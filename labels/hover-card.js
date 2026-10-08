// @ts-check
// 저장된 단어(점선 밑줄)나 메모한 글(노란 형광펜)에 마우스를 올리면, 그 단어의 저장된 뜻과
// 그 자리에 남긴 메모를 작은 카드로 보여준다. 선택한 문단을 먼저 보여주며 긴 카드는 스크롤할 수 있다.
(() => {
  const VERSION = 10;
  if (window.__cxmHover?.version === VERSION) return;
  try { window.__cxmHover?.destroy(); } catch { /* 예전 버전 */ }

  const api = window.codexLabels;
  const VOCAB_HL = "codex-vocabulary-saved";   // vendor/vocabulary-renderer.js 의 저장 단어 하이라이트
  const SHOW_DELAY = 250;
  // 클릭하면 뜨는 자세히 보기 카드(vendor/vocabulary-renderer.js). 열려 있는 동안에는 겹치지 않게 이 카드를 띄우지 않는다.
  const detailOpen = () => !!document.getElementById("cdx-vocabulary-inline");
  const key = (v) => (v || "").normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
  const cleanups = [];
  let disposed = false, vocabEpoch = 0;

  // 문맥 비슷함: 글자 두 개씩 묶은 조각이 얼마나 겹치는지 (0~1). AI 없이 가장 가까운 뜻을 고르는 데 쓴다.
  const bigrams = (t) => {
    const s = key(t).replace(/\s/g, ""), set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const similarity = (a, b) => {
    const A = bigrams(a), B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let n = 0;
    for (const g of A) if (B.has(g)) n++;
    return (2 * n) / (A.size + B.size);
  };

  // ---------------------------------------------------------------- 단어장 데이터 (바뀔 때만 다시 읽기)
  /** @type {VocabSnapshot | null} */
  let vocab = null;
  let vocabStale = true, vocabLoading = null, vocabAt = 0;
  const VOCAB_TTL = 30000;   // 변경 신호를 놓쳐도 30초가 지나면 다시 읽는다
  const loadVocab = () => {
    if (disposed || !api?.vocabularyRead || (!vocabStale && vocab && Date.now() - vocabAt < VOCAB_TTL)) return Promise.resolve(vocab);
    // A change during a read invalidates that response. Coalesce callers while
    // reading again so a delayed snapshot cannot make stale data fresh for 30s.
    return vocabLoading ||= (async () => {
      while (!disposed) {
        const epoch = vocabEpoch;
        const next = await api.vocabularyRead();
        if (disposed) return vocab;
        if (epoch !== vocabEpoch) continue;
        vocab = next; vocabStale = false; vocabAt = Date.now();
        return vocab;
      }
      return vocab;
    })()
      .catch(() => vocab)
      .finally(() => { vocabLoading = null; });
  };
  const offVocab = api?.onVocabularyChanged?.(() => { vocabEpoch++; vocabStale = true; });
  if (offVocab) cleanups.push(offVocab);
  loadVocab();

  // ---------------------------------------------------------------- 카드
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .cxm-hover { position: fixed; z-index: 2147483646; pointer-events: none; max-width: 340px; min-width: 200px;
      box-sizing: border-box; padding: 10px 12px; border-radius: 10px; font: 12px/1.55 'Segoe UI', 'Malgun Gothic', sans-serif;
      background: #ffffff; color: #202123; border: 1px solid #d9dce0; box-shadow: 0 10px 30px #0003;
      max-height: min(70vh, 520px); overflow-y: auto; overscroll-behavior: contain;
      opacity: 0; transform: translateY(-2px); transition: opacity .12s, transform .12s; }
    .cxm-hover.cxm-on { opacity: 1; transform: none; pointer-events: auto; }
    .dark .cxm-hover { background: #26272b; color: #eceef1; border-color: #41434a; box-shadow: 0 12px 34px #0008; }
    .cxm-hover .cxm-h-sec + .cxm-h-sec { margin-top: 8px; padding-top: 8px; border-top: 1px solid #8884; }
    .cxm-hover .cxm-h-tag { display: inline-block; font-size: 10px; font-weight: 600; padding: 0 6px; border-radius: 999px; margin-right: 6px;
      background: #548de833; color: #3c6fd0; }
    .cxm-hover .cxm-h-tag.memo { background: #ffd43b40; color: #a17800; }
    .dark .cxm-hover .cxm-h-tag { color: #8db4ff; }
    .dark .cxm-hover .cxm-h-tag.memo { color: #ffd43b; }
    .cxm-hover .cxm-h-term { font-weight: 600; font-size: 13px; }
    .cxm-hover .cxm-h-meta { opacity: .65; font-size: 11px; margin-left: 4px; }
    .cxm-hover .cxm-h-text { margin-top: 3px; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
      overflow-wrap: anywhere; white-space: pre-wrap; }
    .cxm-hover .cxm-h-ex { margin-top: 3px; opacity: .65; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .cxm-hover .cxm-h-item + .cxm-h-item { margin-top: 6px; }
    .cxm-hover .cxm-h-pinned { border-left: 3px solid #548de8; padding-left: 8px; margin-top: 6px; }
    .cxm-hover .cxm-h-pinned .cxm-h-text { display: block; -webkit-line-clamp: unset; }
    .cxm-hover .cxm-h-close { float: right; margin: -3px -4px 2px 6px; padding: 2px 5px; border: 0; background: none; color: inherit; cursor: pointer; font: 16px/1 sans-serif; }
    .cxm-hover .cxm-h-hint { margin-top: 8px; opacity: .5; font-size: 10.5px; }
    .cxm-hover .cxm-h-learning { margin-top: 5px; font-size: 11px; }
    .cxm-hover .cxm-h-learning select { margin-left: 6px; border: 1px solid #8886; border-radius: 999px; padding: 2px 6px; background: inherit; color: inherit; font: inherit; cursor: pointer; }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  cleanups.push(() => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet); });

  const card = document.createElement("div");
  card.className = "cxm-hover";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "단어장·메모 미리보기");
  cleanups.push(() => card.remove());

  /**
   * @param {string} tag
   * @param {string} [cls]
   * @param {string} [text]
   */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  /** @param {VocabEntry[]} words 지금 문맥에 가까운 순서 @param {Memo[]} memos */
  function render(words, memos) {
    card.replaceChildren();
    const close = el("button", "cxm-h-close", "×");
    close.setAttribute("type", "button"); close.setAttribute("aria-label", "미리보기 닫기");
    close.addEventListener("click", hide); card.append(close);
    const chosen = words.slice(0, 3).flatMap(word => (window.CodexVocabContent?.selectedParagraphs(word) || []).map(paragraph => ({word, paragraph})));
    if (chosen.length) {
      const selected = el("div", "cxm-h-sec");
      selected.append(el("span", "cxm-h-tag", "미리보기 선택 문단"), el("span", "cxm-h-term", words[0].term));
      for (const {word, paragraph} of chosen) {
        const block = el("div", "cxm-h-pinned");
        block.append(el("div", "cxm-h-meta", [word.partOfSpeech, paragraph.label].filter(Boolean).join(" · ")), el("div", "cxm-h-text", paragraph.text));
        selected.append(block);
      }
      card.append(selected);
    }
    if (words.length) {
      const sec = el("div", "cxm-h-sec");
      words.slice(0, 3).forEach((w, i) => {
        const item = el("div", "cxm-h-item");
        const head = el("div");
        if (i === 0) head.append(el("span", "cxm-h-tag", "단어장"), el("span", "cxm-h-term", w.term));
        const pinned = new Set(window.CodexVocabContent?.normalizeSelections(w) || []);
        const meta = [w.partOfSpeech, words.length > 1 ? (i === 0 ? "이 문맥에 가까운 뜻" : `다른 뜻 ${i}`) : ""].filter(Boolean).join(" · ");
        if (meta) head.append(el("span", "cxm-h-meta", meta));
        const remaining = w.showContextAnalysis === false ? "" : w.meaning.split(/\n\s*\n/).map(text => text.trim()).filter(text => text && !pinned.has(text)).join("\n\n");
        item.append(head);
        const label = el("label", "cxm-h-learning", "학습 상태");
        const select = document.createElement("select");
        select.setAttribute("aria-label", w.term + " 학습 상태");
        for (const [value, text] of [["new", "미학습"], ["review", "복습 필요"], ["known", "숙지함"]]) {
          const option = document.createElement("option"); option.value = value; option.textContent = text; select.append(option);
        }
        select.value = w.status || "new";
        const notice = el("span", "cxm-h-meta"); notice.setAttribute("role", "status"); notice.setAttribute("aria-live", "polite");
        select.addEventListener("change", async () => {
          const status = /** @type {VocabEntry['status']} */ (select.value), previous = w.status || "new";
          for (const control of card.querySelectorAll("select")) control.disabled = true;
          notice.textContent = "저장 중…";
          try {
            const current = await api.vocabularyRead();
            if (!current.entries.some(entry => entry.id === w.id)) throw new Error("삭제된 단어입니다. 단어장을 새로고침해 주세요.");
            const next = await api.vocabularyEdit(w.id, { status }, current.revision);
            if (disposed) return;
            vocabEpoch++; vocab = next; vocabStale = false; vocabAt = Date.now();
            w.status = status; notice.textContent = "저장됨";
          } catch (error) {
            select.value = previous; notice.textContent = error.message || "저장하지 못했습니다. 다시 시도해 주세요.";
          } finally {
            for (const control of card.querySelectorAll("select")) control.disabled = false;
          }
        });
        label.append(select, notice); item.append(label);
        if (remaining) item.append(el("div", "cxm-h-text", remaining));
        for (const context of w.contextAnalyses || []) if (context.visible) {
          item.append(el("div", "cxm-h-meta", "다른 문장의 맥락분석"), el("div", "cxm-h-ex", context.context), el("div", "cxm-h-text", context.analysis));
        }
        if (w.example && !pinned.has(w.example.trim())) item.append(el("div", "cxm-h-ex", w.example));
        sec.append(item);
      });
      if (words.length > 3) sec.append(el("div", "cxm-h-meta", `외 ${words.length - 3}개 뜻`));
      card.append(sec);
    }
    if (memos.length) {
      const sec = el("div", "cxm-h-sec");
      memos.slice(0, 3).forEach((m, i) => {
        const item = el("div", "cxm-h-item");
        const head = el("div");
        if (i === 0) head.append(el("span", "cxm-h-tag memo", "메모"));
        head.append(el("span", "cxm-h-meta", m.created || ""));
        item.append(head, el("div", "cxm-h-text", m.note || "(메모 없음)"));
        sec.append(item);
      });
      if (memos.length > 3) sec.append(el("div", "cxm-h-meta", `외 메모 ${memos.length - 3}개`));
      card.append(sec);
    }
    card.append(el("div", "cxm-h-hint", "클릭하면 자세히"));
    card.scrollTop = 0;
  }

  /** @param {DOMRect} rect */
  function place(rect) {
    if (!card.isConnected) document.documentElement.append(card);
    const w = card.offsetWidth, h = card.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, innerWidth - w - 8));
    const below = rect.bottom + 8;
    card.style.left = left + "px";
    card.style.top = (below + h > innerHeight - 8 ? Math.max(8, rect.top - h - 8) : below) + "px";
  }

  // ---------------------------------------------------------------- 마우스 위치 → 단어·메모
  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    const r = document.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  function rectAt(range, x, y) {
    for (const r of range.getClientRects()) {
      if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return r;
    }
    return null;
  }
  /** 저장 단어 밑줄 위면 {term, rect} */
  function wordAt(x, y) {
    const hl = /** @type {any} */ (CSS).highlights?.get(VOCAB_HL);
    if (!hl?.size) return null;
    const p = caretAt(x, y);
    if (!p) return null;
    for (const item of hl) {
      // 대부분 한 글자 노드 안의 범위다. 그런 범위는 마우스 위치와 노드·위치만 비교하고, 맞을 때만 Range 를 만든다
      // (마우스가 움직일 때마다 화면의 모든 범위를 Range 로 바꾸지 않게)
      if (item.startContainer === item.endContainer && item.startContainer.nodeType === 3
        && (item.startContainer !== p.node || p.offset < item.startOffset || p.offset > item.endOffset)) continue;
      // 단어장은 StaticRange 로 칠한다 → 위치 비교·글자 상자를 쓰려면 Range 로 바꾼다
      let range = item;
      if (!(item instanceof Range)) {
        try {
          range = new Range();
          range.setStart(item.startContainer, item.startOffset);
          range.setEnd(item.endContainer, item.endOffset);
        } catch { continue; }   // 본문이 바뀌어 사라진 위치
      }
      try { if (!range.isPointInRange(p.node, p.offset)) continue; } catch { continue; }
      const rect = rectAt(range, x, y);
      if (rect) {
        const host = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
        const block = /** @type {Element} */ (host)?.closest("p, li, pre, td, blockquote, [data-selected-text-overlay-target]") || host;
        return { term: range.toString(), rect, context: (block?.textContent || "").slice(0, 1600), range: item };
      }
    }
    return null;
  }

  let shownKey = "", timer = 0, frame = 0, lastX = 0, lastY = 0;
  let shownRange = null, hoverEpoch = 0;
  const hide = () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame); frame = 0;
    hoverEpoch++;
    shownRange = null;
    shownKey = "";
    card.classList.remove("cxm-on");
    if (card.contains(document.activeElement)) /** @type {HTMLElement} */ (document.activeElement).blur();
  };

  async function inspect() {
    frame = 0;
    if (disposed) return;
    const x = lastX, y = lastY;
    if (detailOpen()) { hide(); return; }
    const word = wordAt(x, y);
    const memoHit = window.__codexMemo?.memosAt?.(x, y) || { memos: [], rect: null };
    if (!word && !memoHit.memos.length) { scheduleHide(); return; }
    const id = (word ? "w:" + key(word.term) : "") + "|" + memoHit.memos.map((m) => m.id).join(",");
    if (id === shownKey && (word?.range || null) === shownRange) return; // 같은 위치 위에서 움직이는 중
    hide();
    shownKey = id;
    shownRange = word?.range || null;
    const epoch = hoverEpoch;
    const current = () => !disposed && epoch === hoverEpoch;
    const rect = word?.rect || memoHit.rect;
    timer = window.setTimeout(async () => {
      const find = (snap) => (snap?.entries || []).filter((e) => key(e.term) === key(word.term));
      let words = word ? find(await loadVocab()) : [];
      // 밑줄은 있는데 기억해 둔 목록에 없으면 (변경 신호를 놓친 경우) 한 번 새로 읽는다
      if (word && !words.length) { vocabStale = true; words = find(await loadVocab()); }
      if (!current()) return;
      if (!words.length && !memoHit.memos.length) return;
      if (words.length > 1) {
        // 이 문맥에 맞는 뜻부터: Mica(로컬 판단 모델) 순서, 못 쓰면 저장 당시 문맥과 글자가 비슷한 순서
        const order = await Promise.race([
          api?.vocabularySenseRank?.(word.term, word.context).catch(() => null) ?? Promise.resolve(null),
          new Promise((r) => setTimeout(() => r(null), 1500)),
        ]);
        if (!current()) return;
        words = Array.isArray(order) && order.length
          ? [...words].sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99))
          : words.map((w) => ({ w, score: Math.max(similarity(word.context, w.context || ""), ...(w.contextAnalyses || []).map(c => similarity(word.context, c.context))) }))
            .sort((a, b) => b.score - a.score).map((x) => x.w);
      }
      if (detailOpen()) return;              // 기다리는 사이 클릭해서 자세히 보기가 열린 경우
      render(words, memoHit.memos);
      place(rect);
      card.classList.add("cxm-on");
    }, SHOW_DELAY);
  }

  /** @param {MouseEvent} e */
  function onMove(e) {
    lastX = e.clientX; lastY = e.clientY;
    const t = /** @type {Element | null} */ (e.target instanceof Element ? e.target : null);
    if (t && card.contains(t)) { clearTimeout(leaveTimer); return; }
    if (card.classList.contains("cxm-on") && card.contains(document.activeElement)) { clearTimeout(leaveTimer); return; }
    // 단어장 창·메모 창·입력란 위에서는 보여주지 않는다
    if (e.buttons || t?.closest("#cdx-vocabulary, #cdx-vocabulary-inline, #cxm-root, input, textarea, [contenteditable='true']")) { hide(); return; }
    clearTimeout(leaveTimer);
    if (!frame) frame = requestAnimationFrame(inspect);   // 프레임마다 한 번만
  }

  let leaveTimer = 0;
  const scheduleHide = () => {
    clearTimeout(timer); hoverEpoch++; shownRange = null; shownKey = "";
    clearTimeout(leaveTimer); leaveTimer = window.setTimeout(hide, 180);
  };
  cleanups.push(() => clearTimeout(leaveTimer));

  const listen = (target, type, fn, opt) => {
    target.addEventListener(type, fn, opt);
    cleanups.push(() => target.removeEventListener(type, fn, opt));
  };
  listen(document, "mousemove", onMove, { passive: true });
  listen(card, "focusin", () => clearTimeout(leaveTimer));
  listen(card, "focusout", event => { if (card.classList.contains("cxm-on") && !card.contains(event.relatedTarget)) scheduleHide(); });
  listen(document, "mousedown", event => { if (!card.contains(event.target)) hide(); }, true);
  listen(document, "mouseleave", hide);
  listen(window, "scroll", event => { if (event.target !== card) hide(); }, true);
  listen(window, "blur", hide);
  listen(document, "keydown", event => { if (event.key === "Escape") hide(); }, true);

  window.__cxmHover = {
    version: VERSION,
    destroy() {
      if (disposed) return;
      disposed = true;
      hide();
      cancelAnimationFrame(frame);
      cleanups.splice(0).reverse().forEach((f) => { try { f(); } catch { /* 이미 정리됨 */ } });
      delete window.__cxmHover;
    },
  };
})();
