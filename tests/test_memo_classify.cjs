// @ts-check
// 메모 자동 분류 검사. 두 분류기 모두 가짜 서버만 사용한다.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {memoRow, COLUMNS} = require('../labels/sheets.cjs');

let reply = {todo: 0.9}, jevReply = {todo: 0.7}, seen = [], healthy = true, failing = false;
const fake = (jev = false) => http.createServer((req, res) => {
  if (req.url === '/health') {
    res.statusCode = healthy ? 200 : 503;
    return res.end(JSON.stringify({model: 'mica-v0.1-4b'}));
  }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (failing) { res.statusCode = 503; return res.end('{}'); }
    const input = JSON.parse(body);
    seen.push(input);
    const probabilities = jev ? jevReply : reply;
    const choice = Object.keys(probabilities).reduce((a, b) => probabilities[b] > probabilities[a] ? b : a);
    res.end(JSON.stringify({answers: {q: {choice, probabilities}}}));
  });
});
const server = fake(), jev = fake(true);
let mica, classifyMemo, clearMemoCache;
function fresh() {
  delete require.cache[require.resolve('../labels/mica.cjs')];
  delete require.cache[require.resolve('../labels/memo-classify.cjs')];
  mica = require('../labels/mica.cjs');
  classifyMemo = require('../labels/memo-classify.cjs').classifyMemo;
  clearMemoCache = require('../labels/memo-classify.cjs').clearMemoCache;
}
test.before(async () => {
  await Promise.all([server, jev].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  process.env.CODEX_MEMO_MICA_URL = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  process.env.CODEX_MEMO_JEV_URL = `http://127.0.0.1:${/** @type {any} */ (jev.address()).port}`;
  process.env.JEV_API_KEY = 'fake-test-key';
  process.env.CODEX_MEMO_CLASSIFIER = 'mica';
  fresh();
});
test.after(() => { server.close(); jev.close(); });
test.beforeEach(() => clearMemoCache());

test('네 분류를 반환하고 선택지와 내 메모 우선 지시를 보낸다', async () => {
  for (const category of ['todo', 'idea', 'question', 'reference']) {
    clearMemoCache();
    reply = {[category]: 0.9};
    assert.deepEqual(await classifyMemo({title: '대화', quote: '인용', note: '내 생각'}), {category, confidence: 0.9});
  }
  assert.deepEqual(Object.keys(seen.at(-1).questions.q.criteria), ['todo', 'idea', 'question', 'reference']);
  assert.match(seen.at(-1).questions.q.instructions, /내 메모.*우선/);
});

test('확률 0.6은 분류하고 0.6 미만은 미분류', async () => {
  reply = {todo: 0.6, idea: 0.4};
  assert.deepEqual(await classifyMemo({note: '나중에 확인'}), {category: 'todo', confidence: 0.6});
  reply = {todo: 0.599, idea: 0.401};
  clearMemoCache();
  assert.equal(await classifyMemo({note: '나중에 확인'}), null);
});

test('내 메모가 비어 있으면 인용만으로 판단한다', async () => {
  reply = {reference: 0.8};
  assert.deepEqual(await classifyMemo({quote: '기억할 설명', note: ''}), {category: 'reference', confidence: 0.8});
  assert.match(seen.at(-1).state, /인용: 기억할 설명\n내 메모: $/);
});

test('인용과 메모의 길이를 제한하고 둘 다 비었으면 요청하지 않는다', async () => {
  await classifyMemo({title: '제목', quote: '가'.repeat(800), note: '나'.repeat(500)});
  assert.equal(seen.at(-1).state, `대화 제목: 제목\n인용: ${'가'.repeat(600)}\n내 메모: ${'나'.repeat(400)}`);
  const count = seen.length;
  assert.equal(await classifyMemo({quote: ' ', note: '\n', title: '제목만'}), null);
  assert.equal(seen.length, count);
});

test('잘못된 선택지나 확률은 저장하지 않는다', async () => {
  for (const probabilities of [{other: 0.99}, {todo: 2}, {todo: 'invalid'}]) {
    reply = /** @type {any} */ (probabilities);
    assert.equal(await classifyMemo({note: '확인할 것'}), null);
  }
});

test('JEV와 평균 모드도 같은 기능을 쓴다 (실제 서비스 호출 없음)', async () => {
  mica.setMode('jev');
  jevReply = {idea: 0.95};
  assert.deepEqual(await classifyMemo({note: '기능 제안'}), {category: 'idea', confidence: 0.95});
  mica.setMode('both');
  clearMemoCache();
  reply = {idea: 0.65};
  const result = await classifyMemo({note: '기능 제안'});
  assert.equal(result.category, 'idea');
  assert.ok(Math.abs(result.confidence - 0.8) < 1e-9);
  mica.setMode('mica');
});

test('서버 실패는 조용히 null을 반환한다', async () => {
  failing = true;
  assert.equal(await classifyMemo({note: '확인'}), null);
  failing = false;
});

test('같은 요청은 한 번만 판단하고 반환값 변경은 캐시에 영향을 주지 않는다', async () => {
  reply = {todo: 0.9};
  const count = seen.length;
  const results = await Promise.all([1, 2, 3].map(() => classifyMemo({note: '중복 요청'})));
  assert.equal(seen.length, count + 1);
  results[0].category = 'idea';
  assert.equal((await classifyMemo({note: '중복 요청'})).category, 'todo');
  assert.equal(seen.length, count + 1);
  clearMemoCache();
  reply = {reference: 0.95};
  assert.equal((await classifyMemo({note: '중복 요청'})).category, 'reference');
  assert.equal(seen.length, count + 2);
});

test('꺼져 있으면 요청하지 않고 나중에 켜지면 다시 분류한다', async () => {
  healthy = false;
  fresh();
  const count = seen.length;
  assert.equal(await classifyMemo({note: '확인'}), null);
  assert.equal(seen.length, count);
  healthy = true;
  reply = {todo: 0.9};
  // 실제 분류기의 상태 캐시 30초가 지난 시각을 흉내 낸다.
  const now = Date.now();
  const original = Date.now;
  Date.now = () => now + 31000;
  try { assert.equal((await classifyMemo({note: '확인'})).category, 'todo'); }
  finally { Date.now = original; }
});

test('시트 분류 열에는 한국어 이름을 넣고 옛 메모는 미분류로 보낸다', () => {
  assert.ok(COLUMNS.some(([key, title]) => key === 'category' && title === '분류'));
  for (const [category, label] of Object.entries({todo: '할 일', idea: '아이디어', question: '질문', reference: '참고'})) {
    assert.equal(memoRow({category}).category, label);
  }
  assert.equal(memoRow({note: '옛 메모'}).category, '미분류');
});

test('직접 고를 때 쓰는 분류별 확률과 조절한 기준', async () => {
  fresh();
  const {memoScores} = require('../labels/memo-classify.cjs');
  reply = {todo: 0.5, idea: 0.3, question: 0.1, reference: 0.1};
  const memo = {quote: '기준 조절 시험', note: '나중에 확인'};
  assert.deepEqual(await memoScores(memo), {todo: 0.5, idea: 0.3, question: 0.1, reference: 0.1});
  assert.equal(await classifyMemo(memo), null);                                   // 기본 기준 0.6
  assert.deepEqual(await classifyMemo(memo, 0.45), {category: 'todo', confidence: 0.5});
});
