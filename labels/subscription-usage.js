// @ts-check
// 현재 Codex 할당량 한 주기를 30일 구독료로 시간 비례 환산한다.
(() => {
  const w = /** @type {any} */ (window), VERSION = 1;
  if (w.__cxmSubscription?.version === VERSION) { w.__cxmSubscription.attach(); return; }
  w.__cxmSubscription?.destroy();
  let disposed = false, loading = false, saving = false, error = '';
  /** @type {import('../dist/node/subscription-usage.cjs').SubscriptionUsage | null} */
  let data = null;
  let seq = Number(w.__cxmUsageSequence) || 0;
  const pending = new Map();
  const responder = {resolve(id, ok, value) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id); clearTimeout(item.timer);
    ok ? item.resolve(value) : item.reject(Error(typeof value === 'string' ? value : '응답을 받지 못했습니다.'));
  }};
  w.__cxmUsage = responder;
  /** @param {LabelsMethod} method @param {unknown[]} args @returns {Promise<any>} */
  const request = (method, args = []) => new Promise((resolve, reject) => {
    if (disposed) { reject(Error('사용량 표시가 종료되었습니다.')); return; }
    const id = ++seq; w.__cxmUsageSequence = seq;
    const timer = setTimeout(() => responder.resolve(id, false, '사용량 응답이 없습니다.'), 25000);
    pending.set(id, {resolve, reject, timer});
    try { window.__codexMemoBridge(JSON.stringify({op: 'labels', cb: '__cxmUsage', id, method, args})); }
    catch { responder.resolve(id, false, 'Codex 메모 도우미와 연결되지 않았습니다.'); }
  });
  const won = value => `₩${Math.round(value).toLocaleString('ko-KR')}`;
  const percent = value => `${value.toLocaleString('ko-KR', {maximumFractionDigits: 2})}%`;
  const duration = minutes => minutes % 1440 === 0 ? `${minutes / 1440}일` : minutes % 60 === 0 ? `${minutes / 60}시간` : `${minutes}분`;
  const date = value => new Date(value).toLocaleString('ko-KR', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'});
  function element(tag, className = '', text = '') {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  }
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .cxm-subscription { flex: 1 0 100%; min-width: 0; text-align: left; padding: 7px 8px; border-radius: 8px;
      font: inherit; font-size: 11px; line-height: 1.6; font-variant-numeric: tabular-nums; cursor: pointer;
      border: 1px solid var(--color-token-border-default, #80808040); background: var(--color-token-bg-primary, #242424);
      color: var(--color-token-text-primary, #eee); }
    .cxm-subscription:hover { background: var(--color-token-bg-hover, #343434); }
    .cxm-subscription:focus-visible { outline: 2px solid #6ca6c5; outline-offset: 2px; }
    .cxm-subscription span { display: block; }
    .cxm-subscription small { display: block; opacity: .7; font-size: 10px; }
    .cxm-subscription[data-stale=true] { border-style: dashed; }
    #cxm-subscription-dialog { width: min(430px, calc(100vw - 40px)); max-height: calc(100vh - 50px); overflow: auto;
      box-sizing: border-box; padding: 22px; border: 1px solid var(--color-token-border-default, #80808050); border-radius: 14px;
      color: var(--color-token-text-primary, #eee); background: var(--color-token-bg-primary, #242424);
      font: 13px/1.65 system-ui, sans-serif; box-shadow: 0 16px 64px #0005; }
    #cxm-subscription-dialog::backdrop { background: #0006; }
    #cxm-subscription-dialog h2 { font-size: 17px; margin: 0 0 4px; }
    #cxm-subscription-dialog p { margin: 7px 0; }
    #cxm-subscription-dialog .cxm-usage-amount { font-size: 27px; font-weight: 650; font-variant-numeric: tabular-nums; }
    #cxm-subscription-dialog progress { width: 100%; height: 7px; accent-color: #64a6ac; }
    #cxm-subscription-dialog dl { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin: 20px 0; }
    #cxm-subscription-dialog dt { opacity: .75; }
    #cxm-subscription-dialog dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
    #cxm-subscription-dialog .cxm-usage-note { font-size: 11px; opacity: .75; }
    #cxm-subscription-dialog .cxm-usage-status { min-height: 1.65em; font-size: 12px; }
    #cxm-subscription-dialog .cxm-usage-actions { display: flex; gap: 8px; margin-top: 18px; justify-content: flex-end; }
    #cxm-subscription-dialog button, #cxm-subscription-dialog input { font: inherit; color: inherit; border: 1px solid #80808066;
      background: transparent; border-radius: 7px; padding: 6px 10px; }
    #cxm-subscription-dialog button { cursor: pointer; }
    #cxm-subscription-dialog button:disabled { opacity: .5; cursor: wait; }
    #cxm-subscription-dialog input { width: 125px; margin: 0 6px; }
    #cxm-subscription-dialog form { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const badge = /** @type {HTMLButtonElement} */ (element('button', 'cxm-subscription'));
  badge.type = 'button'; badge.setAttribute('aria-haspopup', 'dialog');
  const badgeMain = element('span'), badgeSub = element('small'); badge.append(badgeMain, badgeSub);
  /** @type {HTMLDialogElement | null} */
  let dialog = null;
  let fields = null;

  function render() {
    const q = data?.window;
    const stale = Boolean(error || !data || data.status !== 'ready' || Date.now() - (data.observedAt || 0) > 45000 || (q && q.resetsAt * 1000 <= Date.now()));
    const label = q ? `이번 ${duration(q.windowDurationMins)} 사용분` : '구독 사용량';
    badgeMain.textContent = q ? `${won(q.usedKrw)} · ${percent(q.subscriptionPercent)}${stale ? ' · 이전 값' : ''}` : `구독 사용량 · ${error || data?.status === 'unavailable' ? '연결 확인' : '확인 중'}`;
    badgeSub.textContent = `${label} / 30일 구독료 환산`;
    badge.dataset.stale = String(stale);
    badge.title = `${badgeMain.textContent}\n${badgeSub.textContent}\n${data?.observedAt ? `마지막 확인 ${date(data.observedAt)}` : '아직 확인된 사용량이 없습니다.'}`;
    badge.setAttribute('aria-label', `${badgeMain.textContent}. ${badgeSub.textContent}. 상세 보기`);
    if (!fields) return;
    fields.amount.textContent = q ? `${won(q.usedKrw)} · ${percent(q.subscriptionPercent)}` : '사용량 확인 중';
    fields.subtitle.textContent = `${label}을 30일 구독료 기준으로 환산`;
    fields.progress.value = q?.usedPercent || 0;
    fields.progress.setAttribute('aria-label', q ? `${duration(q.windowDurationMins)} 할당량 사용률` : '할당량 사용률');
    fields.used.textContent = q ? `${percent(q.usedPercent)} 사용 / ${percent(100 - q.usedPercent)} 남음` : '—';
    fields.budget.textContent = q ? `${won(q.budgetKrw)} (${duration(q.windowDurationMins)})` : '—';
    fields.remaining.textContent = q ? won(q.remainingKrw) : '—';
    fields.daily.textContent = data ? `${won(data.dailyKrw)} / 일` : '—';
    fields.reset.textContent = q ? date(q.resetsAt * 1000) : '—';
    fields.status.textContent = error || data?.message || (stale && q ? '이전 값입니다. 최신 사용량을 확인 중입니다.' : loading ? '사용량 갱신 중…' : '');
    fields.updated.textContent = data?.observedAt ? `마지막 확인 ${date(data.observedAt)} · 15초마다 갱신` : '확인된 사용량이 없습니다.';
    fields.refresh.disabled = loading;
  }
  function attach() {
    const tools = w.__cxm?.sidebarTools?.();
    if (tools && badge.parentElement !== tools) tools.append(badge);
  }
  async function refresh(force = false) {
    if (disposed || loading || saving) return;
    loading = true; render();
    try {
      const next = await request('subscriptionUsage', [force]);
      if (disposed) return;
      if (!next || !['ready', 'stale', 'unavailable', 'resetting'].includes(next.status)) throw Error('사용량 정보를 읽지 못했습니다.');
      data = next; error = '';
    } catch (reason) { if (!disposed) error = reason.message || '사용량 갱신 실패'; }
    finally { loading = false; if (!disposed) render(); }
  }
  function open() {
    if (dialog) { dialog.focus(); return; }
    dialog = /** @type {HTMLDialogElement} */ (element('dialog'));
    dialog.id = 'cxm-subscription-dialog'; dialog.setAttribute('aria-labelledby', 'cxm-usage-title');
    const title = element('h2', '', '구독 사용량'); title.id = 'cxm-usage-title';
    const subtitle = element('p', 'cxm-usage-note'), amount = element('p', 'cxm-usage-amount');
    const progress = /** @type {HTMLProgressElement} */ (element('progress')); progress.max = 100;
    const list = element('dl');
    const row = label => { const value = element('dd'); list.append(element('dt', '', label), value); return value; };
    const used = row('원본 할당량'), budget = row('해당 기간 환산 기준'), remaining = row('해당 기간 남은 환산액');
    const daily = row('하루 구독료'), reset = row('다음 초기화');
    const note = element('p', 'cxm-usage-note', '이 PC에 로그인한 Codex 계정의 사용량입니다. 30일 구독료를 기간에 비례해 나눈 참고 금액이며, 현재 할당량 주기의 사용분만 표시합니다. 전체 30일 누계나 실제 청구액은 아닙니다.');
    const form = /** @type {HTMLFormElement} */ (element('form'));
    const label = /** @type {HTMLLabelElement} */ (element('label', '', '30일 구독료'));
    const input = /** @type {HTMLInputElement} */ (element('input')); input.type = 'number'; input.min = '1'; input.max = '100000000'; input.step = '1'; input.required = true;
    input.id = 'cxm-usage-fee'; label.htmlFor = input.id; input.value = String(data?.feeKrw || 159000);
    const save = /** @type {HTMLButtonElement} */ (element('button', '', '저장')); save.type = 'submit';
    form.append(label, input, element('span', '', '원'), save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (saving || !form.reportValidity()) return;
      saving = true; input.disabled = save.disabled = true; error = '';
      const owner = dialog;
      try {
        const feeKrw = await request('subscriptionFeeSet', [input.valueAsNumber]);
        if (!disposed && owner === dialog) { input.value = String(feeKrw); data = await request('subscriptionUsage', []); }
      } catch (reason) { if (!disposed && owner === dialog) error = reason.message || '구독료 저장 실패'; }
      finally { saving = false; if (!disposed && owner === dialog) { input.disabled = save.disabled = false; render(); } }
    });
    const status = element('p', 'cxm-usage-status'); status.setAttribute('role', 'status');
    const updated = element('p', 'cxm-usage-note');
    const actions = element('div', 'cxm-usage-actions');
    const refreshButton = /** @type {HTMLButtonElement} */ (element('button', '', '지금 갱신')); refreshButton.type = 'button'; refreshButton.onclick = () => { void refresh(true); };
    const close = /** @type {HTMLButtonElement} */ (element('button', '', '닫기')); close.type = 'button'; close.onclick = () => dialog?.close();
    actions.append(refreshButton, close);
    fields = {subtitle, amount, progress, used, budget, remaining, daily, reset, status, updated, refresh: refreshButton};
    dialog.append(title, subtitle, amount, progress, list, note, form, status, updated, actions);
    dialog.addEventListener('close', () => { dialog?.remove(); dialog = null; fields = null; badge.focus(); }, {once: true});
    document.body.append(dialog); render(); dialog.showModal(); void refresh();
  }
  badge.onclick = open;
  const visible = () => { if (document.visibilityState === 'visible') { attach(); void refresh(); } };
  document.addEventListener('visibilitychange', visible);
  const timer = setInterval(() => { attach(); render(); if (document.visibilityState === 'visible') void refresh(); }, 15000);
  const unwatch = w.__cxm?.watch?.({sidebar: attach});
  const runtime = {version: VERSION, attach, refresh, destroy() {
    disposed = true; clearInterval(timer); unwatch?.(); document.removeEventListener('visibilitychange', visible);
    for (const id of pending.keys()) responder.resolve(id, false, '사용량 표시가 종료되었습니다.');
    badge.remove(); dialog?.remove(); dialog = null; fields = null;
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sheet);
    if (w.__cxmUsage === responder) delete w.__cxmUsage;
    if (w.__cxmSubscription === runtime) delete w.__cxmSubscription;
  }};
  w.__cxmSubscription = runtime;
  attach(); render(); void refresh();
})();
