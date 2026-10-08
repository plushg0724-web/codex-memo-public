// @ts-check
// 왼쪽 목록에서 카테고리가 없는 대화에 Mica 추천을 흐린 점선 칩으로 보여준다 (예: '개발?').
// 클릭하면 그 라벨을 지정하고, 오른쪽 클릭하면 그 대화의 추천을 숨긴다. 상태 라벨은 추천하지 않는다.
// 기준보다 확신이 낮으면 회색 '? 45%' 만 띄우고, 누르면 라벨 메뉴(라벨별 %)를 연다.
// 라벨 배지를 눌러 직접 고를 때는 메뉴의 분류 라벨마다 자동 분류 확신 %를 붙인다.
// 'cxm:auto-refresh' 이벤트(단어장 창의 자동 판단 설정)가 오면 처음부터 다시 묻는다.
(() => {
  const VERSION = 11;
  if (window.__cxmSuggest?.version === VERSION) return;
  try { window.__cxmSuggest?.destroy(); } catch { /* 예전 버전 */ }
  const api = window.codexLabels;
  const cxm = /** @type {any} */ (window).__cxm;
  if (!api?.labelSuggest || !api.assign || !api.read || !cxm) return;

  const { ROW, kindOf, keyOf, uuidOf } = cxm;
  const DISMISS_KEY = "cxm-label-suggest-dismissed";
  const BATCH = 5;                         // 5개씩 물어서 먼저 끝난 것부터 보여준다
  const RETRY_MS = 10 * 60 * 1000;         // 추천이 없던 대화는 10분 뒤 다시 물어본다 (Mica 를 나중에 켠 경우 등)
  const ERROR_RETRY_MS = 30 * 1000;        // 요청이 실패(시간 초과 등)하면 30초 뒤 다시 (첫 판단은 App Server 를 켜느라 오래 걸림)
  const cleanups = [];
  const on = (target, type, fn, opt) => { target.addEventListener(type, fn, opt); cleanups.push(() => target.removeEventListener(type, fn, opt)); };

  /** @type {Map<string, {labelId: string, confidence: number, confident?: boolean} | null>} 대화 uuid → 추천 */
  const results = new Map();
  /** @type {Map<string, number>} 물어본 시각 */
  const asked = new Map();
  /** @type {Set<string>} */
  let dismissed = new Set();
  try { dismissed = new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || "[]")); } catch { /* 저장소 없음 */ }
  /** @type {Map<string, any>} */
  let labels = new Map();
  let snapshot = null, snapshotSignature = '', loadEpoch = 0, generation = 0, disposed = false, rescanPending = false;

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .cxm-label-suggest { display: inline-flex; align-items: center; flex-shrink: 0; margin-right: 2px; padding: 0 3px; height: 17px;
      border: 1px dashed var(--cxm-c, #888); color: var(--cxm-c, #888); border-radius: 5px; font-size: 11px; line-height: 1;
      cursor: pointer; opacity: .8; white-space: nowrap; background: transparent; max-width: min(160px, 32%); overflow: hidden; }
    .cxm-label-suggest-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .cxm-label-suggest.cxm-unsure { border-color: #8888; color: #888; opacity: .7; }
    .cxm-label-suggest small { margin-left: 2px; font-size: 10px; opacity: .75; font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .cxm-label-suggest:hover { opacity: 1; background: color-mix(in srgb, var(--cxm-c, #888) 15%, transparent); }
    #cdx-label-menu .cxm-label-score { margin-left: auto; padding-left: 10px; font-size: 11px; opacity: .6; font-variant-numeric: tabular-nums; }
    #cdx-label-menu .cxm-label-top .cxm-label-score { opacity: 1; font-weight: 600; }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  cleanups.push(() => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet); });

  const badgeOf = (row) => row.querySelector('.cdx-label[data-kind="category"]') || row.querySelector('.cdx-label:not([data-kind])');
  const rowOf = (id) => [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(ROW))].find((r) => uuidOf(r) === id);
  /** 백엔드가 직접 못 읽는 다른 호스트(클라우드) 대화는 화면 통로로 요약을 읽어 보낸다. 실패하면 제목만 */
  async function infoOf(id) {
    const row = rowOf(id);
    const title = row?.dataset.appActionSidebarThreadTitle || "";
    const host = row?.dataset.appActionSidebarThreadHostId || "local";
    if (host === "local" || !api.threadDigest) return title;
    return api.threadDigest(host, id).catch(() => title);
  }
  const unlabeled = (row) => {
    const badge = badgeOf(row);
    if (!badge) return false;
    const key = keyOf(row);
    if (snapshot?.categoryAssignments?.[key]) return false;
    if (!snapshot?.categoryAssignments && labels.has(snapshot?.assignments?.[key])) return false;
    if (badge.dataset.kind === 'category') return !badge.dataset.labelId;
    const text = badge.textContent?.trim();
    return text === '＋' || snapshot?.config.labels.some((label) => kindOf(label) === 'status' && label.name === text);
  };

  function resetResults() {
    generation++;
    results.clear(); asked.clear();
    scoredMenu = null;
    document.querySelectorAll('#cdx-label-menu .cxm-label-score').forEach((tag) => tag.remove());
    document.querySelectorAll('#cdx-label-menu .cxm-label-top').forEach((button) => button.classList.remove('cxm-label-top'));
    render();
    if (scanning) rescanPending = true;
    clearTimeout(scanTimer); scanTimer = window.setTimeout(scan, 300);
  }

  function acceptSnapshot(snap) {
    if (!snap?.config?.labels || disposed) return;
    // Assigning one conversation only changes which chip is eligible to render.
    // Keep other recommendations and in-flight batches until classifier settings change.
    const signature = JSON.stringify(snap.config);
    const changed = !!snapshotSignature && signature !== snapshotSignature;
    snapshot = snap; snapshotSignature = signature;
    labels = new Map(snap.config.labels.filter((label) => label.enabled && kindOf(label) === 'category').map((label) => [label.id, label]));
    if (changed) resetResults();
    else render();
  }

  async function loadLabels() {
    const epoch = ++loadEpoch;
    try {
      const snap = await api.read(null);
      if (epoch === loadEpoch) acceptSnapshot(snap);
    } catch { /* 다음에 */ }
  }

  /** 행마다 칩을 맞춘다: 추천이 있고 라벨이 없고 숨기지 않았으면 표시 */
  function render() {
    for (const row of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(ROW))) {
      const id = uuidOf(row);
      const r = id && results.get(id);
      const label = r && labels.get(r.labelId);
      let chip = /** @type {HTMLElement | null} */ (row.querySelector(".cxm-label-suggest"));
      if (!label || !unlabeled(row) || dismissed.has(id)) { chip?.remove(); continue; }
      const sure = r.confident !== false;
      if (chip?.dataset.label === r.labelId && chip.dataset.confidence === String(r.confidence) && chip.dataset.sure === String(sure)) continue;
      chip?.remove();
      chip = document.createElement("span");
      chip.className = "cxm-label-suggest";
      chip.dataset.label = r.labelId;
      chip.dataset.thread = id;
      chip.dataset.confidence = String(r.confidence);
      chip.dataset.sure = String(sure);
      // 라벨이 비어 있는 대화: 추천 라벨(확신이 기준보다 낮으면 '?')과 추천도(자동 분류 확신 %)를 함께 보여 준다
      const pct = document.createElement("small");
      const name = document.createElement("span");
      name.className = 'cxm-label-suggest-name';
      const percent = Math.round(r.confidence * 100);
      pct.textContent = `${percent}%`;
      if (sure) {
        name.textContent = `${label.name}?`; chip.append(name, pct);
        chip.style.setProperty("--cxm-c", label.backgroundColor || "#888");
        chip.title = `자동 추천 (확신 ${percent}%) · 클릭하면 '${label.name}' 지정 · 오른쪽 클릭하면 숨기기`;
      } else {
        chip.classList.add("cxm-unsure");
        name.textContent = '?'; chip.append(name, pct);
        chip.title = `확신이 낮음 — 가장 가까운 라벨 '${label.name}' ${percent}% · 클릭하면 라벨 메뉴(라벨별 %)에서 직접 고르기 · 오른쪽 클릭하면 숨기기`;
      }
      badgeOf(row)?.after(chip);
    }
  }

  let scanning = false;
  async function scan() {
    if (disposed) return;
    if (scanning) { rescanPending = true; return; }
    scanning = true;
    try {
      if (!snapshot) await loadLabels();
      const epoch = generation;
      const now = Date.now();
      const todo = [...document.querySelectorAll(ROW)].filter(unlabeled).map(uuidOf)
        .filter((id) => id && !dismissed.has(id) && !(asked.has(id) && (results.get(id) || now - asked.get(id) < RETRY_MS)));
      for (let i = 0; i < todo.length; i += BATCH) {
        const ids = todo.slice(i, i + BATCH);
        ids.forEach((id) => asked.set(id, Date.now()));
        // 클라우드 대화는 이 PC 의 백엔드가 읽을 수 없어 화면이 읽은 요약(못 읽으면 제목)을 함께 보낸다
        const titles = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await infoOf(id)])));
        if (disposed || epoch !== generation) break;
        const res = await api.labelSuggest(ids, titles).catch(() => null);
        if (disposed || epoch !== generation) break;
        if (!res) {   // 실패는 '추천 없음'으로 기억하지 않고 곧 다시 묻는다
          ids.forEach((id) => asked.delete(id));
          clearTimeout(scanTimer);
          scanTimer = window.setTimeout(scan, ERROR_RETRY_MS);
          break;
        }
        ids.forEach((id) => results.set(id, res[id] || null));
        render();
      }
    } finally {
      scanning = false;
      if (rescanPending && !disposed) { rescanPending = false; clearTimeout(scanTimer); scanTimer = window.setTimeout(scan, 300); }
    }
  }

  // 라벨 메뉴(vendor/renderer.js)는 마지막으로 누른 배지에서 열린다
  /** @type {HTMLElement | null} */
  let lastBadge = null;
  let scoredMenu = null;
  async function scoreMenu(menu) {
    scoredMenu = menu;
    const epoch = generation;
    const row = /** @type {HTMLElement | null} */ (menu.dataset.key
      ? [...document.querySelectorAll(ROW)].find((candidate) => keyOf(candidate) === menu.dataset.key)
      : lastBadge?.closest(ROW) || null);
    const id = row && uuidOf(row);
    if (!id || !api.labelScores) return;
    const scores = await api.labelScores(id, await infoOf(id)).catch(() => null);
    if (!scores || !menu.isConnected || disposed || epoch !== generation) return;
    if (!labels.size) await loadLabels();
    const byName = new Map([...labels.values()].map((l) => [l.name, l.id]));
    const top = Object.keys(scores).reduce((a, b) => (scores[b] > scores[a] ? b : a), Object.keys(scores)[0]);
    for (const b of /** @type {NodeListOf<HTMLElement>} */ (menu.querySelectorAll("button[role=menuitem]"))) {
      if (b.dataset.kind && b.dataset.kind !== 'category') continue;
      const labelId = b.dataset.labelId || (!b.dataset.kind && byName.get((b.textContent || "").trim()));
      if (!labels.has(labelId) || b.querySelector('.cxm-label-score')) continue;
      const p = labelId && scores[labelId];
      if (p === undefined || p === "" || p === null || !labelId) continue;
      const tag = document.createElement("span");
      tag.className = "cxm-label-score";
      tag.textContent = `${Math.round(Number(p) * 100)}%`;
      b.append(tag);
      b.classList.toggle("cxm-label-top", labelId === top);
      b.title = `자동 분류 확신 ${Math.round(Number(p) * 100)}%`;
    }
  }

  // 칩 클릭: 대화로 이동하지 않게 막고 라벨 지정 (단어장·라벨 배지처럼 캡처 단계에서 처리)
  function onChip(e) {
    if (e.type === "pointerdown" && e.target instanceof Element) {
      const badge = e.target.closest(".cdx-label");
      if (badge) lastBadge = /** @type {HTMLElement} */ (badge);
    }
    const chip = e.target instanceof Element && /** @type {HTMLElement | null} */ (e.target.closest(".cxm-label-suggest"));
    if (!chip) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const row = /** @type {HTMLElement | null} */ (chip.closest(ROW));
    if (!row) return;
    if (e.type === "contextmenu") {
      dismissed.add(chip.dataset.thread);
      try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed].slice(-500))); } catch { /* 저장소 없음 */ }
      chip.remove();
      return;
    }
    if (e.type !== "click") return;
    if (chip.dataset.sure === "false") {   // 확신이 낮으면 지정하지 않고 라벨 메뉴를 연다
      const badge = badgeOf(row);
      if (badge) { lastBadge = /** @type {HTMLElement} */ (badge); /** @type {HTMLElement} */ (badge).click(); }
      return;
    }
    const key = keyOf(row);
    const previous = results.get(chip.dataset.thread);
    chip.remove();
    results.delete(chip.dataset.thread);
    api.assign(key, chip.dataset.label, 'category').then(() => loadLabels())
      .catch(() => { if (!disposed) { results.set(chip.dataset.thread, previous); render(); } });
  }
  for (const type of ["pointerdown", "mousedown", "click", "contextmenu"]) on(document, type, onChip, true);

  // 목록이 바뀌면(스크롤로 새 대화, 라벨 지정 등) 칩을 다시 맞추고, 새 대화는 물어본다
  let renderTimer = 0, scanTimer = 0;
  // 화면 변화는 common.js 가 한 곳에서 지켜본다(왼쪽 목록 변화·새 요소만 알림)
  const unwatch = cxm.watch({
    added: () => {
      const menu = document.getElementById("cdx-label-menu");
      if (menu && menu !== scoredMenu) scoreMenu(menu);
    },
    sidebar: () => {
      clearTimeout(renderTimer);
      renderTimer = window.setTimeout(render, 200);
      clearTimeout(scanTimer);
      scanTimer = window.setTimeout(scan, 1500);
    },
  });
  cleanups.push(() => { unwatch(); clearTimeout(renderTimer); clearTimeout(scanTimer); });
  const offChanged = api.onChanged?.(() => { loadLabels(); });
  if (offChanged) cleanups.push(offChanged);
  cleanups.push(() => document.querySelectorAll(".cxm-label-suggest").forEach((c) => c.remove()));

  // 기준 확신을 바꾸거나 '다시 판단'을 누르면 처음부터 다시 묻는다
  const onRefresh = () => { resetResults(); };
  on(window, "cxm:auto-refresh", onRefresh);

  scanTimer = window.setTimeout(scan, 1500);
  window.__cxmSuggest = {
    version: VERSION,
    destroy() { disposed = true; generation++; loadEpoch++; cleanups.splice(0).reverse().forEach((f) => { try { f(); } catch { /* 이미 정리됨 */ } }); delete window.__cxmSuggest; },
  };
})();
