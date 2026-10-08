'use strict';
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const {test} = require('node:test');

test('vocabulary profile bounds discovery and calls while preserving the full contract', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-mcp-profile-'));
  const calls = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-only-token');
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const call = JSON.parse(body);
      calls.push(call);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ok: true, result: {tool: call.tool, args: call.args}}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(path.join(dir, 'control.json'), JSON.stringify({port: server.address().port, token: 'test-only-token'}));
  const sessions = [];
  function session(profile) {
    const env = {...process.env, CODEX_MEMO_DATA: dir};
    delete env.CODEX_MEMO_MCP_PROFILE;
    if (profile) env.CODEX_MEMO_MCP_PROFILE = profile;
    const child = spawn(process.execPath, [path.join(__dirname, '../labels/memo-mcp.cjs')], {env, stdio: ['pipe', 'pipe', 'pipe']});
    sessions.push(child);
    const pending = new Map();
    let id = 0;
    readline.createInterface({input: child.stdout}).on('line', line => {
      const reply = JSON.parse(line);
      pending.get(reply.id)?.(reply);
    });
    return (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => reject(Error('stdio reply timeout')), 5000);
      pending.set(requestId, reply => {clearTimeout(timer); pending.delete(requestId); resolve(reply);});
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: requestId, method, params}) + '\n');
    });
  }
  try {
    const full = session();
    const fullInit = await full('initialize', {protocolVersion: '2025-11-25'});
    assert.equal(fullInit.result.serverInfo.name, 'codex_memo');
    assert.equal((await full('initialize', {protocolVersion: '2025-11-25'})).error.code, -32602);
    const fullNames = (await full('tools/list')).result.tools.map(t => t.name);
    for (const name of ['memo_delete', 'vocabulary_delete', 'labels_assign', 'threads_move', 'undo']) assert(fullNames.includes(name));

    const limited = session('vocabulary');
    const init = await limited('initialize', {protocolVersion: '2025-11-25'});
    assert.equal(init.result.serverInfo.name, 'codex_memo_vocabulary');
    const rediscovery = await limited('initialize', {protocolVersion: '2025-06-18'});
    assert.equal(rediscovery.result.protocolVersion, '2025-06-18');
    assert.equal(rediscovery.result.serverInfo.name, 'codex_memo_vocabulary');
    const visible = (await limited('tools/list')).result.tools;
    assert.deepEqual(visible.map(t => t.name), ['status', 'vocabulary_list', 'vocabulary_add', 'vocabulary_update']);
    assert.equal(visible.find(t => t.name === 'vocabulary_list').annotations.readOnlyHint, true);
    assert.equal(visible.find(t => t.name === 'vocabulary_update').annotations.readOnlyHint, false);
    const status = await limited('tools/call', {name: 'status', arguments: {}});
    assert.equal(JSON.parse(status.result.content[0].text).tool, 'status');
    const added = await limited('tools/call', {name: 'vocabulary_add', arguments: {term: 'test-only', meaning: 'fake backend only'}});
    assert.equal(JSON.parse(added.result.content[0].text).args.term, 'test-only');
    const before = calls.length;
    for (const name of ['vocabulary_delete', 'memo_add', 'labels_assign', 'undo']) {
      const reply = await limited('tools/call', {name, arguments: {}});
      assert.equal(reply.error.code, -32602);
    }
    const badArgs = await limited('tools/call', {name: 'vocabulary_list', arguments: {unexpected: true}});
    assert.equal(badArgs.result.isError, true);
    assert.equal(calls.length, before, 'excluded tools and invalid arguments must never reach the helper');
  } finally {
    for (const child of sessions) child.kill();
    await new Promise(resolve => server.close(resolve));
    assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dir, {recursive: true, force: true});
  }
});
