// @ts-check
// 필터 관리 창: 왼쪽 목록 필터(sidebar-filter.js)의 진행 상태·카테고리를 한 화면에서 고르고, 필터를 저장·관리한다.
// 막대의 '필터' 버튼으로 연다. 고르는 즉시 왼쪽 목록에 반영된다.
(() => {
  const VERSION = 2;
  const w = /** @type {any} */ (window);
  if (w.__cxmFilterWindow?.version === VERSION) return;
  try { w.__cxmFilterWindow?.destroy(); } catch { /* 예전 버전 */ }

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .cxm-fw-overlay { position: fixed; inset: 0; z-index: 2147483000; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
    .cxm-fw { width: min(620px, calc(100vw - 32px)); max-height: min(720px, calc(100vh - 40px)); display: flex; flex-direction: column;
      background: var(--color-token-bg-primary, #1f1f1f); color: var(--color-token-text-primary, #e5e5e5);
      border: 1px solid var(--color-token-border-default, rgba(127,127,127,.35)); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.5);
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .cxm-fw button, .cxm-fw input { font: inherit; color: inherit; }
    .cxm-fw button { background: var(--color-token-bg-secondary, rgba(127,127,127,.14)); border: 1px solid var(--color-token-border-default, rgba(127,127,127,.3));
      border-radius: 6px; height: 26px; padding: 0 9px; cursor: pointer; white-space: nowrap; }
    .cxm-fw button:hover { background: rgba(127,127,127,.24); }
    .cxm-fw button.cxm-fw-primary { background: #2563eb; border-color: #2563eb; color: #fff; }
    .cxm-fw button.cxm-fw-danger:hover { background: rgba(239,68,68,.25); border-color: rgba(239,68,68,.6); }
    .cxm-fw button:disabled { opacity: .45; cursor: default; }
    .cxm-fw-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; border-bottom: 1px solid var(--color-token-border-default, rgba(127,127,127,.2)); }
    .cxm-fw-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
    .cxm-fw-count { opacity: .7; font-variant-numeric: tabular-nums; }
    .cxm-fw-head .cxm-fw-x { margin-left: auto; width: 28px; padding: 0; font-size: 16px; }
    .cxm-fw-body { overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 14px; }
    .cxm-fw-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 520px) { .cxm-fw-cols { grid-template-columns: 1fr; } }
    .cxm-fw-col h3, .cxm-fw-presets h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; opacity: .8; display: flex; align-items: center; gap: 6px; }
    .cxm-fw-col h3 span { font-weight: 400; opacity: .8; }
    .cxm-fw-item { display: flex; align-items: center; gap: 7px; padding: 4px 6px; border-radius: 6px; cursor: pointer; min-height: 28px; }
    .cxm-fw-item:hover { background: rgba(127,127,127,.13); }
    .cxm-fw-item input { margin: 0; width: 15px; height: 15px; accent-color: #3b82f6; cursor: pointer; flex: 0 0 auto; }
    .cxm-fw-dot { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 3px; box-sizing: border-box; }
    .cxm-fw-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cxm-fw-n { opacity: .55; font-size: 11px; font-variant-numeric: tabular-nums; }
    .cxm-fw-state { font-size: 10px; padding: 0 6px; border-radius: 4px; line-height: 17px; flex: 0 0 auto; }
    .cxm-fw-item:not(.cxm-off) .cxm-fw-state { color: #86efac; background: rgba(34,197,94,.14); }
    .cxm-fw-item.cxm-off { background: rgba(239,68,68,.08); }
    .cxm-fw-item.cxm-off .cxm-fw-name { text-decoration: line-through; opacity: .5; }
    .cxm-fw-item.cxm-off .cxm-fw-dot { opacity: .3; }
    .cxm-fw-item.cxm-off .cxm-fw-state { color: #fca5a5; background: rgba(239,68,68,.16); }
    .cxm-fw .cxm-fw-item .cxm-fw-only { height: 20px; padding: 0 6px; font-size: 11px; display: none; }
    .cxm-fw-item:hover .cxm-fw-only { display: inline-block; }
    .cxm-fw-item:hover .cxm-fw-state { display: none; }
    .cxm-fw-colfoot { display: flex; gap: 6px; margin-top: 6px; }
    .cxm-fw-colfoot button { flex: 1; }
    .cxm-fw-presets { border-top: 1px solid var(--color-token-border-default, rgba(127,127,127,.2)); padding-top: 12px; }
    .cxm-fw-preset { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; }
    .cxm-fw-preset:hover { background: rgba(127,127,127,.1); }
    .cxm-fw-preset.cxm-active { background: rgba(37,99,235,.16); }
    .cxm-fw-preset .cxm-fw-pname { flex: 1; min-width: 0; text-align: left; border: 0; background: none; padding: 0; height: auto; overflow: hidden; text-overflow: ellipsis; }
    .cxm-fw-preset .cxm-fw-pname:hover { background: none; text-decoration: underline; }
    .cxm-fw-psum { opacity: .55; font-size: 11px; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cxm-fw-tag { font-size: 10px; padding: 0 6px; border-radius: 4px; line-height: 17px; color: #93c5fd; background: rgba(37,99,235,.2); }
    .cxm-fw-empty { opacity: .55; font-size: 12px; padding: 4px 6px; }
    .cxm-fw-save { display: flex; gap: 6px; margin-top: 8px; }
    .cxm-fw-save input, .cxm-fw-preset input { flex: 1; min-width: 0; height: 26px; padding: 0 8px; border-radius: 6px;
      background: var(--color-token-bg-secondary, rgba(127,127,127,.1)); border: 1px solid var(--color-token-border-default, rgba(127,127,127,.35)); }
    .cxm-fw-msg { font-size: 12px; min-height: 18px; color: #fb923c; }
    .cxm-fw-foot { display: flex; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid var(--color-token-border-default, rgba(127,127,127,.2)); }
    .cxm-fw-foot .cxm-fw-close { margin-left: auto; }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  const el = /** @type {(tag: string, cls?: string, text?: string) => HTMLElement} */ (w.__cxm?.el
    || ((tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }));
  /** @type {(text: string, cls?: string, title?: string) => HTMLButtonElement} */
  const btn = (text, cls = "", title = "") => { const b = /** @type {HTMLButtonElement} */ (el("button", cls, text)); b.type = "button"; if (title) b.title = title; return b; };

  /** @type {HTMLElement | null} */
  let overlay = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  /** @type {Element | null} */
  let returnFocus = null;
  /** 이름을 고치는 중인 저장한 필터 */
  let renaming = "";

  const filterApi = () => w.__cxmSidebarFilter;

  /** @param {{status: string[], category: string[]}} f */
  function describe(f) {
    const fa = filterApi();
    /** @type {string[]} */
    const parts = [];
    for (const [kind, title] of /** @type {const} */ ([["status", "진행 상태"], ["category", "카테고리"]])) {
      if (!f[kind].length) continue;
      const vals = fa.values(kind), names = new Map(vals.map((/** @type {any} */ v) => [v.value, v.name]));
      const shown = vals.filter((/** @type {any} */ v) => !f[kind].includes(v.value));
      parts.push(shown.length === 1 ? `${title} ${shown[0].name}만` : `${title} ${f[kind].map((v) => names.get(v) || v).join("·")} 제외`);
    }
    return parts.join(", ") || "모두 보기";
  }

  let renderSig = "";
  /** @param {boolean} [force] */
  function render(force = false) {
    if (!overlay) return;
    const fa = filterApi();
    if (!fa) { close(); return; }
    const { filter } = fa.state(), counts = fa.counts();
    // 목록이 자주 다시 그려지므로 바뀐 것이 있을 때만 그린다(이름 고치는 중 입력이 끊기지 않게)
    const sig = JSON.stringify([filter, counts, fa.presets(), fa.values("status"), fa.values("category"), renaming]);
    if (!force && sig === renderSig) return;
    renderSig = sig;
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const focusKey = active?.closest?.(".cxm-fw") ? `${active.closest("[data-kind]")?.getAttribute("data-kind") || ""}|${active.dataset?.value || ""}` : "";
    const box = /** @type {HTMLElement} */ (overlay.querySelector(".cxm-fw"));
    /** @type {HTMLElement} */ (box.querySelector(".cxm-fw-count")).textContent =
      filter.status.length || filter.category.length ? `왼쪽 목록 ${counts.shown} / ${counts.total}개 표시` : `왼쪽 목록 ${counts.total}개 모두 표시`;

    // 진행 상태 · 카테고리
    const cols = /** @type {HTMLElement} */ (box.querySelector(".cxm-fw-cols"));
    cols.replaceChildren(...(/** @type {const} */ ([["status", "진행 상태"], ["category", "카테고리"]])).map(([kind, title]) => {
      const col = el("section", "cxm-fw-col");
      col.dataset.kind = kind;
      const vals = fa.values(kind), hidden = filter[kind];
      const h = el("h3", "", title);
      h.append(el("span", "", hidden.length ? `${vals.length - hidden.length}/${vals.length} 보임` : "전체 보임"));
      const list = el("div");
      list.setAttribute("role", "group"); list.setAttribute("aria-label", `${title} 거르기`);
      for (const v of vals) {
        const off = hidden.includes(v.value);
        const row = el("label", "cxm-fw-item" + (off ? " cxm-off" : ""));
        row.title = off ? `${v.name}: 숨김 (체크하면 보임)` : `${v.name}: 보임 (체크를 끄면 숨김)`;
        const input = /** @type {HTMLInputElement} */ (el("input")); input.type = "checkbox"; input.checked = !off; input.dataset.value = v.value;
        input.addEventListener("change", () => fa.setHidden(kind, input.checked ? hidden.filter((/** @type {string} */ x) => x !== v.value) : [...hidden, v.value]));
        const dot = el("i", "cxm-fw-dot"); dot.style.background = v.color || "transparent";
        if (!v.color) dot.style.border = "1px dashed currentColor";
        const only = btn("이것만", "cxm-fw-only", `${v.name}만 보기`);
        only.addEventListener("click", (e) => { e.preventDefault(); fa.setHidden(kind, vals.filter((/** @type {any} */ x) => x.value !== v.value).map((/** @type {any} */ x) => x.value)); });
        row.append(input, dot, el("span", "cxm-fw-name", v.name), el("span", "cxm-fw-n", String(counts[kind][v.value] || 0)), el("em", "cxm-fw-state", off ? "숨김" : "보임"), only);
        list.append(row);
      }
      const foot = el("div", "cxm-fw-colfoot");
      const all = btn("모두 보기"), none = btn("모두 숨기기"), flip = btn("반전", "", "보이는 것과 숨긴 것을 서로 바꾸기");
      all.addEventListener("click", () => fa.setHidden(kind, []));
      none.addEventListener("click", () => fa.setHidden(kind, vals.map((/** @type {any} */ x) => x.value)));
      flip.addEventListener("click", () => fa.setHidden(kind, vals.map((/** @type {any} */ x) => x.value).filter((/** @type {string} */ v) => !hidden.includes(v))));
      foot.append(all, none, flip);
      col.append(h, list, foot);
      return col;
    }));
    // 체크한 칸에 포커스를 되돌린다(키보드로 이어서 고를 수 있게)
    const [focusKind, focusValue] = focusKey.split("|");
    if (focusKind && focusValue) /** @type {HTMLElement | null} */ (cols.querySelector(`[data-kind="${focusKind}"] input[data-value="${CSS.escape(focusValue)}"]`))?.focus();

    // 저장한 필터
    const plist = /** @type {HTMLElement} */ (box.querySelector(".cxm-fw-plist"));
    const presets = fa.presets();
    plist.replaceChildren(...(presets.length ? presets.map((/** @type {any} */ p) => {
      const row = el("div", "cxm-fw-preset" + (p.active ? " cxm-active" : ""));
      row.dataset.id = p.id;
      if (renaming === p.id) {
        const input = /** @type {HTMLInputElement} */ (el("input")); input.value = p.name; input.maxLength = 30; input.setAttribute("aria-label", "새 이름");
        const ok = btn("저장", "cxm-fw-primary"), cancel = btn("취소");
        const done = () => { try { fa.renamePreset(p.id, input.value); renaming = ""; say(""); render(true); } catch (e) { say(/** @type {any} */ (e).message); } };
        ok.addEventListener("click", done);
        cancel.addEventListener("click", () => { renaming = ""; render(true); });
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(); if (e.key === "Escape") { e.stopPropagation(); renaming = ""; render(true); } });
        row.append(input, ok, cancel);
        queueMicrotask(() => { input.focus(); input.select(); });
        return row;
      }
      const name = btn(p.name, "cxm-fw-pname", "이 필터 쓰기");
      name.addEventListener("click", () => fa.applyPreset(p.id));
      row.append(name);
      if (p.active) row.append(el("span", "cxm-fw-tag", "사용 중"));
      row.append(el("span", "cxm-fw-psum", describe(p)));
      const over = btn("덮어쓰기", "", "지금 고른 필터로 바꾸기"), ren = btn("이름", "", "이름 바꾸기"), del = btn("삭제", "cxm-fw-danger");
      over.disabled = p.active;
      over.addEventListener("click", () => fa.overwritePreset(p.id));
      ren.addEventListener("click", () => { renaming = p.id; render(true); });
      del.addEventListener("click", () => fa.deletePreset(p.id));
      row.append(over, ren, del);
      return row;
    }) : [el("div", "cxm-fw-empty", "저장한 필터가 없습니다. 아래에 이름을 넣고 지금 필터를 저장하세요.")]));
  }

  /** @param {string} text */
  const say = (text) => { const m = overlay?.querySelector(".cxm-fw-msg"); if (m) m.textContent = text; };

  function open() {
    const fa = filterApi();
    if (!fa) return;
    if (overlay) { /** @type {HTMLElement | null} */ (overlay.querySelector(".cxm-fw-x"))?.focus(); return; }
    returnFocus = document.activeElement;
    overlay = el("div", "cxm-fw-overlay");
    const box = el("div", "cxm-fw");
    box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-labelledby", "cxm-fw-title");
    const head = el("div", "cxm-fw-head");
    const h = el("h2", "", "대화 필터"); h.id = "cxm-fw-title";
    const x = btn("×", "cxm-fw-x", "닫기 (Esc)"); x.setAttribute("aria-label", "닫기");
    head.append(h, el("span", "cxm-fw-count"), x);
    const body = el("div", "cxm-fw-body");
    const hint = el("div", "cxm-fw-n", "체크를 끄면 그 라벨의 대화가 왼쪽 목록에서 숨겨집니다. 숫자는 왼쪽 목록에 있는 대화 수입니다.");
    const presetsBox = el("section", "cxm-fw-presets");
    const save = el("div", "cxm-fw-save");
    const nameInput = /** @type {HTMLInputElement} */ (el("input")); nameInput.placeholder = "필터 이름 (예: 진행 중인 개발)"; nameInput.maxLength = 30;
    nameInput.setAttribute("aria-label", "저장할 필터 이름");
    const saveBtn = btn("지금 필터 저장", "cxm-fw-primary");
    const doSave = () => { try { filterApi().savePreset(nameInput.value); nameInput.value = ""; say(""); } catch (e) { say(/** @type {any} */ (e).message); } };
    saveBtn.addEventListener("click", doSave);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });
    save.append(nameInput, saveBtn);
    presetsBox.append(el("h3", "", "저장한 필터"), el("div", "cxm-fw-plist"), save, el("div", "cxm-fw-msg"));
    body.append(hint, el("div", "cxm-fw-cols"), presetsBox);
    const foot = el("div", "cxm-fw-foot");
    const clear = btn("필터 끄기 (모두 보기)"), closeBtn = btn("닫기", "cxm-fw-close");
    clear.addEventListener("click", () => filterApi().clear());
    foot.append(clear, closeBtn);
    box.append(head, body, foot);
    overlay.append(box);
    x.addEventListener("click", close);
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
    document.body.append(overlay);
    unsubscribe = fa.subscribe(() => render());
    render(true);
    x.focus();
  }

  function close() {
    if (!overlay) return;
    unsubscribe?.(); unsubscribe = null;
    overlay.remove(); overlay = null; renaming = ""; renderSig = "";
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
  }

  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (!overlay) return;
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); return; }
    // Tab 이 창 밖(Codex 화면)으로 나가지 않게
    if (e.key === "Tab") {
      const items = /** @type {HTMLElement[]} */ ([...overlay.querySelectorAll("button:not(:disabled), input")]);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  window.addEventListener("keydown", onKey, true);

  w.__cxmFilterWindow = {
    version: VERSION,
    open,
    close,
    isOpen: () => !!overlay,
    destroy() {
      close();
      window.removeEventListener("keydown", onKey, true);
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    },
  };
})();
