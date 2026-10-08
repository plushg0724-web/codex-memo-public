// 분류기 선택(labels/mica.cjs: mica / jev / both) 검사. 가짜 Mica·JEV 서버를 쓴다.
// 실행: node --test tests/test_classifier.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const seen = {mica: 0, jev: 0, auth: ''};
let reply = {mica: {}, jev: {}};
let jevDown = false;

function fake(name) {
  return http.createServer((req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({status: 'ok', model: 'mica-v0.1-4b'}));
    if (name === 'jev' && jevDown) { res.statusCode = 500; return res.end('{}'); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen[name]++;
      if (name === 'jev') seen.auth = req.headers.authorization || '';
      const answers = {};
      for (const [qname, q] of Object.entries(JSON.parse(body).questions)) {
        if (q.type === 'noul') { answers[qname] = {type: 'noul', noul: reply[name].noul ?? 0.5}; continue; }
        const ids = Object.keys(q.criteria);
        const probabilities = Object.fromEntries(ids.map(id => [id, reply[name][id] ?? 0]));
        answers[qname] = {type: 'choice', choice: ids.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a)), probabilities};
      }
      res.end(JSON.stringify({answers}));
    });
  });
}
const servers = {mica: fake('mica'), jev: fake('jev')};

let mica;
test.before(async () => {
  for (const s of Object.values(servers)) await new Promise(r => s.listen(0, '127.0.0.1', r));
  process.env.CODEX_MEMO_MICA_URL = `http://127.0.0.1:${servers.mica.address().port}`;
  process.env.CODEX_MEMO_JEV_URL = `http://127.0.0.1:${servers.jev.address().port}`;
  process.env.JEV_API_KEY = 'test-key';
  delete process.env.CODEX_MEMO_CLASSIFIER;
  mica = require('../labels/mica.cjs');
});
test.after(() => Object.values(servers).forEach(s => s.close()));

const senses = [{id: 'net', meaning: '네트워크 경로'}, {id: 'web', meaning: '웹 화면 연결'}];

test('기본은 Mica 만 쓴다', async () => {
  reply = {mica: {net: 0.9, web: 0.1}, jev: {web: 1}};
  const before = {...seen};
  assert.strictEqual(mica.getMode(), 'mica');
  assert.deepStrictEqual(await mica.judgeSense('라우팅', '문맥', senses), {choice: 'net', confidence: 0.9, via: 'Mica'});
  assert.strictEqual(seen.jev, before.jev);
});

test('JEV 만 고르면 JEV 에 열쇠와 함께 묻는다', async () => {
  mica.setMode('jev');
  reply = {mica: {net: 1}, jev: {web: 0.95, net: 0.05}};
  const before = {...seen};
  assert.deepStrictEqual(await mica.judgeSense('라우팅', '문맥', senses), {choice: 'web', confidence: 0.95, via: 'JEV'});
  assert.strictEqual(seen.mica, before.mica);
  assert.strictEqual(seen.auth, 'Bearer test-key');
});

test('둘 다: 확률을 평균 낸다 (선택지·예/아니오 모두)', async () => {
  mica.setMode('both');
  reply = {mica: {net: 0.9, web: 0.1, noul: 0.9}, jev: {net: 0.5, web: 0.5, noul: 0.3}};
  const r = await mica.rankSenses('라우팅', '문맥', senses);
  assert.strictEqual(r.choice, 'net');
  assert.ok(Math.abs(r.confidence - 0.7) < 1e-9, String(r.confidence));
  assert.strictEqual(await mica.judgeSense('라우팅', '문맥', senses), null);   // 평균 0.7 < 0.8 → 모름
  const a = await mica.ask('글', {y: {type: 'noul', instructions: '?'}});
  assert.ok(Math.abs(a.y.noul - 0.6) < 1e-9);
  assert.strictEqual(a.y.answer, true);
});

test('둘 다: 한쪽이 실패하면 다른 쪽 답만 쓴다', async () => {
  mica.setMode('both');
  jevDown = true;
  reply = {mica: {net: 0.92, web: 0.08}, jev: {}};
  const r = await mica.judgeSense('라우팅', '문맥', senses);
  assert.strictEqual(r.choice, 'net');
  assert.strictEqual(r.confidence, 0.92);
  jevDown = false;
});

test('JEV 열쇠가 없으면 JEV 는 못 씀', async () => {
  delete require.cache[require.resolve('../labels/mica.cjs')];
  delete process.env.JEV_API_KEY;
  const fresh = require('../labels/mica.cjs');
  fresh.setMode('jev');
  assert.strictEqual(await fresh.available(), false);
  assert.strictEqual(await fresh.judgeSense('라우팅', '문맥', senses), null);
  assert.throws(() => fresh.setMode('gpt'));
});
