// App Server 연결 재사용(createToolPool) 검사. 실제 Codex 대신 가짜 App Server 를 쓴다.
// 실행: node --test tests/test_appserver.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {openServer, createPool, createToolPool} = require('../labels/appserver.cjs');

// 각 검사 실행의 전용 폴더에서만 가짜 서버를 실행한다. 병렬 검사와 다른 도구의 파일을 건드리지 않는다.
const FAKE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cxm-appserver-'));
const FAKE = path.join(FAKE_DIR, 'app-server');
fs.writeFileSync(FAKE, `
const rl = require('node:readline').createInterface({input: process.stdin});
let calls = 0;
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.id == null) return;
  const reply = result => process.stdout.write(JSON.stringify({id: m.id, result}) + '\\n');
  if (m.method === 'initialize') reply({});
  else if (m.method === 'account/read') reply({account: {type: 'chatgpt'}});
  else if (m.method === 'thread/start') reply({thread: {id: 't1'}});
  else if (m.method === 'test/notify') {
    process.stdout.write('null\\n[]\\n"text"\\n7\\n{broken\\n');
    process.stdout.write(JSON.stringify({method: 'test/event'}) + '\\n');
    reply({pid: process.pid});
  }
  else if (m.method === 'mcpServer/tool/call') {
    calls++;
    if (m.params.tool === 'fail') reply({isError: true, structuredContent: {error: 'boom'}});
    else reply({structuredContent: {pid: process.pid, calls}});
  }
});
`);
// Windows can briefly retain the terminated child's working-directory handle.
test.after(() => fs.promises.rm(FAKE_DIR, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}));

const node = () => process.execPath;
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('연달아 쓰면 같은 연결(프로세스)을 재사용한다', async () => {
  const pool = createToolPool(node, {idleMs: 5000, cwd: FAKE_DIR});
  try {
    const a = await pool.run(call => call('x', {}));
    const b = await pool.run(call => call('x', {}));
    assert.strictEqual(a.pid, b.pid);
    assert.strictEqual(b.calls, 2);
  } finally { pool.close(); }
});

test('쉬는 시간이 지나면 닫고 다음에 새로 연다', async () => {
  const pool = createToolPool(node, {idleMs: 100, cwd: FAKE_DIR});
  try {
    const a = await pool.run(call => call('x', {}));
    await sleep(400);
    const b = await pool.run(call => call('x', {}));
    assert.notStrictEqual(a.pid, b.pid);
  } finally { pool.close(); }
});

test('도구 오류가 나면 연결을 버리고 다음에 새로 연다', async () => {
  const pool = createToolPool(node, {idleMs: 5000, cwd: FAKE_DIR});
  try {
    const a = await pool.run(call => call('x', {}));
    await assert.rejects(pool.run(call => call('fail', {})), /boom/);
    const b = await pool.run(call => call('x', {}));
    assert.notStrictEqual(a.pid, b.pid);
  } finally { pool.close(); }
});

test('동시에 요청해도 차례로 실행된다', async () => {
  const pool = createToolPool(node, {idleMs: 5000, cwd: FAKE_DIR});
  try {
    const results = await Promise.all([1, 2, 3].map(() => pool.run(call => call('x', {}))));
    assert.deepStrictEqual(results.map(r => r.calls), [1, 2, 3]);
    assert.strictEqual(new Set(results.map(r => r.pid)).size, 1);
  } finally { pool.close(); }
});

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
};

test('close 뒤에는 예약된 작업과 새 작업이 연결을 열지 않는다', async () => {
  let opens = 0, works = 0;
  const pool = createPool(node, async () => { opens++; return {close() {}}; }, 5000);
  const queued = pool.run(async () => { works++; });
  pool.close();
  await assert.rejects(queued, /연결 풀이 종료/);
  await assert.rejects(pool.run(async () => { works++; }), /연결 풀이 종료/);
  assert.strictEqual(opens, 0);
  assert.strictEqual(works, 0);
});

test('연결을 여는 중 close 하면 중단 신호를 보내고 늦게 열린 연결도 한 번만 닫는다', async () => {
  const opening = deferred(), entered = deferred();
  let closed = 0, works = 0, signal;
  const pool = createPool(node, async (_exe, nextSignal) => {
    signal = nextSignal;
    entered.resolve();
    await opening.promise; // 중단 신호를 지원하지 않는 어댑터도 늦게 열릴 수 있다.
    return {close() { closed++; }};
  }, 5000);
  const first = pool.run(async () => { works++; });
  const second = pool.run(async () => { works++; });
  const settled = Promise.allSettled([first, second]);
  await entered.promise;
  pool.close();
  assert.strictEqual(signal.aborted, true);
  opening.resolve();
  const results = await settled;
  assert.ok(results.every(r => r.status === 'rejected' && /연결 풀이 종료/.test(r.reason.message)));
  pool.close();
  assert.strictEqual(closed, 1);
  assert.strictEqual(works, 0);
});

test('실행 중 close 해도 대기 중인 다음 작업을 시작하지 않는다', async () => {
  const working = deferred(), entered = deferred();
  let closed = 0, nextWorked = false;
  const pool = createPool(node, async () => ({close() { closed++; }}), 5000);
  const first = pool.run(async () => { entered.resolve(); await working.promise; return 'late result'; });
  const second = pool.run(async () => { nextWorked = true; });
  const settled = Promise.allSettled([first, second]);
  await entered.promise;
  pool.close();
  working.resolve();
  assert.ok((await settled).every(r => r.status === 'rejected' && /연결 풀이 종료/.test(r.reason.message)));
  assert.strictEqual(closed, 1);
  assert.strictEqual(nextWorked, false);
});

test('실행 파일이 바뀌거나 연결 시작이 실패해도 다음 작업은 새 연결을 사용한다', async () => {
  let executable = 'broken', closed = 0, opens = 0;
  const pool = createPool(() => executable, async exe => {
    opens++;
    if (exe === 'broken') throw Error('startup failed');
    return {value: exe, close() { closed++; }};
  }, 5000);
  try {
    await assert.rejects(pool.run(async s => s.value), /startup failed/);
    executable = 'first';
    assert.strictEqual(await pool.run(async s => s.value), 'first');
    executable = 'second';
    assert.strictEqual(await pool.run(async s => s.value), 'second');
    assert.strictEqual(closed, 1);
    assert.strictEqual(opens, 3);
  } finally { pool.close(); }
  assert.strictEqual(closed, 2);
});

test('App Server close 는 응답 대기를 즉시 거부하고 종료 알림을 한 번만 보낸다', async () => {
  const server = await openServer(process.execPath, 10000, {cwd: FAKE_DIR});
  const notices = [];
  server.listen(m => notices.push(m.method));
  const pending = server.request('never-answers');
  server.close();
  server.close();
  await assert.rejects(pending, /종료/);
  await assert.rejects(server.request('initialize'), /종료/);
  await sleep(30); // 실제 자식 exit 이벤트가 뒤따라도 알림을 중복하지 않는다.
  assert.deepStrictEqual(notices, ['server/exited']);
});

test('App Server 초기화 중 중단 신호를 받으면 응답 제한 시간까지 기다리지 않는다', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cxm-appserver-stall-'));
  fs.writeFileSync(path.join(directory, 'app-server'), 'process.stdin.resume();');
  const abort = new AbortController();
  try {
    const opening = openServer(process.execPath, 10000, {cwd: directory, signal: abort.signal});
    abort.abort();
    await assert.rejects(opening, /종료/);
  } finally { await fs.promises.rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}); }
});

test('알림 구독자가 예외를 내도 다른 구독자·응답·자식 프로세스 종료를 막지 않는다', async () => {
  const server = await openServer(process.execPath, 10000, {cwd: FAKE_DIR});
  const notices = [];
  let pid;
  const alive = () => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  try {
    server.listen(() => { throw Error('broken subscriber'); });
    server.listen(m => notices.push(m.method));
    ({pid} = await server.request('test/notify'));
    assert.deepStrictEqual(notices, ['test/event'], '깨진 JSON·구독자 예외 이후에도 응답을 수신한다');
    assert.strictEqual(alive(), true);
    const pending = server.request('never-answers');
    assert.doesNotThrow(() => server.close());
    await assert.rejects(pending, /종료/);
    assert.doesNotThrow(() => server.listen(() => { throw Error('late subscriber'); }));
    const late = [];
    server.listen(m => late.push(m.method));
    assert.deepStrictEqual(late, ['server/exited']);
    for (let attempts = 0; alive() && attempts < 100; attempts++) await sleep(10);
    assert.strictEqual(alive(), false, '정리 과정의 구독자 예외가 자식 프로세스를 남기지 않는다');
    assert.deepStrictEqual(notices, ['test/event', 'server/exited']);
  } finally {
    server.close();
    if (pid && alive()) process.kill(pid);
  }
});
