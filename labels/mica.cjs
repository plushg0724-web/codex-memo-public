// @ts-check
'use strict';
// 빠른 판단 모델(분류기)로 "이 문맥에서 단어가 저장된 뜻 중 어느 것인지, 아니면 새 뜻인지" 같은 고르기 판단을 한다.
// 분류기는 둘 중 고르거나 둘 다 쓴다 (트레이 메뉴 → settings.json 의 classifier):
//   mica — 로컬 Mica (http://127.0.0.1:8010, 요청 하나 약 0.1~0.3초, 비용 없음, 내용이 PC 밖으로 나가지 않음)
//   jev  — 클라우드 JEV (api.typesafe.ai, 약 0.3초, 환경변수 JEV_API_KEY 필요, 판단할 글이 TypeSafe 로 전송됨)
//   both — 둘에게 동시에 묻고 확률을 평균 낸다. 한쪽이 안 되면 다른 쪽 답만 쓴다.
// 둘 다 같은 형식(/v1/systemone)이라 질문을 그대로 보낸다. 글을 쓰지는 못하므로 '이 문맥에서의 쓰임'은 GPT 몫.
// 쓸 수 있는 분류기가 없거나 확신이 낮으면 null 을 돌려주고, 부르는 쪽은 기존 방식(GPT·글자 비슷함)으로 처리한다.

const MICA_URL = process.env.CODEX_MEMO_MICA_URL || 'http://127.0.0.1:8010';
const MICA_MODEL = 'mica-v0.1-4b';
const JEV_URL = process.env.CODEX_MEMO_JEV_URL || 'https://api.typesafe.ai';
const JEV_MODEL = 'jev-latest';
const CONFIDENT = 0.8;           // 이보다 낮으면 '모름'
const HEALTH_TTL = 30000;        // 켜져 있는지 30초 동안 기억
const NEW = '__new__';
const MODES = ['mica', 'jev', 'both'];

let mode = MODES.includes(process.env.CODEX_MEMO_CLASSIFIER || '') ? String(process.env.CODEX_MEMO_CLASSIFIER) : 'mica';

/** 분류기 선택 ('mica' | 'jev' | 'both'). 백엔드가 설정을 읽어 알려 준다. */
function setMode(next) {
  if (!MODES.includes(next)) throw Error(`알 수 없는 분류기: ${next}`);
  mode = next;
}
const getMode = () => mode;
/** 화면에 보일 분류기 이름 */
const modeName = () => ({mica: 'Mica', jev: 'JEV', both: 'Mica+JEV'})[mode];

/**
 * 분류기 하나. 켜짐 확인은 동시에 들어온 요청들이 같은 결과를 기다리게 한다.
 * @param {string} name
 * @param {() => Promise<boolean>} probe
 * @param {(state: string, questions: object) => Promise<any>} post
 */
function provider(name, probe, post) {
  let healthAt = 0, healthy = false;
  /** @type {Promise<boolean> | null} */
  let checking = null;
  return {
    name,
    available() {
      if (checking) return checking;
      if (Date.now() - healthAt < HEALTH_TTL) return Promise.resolve(healthy);
      checking = (async () => {
        try { healthy = await probe(); } catch { healthy = false; }
        healthAt = Date.now();
        return healthy;
      })().finally(() => { checking = null; });
      return checking;
    },
    /** 답 묶음(answers) 또는 실패 시 null */
    async ask(state, questions) {
      if (!(await this.available())) return null;
      try {
        return await post(state, questions);
      } catch {
        healthAt = 0;   // 실패하면 다음에 다시 확인
        return null;
      }
    },
  };
}

async function postJson(url, body, headers = {}) {
  const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json; charset=utf-8', ...headers},
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000)});
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  return (/** @type {any} */ (await r.json()))?.answers || null;
}

const providers = {
  mica: provider('mica', async () => {
    const r = await fetch(`${MICA_URL}/health`, {signal: AbortSignal.timeout(1000)});
    return r.ok && (/** @type {any} */ (await r.json())).model === MICA_MODEL;
  }, (state, questions) => postJson(`${MICA_URL}/v1/systemone`, {state, questions})),
  // JEV 는 켜짐 확인 주소가 따로 없어 열쇠가 있는지만 본다. 요청이 실패하면 30초 동안 쉰다.
  jev: provider('jev', async () => Boolean(process.env.JEV_API_KEY),
    (state, questions) => postJson(`${JEV_URL}/v1/systemone`, {model: JEV_MODEL, state, questions},
      {Authorization: `Bearer ${process.env.JEV_API_KEY}`})),
};

const active = (classifier = mode) => {
  if (!MODES.includes(classifier)) throw Error(`알 수 없는 분류기: ${classifier}`);
  return classifier === 'both' ? [providers.mica, providers.jev] : [providers[classifier]];
};

/** 지금 고른 분류기 중 하나라도 쓸 수 있는지 */
async function available(classifier = mode) {
  return (await Promise.all(active(classifier).map(p => p.available()))).some(Boolean);
}

/** 두 분류기의 같은 질문 답을 합친다: 선택지 확률·예 확률을 평균 */
function merge(list) {
  if (list.length === 1) return list[0];
  /** @type {Record<string, any>} */
  const out = {};
  for (const name of Object.keys(list[0])) {
    const answers = list.map(a => a[name]).filter(Boolean);
    const first = answers[0];
    if (first?.probabilities) {
      /** @type {Record<string, number>} */
      const probabilities = Object.fromEntries(Object.keys(first.probabilities).map(id =>
        [id, answers.reduce((sum, a) => sum + (Number(a.probabilities?.[id]) || 0), 0) / answers.length]));
      const choice = Object.keys(probabilities).reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
      out[name] = {...first, probabilities, choice, answer: choice, confidence: probabilities[choice]};
    } else if (typeof first?.noul === 'number' || (typeof first?.answer === 'boolean' && typeof first?.confidence === 'number')) {
      const noul = answers.reduce((sum, a) => sum + (typeof a.noul === 'number' ? a.noul : a.answer ? a.confidence : 1 - a.confidence), 0) / answers.length;
      out[name] = {...first, noul, answer: noul >= 0.5, confidence: noul >= 0.5 ? noul : 1 - noul};
    } else {
      out[name] = first;
    }
  }
  return out;
}

/**
 * 질문 묶음을 고른 분류기(들)에 보낸다. 형식은 Mica/JEV 의 /v1/systemone 과 같다.
 * @param {string} state
 * @param {Record<string, object>} questions
 * @param {{classifier?: string, onUsed?: (names: string[]) => void}} [options] 요청별 선택과 실제 답한 분류기 알림. 전역 선택은 바꾸지 않는다.
 * @returns {Promise<Record<string, any> | null>} 질문 이름 → 답. 아무 분류기도 못 쓰면 null
 */
async function ask(state, questions, options = {}) {
  const results = (await Promise.all(active(options.classifier).map(async p => ({name: p.name, answers: await p.ask(state, questions)}))))
    .filter(r => r.answers);
  options.onUsed?.(results.map(r => r.name));
  return results.length ? merge(results.map(r => r.answers)) : null;
}

/**
 * 선택 판단 하나. 못 쓰면 null.
 * @param {string} state 판단할 자료
 * @param {string} instructions
 * @param {Record<string, string>} criteria 선택지 id → 설명
 * @returns {Promise<{choice: string, probabilities: Record<string, number>} | null>}
 */
async function choose(state, instructions, criteria) {
  if (Object.keys(criteria).length < 2) return null;
  const answer = (await ask(state, {q: {type: 'choice', instructions, criteria}}))?.q;
  return answer?.probabilities ? {choice: answer.choice, probabilities: answer.probabilities} : null;
}

/**
 * 저장된 뜻들 중 이 문맥의 뜻을 고른다.
 * @param {string} term
 * @param {string} context
 * @param {{id: string, meaning: string}[]} senses
 * @returns {Promise<{probabilities: Record<string, number>, choice: string | 'new', confidence: number} | null>}
 *   choice 는 뜻 id 또는 'new'. 분류기를 못 쓰면 null.
 */
async function rankSenses(term, context, senses) {
  if (!senses.length) return null;
  const criteria = Object.fromEntries(senses.slice(0, 8).map(s => [s.id, String(s.meaning).slice(0, 400)]));
  criteria[NEW] = '위 뜻들과 다른 새로운 뜻 (어느 것도 이 문맥에 맞지 않음)';
  const r = await choose(`단어: ${term}
문맥: ${String(context).slice(0, 1600)}`,
    `문맥에서 '${term}'이(가) 실제로 쓰인 뜻을 고르세요. 표현이 같아도 가리키는 대상·분야가 다르면 다른 뜻입니다.`, criteria);
  if (!r) return null;
  return {probabilities: r.probabilities, choice: r.choice === NEW ? 'new' : r.choice, confidence: Number(r.probabilities[r.choice]) || 0};
}

/**
 * 확신이 충분할 때만 판단을 돌려준다.
 * @returns {Promise<{choice: string | 'new', confidence: number, via: string} | null>} via 는 판단한 분류기 이름
 */
async function judgeSense(term, context, senses, min = CONFIDENT) {
  const r = await rankSenses(term, context, senses);
  if (!r || r.confidence < min) return null;
  return {choice: r.choice, confidence: r.confidence, via: modeName()};
}

module.exports = {available, ask, choose, rankSenses, judgeSense, setMode, getMode, modeName, MODES, CONFIDENT};
