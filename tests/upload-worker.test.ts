import { afterEach, expect, test, vi } from 'vitest';
import { handleHostedRequest, HOSTED_MAX_UPLOAD_BYTES } from '../server/upload/worker.mjs';
import { encodePersonalKey } from '../server/upload/accounts.mjs';

const owner = 'a'.repeat(64), other = 'b'.repeat(64);
const origin = 'https://memos.example';
const account = { server: 'https://db.example', database: 'memos', identity: owner, token: 'aaa.bbb.ccc' };
const key = encodePersonalKey(account);
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const objects = new Map<string, any>();
  const bucket = {
    async head(path: string) { return objects.get(path) ?? null; },
    async put(path: string, body: ReadableStream, options: any) {
      expect(options.onlyIf).toEqual({ etagDoesNotMatch: '*' });
      if (objects.has(path)) return null;
      const bytes = Buffer.from(await new Response(body).arrayBuffer());
      const object = { size: bytes.length, httpMetadata: options.httpMetadata, httpEtag: '"etag"', bytes };
      objects.set(path, object); return object;
    },
    async get(path: string, options: any) {
      const object = objects.get(path); if (!object) return null;
      const r = options.range;
      return { body: r ? object.bytes.subarray(r.offset, r.offset + r.length) : object.bytes };
    },
  };
  const env = { BUCKET: bucket, UPLOAD_SIGNING_SECRET: 's'.repeat(64), PUBLIC_ORIGIN: origin,
    STDB_HTTP_URL: account.server, STDB_DATABASE: account.database };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 200 }));
  const call = async (path: string, method = 'GET', body?: unknown, auth = key, headers: Record<string, string> = {}) => {
    const req = new Request(new URL(path, origin), { method,
      headers: { Authorization: `Bearer ${auth}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return (await handleHostedRequest(req, env))!;
  };
  const prepare = async (extra = {}) => call('/api/uploads/presign', 'POST', {
    name: 'clip.mp4', type: 'video/mp4', size: 12, title: 'Test clip', durationSec: 1, ...extra,
  });
  const put = (url: string, data = Buffer.from('examplevideo'), headers = {}) => handleHostedRequest(new Request(url, {
    method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(data.length), ...headers }, body: data,
  }), env);
  return { env, call, prepare, put, bucket, objects };
}

test('hosted config keeps the website database and reports real storage/reconstruction limits', async () => {
  const f = fixture(); const config = await (await f.call('/api/account/config')).json();
  expect(config).toMatchObject({ server: account.server, database: account.database, keyPrefix: 'memos1.',
    maxUploadBytes: HOSTED_MAX_UPLOAD_BYTES, pipelineAvailable: false });
  expect((await f.prepare({ size: HOSTED_MAX_UPLOAD_BYTES + 1 })).status).toBe(413);
  expect((await f.prepare({ pipeline: true })).status).toBe(503);
  const upload = await (await f.prepare()).json(); expect(upload.pipeline).toBe(false);
  expect(upload.putUrl).toMatch(/^https:\/\/memos.example\/api\/uploads\/put\?ticket=/);
});

test('signed PUT streams into R2 once, then supports full GET, HEAD and Safari byte ranges', async () => {
  const f = fixture(); const upload = await (await f.prepare()).json();
  expect((await f.put(upload.putUrl))!.status).toBe(200);
  expect((await f.put(upload.putUrl, Buffer.from('changedvideo')))!.status).toBe(409);
  const full = await f.call(upload.sourceUrl); expect(await full.text()).toBe('examplevideo');
  expect(full.headers.get('content-type')).toBe('video/mp4');
  const head = await f.call(upload.sourceUrl, 'HEAD'); expect(await head.text()).toBe('');
  expect(head.headers.get('content-length')).toBe('12');
  for (const [range, expected, contentRange] of [['bytes=0-1', 'ex', 'bytes 0-1/12'], ['bytes=-5', 'video', 'bytes 7-11/12'], ['bytes=7-', 'video', 'bytes 7-11/12']]) {
    const r = await f.call(upload.sourceUrl, 'GET', undefined, key, { Range: range });
    expect(r.status).toBe(206); expect(r.headers.get('content-range')).toBe(contentRange); expect(await r.text()).toBe(expected);
  }
  for (const range of ['bytes=12-', 'bytes=-0', 'bytes=3-1', 'bytes=0-1,4-5', 'broken'])
    expect((await f.call(upload.sourceUrl, 'GET', undefined, key, { Range: range })).status).toBe(416);
});

test('storage rejects tampering, wrong bodies, wrong origins and completion receipts as PUT tickets', async () => {
  const f = fixture(); const upload = await (await f.prepare()).json();
  expect((await f.put(upload.putUrl + 'x'))!.status).toBe(401);
  expect((await f.put(upload.putUrl, Buffer.from('short')))!.status).toBe(400);
  expect((await f.put(upload.putUrl, undefined, { 'Content-Type': 'text/html' }))!.status).toBe(400);
  expect((await f.put(upload.putUrl, undefined, { Origin: 'https://evil.example' }))!.status).toBe(403);
  expect((await f.put(`${origin}/api/uploads/put?ticket=${upload.receipt}`))!.status).toBe(401);
  expect(f.objects.size).toBe(0);
  const missingLength = await handleHostedRequest(new Request(upload.putUrl, { method: 'PUT', body: 'examplevideo', headers: { 'Content-Type': 'video/mp4' } }), f.env);
  expect(missingLength!.status).toBe(411);
});

test('invalid tokens and cross-account completion never register someone else’s upload', async () => {
  const f = fixture();
  expect((await f.call('/api/uploads/presign', 'POST', {}, 'broken')).status).toBe(401);
  const upload = await (await f.prepare()).json(); await f.put(upload.putUrl);
  const wrongKey = encodePersonalKey({ ...account, identity: other });
  expect((await f.call('/api/uploads/complete', 'POST', { receipt: upload.receipt }, wrongKey)).status).toBe(403);
});

test('public media restricts keys and methods; preflight and missing configuration are explicit', async () => {
  const f = fixture();
  expect((await f.call('/media/secret.txt')).status).toBe(404);
  expect((await f.call('/media/videos/' + owner + '/00000000-0000-0000-0000-000000000000.mp4')).status).toBe(404);
  expect((await f.call('/media/anything', 'POST')).status).toBe(405);
  const preflight = await f.call('/api/uploads/put', 'OPTIONS', undefined, key, { Origin: origin });
  expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
  expect((await handleHostedRequest(new Request(origin + '/api/health'), {}))!.status).toBe(503);
  expect(await handleHostedRequest(new Request(origin + '/library'), {})).toBeNull();
});
