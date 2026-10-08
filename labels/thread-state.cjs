// @ts-check
'use strict';
// 메모가 연결된 대화가 지금도 있는지: 'ok'(있음) · 'archived'(보관됨) · 'missing'(없음) · 'unknown'(확인 못 함).
// Codex App Server 의 thread/read 로 하나씩 확인한다(읽기만, 내용은 받지 않음). 없는 대화는
// 'thread not loaded'·'not found' 오류로 답한다. 보관한 대화도 읽히므로 보관 목록과 대조해 구분한다.
// 같은 대화는 1분 동안 기억해 두어 보관함을 열 때마다 다시 묻지 않는다.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MISSING = /not loaded|not found|no such|does not exist|unknown thread/i;

/**
 * @param {{server: {run: <T>(work: (request: (method: string, params?: object) => Promise<any>) => Promise<T>) => Promise<T>}, ttlMs?: number, now?: () => number}} options
 */
function createThreadStates({server, ttlMs = 60000, now = Date.now}) {
  /** @type {Map<string, {state: string, at: number}>} */
  const cache = new Map();
  /** @type {{ids: Set<string>, at: number} | null} */
  let archived = null;

  /** 보관한 대화 id (최대 500개, 1분 기억) @param {(method: string, params?: object) => Promise<any>} request */
  async function archivedIds(request) {
    if (archived && now() - archived.at < ttlMs) return archived.ids;
    const ids = new Set();
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const r = await request('thread/list', {limit: 100, archived: true, ...(cursor ? {cursor} : {})});
      for (const t of r?.data || []) ids.add(String(t.id).toLowerCase());
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    archived = {ids, at: now()};
    return ids;
  }

  /**
   * @param {unknown} list 대화 id 목록
   * @returns {Promise<Record<string, string>>}
   */
  async function states(list) {
    const ids = [...new Set((Array.isArray(list) ? list : []).map(v => String(v).toLowerCase()).filter(v => UUID.test(v)))].slice(0, 200);
    /** @type {Record<string, string>} */
    const result = {};
    const ask = [];
    for (const id of ids) {
      const hit = cache.get(id);
      if (hit && now() - hit.at < ttlMs) result[id] = hit.state; else ask.push(id);
    }
    if (!ask.length) return result;
    await server.run(async request => {
      let archive = null;
      for (const id of ask) {
        let state = 'unknown';
        try {
          await request('thread/read', {threadId: id, includeTurns: false});
          archive ||= await archivedIds(request).catch(() => new Set());
          state = archive.has(id) ? 'archived' : 'ok';
        } catch (error) {
          state = MISSING.test(String(/** @type {any} */ (error)?.message)) ? 'missing' : 'unknown';
        }
        if (state !== 'unknown') cache.set(id, {state, at: now()});
        result[id] = state;
      }
    }).catch(() => { for (const id of ask) result[id] ??= 'unknown'; });
    return result;
  }
  return {states, clear() { cache.clear(); archived = null; }};
}

module.exports = {createThreadStates};
