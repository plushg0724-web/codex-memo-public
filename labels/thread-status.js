// @ts-check
// 왼쪽 대화 목록에서 답이 필요한 대화(파랑)와 막힌 대화(주황)를 작게 표시한다.
(() => {
  const VERSION = 5;
  if (window.__cxmThreadStatus?.version === VERSION) return;
  try { window.__cxmThreadStatus?.destroy(); } catch { /* 예전 버전 */ }
  const api = window.codexLabels;
  const cxm = /** @type {any} */ (window).__cxm;
  if (!api?.threadStatus || !cxm) return;

  const { ROW, NAV, uuidOf } = cxm;
  const OWN = '.cxm-thread-status';
  const BATCH = 5;
  const RETRY_MS = 2 * 60 * 1000;
  const CLIPS = /auto|scroll|hidden|clip/;
  /** @type {Map<string, {state: 'ask' | 'blocked', confidence: number} | null>} */
  const results = new Map();
  /** @type {Map<string, number>} */
  const asked = new Map();
  /** @type {Map<string, number>} 열린 대화는 이후에 시작한 갱신까지 숨긴다 */
  const hidden = new Map();
  /** @type {Set<string>} */
  let selected = new Set();
  let epoch = 0, disposed = false, scanning = false, scanTimer = 0, renderTimer = 0;
  let scanAgain = false, refreshAgain = false;
  /** @type {Element | null} render 가 찾아 둔 왼쪽 목록 틀 (본문 스크롤을 거르는 데 쓴다) */
  let nav = null;
  const rows = () => /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(ROW));
  /** 행과 대화 id 를 한 번씩만 읽는다. first: id 마다 문서 순서상 첫 행 */
  function readRows() {
    /** @type {[HTMLElement, string | undefined][]} */
    const list = [];
    /** @type {Map<string, HTMLElement>} */
    const first = new Map();
    for (const row of rows()) {
      const id = uuidOf(row);
      list.push([row, id]);
      if (id && !first.has(id)) first.set(id, row);
    }
    return { list, first };
  }

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .cxm-thread-status { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; margin-right: 6px;
      font-size: 10px; line-height: 17px; white-space: nowrap; color: #60a5fa; cursor: inherit; }
    .cxm-thread-status::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .cxm-thread-status[data-state="blocked"] { color: #fb923c; }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  /** @param {CSSStyleDeclaration} s */
  const hiddenStyle = (s) => s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0';

  /**
   * 한 번의 그리기·스캔에서 쓰는 '보이는 행' 판별기. 스크롤 영역에 가려진 행도 제외한다.
   * 행들은 같은 조상(목록 스크롤 영역 등)을 공유하므로 조상의 스타일·잘림 영역은 한 번만 계산해 둔다
   * (행마다 조상 전체의 스타일·크기를 다시 읽지 않게).
   */
  function visibility() {
    /** @typedef {{top: number, right: number, bottom: number, left: number}} Box */
    /** @type {Map<Element, Box | null>} 요소와 그 조상들이 남기는 보이는 영역 (null: 숨겨짐) */
    const clips = new Map();
    /** @param {Element | null} el @returns {Box | null} */
    const clipOf = (el) => {
      if (!el) return { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
      const known = clips.get(el);
      if (known !== undefined) return known;
      let clip = clipOf(el.parentElement);
      if (clip) {
        const s = getComputedStyle(el);
        if (hiddenStyle(s)) clip = null;
        else {
          const y = CLIPS.test(s.overflowY), x = CLIPS.test(s.overflowX);
          if (x || y) {
            const r = el.getBoundingClientRect();
            clip = { top: y ? Math.max(clip.top, r.top) : clip.top, bottom: y ? Math.min(clip.bottom, r.bottom) : clip.bottom,
              left: x ? Math.max(clip.left, r.left) : clip.left, right: x ? Math.min(clip.right, r.right) : clip.right };
          }
        }
      }
      clips.set(el, clip);
      return clip;
    };
    return (/** @type {HTMLElement} */ row) => {
      const { top, right, bottom, left, width, height } = row.getBoundingClientRect();
      if (!width || !height || hiddenStyle(getComputedStyle(row))) return false;
      const clip = clipOf(row.parentElement);
      return !!clip && Math.min(bottom, clip.bottom) > Math.max(top, clip.top) && Math.min(right, clip.right) > Math.max(left, clip.left);
    };
  }

  /** 지금 보이는 행의 대화 id @param {[HTMLElement, string | undefined][]} list */
  function visibleIds(list) {
    const visible = visibility();
    return new Set(/** @type {string[]} */ (list.filter(([row, id]) => id && visible(row)).map(([, id]) => id)));
  }

  function render() {
    if (disposed) return;
    if (!nav?.isConnected) nav = document.querySelector(NAV);
    const { list } = readRows();
    const next = new Set();
    for (const [row, id] of list) {
      if (id && row.dataset.appActionSidebarThreadSelected === 'true') next.add(id);
    }
    for (const id of next) if (!selected.has(id)) hidden.set(id, ++epoch);
    selected = next;
    // 먼저 모든 행의 위치를 읽고 그다음 점을 넣고 뺀다(읽기·쓰기를 섞어 레이아웃을 매번 다시 계산하지 않게)
    const visible = visibility();
    const shown = list.map(([row, id]) => {
      const r = id && results.get(id);
      return /** @type {const} */ ([row, r && !selected.has(id) && !hidden.has(id) && visible(row) ? r : null]);
    });
    for (const [row, r] of shown) {
      let dot = /** @type {HTMLElement | null} */ (row.querySelector(OWN));
      if (!r) { dot?.remove(); continue; }
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'cxm-thread-status';
        // 배지 안에 넣으면 라벨 클릭으로 처리되므로, 형제 요소로 둔다. 추천 칩과도 별개다.
        const badge = row.querySelector('.cdx-label');
        if (badge) badge.before(dot);
        else row.prepend(dot);
      }
      const label = r.state === 'ask' ? '답 필요' : '막힘';
      const title = `${label} · ${r.state === 'ask' ? '사용자의 답변·선택·승인·정보 제공을 기다립니다.' : '권한·환경 문제로 작업이 멈췄습니다.'} · 자동 분류 확신 ${Math.round(r.confidence * 100)}%`;
      if (dot.dataset.state !== r.state) dot.dataset.state = r.state;
      if (dot.textContent !== label) dot.textContent = label;
      if (dot.title !== title) { dot.title = title; dot.setAttribute('aria-label', title); }
    }
  }

  async function scan(refresh = false) {
    if (disposed) return;
    if (scanning) { scanAgain = true; refreshAgain ||= refresh; return; }
    scanning = true;
    try {
      render();
      const now = Date.now();
      const todo = [...visibleIds(readRows().list)]
        .filter(id => refresh || !asked.has(id) || now - asked.get(id) >= RETRY_MS);
      for (let i = 0; i < todo.length && !disposed; i += BATCH) {
        // 기다리는 동안 스크롤했어도 지금 보이는 행만 보낸다.
        const { list, first } = readRows();
        const shown = visibleIds(list);
        const ids = todo.slice(i, i + BATCH).filter(id => shown.has(id));
        if (!ids.length) continue;
        const started = epoch;
        ids.forEach(id => asked.set(id, Date.now()));
        // 클라우드 대화는 이 PC 의 백엔드가 읽을 수 없어 화면 통로로 읽은 요약을 함께 보낸다
        /** @type {Record<string, ThreadDigest>} */
        const digests = {};
        await Promise.all(ids.map(async id => {
          const host = first.get(id)?.dataset.appActionSidebarThreadHostId || 'local';
          if (host !== 'local' && api.threadDigest) digests[id] = await api.threadDigest(host, id).catch(() => undefined);
        }));
        const res = await api.threadStatus(ids, digests).catch(() => ({}));
        if (disposed) return;
        for (const id of ids) {
          const r = res?.[id];
          results.set(id, r && (r.state === 'ask' || r.state === 'blocked') ? r : null);   // 기준 확신은 백엔드가 적용 (조절 가능)
          if (!selected.has(id) && hidden.has(id) && hidden.get(id) <= started) hidden.delete(id);
        }
        render();
      }
    } finally {
      scanning = false;
      // 응답을 기다리는 동안 새로 보인 행도, 진행 중이라는 이유로 스캔을 놓치지 않는다.
      if (scanAgain && !disposed) {
        const refresh = refreshAgain;
        scanAgain = refreshAgain = false;
        clearTimeout(scanTimer);
        scanTimer = window.setTimeout(() => scan(refresh), 1500);
      }
    }
  }

  // 답변 작성·스크롤 중에는 변경이 아주 잦으므로 바로 계산하지 않고 모아서 한 번만 한다 (스크롤 버벅임 방지)
  function schedule() {
    if (disposed) return;
    clearTimeout(renderTimer);
    renderTimer = window.setTimeout(render, 200);
    clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, 1500);
  }
  // 왼쪽 목록 변화만 common.js 가 알려 준다(직접 만든 표시의 변경은 빠져 있음)
  const unwatch = cxm.watch({ sidebar: (/** @type {MutationRecord[]} */ list) => {
    // 대화를 열면(선택) 표시는 바로 숨긴다
    if (list.some(m => m.attributeName === 'data-app-action-sidebar-thread-selected')) render();
    schedule();
  } });
  // 답변이 작성되는 동안 대화 본문은 계속 스크롤되지만 왼쪽 목록의 보이는 행은 그대로다.
  // 문서·왼쪽 목록·목록을 품은 영역이 스크롤될 때만 다시 계산한다(목록 틀을 모르면 항상).
  /** @param {Event} event */
  const onScroll = (event) => {
    const target = event.target;
    if (nav?.isConnected && target instanceof Element && !nav.contains(target) && !target.contains(nav)) return;
    schedule();
  };
  document.addEventListener('scroll', onScroll, {capture: true, passive: true});
  window.addEventListener('resize', schedule);
  const interval = window.setInterval(() => scan(true), RETRY_MS);
  // 기준 확신을 바꾸거나 '다시 판단'을 누르면 바로 다시 묻는다
  const onRefresh = () => { results.clear(); asked.clear(); render(); clearTimeout(scanTimer); scanTimer = window.setTimeout(() => scan(true), 300); };
  window.addEventListener('cxm:auto-refresh', onRefresh);
  schedule();
  window.__cxmThreadStatus = {
    version: VERSION,
    destroy() {
      disposed = true;
      unwatch(); clearTimeout(scanTimer); clearTimeout(renderTimer); clearInterval(interval);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('cxm:auto-refresh', onRefresh);
      document.querySelectorAll(OWN).forEach(dot => dot.remove());
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sheet);
      delete window.__cxmThreadStatus;
    },
  };
})();
