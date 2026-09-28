import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { APP, VERSION } from '../../dist/shared/runtime.js';

const exec = promisify(execFile);
const bin = resolve('bin/pilotmeter.js');

for (const [name, accountId, flags, expected] of [
  ['selected personal account', 'test-account', [], '/api/auth/refresh'],
  ['explicit billing while signed in', 'test-account', ['--billing'], '/api/refresh'],
  ['legacy billing without selected account', null, [], '/api/refresh'],
]) {
  test(`account refresh targets ${name}`, async t => {
    const prefix = resolve(tmpdir(), 'pilotmeter-account-cli-');
    const directory = await mkdtemp(prefix);
    const instance = { app: APP, version: VERSION, instanceId: 'synthetic-account-command', managementToken: 'synthetic-management-token', collectorToken: 'synthetic-collector-token', pid: process.pid, url: '' };
    const requests = [];
    const overview = { accounts: [], activeAccountId: accountId, quota: null, login: null, enabled: true, refreshing: false, runCommand: 'pilotmeter run --' };
    const server = createServer((request, response) => {
      requests.push({ path: request.url, method: request.method });
      const value = request.url === '/health' ? instance : request.url === '/api/auth/accounts' ? overview
        : request.url === '/api/auth/refresh' ? { ...overview, refreshing: true } : { state: 'billing-refreshed' };
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
    });
    t.after(async () => {
      await new Promise(resolveClose => server.close(resolveClose));
      assert.ok(resolve(directory).startsWith(prefix) && resolve(directory) !== resolve(tmpdir()));
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    instance.url = `http://127.0.0.1:${server.address().port}`;
    await writeFile(join(directory, 'instance.json'), JSON.stringify(instance), { mode: 0o600 });
    const result = await exec(process.execPath, [bin, '--data-dir', directory, 'account', 'refresh', ...flags], { timeout: 10_000, windowsHide: true });
    const refreshes = requests.filter(request => request.method === 'POST');
    assert.deepEqual(refreshes, [{ path: expected, method: 'POST' }]);
    const output = JSON.parse(result.stdout);
    if (expected === '/api/auth/refresh') { assert.equal(output.activeAccountId, accountId); assert.equal(output.refreshing, true); }
    else assert.equal(output.state, 'billing-refreshed');
    assert.ok(!result.stdout.includes('synthetic-management-token'));
  });
}
