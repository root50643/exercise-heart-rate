// A localhost-only fixture for testing a GitHub Pages project URL.
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  root: { type: 'string', default: '.' },
  base: { type: 'string', default: '/exercise-heart-rate/' },
  port: { type: 'string', default: '8001' },
} });
const root = await realpath(resolve(values.root));
const base = `/${values.base.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
if (/[?#\\\0]/.test(base) || base.split('/').some(part => part.startsWith('.'))) {
  throw new Error('The base path must contain ordinary URL path segments.');
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port.');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
const insideRoot = filename => {
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
  if (!pathname.startsWith(base)) return fail(404, 'Not found');
  const suffix = pathname.slice(base.length);
  if (/[\\\0]/.test(suffix) || suffix.split('/').some(part => part.startsWith('.'))) {
    return fail(403, 'Forbidden');
  }
  const requested = resolve(root, suffix || 'index.html');
  if (!insideRoot(requested)) return fail(403, 'Forbidden');
  try {
    const filename = await realpath(requested);
    if (!insideRoot(filename)) return fail(403, 'Forbidden');
    const info = await stat(filename);
    if (!info.isFile() || !types[extname(filename).toLowerCase()]) return fail(404, 'Not found');
    const body = request.method === 'HEAD' ? undefined : await readFile(filename);
    response.writeHead(200, { 'Content-Type': types[extname(filename).toLowerCase()], 'Content-Length': info.size });
    response.end(body);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return fail(404, 'Not found');
    console.error(error.message);
    fail(500, 'Unable to read file');
  }
});
server.on('error', error => {
  console.error(`Test server failed: ${error.message}`);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}${base}`;
  console.log(`Test server ready: ${url}`);
  process.send?.({ ready: true, url });
});
function shutdown() {
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('disconnect', shutdown);
