'use strict';
// Private stdio MCP invoked by the app's vocabulary service, using its dedicated logged-in Web tab.
const readline = require('node:readline');
const {randomUUID} = require('node:crypto');
const TOOL = 'webchat_summarize';
const OWNER = 'codexMemoWebchat';
const URL = 'https://chatgpt.com/?temporary-chat=true&codexmemo-webchat=1';
// These are Web menu choices, not raw API effort values. Web's Extra High currently reports "max".
const WEB_EFFORTS = {
  none: {labels: ['Instant', '즉시'], values: ['none']},
  medium: {labels: ['Medium', '중간', '보통'], values: ['medium']},
  high: {labels: ['High', '높음'], values: ['high']},
  xhigh: {labels: ['Extra High', '매우 높음'], values: ['max', 'xhigh']},
};
const EFFORT_ORDER = ['none', 'medium', 'high', 'xhigh'];
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const error = (id, code, message) => output({jsonrpc: '2.0', id, error: {code, message}});
let initialized = false, active = null;

function configuration() {
  const cfg = JSON.parse(process.env.CODEX_MEMO_WEBCHAT_CONFIG || '{}');
  const endpoint = new globalThis.URL(cfg.endpoint);
  if (!['127.0.0.1', 'localhost'].includes(endpoint.hostname) || endpoint.protocol !== 'http:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw Error('웹챗 브라우저 연결은 이 PC의 디버그 포트만 사용할 수 있습니다.');
  }
  if (typeof cfg.playwrightModule !== 'string' || !require('node:path').isAbsolute(cfg.playwrightModule)) throw Error('웹챗 연결 프로그램 경로를 확인하세요.');
  return cfg;
}
function answerObject(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1').trim();
  if (cleaned.length > 24000) throw Error('웹챗 요약 결과가 너무 깁니다.');
  const value = JSON.parse(cleaned);
  if (!record(value)) throw Error('웹챗 요약 결과가 JSON 객체 형식이 아닙니다.');
  return JSON.stringify(value);
}
async function ownedPage(browser) {
  for (const page of browser.contexts().flatMap(context => context.pages())) {
    if (!page.url().startsWith('https://chatgpt.com/')) continue;
    const tagged = new globalThis.URL(page.url()).searchParams.get('codexmemo-webchat') === '1'
      || await page.evaluate(key => sessionStorage.getItem(key) === '1', OWNER).catch(() => false);
    if (tagged) return page;
  }
  throw Error('웹챗 요약 전용 탭을 찾지 못했습니다. 사이드 브라우저에서 https://chatgpt.com/?temporary-chat=true&codexmemo-webchat=1 을 열어 주세요.');
}
async function applyReasoningEffort(page, effort, signal) {
  const target = WEB_EFFORTS[effort];
  if (!target) throw Error('웹챗 추론 강도를 확인하세요.');
  const trigger = page.locator('button[data-composer-navigation-target="reasoning"]:visible');
  const menu = page.locator('[role="menu"][data-state="open"]:visible');
  let opened = false;
  try {
    if (signal.aborted) throw Error('웹챗 요약을 취소했습니다.');
    await trigger.waitFor({state: 'visible', timeout: 5000});
    await trigger.click({timeout: 3000}); opened = true;
    const control = menu.locator('[data-reasoning-slider="true"]');
    const status = menu.locator('[role="status"]');
    await control.waitFor({state: 'visible', timeout: 3000});
    for (let step = 0; step < 6; step++) {
      if (signal.aborted) throw Error('웹챗 요약을 취소했습니다.');
      const announcement = (await status.innerText({timeout: 2000})).trim();
      const label = announcement.split(/[,，]/, 1)[0].trim();
      const current = EFFORT_ORDER.find(key => WEB_EFFORTS[key].labels.includes(label));
      if (current === effort) {
        const value = await trigger.getAttribute('data-selected-reasoning-effort');
        if (!target.values.includes(value)) throw Error('웹챗 추론 강도의 적용을 확인하지 못했습니다.');
        return;
      }
      // Pro is a separate execution mode. Move out of it when a standard effort was explicitly requested.
      const index = current ? EFFORT_ORDER.indexOf(current) : ['Pro', '프로'].includes(label) ? 4 : -1;
      if (index < 0) throw Error('웹챗의 현재 모델은 선택한 추론 강도 메뉴를 지원하지 않습니다.');
      await control.press(index > EFFORT_ORDER.indexOf(effort) ? 'ArrowLeft' : 'ArrowRight');
      await page.waitForFunction(({previous}) => {
        const status = document.querySelector('[role="menu"][data-state="open"] [role="status"]');
        return status && status.textContent.trim() !== previous;
      }, {previous: announcement}, {timeout: 2000});
    }
    throw Error('웹챗 추론 강도의 적용을 확인하지 못했습니다.');
  } catch (error) {
    throw Error(signal.aborted ? '웹챗 요약을 취소했습니다.' : error.message?.startsWith('웹챗') ? error.message
      : '웹챗 추론 강도를 적용하지 못했습니다. 전용 탭의 모델 메뉴를 확인하세요.');
  } finally {
    if (opened) await menu.press('Escape', {timeout: 1000}).catch(() => {});
  }
}
async function generate(args, signal) {
  const cfg = configuration();
  const {chromium} = require(cfg.playwrightModule);
  let browser, page;
  const stop = async () => {
    if (page) await page.getByRole('button', {name: /^(응답 중지|중지|Stop generating|Stop)$/}).click({timeout: 1000}).catch(() => {});
  };
  signal.addEventListener('abort', stop, {once: true});
  try {
    browser = await chromium.connectOverCDP(cfg.endpoint, {timeout: 5000});
    // A shared CDP browser also exposes other app pages. Leave their confirmation dialogs to the user.
    const preserveDialogs = p => p.on?.('dialog', () => {});
    for (const context of browser.contexts()) {
      context.on?.('page', preserveDialogs);
      for (const p of context.pages()) preserveDialogs(p);
    }
    page = await ownedPage(browser);
    if (signal.aborted) throw Error('웹챗 요약을 취소했습니다.');
    const composer = page.getByRole('textbox', {name: /^(ChatGPT에게 물어보세요|Ask ChatGPT)$/});
    if (await composer.count() && (await composer.innerText({timeout: 2000})).trim()) throw Error('웹챗 요약 전용 탭에 작성 중인 내용이 있습니다. 먼저 확인해 주세요.');
    if (await page.getByRole('button', {name: /^(응답 중지|중지|Stop generating|Stop)$/}).count()) throw Error('웹챗 요약 전용 탭에서 다른 답변을 생성하고 있습니다. 잠시 기다려 주세요.');
    await page.goto(URL, {waitUntil: 'domcontentloaded', timeout: 15000});
    await page.evaluate(key => sessionStorage.setItem(key, '1'), OWNER);
    await composer.waitFor({state: 'visible', timeout: 10000}).catch(() => { throw Error('웹챗 로그인 상태를 확인하세요. 요약 전용 탭에서 ChatGPT에 로그인해야 합니다.'); });
    await applyReasoningEffort(page, args.effort || 'medium', signal);
    const requestId = randomUUID();
    const prompt = args.prompt + '\n\n이 요청은 코덱스 메모 단어장 초안 분석입니다. MCP 도구, 검색, 저장 작업을 실행하지 마세요. '
      + '아래 스키마에 맞는 JSON 객체 하나만 답하세요. 마크다운 코드 블록이나 안내 문구는 넣지 마세요.\n'
      + JSON.stringify(args.schema) + '\n요청 식별자: ' + requestId;
    if (signal.aborted) throw Error('웹챗 요약을 취소했습니다.');
    await composer.fill(prompt, {timeout: 5000});
    await page.getByRole('button', {name: /^(보내기|Send prompt|Send)$/}).click({timeout: 5000});
    const deadline = Date.now() + 110000;
    let stable = '', stableAt = 0;
    while (Date.now() < deadline) {
      if (signal.aborted) throw Error('웹챗 요약을 취소했습니다.');
      const assistants = page.locator('[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"] .markdown');
      const messages = await assistants.count();
      const text = messages ? await assistants.last().innerText({timeout: 3000}) : '';
      const turns = page.locator('[data-talvt-turn-state]');
      const generating = await turns.count() ? await turns.last().getAttribute('data-talvt-turn-state') !== 'complete'
        : await page.getByRole('button', {name: /^(응답 중지|중지|Stop generating|Stop)$/}).count();
      if (text && text === stable && !generating && Date.now() - stableAt >= 1500) {
        let answer;
        try { answer = answerObject(text); } catch { throw Error('웹챗 요약 결과가 JSON 형식이 아닙니다. 다시 분석해 주세요.'); }
        await page.evaluate(() => {
          const url = new globalThis.URL(location.href); url.searchParams.set('codexmemo-webchat', '1');
          history.replaceState(history.state, '', url.href);
        });
        return answer;
      }
      if (text !== stable || generating) { stable = text; stableAt = Date.now(); }
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    throw Error('웹챗 요약 시간이 초과되었습니다. 다시 시도하세요.');
  } catch (err) {
    throw Error(signal.aborted ? '웹챗 요약을 취소했습니다.' : err.message?.startsWith('웹챗') ? err.message : '웹챗 요약 연결에 실패했습니다. 사이드 브라우저 상태를 확인하세요.');
  } finally {
    signal.removeEventListener('abort', stop);
    // close() on a CDP-connected Playwright browser disconnects this client; the app/tab stay open.
    await browser?.close().catch(() => {});
  }
}

async function handle(msg) {
  if (!record(msg) || msg.jsonrpc !== '2.0') return;
  if (msg.method === 'notifications/cancelled') { if (active?.id === msg.params?.requestId) active.controller.abort(); return; }
  if (msg.id === undefined) return;
  const reply = result => output({jsonrpc: '2.0', id: msg.id, result});
  if (msg.method === 'initialize') {
    initialized = true;
    return reply({protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'codex_memo_webchat', version: '1'}, instructions: 'Generate vocabulary JSON with the logged-in ChatGPT Web. No production-data tools and no API fallback.'});
  }
  if (!initialized) return error(msg.id, -32000, 'Initialize the MCP session first.');
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'tools/list') return reply({tools: [{name: TOOL, description: 'Summarize the app vocabulary prompt in ChatGPT Web and return a JSON draft. The caller reviews and saves it separately.', inputSchema: {
    type: 'object', properties: {prompt: {type: 'string', minLength: 1, maxLength: 18000}, schema: {type: 'object'}, effort: {type: 'string', enum: EFFORT_ORDER, default: 'medium'}}, required: ['prompt', 'schema'], additionalProperties: false},
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false}}]});
  if (msg.method !== 'tools/call') return error(msg.id, -32601, 'Unknown method.');
  const args = msg.params?.arguments;
  if (msg.params?.name !== TOOL || !record(args) || Object.keys(args).some(key => !['prompt', 'schema', 'effort'].includes(key))
    || (args.effort !== undefined && (typeof args.effort !== 'string' || !Object.hasOwn(WEB_EFFORTS, args.effort)))
    || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 18000 || !record(args.schema) || JSON.stringify(args.schema).length > 16000) return error(msg.id, -32602, 'Invalid summarization request.');
  if (active) return reply({isError: true, content: [{type: 'text', text: '웹챗에서 이미 다른 단어를 분석하고 있습니다.'}]});
  const current = {id: msg.id, controller: new AbortController()}; active = current;
  try { return reply({content: [{type: 'text', text: await generate(args, current.controller.signal)}]}); }
  catch (err) { return reply({isError: true, content: [{type: 'text', text: err.message}]}); }
  finally { if (active === current) active = null; }
}

if (require.main === module) {
  const input = readline.createInterface({input: process.stdin});
  input.on('line', line => {
    if (line.length > 65536) return error(null, -32600, 'Request too large.');
    let msg; try { msg = JSON.parse(line); } catch { return error(null, -32700, 'Invalid JSON.'); }
    void handle(msg).catch(() => error(msg?.id ?? null, -32603, 'MCP request failed.'));
  });
  input.on('close', () => { active?.controller.abort(); if (!active) process.exit(0); });
}
module.exports = {answerObject, configuration, generate, handle, applyReasoningEffort};
