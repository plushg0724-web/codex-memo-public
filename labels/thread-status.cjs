// @ts-check
'use strict';
// 마지막 답변이 사용자 응답을 기다리거나 막혀서 끝난 대화를 자동 분류한다.
const CONFIDENT = 0.9;                    // 기본 기준 (단어장 창의 슬라이더로 조절)
const LIST_TTL = 30 * 1000;               // 5개 묶음끼리는 목록을 재사용하고, 2분 스캔에는 새 시각을 읽는다
const INSTRUCTIONS = 'AI 답변의 마지막 부분이 어떤 상태로 끝나는지 고르세요. 사용자에게 보낼 문구 예시·인용 안의 요청은 AI의 질문이 아닙니다.';
const CRITERIA = {
  ask: 'AI가 사용자에게 직접 질문하거나 선택·승인·정보 제공을 요청하며 끝남 (사용자가 답해야 진행됨)',
  blocked: 'AI가 권한·환경 문제로 막혀서 멈췄다고 보고하며 끝남',
  done: '작업 결과를 보고하며 끝남 (사용자가 답할 필요 없음)',
};
const FINISHED = new Set(['completed', 'interrupted', 'failed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @typedef {{state: 'ask' | 'blocked', confidence: number}} ThreadStatus */
/**
 * @param {{server: {run: <T>(work: (request: (method: string, params?: object) => Promise<any>) => Promise<T>) => Promise<T>},
 *   mica: {available: () => Promise<boolean>, choose: (state: string, instructions: string, criteria: Record<string, string>) => Promise<{choice: string, probabilities: Record<string, number>} | null>},
 *   threshold?: () => number}} deps
 */
function createThreadStatus({server, mica, threshold = () => CONFIDENT}) {
  /** @type {Map<string, number>} */
  let threads = new Map();
  let listedAt = 0;
  /** @type {Map<string, {at: number, result: {choice: string, confidence: number} | null}>} 확률 그대로 (기준은 돌려줄 때 적용) */
  const cache = new Map();
  let queue = Promise.resolve();

  async function listThreads(request) {
    if (Date.now() - listedAt < LIST_TTL && threads.size) return;
    const next = new Map();
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const r = await request('thread/list', {limit: 100, ...(cursor ? {cursor} : {})});
      for (const t of r?.data || []) {
        if (t.updatedAt != null && Number.isFinite(Number(t.updatedAt))) next.set(t.id, Number(t.updatedAt));
      }
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    threads = next;
    listedAt = Date.now();
  }

  /** undefined 는 미완료·읽기 불가·분류기 중단이므로 판단 완료로 기억하지 않는다. */
  /** @type {Map<string, {updatedAt: number, lastAgent: string, finished: boolean}>} 화면이 읽어 준 클라우드 대화 요약 */
  const digests = new Map();

  /** 마지막 답변 (이 PC 대화는 App Server, 클라우드 대화는 화면이 준 요약). 아직 진행 중이거나 모르면 undefined */
  async function lastAnswer(request, threadId) {
    let th = null;
    try { th = (await request('thread/read', {threadId, includeTurns: true}))?.thread; } catch { th = null; }
    if (!th) {
      const d = digests.get(threadId);
      return d?.finished && d.lastAgent ? d.lastAgent : undefined;
    }
    const turn = th.turns?.at(-1);
    if (!turn || !FINISHED.has(turn.status)) return undefined;
    const item = th.turns.flatMap(t => t.items || []).filter(i => i.type === 'agentMessage').at(-1);
    return String(item?.text ?? (item?.content || []).map(c => c?.text || '').join(''));
  }

  async function judge(request, threadId) {
    const last = await lastAnswer(request, threadId);
    if (!last?.trim()) return undefined;
    const r = await mica.choose(`AI 답변의 마지막 부분: ${last.slice(-300)}`, INSTRUCTIONS, CRITERIA);
    if (!r) return undefined;
    const confidence = Number(r.probabilities[r.choice]);
    return Number.isFinite(confidence) ? {choice: r.choice, confidence} : null;
  }

  /** @returns {ThreadStatus | null} */
  function pick(r) {
    if (!r || (r.choice !== 'ask' && r.choice !== 'blocked') || r.confidence < threshold() || r.confidence > 1) return null;
    return {state: r.choice, confidence: r.confidence};
  }

  return {
    /**
     * @param {string[]} threadIds 대화 uuid
     * @returns {Promise<Record<string, ThreadStatus>>}
     */
    status(threadIds, digestMap = {}) {
      for (const [id, d] of Object.entries(digestMap || {})) {
        if (d && typeof d === 'object') digests.set(id, {updatedAt: Number(d.updatedAt) || 0, lastAgent: String(d.lastAgent || ''), finished: Boolean(d.finished)});
      }
      // 여러 창이 같은 대화를 동시에 물어도 읽기·판단은 한 번씩만 한다.
      const work = queue.then(async () => {
        /** @type {Record<string, ThreadStatus>} */
        const out = {};
        const ids = [...new Set(threadIds.filter(id => UUID.test(id)))].slice(0, 20);
        if (!ids.length || !(await mica.available())) return out;
        await server.run(async request => {
          await listThreads(request);
          for (const id of ids) {
            const updatedAt = threads.get(id) ?? (digests.get(id)?.updatedAt || undefined);
            const hit = cache.get(id);
            let result;
            if (updatedAt !== undefined && hit?.at === updatedAt) result = hit.result;
            else {
              try { result = await judge(request, id); } catch { continue; }   // 다른 계정·일시적인 연결 실패
              if (updatedAt !== undefined && result !== undefined) cache.set(id, {at: updatedAt, result});
            }
            const shown = pick(result);
            if (shown) out[id] = shown;
          }
        });
        return out;
      }).catch(() => ({}));                // 분류기·App Server 를 못 쓰면 조용히 다음 스캔을 기다린다
      queue = work.then(() => {});
      return work;
    },

    /** 기억한 판단을 모두 버린다 (새로 고침) */
    clear() { cache.clear(); listedAt = 0; },
  };
}

module.exports = {createThreadStatus};
