'use strict';
// 단어장 요약 App Server 경로: 가짜 App Server 로 턴 흐름·취소·오류·exec 대체를 확인한다 (모델 호출 없음)
const test = require('node:test');
const assert = require('node:assert/strict');
const {createSummaryServer, CONFIG} = require('../labels/summary-server.cjs');
const {createSummarizer, SCHEMA} = require('../labels/vendor/vocabulary.cjs');

const ANSWER = JSON.stringify({meaning: '출시하다', usage: '기능 공개', example: '', partOfSpeech: '동사', explanation: '', tags: [], matchedId: ''});

/** turn 마다 behave(params, emit) 로 응답을 흉내 내는 가짜 App Server */
function fakeOpen(behave, log) {
  return async (exe, timeoutMs, options) => {
    log.opens.push(options);
    const listeners = new Set();
    const emit = m => { for (const fn of listeners) fn(m); };
    let threads = 0;
    return {
      async request(method, params) {
        log.requests.push([method, params]);
        if (method === 'config/read') return {config: {mcp_servers: {codex_memo: {}, node_repl: {}}}};
        if (method === 'thread/start') return {thread: {id: `t${++threads}`}};
        if (method === 'turn/start') { setImmediate(() => behave(params, emit)); return {turn: {id: `u${threads}`}}; }
        return {};
      },
      listen(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      close() { log.closed++; },
    };
  };
}
const complete = (params, emit, text = ANSWER) => {
  emit({method: 'item/completed', params: {threadId: params.threadId, item: {type: 'agentMessage', text}}});
  emit({method: 'turn/completed', params: {threadId: params.threadId, turn: {status: 'completed'}}});
};
const request = {model: 'm1', effort: 'low', fast: true, prompt: '자료', schema: SCHEMA};
const newLog = () => ({opens: [], requests: [], closed: 0});

test('도구 없는 임시 대화로 한 턴: MCP 끄기, FAST, 출력 형식, 정리', async () => {
  const log = newLog();
  const server = createSummaryServer({exe: () => 'codex.exe', open: fakeOpen(complete, log)});
  assert.equal(await server.run(request), ANSWER);
  assert.equal(await server.run({...request, fast: false}), ANSWER);
  assert.equal(log.opens.length, 1, '연결은 한 번만 연다');
  assert.deepEqual(log.opens[0].config, CONFIG);
  const starts = log.requests.filter(([m]) => m === 'thread/start').map(([, p]) => p);
  assert.equal(starts.length, 2, '요약마다 새 대화');
  assert.deepEqual(starts[0].config, {'mcp_servers.codex_memo.enabled': false, 'mcp_servers.node_repl.enabled': false});
  assert.equal(starts[0].ephemeral, true); assert.equal(starts[0].sandbox, 'read-only'); assert.equal(starts[0].approvalPolicy, 'never');
  const turns = log.requests.filter(([m]) => m === 'turn/start').map(([, p]) => p);
  assert.equal(turns[0].serviceTierForTurn, 'priority'); assert.equal(turns[1].serviceTierForTurn, 'default');
  assert.deepEqual(turns[0].outputSchema, SCHEMA); assert.equal(turns[0].effort, 'low'); assert.equal(turns[0].input[0].text, '자료');
  assert.equal(log.requests.filter(([m]) => m === 'thread/unsubscribe').length, 2);
  server.close();
});

test('다른 대화의 알림은 무시하고, 실패한 턴은 오류 (exec 대체 아님)', async () => {
  const log = newLog();
  const server = createSummaryServer({exe: () => 'codex.exe', open: fakeOpen((params, emit) => {
    emit({method: 'turn/completed', params: {threadId: 'other', turn: {status: 'completed'}}});
    emit({method: 'turn/completed', params: {threadId: params.threadId, turn: {status: 'failed', error: {message: 'usage limit reached', codexErrorInfo: 'usageLimitExceeded'}}}});
  }, log)});
  await assert.rejects(server.run(request), e => /usage limit/.test(e.message) && !e.fallback);
  server.close();
});

test('취소하면 turn/interrupt', async () => {
  const log = newLog();
  const server = createSummaryServer({exe: () => 'codex.exe', open: fakeOpen(() => {}, log)});
  let stop;
  const running = server.run(request, {onStop: fn => { stop = fn; }});
  await new Promise(r => setTimeout(r, 20));
  stop();
  await assert.rejects(running, /취소/);
  assert.ok(log.requests.some(([m]) => m === 'turn/interrupt'));
  server.close();
});

test('시간 초과', async () => {
  const server = createSummaryServer({exe: () => 'codex.exe', open: fakeOpen(() => {}, newLog())});
  await assert.rejects(server.run(request, {timeoutMs: 30}), /시간이 초과/);
  server.close();
});

test('연결이 안 되면 fallback 표시 → 요약은 codex exec 로 다시 시도', async () => {
  const broken = createSummaryServer({exe: () => 'codex.exe', open: async () => { throw Error('Codex 연결 도구를 시작하지 못했습니다.'); }});
  await assert.rejects(broken.run(request), e => e.fallback === true);
  let execRuns = 0;
  const {EventEmitter} = require('node:events'), {PassThrough} = require('node:stream'), fs = require('node:fs');
  const spawnProcess = (exe, args) => {
    execRuns++;
    const child = new EventEmitter(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    child.stdin.on('finish', () => { fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], ANSWER); setImmediate(() => child.emit('close', 0)); });
    child.stdin.resume();
    return child;
  };
  const summarizer = createSummarizer({executable: process.execPath, spawnProcess, server: broken});
  const draft = await summarizer.summarize('a', {term: 'ship', context: 'ship it'}, {model: 'm1', effort: 'low', fast: true});
  assert.equal(draft.meaning, '출시하다'); assert.equal(execRuns, 1);

  // 연결은 되는데 모델이 실패하면 exec 로 다시 하지 않고 알기 쉬운 오류
  const limited = {run: async () => { throw Error('usage limit reached'); }, close() {}};
  const s2 = createSummarizer({executable: process.execPath, spawnProcess, server: limited});
  await assert.rejects(s2.summarize('a', {term: 'ship', context: ''}, {}), /사용 한도/);
  assert.equal(execRuns, 1);
});

test('App Server 경로 성공 시 exec 를 띄우지 않음', async () => {
  const ok = {run: async () => ANSWER, close() {}};
  const summarizer = createSummarizer({executable: process.execPath, spawnProcess: () => { throw Error('exec 를 띄우면 안 됨'); }, server: ok});
  const draft = await summarizer.summarize('a', {term: 'ship', context: 'ship it'}, {});
  assert.equal(draft.usage, '기능 공개');
});

test('연결 시작 중 close 하면 늦게 열린 연결과 홈 사용을 한 번만 정리하고 턴을 열지 않는다', async () => {
  const log = newLog();
  let finishOpen, enteredOpen, prepared = 0, released = 0;
  const opening = new Promise(resolve => { finishOpen = resolve; });
  const entered = new Promise(resolve => { enteredOpen = resolve; });
  const innerOpen = fakeOpen(complete, log);
  let signal;
  const server = createSummaryServer({
    exe: () => 'fake',
    home: {prepare() { prepared++; return 'fake-home'; }, release() { released++; }},
    open: async (...args) => {
      signal = args[2].signal;
      enteredOpen();
      await opening;
      return innerOpen(...args);
    },
  });
  const running = server.run(request);
  const rejected = assert.rejects(running, e => /연결 풀이 종료/.test(e.message) && !e.fallback);
  await entered;
  server.close();
  assert.equal(signal.aborted, true);
  finishOpen();
  await rejected;
  server.close();
  await assert.rejects(server.run(request), /연결 풀이 종료/);
  assert.equal(prepared, 1);
  assert.equal(released, 1);
  assert.equal(log.closed, 1);
  assert.equal(log.requests.some(([method]) => method === 'thread/start' || method === 'turn/start'), false);
});

test('앞선 요약을 기다리는 동안 취소한 요청은 새 모델 턴을 시작하지 않는다', async () => {
  const log = newLog();
  let completeFirst, enteredFirst;
  const entered = new Promise(resolve => { enteredFirst = resolve; });
  const server = createSummaryServer({exe: () => 'fake', open: fakeOpen((params, emit) => {
    completeFirst = () => complete(params, emit);
    enteredFirst();
  }, log)});
  try {
    const first = server.run(request);
    await entered;
    let stop;
    const queued = server.run(request, {onStop: fn => { stop = fn; }});
    assert.equal(typeof stop, 'function', '대기 중에도 즉시 취소할 수 있다');
    stop();
    const cancelled = assert.rejects(queued, /취소/);
    completeFirst();
    assert.equal(await first, ANSWER);
    await cancelled;
    assert.equal(log.requests.filter(([method]) => method === 'turn/start').length, 1);
    assert.equal(log.requests.filter(([method]) => method === 'thread/start').length, 1);
  } finally { server.close(); }
});

test('연결 시작 중 취소한 뒤 연결이 실패해도 exec 대체를 요청하지 않는다', async () => {
  let failOpen, enteredOpen, stop;
  const opening = new Promise((_resolve, reject) => { failOpen = reject; });
  const entered = new Promise(resolve => { enteredOpen = resolve; });
  const server = createSummaryServer({exe: () => 'fake', open: async () => {
    enteredOpen();
    return opening;
  }});
  try {
    const running = server.run(request, {onStop: fn => { stop = fn; }});
    const cancelled = assert.rejects(running, e => /취소/.test(e.message) && !e.fallback);
    await entered;
    stop();
    failOpen(Error('Codex 연결 도구를 시작하지 못했습니다.'));
    await cancelled;
  } finally { server.close(); }
});
