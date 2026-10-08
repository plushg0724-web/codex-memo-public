// @ts-check
// 공통 설정창의 단어장 요약 설정(모델·추론 강도·FAST·작성 지침)과 자동 판단 설정을 담당한다.
(function installModelPicker() {
  const VERSION = 8;
  const w = /** @type {any} */ (window);
  const DIALOG_ID = "cdx-label-settings";
  if (!window.codexLabels?.vocabularyRead) return;
  if (window.__cxmModelPicker === VERSION) {
    // Reinjecting the installed copy also cancels a different queued version.
    w.__cxmModelPickerPending?.cancel(); return;
  }
  // Legacy installations do not expose their observer cleanup. Leave those
  // intact until the next window load instead of creating competing watchers.
  const previous = w.__cxmModelPickerRuntime;
  if (window.__cxmModelPicker && !previous) return;
  if (previous?.destroy() === false) {
    // The open dialog keeps its drafts and pending saves. CDP injects only on
    // connect, so this copy installs itself once the settings dialog closes.
    // The latest injected copy wins, as with an immediate replacement.
    const waiting = w.__cxmModelPickerPending;
    if (waiting?.version === VERSION) return;
    waiting?.cancel();
    const watcher = new MutationObserver(() => {
      if (document.getElementById(DIALOG_ID)) return;
      entry.cancel(); installModelPicker();
    });
    /** @type {{version: number, cancel(): void}} */
    const entry = {version: VERSION, cancel() {
      watcher.disconnect();
      if (w.__cxmModelPickerPending === entry) delete w.__cxmModelPickerPending;
    }};
    w.__cxmModelPickerPending = entry;
    watcher.observe(document.body, {childList: true});
    return;
  }
  w.__cxmModelPickerPending?.cancel();
  window.__cxmModelPicker = VERSION;
  let disposed = false;
  const cleanups = /** @type {(() => void)[]} */ ([]);

  // 이미 열린 Codex 화면에서도 도우미의 현재 메서드를 사용할 수 있는 연결.
  let seq = Number(w.__cxmPickerSequence) || 0;
  /** @type {Map<number, {owner: AbortSignal, resolve: (value: any) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
  const pending = new Map();
  /** @type {Responder} */
  const responder = {
    resolve(id, ok, value) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id); clearTimeout(p.timer);
      ok ? p.resolve(value) : p.reject(new Error(typeof value === "string" && value || "요청을 처리하지 못했습니다."));
    },
  };
  window.__cxmPicker = responder;
  /** @param {HTMLElement} box @param {AbortSignal} owner @param {LabelsMethod} method @param {unknown[]} args */
  const request = (box, owner, method, args) => new Promise((resolve, reject) => {
    if (disposed || owner.aborted || !box.isConnected) { reject(new Error("설정 화면이 닫혔습니다.")); return; }
    const id = ++seq;
    w.__cxmPickerSequence = seq;
    const timer = setTimeout(() => responder.resolve(id, false, "응답이 없습니다. 설정을 다시 불러와 확인해 주세요."), 30000);
    pending.set(id, {owner, resolve, reject, timer});
    try { window.__codexMemoBridge(JSON.stringify({op: "labels", cb: "__cxmPicker", id, method, args})); }
    catch { responder.resolve(id, false, "Codex 메모 도우미와 연결되지 않았습니다."); }
  });

  const WEB_MODEL = "chatgpt-web";
  const EFFORT_NAMES = {none: "없음", minimal: "최소", low: "낮음", medium: "중간", high: "높음", xhigh: "매우 높음", max: "최대", ultra: "울트라"};
  const WEB_EFFORT_NAMES = {none: "즉시 · Instant", medium: "보통 · Medium", high: "높음 · High", xhigh: "매우 높음 · Extra High"};
  const AUTO_ROWS = /** @type {const} */ ([
    ["label", "라벨 추천", "사이드바의 카테고리 추천에 필요한 확신"],
    ["status", "대화 상태", "답이 필요하거나 막힌 대화를 표시하는 기준"],
    ["memo", "메모 분류", "메모를 할 일·아이디어·질문·참고로 자동 분류하는 기준"],
    ["sense", "단어 뜻 판단", "저장된 뜻과 같은 뜻인지 바로 판단하는 기준"],
  ]);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    #cdx-label-settings .cxm-settings-model, #cdx-label-settings .cxm-settings-auto { margin-top: 20px; }
    #cdx-label-settings .cxm-setting-field { display: flex; flex-direction: column; gap: 7px; margin-bottom: 16px; max-width: 390px; font-size: 13px; }
    #cdx-label-settings .cxm-setting-field select { width: 100%; }
    #cdx-label-settings .cxm-setting-toggle { display: flex; align-items: center; gap: 8px; max-width: 390px; font-size: 13px; }
    #cdx-label-settings .cxm-setting-toggle input { width: 16px; height: 16px; margin: 0; accent-color: #7dd3fc; }
    #cdx-label-settings .cxm-setting-toggle small { color: #aeb5bf; }
    #cdx-label-settings .cxm-settings-guide { margin-top: 22px; max-width: 560px; }
    #cdx-label-settings .cxm-settings-guide textarea { width: 100%; min-height: 190px; resize: vertical; box-sizing: border-box; font: inherit; font-size: 12px; line-height: 1.55; padding: 8px; }
    #cdx-label-settings .cxm-guide-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 13px; margin-bottom: 7px; }
    #cdx-label-settings .cxm-guide-head output { color: #aeb5bf; font-size: 12px; font-variant-numeric: tabular-nums; }
    #cdx-label-settings .cxm-settings-note { margin-top: 8px; color: #aeb5bf; font-size: 12px; overflow-wrap: anywhere; }
    #cdx-label-settings .cxm-settings-note[data-error="true"] { color: #ffd4a5; }
    #cdx-label-settings .cxm-settings-retry { margin-top: 10px; }
    #cdx-label-settings .cxm-auto-setting { display: grid; grid-template-columns: 100px minmax(90px, 1fr) 45px; align-items: center; gap: 6px 12px; margin-top: 18px; }
    #cdx-label-settings .cxm-auto-setting input { min-height: 28px; border: 0; padding: 0; accent-color: #7dd3fc; }
    #cdx-label-settings .cxm-auto-setting output { text-align: right; font-variant-numeric: tabular-nums; }
    #cdx-label-settings .cxm-auto-setting small { grid-column: 1/-1; color: #aeb5bf; }
    #cdx-label-settings .cxm-auto-setting-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; }
    @media(max-width:540px) { #cdx-label-settings .cxm-auto-setting { grid-template-columns: 88px minmax(70px, 1fr) 40px; gap: 6px; } }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  cleanups.push(() => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter(value => value !== sheet); });

  /** @template {keyof HTMLElementTagNameMap} T @param {T} tag */
  function element(tag, className = "", text = "") {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  }
  function option(value, text, selected) {
    const node = element("option", "", text); node.value = value; node.selected = selected; return node;
  }
  function button(text, action) {
    const node = element("button", "", text); node.type = "button"; node.addEventListener("click", action); return node;
  }
  function message(note, text, error = false) {
    note.textContent = text; note.dataset.error = String(error); note.setAttribute("role", error ? "alert" : "status");
  }
  function busy(box, value) {
    box.dataset.settingsBusy = String(value); box.setAttribute("aria-busy", String(value));
    box.dispatchEvent(new Event("codex-labels:settings-busy", {bubbles: true}));
  }
  const errorText = error => error?.message || String(error);
  /** @param {HTMLElement} box */
  const locked = box => {
    const dialog = box.closest("dialog");
    return dialog?.getAttribute("aria-busy") === "true" || Boolean(dialog?.querySelector('[data-settings-busy="true"]'));
  };
  const refreshPages = () => window.dispatchEvent(new Event("cxm:auto-refresh"));
  const normalizeGuide = text => text.replace(/\r\n?/g, "\n").trim();
  /** @param {any} value @returns {value is ReasoningEffort} */
  const validEffort = value => typeof value === "string" && Object.hasOwn(EFFORT_NAMES, value);
  /** @param {any} value @returns {value is VocabModelChoice} */
  const validChoice = value => typeof value?.model === "string" && Boolean(value.model.trim()) && validEffort(value.effort) && typeof value.fast === "boolean";
  /** @param {any} values @returns {values is VocabModel[]} */
  const validModels = values => Array.isArray(values) && values.length > 0
    && new Set(values.map(value => value?.id)).size === values.length
    && values.every(value => typeof value?.id === "string" && Boolean(value.id.trim())
      && typeof value.name === "string" && Boolean(value.name.trim())
      && Array.isArray(value.efforts) && value.efforts.length > 0 && value.efforts.every(validEffort)
      && new Set(value.efforts).size === value.efforts.length
      && (value.fast === undefined || typeof value.fast === "boolean")
      && (value.defaultEffort === undefined || value.efforts.includes(value.defaultEffort)));
  /** @param {any} value @returns {value is VocabGuide} */
  const validGuide = value => typeof value?.guide === "string" && typeof value.defaultGuide === "string"
    && typeof value.custom === "boolean" && Number.isSafeInteger(value.limit) && value.limit > 0
    && value.guide.length <= value.limit && value.defaultGuide.length <= value.limit;
  /** @param {any} values @returns {values is AutoThresholds} */
  const validThresholds = values => values && AUTO_ROWS.every(([key]) => Number.isFinite(values[key]) && values[key] >= .3 && values[key] <= .99);

  // Each mounted section owns its requests and listeners. Closing the dialog
  // retires them immediately; late replies cannot touch a replacement dialog.
  const sections = new Map();
  /** @param {AbortSignal} owner */
  function cancelRequests(owner) {
    for (const [id, value] of pending) if (value.owner === owner) responder.resolve(id, false, "설정 화면의 요청이 종료됐습니다.");
  }
  /** @param {HTMLElement} box @param {HTMLElement} note @param {() => void} update */
  function section(box, note, update) {
    const listeners = new AbortController();
    /** @type {"idle" | "loading" | "saving"} */
    let phase = "idle";
    const active = () => !disposed && !listeners.signal.aborted && box.isConnected;
    const state = {
      active,
      blocked: () => !active() || phase !== "idle" || locked(box),
      /** @type {LabelsCall} */
      call: (method, ...args) => request(box, listeners.signal, method, args),
      /**
       * Keep load/save locking, error handling and busy cleanup in one place.
       * @param {"loading" | "saving"} nextPhase
       * @param {string} text
       * @param {() => Promise<any>} operation
       * @param {(value: any) => void} apply
       * @param {(error: any) => void} failure
       */
      async run(nextPhase, text, operation, apply, failure) {
        if (state.blocked()) return;
        phase = nextPhase;
        if (phase === "saving") busy(box, true);
        update(); message(note, text);
        try {
          const result = await operation();
          if (active()) apply(result);
        } catch (error) {
          if (active()) failure(error);
        } finally {
          cancelRequests(listeners.signal);
          phase = "idle";
          if (active()) {
            if (nextPhase === "saving") busy(box, false);
            update();
          }
        }
      },
      destroy() {
        if (listeners.signal.aborted) return;
        listeners.abort(); cancelRequests(listeners.signal);
        delete box.dataset.cxmSettingsVersion;
        delete box.dataset.settingsBusy;
        box.removeAttribute("aria-busy");
        if (dialog?.isConnected) dialog.dispatchEvent(new Event("codex-labels:settings-busy"));
      },
    };
    const dialog = box.closest("dialog");
    for (const name of ["codex-labels:settings-busy", "codex-labels:settings-unlocked"])
      dialog?.addEventListener(name, update, {signal: listeners.signal});
    sections.set(box, state);
    return state;
  }

  function mountModel(box) {
    box.replaceChildren();
    const modelSelect = element("select"), effortSelect = element("select");
    modelSelect.id = "cxm-settings-model-select"; effortSelect.id = "cxm-settings-effort-select";
    modelSelect.setAttribute("aria-label", "요약 모델"); effortSelect.setAttribute("aria-label", "추론 강도");
    const modelField = element("label", "cxm-setting-field", "요약 모델"); modelField.htmlFor = modelSelect.id; modelField.append(modelSelect);
    const effortField = element("label", "cxm-setting-field", "추론 강도"); effortField.htmlFor = effortSelect.id; effortField.append(effortSelect);
    const fastInput = element("input"); fastInput.type = "checkbox"; fastInput.id = "cxm-settings-fast";
    const fastHint = element("small");
    const fastField = element("label", "cxm-setting-toggle"); fastField.htmlFor = fastInput.id;
    fastField.append(fastInput, element("span", "", "FAST"), fastHint);
    const help = element("p", "cxm-settings-note", "추론 강도는 선택한 모델이 지원하는 값만 표시합니다. 변경하면 바로 저장됩니다.");
    const note = element("p", "cxm-settings-note"); note.setAttribute("aria-live", "polite");
    const retry = button("설정 다시 불러오기", () => load()); retry.className = "cxm-settings-retry"; retry.hidden = true;
    const guideBox = element("div", "cxm-settings-guide");
    box.append(modelField, effortField, fastField, help, note, retry, guideBox);
    /** @type {VocabModel[]} */
    let models = [];
    /** @type {VocabModelChoice | null} */
    let current = null;
    /** @type {Map<string, VocabModel>} */
    let modelIndex = new Map();
    const selectedModel = () => modelIndex.get(current?.model);
    // The helper always saves Web with FAST off, whatever its catalog entry says.
    const fastSupported = () => current?.model !== WEB_MODEL && selectedModel()?.fast !== false;
    const updateDisabled = () => {
      const blocked = state.blocked();
      modelSelect.disabled = blocked || !current;
      effortSelect.disabled = modelSelect.disabled || !selectedModel();
      fastInput.disabled = effortSelect.disabled || !fastSupported();
      retry.disabled = blocked;
    };
    const state = section(box, note, updateDisabled);
    function fill() {
      if (!current) return;
      modelSelect.replaceChildren(...models.map(model => option(model.id, model.name, model.id === current.model)));
      const selected = selectedModel();
      if (!selected) modelSelect.prepend(option(current.model, current.model + " · 현재 사용 가능 여부 확인 필요", true));
      const efforts = selected?.efforts || [current.effort];
      const names = current.model === WEB_MODEL ? WEB_EFFORT_NAMES : EFFORT_NAMES;
      effortSelect.replaceChildren(...efforts.map(effort => option(effort, names[effort] || effort, effort === current.effort)));
      if (!efforts.includes(current.effort)) {
        const unavailable = option(current.effort, (names[current.effort] || current.effort) + " · 현재 지원 안 됨", true);
        unavailable.disabled = true; effortSelect.prepend(unavailable);
      }
      fastInput.checked = current.fast;
      fastHint.textContent = fastSupported() ? "약 2배 빠름 · 사용량 증가" : "이 모델은 FAST를 지원하지 않습니다";
      help.textContent = current.model === WEB_MODEL
        ? "선택한 강도를 웹챗에 적용한 뒤 분석합니다. 변경하면 바로 저장되고 다음 분석부터 적용됩니다. Pro는 별도 실행 모드입니다."
        : "추론 강도는 선택한 모델이 지원하는 값만 표시합니다. 변경하면 바로 저장됩니다.";
      updateDisabled();
    }
    function load() {
      if (state.blocked()) return;
      retry.hidden = true;
      return state.run("loading", "모델 설정을 불러오는 중…",
        () => Promise.all([state.call("vocabularyModels"), state.call("vocabularyModel")]),
        ([list, selected]) => {
          if (!validModels(list) || !validChoice(selected)) throw Error("모델 설정 응답을 확인하지 못했습니다.");
          models = list; modelIndex = new Map(list.map(model => [model.id, model])); current = selected;
          fill(); message(note, "현재 설정입니다. 다음 요약부터 이 값이 적용됩니다.");
        }, error => { message(note, errorText(error), true); retry.hidden = false; });
    }
    /** @param {Partial<VocabModelChoice>} patch */
    function save(patch) {
      if (state.blocked() || !current) { fill(); return; }
      const previous = current;
      const expected = {...previous, ...patch};
      if (expected.model === WEB_MODEL) expected.fast = false;
      if (expected.model === previous.model && expected.effort === previous.effort && expected.fast === previous.fast) { fill(); return; }
      retry.hidden = true;
      return state.run("saving", "저장 중…",
        () => "fast" in patch ? state.call("vocabularySetFast", patch.fast) : state.call("vocabularySetModel", patch.model, patch.effort),
        result => {
          if (!validChoice(result) || result.model !== expected.model || result.effort !== expected.effort || result.fast !== expected.fast)
            throw Error("선택한 모델 설정의 저장을 확인하지 못했습니다. 다시 불러와 확인해 주세요.");
          current = result; fill(); message(note, "저장했습니다. 다음 요약부터 적용됩니다.");
        }, error => { current = previous; fill(); message(note, "저장을 확인하지 못해 이전 선택으로 표시합니다. " + errorText(error), true); retry.hidden = false; });
    }
    modelSelect.addEventListener("change", () => {
      const model = modelIndex.get(modelSelect.value);
      if (!model || !current) { fill(); return; }
      const effort = model.efforts.includes(current.effort) ? current.effort : model.efforts.includes(model.defaultEffort) ? model.defaultEffort : model.efforts[0];
      void save({model: model.id, effort});
    });
    effortSelect.addEventListener("change", () => { void save({model: modelSelect.value, effort: /** @type {ReasoningEffort} */ (effortSelect.value)}); });
    fastInput.addEventListener("change", () => { void save({fast: fastInput.checked}); });
    void load();
    mountGuide(guideBox);
  }

  // 요약 작성 지침: 뜻·쓰임·예문·태그를 어떻게 쓸지. 안전 문구와 JSON 출력 형식은 도우미가 고정으로 붙인다.
  function mountGuide(box) {
    const textarea = element("textarea"); textarea.id = "cxm-settings-guide-text"; textarea.spellcheck = false;
    const counter = element("output"); counter.htmlFor.value = textarea.id;
    const head = element("div", "cxm-guide-head"), title = element("label", "", "요약 작성 지침"); title.htmlFor = textarea.id;
    head.append(title, counter);
    const help = element("p", "cxm-settings-note", "뜻·쓰임·예문·태그를 어떻게 쓸지 정합니다. 출력 형식과 안전 문구는 자동으로 붙습니다. 다음 요약부터 적용됩니다.");
    const note = element("p", "cxm-settings-note"); note.setAttribute("aria-live", "polite");
    const saveButton = button("지침 저장", () => { void save(textarea.value); });
    const reset = button("기본 지침으로 복원", () => { void save(null); });
    const retry = button("지침 다시 불러오기", () => { void load(); }); retry.hidden = true;
    const actions = element("div", "cxm-auto-setting-actions"); actions.append(saveButton, reset, retry);
    box.replaceChildren(head, textarea, help, actions, note);
    /** @type {VocabGuide | null} */
    let current = null;
    const dirty = () => Boolean(current) && normalizeGuide(textarea.value) !== normalizeGuide(current.guide);
    function updateDisabled() {
      const blocked = state.blocked();
      textarea.disabled = blocked || !current;
      saveButton.disabled = textarea.disabled || !dirty() || !textarea.value.trim();
      reset.disabled = textarea.disabled || (!current?.custom && !dirty());
      retry.disabled = blocked;
    }
    const state = section(box, note, updateDisabled);
    function count() {
      counter.textContent = current ? `${textarea.value.length} / ${current.limit}자${current.custom ? "" : " · 기본 지침"}` : "";
      updateDisabled();
    }
    textarea.addEventListener("input", count);
    function load() {
      if (state.blocked()) return;
      const preserveDraft = dirty();
      retry.hidden = true;
      return state.run("loading", "작성 지침을 불러오는 중…", () => state.call("vocabularyGuide"), result => {
        if (!validGuide(result)) throw Error("작성 지침 응답을 확인하지 못했습니다.");
        current = result;
        if (!preserveDraft) textarea.value = result.guide;
        textarea.maxLength = result.limit; count();
        message(note, preserveDraft ? "저장된 지침을 확인했습니다. 편집 중인 내용은 그대로 두었습니다." : "");
      }, error => { message(note, errorText(error), true); retry.hidden = false; });
    }
    /** @param {string | null} text null 이면 기본 지침으로 되돌린다 */
    function save(text) {
      if (state.blocked() || !current) return;
      retry.hidden = true;
      return state.run("saving", "저장 중…", () => state.call("vocabularySetGuide", text), result => {
        if (!validGuide(result) || (text == null ? result.custom || result.guide !== result.defaultGuide : result.guide !== normalizeGuide(text)))
          throw Error("작성 지침의 저장을 확인하지 못했습니다. 다시 불러와 확인해 주세요.");
        current = result; textarea.value = result.guide; textarea.maxLength = result.limit; count();
        message(note, text == null ? "기본 지침으로 되돌렸습니다. 다음 요약부터 적용됩니다." : "저장했습니다. 다음 요약부터 적용됩니다.");
      }, error => { message(note, "저장을 확인하지 못했습니다. 입력한 내용은 그대로 둡니다. " + errorText(error), true); retry.hidden = false; });
    }
    void load();
  }

  function mountAutomation(box) {
    box.replaceChildren();
    const classifier = element("p", "cxm-settings-note");
    const note = element("p", "cxm-settings-note"); note.setAttribute("aria-live", "polite");
    /** @type {Record<string, HTMLInputElement>} */
    const inputs = {};
    /** @type {Record<string, HTMLOutputElement>} */
    const outputs = {};
    /** @type {AutoThresholds | null} */
    let current = null, defaults = null;
    box.append(classifier);
    for (const [key, name, help] of AUTO_ROWS) {
      const row = element("label", "cxm-auto-setting cxm-auto-row"), input = element("input"), output = element("output", "", "–");
      input.id = "cxm-settings-threshold-" + key; row.htmlFor = input.id;
      Object.assign(input, {type: "range", min: "30", max: "99", step: "1"});
      input.setAttribute("aria-label", name); output.htmlFor.value = input.id;
      input.addEventListener("input", () => { output.textContent = `${input.value}%`; input.setAttribute("aria-valuetext", `${input.value}%`); });
      input.addEventListener("change", () => { void save({[key]: Number(input.value) / 100}); });
      inputs[key] = input; outputs[key] = output;
      row.append(element("span", "", name), input, output, element("small", "", help)); box.append(row);
    }
    const reset = button("기본값으로 복원", () => { if (defaults) void save(defaults); });
    const rejudge = button("다시 판단", () => { void refresh(); }); rejudge.title = "기억한 라벨 추천과 대화 상태 판단을 비우고 새로 판단합니다.";
    const retry = button("설정 다시 불러오기", () => { void load(); }); retry.hidden = true;
    const actions = element("div", "cxm-auto-setting-actions cxm-auto-actions"); actions.append(reset, rejudge, retry); box.append(actions, note);
    function updateDisabled() {
      const blocked = state.blocked();
      for (const input of Object.values(inputs)) input.disabled = blocked || !current;
      reset.disabled = blocked || !defaults; rejudge.disabled = blocked || !current; retry.disabled = blocked;
    }
    const state = section(box, note, updateDisabled);
    function fill() {
      if (!current) return;
      for (const [key] of AUTO_ROWS) { inputs[key].value = String(Math.round(current[key] * 100)); outputs[key].textContent = `${inputs[key].value}%`; inputs[key].setAttribute("aria-valuetext", outputs[key].textContent); }
    }
    function load() {
      if (state.blocked()) return;
      retry.hidden = true;
      return state.run("loading", "자동 판단 설정을 불러오는 중…", () => state.call("autoSettings"), result => {
        if (!validThresholds(result?.thresholds) || !validThresholds(result?.defaults) || typeof result.mode !== "string" || typeof result.available !== "boolean")
          throw Error("자동 판단 설정 응답을 확인하지 못했습니다.");
        current = {...result.thresholds}; defaults = {...result.defaults}; fill();
        classifier.textContent = `판단 도구: ${{mica: "Mica", jev: "JEV", both: "Mica + JEV"}[result.mode] || result.mode} · ${result.available ? "사용 가능" : "현재 사용할 수 없음"}`;
        message(note, "값이 높을수록 확신이 높은 결과만 표시하거나 분류합니다.");
      }, error => { message(note, errorText(error), true); retry.hidden = false; });
    }
    /** @param {Partial<AutoThresholds>} patch */
    function save(patch) {
      if (state.blocked() || !current) { fill(); return; }
      if (Object.entries(patch).every(([key, value]) => Math.abs(current[key] - value) < .000001)) { fill(); return; }
      retry.hidden = true;
      return state.run("saving", "저장 중…", () => state.call("thresholdsSet", patch), result => {
        if (!validThresholds(result) || Object.entries(patch).some(([key, value]) => Math.abs(result[key] - value) > .000001))
          throw Error("변경한 기준의 저장을 확인하지 못했습니다. 다시 불러와 확인해 주세요.");
        current = {...result}; fill(); refreshPages(); message(note, "저장했습니다. 변경한 기준을 적용했습니다.");
      }, error => { fill(); message(note, "저장을 확인하지 못해 이전 값으로 표시합니다. " + errorText(error), true); retry.hidden = false; });
    }
    function refresh() {
      if (state.blocked() || !current) return;
      return state.run("saving", "기억한 판단을 새로 고치는 중…", () => state.call("autoRefresh"), result => {
        if (result !== true) throw Error("판단 초기화를 확인하지 못했습니다.");
        refreshPages(); message(note, "기억한 판단을 비웠습니다. 라벨 추천·대화 상태를 다시 판단합니다.");
      }, error => { message(note, "다시 판단하지 못했습니다. " + errorText(error), true); });
    }
    void load();
  }

  function retireDetached() {
    let changed = false;
    for (const [box, state] of sections) if (!box.isConnected) { state.destroy(); sections.delete(box); changed = true; }
    if (changed && cxm) {
      // MutationObserver has no unobserve(): rebuild its narrow subscriptions
      // so it does not retain every dialog opened during a long app session.
      observer.disconnect(); observer.observe(document.body, {childList: true});
      observedDialogs = new WeakSet();
      for (const box of sections.keys()) {
        const dialog = box.closest("dialog");
        if (dialog && !observedDialogs.has(dialog)) {
          observer.observe(dialog, {childList: true, subtree: true}); observedDialogs.add(dialog);
        }
      }
    }
  }
  // With common.js installed, observe removals at the body and changes only
  // inside settings dialogs. Chat streaming never triggers a document scan.
  const cxm = /** @type {any} */ (window).__cxm;
  // scan() retires detached sections first, including on removal-only records.
  const observer = new MutationObserver(records => {
    scan(records.flatMap(record => [...record.addedNodes].filter(node => node instanceof Element)));
  });
  observer.observe(document.body, {childList: true, subtree: !cxm});
  cleanups.push(() => observer.disconnect());
  /** @type {WeakSet<Element>} */
  let observedDialogs = new WeakSet();
  const SECTIONS = ".cxm-settings-model, .cxm-settings-auto";
  /** @param {Node[]} roots */
  function scan(roots = [document]) {
    if (disposed) return;
    retireDetached();
    for (const root of roots) {
      if (!root.isConnected) continue;
      // Only an added subtree can hold new sections. Nodes added inside an open
      // dialog (options, label previews) never re-query the whole dialog.
      const inside = root instanceof Element ? root.closest("#" + DIALOG_ID) : null;
      const dialog = inside || (root instanceof Element ? root.querySelector("#" + DIALOG_ID)
        : root === document ? document.getElementById(DIALOG_ID) : null);
      if (!dialog) continue;
      if (cxm && !observedDialogs.has(dialog)) {
        observer.observe(dialog, {childList: true, subtree: true}); observedDialogs.add(dialog);
      }
      const scope = inside ? /** @type {Element} */ (root) : dialog;
      for (const box of scope.matches(SECTIONS) ? [scope] : scope.querySelectorAll(SECTIONS)) {
        const node = /** @type {HTMLElement} */ (box);
        if (node.dataset.cxmSettingsVersion === String(VERSION)) continue;
        node.dataset.cxmSettingsVersion = String(VERSION);
        (node.classList.contains("cxm-settings-model") ? mountModel : mountAutomation)(node);
      }
    }
  }
  if (cxm) cleanups.push(cxm.watch({ added: scan }));
  w.__cxmModelPickerRuntime = {
    destroy() {
      if (disposed) return true;
      // Keep an open dialog, its unsaved guide and pending saves intact. The
      // newer copy waits for the dialog to close and then retries this call.
      if (document.getElementById(DIALOG_ID)) return false;
      disposed = true;
      for (const state of sections.values()) state.destroy();
      sections.clear();
      for (const id of pending.keys()) responder.resolve(id, false, "설정 화면이 다시 불러와졌습니다.");
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
      if (window.__cxmPicker === responder) delete window.__cxmPicker;
      delete window.__cxmModelPicker;
      delete w.__cxmModelPickerRuntime;
      return true;
    },
  };
  scan();
})();
