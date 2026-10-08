// @ts-check
'use strict';
// Codex 대화의 모델이 Codex 메모(라벨·메모·단어장·대화 옮기기)를 직접 관리하는 MCP 서버(stdio, 줄 단위 JSON-RPC).
// 일은 실행 중인 Codex 메모 도우미가 한다: 개인 데이터 폴더의 control.json 에서 주소·열쇠를 읽어
// 127.0.0.1 제어 서버(control_server.py)로 도구 호출을 넘긴다. 이 파일은 데이터를 직접 읽거나 쓰지 않는다.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const VERSION = '1.0.0';
const PROFILE = process.env.CODEX_MEMO_MCP_PROFILE || 'full';
if (!['full', 'vocabulary'].includes(PROFILE)) throw Error('알 수 없는 MCP 프로필입니다. full 또는 vocabulary를 사용하세요.');
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const dataDir = () => process.env.CODEX_MEMO_DATA || path.join(process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support')
  : process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CodexMemo');
const INSTRUCTIONS = PROFILE === 'vocabulary' ? [
  '사용자의 로컬 CodexMemo 단어장을 다룬다. vocabulary_list로 단어와 문맥을 읽고 웹챗에서 뜻과 예문을 설명한다.',
  '답변을 먼저 보여주고 사용자가 저장하거나 수정하라고 요청한 경우에만 vocabulary_add 또는 vocabulary_update를 호출한다.',
  '원래 단어의 문맥과 뜻을 보존하며 관련 없는 항목은 바꾸지 않는다. 변경 결과의 changeId를 알려준다.',
  '이 연결에는 단어 삭제, 메모, 라벨, 대화 이동 도구가 없다. 기존 앱의 분석 버튼은 별도로 사용할 수 있다.',
].join(' ') : [
  '사용자의 Codex 메모 도우미(왼쪽 대화 목록의 진행 상태·카테고리 라벨과 목록 필터·저장한 필터, 드래그 메모, 단어장, 대화의 프로젝트·섹션 위치)를 다룬다.',
  '대화를 가리킬 때는 threads_list 가 준 threadId 를 쓴다. 라벨은 id 나 이름 모두 받는다.',
  '바꾸는 도구는 changeId 를 돌려주며 undo 로 되돌릴 수 있다. 사용자가 되돌려 달라고 하면 history 로 찾아 undo 한다.',
  '지우기(memo_delete, vocabulary_delete)는 사용자가 분명히 지우라고 했을 때만 confirm=true 로 부른다.',
  '여러 개를 바꾸기 전에는 무엇을 바꿀지 목록으로 확인하고, 바꾼 뒤에는 바꾼 개수와 내용을 짧게 알린다.',
].join(' ');

const str = (description, maxLength = 2000) => ({type: 'string', maxLength, description});
const ids = {type: 'array', minItems: 1, maxItems: 200, items: {type: 'string', minLength: 1, maxLength: 200}, description: 'threads_list 가 준 threadId 목록'};
const labelList = description => ({type: 'array', maxItems: 100, items: {type: 'string', maxLength: 100}, description: `${description}(라벨 이름·id, 라벨 없음은 "none")`});
const labelValue = description => ({type: 'string', maxLength: 100, description});
const memoCategory = {type: 'string', enum: ['todo', 'idea', 'question', 'reference', ''], description: 'todo(할 일)·idea(아이디어)·question(질문)·reference(참고), 빈 값은 미분류'};
const read = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false};
const write = {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false};
const destroy = {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false};

/** @type {{name: string, description: string, inputSchema: any, annotations: any}[]} */
const tools = [
  tool('status', 'Codex 메모 도우미와 Codex 화면 연결 상태, 버전.', {}, [], read),
  tool('labels_list', '진행 상태·카테고리 라벨 종류(id, 이름, 설명, 켜짐 여부, 쓰인 횟수).', {}, [], read),
  tool('threads_list', '대화 목록과 각 대화의 진행 상태·카테고리. 최근 수정 순. status/category 는 그 라벨만, excludeStatus/excludeCategory 는 그 라벨을 뺀다. 라벨 id·이름 또는 "none"(라벨 없음).',
    {status: str('이 진행 상태만', 100), category: str('이 카테고리만', 100),
      excludeStatus: {type: 'array', maxItems: 100, items: {type: 'string', maxLength: 100}, description: '뺄 진행 상태들(예: ["완료", "보류"])'},
      excludeCategory: {type: 'array', maxItems: 100, items: {type: 'string', maxLength: 100}, description: '뺄 카테고리들'},
      query: str('제목·작업 폴더에 들어간 글자', 200),
      limit: {type: 'integer', minimum: 1, maximum: 500, description: '기본 50'}}, [], read),
  tool('labels_assign', '여러 대화의 진행 상태·카테고리를 한꺼번에 지정. 넣지 않은 쪽은 그대로, "none" 은 라벨 지우기.',
    {threadIds: ids, status: labelValue('진행 상태 라벨 id·이름, "none" 은 지우기'), category: labelValue('카테고리 라벨 id·이름, "none" 은 지우기')}, ['threadIds'], write),
  tool('label_define', '라벨 종류를 새로 만들거나(같은 이름이 없을 때) 이름·설명·색·켜짐을 고친다. 라벨은 지울 수 없고 enabled=false 로 끈다.',
    {name: str('라벨 이름(30자 이하)', 30), kind: {type: 'string', enum: ['status', 'category'], description: '새로 만들 때 필수: status(진행 상태)·category(카테고리)'},
      id: str('고칠 라벨 id(이름을 바꿀 때)', 64), description: str('라벨 설명(자동 분류 기준으로도 쓰임)', 500),
      color: str('배경색 #RRGGBB', 7), textColor: str('글자색 #RRGGBB', 7), enabled: {type: 'boolean'}}, ['name'], write),
  tool('memos_list', '드래그 메모 목록(최근 순). 메모 내용·인용·대화 제목에서 찾기.',
    {query: str('찾을 글자', 200), category: memoCategory, threadId: str('이 대화의 메모만', 200), limit: {type: 'integer', minimum: 1, maximum: 500}}, [], read),
  tool('memo_add', '메모 추가.', {note: str('메모 내용', 5000), quote: str('인용한 원문', 5000), threadId: str('관련 대화', 200), title: str('대화 제목', 200), category: memoCategory}, ['note'], write),
  tool('memo_update', '메모 내용·분류 고치기.', {id: str('메모 id', 40), note: str('새 내용', 5000), category: memoCategory}, ['id'], write),
  tool('memo_delete', '메모 지우기. 사용자가 분명히 요청했을 때만 confirm=true.', {id: str('메모 id', 40), confirm: {type: 'boolean'}}, ['id', 'confirm'], destroy),
  tool('vocabulary_list', '단어장 목록. 단어·뜻·예문에서 찾기.',
    {query: str('찾을 글자', 200), status: {type: 'string', enum: ['new', 'review', 'known']}, limit: {type: 'integer', minimum: 1, maximum: 500}}, [], read),
  tool('vocabulary_add', '단어장에 단어 추가. 뜻·예문은 직접 써서 넣는다(같은 단어·같은 뜻은 저장 안 됨).',
    {term: str('단어(160자 이하)', 160), meaning: str('뜻', 1600), example: str('예문', 600), partOfSpeech: str('품사', 80),
      explanation: str('쓰임 설명', 800), tags: {type: 'array', maxItems: 5, items: {type: 'string', maxLength: 24}}, context: str('단어가 나온 문맥', 1600)}, ['term', 'meaning'], write),
  tool('vocabulary_update', '단어장 항목 고치기.',
    {id: str('단어 id', 40), meaning: str('뜻', 1600), example: str('예문', 600), partOfSpeech: str('품사', 80), explanation: str('쓰임 설명', 800),
      tags: {type: 'array', maxItems: 5, items: {type: 'string', maxLength: 24}}, favorite: {type: 'boolean'},
      status: {type: 'string', enum: ['new', 'review', 'known'], description: 'new(새 단어)·review(복습)·known(앎)'}}, ['id'], write),
  tool('vocabulary_delete', '단어장 항목 지우기. 사용자가 분명히 요청했을 때만 confirm=true.', {id: str('단어 id', 40), confirm: {type: 'boolean'}}, ['id', 'confirm'], destroy),
  tool('move_destinations', '대화들을 옮길 수 있는 프로젝트·섹션 목록. Codex 화면이 켜져 있고 대화가 왼쪽 목록에 보여야 한다.', {threadIds: {...ids, maxItems: 50}}, ['threadIds'], read),
  tool('threads_move', '대화들을 프로젝트나 섹션으로 옮긴다(Codex 의 "프로젝트로 이동"·"섹션으로 이동"과 같음). 이미 그곳에 있으면 건너뜀.',
    {threadIds: ids, destination: str('move_destinations 의 id, 또는 "프로젝트:이름"·"섹션:이름"·이름', 300)}, ['threadIds', 'destination'], write),
  tool('filters_list', '왼쪽 대화 목록에 지금 걸린 필터(숨긴 진행 상태·카테고리, 보이는 개수)와 저장한 필터 목록. Codex 화면이 켜져 있어야 한다.', {}, [], read),
  tool('filter_set', '왼쪽 목록 필터 바꾸기. savedFilter 로 저장한 필터를 쓰거나, hideStatus·hideCategory 로 숨길 라벨을 정한다(넣은 쪽만 바뀜, [] 은 모두 보기).',
    {savedFilter: str('쓸 저장한 필터 이름', 30), hideStatus: labelList('숨길 진행 상태들'), hideCategory: labelList('숨길 카테고리들')}, [], write),
  tool('filter_save', '필터를 이름 붙여 저장(같은 이름은 덮어씀). hideStatus·hideCategory 를 빼면 지금 걸린 필터를 저장.',
    {name: str('필터 이름(30자 이하)', 30), hideStatus: labelList('숨길 진행 상태들'), hideCategory: labelList('숨길 카테고리들')}, ['name'], write),
  tool('filter_rename', '저장한 필터 이름 바꾸기.', {name: str('지금 이름', 30), newName: str('새 이름', 30)}, ['name', 'newName'], write),
  tool('filter_delete', '저장한 필터 지우기. 사용자가 분명히 요청했을 때만 confirm=true.', {name: str('필터 이름', 30), confirm: {type: 'boolean'}}, ['name', 'confirm'], destroy),
  tool('history', '이 도구로 바꾼 최근 내역(changeId, 내용, 되돌렸는지).', {limit: {type: 'integer', minimum: 1, maximum: 100}}, [], read),
  tool('undo', '바꾼 내용을 되돌린다. changeId 를 빼면 가장 최근 변경.', {changeId: str('history 의 id', 20)}, [], write),
];
// Web chat uses the same helper and storage, with an explicitly bounded public contract.
const vocabularyTools = new Set(['status', 'vocabulary_list', 'vocabulary_add', 'vocabulary_update']);
const enabledTools = PROFILE === 'vocabulary' ? tools.filter(t => vocabularyTools.has(t.name)) : tools;

function tool(name, description, properties, required, annotations) {
  return {name, description, inputSchema: {type: 'object', properties, required, additionalProperties: false}, annotations};
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const result = (value, isError = false) => ({content: [{type: 'text', text: JSON.stringify(value)}], isError});

function control() {
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(dataDir(), 'control.json'), 'utf8')); }
  catch { throw Error('Codex 메모 도우미가 실행 중이 아닙니다. 바탕화면의 "Codex 메모"를 실행하세요.'); }
  if (!Number.isInteger(info?.port) || typeof info?.token !== 'string') throw Error('control.json 형식이 올바르지 않습니다. Codex 메모 도우미를 다시 시작하세요.');
  return info;
}

/** @param {string} name @param {object} args @returns {Promise<any>} */
function forward(name, args, timeoutMs = 180000) {
  const {port, token} = control();
  const body = Buffer.from(JSON.stringify({tool: name, args}));
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: '/call', method: 'POST', timeout: timeoutMs,
      headers: {'Content-Type': 'application/json', 'Content-Length': body.length, Authorization: `Bearer ${token}`}}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          reply.ok ? resolve(reply.result) : reject(Error(reply.error || '요청 실패'));
        } catch { reject(Error('Codex 메모 도우미의 응답을 읽지 못했습니다.')); }
      });
    });
    req.on('timeout', () => req.destroy(Error('Codex 메모 도우미가 응답하지 않습니다.')));
    req.on('error', e => reject(/** @type {any} */ (e).code === 'ECONNREFUSED' ? Error('Codex 메모 도우미가 실행 중이 아닙니다. 바탕화면의 "Codex 메모"를 실행하세요.') : e));
    req.end(body);
  });
}

async function call(name, args) {
  const spec = enabledTools.find(t => t.name === name);
  if (!spec) throw Error(`알 수 없는 도구: ${name}`);
  if (!object(args) || Object.keys(args).some(k => !Object.hasOwn(spec.inputSchema.properties, k))) throw Error('도구 인자가 올바르지 않습니다.');
  const missing = spec.inputSchema.required.filter(k => args[k] === undefined);
  if (missing.length) throw Error(`필요한 인자: ${missing.join(', ')}`);
  return result(await forward(name, args));
}

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const error = (id, code, message) => send({jsonrpc: '2.0', id, error: {code, message}});
let initialized = false;
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
  if (!hasId) return;   // 알림(notifications/initialized 등)에는 응답하지 않는다
  const {id, method, params = {}} = request;
  let value;
  if (method === 'ping') value = {};
  else if (method === 'initialize') {
    // Tunnel discovery and the subsequent ChatGPT session share a stdio child.
    // Vocabulary sessions can negotiate again without changing helper state.
    if ((initialized && PROFILE !== 'vocabulary') || typeof params.protocolVersion !== 'string') { error(id, -32602, '초기화 인자를 확인하세요. 한 연결은 한 번만 초기화합니다.'); return; }
    initialized = true;
    value = {protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS.at(-1),
      capabilities: {tools: {listChanged: false}}, serverInfo: {name: PROFILE === 'vocabulary' ? 'codex_memo_vocabulary' : 'codex_memo', version: VERSION}, instructions: INSTRUCTIONS};
  } else if (method !== 'tools/list' && method !== 'tools/call') {
    error(id, -32601, '지원하지 않는 메서드입니다.'); return;
  } else if (!initialized) {
    error(id, -32000, 'initialize 를 먼저 보내세요.'); return;
  } else if (method === 'tools/list') {
    value = {tools: enabledTools};
  } else {
    if (typeof params.name !== 'string' || !enabledTools.some(t => t.name === params.name)) { error(id, -32602, '알 수 없는 도구입니다.'); return; }
    try { value = await call(params.name, params.arguments ?? {}); }
    catch (e) { value = result({error: /** @type {any} */ (e).message}, true); }
  }
  send({jsonrpc: '2.0', id, result: value});
}

if (require.main === module) {
  const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
  input.on('line', line => {
    void handle(line).catch(() => { console.error('MCP 요청 처리 중 내부 오류'); error(null, -32603, '내부 오류'); });
  });
}
module.exports = {tools: enabledTools, handle, forward};
