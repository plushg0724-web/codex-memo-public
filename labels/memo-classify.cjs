// @ts-check
'use strict';
// 메모의 용도를 분류한다. 분류기를 못 쓰거나 확신이 기준(기본 0.6, 단어장 창의 슬라이더로 조절)보다 낮으면 미분류로 남긴다.
// 사용자가 직접 고를 때는 기준과 상관없이 분류마다 확률을 보여 준다 (memoScores).
const mica = require('./mica.cjs');
const CATEGORIES = {
  todo: '할 일: 나중에 해야 할 작업·확인할 것',
  idea: '아이디어: 시도해 볼 생각·기능 제안',
  question: '질문: 모르는 점·나중에 물어볼 것',
  reference: '참고: 기억해 둘 정보·설명',
};
const CONFIDENT = 0.6;                    // 기본 기준
// 같은 메모를 여러 창에서 요청해도 판단은 한 번만 한다. 실패는 기억하지 않는다. 확률은 그대로 기억하고 기준은 돌려줄 때 적용한다.
const TTL = 60000;
/** @type {Map<string, {at: number, result: Record<string, number>}>} 판단 자료 → 분류별 확률 */
const cache = new Map();
/** @type {Map<string, Promise<Record<string, number> | null>>} */
const pending = new Map();
let generation = 0;
function clearMemoCache() { generation++; cache.clear(); pending.clear(); }

/**
 * 분류별 확률. 분류기를 못 쓰거나 메모가 비어 있으면 null.
 * @param {{quote?: string, note?: string, title?: string}} memo
 * @returns {Promise<Record<string, number> | null>}
 */
async function memoScores(memo) {
  const quote = String(memo?.quote || '').slice(0, 600);
  const note = String(memo?.note || '').slice(0, 400);
  if (!quote.trim() && !note.trim()) return null;
  if (!(await mica.available())) return null;
  const state = `대화 제목: ${String(memo?.title || '').slice(0, 300)}\n인용: ${quote}\n내 메모: ${note}`;
  const hit = cache.get(state);
  if (hit && Date.now() - hit.at < TTL) return {...hit.result};
  const epoch = generation;
  let work = pending.get(state);
  if (!work) {
    work = (async () => {
      try {
        const r = await mica.choose(state, '내 메모의 용도를 우선하여 분류하세요. 내 메모가 비어 있으면 인용으로 판단하세요.', CATEGORIES);
        if (!r) return null;
        const result = Object.fromEntries(Object.keys(CATEGORIES).map(id => [id, Number(r.probabilities[id]) || 0]));
        if (epoch === generation) {
          if (cache.size >= 100) cache.delete(cache.keys().next().value);
          cache.set(state, {at: Date.now(), result});
        }
        return result;
      } catch { return null; }
      finally { if (epoch === generation) pending.delete(state); }
    })();
    pending.set(state, work);
  }
  const result = await work;
  return result && epoch === generation ? {...result} : null;
}

/**
 * 기준을 넘는 분류 하나. 못 정하면 null.
 * @param {{quote?: string, note?: string, title?: string}} memo
 * @param {number} [min] 기준 확신
 * @returns {Promise<{category: string, confidence: number} | null>}
 */
async function classifyMemo(memo, min = CONFIDENT) {
  const scores = await memoScores(memo);
  if (!scores) return null;
  const category = Object.keys(scores).reduce((a, b) => (scores[b] > scores[a] ? b : a));
  const confidence = scores[category];
  return confidence >= min && confidence <= 1 ? {category, confidence} : null;
}

module.exports = {classifyMemo, memoScores, clearMemoCache, CONFIDENT};
