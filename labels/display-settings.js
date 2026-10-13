// @ts-check
// All Codex windows share the helper's saved preferences. Disabled features
// release their UI, observers and timers instead of merely hiding their DOM.
(() => {
  const w = /** @type {any} */ (window), VERSION = 1;
  if (w.__cxmDisplay?.version === VERSION) { void w.__cxmDisplay.reload(); return; }
  w.__cxmDisplay?.destroy();
  // Retire widgets injected by older helpers before the saved settings arrive.
  w.__cxmTaskPet?.destroy(); w.__cxmSubscription?.destroy();
  let disposed = false, revision = 0, ready = false;
  let current = {petEnabled: false, showUsageAmount: true};
  const features = new Map(), pending = new Map();
  let sequence = Number(w.__cxmDisplaySequence) || 0;
  let retry = 0;
  const valid = value => typeof value?.petEnabled === 'boolean' && typeof value?.showUsageAmount === 'boolean';
  function sync() {
    for (const [key, feature] of features) {
      if (ready && current[key]) feature.start(); else feature.stop();
    }
  }
  function apply(value) {
    if (disposed || !valid(value)) return;
    revision++; ready = true; current = {...value}; clearTimeout(retry); sync();
  }
  const responder = {resolve(id, ok, value) {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id); clearTimeout(item.timer);
    ok ? item.resolve(value) : item.reject(Error('화면 설정을 읽지 못했습니다.'));
  }};
  w.__cxmDisplayReply = responder;
  async function reload() {
    if (disposed) return;
    const epoch = ++revision;
    try {
      const value = await new Promise((resolve, reject) => {
        const id = ++sequence; w.__cxmDisplaySequence = sequence;
        const timer = setTimeout(() => responder.resolve(id, false, null), 25000);
        pending.set(id, {resolve, reject, timer});
        try { window.__codexMemoBridge(JSON.stringify({op: 'labels', cb: '__cxmDisplayReply', id, method: 'displaySettings', args: []})); }
        catch { responder.resolve(id, false, null); }
      });
      if (disposed || epoch !== revision) return;
      if (!valid(value)) throw Error('잘못된 화면 설정');
      apply(value);
    } catch {
      if (!disposed && epoch === revision) { clearTimeout(retry); retry = window.setTimeout(() => { void reload(); }, 15000); }
    }
  }
  const visible = () => { if (document.visibilityState === 'visible') void reload(); };
  document.addEventListener('visibilitychange', visible);
  const unwatch = window.codexLabels?.onChanged?.(() => { void reload(); });
  const runtime = {version: VERSION, reload, apply, register(key, feature) {
    if (disposed) return;
    features.set(key, feature);
    if (ready && current[key]) feature.start(); else feature.stop();
  }, destroy() {
    disposed = true; revision++; clearTimeout(retry); unwatch?.();
    document.removeEventListener('visibilitychange', visible);
    for (const feature of features.values()) feature.stop();
    features.clear();
    for (const id of pending.keys()) responder.resolve(id, false, null);
    if (w.__cxmDisplayReply === responder) delete w.__cxmDisplayReply;
    if (w.__cxmDisplay === runtime) delete w.__cxmDisplay;
  }};
  w.__cxmDisplay = runtime;
  void reload();
})();
