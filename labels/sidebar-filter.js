// @ts-check
// 왼쪽 대화 목록(일반 보기·활동 보기 모두) 위에 진행 상태·카테고리 필터를 붙인다.
// 필터는 '필터' 버튼으로 여는 필터 관리 창(filter-window.js)에서 고르고, 저장한 필터를 막대에서 바로 고를 수 있다.
// '수정'을 켜면 줄을 눌러 여러 대화를 고르고(Shift 로 범위), 진행 상태·카테고리를 한꺼번에 바꾸거나
// 프로젝트·섹션으로 옮긴다. 옮기기는 각 대화의 Codex 오른쪽 클릭 메뉴 항목(getItems → onSelect)을 그대로 실행한다.
(() => {
  const VERSION = 7;
  const w = /** @type {any} */ (window);
  if (w.__cxmSidebarFilter?.version === VERSION) return;
  try { w.__cxmSidebarFilter?.destroy(); } catch { /* 예전 버전 */ }
  const api = window.codexLabels;
  if (!api?.read || !api.onChanged || !api.assignMany || !w.__cxm) return;
  const actions = w.__cxmThreadActions;   // 없으면 옮기기만 빠진다

  const { ROW, kindOf, keyOf, rows: allRows, el } = w.__cxm;
  const STORE_KEY = "cxm-sidebar-filter";
  const PRESET_KEY = "cxm-sidebar-filter-presets";
  const cleanups = /** @type {(() => void)[]} */ ([]);
  /** @type {(t: EventTarget, type: string, fn: any, opt?: any) => void} */
  const on = (target, type, fn, opt) => { target.addEventListener(type, fn, opt); cleanups.push(() => target.removeEventListener(type, fn, opt)); };

  /** @type {{status: string[], category: string[]}} 숨길 값(라벨 id, 라벨 없음은 'none'). 비어 있으면 전체 */
  let filter = { status: [], category: [] };
  /** @type {any} */
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { /* 저장소 없음 */ }
  // 예전 형식 {status: 'all' | 'none' | id} 은 '그것만 보기'였다 → 첫 스냅샷을 받은 뒤 나머지를 숨김으로 바꾼다
  /** @type {{status?: string, category?: string} | null} */
  let legacy = null;
  if (saved && Array.isArray(saved.status) && Array.isArray(saved.category)) filter = { status: saved.status.map(String), category: saved.category.map(String) };
  else if (saved && typeof saved === "object") legacy = saved;
  /** @type {{id: string, name: string, status: string[], category: string[]}[]} 저장한 필터 */
  let presets = [];
  try { const v = JSON.parse(localStorage.getItem(PRESET_KEY) || "[]"); if (Array.isArray(v)) presets = v.filter((x) => x && typeof x.name === "string" && Array.isArray(x.status) && Array.isArray(x.category)); } catch { /* 저장소 없음 */ }
  /** @type {Set<() => void>} 필터·라벨·목록이 바뀌면 부른다(필터 관리 창) */
  const listeners = new Set();
  /** @type {any} */
  let snapshot = null;
  let editing = false, busy = false, disposed = false, applyTimer = 0;
  /** @type {Set<string>} */
  const picked = new Set();
  /** @type {string | null} */
  let anchor = null;

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .cxm-filter { display: flex; flex-direction: column; gap: 6px; padding: 4px 10px 6px; font-size: 12px; flex-shrink: 0; }
    .cxm-filter-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .cxm-filter select, .cxm-filter button { font: inherit; font-size: 12px; color: inherit; background: var(--color-token-bg-secondary, rgba(127,127,127,.12));
      border: 1px solid var(--color-token-border-default, rgba(127,127,127,.3)); border-radius: 6px; height: 24px; padding: 0 6px; min-width: 0; cursor: pointer; }
    .cxm-filter select { flex: 1 1 0; }
    .cxm-filter select.cxm-active { border-color: #60a5fa; color: #93c5fd; }
    .cxm-filter button:disabled, .cxm-filter select:disabled { opacity: .45; cursor: default; }
    .cxm-filter button.cxm-on { background: #2563eb; border-color: #2563eb; color: #fff; }
    .cxm-filter { position: relative; }
    .cxm-filter [hidden] { display: none !important; }
    .cxm-filter .cxm-filter-open { flex: 1 1 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cxm-filter .cxm-filter-open.cxm-active { border-color: #60a5fa; color: #93c5fd; }
    .cxm-filter .cxm-preset-sel { flex: 0 1 96px; }
    .cxm-filter-count { opacity: .65; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .cxm-filter-edit { border-top: 1px solid var(--color-token-border-default, rgba(127,127,127,.25)); padding-top: 6px; display: flex; flex-direction: column; gap: 6px; }
    .cxm-filter-msg { font-size: 11px; opacity: .8; min-height: 0; }
    .cxm-filter-msg:empty { display: none; }
    .cxm-filter-msg.cxm-error { color: #fb923c; opacity: 1; }
    ${ROW}.cxm-filter-hidden { display: none !important; }
    .cxm-filter-editing ${ROW} { padding-left: 22px !important; cursor: default !important; }
    .cxm-filter-editing ${ROW}::before { content: ""; position: absolute; left: 6px; top: 50%; width: 12px; height: 12px; margin-top: -7px;
      border: 1.5px solid currentColor; border-radius: 3px; opacity: .45; box-sizing: border-box; pointer-events: none; }
    .cxm-filter-editing ${ROW}.cxm-picked { background: rgba(37, 99, 235, .18) !important; }
    .cxm-filter-editing ${ROW}.cxm-picked::before { background: #2563eb; border-color: #2563eb; opacity: 1;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.2l2.2 2.2 4.8-4.8' fill='none' stroke='white' stroke-width='1.8'/%3E%3C/svg%3E"); }
    .cxm-filter-editing ${ROW} .cdx-label, .cxm-filter-editing ${ROW} .cxm-label-suggest { pointer-events: none; }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  // ------------------------------------------------------------ 대화 줄
  const visibleRows = () => allRows().filter((r) => !r.classList.contains("cxm-filter-hidden"));
  const labels = () => /** @type {any[]} */ (snapshot?.config?.labels || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  /** @param {string} key @param {'status'|'category'} kind */
  const assigned = (key, kind) => (kind === "status" ? snapshot?.assignments : snapshot?.categoryAssignments)?.[key] ?? null;
  /** @param {string} key */
  const matches = (key) => !filter.status.includes(assigned(key, "status") ?? "none") && !filter.category.includes(assigned(key, "category") ?? "none");

  // ------------------------------------------------------------ 막대
  const bar = el("div", "cxm-filter");
  bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "대화 필터");
  const top = el("div", "cxm-filter-row");
  const openBtn = /** @type {HTMLButtonElement} */ (el("button", "cxm-filter-open", "필터: 전체")); openBtn.type = "button";
  openBtn.title = "필터 관리 창 열기 (진행 상태·카테고리 고르기, 필터 저장)";
  const presetSel = /** @type {HTMLSelectElement} */ (el("select", "cxm-preset-sel")); presetSel.title = "저장한 필터 바로 쓰기";
  const editBtn = /** @type {HTMLButtonElement} */ (el("button", "", "수정")); editBtn.type = "button"; editBtn.title = "여러 대화를 골라 한꺼번에 바꾸기";
  top.append(openBtn, presetSel, editBtn);
  const edit = el("div", "cxm-filter-edit"); edit.hidden = true;
  const editTop = el("div", "cxm-filter-row");
  const pickedCount = el("span", "cxm-filter-count");
  const allBtn = /** @type {HTMLButtonElement} */ (el("button", "", "모두 선택")); allBtn.type = "button"; allBtn.title = "지금 보이는 대화를 모두 선택";
  const noneBtn = /** @type {HTMLButtonElement} */ (el("button", "", "선택 해제")); noneBtn.type = "button";
  editTop.append(pickedCount, allBtn, noneBtn);
  const editRow = el("div", "cxm-filter-row");
  const setStatus = /** @type {HTMLSelectElement} */ (el("select")); setStatus.title = "고른 대화의 진행 상태 바꾸기";
  const setCategory = /** @type {HTMLSelectElement} */ (el("select")); setCategory.title = "고른 대화의 카테고리 바꾸기";
  editRow.append(setStatus, setCategory);
  const moveRow = el("div", "cxm-filter-row");
  const moveSel = /** @type {HTMLSelectElement} */ (el("select")); moveSel.title = "고른 대화를 옮길 프로젝트·섹션";
  const moveBtn = /** @type {HTMLButtonElement} */ (el("button", "", "옮기기")); moveBtn.type = "button";
  moveRow.append(moveSel, moveBtn);
  moveRow.hidden = !actions;
  const msg = el("div", "cxm-filter-msg");
  msg.setAttribute("role", "status");
  edit.append(editTop, editRow, moveRow, msg);
  bar.append(top, edit);

  /** @param {HTMLSelectElement} sel @param {[string, string][]} options @param {string} value */
  const fill = (sel, options, value) => {
    const sig = JSON.stringify(options);
    if (sel.dataset.sig !== sig) {
      sel.replaceChildren(...options.map(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; return o; }));
      sel.dataset.sig = sig;
    }
    sel.value = options.some(([v]) => v === value) ? value : options[0][0];
  };
  /** @param {'status'|'category'} kind */
  const labelOptions = (kind) => /** @type {[string, string][]} */ (labels().filter((l) => kindOf(l) === kind && l.enabled !== false).map((l) => [l.id, l.name]));

  const drawControls = () => {
    drawFilterButton();
    fill(setStatus, [["", "진행 상태 바꾸기…"], ...labelOptions("status"), ["__none", "(진행 상태 지우기)"]], "");
    fill(setCategory, [["", "카테고리 바꾸기…"], ...labelOptions("category"), ["__none", "(카테고리 지우기)"]], "");
    editBtn.textContent = editing ? "완료" : "수정";
    editBtn.classList.toggle("cxm-on", editing);
    edit.hidden = !editing;
    const n = picked.size, lock = busy || n === 0;
    pickedCount.textContent = `${n}개 선택`;
    setStatus.disabled = setCategory.disabled = moveSel.disabled = lock;
    moveBtn.disabled = lock || !moveSel.value;
    allBtn.disabled = noneBtn.disabled = busy;
    openBtn.disabled = presetSel.disabled = editBtn.disabled = busy;
  };

  /** 고를 수 있는 값(라벨 + 라벨 없음). 꺼 둔 라벨이라도 숨김 목록에 있으면 넣는다 @param {'status'|'category'} kind */
  const values = (kind) => {
    /** @type {{value: string, name: string, color?: string}[]} */
    const out = labels().filter((l) => kindOf(l) === kind && (l.enabled !== false || filter[kind].includes(l.id)))
      .map((l) => ({ value: l.id, name: l.name, color: l.backgroundColor }));
    out.push({ value: "none", name: "라벨 없음" });
    return out;
  };
  /** @param {'status'|'category'} kind @param {string[]} next */
  const setHidden = (kind, next) => { filter[kind] = [...new Set(next.map(String))]; saveFilter(); apply(); };
  /** @param {{status: string[], category: string[]}} a @param {{status: string[], category: string[]}} b */
  const sameFilter = (a, b) => ["status", "category"].every((k) => {
    const x = [.../** @type {any} */ (a)[k]].sort().join("|"), y = [.../** @type {any} */ (b)[k]].sort().join("|");
    return x === y;
  });
  const activePreset = () => presets.find((p) => sameFilter(p, filter)) || null;
  const savePresets = () => { try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); } catch { /* 저장소 없음 */ } apply(); };

  /** 막대의 필터 버튼 글자: 전체 / 저장한 필터 이름 / '완료 제외 · 개발만' 같은 요약 */
  function drawFilterButton() {
    const preset = activePreset();
    /** @type {string[]} */
    const parts = [];
    for (const [kind, title] of /** @type {const} */ ([["status", "진행 상태"], ["category", "카테고리"]])) {
      const vals = values(kind), hidden = filter[kind];
      if (!hidden.length) continue;
      const shown = vals.filter((v) => !hidden.includes(v.value));
      const name = (/** @type {string} */ v) => vals.find((x) => x.value === v)?.name || v;
      parts.push(shown.length === 1 ? `${shown[0].name}만` : hidden.length === 1 ? `${name(hidden[0])} 제외` : `${title} ${hidden.length}개 숨김`);
    }
    openBtn.textContent = `필터: ${preset && parts.length ? preset.name : parts.join(" · ") || "전체"}`;
    openBtn.title = `${openBtn.textContent}${preset && parts.length ? ` (${parts.join(" · ")})` : ""}
필터 관리 창 열기`;
    openBtn.classList.toggle("cxm-active", parts.length > 0);
    const sig = JSON.stringify(presets.map((p) => [p.id, p.name]));
    if (presetSel.dataset.sig !== sig) {
      const first = document.createElement("option"); first.value = ""; first.textContent = "저장한 필터";
      presetSel.replaceChildren(first, ...presets.map((p) => { const o = document.createElement("option"); o.value = p.id; o.textContent = p.name; return o; }));
      presetSel.dataset.sig = sig;
    }
    presetSel.hidden = !presets.length;
    presetSel.value = preset?.id || "";
  }

  // 예전 '하나만 보기' 저장값을 '나머지 숨기기'로 바꾼다
  function convertLegacy() {
    if (!legacy || !snapshot) return;
    for (const kind of /** @type {const} */ (["status", "category"])) {
      const want = legacy[kind];
      if (!want || want === "all") continue;
      const all = labels().filter((l) => kindOf(l) === kind).map((l) => l.id).concat("none");
      filter[kind] = all.filter((v) => v !== want);
    }
    legacy = null;
    saveFilter();
  }

  /** @param {string} text @param {boolean} [error] */
  const say = (text, error = false) => { msg.textContent = text; msg.classList.toggle("cxm-error", error); };

  // ------------------------------------------------------------ 필터 적용
  const apply = () => {
    applyTimer = 0;
    if (disposed) return;
    attach();
    const rows = allRows();
    const present = new Set();
    for (const row of rows) {
      const key = keyOf(row);
      present.add(key);
      const hide = !!snapshot && !!key && !matches(key) && !picked.has(key);
      row.classList.toggle("cxm-filter-hidden", hide);
      row.classList.toggle("cxm-picked", editing && picked.has(key));
    }
    // 목록에서 사라진 대화(보관·다른 곳으로 이동)는 선택에서 뺀다
    if (!busy) for (const key of [...picked]) if (!present.has(key)) picked.delete(key);
    document.querySelector(".sidebar-navigation")?.classList.toggle("cxm-filter-editing", editing);
    drawControls();
    if (editing) refreshDestinations();
    for (const fn of listeners) { try { fn(); } catch (e) { console.warn("[codex-memo] 필터 알림", e); } }
  };
  const schedule = () => { if (!applyTimer && !disposed) applyTimer = window.setTimeout(apply, 60); };

  // 사이드바를 Codex 가 다시 그려도 막대가 목록 바로 위에 있게 한다
  function attach() {
    // 이미 목록 바로 위에 있으면 끝(매번 스타일을 계산하지 않게)
    if (bar.isConnected && bar.nextElementSibling?.querySelector(ROW)) return;
    const nav = document.querySelector(".sidebar-navigation");
    const row = nav?.querySelector(ROW);
    let scroller = row?.parentElement;
    while (scroller && scroller !== nav && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!nav || !scroller || scroller === nav) return;
    if (bar.nextElementSibling !== scroller) scroller.before(bar);
  }

  // ------------------------------------------------------------ 수정 모드: 줄 고르기
  /** @param {Event} e */
  const rowFromEvent = (e) => {
    const t = /** @type {Element | null} */ (e.target instanceof Element ? e.target : null);
    const row = /** @type {HTMLElement | null} */ (t?.closest(ROW));
    return row && row.closest(".sidebar-navigation") ? row : null;
  };
  // 수정 중에는 줄을 눌러도 대화가 열리거나 끌리지 않게 Codex 보다 먼저 가로챈다
  /** @param {Event} e */
  const swallow = (e) => { if (editing && rowFromEvent(e)) { e.preventDefault(); e.stopPropagation(); } };
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu", "dragstart"]) on(window, type, swallow, true);
  on(window, "click", (/** @type {MouseEvent} */ e) => {
    if (!editing) return;
    const row = rowFromEvent(e);
    if (!row) return;
    e.preventDefault(); e.stopPropagation();
    if (busy) return;
    const key = keyOf(row);
    if (!key) return;
    if (e.shiftKey && anchor) {
      const keys = visibleRows().map(keyOf), a = keys.indexOf(anchor), b = keys.indexOf(key);
      if (a !== -1 && b !== -1) for (const k of keys.slice(Math.min(a, b), Math.max(a, b) + 1)) picked.add(k);
    } else {
      picked.has(key) ? picked.delete(key) : picked.add(key);
      anchor = key;
    }
    say("");
    apply();
  }, true);
  on(window, "keydown", (/** @type {KeyboardEvent} */ e) => {
    // 필터 관리 창이 열려 있으면 Esc 는 창부터 닫는다
    if (editing && e.key === "Escape" && !busy && !w.__cxmFilterWindow?.isOpen?.()) { e.stopPropagation(); setEditing(false); }
  }, true);

  /** @param {boolean} value */
  const setEditing = (value) => {
    editing = value;
    if (!value) { picked.clear(); anchor = null; say(""); }
    apply();
  };

  // ------------------------------------------------------------ 옮기기: Codex 의 대화 메뉴 항목을 그대로 실행(thread-actions.js)
  const rowByKey = (/** @type {string} */ key) => allRows().find((r) => keyOf(r) === key) || null;
  const pickedRowIds = () => [...picked].map((k) => rowByKey(k)?.dataset.appActionSidebarThreadId || "").filter(Boolean);

  let destSig = "", destEpoch = 0;
  async function refreshDestinations() {
    const sig = [...picked].sort().join("|");
    if (sig === destSig || !actions) return;
    destSig = sig;
    const epoch = ++destEpoch;
    /** @type {{id: string, name: string, group: string}[]} */
    let found = [];
    try { found = await actions.destinations(pickedRowIds().slice(0, 30)); } catch { /* 메뉴 없음 */ }
    if (epoch !== destEpoch) return;
    const prev = moveSel.value;
    const first = document.createElement("option"); first.value = ""; first.textContent = picked.size && !found.length ? "옮길 수 있는 곳 없음" : "옮길 곳 고르기…";
    moveSel.replaceChildren(first, ...["프로젝트", "섹션"].map((g) => [g, found.filter((d) => d.group === g)]).filter(([, list]) => list.length).map(([g, list]) => {
      const og = document.createElement("optgroup"); og.label = /** @type {string} */ (g);
      for (const d of /** @type {any[]} */ (list)) { const o = document.createElement("option"); o.value = d.id; o.textContent = d.name; og.append(o); }
      return og;
    }));
    moveSel.value = found.some((d) => d.id === prev) ? prev : "";
    drawControls();
  }

  async function moveSelected() {
    const target = moveSel.value;
    if (!target || busy || !actions) return;
    const name = moveSel.selectedOptions[0]?.textContent || "";
    busy = true; drawControls();
    const ids = pickedRowIds();
    try {
      const r = await actions.move(ids, target, (/** @type {number} */ done, /** @type {number} */ total) => { if (done < total) say(`${name}(으)로 옮기는 중… ${done + 1}/${total}`); });
      const skipped = r.skipped.length + (picked.size - ids.length);
      const parts = [`${r.moved.length}개 옮김`];
      if (skipped) parts.push(`${skipped}개는 이미 그곳에 있거나 옮길 수 없어 건너뜀`);
      if (r.failed.length) { parts.push(`${r.failed.length}개 실패`); console.warn("[codex-memo] 옮기기 실패", r.failed); }
      say(parts.join(", "), r.failed.length > 0);
    } catch (e) {
      say(`옮기지 못했습니다: ${/** @type {any} */ (e)?.message || e}`, true);
    } finally {
      busy = false; destSig = ""; apply();
    }
  }
  /** @param {'status'|'category'} kind @param {HTMLSelectElement} sel */
  async function assignSelected(kind, sel) {
    const value = sel.value;
    if (!value || busy || !picked.size) return;
    const id = value === "__none" ? null : value;
    const name = id ? labels().find((l) => l.id === id)?.name || id : "없음";
    busy = true; drawControls();
    try {
      snapshot = await api.assignMany([...picked], id, kind);
      say(`${picked.size}개 대화의 ${kind === "status" ? "진행 상태" : "카테고리"}를 '${name}'(으)로 바꿨습니다.`);
    } catch (e) {
      say(`바꾸지 못했습니다: ${/** @type {any} */ (e)?.message || e}`, true);
    } finally {
      busy = false; sel.value = ""; apply();
    }
  }

  // ------------------------------------------------------------ 이벤트
  const saveFilter = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(filter)); } catch { /* 저장소 없음 */ } };
  on(openBtn, "click", () => w.__cxmFilterWindow?.open());
  on(presetSel, "change", () => { if (presetSel.value) api_.applyPreset(presetSel.value); });
  on(editBtn, "click", () => setEditing(!editing));
  on(allBtn, "click", () => { for (const r of visibleRows()) { const k = keyOf(r); if (k) picked.add(k); } say(""); apply(); });
  on(noneBtn, "click", () => { picked.clear(); anchor = null; say(""); apply(); });
  on(setStatus, "change", () => void assignSelected("status", setStatus));
  on(setCategory, "change", () => void assignSelected("category", setCategory));
  on(moveSel, "change", () => drawControls());
  on(moveBtn, "click", () => void moveSelected());

  let readEpoch = 0;
  const load = async () => {
    const epoch = ++readEpoch;
    try {
      const next = await api.read(null);
      if (epoch === readEpoch && next) { snapshot = next; convertLegacy(); schedule(); }
    } catch { /* 다음 변경 신호 때 다시 */ }
  };
  const unsubscribe = api.onChanged(load);
  cleanups.push(() => { try { unsubscribe?.(); } catch { /* 이미 해제 */ } });
  cleanups.push(w.__cxm.watch({ sidebar: schedule }));   // 왼쪽 목록이 바뀔 때만(common.js)
  const timer = setInterval(schedule, 2000);   // Codex 가 줄을 다시 그리며 클래스를 지운 경우 대비
  cleanups.push(() => clearInterval(timer));
  void load();
  schedule();

  const api_ = {
    version: VERSION,
    /** 검사용 */ state: () => ({ filter: { status: [...filter.status], category: [...filter.category] }, editing, picked: [...picked], busy }),
    values,
    /** 숨길 값 바꾸기 @type {(kind: 'status'|'category', hidden: string[]) => void} */
    setHidden,
    /** 모두 보이기 */ clear: () => { filter = { status: [], category: [] }; saveFilter(); apply(); },
    /** @param {{status?: string[], category?: string[]}} f 넣은 쪽만 바꾼다 */
    setFilter(f) {
      filter = { status: f.status ? [...new Set(f.status.map(String))] : filter.status, category: f.category ? [...new Set(f.category.map(String))] : filter.category };
      saveFilter(); apply();
    },
    /** 모델 도구의 되돌리기용: 지금 필터와 저장한 필터 전체 */
    exportState: () => ({ filter: { status: [...filter.status], category: [...filter.category] }, presets: presets.map((p) => ({ ...p, status: [...p.status], category: [...p.category] })) }),
    /** @param {{filter: {status: string[], category: string[]}, presets: any[]}} st */
    importState(st) {
      filter = { status: [...st.filter.status], category: [...st.filter.category] };
      presets = st.presets.map((p) => ({ id: String(p.id), name: String(p.name), status: [...p.status], category: [...p.category] }));
      saveFilter(); savePresets();
    },
    /** 왼쪽 목록에 그려진 대화 수와 값별 개수 */
    counts() {
      /** @type {{status: Record<string, number>, category: Record<string, number>, total: number, shown: number}} */
      const out = { status: {}, category: {}, total: 0, shown: 0 };
      for (const row of allRows()) {
        const key = keyOf(row);
        if (!key) continue;
        out.total++;
        if (!row.classList.contains("cxm-filter-hidden")) out.shown++;
        for (const kind of /** @type {const} */ (["status", "category"])) {
          const v = assigned(key, kind) ?? "none";
          out[kind][v] = (out[kind][v] || 0) + 1;
        }
      }
      return out;
    },
    presets: () => presets.map((p) => ({ ...p, active: sameFilter(p, filter) })),
    /** 지금 필터(또는 f)를 이름 붙여 저장(같은 이름은 덮어씀) @param {string} name @param {{status: string[], category: string[]}} [f] */
    savePreset(name, f = filter) {
      const n = String(name || "").trim().slice(0, 30);
      if (!n) throw new Error("필터 이름을 입력하세요.");
      const old = presets.find((p) => p.name === n);
      const value = { id: old?.id || `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: n, status: [...f.status], category: [...f.category] };
      presets = old ? presets.map((p) => (p === old ? value : p)) : [...presets, value];
      savePresets();
      return value.id;
    },
    /** @param {string} id */
    applyPreset(id) {
      const p = presets.find((x) => x.id === id);
      if (!p) return;
      filter = { status: [...p.status], category: [...p.category] }; saveFilter(); apply();
    },
    /** 지금 필터로 덮어쓰기 @param {string} id */
    overwritePreset(id) { presets = presets.map((p) => (p.id === id ? { ...p, status: [...filter.status], category: [...filter.category] } : p)); savePresets(); },
    /** @param {string} id @param {string} name */
    renamePreset(id, name) {
      const n = String(name || "").trim().slice(0, 30);
      if (!n) throw new Error("필터 이름을 입력하세요.");
      if (presets.some((p) => p.name === n && p.id !== id)) throw new Error("같은 이름의 필터가 있습니다.");
      presets = presets.map((p) => (p.id === id ? { ...p, name: n } : p)); savePresets();
    },
    /** @param {string} id */
    deletePreset(id) { presets = presets.filter((p) => p.id !== id); savePresets(); },
    /** @param {() => void} fn */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    destroy() {
      disposed = true;
      clearTimeout(applyTimer);
      for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* 무시 */ } }
      bar.remove();
      for (const r of allRows()) r.classList.remove("cxm-filter-hidden", "cxm-picked");
      document.querySelector(".sidebar-navigation")?.classList.remove("cxm-filter-editing");
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
      listeners.clear();
    },
  };
  w.__cxmSidebarFilter = api_;
})();
