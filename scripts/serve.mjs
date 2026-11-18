import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';
const root = 'dist', port = +process.env.PORT || 5173;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.txt': 'text/plain' };
createServer(async (req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let f = join(root, p);
  try { if ((await stat(f)).isDirectory()) f = join(f, 'index.html'); } catch { f = join(root, 'index.html'); }
  try {
    let body = await readFile(f);
    const h = { 'content-type': types[extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' };
    if (/gzip/.test(req.headers['accept-encoding'] || '') && body.length > 1024) { body = gzipSync(body); h['content-encoding'] = 'gzip'; }
    res.writeHead(200, h); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(port, () => console.log(`http://localhost:${port}`));
