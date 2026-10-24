// Test-only loopback proxy: complete the first upload, then lose its response.
import { createServer } from 'node:http';
let dropped = false;
const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:5173';
createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    const upstream = await fetch(origin + req.url, {
      method: req.method, headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (req.url === '/api/uploads/complete' && upstream.ok && !dropped) {
      dropped = true;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'TEST: confirmation deliberately lost after server commit' }));
      return;
    }
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
    res.end(bytes);
  } catch {
    res.writeHead(502);
    res.end('Test upstream unavailable');
  }
}).listen(8789, '127.0.0.1', () => console.log('Native upload fault proxy ready on 127.0.0.1:8789'));
