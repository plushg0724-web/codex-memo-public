// @ts-check
'use strict';

// 펫(task-pet.cjs)과 사이드바 답 필요 점(thread-status.cjs)이 함께 쓰는 판단:
// 대화의 마지막 AI 답변이 질문(ask)·남은 확인(check)·막힘(blocked)·보고(done) 중 어디로 끝났는지.
// 같은 답변에는 같은 결과가 나오도록 Mica 질문·기준·근거 확인·캐시를 한곳에 둔다.

const INSTRUCTIONS = 'AI 답변의 마지막 부분이 어떤 상태로 끝나는지 고르세요. 사용자에게 보낼 문구 예시·인용 안의 요청은 AI의 질문이 아닙니다. 원하면 더 해 주겠다는 제안만 있는 것은 질문이 아닙니다.';
// '직접 확인해야 합니다' 같은 남은 확인이 질문으로 잘못 분류되는 일이 많아서 check 를 따로 둔다.
const CRITERIA = {
  ask: 'AI가 사용자에게 질문하거나, 진행에 필요한 선택·승인·정보를 요청하며 끝남 (사용자가 답해야 AI가 이어서 진행함)',
  check: 'AI가 작업을 마쳤지만 사용자가 직접 확인·적용·실행해야 할 일이 남았다고 알리며 끝남',
  blocked: 'AI가 권한·환경 문제로 막혀서 멈췄다고 보고하며 끝남',
  done: '작업 결과를 보고하며 끝남 (사용자가 따로 할 일이 없음)',
};
// Mica 가 'ask' 라고 해도, 그 판단 근거가 된 끝부분에 실제 요청 문장이 있어야 받아들인다.
// 상태 표의 '선택 대기'·'확인 대기' 같은 보고 문구만으로 질문이 되지 않게 한다.
const ASK_CUE = /[?？]|할까요|될까요|드릴까요|볼까요|좋을까요|괜찮을까요|맞을까요|주세요|주시면|주실 수|주시겠|알려|골라|선택해|정해 주|결정해|원하시는|어느 쪽|어떤 걸|어떤 것|어떻게 할지/;
const TAIL = 300;          // Mica 에 넘기는 끝부분 (글자)
const CACHE_LIMIT = 500;

const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const clip = (value, limit) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

/** 마크다운·Codex 지시문(::page-preview 등)·기억 인용 꼬리표를 걷어 낸 한 줄 평문 */
function plain(value) {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/::[\w-]+\{[^}\n]*\}/g, ' ')
    .replace(/:[\w-]+\[([^\]\n]*)\]\{[^}\n]*\}/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
/** 문장 목록. 목록 항목·줄은 마침표가 없어도 따로 센다 */
const sentences = value => String(value ?? '').replace(/```[\s\S]*?```/g, '\n').split(/\n+/)
  .flatMap(line => plain(line).split(/(?<=[.!?。？！])\s+/)).filter(Boolean);
/** 본문만: 마크다운 표 줄과 Codex 기억 인용 꼬리표(<oai-mem-citation>)를 뺀다. 표는 상태 요약이라
 * 질문·확인 판단과 인용에 쓰지 않는다 (표만 있으면 그대로). */
function prose(value) {
  const text = String(value ?? '').replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, '');
  const rest = text.split('\n').filter(line => !/^\s*\|/.test(line)).join('\n');
  return rest.trim() ? rest : text;
}
/** 답변의 끝 문장들을 limit 글자 안에서 모은다 */
function ending(value, limit = 160, separator = ' ') {
  const list = sentences(value);
  let out = '';
  for (let i = list.length - 1; i >= 0; i--) {
    const next = out ? `${list[i]}${separator}${out}` : list[i];
    if (next.length > limit) return out || `…${list[i].slice(-(limit - 1))}`;
    out = next;
  }
  return out;
}
/** Mica 에 넘기는 마지막 부분. 판단 근거 확인과 인용도 같은 부분에서 한다. */
const tail = value => ending(prose(value), TAIL, '\n');
/** 질문으로 끝난 답변: 끝부분의 물음 문장 → 요청 문장 → 마지막 문장 */
function question(value, limit = 160) {
  const list = sentences(tail(value));
  const asked = list.filter(s => /[?？]/.test(s)).at(-1) || list.filter(s => ASK_CUE.test(s)).at(-1) || list.at(-1) || '';
  return clip(asked, limit);
}
/** 남은 확인을 알린 답변: 끝부분에서 '확인하지 못했다·해야 한다' 문장을 고른다 */
function leftover(value, limit = 160) {
  const left = sentences(prose(value)).slice(-3)
    .filter(s => /(확인|검수|적용|재시작|재부팅|실행|업로드|푸시|배포|반영)[^.!?]*(못했|않았|안 했|해야|필요|남아)/.test(s)).at(-1);
  return left ? clip(left, limit) : ending(prose(value), limit);
}
/** 판단에 맞는 근거 문장 (카드 인용·사이드바 근거 원문) */
function evidence(choice, value, limit = 160) {
  return choice === 'ask' ? question(value, limit) : choice === 'check' ? leftover(value, limit) : ending(prose(value), limit);
}

/** Mica 답이 선택지·확률 형식에 맞을 때만 받아들인다 */
function parse(answer) {
  if (!record(answer) || typeof answer.choice !== 'string' || !Object.hasOwn(CRITERIA, answer.choice) || !record(answer.probabilities)) return null;
  const p = answer.probabilities, ids = Object.keys(CRITERIA);
  const valid = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
  if (Object.keys(p).length !== ids.length || !ids.every(id => Object.hasOwn(p, id) && valid(p[id]))) return null;
  // 스스로 모순된 답(고른 것보다 확률이 높은 선택지)은 버린다.
  if (p[answer.choice] <= 0 || ids.some(id => p[id] > p[answer.choice] + 1e-9)) return null;
  return {choice: answer.choice, confidence: p[answer.choice]};
}

/** @typedef {{choice: 'ask'|'check'|'blocked'|'done', confidence: number, gated?: boolean}} Ending */

/**
 * 마지막 답변 판단기. 펫과 사이드바가 같은 인스턴스를 쓰면 같은 답변에 Mica 를 한 번만 묻는다.
 * judge() 결과: Ending, 판단할 글이 없거나 Mica 답 형식이 어긋나면 null(기억하지 않음),
 * Mica 를 쓸 수 없으면 undefined(기억하지 않음).
 * @param {{mica: {ask: (state: string, questions: Record<string, object>, options: {classifier: string}) => Promise<any>}}} deps
 */
function createEndingJudge({mica}) {
  /** @type {Map<string, {body: string, result: Ending}>} 대화별 마지막 판단. 같은 끝부분이면 다시 묻지 않는다. */
  const cache = new Map();
  /** @type {Map<string, Promise<Ending | null | undefined>>} 동시에 같은 끝부분을 묻는 요청은 하나로 합친다 */
  const pending = new Map();
  let generation = 0;

  /** @param {string} key 대화 식별자 (로컬은 UUID, 다른 호스트는 'host:UUID') @param {string} agentText 마지막 AI 답변 */
  async function judge(key, agentText) {
    const body = tail(agentText);
    if (!body) return {choice: 'done', confidence: 1};
    const hit = cache.get(key);
    if (hit && hit.body === body) return hit.result;
    const slot = JSON.stringify([key, body]);
    const running = pending.get(slot);
    if (running) return running;
    const started = generation;
    const work = (async () => {
      let answers;
      // 답변은 판단 자료일 뿐 선택지·지시가 되지 않는다. 문장 단위로 잘라 목록 줄도 그대로 넘긴다.
      try { answers = await mica.ask(`AI 답변의 마지막 부분:\n${body}`, {end: {type: 'choice', instructions: INSTRUCTIONS, criteria: CRITERIA}}, {classifier: 'mica'}); }
      catch { return undefined; }
      if (!answers) return undefined;
      const judged = parse(answers.end);
      if (!judged) return null;   // 형식이 어긋난 답은 기억하지 않고 다음에 다시 묻는다
      /** @type {Ending} */
      const result = judged.choice === 'ask' && !sentences(body).some(s => ASK_CUE.test(s))
        ? {choice: 'done', confidence: judged.confidence, gated: true}   // 질문이라는 판단에 요청 문장 근거가 없다
        : /** @type {Ending} */ (judged);
      if (started === generation) {
        cache.delete(key); cache.set(key, {body, result});
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      }
      return result;
    })().finally(() => { if (pending.get(slot) === work) pending.delete(slot); });
    pending.set(slot, work);
    return work;
  }
  return {judge, clear() { generation++; cache.clear(); pending.clear(); }};
}

module.exports = {INSTRUCTIONS, CRITERIA, ASK_CUE, TAIL, clip, plain, sentences, prose, ending, tail, question, leftover, evidence, parse, createEndingJudge};
