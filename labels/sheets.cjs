// @ts-check
'use strict';
// 단어·메모를 Google 시트에 행으로 쌓는다 (DB 처럼 열·행을 더 붙여 쓸 수 있게).
// - 시트는 사람마다 자기 Google Drive 에 처음 연결할 때 만들고, 정보는 settings.json 에만 둔다.
// - 행을 넣을 때 열 위치가 아니라 머리글 이름으로 칸을 찾는다 → 사용자가 열을 추가·이동해도 안전.
// - 보내지 못한 행은 sheets-pending.json 에 남겨 두었다가 다음에 다시 보낸다.
const fs = require('node:fs');
const path = require('node:path');
const {createToolPool} = require('./appserver.cjs');

const TITLE = 'Codex 단어장·메모';
const TAB = '단어·메모';
/** @type {[string, string][]} [행 항목, 머리글] */
const COLUMNS = [
  ['date', '날짜'], ['kind', '종류'], ['main', '단어·인용'], ['text', '뜻·메모'], ['pos', '품사'], ['example', '예문'],
  ['tags', '태그'], ['status', '학습 상태'], ['context', '원문 문맥'], ['conv', '대화'], ['model', '모델'], ['id', 'ID'],
  ['category', '분류'], ['definitions', '사전적 의미'],
];
const STATUS = {new: '미학습', review: '복습 필요', known: '숙지함'};
const CATEGORY = {todo: '할 일', idea: '아이디어', question: '질문', reference: '참고'};
const PENDING_PATH = path.join(process.env.CODEX_MEMO_DATA || __dirname, 'sheets-pending.json');

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
const stamp = (/** @type {number} */ ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 단어장 항목 → 행 */
function vocabRow(e) {
  return {date: stamp(e.savedAt), kind: '단어', main: e.term, text: e.meaning, pos: e.partOfSpeech || '',
    example: e.example || '', tags: (e.tags || []).join(', '), status: STATUS[e.status || 'new'] || '',
    context: e.context || '', conv: e.source?.title || '', model: `${e.model} · ${e.effort}`, id: e.id,
    definitions: (e.definitions || []).map((d, i) => `${'①②③④'[i] || i + 1} ${d}`).join('\n')};
}

/** 메모 → 행 (원문 문맥은 앞뒤 문맥 사이에 【메모한 글】) */
function memoRow(m) {
  return {date: m.created, kind: '메모', main: m.quote || '', text: m.note || '',
    context: m.exact ? `${m.prefix || ''}【${m.exact}】${m.suffix || ''}` : '', conv: m.title || m.window || '', id: m.id,
    category: CATEGORY[m.category] || '미분류'};
}

/**
 * @param {{exe: () => string | null, settings: () => any, saveSettings: (patch: object) => void}} deps
 */
function createSheetSync({exe, settings, saveSettings}) {
  /** @type {Record<string, string>[]} */
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')); } catch { /* 없음 */ }
  let timer = null, flushing = null, lastError = '';
  const tools = createToolPool(exe);   // 연달아 보낼 때 연결 재사용 (2분 쉬면 닫음)
  // 머리글 위치는 10분 동안 기억한다 (행을 보낼 때마다 시트 정보·머리글을 다시 읽지 않게).
  // 쓰기가 실패하면 버리고 다음에 새로 읽는다 → 그 사이 사용자가 열을 바꿔도 곧 반영된다.
  const LAYOUT_TTL = 10 * 60 * 1000;
  /** @type {{key: string, at: number, sheetId: number, header: string[]} | null} */
  let layout = null;

  const keep = () => {
    try { queue.length ? fs.writeFileSync(PENDING_PATH, JSON.stringify(queue)) : fs.rmSync(PENDING_PATH, {force: true}); } catch { /* 다음에 */ }
  };
  const cell = (/** @type {unknown} */ v) => ({userEnteredValue: {stringValue: String(v ?? '')}});

  /** 행들을 머리글 위치에 맞춰 appendCells 요청으로 만든다 */
  function appendRequest(sheetId, header, rows) {
    const index = Object.fromEntries(COLUMNS.map(([key, title]) => [key, header.indexOf(title)]));
    const width = Math.max(...Object.values(index)) + 1;
    return {appendCells: {sheetId, fields: 'userEnteredValue', rows: rows.map(row => {
      const values = Array.from({length: width}, () => ({}));
      for (const [key] of COLUMNS) if (index[key] >= 0) values[index[key]] = cell(row[key]);
      return {values};
    })}};
  }

  /** 시트 탭 위치와 머리글 읽기 (사용자가 탭 이름을 바꿔도 sheetId 로 찾는다) */
  async function readLayout(call, sheets) {
    const meta = await call('google_drive.get_spreadsheet_metadata', {spreadsheet_id: sheets.spreadsheetId});
    const tab = (meta.sheets || []).map(s => s.properties).find(p => p.sheetId === sheets.sheetId) || meta.sheets?.[0]?.properties;
    if (!tab) throw Error('시트 탭을 찾지 못했습니다.');
    const range = await call('google_drive.get_spreadsheet_range', {spreadsheet_id: sheets.spreadsheetId, sheet_name: tab.title, range: 'A1:ZZ1'});
    const first = (range.values || range.rows || [[]])[0] || [];
    const header = first.map(v => String(typeof v === 'object' && v ? v.value ?? v.formattedValue ?? '' : v ?? '').trim());
    // 머리글이 비었으면 기본 순서로 본다
    return {sheetId: tab.sheetId, header: header.some(Boolean) ? header : COLUMNS.map(([, t]) => t)};
  }

  /** Space 에 시트 링크 페이지를 만든다. 실패해도 시트는 그대로 쓴다. */
  async function createSpacePage(call, url) {
    try {
      const spaces = await call('chatgpt_space.list_spaces', {});
      const space = (spaces.items || []).find(s => s.can_edit) || spaces.items?.[0];
      if (!space) throw Error('쓸 수 있는 Space 가 없습니다.');
      const page = await call('chatgpt_space.create_page', {title: TITLE, space_id: space.id, initial_blocks: [
        'Codex 에서 저장한 단어와 메모가 쌓이는 표입니다.',
        `[${TITLE} (Google 시트) 열기](${url})`,
        '단어나 메모를 저장할 때마다 행이 자동으로 추가됩니다. 열을 더 붙이거나 순서를 바꿔도 됩니다(머리글 이름으로 칸을 찾습니다).',
      ]});
      const id = page?.page_id || page?.metadata?.page_id || page?.id;
      return {spacePageUrl: page?.url || page?.metadata?.url || (id ? `https://chatgpt.com/space/${id}` : null), spaceError: ''};
    } catch (e) {
      return {spacePageUrl: null, spaceError: e?.message || String(e)};
    }
  }

  async function flush() {
    timer = null;
    const sheets = settings().sheets;
    if (!sheets?.ready || !queue.length) return;
    const batch = queue.slice();
    try {
      await tools.run(async call => {
        const key = `${sheets.spreadsheetId}:${sheets.sheetId}`;
        if (!layout || layout.key !== key || Date.now() - layout.at > LAYOUT_TTL) {
          layout = {key, at: Date.now(), ...(await readLayout(call, sheets))};
        }
        try {
          await call('google_drive.batch_update_spreadsheet', {spreadsheet_id: sheets.spreadsheetId,
            requests: [appendRequest(layout.sheetId, layout.header, batch)]});
        } catch (e) {
          layout = null;
          throw e;
        }
      });
      queue = queue.slice(batch.length);
      lastError = '';
    } catch (e) {
      lastError = e?.message || String(e);
      timer = setTimeout(schedule, 60000);   // 1분 뒤 다시
    } finally {
      keep();
    }
  }

  function schedule() {
    if (flushing) { flushing.then(schedule); return; }
    flushing = flush().finally(() => { flushing = null; });
  }

  return {
    /** 행 하나를 보낼 목록에 넣는다 (1.5초 모아서 한 번에 보냄) */
    enqueue(row) {
      if (!settings().sheets?.ready) return;
      queue.push(row);
      keep();
      clearTimeout(timer);
      timer = setTimeout(schedule, 1500);
    },

    /** 백엔드가 끝날 때 살려 둔 연결을 닫는다 */
    dispose() { clearTimeout(timer); tools.close(); },

    status() {
      const s = settings().sheets;
      return {connected: !!s?.ready, url: s?.url || null, spacePageUrl: s?.spacePageUrl || null, pending: queue.length, error: lastError};
    },

    /**
     * 시트를 만들고(또는 settings 에 적힌 기존 시트를 준비하고) 지금까지의 단어·메모를 채운다. Space 에 링크 페이지도 만든다.
     * @param {Record<string, string>[]} rows 처음 채울 행
     */
    async connect(rows) {
      const ex = exe();
      if (!ex) throw Error('Codex 실행 파일을 찾지 못했습니다.');
      const current = settings().sheets || {};
      if (current.ready) {
        if (current.spacePageUrl) return this.status();
        // 시트는 있고 Space 페이지만 없으면 페이지만 다시 만든다
        const {spacePageUrl, spaceError} = await tools.run(call => createSpacePage(call, current.url));
        if (spacePageUrl) saveSettings({sheets: {...current, spacePageUrl}});
        return {...this.status(), spaceError};
      }
      const result = await tools.run(async call => {
        let {spreadsheetId, url} = current;
        if (!spreadsheetId) {
          const f = await call('google_drive.create_file', {title: TITLE, mime_type: 'application/vnd.google-apps.spreadsheet'});
          spreadsheetId = f.fileId;
          url = f.url;
        }
        const meta = await call('google_drive.get_spreadsheet_metadata', {spreadsheet_id: spreadsheetId});
        const sheetId = meta.sheets[0].properties.sheetId;
        url = url || meta.spreadsheetUrl;
        const header = COLUMNS.map(([, t]) => t);
        /** @type {object[]} 시트 이름·머리글 고정·머리글 쓰기·기존 행 채우기 */
        const requests = [
          {updateSheetProperties: {properties: {sheetId, title: TAB, gridProperties: {frozenRowCount: 1}}, fields: 'title,gridProperties.frozenRowCount'}},
          {updateCells: {start: {sheetId, rowIndex: 0, columnIndex: 0}, fields: 'userEnteredValue,userEnteredFormat.textFormat.bold',
            rows: [{values: header.map(t => ({userEnteredValue: {stringValue: t}, userEnteredFormat: {textFormat: {bold: true}}}))}]}},
        ];
        if (rows.length) requests.push(appendRequest(sheetId, header, rows));
        await call('google_drive.batch_update_spreadsheet', {spreadsheet_id: spreadsheetId, requests});
        // 시트 정보는 바로 저장 (Space 페이지 실패와 상관없이 시트는 쓸 수 있게)
        saveSettings({sheets: {spreadsheetId, url, sheetId, ready: true}});

        const {spacePageUrl, spaceError} = await createSpacePage(call, url);
        return {spreadsheetId, url, sheetId, spacePageUrl, spaceError};
      });
      saveSettings({sheets: {spreadsheetId: result.spreadsheetId, url: result.url, sheetId: result.sheetId, ready: true, spacePageUrl: result.spacePageUrl}});
      return {...this.status(), spaceError: result.spaceError};
    },
  };
}

module.exports = {createSheetSync, vocabRow, memoRow, COLUMNS};
