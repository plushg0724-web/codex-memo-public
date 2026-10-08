// @ts-check
'use strict';
// 대화 라벨 자동 추천 (분류 라벨만). 대화 내용을 Codex App Server 로 읽고 Mica 가 고른다.
// - 상태 라벨(요청·진행·검토·완료·보류)은 사용자가 정하는 것이라 추천하지 않는다.
//   (실측: 상태는 붙여 둔 라벨과 7% 일치, 분류는 확신 0.8 이상일 때 5/5 일치)
// - 각 분류 라벨 설명에 이 사용자가 그 라벨을 붙인 대화 제목 예시를 넣어 개인 기준을 알려 준다.
// - 확신이 기준(기본 0.6, 단어장 창의 슬라이더로 조절) 미만이거나 '해당 없음'이면 추천하지 않는다.
// - 판단 결과는 확률 그대로 기억하고 기준은 돌려줄 때 적용한다 (기준을 바꿔도 다시 판단하지 않음).
//   대화가 바뀌지 않았으면 다시 판단하지 않는다.
// - 클라우드(durable) 대화처럼 이 PC 의 App Server 로 읽을 수 없는 대화는 화면이 알려 준 제목만으로 판단한다.

const {STATUS_LABELS,labelKind} = require('./vendor/label-kind.cjs');
const CONFIDENT = 0.6;                    // 기본 기준 (실측: 0.8 은 추천이 거의 없음)
const NONE = '__none__';
const LIST_TTL = 10 * 60 * 1000;          // 대화 목록(제목·수정 시각) 기억
const CATEGORY_INSTRUCTIONS = '대화 전체의 주된 작업 목적에 맞는 카테고리를 고르세요. 요청·진행·검토·완료·보류는 진행 상태이므로 카테고리와 별개입니다. 완료·보류되었다는 이유만으로 해당 없음으로 바꾸지 마세요. 마지막 확인·설명 요청보다 원래 주된 작업 목적을 우선하세요.';
const TITLE_INSTRUCTIONS = '제공된 대화 제목에서 확인할 수 있는 주된 작업 목적에 맞는 카테고리를 고르세요. 요청·진행·검토·완료·보류는 진행 상태이므로 카테고리와 별개입니다. 완료·보류되었다는 이유만으로 해당 없음으로 바꾸지 마세요. 제목에 없는 대화 내용은 추측하지 마세요.';
const textOf = it => String(it?.text ?? (it?.content || []).map(c => c?.text || '').join(' ') ?? '').replace(/\s+/g, ' ').trim();
const uuidOf = key => (/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(key) || [])[1];

/**
 * @param {{server: {run: <T>(work: (request: (method: string, params?: object) => Promise<any>) => Promise<T>) => Promise<T>},
 *   mica: {available: () => Promise<boolean>, choose: (state: string, instructions: string, criteria: Record<string, string>) => Promise<{choice: string, probabilities: Record<string, number>} | null>},
 *   snapshot: () => {config: {labels: any[]}, assignments: Record<string, string>, categoryAssignments?: Record<string, string>},
 *   threshold?: () => number}} deps
 */
function createLabelSuggester({server, mica, snapshot, threshold = () => CONFIDENT}) {
  /** @type {Map<string, {name: string, updatedAt: number}>} */
  let threads = new Map();
  let listedAt = 0;
  /** @type {Map<string, {at: number, criteria: string, result: {choice: string, probabilities: Record<string, number>} | null}>} 대화 id → 판단 (수정 시각·분류 기준) */
  const cache = new Map();

  async function listThreads(request) {
    if (Date.now() - listedAt < LIST_TTL && threads.size) return;
    const next = new Map();
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const r = await request('thread/list', {limit: 100, ...(cursor ? {cursor} : {})});
      for (const t of r?.data || []) next.set(t.id, {name: t.name || '', updatedAt: Number(t.updatedAt) || 0});
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    threads = next;
    listedAt = Date.now();
  }

  /** 분류 라벨마다 '설명 + 이 사용자가 붙인 대화 예' (판단 대상 자신은 빼고) */
  function criteriaFor(threadId) {
    const {config, assignments, categoryAssignments} = snapshot();
    const byLabel = new Map();
    // Old integrations may still provide a mixed assignments map. New snapshots
    // always supply categoryAssignments, including when it is empty.
    for (const [key, labelId] of Object.entries(categoryAssignments ?? assignments)) {
      const id = uuidOf(key);
      const name = id && id !== threadId && (threads.get(id)?.name || titles.get(id));
      if (!name) continue;
      if (!byLabel.has(labelId)) byLabel.set(labelId, new Set());
      byLabel.get(labelId).add(name);
    }
    /** @type {Record<string, string>} */
    const criteria = {};
    for (const l of config.labels) {
      if (!l.enabled || labelKind(l) !== 'category') continue;
      const examples = [...(byLabel.get(l.id) || [])].slice(0, 4).join(', ');
      criteria[l.id] = `${l.name}${l.description ? ': ' + l.description : ''}${examples ? ` (이 사용자가 이 라벨을 붙인 대화 예: ${examples})` : ''}`;
    }
    criteria[NONE] = '어느 분류에도 맞지 않거나 판단할 정보가 부족함';
    return criteria;
  }

  /** @type {Map<string, string>} 화면이 알려 준 대화 제목 (App Server 로 못 읽는 대화용) */
  const titles = new Map();
  /** @type {Map<string, {title: string, updatedAt: number, firstUser: string, lastUser: string, lastAgent: string}>} 화면이 읽어 준 클라우드 대화 요약 */
  const digests = new Map();
  function remember(id, v) {
    if (v && typeof v === 'object') {
      digests.set(id, {title: String(v.title || ''), updatedAt: Number(v.updatedAt) || 0, firstUser: String(v.firstUser || ''),
        lastUser: String(v.lastUser || ''), lastAgent: String(v.lastAgent || '')});
      if (v.title) titles.set(id, String(v.title));
    } else if (v) titles.set(id, String(v));
  }
  const stateOf = (name, first, lastUser, lastAgent) => `대화 제목: ${name || ''}\n첫 요청: ${(first || '').slice(0, 400)}\n`
    + `마지막 요청: ${(lastUser || '').slice(0, 300)}\n마지막 답변: ${(lastAgent || '').slice(-600)}`;

  async function judge(request, threadId, criteria) {
    let th;
    try { th = (await request('thread/read', {threadId, includeTurns: true}))?.thread; } catch { th = null; }
    if (!th) {
      const d = digests.get(threadId);
      if (d) return mica.choose(stateOf(d.title, d.firstUser, d.lastUser, d.lastAgent), CATEGORY_INSTRUCTIONS, criteria);
      const title = titles.get(threadId);
      if (!title) return undefined;   // 읽을 수 없고 제목도 모름
      return mica.choose(`대화 제목: ${title.slice(0, 300)}`, TITLE_INSTRUCTIONS, criteria);
    }
    const items = (th.turns || []).flatMap(t => t.items || []);
    const users = items.filter(i => i.type === 'userMessage').map(textOf).filter(Boolean);
    const agents = items.filter(i => i.type === 'agentMessage').map(textOf).filter(Boolean);
    const state = stateOf(th.name, users[0] || th.preview, users.at(-1), (agents.at(-1) || '').slice(0, 600));
    return mica.choose(state, CATEGORY_INSTRUCTIONS, criteria);
  }

  /** 기억한 판단을 쓰거나 새로 판단한다. 읽을 수 없으면 undefined */
  async function judged(request, id) {
    const updatedAt = threads.get(id)?.updatedAt || digests.get(id)?.updatedAt || 0;
    const criteria = criteriaFor(id);
    const fingerprint = JSON.stringify(criteria);
    const hit = cache.get(id);
    if (hit && hit.at === updatedAt && hit.criteria === fingerprint) return hit.result;
    let result;
    try { result = await judge(request, id, criteria); } catch { return undefined; }
    if (result) {
      // Only configured, enabled categories may leave this boundary, even if a
      // classifier unexpectedly returns a status or an old category ID.
      result = {choice: Object.hasOwn(criteria,result.choice) ? result.choice : NONE,
        probabilities: Object.fromEntries(Object.entries(result.probabilities).filter(([labelId]) => Object.hasOwn(criteria,labelId)))};
      cache.set(id, {at: updatedAt, criteria: fingerprint, result});
    }   // 분류기 실패(null)·읽을 수 없음(undefined)은 기억하지 않음
    return result;
  }

  /** 가장 높은 분류 라벨('해당 없음' 제외)과 확신. confident 는 '해당 없음'이 1등이 아니고 기준을 넘었는지 */
  function pick(r) {
    if (!r) return null;
    const entries = Object.entries(r.probabilities).filter(([id]) => id !== NONE);
    if (!entries.length) return null;
    const [labelId, p] = entries.reduce((a, b) => (Number(b[1]) > Number(a[1]) ? b : a));
    const confidence = Number(p) || 0;
    return {labelId, confidence, confident: r.choice !== NONE && confidence >= threshold()};
  }

  return {
    /**
     * 라벨이 없는 대화들의 추천. 판단한 대화는 모두 돌려주고, 기준을 넘은 것만 confident.
     * @param {string[]} threadIds 대화 uuid
     * @returns {Promise<Record<string, {labelId: string, confidence: number, confident: boolean}>>}
     */
    async suggest(threadIds, titleMap = {}) {
      for (const [id, v] of Object.entries(titleMap || {})) remember(id, v);
      /** @type {Record<string, {labelId: string, confidence: number, confident: boolean}>} */
      const out = {};
      // Mica 가 꺼져 있으면 아무것도 기억하지 않고 돌아간다 (나중에 켜면 다시 판단하도록)
      if (!threadIds.length || !(await mica.available())) return out;
      await server.run(async request => {
        await listThreads(request);
        for (const id of threadIds.slice(0, 20)) {
          const result = pick(await judged(request, id));
          if (result) out[id] = result;
        }
      });
      return out;
    },

    /**
     * 사용자가 직접 고를 때 보여 줄 분류 라벨별 확률 (기준과 상관없이). 분류기를 못 쓰면 null.
     * @param {string} threadId 대화 uuid
     * @returns {Promise<Record<string, number> | null>}
     */
    async scores(threadId, title = '') {
      remember(threadId, title);
      if (!threadId || !(await mica.available())) return null;
      const r = await server.run(async request => { await listThreads(request); return judged(request, threadId); });
      if (!r) return null;
      return Object.fromEntries(Object.entries(r.probabilities).filter(([id]) => id !== NONE));
    },

    /** 기억한 판단을 모두 버린다 (새로 고침) */
    clear() { cache.clear(); listedAt = 0; },
  };
}

module.exports = {createLabelSuggester, STATUS_LABELS};
