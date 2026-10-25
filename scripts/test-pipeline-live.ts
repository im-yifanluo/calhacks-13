/** Real acceptance: actual phone uploader → deployed API → Runpod → ready scene.
 * Requires an explicitly supplied clip and a running, configured GPU worker. No mock fallback.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../apps/web/src/loader';
import { DbConnection } from '../apps/web/src/module_bindings';
import { decodeAccountKey } from '../apps/web/src/account-key';

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const api = option('--api') || 'https://memos.alightdell64.chatgpt.site';
const clip = option('--clip');
const timeout = Number(option('--timeout-seconds') || 7200) * 1000;
if (!clip || new URL(api).protocol !== 'https:' || new URL(api).origin !== api || !Number.isFinite(timeout) || timeout <= 0)
  throw new Error('Usage: npm run test:pipeline:live -- --clip /absolute/clip.mp4 [--api https://memos.example] [--timeout-seconds 7200]');
if (process.platform !== 'darwin') throw new Error('Native upload verification requires macOS/Xcode. The pod runs start-worker.sh on Linux.');
await stat(clip);
const root = fileURLToPath(new URL('..', import.meta.url));
const privateDir = await mkdtemp(join(tmpdir(), 'memos-live-acceptance-'));
const outputDir = join(root, 'data', 'pipeline-acceptance-' + Date.now());
await mkdir(outputDir, { mode: 0o700, recursive: true });
let connection: DbConnection | undefined;
const credentialFile = join(outputDir, 'account.json');
const started = new Date().toISOString();
const events: { status: string; progress: number; at: string }[] = [];
async function response(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  return res;
}
function run(command: string, argv: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, argv, { cwd: root, stdio: 'inherit' });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
try {
  const config = await (await response(api + '/api/account/config')).json();
  assert.equal(config.pipelineAvailable, true, 'Worker is not configured on this API; refusing a storage-only acceptance test');
  const binary = join(privateDir, 'pipeline-upload');
  await run('xcrun', ['swiftc', '-module-cache-path', join(privateDir, 'module-cache'), '-parse-as-library',
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`,
    ...['AccountKey', 'CaptureRequirements', 'Recorder', 'SceneLibrary'].map(name => `apps/ios/SceneCapture/${name}.swift`),
    'apps/ios/Tests/PipelineUploadChecks.swift', '-o', binary]);
  await run(binary, ['--live', '--api', api, '--clip', resolve(clip), '--directory', join(privateDir, 'phone'), '--output', credentialFile]);
  const uploaded = JSON.parse(await readFile(credentialFile, 'utf8'));
  const account = decodeAccountKey(uploaded.personalKey, { server: config.server, database: config.database, uri: config.server.replace(/^http/, 'ws') });
  const mid = BigInt(uploaded.memoryId);
  connection = await new Promise<DbConnection>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Website WebSocket subscription did not connect')), 30000);
    const db = DbConnection.builder().withUri(config.server.replace(/^http/, 'ws')).withDatabaseName(config.database)
      .withToken(account.token).withCompression('none')
      .onConnect(c => c.subscriptionBuilder().onApplied(() => { clearTimeout(timer); resolve(c); })
        .onError(() => { clearTimeout(timer); reject(new Error('Subscription failed')); }).subscribeToAllTables())
      .onConnectError((_c, e) => { clearTimeout(timer); reject(e); }).build();
    connection = db;
  });
  let ready: any;
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const data = await (await response(api + '/api/memories', { headers: { Authorization: `Bearer ${uploaded.personalKey}` } })).json();
    const row = data.memories.find((m: any) => m.id === uploaded.memoryId);
    assert.ok(row, 'Uploaded memory disappeared from its account');
    const previous = events.at(-1);
    if (!previous || previous.status !== row.status || previous.progress !== row.progress) {
      events.push({ status: row.status, progress: row.progress, at: new Date().toISOString() });
      console.log(`Memory #${row.id}: ${row.status} ${Math.round(row.progress * 100)}%`);
    }
    if (row.status === 'failed') throw new Error(`Runpod processing failed: ${row.error}`);
    if (row.status === 'ready' && connection.db.memory.id.find(mid)?.status === 'ready') { ready = row; break; }
    await new Promise(r => setTimeout(r, 3000));
  }
  assert.ok(ready, 'Timed out waiting for a real ready scene; upload success alone does not pass');
  assert.equal(ready.progress, 1);
  const liveRow = connection.db.memory.id.find(mid)!;
  assert.equal(liveRow.owner.toHexString(), account.identity);
  assert.equal(liveRow.manifestUrl, ready.manifestUrl);
  const manifest = await (await response(ready.manifestUrl)).json();
  validateManifest(manifest);
  assert.ok(manifest.background.url && manifest.background.splatCount > 0, 'Synthetic/empty geometry cannot pass live GPU acceptance');
  const refs = new Set<string>();
  function references(value: any): void {
    if (!value || typeof value !== 'object') return;
    if (value.kind === 'splat-sequence') {
      for (let i = 0; i < value.frameCount; i++) refs.add(value.urlPattern.replace('{frame}', String(i)));
    }
    for (const [key, item] of Object.entries(value)) {
      if (['url', 'colliderUrl', 'audioUrl', 'videoUrl'].includes(key) && typeof item === 'string' && item) refs.add(item);
      else if (typeof item === 'object') references(item);
    }
  }
  references(manifest);
  for (const ref of refs) {
    const url = new URL(ref, ready.manifestUrl);
    assert.equal(url.origin, new URL(ready.manifestUrl).origin, 'Scene asset must belong to the published bundle');
    const head = await response(url.href, { method: 'HEAD' });
    assert.ok(Number(head.headers.get('content-length')) > 0, `Empty asset: ${ref}`);
  }
  const report = { passed: true, started, completed: new Date().toISOString(), api,
    memoryId: uploaded.memoryId, requestId: uploaded.requestId, sourceSHA256: uploaded.sourceSHA256,
    workerIdentity: uploaded.pipelineIdentity, manifestUrl: ready.manifestUrl, assets: refs.size, events };
  await writeFile(join(outputDir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(`PASS real native upload → GPU reconstruction → published assets → API and website subscription. Evidence: ${outputDir}/result.json`);
} catch (error) {
  await writeFile(join(outputDir, 'result.json'), JSON.stringify({ passed: false, started, events, error: String(error) }, null, 2));
  console.error(`Acceptance failed. Private test-account file, if created, is retained at ${credentialFile}.`);
  throw error;
} finally { connection?.disconnect(); await rm(privateDir, { recursive: true, force: true }); }
