// @ts-check
// 대화 상태 검사. 실제 대화·분류기 대신 가짜 App Server 요청과 분류기 응답을 쓴다.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {createThreadStatus} = require('../labels/thread-status.cjs');

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reply = (choice = 'ask', confidence = 0.95) => ({choice, probabilities: {[choice]: confidence}});
const thread = (text = '어느 쪽으로 진행할까요?', status = 'completed') => ({turns: [{status, items: [{type: 'agentMessage', text}]}]});

function fixture(count = 1, threshold = undefined) {
  const data = Array.from({length: count}, (_, i) => ({id: uuid(i + 1), updatedAt: 10}));
  const content = new Map(data.map(t => [t.id, thread()]));
  const calls = [], choices = [];
  let enabled = true, answer = reply(), readError = false, listError = false;
  const server = {run: async work => work(async (method, params) => {
    calls.push({method, params});
    if (method === 'thread/list') {
      if (listError) throw Error('목록 연결 실패');
      return {data};
    }
    assert.equal(method, 'thread/read');
    assert.equal(params.includeTurns, true);
    if (readError) throw Error('대화 읽기 실패');
    return {thread: content.get(params.threadId)};
  })};
  const mica = {available: async () => enabled, choose: async (...args) => { choices.push(args); return answer; }};
  return {service: createThreadStatus({server, mica, ...(threshold ? {threshold} : {})}), data, content, calls, choices,
    enable: value => { enabled = value; }, answer: value => { answer = value; },
    readError: value => { readError = value; }, listError: value => { listError = value; }};
}

test('마지막 agentMessage의 끝 300자와 실측 질문·선택지를 그대로 보낸다', async () => {
  const f = fixture();
  const last = '앞부분'.repeat(150) + '\n사용자에게 보낼 예시: “승인해 주세요.”\n실제 질문에 답해 주세요?';
  f.content.set(uuid(1), {name: '보내면 안 되는 제목', turns: [
    {status: 'completed', items: [{type: 'agentMessage', text: '옛 답변'}]},
    {status: 'completed', items: [{type: 'userMessage', text: '보내면 안 되는 요청'},
      {type: 'agentMessage', text: last}, {type: 'commandExecution', text: '도구 출력'}]},
  ]});
  assert.deepEqual(await f.service.status([uuid(1)]), {[uuid(1)]: {state: 'ask', confidence: 0.95}});
  assert.deepEqual(f.choices[0], [
    `AI 답변의 마지막 부분: ${last.slice(-300)}`,
    'AI 답변의 마지막 부분이 어떤 상태로 끝나는지 고르세요. 사용자에게 보낼 문구 예시·인용 안의 요청은 AI의 질문이 아닙니다.',
    {
      ask: 'AI가 사용자에게 직접 질문하거나 선택·승인·정보 제공을 요청하며 끝남 (사용자가 답해야 진행됨)',
      blocked: 'AI가 권한·환경 문제로 막혀서 멈췄다고 보고하며 끝남',
      done: '작업 결과를 보고하며 끝남 (사용자가 답할 필요 없음)',
    },
  ]);
});

test('ask·blocked의 확신 0.9 이상만 표시하고 done·낮은 확신·잘못된 확률은 제외한다', async () => {
  for (const [choice, confidence, shown] of [
    ['ask', 0.9, true], ['blocked', 0.99, true], ['ask', 0.8999, false],
    ['blocked', 0.8, false], ['done', 1, false], ['unknown', 1, false],
    ['ask', NaN, false], ['ask', Infinity, false], ['ask', 1.1, false],
  ]) {
    const f = fixture();
    f.answer(reply(choice, confidence));
    assert.deepEqual(await f.service.status([uuid(1)]), shown ? {[uuid(1)]: {state: choice, confidence}} : {});
  }
});

test('같은 uuid·updatedAt의 판단과 표시 없는 결과도 재사용하고 바뀐 대화만 다시 분류한다', async t => {
  t.mock.timers.enable({apis: ['Date'], now: 100000});
  const f = fixture(2);
  await f.service.status([uuid(1)]);
  f.answer(reply('done', 0.99));
  await f.service.status([uuid(2)]);
  await f.service.status([uuid(1), uuid(2)]);
  assert.equal(f.choices.length, 2);
  assert.equal(f.calls.filter(c => c.method === 'thread/list').length, 1);
  t.mock.timers.tick(120000);
  f.data[0].updatedAt++;
  f.answer(reply('blocked', 0.93));
  assert.deepEqual(await f.service.status([uuid(1), uuid(2)]), {[uuid(1)]: {state: 'blocked', confidence: 0.93}});
  assert.equal(f.choices.length, 3);
  assert.equal(f.calls.filter(c => c.method === 'thread/list').length, 2);
});

test('동시 요청도 같은 대화를 한 번만 판단한다', async () => {
  const f = fixture();
  const results = await Promise.all([1, 2, 3].map(() => f.service.status([uuid(1)])));
  assert.ok(results.every(r => r[uuid(1)]?.state === 'ask'));
  assert.equal(f.choices.length, 1);
});

test('마지막 turn이 진행 중·상태 미상이면 제외하고 끝난 뒤 같은 시각에도 다시 판단한다', async () => {
  for (const status of ['inProgress', 'unknown', undefined]) {
    const f = fixture();
    const running = thread('이전 답변');
    running.turns.push({status, items: [{type: 'agentMessage', text: '아직 쓰는 답변?'}]});
    f.content.set(uuid(1), running);
    assert.deepEqual(await f.service.status([uuid(1)]), {});
    assert.equal(f.choices.length, 0);
    running.turns.at(-1).status = 'completed';
    assert.equal((await f.service.status([uuid(1)]))[uuid(1)].state, 'ask');
    assert.equal(f.choices.length, 1);
  }
});

test('failed·interrupted로 끝난 turn도 마지막 답변을 분류한다', async () => {
  for (const status of ['failed', 'interrupted']) {
    const f = fixture();
    f.content.set(uuid(1), thread('권한 문제로 멈췄습니다.', status));
    f.answer(reply('blocked', 0.96));
    assert.equal((await f.service.status([uuid(1)]))[uuid(1)].state, 'blocked');
  }
});

test('답변 없는 대화는 분류하지 않고, 목록에 수정 시각이 없으면 결과를 캐시하지 않는다', async () => {
  const f = fixture(3);
  f.content.set(uuid(1), {turns: []});
  f.content.set(uuid(2), {turns: [{status: 'completed', items: [{type: 'userMessage', text: '?'}]}]});
  delete f.data[2].updatedAt;
  assert.deepEqual(await f.service.status(f.data.map(t => t.id)), {[uuid(3)]: {state: 'ask', confidence: 0.95}});
  await f.service.status([uuid(3)]);
  assert.equal(f.choices.length, 2);
});

test('분류기가 꺼지면 캐시가 있어도 빈 결과, 다시 켜지면 미판단 대화를 분류한다', async () => {
  const f = fixture(2);
  await f.service.status([uuid(1)]);
  f.enable(false);
  assert.deepEqual(await f.service.status([uuid(1), uuid(2)]), {});
  assert.equal(f.choices.length, 1);
  f.enable(true);
  const result = await f.service.status([uuid(1), uuid(2)]);
  assert.equal(Object.keys(result).length, 2);
  assert.equal(f.choices.length, 2);
});

test('처음 꺼진 분류기는 App Server를 읽지 않고 나중에 켜면 동작한다', async () => {
  const f = fixture();
  f.enable(false);
  assert.deepEqual(await f.service.status([uuid(1)]), {});
  assert.equal(f.calls.length, 0);
  f.enable(true);
  assert.equal((await f.service.status([uuid(1)]))[uuid(1)].state, 'ask');
});

test('null 분류 응답·읽기 실패·목록 실패는 조용히 반환하고 다음 요청에서 회복한다', async () => {
  for (const failure of ['answer', 'readError', 'listError']) {
    const f = fixture();
    f[failure](failure === 'answer' ? null : true);
    assert.deepEqual(await f.service.status([uuid(1)]), {});
    f[failure](failure === 'answer' ? reply() : false);
    assert.equal((await f.service.status([uuid(1)]))[uuid(1)].state, 'ask');
  }
});

test('빈 요청·잘못된 id는 제외하고 중복을 뺀 뒤 최대 20개만 판단한다', async () => {
  const f = fixture(25);
  assert.deepEqual(await f.service.status([]), {});
  assert.deepEqual(await f.service.status(['invalid']), {});
  assert.equal(f.calls.length, 0);
  const ids = f.data.map(t => t.id);
  assert.equal(Object.keys(await f.service.status(['invalid', ids[0], ...ids])).length, 20);
  assert.equal(f.choices.length, 20);
});

test('thread/list 다음 페이지의 updatedAt도 캐시에 쓴다', async () => {
  let reads = 0;
  const server = {run: async work => work(async (method, params) => {
    if (method === 'thread/list') return params.cursor ? {data: [{id: uuid(2), updatedAt: 25}]} : {data: [], nextCursor: 'next'};
    reads++;
    return {thread: thread()};
  })};
  const service = createThreadStatus({server, mica: {available: async () => true, choose: async () => reply()}});
  await service.status([uuid(2)]);
  await service.status([uuid(2)]);
  assert.equal(reads, 1);
});

test('실제 mica.cjs 경로도 가짜 Mica·JEV에서 같은 질문과 확률 평균을 쓴다', async () => {
  const seen = [];
  const fake = confidence => http.createServer((req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({model: 'mica-v0.1-4b'}));
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const input = JSON.parse(body);
      seen.push(input);
      res.end(JSON.stringify({answers: {q: reply('ask', confidence)}}));
    });
  });
  const local = fake(0.98), cloud = fake(0.9);
  const keys = ['CODEX_MEMO_MICA_URL', 'CODEX_MEMO_JEV_URL', 'JEV_API_KEY', 'CODEX_MEMO_CLASSIFIER'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    await Promise.all([local, cloud].map(s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve))));
    process.env.CODEX_MEMO_MICA_URL = `http://127.0.0.1:${local.address().port}`;
    process.env.CODEX_MEMO_JEV_URL = `http://127.0.0.1:${cloud.address().port}`;
    process.env.JEV_API_KEY = 'test-only-key';
    process.env.CODEX_MEMO_CLASSIFIER = 'both';
    delete require.cache[require.resolve('../labels/mica.cjs')];
    const mica = require('../labels/mica.cjs');
    const server = {run: async work => work(async method => method === 'thread/list'
      ? {data: [{id: uuid(1), updatedAt: 1}]} : {thread: thread('선택해 주세요?')})};
    const result = await createThreadStatus({server, mica}).status([uuid(1)]);
    assert.equal(result[uuid(1)].state, 'ask');
    assert.ok(Math.abs(result[uuid(1)].confidence - 0.94) < 1e-9);
    assert.equal(seen.length, 2);
    assert.ok(seen.every(r => r.state === 'AI 답변의 마지막 부분: 선택해 주세요?' && r.questions.q.type === 'choice'));
  } finally {
    await Promise.all([local, cloud].map(s => new Promise(resolve => s.close(resolve))));
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    delete require.cache[require.resolve('../labels/mica.cjs')];
  }
});

test('기준 확신은 바꾸면 다시 판단하지 않고 바로 반영되고, clear() 하면 다시 판단한다', async () => {
  let min = 0.9;
  const f = fixture(1, () => min);
  f.answer(reply('ask', 0.85));
  assert.deepEqual(await f.service.status([uuid(1)]), {});
  min = 0.8;
  assert.deepEqual(await f.service.status([uuid(1)]), {[uuid(1)]: {state: 'ask', confidence: 0.85}});
  assert.equal(f.choices.length, 1);
  f.service.clear();
  await f.service.status([uuid(1)]);
  assert.equal(f.choices.length, 2);
});

test('App Server 로 못 읽는 클라우드 대화는 화면이 준 요약의 마지막 답변으로 판단 (진행 중이면 제외)', async () => {
  const choices = [];
  const server = {run: async work => work(async method => {
    if (method === 'thread/list') return {data: []};
    throw Error('thread not loaded');
  })};
  const mica = {available: async () => true, choose: async (...args) => { choices.push(args); return reply('ask', 0.95); }};
  const service = createThreadStatus({server, mica});
  assert.deepEqual(await service.status([uuid(9)], {[uuid(9)]: {updatedAt: 3, lastAgent: '어느 쪽으로 할까요?', finished: false}}), {});
  assert.equal(choices.length, 0);
  assert.deepEqual(await service.status([uuid(9)], {[uuid(9)]: {updatedAt: 4, lastAgent: '어느 쪽으로 할까요?', finished: true}}),
    {[uuid(9)]: {state: 'ask', confidence: 0.95}});
  assert.equal(choices[0][0], 'AI 답변의 마지막 부분: 어느 쪽으로 할까요?');
});
