// @ts-check
// 단어장 창에 메모를 합친다 (vocabulary-renderer.js 의 window.__cxmVocabHooks 연결 지점 사용).
// - 툴바: 짧은 선택은 [단어장·메모] 하나 (긴 문장은 inject.js 의 [메모])
// - 작성: 핵심 뜻 → 내 메모 → 저장 → 접힌 원문 문맥
// - 보관함: [전체 · 단어 · 메모] 필터, 함께 검색, 메모 카드(위치로 이동·수정·복사·삭제)
// - 위치로 이동: 메모한 대화를 열고 그 글로 스크롤해 잠깐 반짝인다. 대화가 없어졌으면 카드에 표시한다.
// 메모 데이터와 저장은 inject.js(window.__codexMemo)가 맡는다. 단어장 원본 화면은 배치·스타일만 바꾼다.
(() => {
  const VERSION = 12;
  if (window.__cxmVocabHooks?.version === VERSION) return;
  if (window.__cxmVocabHooks?.destroy?.() === false) return;

  const memoApi = () => window.__codexMemo;
  /** @typedef {"all" | "word" | "memo"} Kind */
  const norm = (v) => (v || "").normalize("NFKC").toLocaleLowerCase("ko").replace(/\s+/g, " ").trim();
  /** 열린 단어장 창 하나의 상태 */
  let st = null;
  let alive = true, classifying = false;
  /** @type {Record<string, string>} */
  const categories = {todo: "할 일", idea: "아이디어", question: "질문", reference: "참고", "": "미분류"};
  const categoryOf = (m) => Object.hasOwn(categories, m.category || "") ? m.category || "" : "";

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    /* 작성: 내 메모 */
    #cdx-vocabulary .cxm-vmemo { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--vb-line); }
    #cdx-vocabulary .cxm-vmemo-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
    #cdx-vocabulary .cxm-vmemo-head span { font-size: 12px; font-weight: 600; }
    #cdx-vocabulary .cxm-vmemo-head small { font-size: 11px; color: var(--vb-muted); }
    #cdx-vocabulary .cxm-vmemo-quote { font-size: 12px; color: var(--vb-muted); border-left: 3px solid #ffd43b;
      padding: 2px 8px; margin-bottom: 8px; max-height: 60px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
    #cdx-vocabulary .cxm-vmemo textarea { min-height: 64px; }

    /* 작성: 버튼 — 저장 두 개는 크게, 뜻 편집·다시 요약 등은 오른쪽에 작게 */
    #cdx-vocabulary .vb-actions { align-items: center; margin-top: 14px; }
    #cdx-vocabulary .vb-actions > button { order: 2; }
    #cdx-vocabulary .vb-actions .vb-primary { order: 0; }
    #cdx-vocabulary .vb-actions .cxm-only { order: 1; }
    #cdx-vocabulary .vb-actions .cxm-sub { order: 2; border-color: transparent; padding: 5px 7px; font-size: 12px; color: var(--vb-muted); }
    #cdx-vocabulary .vb-actions .cxm-sub:hover { color: var(--vb-ink); }
    #cdx-vocabulary .vb-actions .cxm-sub-first { margin-left: auto; }
    #cdx-vocabulary .vb-note { opacity: .75; }

    /* 작성: 이 문맥에서의 쓰임 (저장된 뜻과 비교한 결과) */
    #cdx-vocabulary .cxm-usage { margin-top: 16px; padding: 10px 12px; border-radius: 9px; background: var(--vb-soft);
      color: var(--vb-muted); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
    #cdx-vocabulary .cxm-usage b { display: block; font-size: 11px; font-weight: 600; margin-bottom: 4px; }
    #cdx-vocabulary .cxm-usage .cxm-usage-ask { padding: 3px 10px; font-size: 12px; }
    #cdx-vocabulary .cxm-new-sense { display: inline-block; margin-left: 8px; padding: 0 7px; border-radius: 999px; font-size: 11px;
      font-weight: 600; vertical-align: middle; background: color-mix(in srgb, #22c55e 18%, transparent); color: #16a34a; }

    /* 보관함: 종류 탭 */
    #cdx-vocabulary .cxm-tabs { display: flex; gap: 4px; margin-top: 12px; padding: 3px; border-radius: 9px; background: var(--vb-soft); }
    #cdx-vocabulary .cxm-tabs button { flex: 1; border: 0; padding: 6px 8px; font-size: 12px; color: var(--vb-muted); border-radius: 7px; }
    #cdx-vocabulary .cxm-tabs button[aria-selected="true"] { background: var(--vb-bg); color: var(--vb-ink); font-weight: 600;
      box-shadow: 0 1px 3px #0003; }
    #cdx-vocabulary .cxm-tabs button b { font-weight: inherit; opacity: .7; margin-left: 4px; }
    #cdx-vocabulary .vb-library .vb-search { margin-top: 10px; }
    #cdx-vocabulary .vb-filters { gap: 10px; }
    #cdx-vocabulary .vb-filters select { flex: 0 1 auto; width: auto; padding: 4px 8px; font-size: 12px; border-radius: 7px; }
    #cdx-vocabulary .vb-filters label { color: var(--vb-muted); }

    /* 보관함: 메모 카드 */
    #cdx-vocabulary .cxm-memo-card { border-left: 3px solid #ffd43b; }
    #cdx-vocabulary .cxm-memo-card .cxm-memo-note { color: var(--vb-ink); font-size: 13px; margin-top: 0; }
    #cdx-vocabulary .cxm-memo-card .cxm-memo-quote { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden; border-left: 2px solid var(--vb-line); padding-left: 8px; }
    #cdx-vocabulary .cxm-memo-card .cxm-memo-meta { font-size: 11px; }
    /* 위치로 이동: 대화 상태 */
    #cdx-vocabulary .cxm-thread-badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 999px; font-size: 10.5px; font-weight: 600; }
    #cdx-vocabulary .cxm-thread-badge[data-state=missing] { background: #e5484d26; color: #e5484d; }
    #cdx-vocabulary .cxm-thread-badge[data-state=archived] { background: #8b95a133; color: var(--vb-muted); }
    #cdx-vocabulary .cxm-memo-card[data-thread=missing] .cxm-memo-quote { text-decoration: line-through; opacity: .6; }
    ::highlight(cxm-memo-flash) { background-color: rgba(255, 212, 59, .75); }
    .cxm-jump-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483646; max-width: min(520px, calc(100vw - 32px));
      padding: 9px 14px; border-radius: 10px; background: #26272b; color: #eceef1; border: 1px solid #41434a; box-shadow: 0 10px 30px #0006;
      font: 12.5px/1.5 'Segoe UI', 'Malgun Gothic', sans-serif; }
    #cdx-vocabulary .cxm-memo-card textarea { margin-top: 7px; min-height: 64px; }
    #cdx-vocabulary .cxm-category-filters { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    #cdx-vocabulary .cxm-category-filters[hidden] { display: none; }
    #cdx-vocabulary .cxm-category-chip, #cdx-vocabulary .cxm-category-filters button { border-radius: 999px; padding: 3px 8px; font-size: 11px; }
    #cdx-vocabulary .cxm-category-filters button[aria-pressed="true"] { background: var(--vb-soft); font-weight: 600; }
    #cdx-vocabulary .cxm-category-menu { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 0; }
    #cdx-vocabulary .cxm-category-menu[hidden] { display: none; }
    #cdx-vocabulary .cxm-classify { font-size: 12px; margin-top: 8px; }
    #cdx-vocabulary .cxm-category-menu button small { margin-left: 4px; opacity: .65; font-variant-numeric: tabular-nums; }
    #cdx-vocabulary .cxm-category-menu button.cxm-top { border-color: #548de8; }

  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  /**
   * @param {string} tag
   * @param {string} [cls]
   * @param {string} [text]
   */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  /**
   * @param {string} text
   * @param {() => void} action
   * @param {string} [cls]
   */
  function btn(text, action, cls) {
    const b = /** @type {HTMLButtonElement} */ (el("button", cls, text));
    b.type = "button";
    b.addEventListener("click", action);
    return b;
  }
  const cut = (v, n) => (v.length > n ? v.slice(0, n) + "…" : v);

  function saveMemo() {
    const text = st.input.value.trim();
    if (!text || !st.draft) return false;
    memoApi()?.add(st.draft, text);
    st.input.value = "";
    st.tools.controls();
    syncButtons();
    return true;
  }

  function syncButtons() {
    if (!st) return;
    st.only.disabled = !st.draft || !st.input.value.trim();
  }

  /** @param {Kind} kind */
  function setKind(kind) {
    st.kind = kind;
    for (const b of st.tabs.querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.kind === kind));
    // 즐겨찾기·학습 상태는 단어에만 해당하므로 메모 탭에서는 숨긴다
    const filters = /** @type {HTMLElement | null} */ (st.s.dialog.querySelector(".vb-filters"));
    if (filters) filters.hidden = kind === "memo";
    st.categoryFilters.hidden = kind !== "memo";
    st.tools.drawList();
  }

  function syncClassifyButton() {
    if (!st) return;
    const count = (memoApi()?.list() || []).filter((m) => !categoryOf(m)).length;
    st.classify.hidden = !st.available || !count;
    st.classify.disabled = classifying;
    st.classify.textContent = classifying ? "자동 분류 중…" : `미분류 ${count}개 분류하기`;
  }

  async function classifyAll() {
    if (classifying || !window.codexLabels?.memoClassify) return;
    classifying = true;
    syncClassifyButton();
    const memos = (memoApi()?.list() || []).filter((m) => !categoryOf(m));
    // 네 개씩 요청한다. 저장은 도우미가 맡아, 다른 창의 수동 변경도 덮어쓰지 않는다.
    try {
      for (let i = 0; alive && i < memos.length; i += 4) {
        await Promise.all(memos.slice(i, i + 4).map((m) => window.codexLabels.memoClassify(m).catch(() => null)));
      }
    } finally {
      classifying = false;
      syncClassifyButton();
    }
  }

  // ------------------------------------------------------------ 위치로 이동
  const threads = () => /** @type {any} */ (window).__cxmThreads;
  /** 메모가 연결된 Codex 대화 id (채팅 메모·예전 'title:' 메모는 null) */
  const threadOf = (m) => threads()?.uuidOf?.(m.conv) || null;
  /** 메모가 연결된 ChatGPT 채팅 id ('chat:<id>' 메모) */
  const chatOf = (m) => threads()?.chatOf?.(m.conv) || null;
  /** 보관함을 열 때: 메모들이 연결된 대화가 아직 있는지 한 번에 묻는다 */
  async function loadThreadStates() {
    const current = st;
    const ids = [...new Set((memoApi()?.list() || []).map(threadOf).filter(Boolean))];
    if (!current || !ids.length || !window.codexLabels?.threadStates) return;
    const states = await window.codexLabels.threadStates(ids).catch(() => null);
    if (!states || st !== current) return;
    let changed = false;
    for (const [id, state] of Object.entries(states)) if (current.threads.get(id) !== state) { current.threads.set(id, state); changed = true; }
    if (changed && !current.s.list.querySelector("textarea:focus")) current.tools.drawList();
  }
  let toastTimer = 0;
  /** 보관함을 닫은 뒤에도 보이는 짧은 알림 */
  function toast(text) {
    let node = document.querySelector(".cxm-jump-toast");
    if (!node) { node = el("div", "cxm-jump-toast"); node.setAttribute("role", "status"); document.body.append(node); }
    node.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => node?.remove(), 5000);
  }
  /** 메모한 글로 스크롤하고 1.6초 동안 진하게 칠한다 @param {Range} range */
  function reveal(range) {
    const host = range.startContainer.nodeType === 1 ? /** @type {Element} */ (range.startContainer) : range.startContainer.parentElement;
    host?.scrollIntoView({block: "center", behavior: "smooth"});
    const reg = /** @type {any} */ (CSS).highlights, H = /** @type {any} */ (window).Highlight;
    if (!reg || !H) return;
    reg.set("cxm-memo-flash", new H(range));
    setTimeout(() => reg.delete("cxm-memo-flash"), 1600);
  }
  /** 메모한 대화를 열고 그 위치로 간다 */
  async function jumpTo(m) {
    const chat = chatOf(m);
    const id = chat ? `chat:${chat}` : threadOf(m);
    if (!id || !threads()) return;
    // 대화를 보이게 단어장 창을 닫는다 (저장하지 않은 수정이 있어 닫지 않기로 하면 그대로 둔다)
    /** @type {HTMLElement | null} */ (document.querySelector("#cdx-vocabulary .vb-close"))?.click();
    if (document.querySelector("#cdx-vocabulary")) return;
    toast(chat ? "메모한 채팅을 여는 중…" : "메모한 대화를 여는 중…");
    if (!await threads().open(id)) {
      if (chat) { toast(`채팅${m.title ? ` '${m.title}'` : ""}을 열지 못했습니다. 삭제되었거나 다른 계정의 채팅일 수 있습니다.`); return; }
      const state = (await window.codexLabels?.threadStates?.([id]).catch(() => null))?.[id];
      toast(state === "missing" ? `메모한 대화${m.title ? ` '${m.title}'` : ""}가 삭제되어 없습니다.`
        : "대화를 열지 못했습니다. 왼쪽 목록에서 대화를 펼친 뒤 다시 시도하세요.");
      return;
    }
    // 대화가 그려지고 형광펜이 다시 계산될 때까지 기다린다
    for (const end = Date.now() + 6000; Date.now() < end;) {
      const range = memoApi()?.rangeOf?.(m.id);
      if (range) { reveal(range); toast("메모한 위치입니다."); return; }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    toast("메모한 글을 찾지 못했습니다. 위로 스크롤해 내용을 불러온 뒤 다시 시도하세요.");
  }

  /** @param {Memo} m */
  function memoCard(m) {
    const card = el("article", "vb-card cxm-memo-card");
    const note = el("p", "cxm-memo-note", m.note || "(메모 없음)");
    const quote = el("p", "cxm-memo-quote", m.quote || "");
    quote.hidden = !m.quote;
    const chat = chatOf(m);
    const meta = el("p", "cxm-memo-meta", ["메모", chat ? "채팅" : "", m.created, m.title].filter(Boolean).join(" · "));
    if (chat) card.dataset.source = "chat";
    const thread = threadOf(m), state = thread ? st.threads.get(thread) : "";
    if (state === "missing" || state === "archived") {
      card.dataset.thread = state;
      const badge = el("span", "cxm-thread-badge", state === "missing" ? "대화 없음 (삭제됨)" : "보관된 대화");
      badge.dataset.state = state;
      meta.append(badge);
    }
    const go = btn("위치로 이동", () => { void jumpTo(m); }, "cxm-memo-go");
    go.disabled = (!thread && !chat) || state === "missing";
    go.title = chat ? "메모한 채팅을 열고 그 위치로 이동" : !thread ? "대화 정보가 없는 예전 메모입니다"
      : state === "missing" ? "메모한 대화가 삭제되어 열 수 없습니다" : "메모한 대화를 열고 그 위치로 이동";
    const actions = el("div", "vb-card-actions");
    const chip = btn(categories[categoryOf(m)], () => {
      menu.hidden = !menu.hidden;
      chip.setAttribute("aria-expanded", String(!menu.hidden));
      if (!menu.hidden) showScores(m, menu);
    }, "cxm-category-chip");
    chip.setAttribute("aria-label", `메모 분류 변경: ${categories[categoryOf(m)]}`);
    chip.setAttribute("aria-haspopup", "menu");
    chip.setAttribute("aria-expanded", "false");
    const menu = el("div", "cxm-category-menu");
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    for (const [id, label] of Object.entries(categories)) {
      const option = btn(label, () => {
        memoApi()?.update(m.id, undefined, /** @type {MemoCategory | ""} */ (id));
        menu.hidden = true;
        chip.setAttribute("aria-expanded", "false");
      });
      option.setAttribute("role", "menuitem");
      option.dataset.category = id;
      menu.append(option);
    }
    const openEditor = (focus) => {
      const area = /** @type {HTMLTextAreaElement} */ (el("textarea"));
      area.value = st.edits.get(m.id) ?? m.note ?? "";
      st.edits.set(m.id, area.value);
      area.addEventListener("input", () => st?.edits.set(m.id, area.value));
      const save = btn("저장", () => { st.edits.delete(m.id); memoApi()?.update(m.id, area.value.trim()); st.tools.message("메모를 수정했습니다."); });
      const cancel = btn("취소", () => {
        if (area.value !== (m.note || "") && !window.confirm("저장하지 않은 메모 수정을 취소할까요?")) return;
        st.edits.delete(m.id); st.tools.drawList();
      });
      area.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.click(); }
      });
      note.replaceWith(area);
      actions.replaceChildren(save, cancel);
      if (focus) area.focus();
    };
    const edit = btn("수정", () => openEditor(true));
    const copy = btn("복사", () => {
      const q = (m.quote || "").split("\n").map((l) => "> " + l).join("\n");
      navigator.clipboard.writeText((m.quote ? q + "\n\n" : "") + (m.note || ""))
        .then(() => st?.tools.message("메모를 복사했습니다."), () => st?.tools.message("복사하지 못했습니다.", true));
    });
    const del = btn("삭제", () => {
      if (!del.hasAttribute("data-confirm")) { del.setAttribute("data-confirm", ""); del.textContent = "삭제 확인"; return; }
      st.edits.delete(m.id);
      memoApi()?.remove(m.id);
      st.tools.message("메모를 삭제했습니다.");
    });
    actions.append(go, edit, copy, del);
    card.append(chip, menu, note, quote, meta, actions);
    if (st.edits.has(m.id)) openEditor(false);
    return card;
  }

  /**
   * 직접 고르는 분류 메뉴에 분류마다 확신 %를 붙인다 (분류기를 못 쓰면 그대로)
   * @param {Memo} m
   * @param {HTMLElement} menu
   */
  async function showScores(m, menu) {
    if (menu.dataset.scored) return;
    menu.dataset.scored = "1";
    const scores = await window.codexLabels?.memoScores?.(m).catch(() => null);
    if (!scores) { delete menu.dataset.scored; return; }
    const top = Object.keys(scores).reduce((a, b) => (scores[b] > scores[a] ? b : a));
    for (const option of /** @type {NodeListOf<HTMLElement>} */ (menu.querySelectorAll("button[data-category]"))) {
      const p = scores[option.dataset.category || ""];
      if (p === undefined) continue;
      option.querySelector("small")?.remove();
      option.append(el("small", "", `${Math.round(p * 100)}%`));
      option.classList.toggle("cxm-top", option.dataset.category === top);
      option.title = `자동 분류 확신 ${Math.round(p * 100)}%`;
    }
  }

  /** @type {VocabHooks} */
  window.__cxmVocabHooks = {
    version: VERSION,
    destroy() {
      if (st) {
        // A cancelled unsaved-work confirmation aborts the entire hot reload.
        st.s.dialog.querySelector(".vb-close")?.click();
        if (st?.s.dialog.isConnected) return false;
      }
      alive = false;
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet);
      delete window.__cxmOpenLibrary;
      return true;
    },

    buttonLabel: (exists) => (exists ? "맥락분석" : "단어장·메모"),

    saveLabel(s) {
      if (st?.s !== s || s.saved) return null;
      const memo = !!st.input.value.trim();
      if (s.newSense) return memo ? "새 의미+메모 저장" : "새 의미로 저장";
      return memo ? "뜻+메모 저장" : null;
    },

    hasUnsaved(s) {
      if (st?.s !== s) return false;
      if (st.input.value.trim()) return true;
      const memos = memoApi()?.list() || [];
      return [...st.edits].some(([id, value]) => value !== (memos.find((m) => m.id === id)?.note || ""));
    },

    libraryKind(s, kind) {
      if (st?.s === s && ["all", "word", "memo"].includes(kind)) setKind(kind);
    },

    viewChanged(s) {
      if (st?.s !== s) return;
      syncButtons();
    },

    // 저장된 뜻과 비교한 결과: 이 문맥에서의 구체적 쓰임을 뜻 아래에 보여준다 (빈 글이면 지운다).
    // 분류기(Mica·JEV)가 고른 경우(info.via 있음)는 쓰임 문장이 없으므로 누르면 GPT 로 받는 버튼을 둔다.
    usage(s, text, item, info) {
      const pane = s.dialog.querySelector(".vb-pane:not(.vb-library)");
      pane?.querySelectorAll(".cxm-usage, .cxm-new-sense").forEach((n) => n.remove());
      if (s.newSense) pane?.querySelector("h3")?.append(el("span", "cxm-new-sense", "새 의미"));
      if (!text && !info?.via) return;
      const box = el("div", "cxm-usage");
      const title = item ? `여기서 가리키는 것 · 저장된 뜻과 같음${info?.via ? ` (${info.via} 판단)` : ""}` : "여기서 가리키는 것";
      box.append(el("b", "", title));
      if (text) box.append(document.createTextNode(text));
      else {
        const vs = /** @type {any} */ (s);
        const ask = btn("가리키는 것 받기", async () => {
          ask.disabled = true;
          ask.textContent = "정리하는 중…";
          try {
            const usage = await window.codexLabels?.vocabularyUsage?.(vs.input, item.id);
            ask.replaceWith(document.createTextNode(usage || "설명을 받지 못했습니다."));
          } catch (e) {
            ask.disabled = false;
            ask.textContent = "다시 시도";
            st?.tools.message(e?.message || String(e), true);
          }
        }, "cxm-usage-ask");
        box.append(ask);
      }
      pane?.querySelector(".vb-meaning")?.after(box);
    },

    opened(s, tools) {
      const draft = memoApi()?.takeVocabDraft?.() || null;
      const vs = /** @type {any} */ (s);   // 단어장 원본 창 상태 (edit·retry·add·cancel 버튼 등)
      const title = s.dialog.querySelector("#cdx-vocabulary-title");
      if (title) title.textContent = "단어장 · 메모";
      const sub = /** @type {HTMLElement | null} */ (s.dialog.querySelector(".vb-subtitle"));
      if (sub) sub.hidden = true;

      // ---------- 작성: 뜻 → 내 메모 → 버튼 → 원문 문맥 순서로 배치
      const box = el("div", "cxm-vmemo");
      const head = el("div", "cxm-vmemo-head");
      head.append(el("span", "", "내 메모"), el("small", "", "Ctrl+Enter 저장"));
      const input = /** @type {HTMLTextAreaElement} */ (el("textarea"));
      input.rows = 3;
      input.maxLength = 4000;
      input.placeholder = "메모 (선택)";
      input.setAttribute("aria-label", "내 메모");
      box.append(head);
      // 짧은 단어는 제목과 같아 인용을 다시 보여주지 않는다 (긴 문장일 때만)
      if (draft?.quote && norm(draft.quote) !== norm(vs.input?.term || title?.textContent || "")) {
        box.append(el("div", "cxm-vmemo-quote", cut(draft.quote, 300)));
      }
      box.append(input);
      box.hidden = !draft;
      const actions = s.dialog.querySelector(".vb-actions");
      const context = s.dialog.querySelector(".vb-context");
      s.dialog.querySelector('.vb-pane:not(.vb-library) .vb-analysis')?.before(box);

      const only = btn("메모만 저장", () => { if (saveMemo()) tools.message("메모를 저장했습니다."); }, "cxm-only");
      only.hidden = !draft;
      actions?.append(only);
      const subs = [...(actions?.querySelectorAll("button:not(.vb-primary):not(.cxm-only)") || [])];
      subs.forEach((b, i) => b.classList.add("cxm-sub", ...(i === 0 ? ["cxm-sub-first"] : [])));

      // 뜻+메모 저장: 단어장 저장이 성공하면(saved 연결 지점) 메모도 저장
      let withVocab = false;
      s.save.addEventListener("click", () => { withVocab = !s.saved && !!input.value.trim(); }, true);
      input.addEventListener("input", () => { tools.controls(); syncButtons(); });
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        // 뜻을 저장할 수 있으면 뜻+메모, 아니면(요약 중·이미 저장한 단어) 메모만
        if (!s.save.disabled && !s.saved) s.save.click(); else only.click();
      });
      for (const t of ["keyup", "keypress"]) input.addEventListener(t, (e) => e.stopPropagation());

      // ---------- 보관함: 전체 · 단어 · 메모 탭
      const tabs = el("div", "cxm-tabs");
      tabs.setAttribute("role", "tablist");
      for (const [kind, label] of /** @type {[Kind, string][]} */ ([["all", "전체"], ["word", "단어"], ["memo", "메모"]])) {
        const b = btn("", () => setKind(kind));
        b.dataset.kind = kind;
        b.setAttribute("role", "tab");
        b.append(label, el("b", "", "0"));
        tabs.append(b);
      }
      s.dialog.querySelector(".vb-library-head")?.after(tabs);
      const categoryFilters = el("div", "cxm-category-filters");
      categoryFilters.setAttribute("aria-label", "메모 분류 필터");
      for (const [id, label] of [["all", "전체"], ...Object.entries(categories)]) {
        const b = btn(label, () => {
          st.category = id;
          for (const option of categoryFilters.querySelectorAll("button")) option.setAttribute("aria-pressed", String(option.dataset.category === id));
          tools.drawList();
        });
        b.dataset.category = id;
        b.setAttribute("aria-pressed", String(id === "all"));
        categoryFilters.append(b);
      }
      tabs.after(categoryFilters);
      const classify = btn("", classifyAll, "cxm-classify");
      classify.hidden = true;
      categoryFilters.after(classify);
      if (s.count) s.count.textContent = "보관함";
      if (s.search) s.search.placeholder = "단어, 뜻, 메모, 원문 검색";

      st = {
        s, tools, draft, input, only, tabs, categoryFilters, classify, category: "all", available: false,
        edits: new Map(), kind: /** @type {Kind} */ ("all"), healthTimer: null,
        /** @type {Map<string, string>} 대화 id → 'ok' | 'archived' | 'missing' | 'unknown' */
        threads: new Map(),
        get withVocab() { return withVocab; },
        set withVocab(v) { withVocab = v; },
        // 자동 분류 응답이 도착해도 입력 중인 카드의 키보드 포커스를 빼앗지 않는다.
        unsub: memoApi()?.subscribe?.(() => {
          if (s.list.querySelector("textarea:focus")) syncClassifyButton();
          else tools.drawList();
        }),
      };
      syncButtons();
      setKind("all");
      const current = st;
      const probe = async () => {
        try {
          const info = await window.codexLabels?.classifierGet?.();
          if (alive && st === current) { st.available = !!info?.available; syncClassifyButton(); }
        } catch { if (st === current) { st.available = false; syncClassifyButton(); } }
      };
      probe();
      st.healthTimer = setInterval(probe, 30000);
      void loadThreadStates();
    },

    saved(s) {
      if (st?.s !== s || !st.withVocab || /** @type {any} */ (s).editorKind !== "compose") return;
      st.withVocab = false;
      if (saveMemo()) st.tools.message("뜻과 메모를 저장했습니다.");
    },

    closed(s) {
      if (st?.s !== s) return;
      st.unsub?.();
      clearInterval(st.healthTimer);
      st = null;
    },

    drawList(s, q) {
      if (st?.s !== s) return;
      const kind = st.kind;
      const memos = (memoApi()?.list() || []).slice().reverse();
      syncClassifyButton();
      const words = s.snapshot?.entries.length ?? 0;
      if (s.count) s.count.textContent = "보관함";
      const counts = {all: words + memos.length, word: words, memo: memos.length};
      for (const b of st.tabs.querySelectorAll("button")) b.querySelector("b").textContent = String(counts[b.dataset.kind]);

      const empty = s.list.querySelector(".vb-empty");
      if (kind === "memo") s.list.querySelectorAll(".vb-card, .vb-empty").forEach((n) => n.remove());
      if (kind === "word") return;
      // 즐겨찾기·학습 상태 필터를 켠 '전체' 탭에서는 단어만 보여준다
      if (kind === "all" && (s.favorites?.checked || s.statusFilter?.value)) return;
      const shown = memos.filter((m) => (kind !== "memo" || st.category === "all" || categoryOf(m) === st.category)
        && (!q || norm([m.quote, m.note, m.title].join(" ")).includes(q)));
      if (shown.length) empty?.remove();
      else if (kind === "memo") s.list.append(el("p", "vb-empty", q || st.category !== "all" ? "일치하는 메모가 없습니다." : "저장한 메모가 여기에 표시됩니다."));
      else if (empty && !q && !words) empty.textContent = "저장한 단어와 메모가 여기에 표시됩니다.";
      for (const m of shown) s.list.append(memoCard(m));
    },
  };

  // 도우미(트레이·Ctrl+Alt+M)가 부른다: 열린 작성 내용도 보존하며 보관함으로 이동한다.
  /** @param {Kind} kind */
  window.__cxmOpenLibrary = (kind = "memo") => {
    window.dispatchEvent(new CustomEvent("codex-labels:open-vocabulary", {detail: {kind}}));
  };
})();
