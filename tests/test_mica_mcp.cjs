// @ts-check
'use strict';
// 별도 stdio 프로세스와 가짜 HTTP 서버만 사용한다. 실제 앱·설정·분류기에는 연결하지 않는다.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');

const seen = [];
let running = 0, peak = 0;
const flags = {micaDown: false, jevDown: false, malformed: false, boolean: false};
function fake(name) {
  return http.createServer((req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({model: 'mica-v0.1-4b'}));
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body);
      seen.push({name, request, auth: req.headers.authorization});
      if (flags[`${name}Down`]) { res.statusCode = 503; return res.end('{}'); }
      running++; peak = Math.max(peak, running);
      setTimeout(() => {
        running--;
        const answers = {};
        for (const [key, q] of Object.entries(request.questions)) {
          if (flags.malformed || request.state === '잘못된 응답') { answers[key] = {choice: '없음', probabilities: {}}; continue; }
          if (q.type === 'noul') {
            answers[key] = flags.boolean ? {answer: name === 'mica', confidence: 0.9} : {noul: name === 'mica' ? 0.1 : 0.7};
          } else {
            const ids = Object.keys(q.criteria), choice = ids[name === 'mica' ? 0 : 1];
            answers[key] = {choice, probabilities: Object.fromEntries(ids.map(id => [id, id === choice ? 0.9 : 0.1 / (ids.length - 1)]))};
          }
        }
        res.end(JSON.stringify({answers}));
      }, 15);
    });
  });
}
const servers = {mica: fake('mica'), jev: fake('jev')};
const url = server => `http://127.0.0.1:${server.address().port}`;
test.before(async () => {
  await Promise.all(Object.values(servers).map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
});
test.after(async () => {
  await Promise.all(Object.values(servers).map(server => new Promise(resolve => server.close(resolve))));
});
test.beforeEach(() => {
  for (const key of Object.keys(flags)) flags[key] = false;
  seen.length = 0; running = 0; peak = 0;
});

function client(t, env = {}) {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../labels/mica-mcp.cjs')], {
    env: {...process.env, CODEX_MEMO_MICA_URL: url(servers.mica), CODEX_MEMO_JEV_URL: url(servers.jev),
      CODEX_MEMO_CLASSIFIER: 'mica', JEV_API_KEY: 'fake-test-key', ...env},
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map(), messages = [];
  let serial = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = readline.createInterface({input: child.stdout});
  lines.on('line', line => {
    // stdout에 로그나 빈 줄이 섞이면 테스트가 실패한다.
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0'); messages.push(message);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  });
  const exit = new Promise(resolve => child.on('exit', (code, signal) => resolve({code, signal})));
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 2000);
    const status = await exit; clearTimeout(timer); lines.close();
    assert.equal(status.code, 0, stderr);
    assert.equal(stderr, '');
  });
  function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }
  function raw(line, id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('MCP 응답 시간 초과')); }, 12000);
      pending.set(id, message => { clearTimeout(timer); resolve(message); });
      child.stdin.write(`${line}\n`);
    });
  }
  function rpc(method, params, id = ++serial) { return raw(JSON.stringify({jsonrpc: '2.0', id, method, ...(params === undefined ? {} : {params})}), id); }
  async function init(protocolVersion = '2025-11-25') {
    const response = await rpc('initialize', {protocolVersion, capabilities: {}, clientInfo: {name: '가짜 클라이언트', version: '1'}});
    send({jsonrpc: '2.0', method: 'notifications/initialized'});
    return response;
  }
  async function call(name, args) {
    const response = await rpc('tools/call', {name, arguments: args});
    assert.ok(response.result, JSON.stringify(response));
    return {...response.result, data: JSON.parse(response.result.content[0].text)};
  }
  return {rpc, raw, init, call, send, messages};
}
const base = {text: '라우터 설정', question: '어느 분야인가?', options: {net: '네트워크', web: '웹 화면'}};

test('초기화·네 도구 목록·ping·알림·문자열 id', async t => {
  const c = client(t);
  assert.equal((await c.rpc('tools/list')).error.code, -32000);
  const initial = await c.init('2024-11-05');
  assert.equal(initial.result.protocolVersion, '2024-11-05');
  assert.deepEqual(initial.result.serverInfo, {name: 'mica', version: '1.0.0'});
  assert.deepEqual(initial.result.capabilities, {tools: {listChanged: false}});
  c.send({jsonrpc: '2.0', method: '알 수 없는 알림'});
  const list = (await c.rpc('tools/list')).result.tools;
  assert.deepEqual(list.map(tool => tool.name), ['mica_choose', 'mica_yes_no', 'mica_score', 'mica_batch']);
  for (const tool of list) {
    assert.match(tool.description, /빠르고 무료인 로컬 판단기/);
    assert.match(tool.description, /0\.8/);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.properties.classifier.enum, ['mica', 'jev', 'both']);
  }
  assert.deepEqual((await c.rpc('ping', undefined, '문자열 id')).result, {});
  assert.equal(c.messages.length, 4); // 알림 응답 없음
  assert.equal(seen.length, 0); // 목록·초기화는 분류기를 부르지 않음
});

test('지원하지 않는 버전은 지원 버전으로 협상한다', async t => {
  const c = client(t);
  assert.equal((await c.init('2099-01-01')).result.protocolVersion, '2025-11-25');
  assert.equal((await c.rpc('initialize', {})).error.code, -32602);
});

test('선택: 객체·배열 선택지, 확률과 실제 분류기', async t => {
  const c = client(t); await c.init();
  const r = await c.call('mica_choose', base);
  assert.equal(r.isError, false);
  assert.deepEqual(r.data, {choice: 'net', description: '네트워크', probabilities: {net: 0.9, web: 0.1}, confidence: 0.9, reliable: true, classifier: 'mica', classifierName: 'Mica'});
  const a = await c.call('mica_choose', {...base, options: ['네트워크', '웹 화면']});
  assert.equal(a.data.choice, '0');
  assert.deepEqual(seen[0].request, {state: base.text, questions: {q: {type: 'choice', instructions: base.question, criteria: base.options}}});
  const special = await c.call('mica_choose', {...base, classifier: 'both', options: Object.fromEntries([['__proto__', '첫 선택지'], ['web', '둘째 선택지']])});
  assert.equal(special.isError, false);
  assert.equal(special.data.probabilities.__proto__, 0.5);
});

test('예/아니오: noul·answer/confidence 형식, both 평균과 낮은 확신', async t => {
  const c = client(t); await c.init();
  const r = await c.call('mica_yes_no', {text: '글', question: '해당하는가?'});
  assert.equal(r.data.answer, false); assert.equal(r.data.confidence, 0.9);
  flags.boolean = true;
  const b = await c.call('mica_yes_no', {text: '글', question: '?', classifier: 'mica'});
  assert.equal(b.data.answer, true); assert.equal(b.data.confidence, 0.9);
  const avg = await c.call('mica_yes_no', {text: '글', question: '?', classifier: 'both'});
  assert.equal(avg.data.confidence, 0.5); assert.equal(avg.data.reliable, false);
  flags.boolean = false;
  const n = await c.call('mica_yes_no', {text: '글', question: '?', classifier: 'both'});
  assert.equal(n.data.answer, false); assert.ok(Math.abs(n.data.confidence - 0.6) < 1e-9);
});

test('점수: 낮음→높음의 1부터 시작하는 선택 점수', async t => {
  const c = client(t); await c.init();
  const r = await c.call('mica_score', {text: '글', question: '길이는?', scale: ['짧음', '중간', '길음'], classifier: 'jev'});
  assert.equal(r.data.score, 2); assert.equal(r.data.description, '중간');
  assert.equal(r.data.confidence, 0.9); assert.equal(r.data.classifierName, 'JEV');
});

test('일괄: 동시에 최대 4개, 입력 순서와 id 보존', async t => {
  const c = client(t); await c.init();
  const items = Array.from({length: 9}, (_, i) => ({id: `항목${i}`, text: `글${i}`}));
  const r = await c.call('mica_batch', {items, question: base.question, options: base.options});
  assert.equal(r.isError, false);
  assert.deepEqual(r.data.items.map(item => item.id), items.map(item => item.id));
  assert.ok(r.data.items.every(item => item.choice === 'net' && item.classifier === 'mica'));
  assert.equal(seen.length, 9); assert.equal(peak, 4);
});

test('환경 기본 선택·동시 호출의 선택 분리·both 평균', async t => {
  const c = client(t, {CODEX_MEMO_CLASSIFIER: 'jev'}); await c.init();
  assert.equal((await c.call('mica_choose', base)).data.classifier, 'jev');
  const [a, b] = await Promise.all([c.call('mica_choose', {...base, classifier: 'mica'}), c.call('mica_choose', {...base, classifier: 'jev'})]);
  assert.equal(a.data.choice, 'net'); assert.equal(b.data.choice, 'web');
  assert.equal(a.data.classifier, 'mica'); assert.equal(b.data.classifier, 'jev');
  const avg = await c.call('mica_choose', {...base, classifier: 'both'});
  assert.deepEqual(avg.data.probabilities, {net: 0.5, web: 0.5});
  assert.equal(avg.data.classifier, 'both'); assert.equal(avg.data.classifierName, 'Mica+JEV');
  assert.equal(avg.data.reliable, false);
  assert.equal((await c.call('mica_choose', base)).data.classifier, 'jev');
  assert.ok(seen.filter(r => r.name === 'jev').every(r => r.auth === 'Bearer fake-test-key'));
});

test('both의 한쪽 실패는 실제 답한 분류기로 표시한다', async t => {
  const c = client(t); await c.init(); flags.jevDown = true;
  const r = await c.call('mica_choose', {...base, classifier: 'both'});
  assert.equal(r.isError, false); assert.equal(r.data.classifier, 'mica'); assert.equal(r.data.confidence, 0.9);
  flags.jevDown = false; flags.micaDown = true;
  const other = await c.call('mica_choose', {...base, classifier: 'both'});
  assert.equal(other.isError, false); assert.equal(other.data.classifier, 'jev');
});

test('꺼진 Mica·없는 JEV 키·HTTP 실패는 복구 안내를 반환한다', async t => {
  // 닫힌 테스트 포트만 가리킨다. 기본 8010이나 실제 JEV 주소를 쓰지 않는다.
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const closedUrl = url(closed); await new Promise(resolve => closed.close(resolve));
  const c = client(t, {CODEX_MEMO_MICA_URL: closedUrl, JEV_API_KEY: ''}); await c.init();
  for (const classifier of ['mica', 'jev', 'both']) {
    const r = await c.call('mica_choose', {...base, classifier});
    assert.equal(r.isError, true);
    assert.match(r.data.error, classifier === 'jev' ? /JEV_API_KEY/ : /Start-Mica\.cmd/);
  }
  assert.equal(seen.length, 0);
  const d = client(t); await d.init(); flags.jevDown = true;
  const failure = await d.call('mica_choose', {...base, classifier: 'jev'});
  assert.equal(failure.isError, true); assert.match(failure.data.error, /서비스 상태/);
});

test('잘못된 도구 인자·모델 응답은 오류, 일괄 오류는 id별로 반환', async t => {
  const c = client(t); await c.init();
  const bad = [{...base, text: ''}, {...base, classifier: 'gpt'}, {...base, classifier: null},
    {...base, options: ['하나']}, {...base, options: {a: '하나', b: 2}}, {...base, extra: true}];
  for (const args of bad) assert.equal((await c.call('mica_choose', args)).isError, true);
  assert.equal((await c.call('mica_score', {text: '글', question: '?', scale: {a: '낮음', b: '높음'}})).isError, true);
  assert.equal((await c.call('mica_batch', {question: '?', options: base.options, items: [{id: '중복', text: '글'}, {id: '중복', text: '글'}]})).isError, true);
  assert.equal(seen.length, 0);
  flags.malformed = true;
  assert.equal((await c.call('mica_choose', base)).isError, true);
  assert.equal((await c.call('mica_yes_no', {text: '글', question: '?'})).isError, true);
  const batch = await c.call('mica_batch', {question: '?', options: base.options, items: [{id: '하나', text: '글'}]});
  assert.equal(batch.isError, true); assert.equal(batch.data.items[0].id, '하나'); assert.match(batch.data.items[0].error, /확률 표/);
});

test('깨진 JSON·잘못된 요청·없는 메서드 뒤에도 서버가 응답한다', async t => {
  const c = client(t); await c.init();
  assert.equal((await c.raw('{', null)).error.code, -32700);
  assert.equal((await c.raw('[]', null)).error.code, -32600);
  assert.equal((await c.raw('{"jsonrpc":"1.0","id":5,"method":"ping"}', null)).error.code, -32600);
  assert.equal((await c.rpc('없음')).error.code, -32601);
  assert.equal((await c.rpc('tools/call', {name: '없음'})).error.code, -32602);
  assert.equal((await c.rpc('tools/list', {cursor: '없음'})).error.code, -32602);
  assert.deepEqual((await c.rpc('ping')).result, {});
});

test('일괄 일부 실패에도 성공 결과와 입력 순서가 남는다', async t => {
  const c = client(t); await c.init();
  const items = [{id: '정상1', text: '정상 글'}, {id: '실패', text: '잘못된 응답'}, {id: '정상2', text: '정상 글'}];
  const batch = await c.call('mica_batch', {items, question: '?', options: base.options});
  assert.equal(batch.isError, true);
  assert.deepEqual(batch.data.items.map(item => item.id), items.map(item => item.id));
  assert.equal(batch.data.items[0].choice, 'net'); assert.equal(batch.data.items[2].choice, 'net');
  assert.match(batch.data.items[1].error, /확률 표/);
  assert.equal(batch.data.items[1].choice, undefined);
});
