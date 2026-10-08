'use strict';
// 메모가 연결된 대화 상태: 있음·보관됨·없음·확인 못 함, 1분 기억 (가짜 App Server)
const test = require('node:test');
const assert = require('node:assert/strict');
const {createThreadStates} = require('../labels/thread-state.cjs');

const A = '01a1102e-0000-7000-8000-00000000000a', B = '01a1102e-0000-7000-8000-00000000000b';
const C = '01a1102e-0000-7000-8000-00000000000c', D = '01a1102e-0000-7000-8000-00000000000d';

function fake() {
  const calls = [];
  const request = async (method, params) => {
    calls.push([method, params?.threadId || '']);
    if (method === 'thread/list') return {data: [{id: B}]};
    if (params.threadId === C) throw Error(`thread not loaded: ${C}`);
    if (params.threadId === D) throw Error('connection reset');
    return {thread: {id: params.threadId}};
  };
  return {calls, server: {run: work => work(request)}};
}

test('있음·보관됨·없음·확인 못 함을 구분하고, 잘못된 id 는 묻지 않는다', async () => {
  const {calls, server} = fake();
  const s = createThreadStates({server});
  assert.deepEqual(await s.states([A, B, C, D, 'title:예전 메모', A.toUpperCase()]), {[A]: 'ok', [B]: 'archived', [C]: 'missing', [D]: 'unknown'});
  assert.equal(calls.filter(([m]) => m === 'thread/read').length, 4);
  assert.equal(calls.filter(([m]) => m === 'thread/list').length, 1, '보관 목록은 한 번만');
});

test('1분 동안 기억하고(확인 못 함은 기억하지 않음), 지나면 다시 묻는다', async () => {
  const {calls, server} = fake();
  let t = 0;
  const s = createThreadStates({server, now: () => t});
  await s.states([A, D]);
  const first = calls.length;
  await s.states([A, D]);
  assert.deepEqual(calls.slice(first).map(([m, id]) => id), [D], 'A 는 기억, D(확인 못 함)는 다시');
  t = 61000;
  await s.states([A]);
  assert.ok(calls.slice(first + 1).some(([m, id]) => m === 'thread/read' && id === A));
});

test('연결이 안 되면 모두 확인 못 함', async () => {
  const s = createThreadStates({server: {run: async () => { throw Error('Codex 연결 도구가 종료됐습니다.'); }}});
  assert.deepEqual(await s.states([A]), {[A]: 'unknown'});
});
