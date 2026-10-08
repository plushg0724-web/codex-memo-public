// @ts-check
// 대화(스레드) 열기·지금 열린 대화 알아내기. 메모 위치로 이동할 때 쓴다.
// Codex 는 화면 안 라우터로 대화를 바꾼다(location 은 /index.html 그대로). 왼쪽 목록 줄이 보이면 그 줄을 누르고,
// 같은 대화로 가는 앱 링크가 보이면 그 링크를, 둘 다 없으면(접힌 프로젝트·가상 목록) Codex 라우터로 /local/<id> 로 간다.
// 같은 앱의 ChatGPT 채팅은 /c/<id> (GPT 채팅은 /g/<gizmo>/c/<id>) 경로이며, 메모에는 'chat:<id>' 로 적는다.
// 문서 이동·새로 고침은 하지 않는다. 누른 것만으로 성공으로 치지 않고, 실제로 그 대화가 열렸는지 확인한다.
(() => {
  const VERSION = 3;
  const w = /** @type {any} */ (window);
  if (w.__cxmThreads?.version === VERSION) return;
  const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const CHAT = /^chat:/i;
  const pick = (/** @type {string} */ v) => UUID.exec(v)?.[1]?.toLowerCase() || null;
  /** Codex 대화 id. 'chat:' 메모는 Codex 대화가 아니므로 null */
  const uuidOf = (/** @type {unknown} */ v) => typeof v === "string" && !CHAT.test(v) ? pick(v) : null;
  /** ChatGPT 채팅 id ('chat:<id>' 에서) */
  const chatOf = (/** @type {unknown} */ v) => typeof v === "string" && CHAT.test(v) ? pick(v.slice(5)) : null;

  /** React 가 들고 있는 Codex 라우터 (화면 데이터에서 찾아 기억해 둔다) */
  let cache = /** @type {{seed: Element, router: any} | null} */ (null);
  function router() {
    if (cache?.seed.isConnected) return cache.router;
    for (const seed of [document.querySelector("[data-app-action-sidebar-thread-row], [data-app-action-sidebar-thread-id]"), document.querySelector("#root")?.firstElementChild]) {
      if (!seed) continue;
      const key = Object.keys(seed).find((k) => k.startsWith("__reactFiber"));
      let fiber = key && /** @type {any} */ (seed)[key];
      for (let depth = 0; fiber && depth < 240; depth++, fiber = fiber.return) {
        const values = [fiber.memoizedProps?.value];
        let dep = fiber.dependencies?.firstContext;
        for (let i = 0; dep && i < 30; i++, dep = dep.next) values.push(dep.memoizedValue);
        for (const value of values) {
          const r = value?.router;
          if (typeof r?.navigate === "function" && typeof r.state?.location?.pathname === "string") { cache = { seed, router: r }; return r; }
        }
      }
    }
    return null;
  }
  const pathname = () => /** @type {unknown} */ (router()?.state?.location?.pathname);

  /** 지금 열린 Codex 대화의 id (없으면 null) */
  function currentId() {
    const path = pathname();
    if (typeof path === "string") return uuidOf(/^\/local\/([^/]+)\/?$/.exec(path)?.[1]);
    const row = document.querySelector('[data-app-action-sidebar-thread-selected="true"]');
    return uuidOf(row?.getAttribute("data-app-action-sidebar-thread-id"));
  }

  /** 지금 열린 ChatGPT 채팅의 id (없으면 null) */
  function currentChat() {
    const path = pathname();
    return typeof path === "string" ? pick(/^(?:\/g\/[^/]+)?\/c\/([^/]+)\/?$/.exec(path)?.[1] || "") : null;
  }

  /** 메모에 적을 지금 대화: Codex 대화는 '<id>', 채팅은 'chat:<id>', 모르면 null */
  function currentConv() {
    const chat = currentChat();
    return chat ? `chat:${chat}` : currentId();
  }

  const visible = (/** @type {Element | null | undefined} */ n) => !!n?.isConnected && n.getClientRects().length > 0
    && getComputedStyle(n).visibility !== "hidden" && getComputedStyle(n).display !== "none";

  /** @param {() => unknown} action @param {() => boolean} opened @param {number} timeoutMs */
  async function attempt(action, opened, timeoutMs) {
    try { await action(); } catch { return false; }
    for (const end = Date.now() + timeoutMs; Date.now() < end;) {
      if (opened()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return opened();
  }

  /** ChatGPT 채팅을 연다. 채팅 목록 줄에는 주소가 없어 앱 라우터로 /c/<id> 로 간다. */
  async function openChat(/** @type {string} */ chat, /** @type {number} */ timeoutMs) {
    if (currentChat() === chat) return true;
    const r = router();
    if (!r) return false;
    return attempt(() => r.navigate(`/c/${chat}`), () => currentChat() === chat, timeoutMs);
  }

  /**
   * 이 Codex 대화로 가는 방법: 보이는 이 PC 목록 줄 → 같은 대화로 가는 앱 링크 → 라우터. 없으면 null.
   * @param {string} uuid
   * @returns {(() => unknown) | null}
   */
  function opener(uuid) {
    const row = [...document.querySelectorAll("[data-app-action-sidebar-thread-id]")]
      .find((r) => uuidOf(r.getAttribute("data-app-action-sidebar-thread-id")) === uuid);
    const host = row?.getAttribute("data-app-action-sidebar-thread-host-id");
    if ((!host || host === "local") && visible(row)) return () => /** @type {HTMLElement} */ (row).click();
    const link = [...document.querySelectorAll("a[href]")].find((a) => {
      if (!visible(a)) return false;
      try { const u = new URL(a.getAttribute("href") || "", location.href); return u.origin === location.origin && u.pathname === `/local/${uuid}`; } catch { return false; }
    });
    if (link) return () => /** @type {HTMLElement} */ (link).click();
    const r = router();
    return r ? () => r.navigate(`/local/${uuid}`) : null;
  }

  /**
   * 대화를 연다. 열렸으면 true. 열 방법이 없거나 제때 열리지 않으면 false.
   * @param {string} id Codex 대화 id (uuid, 'local:' 같은 앞붙임이 있어도 된다) 또는 'chat:<id>'
   * @param {{timeoutMs?: number}} [options]
   */
  async function open(id, { timeoutMs = 3000 } = {}) {
    const chat = chatOf(id);
    if (chat) return openChat(chat, timeoutMs);
    const uuid = uuidOf(id);
    if (!uuid) return false;
    if (currentId() === uuid) return true;
    const action = opener(uuid);
    if (!action) return false;
    return attempt(action, () => currentId() === uuid, timeoutMs);
  }

  w.__cxmThreads = { version: VERSION, open, opener, router, currentId, currentChat, currentConv, uuidOf, chatOf };
})();
