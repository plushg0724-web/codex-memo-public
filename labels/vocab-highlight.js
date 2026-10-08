// @ts-check
// 단어장에 저장한 단어를 대화 본문에 표시하는 모양. 종류(기본·복습 필요·숙지함·즐겨찾기)마다 선 모양·두께·색,
// 배경색·진하기, 글자색을 고를 수 있다.
// 찾기는 vendor/vocabulary-renderer.js 의 CSS Custom Highlight('codex-vocabulary-saved')가 한다
// (DOM 을 바꾸지 않고, 보이는 문단만, 바뀐 문단만 다시 계산). 그 칠하기는 보이지 않게 두고(마우스 카드가 쓴다)
// 같은 범위를 단어의 종류에 따라 'cxm-vhl-<종류>' 칠하기로 나눠 그린다. 원본이 범위를 더하거나 뺄 때마다 다시 나눈다.
// 끄면 원본 칠하기도 등록부(CSS.highlights)에서 떼어 내 마우스 올림 카드·클릭 카드도 함께 쉰다.
// 설정은 이 화면의 localStorage 에 저장하고, 공통 설정 창 '단어장·메모' 탭의 '본문 표시'에서 바꾼다.
(() => {
  const VERSION = 6;
  const w = /** @type {any} */ (window);
  if (w.__cxmVocabHighlight?.version === VERSION) {
    w.__cxmVocabHighlight.refreshPaint();
    return;
  }
  try { w.__cxmVocabHighlight?.destroy(); } catch { /* 예전 버전 */ }

  const NAME = "codex-vocabulary-saved";
  const STORE_KEY = "cxm-vocab-highlight";
  const api = window.codexLabels;
  const reg = /** @type {any} */ (CSS).highlights;
  const HighlightCtor = /** @type {any} */ (window).Highlight;
  const cleanups = /** @type {(() => void)[]} */ ([]);
  let disposed = false, readEpoch = 0, mountTimer = 0;

  // ---------------------------------------------------------------- 설정
  /** @typedef {{line: string, thickness: number, lineColor: string, bg: string, bgAlpha: number, text: string}} Style */
  /** 즐겨찾기가 가장 앞선다. 그다음 학습 상태(복습 필요·숙지함), 나머지는 기본 */
  const KINDS = /** @type {const} */ ([["base", "기본 (미학습)"], ["review", "복습 필요"], ["known", "숙지함"], ["favorite", "즐겨찾기"]]);
  /** @typedef {typeof KINDS[number][0]} Kind */
  const LINES = /** @type {const} */ ([["solid", "실선"], ["dotted", "점선"], ["dashed", "끊은 선"], ["wavy", "물결"], ["double", "이중선"], ["none", "선 없음"]]);
  /** @type {Record<Kind, Style>} 눈에 잘 띄게: 기본은 2px 실선 + 진한 배경, 즐겨찾기는 3px 금색 */
  const DEFAULTS = {
    base: { line: "solid", thickness: 2, lineColor: "#2aa5c7", bg: "#2aa5c7", bgAlpha: 20, text: "" },
    review: { line: "wavy", thickness: 2, lineColor: "#ef6b5b", bg: "#ef6b5b", bgAlpha: 16, text: "" },
    known: { line: "dotted", thickness: 1, lineColor: "#8b95a1", bg: "#8b95a1", bgAlpha: 0, text: "" },
    favorite: { line: "solid", thickness: 3, lineColor: "#f2a900", bg: "#f2c230", bgAlpha: 28, text: "" },
  };
  const HEX = /^#[0-9a-f]{6}$/i;
  /** 저장된 값을 믿지 않고 하나씩 확인한다 @param {any} v @param {Style} d @returns {Style} */
  const cleanStyle = (v, d) => ({
    line: LINES.some(([k]) => k === v?.line) ? v.line : d.line,
    thickness: [1, 2, 3, 4].includes(v?.thickness) ? v.thickness : d.thickness,
    lineColor: HEX.test(v?.lineColor) ? v.lineColor : d.lineColor,
    bg: HEX.test(v?.bg) ? v.bg : d.bg,
    bgAlpha: Number.isInteger(v?.bgAlpha) && v.bgAlpha >= 0 && v.bgAlpha <= 60 ? v.bgAlpha : d.bgAlpha,
    text: v?.text === "" || HEX.test(v?.text) ? v.text : d.text,
  });
  const defaults = () => ({ on: true, styles: /** @type {Record<Kind, Style>} */ (Object.fromEntries(KINDS.map(([k]) => [k, { ...DEFAULTS[k] }]))) });
  function load() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch { /* 저장소 없음 */ }
    const config = defaults();
    if (!raw) return config;
    // 예전(v1) 값: 'both' | 'underline' | 'background' | 'off'
    if (["both", "underline", "background", "off"].includes(raw)) {
      config.on = raw !== "off";
      for (const [k] of KINDS) {
        if (raw === "underline") config.styles[k].bgAlpha = 0;
        if (raw === "background") config.styles[k].line = "none";
      }
      return config;
    }
    try {
      const v = JSON.parse(raw);
      config.on = v?.on !== false;
      for (const [k] of KINDS) config.styles[k] = cleanStyle(v?.styles?.[k], DEFAULTS[k]);
    } catch { /* 깨진 값이면 기본 */ }
    return config;
  }
  let config = load();
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(config)); } catch { /* 저장소 없음 */ } };

  // ---------------------------------------------------------------- 모양
  const rgba = (/** @type {string} */ hex, /** @type {number} */ alpha) =>
    `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${alpha / 100})`;
  /** ::highlight 와 미리보기 글자에 같이 쓰는 선언 @param {Style} s */
  const decl = (s) => (s.line === "none" ? "text-decoration-line: none;" :
    `text-decoration-line: underline; text-decoration-style: ${s.line}; text-decoration-thickness: ${s.thickness}px; text-decoration-color: ${s.lineColor};`)
    + ` background-color: ${s.bgAlpha ? rgba(s.bg, s.bgAlpha) : "transparent"};` + (s.text ? ` color: ${s.text};` : "");
  // adoptedStyleSheets 는 문서 스타일보다 뒤라 같은 선택자로 vendor 의 기본 점선을 덮는다
  const sheet = new CSSStyleSheet();
  const css = () => `
    ::highlight(${NAME}) { text-decoration-line: none; background-color: transparent; }
    ${KINDS.map(([k]) => `::highlight(cxm-vhl-${k}) { ${decl(config.styles[k])} }`).join("\n")}
    @media (forced-colors: active) { ${KINDS.map(([k]) => `::highlight(cxm-vhl-${k}) { text-decoration-line: underline; text-decoration-color: LinkText; background-color: transparent; color: inherit; }`).join(" ")} }
    ${config.on ? "" : "#cdx-vocabulary-access { display: none !important; }"}
    #cdx-vocabulary .cxm-vhl { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    #cdx-vocabulary .cxm-vhl button { padding: 3px 8px; font-size: 12px; }
    #cdx-label-settings .cxm-vhl-settings { margin-top: 26px; }
    #cdx-label-settings .cxm-vhl-on { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 12px; }
    #cdx-label-settings .cxm-vhl-on input { width: 16px; height: 16px; margin: 0; accent-color: #7dd3fc; }
    #cdx-label-settings .cxm-vhl-row { display: grid; grid-template-columns: 96px 1fr; gap: 6px 12px; align-items: center; padding: 10px 0; border-top: 1px solid #3c3f44; }
    #cdx-label-settings .cxm-vhl-row[aria-disabled="true"] { opacity: .45; }
    #cdx-label-settings .cxm-vhl-name { font-size: 13px; }
    #cdx-label-settings .cxm-vhl-sample { justify-self: start; font-size: 14px; padding: 0 2px; }
    #cdx-label-settings .cxm-vhl-controls { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 12px; color: #c7ced8; }
    #cdx-label-settings .cxm-vhl-controls label { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
    #cdx-label-settings .cxm-vhl-controls input[type=color] { width: 28px; height: 22px; padding: 0; border: 1px solid #52565e; border-radius: 4px; background: none; }
    #cdx-label-settings .cxm-vhl-controls input[type=range] { width: 80px; accent-color: #7dd3fc; }
    #cdx-label-settings .cxm-vhl-controls output { min-width: 30px; font-variant-numeric: tabular-nums; }
    #cdx-label-settings .cxm-vhl-actions { margin-top: 10px; }
  `;
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  cleanups.push(() => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet); });

  // ---------------------------------------------------------------- 종류별 칠하기
  /** @type {Record<Kind, any>} */
  const layers = /** @type {any} */ (Object.fromEntries(KINDS.map(([k]) => [k, HighlightCtor ? new HighlightCtor() : null])));
  // 겹치지는 않지만, 혹시 겹치면 즐겨찾기가 위에 보이게
  KINDS.forEach(([k], i) => { if (layers[k]) layers[k].priority = i; });
  const register = (/** @type {boolean} */ on) => {
    for (const [k] of KINDS) {
      const name = `cxm-vhl-${k}`;
      if (on && layers[k]) reg?.set(name, layers[k]); else reg?.delete(name);
    }
  };
  cleanups.push(() => register(false));

  /** @type {any} 떼어 둔 원본 칠하기 (다시 주입돼도 잃지 않게 window 에 보관) */
  const paint = () => reg?.get(NAME) || w.__cxmVocabPaint || null;
  /** 원본 칠하기가 범위를 더하고 뺄 때 무엇이 바뀌었는지 알린다 (한 번만 감싼다. 알림은 지금 버전으로 간다) */
  const hook = (/** @type {any} */ p) => {
    if (!p || p.__cxmHooked2) return;
    p.__cxmHooked2 = true;
    for (const method of ["add", "delete", "clear"]) {
      const original = p[method];
      p[method] = function (/** @type {any[]} */ ...args) { const r = original.apply(this, args); w.__cxmVocabHighlight?.changed?.(method, args[0]); return r; };
    }
  };
  const attach = (/** @type {boolean} */ on) => {
    const p = paint();
    if (!reg || !p) return;
    w.__cxmVocabPaint = p;
    hook(p);
    if (on && reg.get(NAME) !== p) reg.set(NAME, p);
    if (!on && reg.get(NAME) === p) reg.delete(NAME);
  };

  const key = (/** @type {string} */ v) => (v || "").normalize("NFKC").toLocaleLowerCase("en").replace(/ς/g, "σ").replace(/\s+/g, " ").trim();
  /** 단어 → 종류 @type {Map<string, Kind>} */
  let kinds = new Map();
  async function loadKinds() {
    const epoch = ++readEpoch;
    let snap = null;
    try { snap = await api?.vocabularyRead?.(); } catch { return; }
    if (disposed || epoch !== readEpoch) return;
    /** @type {Map<string, {fav: boolean, review: boolean, known: boolean}>} */
    const acc = new Map();
    for (const e of snap?.entries || []) {
      const k = key(e.term), a = acc.get(k) || { fav: false, review: false, known: true };
      a.fav ||= e.favorite === true; a.review ||= e.status === "review"; a.known &&= e.status === "known";
      acc.set(k, a);
    }
    kinds = new Map([...acc].map(([k, a]) => [k, a.fav ? "favorite" : a.review ? "review" : a.known ? "known" : "base"]));
    schedule();
  }
  const textOf = (/** @type {any} */ r) => {
    if (r.startContainer === r.endContainer && r.startContainer.nodeType === 3) return r.startContainer.data.slice(r.startOffset, r.endOffset);
    try { const x = new Range(); x.setStart(r.startContainer, r.startOffset); x.setEnd(r.endContainer, r.endOffset); return x.toString(); } catch { return ""; }
  };
  let timer = 0;
  function rebuild() {
    timer = 0;
    if (disposed) return;
    for (const [k] of KINDS) layers[k]?.clear();
    const p = paint();
    if (!config.on || !p) return;
    for (const r of p) layers[kindOf(r)]?.add(r);
  }
  const kindOf = (/** @type {any} */ r) => kinds.get(key(textOf(r))) || "base";
  /** 원본이 범위 하나를 더하거나 뺄 때는 그 범위만 옮긴다 (문단을 칠할 때마다 전부 다시 나누지 않게).
   * 무엇이 바뀌었는지 모르면(예전 알림·전체 지우기) 모아서 전부 다시 나눈다.
   * @param {string} [method] @param {any} [range] */
  function changed(method, range) {
    if (disposed || !config.on) return;
    if (timer || !range || (method !== "add" && method !== "delete")) { schedule(); return; }
    if (method === "add") layers[kindOf(range)]?.add(range);
    else for (const [k] of KINDS) layers[k]?.delete(range);
  }
  // 원본은 문단마다 범위를 하나씩 더하므로 모아서 한 번에 나눈다
  const schedule = () => { if (!disposed && !timer) timer = window.setTimeout(rebuild, 30); };
  cleanups.push(() => clearTimeout(timer));
  // A renderer update can replace its Highlight after an open dialog closes,
  // even when this style module was already injected with the same version.
  const refreshPaint = () => { if (!disposed) { attach(config.on); schedule(); } };
  window.addEventListener("codex-vocabulary:highlight-ready", refreshPaint);
  cleanups.push(() => window.removeEventListener("codex-vocabulary:highlight-ready", refreshPaint));
  const offVocab = api?.onVocabularyChanged?.(() => { void loadKinds(); });
  if (offVocab) cleanups.push(offVocab);

  function apply(rebuildLayers = true) {
    if (disposed) return;
    sheet.replaceSync(css());
    attach(config.on);
    register(config.on);
    if (rebuildLayers) schedule();
    for (const sel of document.querySelectorAll("#cdx-vocabulary .cxm-vhl select")) /** @type {HTMLSelectElement} */ (sel).value = config.on ? "on" : "off";
    for (const box of document.querySelectorAll("#cdx-label-settings .cxm-vhl-settings")) /** @type {any} */ (box).__cxmFill?.();
  }
  const setOn = (/** @type {boolean} */ on) => { config.on = !!on; save(); apply(); };
  /** @param {Kind} kind @param {Partial<Style>} patch */
  const setStyle = (kind, patch) => {
    if (!config.styles[kind]) return;
    config.styles[kind] = cleanStyle({ ...config.styles[kind], ...patch }, config.styles[kind]);
    save(); apply(false);
  };
  const reset = () => { config = { ...defaults(), on: config.on }; save(); apply(); };
  apply();
  void loadKinds();
  // vendor 가 아직 등록 전이었다면(순서가 바뀐 경우) 한 번 더 맞춘다
  if (!paint()) { const t = setTimeout(apply, 1000); cleanups.push(() => clearTimeout(t)); }
  cleanups.push(() => attach(true));

  // ---------------------------------------------------------------- 보관함 필터 줄: 켜기·끄기 + 스타일 설정 열기
  /** @template {keyof HTMLElementTagNameMap} T @param {T} tag */
  const el = (tag, cls = "", text = "") => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  function mountLibrary() {
    const filters = document.querySelector("#cdx-vocabulary .vb-library .vb-filters");
    if (!filters || filters.querySelector(".cxm-vhl")) return;
    const label = el("label", "cxm-vhl");
    label.title = "저장한 단어를 대화 본문에 표시합니다";
    const sel = el("select");
    sel.setAttribute("aria-label", "저장한 단어 본문 표시");
    sel.append(new Option("켜기", "on"), new Option("끄기", "off"));
    sel.value = config.on ? "on" : "off";
    sel.addEventListener("change", () => setOn(sel.value === "on"));
    const style = el("button", "", "스타일…");
    style.type = "button";
    style.title = "종류별 밑줄·배경·글자색 바꾸기";
    style.addEventListener("click", (e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("codex-labels:open-settings", { detail: { tab: "vocabulary" } })); });
    label.append("본문 표시", sel, style);
    filters.append(label);
  }

  // ---------------------------------------------------------------- 설정 창 '단어장·메모' 탭: 본문 표시
  function mountSettings() {
    const panel = document.querySelector("#cdx-label-settings #cdx-settings-panel-vocabulary");
    if (!panel || panel.querySelector(".cxm-vhl-settings")) return;
    const box = el("section", "cxm-vhl-settings");
    const onInput = el("input"); onInput.type = "checkbox"; onInput.id = "cxm-vhl-on";
    const onLabel = el("label", "cxm-vhl-on"); onLabel.htmlFor = onInput.id;
    onLabel.append(onInput, "대화 본문에 저장한 단어 표시");
    onInput.addEventListener("change", () => setOn(onInput.checked));
    box.append(el("h3", "", "본문 표시"), el("p", "cdx-settings-help", "저장한 단어를 대화 본문에서 어떻게 보일지 종류별로 정합니다. 즐겨찾기가 가장 앞서고, 그다음 학습 상태를 따릅니다. 바꾸면 바로 적용·저장됩니다."), onLabel);
    /** @type {(() => void)[]} */
    const fills = [];
    for (const [kind, name] of KINDS) {
      const row = el("div", "cxm-vhl-row"); row.dataset.kind = kind;
      const sample = el("span", "cxm-vhl-sample", "Sample 단어");
      const controls = el("div", "cxm-vhl-controls");
      const field = (/** @type {string} */ text, /** @type {HTMLElement} */ input) => { const l = el("label"); l.append(text, input); controls.append(l); return input; };
      const line = /** @type {HTMLSelectElement} */ (field("선", el("select")));
      for (const [v, t] of LINES) line.append(new Option(t, v));
      const thick = /** @type {HTMLSelectElement} */ (field("두께", el("select")));
      for (const v of [1, 2, 3, 4]) thick.append(new Option(`${v}px`, String(v)));
      const color = /** @type {HTMLInputElement} */ (field("선 색", el("input"))); color.type = "color";
      const bg = /** @type {HTMLInputElement} */ (field("배경", el("input"))); bg.type = "color";
      const alpha = /** @type {HTMLInputElement} */ (field("진하기", el("input"))); Object.assign(alpha, { type: "range", min: "0", max: "60", step: "2" });
      const alphaOut = el("output"); controls.lastElementChild?.append(alphaOut);
      const textOn = /** @type {HTMLInputElement} */ (field("글자색", el("input"))); textOn.type = "checkbox";
      const text = /** @type {HTMLInputElement} */ (el("input")); text.type = "color"; controls.lastElementChild?.append(text);
      for (const [input, label] of /** @type {const} */ ([[line, "선 모양"], [thick, "선 두께"], [color, "선 색"], [bg, "배경색"], [alpha, "배경 진하기"], [textOn, "글자색 바꾸기"], [text, "글자색"]])) input.setAttribute("aria-label", `${name} ${label}`);
      line.addEventListener("change", () => setStyle(kind, { line: line.value }));
      thick.addEventListener("change", () => setStyle(kind, { thickness: Number(thick.value) }));
      color.addEventListener("input", () => setStyle(kind, { lineColor: color.value }));
      bg.addEventListener("input", () => setStyle(kind, { bg: bg.value }));
      alpha.addEventListener("input", () => setStyle(kind, { bgAlpha: Number(alpha.value) }));
      textOn.addEventListener("change", () => setStyle(kind, { text: textOn.checked ? text.value || "#ffffff" : "" }));
      text.addEventListener("input", () => { if (textOn.checked) setStyle(kind, { text: text.value }); });
      fills.push(() => {
        const s = config.styles[kind];
        line.value = s.line; thick.value = String(s.thickness); color.value = s.lineColor; bg.value = s.bg;
        alpha.value = String(s.bgAlpha); alphaOut.textContent = `${s.bgAlpha}%`;
        textOn.checked = !!s.text; text.disabled = !s.text; if (s.text) text.value = s.text;
        thick.disabled = color.disabled = s.line === "none";
        sample.setAttribute("style", decl(s));
        row.setAttribute("aria-disabled", String(!config.on));
      });
      row.append(el("span", "cxm-vhl-name", name), sample, controls);
      box.append(row);
    }
    const reset_ = el("button", "", "기본 모양으로 복원"); reset_.type = "button";
    reset_.addEventListener("click", () => reset());
    const actions = el("div", "cxm-vhl-actions"); actions.append(reset_);
    box.append(actions);
    /** @type {any} */ (box).__cxmFill = () => { onInput.checked = config.on; fills.forEach((f) => f()); };
    /** @type {any} */ (box).__cxmFill();
    panel.append(box);
  }

  const mountAll = () => { if (!disposed) { mountLibrary(); mountSettings(); } };
  mountAll();
  // 붙일 곳은 단어장·설정 창 안에만 있다. 답변이 작성되는 동안 새 요소마다 조상·자식을 뒤지지 않고,
  // 창이 열려 있을 때만 확인한다(mountAll 은 이미 붙어 있으면 아무것도 하지 않음).
  const unwatch = w.__cxm?.watch?.({
    added: () => {
      if (document.getElementById("cdx-vocabulary") || document.getElementById("cdx-label-settings")) mountAll();
    },
  });
  if (unwatch) cleanups.push(unwatch);
  const onOpen = () => {
    if (!disposed && !mountTimer) mountTimer = window.setTimeout(() => { mountTimer = 0; mountAll(); }, 0);
  };
  cleanups.push(() => clearTimeout(mountTimer));
  for (const type of ["codex-labels:open-vocabulary", "codex-labels:open-settings"]) {
    window.addEventListener(type, onOpen);
    cleanups.push(() => window.removeEventListener(type, onOpen));
  }
  cleanups.push(() => document.querySelectorAll("#cdx-vocabulary .cxm-vhl, #cdx-label-settings .cxm-vhl-settings").forEach((n) => n.remove()));

  w.__cxmVocabHighlight = {
    version: VERSION,
    get config() { return JSON.parse(JSON.stringify(config)); },
    get on() { return config.on; },
    setOn, setStyle, reset, refreshPaint,
    /** 원본 칠하기가 바뀌었을 때 (hook 이 부른다) */
    changed,
    destroy() {
      if (disposed) return;
      disposed = true;
      readEpoch++;
      cleanups.splice(0).reverse().forEach((f) => { try { f(); } catch { /* 이미 정리됨 */ } });
      delete w.__cxmVocabHighlight;
    },
  };
})();
