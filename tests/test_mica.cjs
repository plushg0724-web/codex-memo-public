// Mica 연동(labels/mica.cjs) 검사. 실제 Mica 대신 가짜 서버를 쓴다.
// 실행: node --test tests/test_mica.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

let reply = {};   // 다음 판단 요청에 돌려줄 확률
const server = http.createServer((req, res) => {
  if (req.url === '/health') return res.end(JSON.stringify({status: 'ok', model: 'mica-v0.1-4b'}));
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const [name, q] = Object.entries(JSON.parse(body).questions)[0];   // 질문 이름과 상관없이 첫 질문
    const ids = Object.keys(q.criteria);
    const probabilities = Object.fromEntries(ids.map(id => [id, reply[id] ?? 0]));
    const choice = ids.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
    res.end(JSON.stringify({answers: {[name]: {choice, probabilities}}}));
  });
});

let mica;
test.before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.CODEX_MEMO_MICA_URL = `http://127.0.0.1:${server.address().port}`;
  mica = require('../labels/mica.cjs');
});
test.after(() => server.close());

const senses = [{id: 'net', meaning: '네트워크 경로'}, {id: 'web', meaning: '웹 화면 연결'}];

test('확신이 높으면 저장된 뜻을 고른다', async () => {
  reply = {net: 0.97, web: 0.02, __new__: 0.01};
  assert.deepStrictEqual(await mica.judgeSense('라우팅', '라우터 테이블', senses), {choice: 'net', confidence: 0.97, via: 'Mica'});
});

test('새 뜻이면 choice 는 new', async () => {
  reply = {net: 0.05, web: 0.03, __new__: 0.92};
  assert.strictEqual((await mica.judgeSense('라우팅', '콜센터 배정', senses)).choice, 'new');
});

test('확신이 낮으면 모름(null) → GPT 로 넘긴다', async () => {
  reply = {net: 0.55, web: 0.4, __new__: 0.05};
  assert.strictEqual(await mica.judgeSense('라우팅', '애매한 문맥', senses), null);
});

test('순서용 확률은 확신과 상관없이 돌려준다', async () => {
  reply = {net: 0.3, web: 0.6, __new__: 0.1};
  const r = await mica.rankSenses('라우팅', '문맥', senses);
  assert.ok(r.probabilities.web > r.probabilities.net);
});

test('처음 동시에 들어온 요청들도 모두 판단받는다 (켜짐 확인을 함께 기다림)', async () => {
  delete require.cache[require.resolve('../labels/mica.cjs')];
  const fresh = require('../labels/mica.cjs');
  reply = {net: 0.97, web: 0.02, __new__: 0.01};
  const results = await Promise.all([1, 2, 3].map(() => fresh.judgeSense('라우팅', '문맥', senses)));
  assert.ok(results.every(r => r && r.choice === 'net'), JSON.stringify(results));
});

test('Mica 가 꺼져 있으면 모름(null)', async () => {
  await new Promise(r => server.close(r));
  // 켜져 있다고 기억한 시간(30초)을 지나도록 다시 불러온다
  delete require.cache[require.resolve('../labels/mica.cjs')];
  const fresh = require('../labels/mica.cjs');
  assert.strictEqual(await fresh.judgeSense('라우팅', '문맥', senses), null);
  assert.strictEqual(await fresh.rankSenses('라우팅', '문맥', senses), null);
});
