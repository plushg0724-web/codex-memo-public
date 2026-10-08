// @ts-check
'use strict';
// 줄 단위 JSON-RPC 전용 서버. 개인 저장소나 Codex 앱에는 연결하지 않는다.
const readline = require('node:readline');
const mica = require('./mica.cjs');

const VERSION = '1.0.0';
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const CAUTION = '빠르고 무료인 로컬 판단기. 글을 쓰지 못하고 고르기만 함. 확신 0.8 미만은 믿지 말 것. JEV 또는 both를 고르면 글이 클라우드로 전송되며 무료 여부는 해당 서비스에 따름.';
const string = {type: 'string', minLength: 1, maxLength: 100000};
const choices = {oneOf: [
  {type: 'object', minProperties: 2, maxProperties: 64, additionalProperties: string},
  {type: 'array', minItems: 2, maxItems: 64, items: string},
]};
const classifier = {type: 'string', enum: mica.MODES, description: '이 호출에서만 쓸 분류기. 생략하면 CODEX_MEMO_CLASSIFIER, 기본 mica.'};
const tools = [
  tool('mica_choose', '주어진 선택지 중 하나와 확률 표를 반환한다.', {text: string, question: string, options: choices}, ['text', 'question', 'options']),
  tool('mica_yes_no', '질문에 예/아니오와 확신을 반환한다.', {text: string, question: string}, ['text', 'question']),
  tool('mica_score', '낮음→높음 척도에서 하나를 골라 1부터 시작하는 점수와 확신을 반환한다. 작업 완료도 평가는 부정확하므로 쓰지 않는다.',
    {text: string, question: string, scale: {type: 'array', minItems: 2, maxItems: 64, items: string}}, ['text', 'question', 'scale']),
  tool('mica_batch', '같은 질문으로 여러 글을 최대 4개씩 동시에 분류하고 입력 순서대로 반환한다.',
    {items: {type: 'array', minItems: 1, maxItems: 100, items: {type: 'object', properties: {id: string, text: string}, required: ['id', 'text'], additionalProperties: false}},
      question: string, options: choices}, ['items', 'question', 'options']),
];

function tool(name, description, properties, required) {
  return {name, description: `${description} ${CAUTION}`,
    inputSchema: {type: 'object', properties: {...properties, classifier}, required, additionalProperties: false}};
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100000) throw Error(`${name}은 비어 있지 않은 100000자 이하 문자열이어야 합니다.`);
  return value;
}
/** @returns {Record<string, string>} */
function criteria(value, arrayOnly = false, start = 0) {
  if ((!object(value) && !Array.isArray(value)) || (arrayOnly && !Array.isArray(value))) throw Error('선택지는 id:설명 객체 또는 설명 배열이어야 합니다.');
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i + start), v]) : Object.entries(value);
  if (entries.length < 2 || entries.length > 64) throw Error('선택지는 2~64개여야 합니다.');
  return Object.fromEntries(entries.map(([id, description]) => [text(id, '선택지 id'), text(description, '선택지 설명')]));
}
function unavailable(selected) {
  const local = '로컬 Mica에 연결할 수 없습니다. Start-Mica.cmd로 켜고 CODEX_MEMO_MICA_URL을 확인하세요.';
  const cloud = process.env.JEV_API_KEY ? 'JEV 요청에 실패했습니다. CODEX_MEMO_JEV_URL과 서비스 상태를 확인하세요.' : 'JEV를 쓰려면 JEV_API_KEY 환경변수가 필요합니다.';
  return selected === 'mica' ? local : selected === 'jev' ? cloud : `${local} ${cloud}`;
}
function result(value, isError = false) {
  return {content: [{type: 'text', text: JSON.stringify(value)}], isError};
}
/** 실제 답한 분류기를 요청 안에서만 기억한다. both의 한쪽 실패도 정확히 표시한다. */
async function ask(state, question, selected) {
  /** @type {string[]} */
  let used = [];
  const answers = await mica.ask(state, {q: question}, {classifier: selected, onUsed: names => { used = names; }});
  if (!answers) throw Error(unavailable(selected));
  if (!object(answers.q) || !used.length) throw Error('분류기 응답에 질문의 답이 없습니다.');
  return {answer: answers.q, classifier: used.length === 2 ? 'both' : used[0],
    classifierName: used.map(n => n === 'mica' ? 'Mica' : 'JEV').join('+')};
}
async function choose(state, question, options, selected) {
  const {answer, ...via} = await ask(state, {type: 'choice', instructions: question, criteria: options}, selected);
  if (typeof answer.choice !== 'string' || !Object.hasOwn(options, answer.choice) || !object(answer.probabilities) ||
      Object.keys(answer.probabilities).length !== Object.keys(options).length ||
      !Object.keys(options).every(id => probability(answer.probabilities[id]))) throw Error('분류기 응답의 선택지 또는 확률 표가 올바르지 않습니다.');
  const confidence = answer.probabilities[answer.choice];
  return {choice: answer.choice, description: options[answer.choice], probabilities: answer.probabilities,
    confidence, reliable: confidence >= mica.CONFIDENT, ...via};
}
async function call(name, args) {
  const spec = tools.find(t => t.name === name);
  if (!spec) throw Error(`알 수 없는 도구: ${name}`);
  if (!object(args) || Object.keys(args).some(k => !Object.hasOwn(spec.inputSchema.properties, k))) throw Error('도구 인자가 올바르지 않습니다.');
  const selected = args.classifier === undefined ? mica.getMode() : args.classifier;
  if (!mica.MODES.includes(selected)) throw Error('classifier는 mica, jev, both 중 하나여야 합니다.');
  const question = text(args.question, 'question');
  const state = name === 'mica_batch' ? '' : text(args.text, 'text');
  const options = name === 'mica_yes_no' ? null : criteria(name === 'mica_score' ? args.scale : args.options, name === 'mica_score', name === 'mica_score' ? 1 : 0);
  if (name === 'mica_batch') {
    if (!Array.isArray(args.items) || !args.items.length || args.items.length > 100) throw Error('items는 1~100개 항목의 배열이어야 합니다.');
    const ids = new Set();
    for (const item of args.items) {
      if (!object(item) || Object.keys(item).some(k => k !== 'id' && k !== 'text')) throw Error('항목에는 id와 text가 필요합니다.');
      text(item.id, 'id'); text(item.text, 'text');
      if (ids.has(item.id)) throw Error('항목 id가 중복되었습니다.');
      ids.add(item.id);
    }
  }
  if (!(await mica.available(selected))) throw Error(unavailable(selected));
  if (name === 'mica_yes_no') {
    const {answer, ...via} = await ask(state, {type: 'noul', instructions: question}, selected);
    // 로컬 모델의 noul(예 확률)과 answer/confidence 형식 모두 지원한다.
    const yes = probability(answer.noul) ? answer.noul >= 0.5 : answer.answer;
    const confidence = probability(answer.noul) ? (yes ? answer.noul : 1 - answer.noul) : answer.confidence;
    if (typeof yes !== 'boolean' || !probability(confidence)) throw Error('분류기 응답의 예/아니오 또는 확신이 올바르지 않습니다.');
    return result({answer: yes, confidence, reliable: confidence >= mica.CONFIDENT, ...via});
  }
  if (name === 'mica_batch') {
    const items = [];
    let failed = false;
    for (let i = 0; i < args.items.length; i += 4) {
      items.push(...await Promise.all(args.items.slice(i, i + 4).map(async item => {
        try { return {id: item.id, ...await choose(item.text, question, options, selected)}; }
        catch (e) { failed = true; return {id: item.id, error: e.message}; }
      })));
    }
    return result({items}, failed);
  }
  const chosen = await choose(state, question, options, selected);
  return result(name === 'mica_score' ? {...chosen, score: Number(chosen.choice)} : chosen);
}

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const error = (id, code, message) => send({jsonrpc: '2.0', id, error: {code, message}});
let initialized = false, ready = false;
async function handle(line) {
  let request;
  try { request = JSON.parse(line); }
  catch { error(null, -32700, 'JSON을 해석할 수 없습니다.'); return; }
  const hasId = object(request) && Object.hasOwn(request, 'id');
  if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
      (hasId && typeof request.id !== 'string' && !(typeof request.id === 'number' && Number.isFinite(request.id))) ||
      (request.params !== undefined && !object(request.params))) {
    error(null, -32600, '올바른 JSON-RPC 2.0 요청이 아닙니다.'); return;
  }
  if (!hasId) {
    if (request.method === 'notifications/initialized' && initialized) ready = true;
    return;   // 알 수 없는 알림에도 응답하지 않는다.
  }
  const {id, method, params = {}} = request;
  let value;
  if (method === 'ping') value = {};
  else if (method === 'initialize') {
    if (initialized || typeof params.protocolVersion !== 'string' || !object(params.capabilities) ||
        !object(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
      error(id, -32602, '초기화 인자를 확인하세요. 한 연결은 한 번만 초기화합니다.'); return;
    }
    initialized = true;
    value = {protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS.at(-1),
      capabilities: {tools: {listChanged: false}}, serverInfo: {name: 'mica', version: VERSION}, instructions: CAUTION};
  } else if (method !== 'tools/list' && method !== 'tools/call') {
    error(id, -32601, '지원하지 않는 메서드입니다.'); return;
  } else if (!ready) {
    error(id, -32000, 'initialize와 notifications/initialized를 먼저 보내세요.'); return;
  } else if (method === 'tools/list') {
    if (params.cursor !== undefined) { error(id, -32602, '이 서버는 페이지 커서를 사용하지 않습니다.'); return; }
    value = {tools};
  } else {
    if (typeof params.name !== 'string') { error(id, -32602, '도구 이름이 필요합니다.'); return; }
    if (!tools.some(t => t.name === params.name)) { error(id, -32602, '알 수 없는 도구입니다.'); return; }
    try { value = await call(params.name, params.arguments ?? {}); }
    catch (e) { value = result({error: e.message}, true); }
  }
  send({jsonrpc: '2.0', id, result: value});
}

if (require.main === module) {
  const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
  input.on('line', line => {
    void handle(line).catch(() => { console.error('MCP 요청 처리 중 내부 오류가 발생했습니다.'); error(null, -32603, '내부 오류'); });
  });
}
