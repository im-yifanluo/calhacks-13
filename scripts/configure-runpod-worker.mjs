/** Explicit setup command: creates one SpacetimeDB worker credential, never a billable Runpod resource. */
import { writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
const [api, output] = process.argv.slice(2);
if (!api || !output || new URL(api).protocol !== 'https:' || new URL(api).origin !== api)
  throw new Error('Usage: node scripts/configure-runpod-worker.mjs https://memos.example data/runpod-worker.env');
const file = resolve(output);
try { await access(file); throw new Error('Refusing to replace an existing worker credential. Reuse that file.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const response = await fetch(api + '/api/account/config');
if (!response.ok) throw new Error('Upload API configuration is unavailable');
const config = await response.json();
if (config.pipelineAvailable) throw new Error('A worker is already configured. Reuse its credential instead of creating a different identity.');
const server = new URL(config.server);
if (server.protocol !== 'https:' || server.username || server.password || !config.database) throw new Error('Invalid database configuration');
const created = await fetch(server.href.replace(/\/$/, '') + '/v1/identity', { method: 'POST' });
if (!created.ok) throw new Error('Could not create worker identity');
const account = await created.json(), identity = account.identity.replace(/^0x/, '');
if (!/^[a-f0-9]{64}$/.test(identity) || !/^[A-Za-z0-9_.-]+$/.test(account.token)) throw new Error('Invalid credential response');
const values = { STDB_HTTP_URL: config.server, STDB_DATABASE: config.database, MEMREPLAY_UPLOAD_API: api,
  ASSET_BASE_URL: api + '/media', MEMREPLAY_WORK: '/workspace/work', PIPELINE_IDENTITY: identity, PIPELINE_TOKEN: account.token };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
await writeFile(file, Object.entries(values).map(([key, value]) => `export ${key}=${quote(value)}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log(`Worker configuration saved with mode 0600: ${file}\nUpload-service PIPELINE_IDENTITY: ${identity}\nNo Runpod pod was created. Keep the token file private.`);
