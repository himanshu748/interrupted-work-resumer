import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startDeskServer } from '../src/desk/server.js';
import { createTavilyService } from '../src/integrations/tavily.js';

test('research API requires local session and origin, blocks unconfirmed funding, and exposes only allowlisted assets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tavily-api-'));
  const running = await startDeskServer({ port: 0, workspaceRoot: root, dataRoot: path.join(root, 'data'),
    factories: { research: (options) => createTavilyService({ ...options, env: { TAVILY_API_KEY: 'not-a-live-key' } }) } });
  t.after(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });
  const { token } = await (await fetch(`${running.url}/api/session`)).json();
  const post = (action, body, extra = {}) => fetch(`${running.url}/api/research/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': token, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('status', {}, { 'X-Session-Token': 'wrong' })).status, 403);
  assert.equal((await post('status', {}, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await post('history', { product: 'resumer' }, { 'X-Session-Token': 'wrong' })).status, 403);
  assert.equal((await post('history', { product: 'resumer' }, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await post('record', { id: '00000000-0000-4000-8000-000000000000', product: 'resumer' }, { 'X-Session-Token': 'wrong' })).status, 403);
  assert.deepEqual(await (await post('history', { product: 'resumer' })).json(), { product: 'resumer', records: [], failures: [], unavailable: false });
  const status = await (await post('status', {})).json();
  assert.equal(status.configured, true);
  assert.equal(status.available, false);
  assert.equal(status.transport, 'tavily-search');
  assert.equal(status.liveAccessVerified, false);
  assert.equal(status.funding.providerBalanceVerified, false);
  assert.doesNotMatch(JSON.stringify(status), /not-a-live-key/);
  const blocked = await post('search', { product: 'resumer', query: 'API documentation', consent: true });
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /Live tavily usage is blocked/);
  for (const asset of ['/research.js', '/research.css']) {
    const response = await fetch(running.url + asset);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  }
  assert.equal((await fetch(`${running.url}/src/integrations/tavily.js`)).status, 404);
});
