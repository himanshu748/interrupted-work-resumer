import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startDeskServer } from '../src/desk/server.js';
import { createInferenceRuntime } from '../src/integrations/runtime.js';

const product = 'resumer';
function request(url, target, { method = 'GET', headers = {}, body } = {}) {
  const address = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: address.hostname, port: address.port, path: target, method, headers: { Connection: 'close', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}

test('standalone landing, assets and own APIs preserve the session and static boundary', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'standalone-http-'));
  await writeFile(path.join(root, '.env'), 'PRIVATE_LOCAL_FIXTURE');
  const runtime = createInferenceRuntime({ env: {}, fetchImpl: () => { throw Error('Provider calls forbidden in smoke test.'); } });
  const running = await startDeskServer({ port: 0, workspaceRoot: root, inferenceRuntime: runtime });
  t.after(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
  const home = await request(running.url, '/');
  assert.equal(home.status, 200);
  assert.match(home.bytes.toString(), /Interrupted Work Resumer/);
  assert.match(home.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(home.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual((await request(running.url, '/products/' + product)).bytes, home.bytes);
  assert.equal((await request(running.url, '/' + product + (product === 'route' ? '/' : ''))).status, 200);
  const session = JSON.parse((await request(running.url, '/api/session')).bytes);
  assert.match(session.token, /^[a-f0-9]{64}$/);
  assert.equal(session.sponsorConnected, false);
  const post = (target, body = '{}', token = session.token, headers = {}) => request(running.url, target, {
    method: 'POST', body, headers: { 'X-Session-Token': token, 'Content-Type': 'application/json', ...headers },
  });
  assert.equal((await post('/api/inference/status', '{}', '')).status, 403);
  assert.equal((await post('/api/inference/status', '{}', 'incorrect')).status, 403);
  const status = await post('/api/inference/status');
  assert.equal(status.status, 200);
  assert.equal(JSON.parse(status.bytes).configured, false);
  assert.equal(JSON.parse(status.bytes).liveAccessVerified, false);
  assert.equal((await post('/api/' + product + '/list')).status, 200);
  assert.equal((await request(running.url, '/', { headers: { Host: 'untrusted.local' } })).status, 403);
  assert.equal((await post('/api/inference/status', '{}', session.token, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await post('/api/inference/status', '[]')).status, 400);
  assert.equal((await post('/api/inference/status', '{}', session.token, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/inference/status', JSON.stringify({ content: 'x'.repeat(1024 * 1024) }))).status, 413);
  for (const sibling of ['verifier', 'scope', 'resumer', 'route'].filter(name => name !== product)) {
    for (const target of ['/' + sibling, '/' + sibling + '/', '/products/' + sibling, '/' + sibling + '.js', '/' + sibling + '-landing.js'])
      assert.equal((await request(running.url, target)).status, 404, target);
    assert.equal((await post('/api/' + sibling + '/list')).status, 404, sibling + ' API must be absent');
  }
  for (const target of ['/.env', '/package.json', '/src/desk/server.js', '/product-evidence/../.env', '/product-evidence/%2e%2e/.env', '/unknown'])
    assert.equal((await request(running.url, target)).status, 404, target);
  for (const file of ['resumer-local-continuation-desktop.png', 'resumer-local-continuation-mobile.png', 'resumer-local-continuation.json']) {
    const asset = await request(running.url, '/product-evidence/' + file);
    assert.equal(asset.status, 200);
    assert.ok(asset.bytes.length > 0);
  }
  assert.equal((await request(running.url, '/fonts/manrope.woff2')).status, 200);
  assert.equal((await request(running.url, '/fonts/LICENSE.txt')).status, 200);
  assert.equal((await request(running.url, '/', { method: 'HEAD' })).bytes.length, 0);
});
