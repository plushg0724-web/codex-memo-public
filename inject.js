// @ts-check
// Codex 화면 안에서 동작하는 드래그 메모 + 형광펜.
// codex_memo.py 가 디버그 포트(CDP)로 주입한다. 메모 저장은 __codexMemoBridge 바인딩으로 Python 에 넘긴다.
(() => {
  const VERSION = 12;
  if (window.__codexMemo) {
    if (window.__codexMemo.version === VERSION) return;
    const previous = window.__codexMemo;
    // Older popup versions cannot refuse destruction. Keep an open editor
    // intact until it closes; newer versions ask before discarding edits.
    const oldPopup = /** @type {HTMLElement | null} */ (document.querySelector("#cxm-root .cxm-pop"));
    if (previous.version < 11 && oldPopup?.style.display === "block") return;
    try { previous.destroy(); } catch (e) { /* 정리 기능이 없는 예전 버전 */ }
    if (window.__codexMemo === previous) return;
  }
  const cleanups = [];
  const on = (target, type, fn, opt) => {
    target.addEventListener(type, fn, opt);
    cleanups.push(() => target.removeEventListener(type, fn, opt));
  };

  const HL_NAME = "codex-memo";
  /** @type {Memo[]} */
  let memos = [];
  let marks = [];            // [{ range, id }] 현재 칠해진 범위
  let pending = null;        // 버튼을 누를 때 쓸 선택 정보 { quote, rect, range }
  let draft = null;          // 작성 중인 새 메모의 위치 정보 { exact, prefix, suffix, conv, title }
  const CONTEXT = 32;        // 앞뒤 문맥으로 저장할 글자 수
  // Codex 화면 구조 (Codex Labels 단어장과 같은 기준)
  const TARGET = "[data-selected-text-overlay-target]";                 // 대화 본문
  const TOOLBAR = 'div[role="presentation"].pointer-events-auto';       // Codex 선택 툴바
  const tbButtons = new Set();                                          // 툴바에 넣은 [메모] 버튼
  const VOCAB_BUTTON = ".cdx-vocabulary-action";                        // 단어장·메모 통합 버튼
  const subscribers = new Set();                                        // 메모 목록이 바뀌면 알릴 곳(단어장 창)
  let vocabDraft = null;                                                // 단어장 버튼을 누를 때 잡아 둔 선택 위치
  let ui = null;
  let originalNote = "", blockedOutsideClick = false;
  let observer = null;
  let textIndex = null;  // 본문이 바뀌기 전까지 선택 위치·형광펜이 같은 색인을 사용한다
  const deferred = new Set();
  const defer = (fn, ms) => {
    const timer = setTimeout(() => { deferred.delete(timer); fn(); }, ms);
    deferred.add(timer);
  };

  /** @param {BridgeMessage} msg */
  const send = (msg) => {
    try { window.__codexMemoBridge(JSON.stringify(msg)); return true; }
    catch (e) { console.warn("[codex-memo] bridge", e); return false; }
  };
  const norm = (s) => s.replace(/\s+/g, " ").trim();

  // ------------------------------------------------------------ 지금 열린 대화
  // Codex 는 주소에 대화 ID 가 없어서, 왼쪽 목록에서 선택된 대화의 ID 를 쓴다.
  // 같은 앱의 ChatGPT 채팅(/c/<id>)은 왼쪽 목록에 대화 ID 가 없어 앱 라우터에서 읽고 'chat:<id>' 로 적는다.
  function currentThread() {
    const chat = /** @type {any} */ (window).__cxmThreads?.currentChat?.();
    if (chat) return { conv: "chat:" + chat, title: document.title };
    const row = document.querySelector('[data-app-action-sidebar-thread-selected="true"]');
    if (row) {
      return {
        conv: (row.getAttribute("data-app-action-sidebar-thread-id") || "").replace(/^[a-z]+:/, ""),
        title: row.getAttribute("data-app-action-sidebar-thread-title") || document.title,
      };
    }
    return { conv: "title:" + document.title, title: document.title };
  }

  // ------------------------------------------------------------ 스타일
  const CSS_TEXT = `
    ::highlight(${HL_NAME}) { background-color: rgba(255, 212, 59, 0.38); }
    #cxm-root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
      font-family: "Pretendard", "Malgun Gothic", system-ui, sans-serif; }
    #cxm-root .cxm-btn { position: fixed; pointer-events: auto; display: none;
      background: #3b5bdb; color: #fff; border: 0; border-radius: 8px; padding: 5px 11px;
      font-family: inherit; font-size: 12px; font-weight: 600; line-height: 1.4; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.35); }
    #cxm-root .cxm-btn:hover { background: #2f4ac0; }
    /* 단어장·메모 모드일 때 단어장 툴바 버튼용 스타일(구분선·여백)이 섞이지 않게 */
    #cxm-root .cxm-btn.cdx-vocabulary-action { padding: 5px 11px !important; margin: 0; }
    #cxm-root .cxm-btn.cdx-vocabulary-action::before { display: none; }
    #cxm-root .cxm-pop { position: fixed; pointer-events: auto; display: none; width: 340px;
      box-sizing: border-box; background: #232323; color: #ececec; border: 1px solid #3a3a3a;
      border-radius: 12px; padding: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.45);
      font-size: 13px; line-height: 1.5; }
    #cxm-root .cxm-meta { color: #8a8a8a; font-size: 11px; margin-bottom: 6px; }
    #cxm-root .cxm-quote { border-left: 3px solid #ffd43b; padding: 2px 8px; margin: 0 0 10px;
      color: #bdbdbd; font-size: 12px; max-height: 96px; overflow: auto; white-space: pre-wrap; }
    #cxm-root textarea { display: block; width: 100%; box-sizing: border-box; min-height: 96px;
      background: #191919; color: #ececec; border: 1px solid #444; border-radius: 8px;
      padding: 8px; font-family: inherit; font-size: 13px; line-height: 1.5; resize: vertical; outline: none; }
    #cxm-root textarea:focus { border-color: #5c7cfa; }
    #cxm-root .cxm-row { display: flex; gap: 6px; align-items: center; margin-top: 10px; }
    #cxm-root .cxm-hint { margin-right: auto; color: #6f6f6f; font-size: 11px; }
    #cxm-root .cxm-row button { border: 1px solid #444; background: #2c2c2c; color: #ddd;
      border-radius: 7px; padding: 4px 12px; font-family: inherit; font-size: 12px; cursor: pointer; }
    #cxm-root .cxm-row button.cxm-save { background: #3b5bdb; border-color: #3b5bdb; color: #fff; }
    #cxm-root .cxm-row button.cxm-del { color: #ff8787; }
  `;

  function installStyle() {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS_TEXT);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    cleanups.push(() => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet);
    });
  }

  // ------------------------------------------------------------ UI
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function buildUI() {
    const root = el("div");
    root.id = "cxm-root";
    const btn = el("button", "cxm-btn", "📝 메모");
    const pop = el("div", "cxm-pop");
    const meta = el("div", "cxm-meta");
    const quote = el("div", "cxm-quote");
    const note = el("textarea");
    note.placeholder = "메모를 입력하세요";
    const row = el("div", "cxm-row");
    const hint = el("span", "cxm-hint", "Ctrl+Enter 저장 · Esc 닫기");
    const del = el("button", "cxm-del", "삭제");
    const cancel = el("button", "", "취소");
    const save = el("button", "cxm-save", "저장");
    row.append(hint, del, cancel, save);
    pop.append(meta, quote, note, row);
    root.append(btn, pop);

    // 버튼을 눌러도 선택이 풀리지 않게
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => openNew());
    cancel.addEventListener("click", closePop);
    save.addEventListener("click", submit);
    // 확인 창 대신 두 번 눌러 삭제
    del.addEventListener("click", () => {
      if (!pop.dataset.id) return;
      if (del.dataset.armed) {
        if (send({ op: "delete", id: pop.dataset.id })) hidePop();
      } else {
        del.dataset.armed = "1";
        del.textContent = "한 번 더 누르면 삭제";
      }
    });
    // Codex 의 단축키가 메모 입력을 가로채지 않도록 이벤트를 여기서 끊는다
    for (const type of ["keydown", "keyup", "keypress", "input", "paste", "copy", "cut"]) {
      pop.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type !== "keydown") return;
        if (e.key === "Escape") { e.preventDefault(); closePop(); }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      });
    }
    ui = { root, btn, pop, meta, quote, note, del };
    mount();
  }

  function mount() {
    if (ui && !ui.root.isConnected) document.documentElement.appendChild(ui.root);
  }

  function place(node, x, y) {
    node.style.left = "0px"; node.style.top = "0px";
    const w = node.offsetWidth, h = node.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    node.style.left = Math.max(8, Math.min(x, vw - w - 8)) + "px";
    node.style.top = (y + h + 8 > vh ? Math.max(8, vh - h - 8) : y) + "px";
  }

  function hideBtn() { if (ui) ui.btn.style.display = "none"; }

  function openPop(x, y, { quote, note = "", id = "", created = "" }, anchor = null) {
    if (!closePop()) return false;
    draft = anchor;
    hideBtn();
    ui.pop.dataset.id = id;
    ui.pop.dataset.quote = quote;
    ui.meta.textContent = id ? `메모 · ${created}` : "새 메모";
    ui.quote.textContent = quote;
    ui.quote.style.display = quote ? "" : "none";
    ui.note.value = note;
    originalNote = note;
    ui.del.style.display = id ? "" : "none";
    delete ui.del.dataset.armed;
    ui.del.textContent = "삭제";
    ui.pop.style.display = "block";
    place(ui.pop, x, y);
    ui.note.focus();
    return true;
  }

  function hidePop() {
    if (ui) ui.pop.style.display = "none";
  }

  function closePop() {
    if (ui?.pop.style.display === "block" && ui.note.value !== originalNote) {
      const { selectionStart, selectionEnd, selectionDirection } = ui.note;
      if (!window.confirm("저장하지 않은 메모 수정 내용을 버리고 닫을까요?")) {
        ui.note.focus();
        ui.note.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
        return false;
      }
    }
    hidePop();
    return true;
  }

  function submit() {
    if (ui.pop.style.display !== "block") return;
    const note = ui.note.value.trim();
    const id = ui.pop.dataset.id;
    const quote = ui.pop.dataset.quote || "";
    if (id) { if (!send({ op: "update", id, note })) return; }
    else if (note || quote) { if (!send({ op: "add", quote, note, ...(draft || {}) })) return; }
    hidePop();
  }

  function openNew() {
    if (!pending) return;
    const { quote, rect, range } = pending;
    const anchor = { ...anchorOf(range), ...currentThread() };
    if (openPop(rect.left, rect.bottom + 8, { quote }, anchor)) window.getSelection()?.removeAllRanges();
  }

  // ------------------------------------------------------------ 드래그 감지
  function inOurUI(node) {
    return ui && node && ui.root.contains(node.nodeType === 1 ? node : node.parentNode);
  }

  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const quote = sel.toString().trim();
    if (!quote) return null;
    const range = sel.getRangeAt(0);
    if (inOurUI(range.commonAncestorContainer)) return null;
    const el = (n) => (n.nodeType === 1 ? n : n.parentElement);
    if (!el(range.startContainer)?.closest(TARGET) || !el(range.endContainer)?.closest(TARGET)) return null;
    const host = el(range.commonAncestorContainer);
    if (host && host.closest("textarea, input, [contenteditable='true'], .ProseMirror")) return null;
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    return { quote, rect, range: range.cloneRange() };
  }

  // Codex 선택 툴바의 [채팅에 추가] 옆(단어장이 있으면 그 뒤)에 [메모] 버튼을 넣는다
  function addToolbar(toolbar) {
    if (!toolbar.matches(TOOLBAR)) return;
    if (toolbar.querySelector(VOCAB_BUTTON)) {
      toolbar.querySelectorAll(".cxm-toolbar-action").forEach((b) => { b.remove(); tbButtons.delete(b); });
      return;
    }
    if (!pending || toolbar.querySelector(".cxm-toolbar-action")) return;
    const native = [...toolbar.querySelectorAll("button")]
      .find((b) => ["채팅에 추가", "Add to chat"].includes(b.textContent.trim()));
    if (!native || !toolbar.getClientRects().length) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = native.className + " cxm-toolbar-action";
    b.textContent = "메모";
    b.title = "선택한 글에 메모 남기기";
    (toolbar.querySelector(".cdx-vocabulary-action") || native).insertAdjacentElement("afterend", b);
    tbButtons.add(b);
    hideBtn();
  }

  function scanToolbar(node) {
    if (!(node instanceof Element) || inOurUI(node)) return;
    if (node.matches(TOOLBAR)) addToolbar(node);
    const parent = node.closest(TOOLBAR);
    if (parent) addToolbar(parent);
    node.querySelectorAll(TOOLBAR).forEach(addToolbar);
  }

  // 툴바에 [메모] 또는 [단어장·메모] 버튼이 들어가 있으면 떠 있는 버튼은 필요 없다
  const hasToolbarButton = () => [...tbButtons].some((b) => b.isConnected)
    || !!document.querySelector(`${TOOLBAR} ${VOCAB_BUTTON}`);

  let selTimer = null;
  function onSelectionChange() {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      pending = selectionInfo();
      for (const b of tbButtons) if (!pending || !b.isConnected) { b.remove(); tbButtons.delete(b); }
      if (pending) document.querySelectorAll(TOOLBAR).forEach(addToolbar);
    }, 30);
  }

  function grabForVocabulary(e) {
    if (!(e.target instanceof Element) || !e.target.closest(VOCAB_BUTTON)) return;
    const info = selectionInfo();
    if (info) vocabDraft = { quote: info.quote, ...anchorOf(info.range), ...currentThread() };
  }

  function toolbarEvent(e) {
    if (!(e.target instanceof Element) || !e.target.closest(".cxm-toolbar-action")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === "click") { pending = selectionInfo() || pending; openNew(); }
  }

  // 단어장이 받는 길이(160자) 이하면 떠 있는 버튼도 [단어장·메모]로 동작한다.
  // 단어장 화면 코드는 .cdx-vocabulary-action 버튼을 누르면 어디서든 창을 연다.
  const VOCAB_MAX = 160;
  const vocabReady = () => !!window.__codexVocabularyInstalled && !!window.__cxmVocabHooks;

  function onMouseUp(e) {
    if (e.button !== 0 || inOurUI(e.target)) return;
    // Codex 툴바가 안 뜨는 화면(예: Your dot)이나 툴바 구조가 바뀐 경우에 떠 있는 버튼을 보여준다
    defer(() => {
      const info = selectionInfo();
      if (!info || hasToolbarButton()) return;
      pending = info;
      const vocab = vocabReady() && info.quote.length <= VOCAB_MAX;
      ui.btn.textContent = vocab ? "📝 단어장·메모" : "📝 메모";
      ui.btn.classList.toggle("cdx-vocabulary-action", vocab);
      ui.btn.style.display = "block";
      place(ui.btn, info.rect.right + 6, info.rect.bottom + 6);
    }, 400);
  }

  // 떠 있는 [단어장·메모]를 누르면 단어장이 창을 열고 선택을 지우므로 버튼도 숨긴다
  function hideAfterVocabClick(e) {
    if (e.target instanceof Element && e.target.closest("#cxm-root .cxm-btn.cdx-vocabulary-action")) defer(hideBtn, 0);
  }

  function onMouseDown(e) {
    blockedOutsideClick = false;
    if (inOurUI(e.target)) return;
    hideBtn();
    if (!closePop()) {
      blockedOutsideClick = true;
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }

  function onOutsideClick(e) {
    if (!blockedOutsideClick) return;
    blockedOutsideClick = false;
    if (inOurUI(e.target)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    ui.note.focus();
  }

  /** 화면 좌표의 글자 위치 (텍스트 노드, 위치) */
  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    const r = document.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }

  /** 범위의 글자 상자 중 (x, y)를 덮는 것 — 줄 끝 빈 공간 등 글자 밖을 걸러낸다 */
  function rectAt(range, x, y) {
    for (const r of range.getClientRects()) {
      if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return r;
    }
    return null;
  }

  /** (x, y) 글자 위에 칠해진 메모들과 그 글자 상자 */
  function memosAt(x, y) {
    const p = marks.length ? caretAt(x, y) : null;
    if (!p) return { memos: [], rect: null };
    let rect = null;
    const ids = new Set();
    for (const { range, id } of marks) {
      try {
        if (range.collapsed || !range.isPointInRange(p.node, p.offset)) continue;
      } catch { continue; }
      const r = rectAt(range, x, y);
      if (r) { ids.add(id); rect = rect || r; }
    }
    return { memos: memos.filter((m) => ids.has(m.id)), rect };
  }

  // 칠해진 문장을 클릭하면 그 메모 열기 (드래그가 아닐 때만)
  function onClick(e) {
    if (e.button !== 0 || inOurUI(e.target) || !marks.length) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const memo = memosAt(e.clientX, e.clientY).memos[0];
    if (memo) openPop(e.clientX, e.clientY + 14, memo);
  }

  // ------------------------------------------------------------ 형광펜
  // 대화 본문만 훑는다 (왼쪽 목록·메뉴 제외 → 빠르고, 짧은 메모가 엉뚱한 곳에 칠해지지 않음).
  // Codex 구조가 바뀌어 본문 표식이 없으면 화면 전체로 대신한다.
  function indexRoots() {
    const roots = [...document.querySelectorAll(TARGET)].filter((e) => !e.parentElement?.closest(TARGET));
    return roots.length ? roots : [document.body];
  }

  const INDEX_IGNORE = `script, style, noscript, textarea, #cxm-root, #cdx-vocabulary, ${TOOLBAR}`;
  const SKIP = { acceptNode: (n) => (!n.parentElement || n.parentElement.closest(INDEX_IGNORE)
    ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) };
  // 줄이거나 바꿔야 하는 공백(줄바꿈·탭·nbsp·연속 공백)이 있는 글자인지
  const COLLAPSE = /[\n\t\r ]| {2}/;
  const isSpace = (c) => c === " " || c === "\n" || c === "\t" || c === "\r" || c === " ";

  // 본문 글자를 공백을 하나로 줄여 이어 붙이고, 글자마다 원래 (텍스트 노드, 위치)를 기억한다
  function buildIndex() {
    // 선택 직전에 본문이 동기적으로 바뀌어도 이전 위치를 재사용하지 않는다.
    if (observer) processMutations(observer.takeRecords());
    if (textIndex) return textIndex;
    // 답변이 스트리밍되는 동안 자주 다시 만든다 → 글자 위치는 숫자 배열(Int32Array)에, 글자는 노드 단위로 이어 붙인다
    /** @type {Text[]} */
    const nodes = [];
    for (const root of indexRoots()) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, SKIP);
      let n;
      while ((n = walker.nextNode())) nodes.push(/** @type {Text} */ (n));
    }
    let total = 0;
    for (const n of nodes) total += n.data.length;
    const idxN = new Int32Array(total), idxO = new Int32Array(total), parts = [];
    let k = 0, prevSpace = true;
    for (let ni = 0; ni < nodes.length; ni++) {
      const t = nodes[ni].data;
      // 대부분의 노드: 줄여야 할 공백이 없으면 글자를 그대로 쓰고 위치만 채운다
      if (t && !(prevSpace && t[0] === " ") && !COLLAPSE.test(t)) {
        for (let i = 0; i < t.length; i++) { idxN[k] = ni; idxO[k] = i; k++; }
        parts.push(t); prevSpace = t[t.length - 1] === " ";
        continue;
      }
      let piece = "";
      for (let i = 0; i < t.length; i++) {
        let c = t[i];
        if (isSpace(c)) {
          if (prevSpace) continue;
          c = " "; prevSpace = true;
        } else prevSpace = false;
        piece += c; idxN[k] = ni; idxO[k] = i; k++;
      }
      if (piece) parts.push(piece);
    }
    return (textIndex = { text: parts.join(""), nodes, idxN: idxN.subarray(0, k), idxO: idxO.subarray(0, k) });
  }

  function processMutations(list) {
    if (!list.length) return;
    if (pending) for (const m of list) for (const node of m.addedNodes) scanToolbar(node);
    const hasTargets = !!document.querySelector(TARGET);
    const textChanged = list.some((m) => {
      const target = m.target instanceof Element ? m.target : m.target.parentElement;
      if (target?.closest(INDEX_IGNORE)) return false;
      if (m.type === "attributes") return m.attributeName === "data-selected-text-overlay-target";
      if (!hasTargets || target?.closest(TARGET)) return true;
      return [...m.addedNodes, ...m.removedNodes].some((n) => n instanceof Element
        && (n.matches(TARGET) || !!n.querySelector(TARGET)));
    });
    if (textChanged) textIndex = null;
    if (textChanged || list.some((m) => m.type === "attributes")) scheduleHighlights();
  }

  // 화면 글자 목록에서 (node, offset) 지점이 몇 번째 글자인지 (이진 탐색)
  function indexOfPoint(idx, node, offset) {
    const probe = document.createRange();
    probe.setStart(node, offset);
    let lo = 0, hi = idx.idxN.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (probe.comparePoint(idx.nodes[idx.idxN[mid]], idx.idxO[mid]) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // 선택 영역 → { exact, prefix, suffix } (W3C TextQuoteSelector 와 같은 방식)
  function anchorOf(range) {
    try {
      const idx = buildIndex();
      let a = indexOfPoint(idx, range.startContainer, range.startOffset);
      let b = indexOfPoint(idx, range.endContainer, range.endOffset);
      while (a < b && idx.text[a] === " ") a++;
      while (b > a && idx.text[b - 1] === " ") b--;
      if (b <= a) return {};
      return {
        exact: idx.text.slice(a, b),
        prefix: idx.text.slice(Math.max(0, a - CONTEXT), a),
        suffix: idx.text.slice(b, b + CONTEXT),
      };
    } catch (e) {
      console.warn("[codex-memo] anchor", e);
      return {};
    }
  }

  function sameTail(a, b) {  // a 의 끝과 b 의 끝이 몇 글자 같은지
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }

  function sameHead(a, b) {  // a 의 앞과 b 의 앞이 몇 글자 같은지
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  // 같은 글이 여러 곳에 있으면 앞뒤 문맥이 가장 잘 맞는 한 곳만 고른다
  function locate(text, m) {
    let best = -1, bestScore = -1, i = -1, count = 0;
    while ((i = text.indexOf(m.exact, i + 1)) !== -1 && count++ < 200) {
      const end = i + m.exact.length;
      const score = sameTail(text.slice(Math.max(0, i - CONTEXT), i), m.prefix || "")
                  + sameHead(text.slice(end, end + CONTEXT), m.suffix || "");
      if (score > bestScore) { best = i; bestScore = score; }
    }
    return best;
  }

  function segments(list) {
    const out = [];
    for (const m of list) {
      for (let line of (m.quote || "").split("\n")) {
        line = norm(line).replace(/^[-*•]\s+/, "");
        if (line.length >= 2) out.push({ seg: line, id: m.id });
      }
    }
    return out;
  }

  function computeHighlights() {
    if (!document.body || !window.CSS?.highlights) return;
    const { conv } = currentThread();
    // 다른 대화에서 쓴 메모는 칠하지 않는다 (대화 정보가 없는 예전 메모는 어디서나)
    const here = memos.filter((m) => !m.conv || m.conv === conv);
    const anchored = here.filter((m) => m.exact);
    const segs = segments(here.filter((m) => !m.exact));  // 예전 메모: 인용문으로만 찾기
    marks = [];
    if (anchored.length || segs.length) {
      const { text, nodes, idxN, idxO } = buildIndex();
      const mark = (i, len, id) => {
        const j = i + len - 1;
        const r = new Range();
        r.setStart(nodes[idxN[i]], idxO[i]);
        r.setEnd(nodes[idxN[j]], idxO[j] + 1);
        marks.push({ range: r, id });
      };
      for (const m of anchored) {
        const i = locate(text, m);
        if (i >= 0) mark(i, m.exact.length, m.id);
      }
      for (const { seg, id } of segs) {
        let from = 0, count = 0, i;
        while ((i = text.indexOf(seg, from)) !== -1 && count++ < 50) {
          mark(i, seg.length, id);
          from = i + seg.length;
        }
      }
    }
    CSS.highlights.set(HL_NAME, new Highlight(...marks.map((m) => m.range)));
  }

  // 대화가 바뀌거나 답변이 스트리밍되면 다시 찾는다 (너무 자주 돌지 않게 묶음)
  let hlTimer = null, lastRun = 0;
  function scheduleHighlights() {
    if (hlTimer) return;
    const wait = Math.max(150, 500 - (Date.now() - lastRun));
    hlTimer = setTimeout(() => {
      hlTimer = null; lastRun = Date.now();
      mount();
      try { computeHighlights(); } catch (e) { console.warn("[codex-memo] highlight", e); }
    }, wait);
  }

  // ------------------------------------------------------------ 시작
  function start() {
    installStyle();
    buildUI();
    on(document, "mouseup", onMouseUp, true);
    on(document, "mousedown", onMouseDown, true);
    on(window, "click", onOutsideClick, true);
    on(document, "click", onClick, false);
    for (const type of ["pointerdown", "mousedown", "click"]) on(document, type, toolbarEvent, true);
    on(window, "pointerdown", grabForVocabulary, true);
    on(window, "click", hideAfterVocabClick, true);
    on(document, "selectionchange", onSelectionChange, false);
    on(document, "keydown", (e) => { if (e.key === "Escape") hideBtn(); }, true);
    on(window, "scroll", hideBtn, true);
    observer = new MutationObserver(processMutations);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["data-selected-text-overlay-target",
        "data-app-action-sidebar-thread-selected", "data-app-action-sidebar-thread-id"] });
    cleanups.push(() => { observer.disconnect(); observer = null; textIndex = null; });
    cleanups.push(() => ui.root.remove());
    cleanups.push(() => CSS.highlights.delete(HL_NAME));
    cleanups.push(() => clearTimeout(hlTimer));
    cleanups.push(() => { deferred.forEach(clearTimeout); deferred.clear(); });
    cleanups.push(() => { clearTimeout(selTimer); tbButtons.forEach((b) => b.remove()); tbButtons.clear(); });
    send({ op: "hello" });
  }

  /** @type {CodexMemoApi} */
  window.__codexMemo = {
    version: VERSION,
    destroy() {
      if (!closePop()) return;
      cleanups.splice(0).reverse().forEach((f) => { try { f(); } catch (e) {} });
      delete window.__codexMemo;
    },
    setMemos(list) {
      memos = list || [];
      scheduleHighlights();
      for (const fn of subscribers) { try { fn(memos); } catch (e) { console.warn("[codex-memo]", e); } }
    },
    list: () => memos.slice(),
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    takeVocabDraft() { const d = vocabDraft; vocabDraft = null; return d; },
    memosAt,
    add(draft, note) { send({ op: "add", ...(draft || {}), note }); },
    update(id, note, category) { send({ op: "update", id, note, category }); },
    remove(id) { send({ op: "delete", id }); },
    get count() { return memos.length; },
    get marks() { return marks.length; },
    /** 메모 위치로 이동: 지금 화면에서 그 메모가 칠해진 첫 범위 (없으면 null) */
    rangeOf(id) { return marks.find((m) => m.id === id && !m.range.collapsed)?.range || null; },
    /** 테스트용: 본문 색인 (글자, 글자마다 노드 번호·위치) */
    indexDump() { const x = buildIndex(); return { text: x.text, n: Array.from(x.idxN), o: Array.from(x.idxO), nodes: x.nodes.length }; },
    bench(times = 20) {  // 형광펜 다시 계산 1회 평균 시간(ms)
      const t0 = performance.now();
      for (let i = 0; i < times; i++) computeHighlights();
      return +((performance.now() - t0) / times).toFixed(2);
    },
  };

  if (document.body) start();
  else on(document, "DOMContentLoaded", start, { once: true });
})();
