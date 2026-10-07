import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(dirname(fileURLToPath(import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8' };
const insideRoot = (filename) => {
  const path = relative(root, filename);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const fail = (code, message) => {
    response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : message);
  };
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    return fail(405, 'Method not allowed');
  }
  let pathname;
  try { pathname = decodeURIComponent((request.url || '/').split('?')[0]); }
  catch { return fail(400, 'Invalid URL'); }
  if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some((part) => part.startsWith('.'))) {
    return fail(403, 'Forbidden');
  }
  const requested = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!insideRoot(requested)) return fail(403, 'Forbidden');
  try {
    const filename = await realpath(requested);
    if (!insideRoot(filename)) return fail(403, 'Forbidden');
    const info = await stat(filename);
    if (!info.isFile() || !types[extname(filename).toLowerCase()]) return fail(404, 'Not found');
    const content = request.method === 'HEAD' ? null : await readFile(filename);
    response.writeHead(200, { 'Content-Type': types[extname(filename).toLowerCase()], 'Content-Length': info.size });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return fail(404, 'Not found');
    console.error('File request failed:', error.message);
    fail(500, 'Unable to read file');
  }
});
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? 'Port 8000 is already in use. Stop the other server, then try again. The port stays fixed to preserve local records.'
    : `Server failed: ${error.message}`);
  process.exitCode = 1;
});
server.listen(8000, '127.0.0.1', () => {
  console.log('運動心率已啟動：http://localhost:8000');
  console.log('Keep this window open. Press Ctrl+C to stop.');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
