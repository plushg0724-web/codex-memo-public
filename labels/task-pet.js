// @ts-check
// 저장된 메모·진행 상태와 대화의 마지막 답변을 읽어 다음 할 일을 제안하는 작은 화면 펫.
// v9: 지난 결과를 바로 보이고 뒤에서 다시 확인한다. 모델 설명은 나중에 채운다. 펫이 할 일 수와 표정으로 상태를 알린다.
// 패널 위쪽 전환으로 '업무 진척'(task-progress.js, JSON 수동 동기화) 보기를 연다.
(() => {
  const VERSION = 9;
  const w = /** @type {any} */ (window);
  const initialRoute = new URLSearchParams(location.search).get('initialRoute') || '';
  if (/^\/(?:hotkey-window|avatar-overlay)(?:\/|$)/.test(initialRoute)
      || (location.protocol === 'app:' && !['/index.html', '/detached-window.html'].includes(location.pathname))) return;
  if (w.__cxmTaskPet?.version === VERSION && document.getElementById('cxm-task-pet')) return;
  try { w.__cxmTaskPet?.destroy(); } catch { /* 이전 주입 정리 */ }
  const cleanups = [];
  const on = (target, name, fn, options = /** @type {boolean | AddEventListenerOptions} */ (false)) => {
    target.addEventListener(name, fn, options);
    cleanups.push(() => target.removeEventListener(name, fn, options));
  };
  const el = (tag, cls = '', text = '') => {
    const node = document.createElement(tag);
    node.className = cls;
    node.textContent = text;
    return node;
  };
  const button = (cls, text, label = text) => {
    const node = /** @type {HTMLButtonElement} */ (el('button', cls, text));
    node.type = 'button'; node.setAttribute('aria-label', label);
    return node;
  };
  const HIDE_KEY = 'cxm-task-pet-hidden-until';
  const POSITION_KEY = 'cxm-task-pet-position';
  // 넘긴 카드: id → 그때의 근거 지문(v). 이 PC 에 남겨, 새 답변·메모·라벨 변경으로 근거가 바뀌기 전까지 다시 보이지 않는다.
  const DISMISS_KEY = 'cxm-task-pet-skipped';
  const DISMISS_DAYS = 30;
  const RESULT_KEY = 'cxm-task-pet-result';
  const UUID = /^(?:local:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  const SIZE = 46;                       // 펫 크기 (px). 마우스를 올리면 커진다.
  const FRESH_MS = 3 * 60 * 1000;        // 이보다 오래된 결과는 패널을 열 때 뒤에서 다시 확인한다
  // 닫혀 있을 때의 자동 확인 (모델 설명 없이 순위만). 테스트는 window.__cxmTaskPetAuto 로 끄거나 줄인다.
  const auto = () => {
    const custom = w.__cxmTaskPetAuto;
    if (custom === false) return null;
    return { prefetch: 8000, debounce: 20000, minGap: 60000, ...(custom && typeof custom === 'object' ? custom : {}) };
  };
  let destroyed = false, isOpen = false, requested = false, stale = false, advising = false, unseen = false;
  let generation = 0, wakeTimer = 0, layoutFrame = 0, preparingEpoch = 0, autoTimer = 0, lastRun = 0;
  let opening = false, tabLeaving = false, tabTimer = 0, sleeping = false;
  /** @type {any} */
  let result = null;
  /** @type {Set<string>} 바로 앞 결과의 후보. 새로 들어온 카드를 표시한다. */
  let previousIds = new Set();
  /** @type {Map<string, {v: string, at: number}>} */
  const dismissed = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}');
    const oldest = Date.now() - DISMISS_DAYS * 86400000;
    for (const [id, entry] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
      if (typeof id === 'string' && typeof entry?.v === 'string' && Number(entry.at) > oldest) dismissed.set(id, { v: entry.v, at: Number(entry.at) });
    }
  } catch { /* 저장이 막혀도 화면 기능은 유지 */ }
  try { sessionStorage.removeItem('cxm-task-pet-dismissed'); } catch { /* v8 까지의 탭 단위 기록 */ }
  // 근거 지문이 없는 예전 카드는 id 로만 뺀다.
  const isSkipped = (item) => { const entry = dismissed.get(item.id); return Boolean(entry && (!entry.v || !item.version || entry.v === item.version)); };
  const skipRequest = () => ({
    dismissedIds: [...dismissed].filter(([, e]) => !e.v).map(([id]) => id),
    dismissed: Object.fromEntries([...dismissed].filter(([, e]) => e.v).map(([id, e]) => [id, e.v])),
  });
  // 화면을 새로 고쳐도 지난 추천을 바로 보인다. 같은 탭 세션에만 둔다.
  try {
    const saved = JSON.parse(sessionStorage.getItem(RESULT_KEY) || 'null');
    if (saved?.status === 'ok' && Array.isArray(saved.items)) { result = saved; requested = true; previousIds = new Set(saved.items.map((x) => x?.id)); }
  } catch { /* 저장 제한 */ }

  const root = el('div'); root.id = 'cxm-task-pet'; root.dataset.phase = 'idle'; root.dataset.mood = 'normal';
  const style = document.createElement('style');
  style.id = 'cxm-task-pet-style';
  // Codex 테마 클래스가 OS 설정과 다를 수 있으므로 경고·확신 색도 같은 토큰으로 바꾼다.
  const LIGHT = `--pet-bg:#fffef9; --pet-ink:#253d35; --pet-muted:#60766b; --pet-line:#dfebe3;
      --pet-card:#f3f8f2; --pet-card-hover:#e9f3ea; --pet-mint:#d9eee0; --pet-accent:#29624b; --pet-shadow:0 14px 48px #163c2926;
      --pet-warn-bg:#fff1d6; --pet-warn-ink:#745322; --pet-ready:#3f9a72; --pet-alert:#e4af55; --pet-new:#3f9a72; color-scheme:light;`;
  const DARK = `--pet-bg:#202d28; --pet-ink:#e4ede6; --pet-muted:#a8b9ae; --pet-line:#3b4f43;
      --pet-card:#27392f; --pet-card-hover:#2e4337; --pet-mint:#334e40; --pet-accent:#a6d8b9; --pet-shadow:0 14px 48px #0007;
      --pet-warn-bg:#4b3c26; --pet-warn-ink:#ecd6ae; --pet-ready:#7fd0a6; --pet-alert:#e4af55; --pet-new:#7fd0a6; color-scheme:dark;`;
  style.textContent = `
    #cxm-task-pet { ${LIGHT}
      position:fixed; right:18px; top:64px; z-index:2147483000; width:${SIZE}px; pointer-events:none;
      color:var(--pet-ink); font:12px/1.55 'Pretendard','Malgun Gothic',system-ui,sans-serif; color-scheme:light; }
    #cxm-task-pet *, #cxm-task-pet *::before, #cxm-task-pet *::after { box-sizing:border-box; }
    #cxm-task-pet [hidden] { display:none !important; }
    #cxm-task-pet button { font:inherit; border:0; cursor:pointer; color:inherit; -webkit-app-region:no-drag; }
    #cxm-task-pet button:focus-visible { outline:3px solid #53a78a; outline-offset:2px; }
    #cxm-task-pet .cxm-pet-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
    #cxm-task-pet .cxm-pet-launcher { position:relative; pointer-events:auto; display:grid; place-items:center;
      width:${SIZE}px; height:${SIZE + 2}px; padding:0; border-radius:17px; background:transparent;
      transform-origin:top right; transition:transform .18s ease; cursor:grab; touch-action:none; }
    #cxm-task-pet .cxm-pet-launcher:hover, #cxm-task-pet .cxm-pet-launcher:focus-visible { transform:scale(1.25); }
    #cxm-task-pet[data-dragging] .cxm-pet-launcher { cursor:grabbing; transform:scale(1.1); transition:none; }
    #cxm-task-pet .cxm-pet-launcher[aria-expanded=true] { background:var(--pet-mint); }
    #cxm-task-pet .cxm-pet-launcher svg { width:${SIZE - 2}px; height:${SIZE - 2}px; overflow:visible; filter:drop-shadow(0 2px 2px #214a3022); }
    #cxm-task-pet[data-phase=loading][data-fg] .cxm-pet-launcher svg { animation:cxm-pet-think 1.1s ease-in-out infinite alternate; }
    #cxm-task-pet .cxm-pet-launcher svg .m { display:none; }
    #cxm-task-pet[data-mood=normal] svg .m-normal, #cxm-task-pet[data-mood=sleep] svg .m-sleep,
    #cxm-task-pet[data-mood=alert] svg .m-alert, #cxm-task-pet[data-mood=worry] svg .m-worry { display:inline; }
    #cxm-task-pet[data-mood=sleep] .cxm-pet-launcher:not(:hover) svg { opacity:.72; }
    #cxm-task-pet .cxm-pet-count { position:absolute; right:-3px; top:-2px; min-width:17px; height:17px; padding:0 4px;
      border-radius:999px; background:var(--pet-accent); color:var(--pet-bg); border:2px solid var(--pet-bg);
      font:700 10px/13px inherit; font-family:inherit; font-size:10px; font-weight:700; text-align:center; }
    #cxm-task-pet .cxm-pet-count[data-kind=urgent] { background:var(--pet-alert); color:#3b2a0b; }
    #cxm-task-pet .cxm-pet-count[data-kind=stale] { background:var(--pet-muted); }
    #cxm-task-pet .cxm-pet-count[data-new]::after { content:''; position:absolute; inset:-4px; border-radius:inherit;
      border:2px solid var(--pet-new); animation:cxm-pet-ping 1.6s ease-out 3; opacity:0; }
    #cxm-task-pet .cxm-pet-wake { pointer-events:auto; display:grid; place-items:center; width:30px; height:22px; margin-left:auto;
      border-radius:999px; background:var(--pet-mint); color:var(--pet-accent); font-size:12px; opacity:.6;
      box-shadow:0 2px 8px #163c2926; transition:opacity .15s ease; }
    #cxm-task-pet .cxm-pet-wake:hover, #cxm-task-pet .cxm-pet-wake:focus-visible { opacity:1; }
    #cxm-task-pet .cxm-pet-panel { position:absolute; pointer-events:auto; width:min(340px,calc(100vw - 24px));
      right:0; top:${SIZE + 8}px; overflow:auto; overscroll-behavior:contain; scrollbar-width:thin;
      border:1px solid var(--pet-line); border-radius:16px; background:var(--pet-bg); box-shadow:var(--pet-shadow);
      padding:12px 12px 10px; animation:cxm-pet-enter .16s ease-out; }
    #cxm-task-pet .cxm-pet-panel[data-side=left] { right:auto; left:0; }
    #cxm-task-pet .cxm-pet-head { display:flex; align-items:center; gap:2px; margin:0 0 8px; }
    #cxm-task-pet .cxm-pet-titles { flex:1; min-width:0; display:flex; align-items:baseline; gap:7px; }
    #cxm-task-pet h2 { font-family:inherit; font-size:14px; font-weight:700; line-height:1.4; margin:0; white-space:nowrap; }
    #cxm-task-pet .cxm-pet-time { font-size:10px; color:var(--pet-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    #cxm-task-pet .cxm-pet-icon { display:grid; place-items:center; width:26px; height:26px; padding:0; border-radius:7px;
      background:transparent; color:var(--pet-muted); font-size:14px; line-height:1; }
    #cxm-task-pet .cxm-pet-icon:hover { background:var(--pet-mint); color:var(--pet-accent); }
    #cxm-task-pet .cxm-pet-icon[aria-expanded=true] { background:var(--pet-mint); color:var(--pet-accent); }
    #cxm-task-pet .cxm-pet-icon:disabled { cursor:wait; }
    #cxm-task-pet .cxm-pet-refresh[data-busy] span { display:inline-block; animation:cxm-pet-spin .9s linear infinite; }
    #cxm-task-pet .cxm-pet-close { font-size:18px; }
    #cxm-task-pet .cxm-pet-views { display:flex; gap:3px; margin:0 0 9px; padding:3px; background:var(--pet-card); border-radius:9px; }
    #cxm-task-pet .cxm-pet-view { flex:1; padding:4px 6px; border-radius:7px; background:transparent; color:var(--pet-muted); font-size:11.5px; }
    #cxm-task-pet .cxm-pet-view[aria-pressed=true] { background:var(--pet-bg); color:var(--pet-accent); font-weight:700; box-shadow:0 1px 3px #163c2918; }
    #cxm-task-pet .cxm-pet-rules { margin:0 0 10px; padding:8px 10px; border-radius:9px; background:var(--pet-card); font-size:10.5px; color:var(--pet-muted); }
    #cxm-task-pet .cxm-pet-rules b { color:var(--pet-ink); }
    #cxm-task-pet .cxm-pet-rules ol { margin:4px 0 0; padding-left:17px; }
    #cxm-task-pet .cxm-pet-rules p { margin:4px 0 0; }
    #cxm-task-pet .cxm-pet-live { color:var(--pet-muted); margin:4px 2px 8px; overflow-wrap:anywhere; }
    #cxm-task-pet .cxm-pet-stale { background:var(--pet-warn-bg); color:var(--pet-warn-ink); border-radius:8px; padding:6px 9px; margin:0 0 8px; font-size:11px; }
    #cxm-task-pet .cxm-pet-cards { display:grid; gap:6px; }
    #cxm-task-pet .cxm-pet-card { position:relative; border:1px solid var(--pet-line); border-radius:11px; background:var(--pet-card);
      padding:9px 11px 9px 12px; overflow-wrap:anywhere; transition:background .12s ease, box-shadow .3s ease; }
    #cxm-task-pet .cxm-pet-card[data-open]:hover { background:var(--pet-card-hover); }
    #cxm-task-pet .cxm-pet-card[data-urgent] { border-left:3px solid var(--pet-alert); padding-left:10px; }
    #cxm-task-pet .cxm-pet-card[data-new] { box-shadow:0 0 0 2px var(--pet-new); }
    #cxm-task-pet .cxm-pet-meta { display:flex; flex-wrap:wrap; align-items:center; gap:5px; color:var(--pet-muted); font-size:10px; padding-right:20px; }
    #cxm-task-pet .cxm-pet-key { display:inline-grid; place-items:center; min-width:15px; height:15px; border-radius:4px;
      border:1px solid var(--pet-line); background:var(--pet-bg); font-size:9px; font-weight:700; color:var(--pet-muted); }
    #cxm-task-pet .cxm-pet-badge { background:var(--pet-mint); color:var(--pet-accent); border-radius:999px; padding:0 7px; font-weight:700; }
    #cxm-task-pet .cxm-pet-card[data-urgent] .cxm-pet-badge { background:var(--pet-warn-bg); color:var(--pet-warn-ink); }
    #cxm-task-pet .cxm-pet-card h3 { font-family:inherit; font-size:13px; font-weight:700; line-height:1.4; margin:3px 0 2px; }
    #cxm-task-pet .cxm-pet-open { background:transparent; padding:0; text-align:left; font-weight:inherit; }
    #cxm-task-pet .cxm-pet-open::after { content:''; position:absolute; inset:0; border-radius:inherit; }
    #cxm-task-pet .cxm-pet-open:focus-visible { outline:none; }
    #cxm-task-pet .cxm-pet-card:has(.cxm-pet-open:focus-visible) { outline:3px solid #53a78a; outline-offset:1px; }
    #cxm-task-pet .cxm-pet-quote { margin:0 0 3px; padding:0 0 0 7px; border-left:2px solid var(--pet-line); color:var(--pet-muted);
      font-size:11px; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
    #cxm-task-pet .cxm-pet-quote-who { font-weight:700; color:var(--pet-ink); margin-right:5px; }
    #cxm-task-pet .cxm-pet-action { margin:0; font-size:11.5px; }
    #cxm-task-pet .cxm-pet-action[data-pending] { color:var(--pet-muted); }
    #cxm-task-pet .cxm-pet-by { color:var(--pet-muted); font-size:9.5px; margin-left:4px; }
    #cxm-task-pet .cxm-pet-skip { position:absolute; z-index:1; right:5px; top:5px; width:22px; height:22px; padding:0; border-radius:6px;
      background:transparent; color:var(--pet-muted); font-size:14px; line-height:1; opacity:0; transition:opacity .12s ease; }
    #cxm-task-pet .cxm-pet-card:hover .cxm-pet-skip, #cxm-task-pet .cxm-pet-card:focus-within .cxm-pet-skip { opacity:1; }
    #cxm-task-pet .cxm-pet-skip:hover { background:var(--pet-mint); color:var(--pet-ink); }
    #cxm-task-pet .cxm-pet-foot { margin-top:8px; display:flex; justify-content:space-between; align-items:center; gap:5px;
      color:var(--pet-muted); font-size:10px; }
    #cxm-task-pet .cxm-pet-foot-actions { display:flex; align-items:center; gap:2px; margin-left:auto; }
    #cxm-task-pet .cxm-pet-hide, #cxm-task-pet .cxm-pet-restore { background:transparent; color:var(--pet-muted); padding:3px 4px; font-size:10px; border-radius:5px; }
    #cxm-task-pet .cxm-pet-hide:hover, #cxm-task-pet .cxm-pet-restore:hover { color:var(--pet-ink); }
    #cxm-task-pet .cxm-pet-restore { text-decoration:underline; text-underline-offset:2px; padding-left:0; }
    @keyframes cxm-pet-enter { from { opacity:0; transform:translateY(-5px); } to { opacity:1; transform:translateY(0); } }
    @keyframes cxm-pet-think { from { transform:translateY(0) rotate(0); } to { transform:translateY(-3px) rotate(4deg); } }
    @keyframes cxm-pet-spin { to { transform:rotate(360deg); } }
    @keyframes cxm-pet-ping { 0% { opacity:.9; transform:scale(.8); } 100% { opacity:0; transform:scale(1.5); } }
    @media (prefers-reduced-motion:reduce) { #cxm-task-pet *, #cxm-task-pet *::before, #cxm-task-pet *::after { animation:none !important; transition:none !important; } }
    @media (max-width:480px) { #cxm-task-pet { right:12px; top:56px; } }
    @media (prefers-color-scheme:dark) { #cxm-task-pet { ${DARK} } }
    html.dark #cxm-task-pet, [data-theme=dark] #cxm-task-pet { ${DARK} }
    html.light #cxm-task-pet, [data-theme=light] #cxm-task-pet { ${LIGHT} }
  `;
  const LAUNCHER_LABEL = '메모 펫 · 다음 할 일 추천 열기';
  const launcher = button('cxm-pet-launcher', '', LAUNCHER_LABEL);
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'cxm-task-pet-panel');
  launcher.setAttribute('aria-haspopup', 'dialog');
  launcher.title = '메모 펫 · 눌러서 다음 할 일 보기 (Ctrl+Alt+P) · 끌어서 옮기기';
  // 고정 그림만 SVG로 만든다. 표정(.m-*)은 root 의 data-mood 로 고른다. 추천 문구·메모는 textContent로 넣는다.
  launcher.innerHTML = `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="32" cy="58" rx="21" ry="3" fill="#244834" opacity=".1"/>
    <path d="M49 48q12-5 9-15" fill="none" stroke="#91c6ac" stroke-width="6" stroke-linecap="round"/>
    <path d="M16 28 13 10q1-4 5-1l11 9 11-1 8-9q3-3 5 1l-1 21q5 6 3 16-2 12-22 12S9 50 10 39q0-6 6-11Z" fill="#b9dfc6" stroke="#527e68" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="m17 14 2 12 8-5m21-7-7 8 8 4" fill="#f9eacc"/>
    <ellipse cx="32" cy="39" rx="19" ry="14" fill="#fff4db"/>
    <ellipse cx="20" cy="41" rx="3.5" ry="2" fill="#e8b8a5" opacity=".75"/><ellipse cx="44" cy="41" rx="3.5" ry="2" fill="#e8b8a5" opacity=".75"/>
    <path d="M28 18q-1-8 7-10 2 7-7 10" fill="#5b9e77"/><path d="m28 19 5-7" stroke="#365b42" stroke-width="1"/>
    <path d="M20 54h7m10 0h7" stroke="#527e68" stroke-width="2" stroke-linecap="round"/>
    <g class="m m-normal" stroke="#385c49" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 35q2-3 4 0m16 0q2-3 4 0" stroke-width="2.4"/><path d="m30 39 2 2 2-2m-6 5q4 3 8 0" stroke-width="1.5"/></g>
    <g class="m m-sleep" stroke="#385c49" fill="none" stroke-linecap="round">
      <path d="M19.5 35.5q2.5 1.6 5 0m15 0q2.5 1.6 5 0" stroke-width="2"/><path d="m30 39 2 2 2-2m-4 4.5q2 1 4 0" stroke-width="1.5"/>
      <path d="M50 4h5l-5 6h5m-12-2h3.5l-3.5 4h3.5" stroke="#6f9a84" stroke-width="1.4" stroke-linejoin="round"/></g>
    <g class="m m-alert" fill="#385c49">
      <circle cx="22" cy="34.5" r="2.7"/><circle cx="42" cy="34.5" r="2.7"/><circle cx="23" cy="33.6" r=".9" fill="#fff"/><circle cx="43" cy="33.6" r=".9" fill="#fff"/>
      <path d="m30 39 2 2 2-2" stroke="#385c49" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <ellipse cx="32" cy="45" rx="2.6" ry="2.1"/></g>
    <g class="m m-worry" stroke="#385c49" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 30.5l5-1.8m16 0 5 1.8" stroke-width="1.6"/><circle cx="22" cy="35" r="1.9" fill="#385c49" stroke="none"/><circle cx="42" cy="35" r="1.9" fill="#385c49" stroke="none"/>
      <path d="m30 39 2 2 2-2m-6 6q2-2 4 0t4 0" stroke-width="1.5"/></g>
  </svg>`;
  const count = el('span', 'cxm-pet-count'); count.hidden = true; count.setAttribute('aria-hidden', 'true'); launcher.append(count);
  // 숨긴 동안 남는 작은 손잡이. 누르면 바로 다시 보인다.
  const wake = button('cxm-pet-wake', '🐾', '메모 펫 다시 보이기'); wake.hidden = true;
  const panel = el('section', 'cxm-pet-panel'); panel.id = 'cxm-task-pet-panel'; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '메모 펫의 다음 할 일');
  panel.setAttribute('aria-modal', 'false'); panel.setAttribute('aria-busy', 'false');
  const head = el('div', 'cxm-pet-head');
  const titles = el('div', 'cxm-pet-titles');
  const time = el('span', 'cxm-pet-time');
  const title = el('h2', '', '다음 할 일');
  titles.append(title, time);
  const refresh = button('cxm-pet-icon cxm-pet-refresh', '', '추천 새로고침');
  refresh.append(el('span', '', '↻')); refresh.title = '다시 확인';
  const info = button('cxm-pet-icon', 'ⓘ', '추천 기준'); info.title = '추천 기준';
  info.setAttribute('aria-expanded', 'false'); info.setAttribute('aria-controls', 'cxm-task-pet-rules');
  const gear = button('cxm-pet-icon', '⚙', '펫 설정 열기'); gear.title = '펫 설정 (모델·개수·확신도)';
  gear.hidden = typeof w.__codexMemoBridge !== 'function';
  const close = button('cxm-pet-icon cxm-pet-close', '×', '추천 닫기');
  head.append(titles, refresh, info, gear, close);
  // 추천 순서를 화면에서 확인할 수 있게 한다. task-pet.cjs 의 STATES 순서와 같다. ⓘ 로 펼친다.
  const rules = el('div', 'cxm-pet-rules'); rules.id = 'cxm-task-pet-rules'; rules.hidden = true;
  const ruleList = el('ol');
  for (const line of ['Codex가 답을 기다리는 대화', '중간에 멈췄거나 오류로 끝난 대화', '권한·환경 문제로 막힌 대화',
    '할 일 메모가 있는 대화', '확인할 일이 남은 대화, ‘검토’ 라벨', '그 밖의 진행 상태 라벨']) ruleList.append(el('li', '', line));
  rules.append(el('b', '', '대화의 마지막 답변·진행 상태·할 일 메모 기준'), ruleList,
    el('p', '', '같은 순서면 최근 대화부터예요. 답 대기·막힘·남은 확인은 Mica가 마지막 답변을 읽고 판단해요.'),
    el('p', '', '완료·보류 라벨, 지금 열린 대화, Codex가 작업 중인 대화는 빼고, 라벨 없는 대화는 최근 3일 것만 봐요.'),
    el('p', '', '숫자 키 1~6으로 카드를 바로 열고, Ctrl+Alt+P로 펫을 열고 닫아요.'));
  const live = el('p', 'cxm-pet-live'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
  const staleNote = el('p', 'cxm-pet-stale', '그사이 대화나 메모·진행 상태가 바뀌었어요. ↻로 다시 확인해 주세요.'); staleNote.hidden = true;
  const cards = el('div', 'cxm-pet-cards');
  const foot = el('div', 'cxm-pet-foot');
  const hide = button('cxm-pet-hide', '30분 숨기기', '잠시 숨기기 · 30분');
  const restore = button('cxm-pet-restore', ''); restore.hidden = true;
  const home = button('cxm-pet-hide', '위치 되돌리기', '펫을 원래 위치로 되돌리기'); home.hidden = true;
  const footActions = el('div', 'cxm-pet-foot-actions'); footActions.append(home, hide);
  foot.append(restore, footActions);
  // 보기 전환: 다음 할 일(추천) ↔ 업무 진척. 진척 화면은 처음 고를 때 만든다.
  const views = el('div', 'cxm-pet-views'); views.setAttribute('role', 'group'); views.setAttribute('aria-label', '펫 보기');
  const recommendations = button('cxm-pet-view', '다음 할 일'); recommendations.setAttribute('aria-pressed', 'true');
  const progressButton = button('cxm-pet-view', '업무 진척'); progressButton.setAttribute('aria-pressed', 'false');
  views.append(recommendations, progressButton);
  const recommendationView = el('div'); recommendationView.append(rules, staleNote, live, cards);
  const progressView = el('div'); progressView.hidden = true;
  /** @type {{destroy: () => void} | null} */
  let progressPanel = null;
  let progressActive = false;
  panel.append(head, views, recommendationView, progressView, foot); root.append(launcher, wake, panel);

  // ------------------------------------------------------------ 위치: 끌어서 옮기고 기억한다 (오른쪽·위 기준 px)
  /** @type {{right: number, top: number} | null} */
  let position = null;
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
    if (Number.isFinite(saved?.right) && Number.isFinite(saved?.top)) position = { right: saved.right, top: saved.top };
  } catch { /* 저장이 막혀도 기본 위치 */ }
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  function placeRoot() {
    home.hidden = !position;
    if (!position) { root.style.right = ''; root.style.top = ''; return; }
    // 창 크기가 바뀌어도 펫이 화면 밖으로 나가지 않게 한다.
    root.style.right = `${clamp(position.right, 4, window.innerWidth - (SIZE + 4))}px`;
    root.style.top = `${clamp(position.top, 4, window.innerHeight - (SIZE + 6))}px`;
  }
  function savePosition() {
    try {
      if (position) localStorage.setItem(POSITION_KEY, JSON.stringify(position)); else localStorage.removeItem(POSITION_KEY);
    } catch { /* 저장 제한 */ }
  }
  function moveTo(next) {
    position = { right: clamp(next.right, 4, window.innerWidth - (SIZE + 4)), top: clamp(next.top, 4, window.innerHeight - (SIZE + 6)) };
    placeRoot(); scheduleLayout();
  }
  /** @type {{id: number, x: number, y: number, right: number, top: number, moved: boolean} | null} */
  let drag = null;
  let dragged = false;

  function layout() {
    if (destroyed || !isOpen || sleeping || !root.isConnected) return;
    // 펫을 왼쪽으로 옮겼으면 패널을 오른쪽으로 펼친다.
    const rect = root.getBoundingClientRect();
    if (rect.right < Math.min(352, window.innerWidth - 12)) panel.dataset.side = 'left'; else delete panel.dataset.side;
    const top = rect.top + SIZE + 8;
    let bottom = window.innerHeight - 12;
    // 화면 아래쪽 입력칸 앞에서 멈추어 추천을 펼쳐도 타이핑 공간을 덮지 않는다.
    for (const entry of document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')) {
      if (root.contains(entry)) continue;
      const rect = entry.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 16 && rect.bottom > window.innerHeight * .65)
        bottom = Math.min(bottom, rect.top - 12);
    }
    // 입력칸 앞에 패널 머리말조차 놓을 공간이 없으면 위쪽 여유 공간을 사용한다.
    const panelTop = bottom - top < 80 ? Math.max(8, Math.min(top, bottom - 160)) : top;
    panel.style.top = `${panelTop - root.getBoundingClientRect().top}px`;
    panel.style.maxHeight = `${Math.max(0, bottom - panelTop)}px`;
    if (bottom - panelTop < 48) closePanel(true);
  }
  function scheduleLayout() {
    if (destroyed || !isOpen || layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; layout(); });
  }
  function setPhase(phase) {
    root.dataset.phase = phase;
    const value = phase === 'loading';
    if (!progressActive) panel.setAttribute('aria-busy', String(value));
    refresh.disabled = value;
    if (value) refresh.dataset.busy = ''; else delete refresh.dataset.busy;
    renderTime();
  }
  // 상태 줄: 화면에 보일지(visible)와 화면 읽기 프로그램에 읽힐 내용을 함께 정한다.
  function say(text, visible = true) {
    live.textContent = text;
    live.classList.toggle('cxm-pet-sr', !visible || !text);
  }
  function visibleItems() {
    if (result?.status !== 'ok' || !Array.isArray(result.items)) return [];
    const current = currentThreadId();
    return result.items.filter((item) => item && typeof item.id === 'string' && !isSkipped(item)
      && (!current || UUID.exec(String(item.threadId || ''))?.[1] !== current)).slice(0, Math.min(6, Math.max(1, Number(result.limit) || 3)));
  }
  // 펫이 닫혀 있어도 보이는 신호: 할 일 수 배지와 표정. 급한 일(답 대기·멈춤·막힘)이 있으면 주황.
  function syncBadge() {
    const items = visibleItems();
    const urgent = items.filter((item) => URGENT.has(item.state)).length;
    const failed = ['unavailable', 'source_error'].includes(result?.status);
    count.hidden = !items.length;
    count.textContent = String(items.length);
    count.dataset.kind = stale ? 'stale' : urgent ? 'urgent' : 'normal';
    if (unseen && items.length) count.dataset.new = ''; else delete count.dataset.new;
    root.dataset.mood = failed ? 'worry' : !result ? 'normal' : !items.length ? 'sleep' : urgent ? 'alert' : 'normal';
    let note = '';
    if (items.length) note += ` · 할 일 ${items.length}개${urgent ? `, 급한 일 ${urgent}개` : ''}`;
    else if (failed) note += ' · 추천을 받지 못했어요';
    if (unseen) note += ' · 추천 준비됨';
    if (stale) note += ' · 다시 확인 필요';
    launcher.setAttribute('aria-label', LAUNCHER_LABEL + note);
  }
  function renderTime() {
    const checked = new Date(result?.checkedAt || '');
    const at = Number.isFinite(checked.getTime()) ? `${checked.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 확인` : '';
    time.textContent = root.dataset.phase === 'loading' ? (result ? '다시 확인 중…' : '살펴보는 중…')
      : advising ? [at, '설명 다듬는 중…'].filter(Boolean).join(' · ') : at;
  }
  function syncRestore() {
    // 엔진이 이번에 실제로 뺀 카드 + 화면에서 방금 넘긴 카드
    const hiddenNow = new Set(Array.isArray(result?.skipped) ? result.skipped.filter((id) => dismissed.has(id)) : []);
    for (const item of Array.isArray(result?.items) ? result.items : []) if (item && isSkipped(item)) hiddenNow.add(item.id);
    restore.hidden = progressActive || !hiddenNow.size;
    restore.textContent = `넘긴 후보 ${hiddenNow.size}개 다시 보기`;
    restore.setAttribute('aria-label', restore.textContent);
  }
  function saveDismissed() {
    try {
      const keep = [...dismissed].sort((a, b) => a[1].at - b[1].at).slice(-500);
      if (keep.length) localStorage.setItem(DISMISS_KEY, JSON.stringify(Object.fromEntries(keep)));
      else localStorage.removeItem(DISMISS_KEY);
    } catch { /* 세션 저장 제한 */ }
    syncRestore();
  }
  function closePanel(focus = false) {
    cancelAnimationFrame(layoutFrame); layoutFrame = 0;
    isOpen = false; panel.hidden = true; launcher.setAttribute('aria-expanded', 'false');
    if (focus && !sleeping) launcher.focus();
    if (stale) scheduleAuto();
  }
  function markStale() {
    if (destroyed || !requested) return;
    generation++; stale = true; advising = false; setPhase('stale');
    staleNote.hidden = false;
    // 안내 상자와 같은 말을 상태 줄에 반복하지 않는다.
    if (!result) say('');
    syncBadge(); scheduleAuto();
  }
  // 닫혀 있는 동안 바뀐 내용을 조용히 다시 확인한다 (모델 설명 없이 순위만). 연달아 바뀌면 한 번만, 최소 간격을 둔다.
  function scheduleAuto(delay) {
    const config = auto();
    if (!config || destroyed || sleeping || isOpen) return;
    clearTimeout(autoTimer);
    const gap = lastRun ? config.minGap - (Date.now() - lastRun) : 0;
    autoTimer = window.setTimeout(() => {
      autoTimer = 0;
      if (destroyed || sleeping || isOpen || root.dataset.phase === 'loading') return;
      if (document.visibilityState === 'hidden') return; // 다시 보일 때 visibilitychange 가 예약한다
      void suggest({ background: true });
    }, Math.max(delay ?? config.debounce, gap, 0));
  }
  // Codex uses an in-memory router: location.href stays /index.html. thread-open.js
  // (injected earlier) finds it, so a folded or virtualized recommendation still opens
  // without a document navigation/reload.
  const threads = () => w.__cxmThreads;
  function currentThreadId() {
    const path = threads()?.router?.()?.state?.location?.pathname;
    if (typeof path === 'string') {
      const match = /^\/local\/([^/]+)\/?$/.exec(path);
      return UUID.exec(match?.[1] || '')?.[1]?.toLowerCase() || null;
    }
    const row = document.querySelector('[data-app-action-sidebar-thread-selected="true"]');
    const host = row?.getAttribute('data-app-action-sidebar-thread-host-id');
    if (host && host !== 'local') return null;
    const id = row && (w.__cxm?.rowIdOf?.(row) || row.getAttribute('data-app-action-sidebar-thread-id'));
    return UUID.exec(id || '')?.[1]?.toLowerCase() || null;
  }
  let knownThread = currentThreadId();
  function threadChanged() {
    const current = currentThreadId();
    if (knownThread === current) return;
    knownThread = current;
    if (requested) { markStale(); if (result) render(); }
  }
  async function openThread(id) {
    if (opening || destroyed) return;
    const uuid = UUID.exec(typeof id === 'string' ? id : '')?.[1]?.toLowerCase();
    if (!uuid) { say('이 메모에는 연결된 대화가 없어요.'); return; }
    if (uuid === currentThreadId()) {
      threadChanged(); say('지금 열려 있는 대화예요. 다른 후보를 골라 주세요.'); return;
    }
    opening = true;
    const buttons = [...cards.querySelectorAll('button')];
    buttons.forEach((node) => { node.disabled = true; });
    say('대화를 열고 있어요…');
    try {
      // 보이는 이 PC 목록 줄 → 같은 대화로 가는 앱 링크 → 라우터 순서 (thread-open.js)
      const action = threads()?.opener?.(uuid);
      if (!action) {
        say('대화를 바로 열 수 없어요. 왼쪽 목록에서 해당 대화를 펼친 뒤 다시 눌러 주세요.');
        return;
      }
      // A click alone is not success. A blocked/no-op navigation keeps the
      // panel and its error visible instead of silently dismissing it.
      let failed = false;
      Promise.resolve(action()).catch(() => { failed = true; });
      for (let attempt = 0; attempt < 40 && !destroyed && !failed; attempt++) {
        if (currentThreadId() === uuid) { closePanel(); return; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!destroyed) say('대화가 열리지 않았어요. 잠시 후 다시 눌러 주세요.');
    } catch {
      if (!destroyed) say('대화가 열리지 않았어요. 잠시 후 다시 눌러 주세요.');
    } finally {
      opening = false;
      buttons.forEach((node) => { node.disabled = false; });
    }
  }
  const URGENT = new Set(['ask', 'interrupted', 'stalled', 'failed', 'blocked']);
  const QUOTED = { agent: 'Codex', request: '내 요청', memo: '메모' };
  function ago(seconds) {
    const at = Number(seconds) * 1000;
    if (!Number.isFinite(at) || at <= 0) return '';
    const minutes = Math.floor(Math.max(0, Date.now() - at) / 60000);
    if (minutes < 1) return '방금';
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}시간 전` : `${Math.floor(hours / 24)}일 전`;
  }
  function render() {
    cards.replaceChildren();
    const items = visibleItems();
    root.dataset.status = result?.status || 'idle';
    if (result?.status === 'unavailable') say('지금은 추천 도우미에 연결할 수 없어요. 잠시 후 ↻로 다시 확인해 주세요.');
    else if (result?.status === 'source_error') say('메모와 대화 목록을 읽지 못했어요. ↻로 다시 확인해 주세요.');
    else if (result?.status === 'empty') say('지금 손댈 대화가 없어요. 답을 기다리거나 멈춘 대화, 진행·검토 라벨, 할 일 메모가 생기면 알려 드릴게요.');
    else if (!result) say('');
    else if (!items.length) say(result?.items?.length
      ? '현재 대화와 넘긴 후보를 제외하면 남은 추천이 없어요.'
      : String(result?.message || '지금 권할 일을 고르지 못했어요. 잠시 후 다시 확인해 주세요.'));
    // 카드가 있으면 개수 안내는 화면 읽기 프로그램에만 알린다.
    else say(`${items.length}가지를 골랐어요. 위에서부터 먼저 해 볼 일이에요.`, false);
    // Mica·대화 읽기 실패처럼 판단 범위가 줄었을 때의 안내는 화면에도 보인다.
    if (result?.notice && ['ok', 'empty'].includes(result.status)) say(`${live.textContent} ${String(result.notice)}`.trim());
    renderTime(); syncBadge(); syncRestore();
    // 실패 응답에 잘못 섞여 온 이전 후보는 표시하지 않는다.
    if (result?.status !== 'ok') return;
    items.forEach((item, index) => {
      const card = el('article', 'cxm-pet-card'); card.dataset.id = item.id;
      card.dataset.state = String(item.state || '');
      if (URGENT.has(item.state)) card.dataset.urgent = '';
      if (previousIds.size && !previousIds.has(item.id)) card.dataset.new = '';
      // 번호·근거(배지·경과 시간·사용자 라벨) → 대화 → 실제 문장 → 할 일 순서로 보여 준다.
      const meta = el('div', 'cxm-pet-meta');
      const key = el('span', 'cxm-pet-key', String(index + 1)); key.title = `숫자 키 ${index + 1}로 열기`;
      const badge = String(item.badge || '다음 할 일');
      meta.append(key, el('span', 'cxm-pet-badge', badge));
      const age = ago(item.updatedAt);
      if (age) meta.append(el('span', '', age));
      if (item.labelName && String(item.labelName) !== badge) meta.append(el('span', '', `· ${String(item.labelName)}`));
      const title = String(item.title || '제목 없는 대화');
      const heading = el('h3');
      // 카드 전체가 대화 열기 단추다 (제목 단추를 카드 크기로 늘림). 넘기기 × 는 그 위에 따로 둔다.
      if (UUID.test(String(item.threadId || ''))) {
        const open = button('cxm-pet-open', title, `대화 열기: ${title}`);
        open.addEventListener('click', () => openThread(item.threadId));
        heading.append(open); card.dataset.open = '';
      } else heading.textContent = title;
      card.append(meta, heading);
      if (item.quote) {
        const quote = el('p', 'cxm-pet-quote');
        const who = QUOTED[item.quoteKind];
        if (who) quote.append(el('span', 'cxm-pet-quote-who', who));
        quote.append(String(item.quote));
        quote.title = String(item.quote);
        card.append(quote);
      }
      const action = el('p', 'cxm-pet-action', String(item.action || '대화를 열어 다음 단계를 정해 주세요.'));
      if (advising && result.advicePending) action.dataset.pending = '';
      if (item.adviceModel) action.append(el('span', 'cxm-pet-by', `${item.adviceModel} · ${item.adviceEffort || ''} 설명`));
      card.append(action);
      const skip = button('cxm-pet-skip', '×', '이번엔 넘기기'); skip.title = '이번엔 넘기기';
      skip.addEventListener('click', () => {
        dismissed.set(item.id, { v: typeof item.version === 'string' ? item.version : '', at: Date.now() }); saveDismissed();
        render();
        /** @type {HTMLElement | null} */ (cards.querySelector('.cxm-pet-open') || refresh).focus();
      });
      card.append(skip); cards.append(card);
    });
  }
  const TIMEOUT = 120000;
  const withDeadline = (work) => {
    let deadline = 0;
    return Promise.race([work, new Promise((_, reject) => {
      deadline = window.setTimeout(() => reject(new Error('pet_timeout')), TIMEOUT);
    })]).finally(() => clearTimeout(deadline));
  };
  function remember() {
    try {
      if (result?.status === 'ok') sessionStorage.setItem(RESULT_KEY, JSON.stringify(result));
      else sessionStorage.removeItem(RESULT_KEY);
    } catch { /* 저장 제한 */ }
  }
  /** 1단계: 모델 설명 없이 순위만 받아 바로 보인다. 패널이 열려 있으면 2단계로 설명을 채운다. */
  async function suggest(options = {}) {
    if (destroyed || !root.isConnected) return;
    const background = options?.background === true;
    attachSources(); threadChanged();
    clearTimeout(autoTimer); autoTimer = 0;
    const context = { epoch: ++generation, thread: currentThreadId() };
    preparingEpoch = context.epoch;
    requested = true; stale = false; advising = false; staleNote.hidden = true;
    if (background) delete root.dataset.fg; else root.dataset.fg = '';
    setPhase('loading'); syncBadge();
    if (!result) say('대화의 마지막 답변과 메모를 살펴보고 있어요… 닫아 두어도 준비되면 펫이 알려 줘요.');
    const before = new Set(visibleItems().map((item) => item.id));
    let failed = true;
    try {
      const next = await withDeadline((async () => {
        memoChanged();
        await readLabelChanges(true);
        if (!acceptResponse(context)) return null;
        preparingEpoch = 0;
        const api = w.codexLabels;
        const reply = typeof api?.taskPetSuggest === 'function'
          ? await api.taskPetSuggest({ currentThreadId: context.thread, ...skipRequest(), advice: false })
          : { status: 'unavailable', items: [] };
        if (labelReadWork || labelsDirty) await readLabelChanges();
        return reply;
      })());
      if (!acceptResponse(context)) return;
      if (result?.status === 'ok') previousIds = new Set(result.items.map((item) => item?.id));
      result = next && ['ok', 'empty', 'unavailable', 'source_error'].includes(next.status)
        ? next : { status: 'unavailable', items: [] };
      failed = ['unavailable', 'source_error'].includes(result.status);
      lastRun = Date.now(); remember();
      setPhase(failed ? 'error' : 'ready'); render();
      // 열 때 닫기 단추에 두었던 초점은 첫 카드로 옮겨 Enter 로 바로 열게 한다.
      if (isOpen && document.activeElement === close) /** @type {HTMLElement | null} */ (cards.querySelector('.cxm-pet-open'))?.focus();
      // 닫힌 동안 준비된 결과: 직접 요청했거나 새 후보가 생겼을 때만 '새 추천'으로 알린다.
      const fresh = visibleItems().some((item) => !before.has(item.id));
      if (!isOpen && !failed && (!background || fresh)) { unseen = true; syncBadge(); }
    } catch (error) {
      if (!acceptResponse(context)) return;
      result = { status: 'unavailable', items: [] }; lastRun = Date.now(); remember();
      setPhase('error'); render();
      if (error instanceof Error && error.message === 'pet_timeout')
        say('추천 응답이 늦어지고 있어요. ↻로 다시 시도해 주세요.');
    } finally {
      if (!destroyed && context.epoch === generation) { preparingEpoch = 0; scheduleLayout(); }
    }
    if (!failed && result?.advicePending && isOpen && !progressActive) await addAdvice(context);
  }
  /** 2단계: 같은 후보에 모델 설명을 붙인다. 엔진이 1단계 순위를 재사용하므로 설명 시간만 든다. */
  async function addAdvice(context) {
    if (!acceptResponse(context) || !result?.advicePending || advising) return;
    const api = w.codexLabels;
    if (typeof api?.taskPetSuggest !== 'function') return;
    advising = true; render();
    const keep = (note) => ({ ...result, advicePending: false, notice: [result.notice, note].filter(Boolean).join(' ') });
    try {
      const reply = await withDeadline(api.taskPetSuggest({ currentThreadId: context.thread, ...skipRequest() }));
      if (!acceptResponse(context)) return;
      // 설명 단계의 실패는 이미 보인 후보를 지우지 않는다.
      result = reply?.status === 'ok' ? reply : keep('모델 설명을 받지 못해 기본 안내를 표시해요.');
      remember();
    } catch {
      if (!acceptResponse(context)) return;
      result = keep('모델 설명을 받지 못해 기본 안내를 표시해요.');
    } finally {
      if (!destroyed && context.epoch === generation) { advising = false; render(); scheduleLayout(); }
    }
  }
  function acceptResponse(context) {
    if (destroyed || context.epoch !== generation || !root.isConnected) return false;
    if (context.thread !== currentThreadId()) { threadChanged(); return false; }
    return true;
  }
  function show() {
    if (destroyed) return;
    clearTimeout(wakeTimer);
    try { sessionStorage.removeItem(HIDE_KEY); } catch { /* 세션 저장 제한 */ }
    const refocus = document.activeElement === wake;
    sleeping = false; delete root.dataset.sleeping; launcher.hidden = false; wake.hidden = true; layout();
    if (refocus) launcher.focus();
    if (stale || !requested) scheduleAuto(0);
  }
  function sleepUntil(until) {
    closePanel(); sleeping = true; root.dataset.sleeping = ''; launcher.hidden = true; wake.hidden = false;
    const at = new Date(until).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    wake.title = `메모 펫 다시 보이기 · ${at}에 자동으로 다시 보여요`;
    clearTimeout(wakeTimer); wakeTimer = window.setTimeout(show, Math.max(0, until - Date.now()));
  }
  on(wake, 'click', show);
  on(launcher, 'pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = root.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, right: window.innerWidth - rect.right, top: rect.top, moved: false };
  });
  on(window, 'pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    // 조금 흔들린 클릭은 옮기기로 보지 않는다.
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) { drag.moved = true; root.dataset.dragging = ''; try { launcher.setPointerCapture(event.pointerId); } catch { /* 이미 놓음 */ } }
    moveTo({ right: drag.right - dx, top: drag.top + dy });
  });
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.moved) { dragged = true; delete root.dataset.dragging; savePosition(); }
    drag = null;
  };
  on(window, 'pointerup', endDrag);
  on(window, 'pointercancel', endDrag);
  // 키보드로도 옮긴다: 펫에 초점이 있을 때 Alt+화살표 (Shift 를 함께 누르면 크게)
  on(launcher, 'keydown', (event) => {
    const step = event.shiftKey ? 64 : 16;
    const delta = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!event.altKey || !delta) return;
    event.preventDefault();
    const rect = root.getBoundingClientRect();
    moveTo({ right: window.innerWidth - rect.right + delta[0], top: rect.top + delta[1] });
    savePosition();
  });
  on(home, 'click', () => { position = null; savePosition(); placeRoot(); scheduleLayout(); launcher.focus(); });
  on(window, 'resize', placeRoot);
  function selectView(active) {
    progressActive = active;
    if (active && !progressPanel) {
      progressPanel = w.__cxmTaskProgress?.mount(progressView, scheduleLayout) || null;
      if (!progressPanel) progressView.textContent = '업무 진척 화면을 불러오지 못했어요. Codex 화면을 새로 고쳐 주세요.';
    }
    recommendationView.hidden = active; progressView.hidden = !active;
    // 추천 전용 단추(새로고침·기준·확인 시각)는 진척 보기에서 감춘다.
    refresh.hidden = active; info.hidden = active; time.hidden = active;
    recommendations.setAttribute('aria-pressed', String(!active)); progressButton.setAttribute('aria-pressed', String(active));
    title.textContent = active ? '업무 진척' : '다음 할 일';
    close.setAttribute('aria-label', active ? '업무 진척 닫기' : '추천 닫기');
    panel.setAttribute('aria-label', active ? '메모 펫의 업무 진척' : '메모 펫의 다음 할 일');
    panel.setAttribute('aria-busy', String(!active && root.dataset.phase === 'loading'));
    syncRestore();
    if (!active && isOpen) {
      // 추천 보기로 돌아오면 바뀐 내용을 확인한다 (진척 보기 동안은 추천을 묻지 않는다).
      const loading = root.dataset.phase === 'loading';
      if (!requested || (!loading && (stale || !lastRun || Date.now() - lastRun > FRESH_MS))) void suggest();
    }
    scheduleLayout();
  }
  on(recommendations, 'click', () => selectView(false));
  on(progressButton, 'click', () => selectView(true));
  cleanups.push(() => { try { progressPanel?.destroy(); } catch { /* 진척 화면 정리 */ } });
  // 지난 결과를 바로 보이고, 바뀌었거나 오래됐으면 뒤에서 다시 확인한다 (카드는 그대로 둔다).
  function openPanel() {
    if (destroyed) return;
    if (sleeping) show();
    attachSources(); threadChanged();
    clearTimeout(autoTimer); autoTimer = 0;
    isOpen = true; panel.hidden = false; launcher.setAttribute('aria-expanded', 'true');
    unseen = false;
    if (result) render(); else syncBadge();
    layout();
    const loading = root.dataset.phase === 'loading';
    if (progressActive) { close.focus(); return; }
    if (!requested) void suggest();
    else if (!loading && (stale || !lastRun || Date.now() - lastRun > FRESH_MS)) void suggest();
    else if (!loading && result?.advicePending) void addAdvice({ epoch: generation, thread: currentThreadId() });
    // 첫 카드에 초점을 두어 Enter 로 바로 연다. 카드가 없으면 닫기에 둔다.
    /** @type {HTMLElement} */ (cards.querySelector('.cxm-pet-open') || close).focus();
  }
  on(launcher, 'click', () => {
    // 끌어서 옮긴 뒤 손을 뗄 때의 클릭은 패널을 열지 않는다.
    if (dragged) { dragged = false; return; }
    if (isOpen) { closePanel(); return; }
    openPanel();
  });
  on(close, 'click', () => closePanel(true));
  on(refresh, 'click', () => { void suggest(); });
  on(info, 'click', () => {
    rules.hidden = !rules.hidden; info.setAttribute('aria-expanded', String(!rules.hidden)); scheduleLayout();
  });
  on(gear, 'click', () => {
    try { w.__codexMemoBridge(JSON.stringify({ op: 'pet_settings' })); say('트레이 도우미의 펫 설정 창을 열었어요.'); }
    catch { say('펫 설정은 트레이의 Codex 메모 아이콘 → 펫 설정…에서 열 수 있어요.'); }
  });
  on(restore, 'click', () => {
    // 지금 가려진 카드만 되돌린다. 다른 대화에서 넘긴 기록은 그대로 둔다.
    const ids = new Set(Array.isArray(result?.skipped) ? result.skipped : []);
    for (const item of Array.isArray(result?.items) ? result.items : []) if (item && isSkipped(item)) ids.add(item.id);
    for (const id of ids) dismissed.delete(id);
    saveDismissed();
    close.focus(); void suggest();
  });
  on(hide, 'click', () => {
    const until = Date.now() + 30 * 60 * 1000;
    try { sessionStorage.setItem(HIDE_KEY, String(until)); } catch { /* 세션 저장 제한 */ }
    sleepUntil(until);
  });
  const editable = (node) => node instanceof Element && !root.contains(node)
    && !!node.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"],[role="textbox"]');
  on(document, 'keydown', (event) => {
    // Ctrl+Alt+P: 어디서든 펫 열기·닫기
    if (event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey && event.code === 'KeyP') {
      event.preventDefault(); event.stopPropagation();
      if (isOpen) closePanel(true); else openPanel();
      return;
    }
    // 숫자 1~6: 해당 카드의 대화 열기 (입력칸에 쓰는 중이면 무시)
    if (isOpen && !progressActive && /^[1-6]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey && !editable(event.target)) {
      const target = /** @type {HTMLElement | null} */ (cards.children[Number(event.key) - 1]?.querySelector('.cxm-pet-open'));
      if (target) { event.preventDefault(); event.stopPropagation(); target.click(); }
      return;
    }
    if (isOpen && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePanel(true); }
    if (isOpen && event.key === 'Tab') {
      tabLeaving = true;
      clearTimeout(tabTimer);
      tabTimer = window.setTimeout(() => { tabLeaving = false; }, 0);
    }
  }, true);
  on(document, 'pointerdown', (event) => { if (isOpen && !root.contains(event.target)) closePanel(); }, true);
  // Codex may refocus its composer after a render or disabled button. That is
  // not an outside click and must not dismiss Refresh/Open before they finish.
  on(document, 'focusin', (event) => { if (isOpen && tabLeaving && !root.contains(event.target)) closePanel(); });
  on(document, 'input', (event) => { if (isOpen && !root.contains(event.target)) closePanel(); });
  on(window, 'resize', scheduleLayout);
  on(window, 'cxm:auto-refresh', markStale);
  // labels_script 다음에 inject.js 가 실행되어도 같은 평가의 끝에서 메모 구독을 연결한다.
  // 열 때에도 API 교체를 확인한다. 주기적인 읽기나 모델 호출은 하지 않는다.
  let memoSource = null, labelsSource = null;
  let offMemos = null, offLabels = null;
  let memoSignature = null, labelSignature = null, labelsDirty = true;
  /** @type {Promise<void> | null} */
  let labelReadWork = null;
  const statuses = new Set(['requested', 'in_progress', 'in_review', 'completed', 'on_hold']);
  const stopped = new Set(['completed', 'on_hold']);
  const cleanText = (value, limit) => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
  const localId = (value) => typeof value === 'string'
    ? UUID.exec(value.replace(/^thread:local:(?:thread|local):/, ''))?.[1]?.toLowerCase() || null : null;
  function memoChanged(list) {
    if (destroyed) return;
    const rows = Array.isArray(list) ? list : memoSource?.list?.();
    if (!Array.isArray(rows)) return;
    const seen = new Set();
    const next = JSON.stringify(rows.filter((memo) => {
      if (memo?.category !== 'todo' || typeof memo.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(memo.id)
          || seen.has(memo.id) || !localId(memo.conv)) return false;
      seen.add(memo.id); return true;
    }).map((memo) => [memo.id, localId(memo.conv), cleanText(memo.note, 480), cleanText(memo.quote, 320), cleanText(memo.title, 160)])
      .sort((a, b) => a[0].localeCompare(b[0])));
    const changed = memoSignature !== null && next !== memoSignature;
    memoSignature = next;
    if (changed && preparingEpoch !== generation) markStale();
  }
  function statusSignature(snapshot) {
    if (!snapshot || snapshot.configError || !Array.isArray(snapshot.config?.labels)
        || !snapshot.assignments || typeof snapshot.assignments !== 'object' || Array.isArray(snapshot.assignments)) return 'source_error';
    // 상태에만 필요한 필드. categoryAssignments·색상·버전은 추천 근거가 아니다.
    const labels = new Map();
    for (const label of snapshot.config.labels) {
      if (label && statuses.has(label.id)) labels.set(label.id, [label.id, cleanText(label.name, 160),
        label.enabled === true, label.kind == null || label.kind === 'status']);
    }
    const assignments = new Map();
    for (const [key, value] of Object.entries(snapshot.assignments)) {
      if (!/^thread:local:(?:thread|local):/.test(key)) continue;
      const id = localId(key);
      if (id && (stopped.has(value) || !stopped.has(assignments.get(id)))) assignments.set(id, value);
    }
    return JSON.stringify([[...labels.values()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [...assignments].filter(([, value]) => statuses.has(value)).sort(([a], [b]) => a.localeCompare(b))]);
  }
  function readLabelChanges(force = false) {
    if (force) labelsDirty = true;
    if (destroyed || !requested) return Promise.resolve();
    if (labelReadWork) return labelReadWork;
    const work = Promise.resolve().then(async () => {
      while (labelsDirty && !destroyed) {
        labelsDirty = false;
        const source = labelsSource, epoch = generation;
        if (typeof source?.read !== 'function') return;
        let next;
        try { next = statusSignature(await source.read()); } catch { next = 'source_error'; }
        if (destroyed) return;
        // 새 요청 또는 API 교체 이전의 읽기는 기준을 덮어쓰지 않는다.
        if (source !== labelsSource || epoch !== generation) { labelsDirty = true; continue; }
        if (labelsDirty) continue;
        const changed = labelSignature !== null && labelSignature !== next;
        labelSignature = next;
        if (changed && preparingEpoch !== epoch) markStale();
      }
    }).finally(() => {
      if (labelReadWork === work) labelReadWork = null;
      // 마지막 await 와 정리 사이에 온 알림도 빠뜨리지 않는다.
      if (labelsDirty && !destroyed && requested) return readLabelChanges();
    });
    labelReadWork = work;
    return work;
  }
  function labelsChanged() {
    labelsDirty = true;
    if (requested) void readLabelChanges();
  }
  function attachSources() {
    if (destroyed) return;
    if (memoSource !== w.__codexMemo && typeof w.__codexMemo?.subscribe === 'function') {
      offMemos?.(); memoSource = w.__codexMemo; memoChanged(); offMemos = memoSource.subscribe(memoChanged);
    }
    if (labelsSource !== w.codexLabels && typeof w.codexLabels?.onChanged === 'function') {
      offLabels?.(); labelsSource = w.codexLabels; labelsDirty = true; offLabels = labelsSource.onChanged(labelsChanged);
    }
  }
  syncRestore();
  attachSources(); queueMicrotask(attachSources);
  cleanups.push(() => { offMemos?.(); offLabels?.(); });
  function mount() {
    if (destroyed || !document.body) return;
    document.head.append(style); document.body.append(root);
    const observer = new MutationObserver(() => { if (!root.isConnected) destroy(); });
    observer.observe(document.body, { childList: true }); cleanups.push(() => observer.disconnect());
    if (typeof w.__cxm?.watch === 'function') {
      const unwatch = w.__cxm.watch({ sidebar: threadChanged });
      cleanups.push(unwatch);
    } else {
      // common.js 가 없는 최소 화면에서만 사이드바의 선택 속성을 직접 지켜본다.
      const sidebar = document.querySelector('.sidebar-navigation');
      if (sidebar) {
        const selection = new MutationObserver(threadChanged);
        selection.observe(sidebar, { childList: true, subtree: true, attributes: true,
          attributeFilter: ['data-app-action-sidebar-thread-selected', 'data-app-action-sidebar-thread-id', 'data-app-action-sidebar-thread-host-id'] });
        cleanups.push(() => selection.disconnect());
      }
    }
    placeRoot();
    let until = 0;
    try { until = Number(sessionStorage.getItem(HIDE_KEY)); } catch { /* 세션 저장 제한 */ }
    if (Number.isFinite(until) && until > Date.now()) sleepUntil(Math.min(until, Date.now() + 30 * 60 * 1000));
    layout();
    if (result) { render(); stale = true; syncBadge(); }
    // 처음 한 번은 열기 전에 미리 확인해 두어 배지와 첫 화면이 바로 보이게 한다.
    const config = auto();
    if (config) scheduleAuto(config.prefetch);
    // 오래 열어 둔 창도 가끔 (기본 10분) 다시 확인한다. 숨긴 동안·패널을 연 동안·창이 가려진 동안은 하지 않는다.
    const every = window.setInterval(() => {
      const current = auto();
      if (current && lastRun && Date.now() - lastRun > (current.every || 600000)) scheduleAuto(0);
    }, 60000);
    cleanups.push(() => clearInterval(every));
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible' && (stale || !requested)) scheduleAuto();
    });
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true; generation++; clearTimeout(wakeTimer); clearTimeout(autoTimer); clearTimeout(tabTimer); cancelAnimationFrame(layoutFrame);
    cleanups.splice(0).reverse().forEach((cleanup) => { try { cleanup(); } catch { /* 해제는 계속 */ } });
    root.remove(); style.remove();
    if (w.__cxmTaskPet?.destroy === destroy) delete w.__cxmTaskPet;
  }
  w.__cxmTaskPet = { version: VERSION, destroy, show, open: openPanel, refresh: suggest, get stale() { return stale; }, get hidden() { return sleeping; } };
  if (document.body) mount(); else on(document, 'DOMContentLoaded', mount, { once: true });
})();
