'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the real backend helper without starting the app's stores or native services.
// labels/backend.cjs 는 호환 래퍼이므로 빌드된 실제 구현(dist/node/backend.cjs)에서 함수를 떼어 온다.
const source = fs.readFileSync(path.join(__dirname, '../dist/node/backend.cjs'), 'utf8');
const start = source.indexOf('async function readThreadCatalog(');
const end = source.indexOf('\n// 펫은', start);
assert.ok(start > 0 && end > start, 'catalog helper boundary exists');
const protocol = require('../dist/node/protocol.cjs');
function fixture(pages) {
  const calls = [];
  const serverPool = {run: fn => fn(async (method, params) => {
    calls.push({method, params});
    const page = pages[calls.length - 1];
    if (page instanceof Error) throw page;
    return page;
  })};
  const read = vm.runInNewContext(source.slice(start, end) + '\nreadThreadCatalog', {serverPool, protocol_cjs_1: protocol});
  return {read, calls};
}
function turnsFixture(responses) {
  const calls = [];
  const serverPool = {run: fn => fn(async (method, params) => {
    calls.push(JSON.stringify([method, params]));
    const value = responses[params.threadId];
    if (value instanceof Error) throw value;
    return value;
  })};
  const {readLastTurns} = vm.runInNewContext(source.slice(start, end) + '\n({readLastTurns})', {serverPool, protocol_cjs_1: protocol});
  return {read: readLastTurns, calls};
}
function petFixture({pages = [], reads = {}}) {
  const calls = [];
  let listed = 0;
  const serverPool = {run: fn => fn(async (method, params) => {
    calls.push(JSON.stringify([method, params]));
    const value = method === 'thread/list' ? pages[listed++] : reads[params.threadId];
    if (value instanceof Error) throw value;
    return value;
  })};
  const {readPetThreads} = vm.runInNewContext(source.slice(start, end) + '\n({readPetThreads})', {serverPool, protocol_cjs_1: protocol});
  return {read: readPetThreads, calls};
}
const page = (ids, nextCursor = null) => ({data: ids.map(id => ({id, name: '작업 ' + id, updatedAt: 42})), nextCursor});

test('ordinary catalog preserves pagination and field projection', async () => {
  const f = fixture([page(['a', 'b'], 'next'), page(['c'])]);
  const result = await f.read();
  assert.equal(result.length, 3);
  assert.deepEqual(f.calls.map(c => c.params.cursor), [undefined, 'next']);
  assert.equal(result[0].cwd, '');
});
test('targeted verification stops at the first complete page', async () => {
  const f = fixture([page(['a', 'local:B', 'c'], 'unused')]);
  const result = await f.read(1000, ['b', 'b']);
  assert.deepEqual(Array.from(result, t => t.id), ['local:B']);
  assert.equal(f.calls.length, 1);
});
test('missing or archived target scans remaining pages and stays absent', async () => {
  const f = fixture([page(['a'], 'next'), page(['c'])]);
  const result = await f.read(1000, ['a', 'removed']);
  assert.deepEqual(Array.from(result, t => t.id), ['a']);
  assert.equal(f.calls.length, 2);
});
test('empty target avoids an API call; missing targets respect scan cap', async () => {
  const f = fixture(Array.from({length: 11}, () => page(Array.from({length:100}, (_, i) => String(i)), 'more')));
  assert.equal((await f.read(1000, [])).length, 0);
  assert.equal(f.calls.length, 0);
  await f.read(1000, ['missing']);
  assert.equal(f.calls.length, 10);
});
test('malformed and failed catalog reads reject instead of appearing empty', async () => {
  await assert.rejects(fixture([{}]).read(1000, ['a']), /대화 목록/);
  await assert.rejects(fixture([Error('offline')]).read(), /offline/);
});

test('last turns read only the newest turn of each unique thread and keep the final answer and request', async () => {
  const f = turnsFixture({
    a: {data: [{status: 'completed', completedAt: 5, items: [{type: 'userMessage', content: [{type: 'text', text: '고쳐줘'}]},
      {type: 'agentMessage', text: '첫 답'}, {type: 'agentMessage', text: '마지막 답'}]}]},
    b: {data: [{status: 'interrupted', completedAt: null, items: [{type: 'userMessage', content: [{type: 'text', text: '계속'}]}]}]},
    c: {data: []},
    d: {data: [{status: 'completed', items: [{type: 'agentMessage', text: 'x'.repeat(5000)}]}]},
  });
  const out = await f.read(['a', 'b', 'a', 'c', 'd']);
  assert.deepEqual(f.calls, ['a', 'b', 'c', 'd'].map(id => JSON.stringify(['thread/turns/list', {threadId: id, limit: 1}])));
  assert.deepEqual({...out.a}, {status: 'completed', completedAt: 5, agentText: '마지막 답', userText: '고쳐줘'});
  assert.deepEqual({...out.b}, {status: 'interrupted', completedAt: null, agentText: '', userText: '계속'});
  assert.ok(!('c' in out));
  assert.equal(out.d.agentText.length, 2000);
});
test('last turns skip one unreadable thread, reject when all fail, and make no call for no input', async () => {
  const some = turnsFixture({a: Error('gone'), b: {data: [{status: 'completed', items: []}]}});
  assert.deepEqual(Object.keys(await some.read(['a', 'b'])), ['b']);
  await assert.rejects(turnsFixture({a: Error('offline')}).read(['a']), /마지막 상태/);
  const none = turnsFixture({});
  assert.equal(Object.keys(await none.read([])).length, 0);
  assert.equal(none.calls.length, 0);
});

test('pet threads list only the recent part, newest first, then read the rest by ID', async () => {
  const item = (id, updatedAt) => ({id, name: '작업 ' + id, updatedAt});
  const f = petFixture({
    pages: [{data: [item('r1', 100), item('r2', 90)], nextCursor: 'p2'}, {data: [item('r3', 80), item('old', 10)], nextCursor: 'p3'}],
    reads: {
      l1: {thread: {id: 'l1', name: '라벨 대화', updatedAt: 5, path: 'D:\\CodexHome\\sessions\\2026\\a.jsonl'}},
      arch: {thread: {id: 'arch', name: '보관', updatedAt: 6, path: 'D:\\CodexHome\\archived_sessions\\b.jsonl'}},
      gone: Error('thread not loaded: gone'),
    },
  });
  const out = await f.read(['r2', 'L1', 'arch', 'gone'], 50);
  assert.deepEqual(Array.from(out, t => t.id), ['r1', 'r2', 'r3', 'l1']);
  assert.equal(out[3].name, '라벨 대화');
  assert.deepEqual(f.calls.map(c => JSON.parse(c)), [
    ['thread/list', {limit: 25, sortKey: 'updated_at'}], ['thread/list', {limit: 25, sortKey: 'updated_at', cursor: 'p2'}],
    ['thread/read', {threadId: 'l1', includeTurns: false}], ['thread/read', {threadId: 'arch', includeTurns: false}],
    ['thread/read', {threadId: 'gone', includeTurns: false}]]);
});
test('pet threads: verification reads only IDs, connection errors reject, nothing to read makes no call', async () => {
  const f = petFixture({reads: {a: {thread: {id: 'a', updatedAt: 1}}}});
  assert.deepEqual(Array.from(await f.read(['a']), t => t.id), ['a']);
  assert.ok(f.calls.every(c => JSON.parse(c)[0] === 'thread/read'));
  await assert.rejects(petFixture({reads: {a: Error('Codex 연결 도구가 종료됐습니다.')}}).read(['a']), /종료/);
  await assert.rejects(petFixture({pages: [{}]}).read([], 1), /대화 목록/);
  const none = petFixture({});
  assert.equal((await none.read([])).length, 0);
  assert.equal(none.calls.length, 0);
});
