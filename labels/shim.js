// @ts-check
// Codex Labels 화면 코드(renderer.js, vocabulary-renderer.js)가 쓰는 window.codexLabels 를
// 디버그 포트 연결로 대신 제공한다. 요청은 __codexMemoBridge → codex_memo.py → backend.cjs 로 간다.
(() => {
  // 응답 제한 시간. cdp_bridge.py 의 PAGE_REQUEST_SECONDS 와 맞춘다.
  const LONG = new Set(["vocabularySummarize", "vocabularyReanalyze", "vocabularyFollowup", "vocabularyParagraph"]);
  const timeoutFor = (/** @type {string} */ method) => method === "taskPetSuggest" ? 180000 : LONG.has(method) ? 150000 : 30000;
  if (window.__cxlBridge) {
    // 기존 요청과 작성 중인 입력을 유지하면서 새 메서드를 연결한다.
    const existing = window.codexLabels;
    if (existing && (!existing.taskPetSuggest || !existing.vocabularyReanalyze || !existing.vocabularyFollowup || !existing.vocabularyParagraph || !(/** @type {any} */ (window)).__cxmPetLongRequest)) {
      const bridge = window.__cxlBridge;
      const resolve = bridge.resolve.bind(bridge), reset = bridge.reset.bind(bridge);
      const waiting = new Map();
      let extraSeq = 0;
      const finish = (id, ok, value) => {
        const entry = waiting.get(id);
        if (!entry) return resolve(id, ok, value);
        waiting.delete(id); clearTimeout(entry.timer);
        ok ? entry.resolve(value) : entry.reject(new Error(value || '추천을 읽지 못했습니다.'));
      };
      bridge.resolve = finish;
      bridge.reset = () => {
        for (const id of [...waiting.keys()]) finish(id, false, '도우미가 다시 연결되었습니다. 다시 시도하세요.');
        reset();
      };
      // 기존 연결의 숫자 ID 와 겹치지 않는 자기 이름공간의 ID 를 쓴다(펫 추천·단어장 재분석 공용).
      /** @type {LabelsCall} */
      const extraCall = (method, ...args) => new Promise((resolve, reject) => {
        const id = `cxl-upgrade:${Date.now()}:${++extraSeq}`;
        const timer = setTimeout(() => finish(id, false, '응답이 없습니다. 다시 시도하세요.'), timeoutFor(method));
        waiting.set(id, {resolve, reject, timer});
        try { window.__codexMemoBridge(JSON.stringify({op: 'labels', id, method, args})); }
        catch { finish(id, false, '메모 도우미에 연결할 수 없습니다.'); }
      });
      window.codexLabels = Object.freeze({...existing,
        taskPetSuggest: options => extraCall('taskPetSuggest', options || {}),
        vocabularyReanalyze: existing.vocabularyReanalyze || ((id, revision) => extraCall('vocabularyReanalyze', id, revision)),
        vocabularyFollowup: existing.vocabularyFollowup || ((id, question, revision) => extraCall('vocabularyFollowup', id, question, revision)),
        vocabularyParagraph: existing.vocabularyParagraph || ((id, paragraph, revision) => extraCall('vocabularyParagraph', id, paragraph, revision)),
      });
      (/** @type {any} */ (window)).__cxmPetLongRequest = true;
    }
    return;
  }
  let seq = 0;
  (/** @type {any} */ (window)).__cxmPetLongRequest = true;
  const pending = new Map();
  const listeners = { "changed": new Set(), "vocabulary-changed": new Set() };
  // [codex-memo 변경] 단어장 변경 신호 하나에 화면 여러 곳(단어장·본문 표시·마우스 카드)이 동시에 읽는다.
  // 진행 중인 읽기를 함께 쓰고 각자 사본을 받는다. 변경 신호나 단어장을 바꾸는 요청이 오면 새로 읽는다.
  /** @type {Promise<import('../dist/node/backend-types.cjs').VocabSnapshot> | null} */
  let vocabRead = null;

  const settle = (id, ok, value) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    ok ? p.resolve(value) : p.reject(new Error(value || "요청을 처리하지 못했습니다."));
  };

  window.__cxlBridge = {
    resolve: settle,
    // 도우미가 다시 연결되면 응답을 못 받은 요청을 실패로 정리한다(화면이 '저장 중'에 묶이지 않게)
    // 그 뒤 화면이 새 도우미에서 다시 읽게 해, 끊겨 실패한 백그라운드 읽기가 알림으로 남지 않게 한다
    reset() {
      const had = pending.size > 0;
      for (const id of [...pending.keys()]) settle(id, false, "Codex 메모 도우미가 다시 연결되었습니다. 다시 시도하세요.");
      if (had) setTimeout(() => window.__cxlBridge.emit("changed"), 0);
    },
    emit(name) {
      if (name === "vocabulary-changed") vocabRead = null;
      for (const fn of listeners[name] || []) { try { fn(); } catch (e) { console.warn("[codex-labels]", e); } }
    },
  };

  /** @type {LabelsCall} */
  const call = (method, ...args) => new Promise((resolve, reject) => {
    if (method !== "vocabularyRead" && method.startsWith("vocabulary")) vocabRead = null;
    const id = ++seq;
    const timer = setTimeout(() => settle(id, false, "응답이 없습니다. Codex 메모 도우미가 실행 중인지 확인하세요."), timeoutFor(method));
    pending.set(id, { resolve, reject, timer });
    try {
      /** @type {BridgeMessage} */
      const msg = { op: "labels", id, method, args: args.map((a) => (a === undefined ? null : a)) };
      window.__codexMemoBridge(JSON.stringify(msg));
    } catch (e) {
      settle(id, false, "Codex 메모 도우미와 연결되지 않았습니다.");
    }
  });
  const subscribe = (name) => (callback) => {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    listeners[name].add(callback);
    return () => listeners[name].delete(callback);
  };

  // 업데이트·Paseo·계정 창 기능은 Codex Labels 실행본 전용이라 정의하지 않는다(화면이 알아서 숨김).
  // ---------------------------------------------------------------- 다른 호스트(클라우드 durable 등)의 대화 읽기
  // 도우미 백엔드는 이 PC 의 App Server 만 읽을 수 있다. 클라우드 대화는 Codex 화면이 쓰는 통로
  // (electronBridge 의 mcp-request → mcp-response, hostId 로 구분)로 읽기 전용 요청만 보낸다.
  /** @type {(hostId: string, method: string, params: object, ms?: number) => Promise<any>} */
  const hostCall = (hostId, method, params, ms = 20000) => new Promise((resolve, reject) => {
    const id = `cxm-host-${++seq}-${Date.now()}`;
    const done = (fn, value) => { window.removeEventListener("message", onMessage); clearTimeout(timer); fn(value); };
    const onMessage = (/** @type {MessageEvent} */ e) => {
      const d = e.data;
      if (d?.type !== "mcp-response" || d.message?.id !== id) return;
      d.message.error ? done(reject, new Error(d.message.error.message || "요청 실패")) : done(resolve, d.message.result);
    };
    const timer = setTimeout(() => done(reject, new Error("응답 없음")), ms);
    window.addEventListener("message", onMessage);
    const bridge = /** @type {any} */ (window).electronBridge;
    if (!bridge?.sendMessageFromView) return done(reject, new Error("Codex 통로 없음"));
    bridge.sendMessageFromView({ type: "mcp-request", hostId, request: { id, method, params } }).catch((/** @type {any} */ err) => done(reject, err));
  });
  const READ_ONLY = new Set(["thread/read", "thread/turns/list"]);
  const itemText = (/** @type {any} */ it) => String(it?.text ?? (it?.content || []).map((/** @type {any} */ c) => c?.text || "").join(" ") ?? "")
    .replace(/^[\s\S]*?<input>([\s\S]*?)<\/input>[\s\S]*$/, "$1")   // 위임 대화의 <codex_delegation> 포장 벗기기
    .replace(/\s+/g, " ").trim();
  /** @type {Map<string, {at: number, digest: ThreadDigest}>} */
  const digests = new Map();
  /**
   * 대화 요약: 제목, 첫 요청, 마지막 요청, 마지막 답변, 마지막 차례가 끝났는지. 수정 시각이 같으면 다시 읽지 않는다.
   * @param {string} hostId
   * @param {string} threadId
   * @returns {Promise<ThreadDigest>}
   */
  async function threadDigest(hostId, threadId) {
    const call = (/** @type {string} */ method, /** @type {object} */ params) => {
      if (!READ_ONLY.has(method)) throw new Error("읽기 요청만 허용");
      return hostCall(hostId, method, params);
    };
    const th = (await call("thread/read", { threadId }))?.thread;
    const updatedAt = Number(th?.updatedAt) || 0;
    const key = `${hostId}:${threadId}`;
    const hit = digests.get(key);
    if (hit && hit.at === updatedAt && updatedAt) return hit.digest;
    const [first, last] = await Promise.all([
      call("thread/turns/list", { threadId, limit: 1, sortDirection: "asc", itemsView: "full" }),
      call("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "full" }),
    ]);
    const firstItems = first?.data?.[0]?.items || [], lastTurn = last?.data?.[0], lastItems = lastTurn?.items || [];
    const users = (/** @type {any[]} */ items) => items.filter((i) => i.type === "userMessage").map(itemText).filter(Boolean);
    /** @type {ThreadDigest} */
    const digest = {
      title: th?.name || "", updatedAt,
      firstUser: (users(firstItems)[0] || th?.preview || "").slice(0, 400),
      lastUser: (users(lastItems).at(-1) || "").slice(0, 300),
      lastAgent: lastItems.filter((/** @type {any} */ i) => i.type === "agentMessage").map(itemText).at(-1)?.slice(-900) || "",
      finished: ["completed", "interrupted", "failed"].includes(lastTurn?.status),
    };
    if (digests.size > 300) digests.delete(digests.keys().next().value);
    digests.set(key, { at: updatedAt, digest });
    return digest;
  }

  window.codexLabels = Object.freeze({
    read: (knownVersion) => call("read", knownVersion),
    onChanged: subscribe("changed"),
    assign: (key, id, kind) => kind === undefined ? call("assign", key, id) : call("assign", key, id, kind),
    assignMany: (keys, id, kind) => call("assignMany", keys, id, kind),
    saveConfig: (config, revision) => call("saveConfig", config, revision),
    report: (counts) => call("report", counts),
    openConfig: () => call("openConfig"),
    vocabularyRead: () => {
      const shared = vocabRead ||= call("vocabularyRead");
      shared.catch(() => {}).finally(() => { if (vocabRead === shared) vocabRead = null; });
      return shared.then((value) => structuredClone(value));
    },
    onVocabularyChanged: subscribe("vocabulary-changed"),
    vocabularySummarize: (value) => call("vocabularySummarize", value),
    vocabularyReanalyze: (id, revision) => call("vocabularyReanalyze", id, revision),
    vocabularyFollowup: (id, question, revision) => call("vocabularyFollowup", id, question, revision),
    vocabularyParagraph: (id, paragraph, revision) => call("vocabularyParagraph", id, paragraph, revision),
    vocabularyCancel: () => call("vocabularyCancel"),
    vocabularySave: (id, revision, options) => call("vocabularySave", id, revision, options),
    vocabularyEdit: (id, patch, revision) => call("vocabularyEdit", id, patch, revision),
    vocabularyDelete: (id, revision) => call("vocabularyDelete", id, revision),
    // [codex-memo 추가] 단어장 모델 선택
    vocabularyModels: () => call("vocabularyModels"),
    vocabularyModel: () => call("vocabularyModel"),
    vocabularySetModel: (model, effort) => call("vocabularySetModel", model, effort),
    vocabularySetFast: (fast) => call("vocabularySetFast", fast),
    vocabularyGuide: () => call("vocabularyGuide"),
    vocabularySetGuide: (text) => call("vocabularySetGuide", text),
    // [codex-memo 추가] Mica 로 뜻 판단·순서, GPT 로 쓰임 설명
    vocabularyJudge: (input) => call("vocabularyJudge", input),
    vocabularySenseRank: (term, context) => call("vocabularySenseRank", term, context),
    vocabularyUsage: (input, entryId) => call("vocabularyUsage", input, entryId),
    labelSuggest: (threadIds, titles) => call("labelSuggest", threadIds, titles),
    threadDigest,
    threadStatus: (threadIds, digests) => call("threadStatus", threadIds, digests),
    threadStates: (threadIds) => call("threadStates", threadIds),
    taskPetSuggest: (options) => call("taskPetSuggest", options),
    memoClassify: (memo) => call("memoClassify", memo),
    classifierGet: () => call("classifierGet"),
    memoScores: (memo) => call("memoScores", memo),
    labelScores: (threadId, title) => call("labelScores", threadId, title),
    autoSettings: () => call("autoSettings"),
    thresholdsSet: (patch) => call("thresholdsSet", patch),
    autoRefresh: () => call("autoRefresh"),
  });
})();
