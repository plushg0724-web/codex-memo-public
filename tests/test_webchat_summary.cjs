'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {createWebchatSummaryServer, vocabularySummaryServer, WEBCHAT_MODEL} = require('../dist/node/webchat-summary-server.cjs');
const {answerObject, configuration} = require('../labels/webchat-mcp.cjs');
const worker = path.join(__dirname, '../labels/webchat-mcp.cjs');
const request = {model: 'chatgpt-web', effort: 'medium', fast: false, prompt: 'Explain Cache in a test-only sentence.', schema: {type: 'object', properties: {meaning: {type: 'string'}}, required: ['meaning']}};

function fixture(t, answer = '{"meaning":"Test-only Web answer"}', typed = '', options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-webchat-test-'));
  const modulePath = path.join(dir, 'browser.cjs'), transcript = path.join(dir, 'prompt.json'), selection = path.join(dir, 'selection.json');
  fs.writeFileSync(modulePath, `const fs=require('node:fs'); let sent=false,opened=false,index=${options.initial === 'Pro' ? 4 : 1};
    const labels=['Instant','Medium','High','Extra High','Pro'],values=['none','medium','high','max','medium'];
    const trigger={waitFor:async()=>{},click:async()=>{opened=true;},getAttribute:async()=>${options.wrongValue ? "'none'" : 'values[index]'}};
    const menu={press:async()=>{opened=false;},locator:selector=>selector.includes('role="status"')
      ?{innerText:async()=>labels[index]+', '+(index+1)+' of 5.'}
      :{waitFor:async()=>{if(${Boolean(options.locked)})throw Error('control missing');},press:async key=>{if(!${Boolean(options.stuck)})index=Math.max(0,Math.min(4,index+(key==='ArrowLeft'?-1:1)));}}};
    const page={url:()=> 'https://chatgpt.com/?codexmemo-webchat=1',evaluate:async()=>true,goto:async()=>{},
      waitForFunction:async()=>{if(${Boolean(options.stuck)})throw Error('control did not change');},
      getByRole(role){return role==='textbox'?{count:async()=>1,innerText:async()=>${JSON.stringify(typed)},waitFor:async()=>{},fill:async value=>{fs.writeFileSync(${JSON.stringify(selection)},JSON.stringify({label:labels[index],value:values[index],menuOpen:opened}));fs.writeFileSync(${JSON.stringify(transcript)},JSON.stringify(value));}}:{count:async()=>0,click:async()=>{sent=true;}};},
      locator(selector){if(selector.startsWith('button[data-composer-navigation-target'))return trigger;if(selector.startsWith('[role="menu"]'))return menu;
        return selector==='[data-talvt-turn-state]'?{count:async()=>sent?1:0,last:()=>({getAttribute:async()=> 'complete'})}:{count:async()=>selector.includes('data-markdown-text-style')&&sent?1:0,last:()=>({innerText:async()=>${JSON.stringify(answer)}})};}};
    module.exports={chromium:{connectOverCDP:async()=>({contexts:()=>[{pages:()=>[page]}],close:async()=>{}})}};`);
  const config = {endpoint: 'http://127.0.0.1:9233', playwrightModule: modulePath};
  const server = createWebchatSummaryServer({worker, config: () => config});
  t.after(() => { server.close(); assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, {recursive: true, force: true}); });
  return {server, transcript, selection, config};
}

test('app vocabulary requests pass through a real MCP initialize/tool call and return Web JSON', async t => {
  const {server, transcript} = fixture(t);
  const result = await server.run(request);
  assert.deepEqual(JSON.parse(result), {meaning: 'Test-only Web answer'});
  const prompt = JSON.parse(fs.readFileSync(transcript, 'utf8'));
  assert(prompt.includes(request.prompt));
  assert(prompt.includes(JSON.stringify(request.schema)));
  assert(prompt.includes('MCP 도구, 검색, 저장 작업을 실행하지 마세요'));
});

test('Web failures stay on the selected route; Codex is never silently used as fallback', async () => {
  const calls = [];
  const codex = {run: async () => { calls.push('codex'); return 'codex'; }, close() {}};
  const webchat = {run: async () => { calls.push('webchat'); throw Error('웹챗 연결 오류'); }, close() {}};
  const router = vocabularySummaryServer(codex, webchat);
  assert.equal(await router.run({...request, model: 'gpt-6-luna'}), 'codex');
  await assert.rejects(router.run(request), /웹챗/);
  assert.deepEqual(calls, ['codex', 'webchat']);
});

test('cancellation rejects the draft and concurrent Web requests do not overwrite it', async t => {
  const {server} = fixture(t);
  let stop;
  const pending = server.run(request, {onStop: value => { stop = value; }});
  const rejection = assert.rejects(pending, /취소/);
  await assert.rejects(server.run(request), /다른 단어/);
  stop(); await rejection;
});

test('timeouts and malformed Web output fail instead of creating a draft', async t => {
  const first = fixture(t);
  await assert.rejects(first.server.run(request, {timeoutMs: 30}), /시간이 초과/);
  const second = fixture(t, 'This is not a vocabulary JSON result.');
  await assert.rejects(second.server.run(request), /JSON/);
});

test('an unsent message in the dedicated Web tab is preserved', async t => {
  const {server, transcript} = fixture(t, '{}', 'Unsent user text');
  await assert.rejects(server.run(request), /작성 중인 내용/);
  assert.equal(fs.existsSync(transcript), false);
});

test('every advertised Web effort is passed through MCP and selected before the prompt is sent', async t => {
  const expected = {none: ['Instant', 'none'], medium: ['Medium', 'medium'], high: ['High', 'high'], xhigh: ['Extra High', 'max']};
  assert.deepEqual(WEBCHAT_MODEL.efforts, Object.keys(expected));
  for (const [effort, [label, value]] of Object.entries(expected)) {
    const {server, selection} = fixture(t);
    await server.run({...request, effort});
    assert.deepEqual(JSON.parse(fs.readFileSync(selection, 'utf8')), {label, value, menuOpen: false});
  }
});

test('Medium is verified by its menu label even when the current Pro mode has the same raw value', async t => {
  const {server, selection} = fixture(t, '{}', '', {initial: 'Pro'});
  await server.run(request);
  assert.deepEqual(JSON.parse(fs.readFileSync(selection, 'utf8')), {label: 'Medium', value: 'medium', menuOpen: false});
});

test('unavailable, stuck and mismatched effort controls fail before sending any vocabulary prompt', async t => {
  for (const options of [{locked: true}, {stuck: true}, {wrongValue: true}]) {
    const {server, transcript} = fixture(t, '{}', '', options);
    await assert.rejects(server.run({...request, effort: 'xhigh'}), /웹챗 추론 강도/);
    assert.equal(fs.existsSync(transcript), false);
  }
});

test('unsupported Web efforts are rejected by the app client before launching the MCP worker', async t => {
  const {server, transcript} = fixture(t);
  await assert.rejects(server.run({...request, effort: 'ultra'}), /웹챗 추론 강도/);
  assert.equal(fs.existsSync(transcript), false);
});

test('Web MCP exposes only summarization and rejects unknown tools/extra arguments before browser access', async t => {
  const child = spawn(process.execPath, [worker], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, CODEX_MEMO_WEBCHAT_CONFIG: '{}'}});
  t.after(() => child.kill());
  let id = 0; const pending = new Map();
  readline.createInterface({input: child.stdout}).on('line', line => { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => reject(Error('test MCP timeout')), 4000);
    pending.set(next, reply => { clearTimeout(timer); pending.delete(next); resolve(reply); });
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: next, method, params}) + '\n');
  });
  assert.equal((await call('tools/list')).error.code, -32000);
  assert.equal((await call('initialize', {protocolVersion: '2025-06-18'})).result.serverInfo.name, 'codex_memo_webchat');
  assert.deepEqual((await call('tools/list')).result.tools.map(tool => tool.name), ['webchat_summarize']);
  assert.equal((await call('tools/call', {name: 'vocabulary_add', arguments: {}})).error.code, -32602);
  assert.equal((await call('tools/call', {name: 'webchat_summarize', arguments: {prompt: 'test', schema: {}, unexpected: true}})).error.code, -32602);
  for (const effort of ['ultra', 'low', ['medium']]) {
    assert.equal((await call('tools/call', {name: 'webchat_summarize', arguments: {prompt: 'test', schema: {}, effort}})).error.code, -32602);
  }
});

test('JSON cleaning is narrow and the browser endpoint is restricted to localhost', () => {
  assert.equal(answerObject('```json\n{"answer":"ok"}\n```'), '{"answer":"ok"}');
  assert.throws(() => answerObject('Explanation\n{"answer":"ok"}'));
  assert.throws(() => answerObject('[]'));
  const before = process.env.CODEX_MEMO_WEBCHAT_CONFIG;
  try {
    process.env.CODEX_MEMO_WEBCHAT_CONFIG = JSON.stringify({endpoint: 'https://remote.example:9233', playwrightModule: worker});
    assert.throws(configuration, /이 PC/);
  } finally { if (before === undefined) delete process.env.CODEX_MEMO_WEBCHAT_CONFIG; else process.env.CODEX_MEMO_WEBCHAT_CONFIG = before; }
});
