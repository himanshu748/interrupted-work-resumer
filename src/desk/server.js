import http from 'node:http';
import { readFile, mkdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createResumerService } from '../resumer/service.js';
import { createInferenceRuntime } from '../integrations/runtime.js';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = path.join(sourceRoot, 'desk/public');
const staticFiles = new Map([
  ['/', [publicRoot, 'resumer-landing.html']],
  ['/products/resumer', [publicRoot, 'resumer-landing.html']],
  ['/resumer', [publicRoot, 'resumer.html']],
  ['/fonts.css', [publicRoot, 'fonts.css']],
  ['/marketing.css', [publicRoot, 'marketing.css']],
  ['/motion.js', [publicRoot, 'motion.js']],
  ['/resumer-landing.js', [publicRoot, 'resumer-landing.js']],
  ['/resumer-design.css', [publicRoot, 'resumer-design.css']],
  ['/styles.css', [publicRoot, 'styles.css']],
  ['/common.js', [publicRoot, 'common.js']],
  ['/resumer.js', [publicRoot, 'resumer.js']],
  ['/fonts/manrope.woff2', [publicRoot, 'fonts/manrope.woff2']],
  ['/fonts/LICENSE.txt', [publicRoot, 'fonts/LICENSE.txt']],
  ['/product-evidence/resumer-local-continuation-desktop.png', [publicRoot, 'product-evidence/resumer-local-continuation-desktop.png']],
  ['/product-evidence/resumer-local-continuation-mobile.png', [publicRoot, 'product-evidence/resumer-local-continuation-mobile.png']],
  ['/product-evidence/resumer-local-continuation.json', [publicRoot, 'product-evidence/resumer-local-continuation.json']],
]);
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.zip': 'application/zip', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
function send(response, status, body, type = 'application/json; charset=utf-8', extra = {}, head = false) {
  const bytes = typeof body === 'object' && !Buffer.isBuffer(body) ? Buffer.from(JSON.stringify(body)) : Buffer.from(body);
  response.writeHead(status, { ...securityHeaders, 'Content-Type': type, 'Content-Length': bytes.length, ...extra });
  response.end(head ? undefined : bytes);
}
async function jsonBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw Object.assign(new Error('Use application/json.'), { statusCode: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('Request exceeds 1 MiB.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new Error('Request must be a JSON object.'); }
}

export async function startDeskServer({ port = 4190, workspaceRoot = process.cwd(), dataRoot, factories = {}, inferenceRuntime = createInferenceRuntime() } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('DESK_PORT must be an integer between 0 and 65535.');
  workspaceRoot = await realpath(workspaceRoot);
  if (!(await lstat(workspaceRoot)).isDirectory()) throw new Error('Workspace must be a directory.');
  dataRoot ??= path.join(workspaceRoot, 'work/desk');
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(dataRoot)).isSymbolicLink()) throw new Error('Data root cannot be a symbolic link.');
  dataRoot = await realpath(dataRoot);
  const services = {
    inference: inferenceRuntime,
    resumer: await (factories.resumer ?? createResumerService)({ workspaceRoot, dataRoot, inferenceRuntime }),
  };
  const token = randomBytes(32).toString('hex');
  let expectedHost;
  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (request, response) => {
    const method = request.method;
    try {
      if (request.headers.host !== expectedHost) return send(response, 403, { error: 'Unrecognized local host.' });
      const origin = `http://${expectedHost}`;
      if (request.headers.origin && request.headers.origin !== origin) return send(response, 403, { error: 'Cross-origin access is not allowed.' });
      const url = new URL(request.url, origin);
      if (url.pathname === '/api/session' && method === 'GET') return send(response, 200, { token, workspaceRoot, mode: 'local', sponsorConnected: false });
      if (url.pathname.startsWith('/api/')) {
        const provided = request.headers['x-session-token'];
        if (typeof provided !== 'string' || Buffer.byteLength(provided) !== token.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) return send(response, 403, { error: 'Refresh this local page to renew its session.' });
        if (method !== 'POST') return send(response, 405, { error: 'Use POST for this operation.' }, undefined, { Allow: 'POST' });
        const match = /^\/api\/(resumer|inference)\/([a-z]+)$/.exec(url.pathname);
        if (!match) return send(response, 404, { error: 'Unknown operation.' });
        const data = await services[match[1]].handle(match[2], await jsonBody(request));
        return send(response, 200, data);
      }
      if (!['GET', 'HEAD'].includes(method)) return send(response, 405, { error: 'Method not allowed.' }, undefined, { Allow: 'GET, HEAD' });
      // Raw matching prevents URL normalization from turning traversal into an allowed asset.
      const asset = staticFiles.get(request.url.split('?')[0]);
      if (!asset) return send(response, 404, 'Not found.', 'text/plain', {}, method === 'HEAD');
      return send(response, 200, await readFile(path.join(...asset)), contentTypes[path.extname(asset[1])], {}, method === 'HEAD');
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const status = error.statusCode ?? (error.code === 'ENOENT' ? 404 : error.code ? 500 : 400);
        const message = error.code === 'ENOENT' ? 'Requested record or file was not found.'
          : error.code ? 'Local storage is unavailable. Check the server and try again.' : error.message;
        send(response, status, { error: message });
      }
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  expectedHost = `127.0.0.1:${server.address().port}`;
  let closing;
  const close = () => closing ??= (async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await Promise.allSettled(Object.values(services).map((service) => service.close?.()));
  })();
  return { server, url: `http://${expectedHost}`, close };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    // Optional ignored, user-owned configuration. Never load a selected project’s .env.
    try { process.loadEnvFile(path.join(process.cwd(), '.env')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load the local .env configuration.'); }
    const raw = process.env.DESK_PORT ?? '4190';
    if (!/^(0|[1-9]\d{0,4})$/.test(raw)) throw new Error('DESK_PORT must be a decimal integer.');
    const running = await startDeskServer({ port: Number(raw), workspaceRoot: process.env.DESK_WORKSPACE ?? process.cwd() });
    process.stdout.write(`Interrupted Work Resumer is available at ${running.url}\n`);
    const stop = () => running.close().catch((error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
