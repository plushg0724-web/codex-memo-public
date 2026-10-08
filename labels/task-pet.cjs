// @ts-check
'use strict';

// 다음에 손댈 대화를 고르는 읽기 전용 추천. 메시지 전송·라벨 변경·작업 실행은 하지 않는다.
// 근거는 대화의 마지막 턴이 끝난 모양(질문·중단·막힘), 사용자가 붙인 진행 상태 라벨, 할 일 메모이다.
// Mica 는 마지막 답변이 어떻게 끝났는지(질문·남은 확인·막힘·보고)만 판단하고, 순서는 STATES 의 고정 규칙이 정한다.

// 마지막 답변이 어떻게 끝났는지는 사이드바 답 필요 점과 같은 판단기(turn-ending.cjs)를 쓴다.
const {CRITERIA, clip, plain, prose, ending, evidence, createEndingJudge} = require('./turn-ending.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMO_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const ACTIVE = new Set(['requested', 'in_progress', 'in_review']);
const STOPPED = new Set(['completed', 'on_hold']);
const CONFIDENT = 0.8;
const RECENT = 3 * 24 * 60 * 60;   // 라벨·메모 없는 대화는 최근 3일 것만 본다 (초)
const QUIET = 30 * 60;             // 끝나지 않은 턴이 30분 넘게 그대로면 멈춘 것으로 본다 (초). 긴 명령은 몇 분씩 기록이 없다.
const FLAGGED_LIMIT = 20;          // 진행 라벨·할 일 메모가 있는 대화
const RECENT_LIMIT = 12;           // 그 밖의 최근 대화
const VERIFY = 6;                  // 판단 뒤 원본을 다시 확인할 상위 후보
const SHOW = 3;
const EMPTY = '답을 기다리거나 멈춘 대화, 진행·검토 라벨, 할 일 메모가 없어요.';
const NOTES = {
  mica: 'Mica에 연결하지 못해 Codex가 답을 기다리는지는 확인하지 못했어요.',
  turns: '대화의 마지막 상태를 읽지 못해 라벨과 메모로만 골랐어요.',
};
/** 순서(tier)가 낮을수록 먼저 보여 준다. 같은 순서에서는 최근 대화부터.
 * 라벨만 근거인 카드(badge 가 빈 값)는 사용자가 붙인 라벨 이름을 그대로 보인다. 라벨 이름은 바꿀 수 있어 뜻을 짐작하지 않는다. */
const STATES = {
  ask: {tier: 0, badge: '답을 기다려요', action: 'Codex의 질문에 답해 주세요.'},
  interrupted: {tier: 1, badge: '중간에 멈췄어요', action: '이어서 진행할지 정해 주세요.'},
  stalled: {tier: 1, badge: '진행이 멈춰 있어요', action: '승인을 기다리는지, 멈춘 작업인지 확인해 주세요.'},
  failed: {tier: 1, badge: '오류로 끝났어요', action: '오류를 확인하고 다시 요청해 주세요.'},
  blocked: {tier: 2, badge: '막혀 있어요', action: '막힌 권한·환경 문제를 풀어 주세요.'},
  memo: {tier: 3, badge: '할 일 메모', action: '메모해 둔 일을 이어서 해 주세요.'},
  check: {tier: 4, badge: '확인할 일이 남았어요', action: '남은 확인·적용을 마무리하고 상태를 정리해 주세요.'},
  review: {tier: 4, badge: '', action: '보고된 결과를 확인하고 상태를 정리해 주세요.'},
  requested: {tier: 5, badge: '', action: '대화를 열어 다음 단계를 정해 주세요.'},
  progress: {tier: 6, badge: '', action: '다음 요청을 보내거나, 끝났다면 상태를 완료로 바꿔 주세요.'},
};

/** @typedef {keyof typeof STATES} State */
/** @typedef {{status: string, completedAt: number | null, agentText: string, userText: string}} LastTurn */
/** @typedef {{id: string, threadId: string, rawId: string, title: string, statusId: string, labelName: string, memo: {note: string, quote: string} | null, updatedAt: number, flagged: boolean}} Candidate */
/** @typedef {{kind: string, turn?: LastTurn, confidence?: number}} Signal */
/** @typedef {{id: string, threadId: string, title: string, state: State, badge: string, action: string, quote: string, quoteKind: '' | 'agent' | 'request' | 'memo', labelName: string, updatedAt: number, version: string, confidence?: number}} Item */
/** advice: false 는 모델 설명 없이 바로 돌려주고, 이어지는 advice 요청이 그 순위를 재사용한다 (펫 화면이 먼저 보이게). */
/** dismissed: 넘긴 카드 {id: version}. 같은 근거(턴·메모·라벨)인 동안만 빼고, 새 답변이 오면 다시 본다. */
/** @typedef {{currentThreadId?: string, dismissedIds?: string[], dismissed?: Record<string, string>, advice?: boolean}} SuggestOptions */
/** @typedef {{status: 'ok' | 'empty' | 'source_error', checkedAt: string, totalCandidates: number, items: Item[], message?: string, notice?: string, limit?: number, advicePending?: boolean, skipped?: string[]}} SuggestResult */

// Never strip an arbitrary host prefix: remote and local UUIDs are different identities.
function localId(value) {
  if (typeof value !== 'string') return null;
  const id = value.replace(/^thread:local:(?:thread|local):/, '').replace(/^local:/, '');
  return UUID.test(id) ? id.toLowerCase() : null;
}

const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value, limit = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
const timestamp = value => typeof value === 'number' && Number.isFinite(value) ? value : 0;
/** 사용자의 마지막 요청. 위임 대화의 <input> 포장은 벗긴다 */
const request = value => clip(plain(String(value ?? '').replace(/^[\s\S]*?<input>([\s\S]*?)<\/input>[\s\S]*$/, '$1')), 120);

/** 진행 라벨이 붙었거나 할 일 메모가 연결된 로컬 대화 ID. 걸러 내기는 pool 이 다시 한다. */
function flaggedIds(memos, snapshot) {
  const ids = new Set();
  for (const [key, value] of Object.entries(snapshot.assignments)) {
    const id = /^thread:local:(?:thread|local):/.test(key) && ACTIVE.has(value) ? localId(key) : null;
    if (id) ids.add(id);
  }
  for (const memo of memos) {
    const id = record(memo) && memo.category === 'todo' ? localId(memo.conv) : null;
    if (id) ids.add(id);
  }
  return [...ids].sort().slice(0, 200);
}

/** @param {Candidate} c @param {Signal} s @returns {State | null} */
function decide(c, s) {
  if (s.kind === 'running') return null;   // Codex가 지금 작업 중이면 사용자가 할 일이 없다
  if (s.kind === 'ask' || s.kind === 'interrupted' || s.kind === 'stalled' || s.kind === 'failed' || s.kind === 'blocked') return s.kind;
  if (c.memo) return 'memo';
  if (s.kind === 'check') return 'check';
  if (c.statusId === 'in_review') return 'review';
  if (c.statusId === 'in_progress') return 'progress';
  if (c.statusId === 'requested') return 'requested';
  return null;   // 라벨·메모 없이 보고로 끝난 대화는 끝난 일로 본다
}

/** 대화가 실제로 움직인 시각: 마지막 턴이 끝난 시각. 정리·이동으로 바뀐 대화 수정 시각보다 우선한다. */
const activity = (/** @type {Candidate} */ c, /** @type {LastTurn | undefined} */ turn) =>
  record(turn) && typeof turn.completedAt === 'number' && turn.completedAt > 0 ? turn.completedAt : c.updatedAt;
/** 카드 근거의 지문. 넘긴 카드는 이 값이 같은 동안만 빠진다 (새 턴·메모 수정·라벨 변경이면 바뀜). */
function version(/** @type {{c: Candidate, s: Signal, state: State}} */ {c, s, state}) {
  const source = JSON.stringify([state, s.turn?.completedAt ?? null, s.turn ? String(s.turn.agentText || '').length : 0, c.memo?.note || '', c.statusId]);
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) { h ^= source.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/** @param {{c: Candidate, s: Signal, state: State}} entry @returns {Item} */
function item({c, s, state}) {
  let quote = '';
  /** @type {Item['quoteKind']} */
  let quoteKind = '';
  if (state === 'memo' && c.memo) { quote = clip(plain(c.memo.note) || plain(c.memo.quote), 160); quoteKind = 'memo'; }
  else if (state === 'interrupted' || state === 'stalled' || state === 'failed') { quote = request(s.turn?.userText); quoteKind = 'request'; }
  else if (s.turn?.agentText) {
    quote = evidence(state === 'ask' || state === 'check' ? state : 'done', s.turn.agentText);
    quoteKind = 'agent';
  }
  return {id: c.id, threadId: c.threadId, title: c.title, state, badge: STATES[state].badge || c.labelName || '진행 상태', action: STATES[state].action,
    quote, quoteKind: quote ? quoteKind : '', labelName: c.labelName, updatedAt: activity(c, s.turn), version: version({c, s, state}),
    ...(s.confidence !== undefined ? {confidence: s.confidence} : {})};
}

/**
 * @param {{mica: {ask: (state: string, questions: Record<string, object>, options: {classifier: string}) => Promise<any>},
 *   getThreads: (threadIds: string[], since?: number) => Promise<any[]>, getMemos: () => Promise<any[]>, getSnapshot: () => any,
 *   getLastTurns: (threadIds: string[]) => Promise<Record<string, LastTurn>>, now?: () => number}} deps
 */
function createTaskPet({mica, endings = createEndingJudge({mica}), getThreads, getMemos, getSnapshot, getLastTurns, now = Date.now, settings = () => ({threshold: CONFIDENT, count: SHOW}), advise}) {
  /** @type {Map<string, Promise<SuggestResult>>} Only concurrent calls share a result. */
  const pending = new Map();
  /** @type {Map<string, {at: number, config: string, total: number, items: Item[], prints: Map<string, string>, notes: Set<string>, hidden: string[]}>} 빠른 응답의 순위 (설명 요청이 재사용) */
  const ranks = new Map();
  const RANK_TTL = 60_000;

  /** @param {SuggestResult['status']} status @param {number} totalCandidates @param {Item[]} [items] @param {Set<string>} [notes] */
  function result(status, totalCandidates, items = [], message = '', notes = new Set()) {
    const at = now();
    const notice = [...notes].map(n => NOTES[n]).join(' ');
    return {status, checkedAt: new Date(Number.isFinite(at) ? at : Date.now()).toISOString(), totalCandidates, items,
      ...(message ? {message} : {}), ...(notice ? {notice} : {})};
  }

  function checkLocal(memos, snapshot) {
    if (!Array.isArray(memos) || !record(snapshot) || snapshot.configError ||
        !Array.isArray(snapshot.config?.labels) || !record(snapshot.assignments)) throw Error('source_error');
  }

  /**
   * 처음 읽기(wantedIds 없음): 라벨·메모로 읽을 대화를 정하고, 그 대화들과 since 이후 바뀐 대화만 읽는다.
   * 전체 대화 목록은 대화 수만큼 느려지므로(100개 약 4.5초) 읽지 않는다.
   * 다시 확인(wantedIds): 대화 → 메모 → 라벨 순으로 읽어, 대화를 읽는 사이 바뀐 완료·보류를 놓치지 않는다.
   * @param {string[] | null} wantedIds @param {number} [since]
   */
  async function readSources(wantedIds, since) {
    if (!wantedIds) {
      const memos = await getMemos();
      const snapshot = await getSnapshot();
      checkLocal(memos, snapshot);
      const threads = await getThreads(flaggedIds(memos, snapshot), since);
      if (!Array.isArray(threads)) throw Error('source_error');
      return {threads, memos, snapshot};
    }
    const threads = await getThreads(wantedIds);
    if (!Array.isArray(threads)) throw Error('source_error');
    const memos = await getMemos();
    // The actual store snapshot is synchronous. Keep it last so even a slow
    // memo disk read cannot leave an older completion state waiting in memory.
    const snapshot = await getSnapshot();
    checkLocal(memos, snapshot);
    return {threads, memos, snapshot};
  }

  /**
   * 살펴볼 대화: 진행 라벨·할 일 메모가 있는 대화와, 그 밖의 최근 대화.
   * @param {{threads: any[], memos: any[], snapshot: any}} sources @param {string | null} current @param {Set<string>} dismissed @param {number} nowSec
   * @returns {Candidate[]}
   */
  function pool({threads, memos, snapshot}, current, dismissed, nowSec) {
    const labels = new Map(snapshot.config.labels.filter(l => record(l) && typeof l.id === 'string').map(l => [l.id, l]));
    const local = new Map();
    for (const thread of threads) {
      if (!record(thread) || (thread.hostId != null && thread.hostId !== 'local') || (thread.host_id != null && thread.host_id !== 'local')) continue;
      const id = localId(thread.id);
      if (id && !local.has(id)) local.set(id, thread);
    }
    // Only exact local assignment keys are authoritative. Do not use withAliases here.
    const assignments = new Map();
    for (const [key, value] of Object.entries(snapshot.assignments)) {
      if (!/^thread:local:(?:thread|local):/.test(key)) continue;
      const id = localId(key);
      // Old and current local row formats may coexist. A stopped state always
      // wins over an active alias, regardless of file property order.
      if (id && (STOPPED.has(value) || !STOPPED.has(assignments.get(id)))) assignments.set(id, value);
    }
    /** @type {Map<string, any>} 대화별 마지막 할 일 메모 */
    const todos = new Map();
    const seen = new Set();
    for (const memo of memos) {
      if (!record(memo) || memo.category !== 'todo' || typeof memo.id !== 'string' || !MEMO_ID.test(memo.id) || seen.has(memo.id)) continue;
      seen.add(memo.id);
      const id = localId(memo.conv);
      if (id && local.has(id) && !dismissed.has(`memo:${memo.id}`) && !dismissed.has(memo.id)) todos.set(id, memo);
    }
    /** @type {Candidate[]} */
    const flagged = [];
    /** @type {Candidate[]} */
    const others = [];
    for (const [id, thread] of local) {
      const status = assignments.get(id);
      // 완료·보류는 사용자가 정한 결론이므로 대화가 질문으로 끝났어도 다시 권하지 않는다.
      if (id === current || dismissed.has(id) || dismissed.has(`thread:${id}`) || STOPPED.has(status)) continue;
      const label = labels.get(status);
      const shown = Boolean(label && label.enabled === true && (label.kind == null || label.kind === 'status'));
      const active = shown && ACTIVE.has(status);
      const memo = todos.get(id);
      /** @type {Candidate} */
      const c = {id: `thread:${id}`, threadId: id, rawId: String(thread.id), title: text(thread.name) || '제목 없는 대화',
        statusId: active ? status : '', labelName: shown ? (text(label.name) || String(status)) : '',
        memo: memo ? {note: text(memo.note, 480), quote: text(memo.quote, 320)} : null,
        updatedAt: timestamp(thread.updatedAt), flagged: active || Boolean(memo)};
      if (c.flagged) flagged.push(c);
      else if (nowSec - c.updatedAt <= RECENT) others.push(c);
    }
    const recent = (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
    return [...flagged.sort(recent).slice(0, FLAGGED_LIMIT), ...others.sort(recent).slice(0, RECENT_LIMIT)];
  }

  /**
   * 마지막 답변이 질문·남은 확인·막힘·보고 중 어디로 끝났는지. Mica를 쓸 수 없으면 undefined(기억하지 않음).
   * @param {Candidate} c @param {LastTurn} turn
   */
  async function judge(c, turn) {
    // 같은 끝부분은 다시 묻지 않는다 (사이드바와 같은 캐시). 대화 정리·이동으로 수정 시각만 바뀐 경우도 포함.
    return endings.judge(c.threadId, turn.agentText);
  }

  /** @param {Candidate} c @param {LastTurn | undefined} turn @param {number} nowSec @param {Set<string>} notes @returns {Promise<Signal>} */
  async function signal(c, turn, nowSec, notes, threshold = settings().threshold) {
    if (!record(turn)) return {kind: 'unknown'};
    if (turn.status === 'failed') return {kind: 'failed', turn};
    // 이 도우미의 App Server 에는 Codex 화면에서 실행 중인 턴도 'interrupted' 로 보인다.
    // 실제로 중단된 턴만 끝난 시각이 있고, 실행 중인 턴은 대화 수정 시각이 계속 바뀐다.
    if (turn.status === 'interrupted' && turn.completedAt != null) return {kind: 'interrupted', turn};
    if (turn.status === 'interrupted' || turn.status === 'inProgress')
      return {kind: nowSec - c.updatedAt < QUIET ? 'running' : 'stalled', turn};
    if (turn.status !== 'completed') return {kind: 'unknown', turn};
    const judged = await judge(c, turn);
    if (judged === undefined) notes.add('mica');
    if (judged && judged.confidence >= threshold && judged.choice !== 'done')
      return {kind: judged.choice, turn, confidence: judged.confidence};
    return {kind: 'done', turn};
  }

  /** @param {string | null} current @param {Set<string>} dismissed @param {string} key @param {boolean} withAdvice
   *  @param {Map<string, string>} [skipped] 넘긴 카드 id → 그때의 근거 지문 @returns {Promise<SuggestResult>} */
  async function run(current, dismissed, key, withAdvice, skipped = new Map()) {
    const config = settings();
    const nowSec = Math.floor(now() / 1000);
    const cached = ranks.get(key);
    ranks.delete(key);
    // 방금 빠른 응답으로 고른 후보가 있으면 순위를 다시 매기지 않고 설명만 붙인다. 설명 뒤 원본 재확인은 그대로 한다.
    if (withAdvice && cached && now() - cached.at < RANK_TTL && cached.config === JSON.stringify(config))
      return finish(config, current, dismissed, nowSec, cached.total, cached.items, cached.prints, cached.notes, cached.hidden);
    let list;
    try { list = pool(await readSources(null, nowSec - RECENT), current, dismissed, nowSec); }
    catch { return result('source_error', 0, [], '대화·라벨·메모 자료를 읽지 못했어요.'); }
    if (!list.length) return result('empty', 0, [], EMPTY);
    /** @type {Set<string>} */
    const notes = new Set();
    /** @type {Record<string, LastTurn>} */
    let turns = {};
    try {
      const read = await getLastTurns(list.map(c => c.rawId));
      if (!record(read)) throw Error('turns');
      turns = read;
    } catch { notes.add('turns'); }
    /** @type {{c: Candidate, s: Signal, state: State}[]} */
    const ranked = [];
    /** @type {string[]} */
    const hidden = [];
    for (const c of list) {
      const turn = Object.hasOwn(turns, c.rawId) ? turns[c.rawId] : undefined;
      // 라벨·메모 없는 대화는 실제 마지막 턴이 최근 3일 안일 때만 본다. 정리·이동으로 수정 시각만 바뀐 대화는 다시 판단하지 않는다.
      if (!c.flagged && nowSec - activity(c, turn) > RECENT) continue;
      const s = await signal(c, turn, nowSec, notes, config.threshold);
      const state = decide(c, s);
      if (!state) continue;
      // 넘긴 카드: 근거가 같으면 빼고 그 id 를 알려 준다 (화면의 '넘긴 카드 다시 보기' 개수).
      if (skipped.get(c.id) === version({c, s, state})) hidden.push(c.id); else ranked.push({c, s, state});
    }
    if (!ranked.length) return {...result('empty', 0, [], EMPTY, notes), skipped: hidden};
    const at = (/** @type {{c: Candidate, s: Signal}} */ x) => activity(x.c, x.s.turn);
    ranked.sort((a, b) => STATES[a.state].tier - STATES[b.state].tier || at(b) - at(a) || a.c.id.localeCompare(b.c.id));
    // Labels, memos, or the conversation itself can change while Mica is working. Do not return stale work.
    const head = ranked.slice(0, VERIFY);
    let fresh;
    try { fresh = pool(await readSources(head.map(x => x.c.threadId)), current, dismissed, nowSec); }
    catch { return result('source_error', ranked.length, [], '판단 후 대화·라벨·메모 자료를 다시 확인하지 못했어요.'); }
    const prints = new Map(fresh.map(c => [c.id, JSON.stringify(c)]));
    const items = head.filter(x => prints.get(x.c.id) === JSON.stringify(x.c)).slice(0, config.count).map(item);
    if (!items.length) return result('ok', ranked.length, [], '살펴보는 사이 대화나 자료가 바뀌었어요. 다시 확인해 주세요.');
    if (!withAdvice) {
      ranks.set(key, {at: now(), config: JSON.stringify(config), total: ranked.length, items, prints, notes, hidden});
      const output = result('ok', ranked.length, items, '', notes);
      output.limit = config.count;
      output.skipped = hidden;
      if (advise && config.enabled !== false) output.advicePending = true;
      return output;
    }
    return finish(config, current, dismissed, nowSec, ranked.length, items, prints, notes, hidden);
  }

  /** @param {any} config @param {string | null} current @param {Set<string>} dismissed @param {number} nowSec @param {number} total
   *  @param {Item[]} items @param {Map<string, string>} prints @param {Set<string>} notes @returns {Promise<SuggestResult>} */
  async function finish(config, current, dismissed, nowSec, total, items, prints, notes, hidden = /** @type {string[]} */ ([])) {
    let notice = '';
    if (advise) {
      try { items = await advise(items, config); }
      catch (error) {
        const unavailable = /model.*not supported|model.*not.*available|unsupported.*model/i.test(String(error?.message));
        notice = unavailable ? `${config.model}은 현재 Codex 로그인에서 지원되지 않습니다. 저장된 근거와 기본 안내를 표시합니다.`
          : '추천 모델의 설명을 받지 못해 저장된 근거와 기본 안내를 표시합니다.';
      }
      // Model inference can take a while. Revalidate every displayed source after it.
      if (JSON.stringify(settings()) !== JSON.stringify(config))
        return result('ok', total, [], '추천 중 펫 설정이 바뀌었어요. 다시 확인해 주세요.');
      let latest;
      try { latest = pool(await readSources(items.map(x => x.threadId)), current, dismissed, nowSec); }
      catch { return result('source_error', total, [], '추천 후 자료를 다시 확인하지 못했어요.'); }
      const currentPrints = new Map(latest.map(c => [c.id, JSON.stringify(c)]));
      items = items.filter(x => currentPrints.get(x.id) === prints.get(x.id));
    }
    const output = result('ok', total, items, items.length ? '' : '추천 중 자료가 바뀌었어요. 다시 확인해 주세요.', notes);
    output.limit = config.count;
    output.skipped = hidden;
    if (notice) output.notice = [output.notice, notice].filter(Boolean).join(' ');
    return output;
  }

  return {
    /** @param {SuggestOptions} [options] @returns {Promise<SuggestResult>} */
    suggest(options = {}) {
      const current = localId(options?.currentThreadId);
      const dismissed = new Set((Array.isArray(options?.dismissedIds) ? options.dismissedIds : [])
        .slice(0, 1000).filter(id => typeof id === 'string' && id.length <= 100));
      const withAdvice = options?.advice !== false;
      const skipped = new Map(Object.entries(record(options?.dismissed) ? options.dismissed : {})
        .filter(([id, v]) => id.length <= 100 && typeof v === 'string' && v.length <= 40).slice(0, 1000));
      const key = JSON.stringify([current, [...dismissed].sort(), [...skipped].sort()]);
      const running = pending.get(JSON.stringify([key, withAdvice]));
      if (running) return running;
      const slot = JSON.stringify([key, withAdvice]);
      const work = run(current, dismissed, key, withAdvice, skipped).finally(() => { if (pending.get(slot) === work) pending.delete(slot); });
      pending.set(slot, work);
      return work;
    },
  };
}

module.exports = {createTaskPet, STATES, CRITERIA};
