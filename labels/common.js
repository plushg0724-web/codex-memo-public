// @ts-check
// Codex 화면에 넣는 Codex 메모 스크립트들이 같이 쓰는 도구.
// - 대화 줄 찾기·열쇠·라벨 종류·요소 만들기
// - 화면 변화 감시(하나로): body 전체를 각자 지켜보면 답변이 흘러나올 때마다 모두 깨어나므로,
//   여기 한 곳에서 지켜보고 왼쪽 목록이 바뀐 경우(sidebar)와 새 요소가 붙은 경우(added)만 알린다.
(() => {
  const VERSION = 2;
  const w = /** @type {any} */ (window);
  if (w.__cxm?.version === VERSION) {
    // Extend an already-open helper without dropping other scripts' subscriptions.
    w.__cxm.sidebarTools = sidebarTools;
    return;
  }
  try { w.__cxm?.destroy(); } catch { /* 예전 버전 */ }

  const ROW = "[data-app-action-sidebar-thread-row]";
  const NAV = ".sidebar-navigation";
  const STATUS_IDS = new Set(["requested", "in_progress", "in_review", "completed", "on_hold"]);
  const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  // 왼쪽 목록 안에 우리가 넣는 표시. 이것만 바뀐 경우는 알리지 않는다(서로 깨우며 반복하지 않게).
  const OWN = ".cxm-filter, .cxm-label-suggest, .cxm-thread-status, .cxm-version-badge, .cxm-sidebar-tools";

  /** Shared tools row above the conversation filters, outside the scrolling list. */
  function sidebarTools() {
    const nav = document.querySelector(".sidebar-navigation");
    if (!nav) return null;
    let tools = /** @type {HTMLElement | null} */ (document.querySelector(".cxm-sidebar-tools"));
    const filter = nav.querySelector(".cxm-filter");
    const anchor = filter || [...nav.children].find((child) => child !== tools);
    if (!tools) {
      tools = document.createElement("div");
      tools.className = "cxm-sidebar-tools";
      tools.setAttribute("role", "group");
      tools.setAttribute("aria-label", "Codex 메모 도구");
      tools.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex-shrink:0;min-width:0;padding:4px 12px;";
    }
    if (anchor && tools.nextElementSibling !== anchor) anchor.before(tools);
    else if (!tools.isConnected) nav.append(tools);
    return tools;
  }

  /** 라벨 종류: kind 가 있으면 그것, 없으면 기본 진행 상태 id 인지로 판단 @param {any} label */
  const kindOf = (label) => label?.kind === "status" || label?.kind === "category" ? label.kind
    : (STATUS_IDS.has(typeof label === "string" ? label : label?.id) ? "status" : "category");
  /** 임시 목록 ID가 남아 있으면 같은 줄의 실제 대화 ID를 읽는다. @param {HTMLElement} row */
  const rowIdOf = (row) => {
    const id = row.dataset.appActionSidebarThreadId || "";
    if (!id.includes("client-new-thread:")) return id;
    const fiberKey = Object.keys(row).find((key) => key.startsWith("__reactFiber"));
    let fiber = fiberKey ? /** @type {any} */ (row)[fiberKey] : null;
    let routeId = "";
    for (let i = 0; fiber && i < 20; i++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      // A pending client's UUID is unrelated to the server's conversation UUID.
      // Read only this row's nearest conversation props; never match by title.
      if (typeof props?.conversationId === "string" && UUID.test(props.conversationId)
          && !props.conversationId.includes("client-new-thread:")) return `local:${UUID.exec(props.conversationId)[1]}`;
      const match = typeof props?.href === "string" && /^\/local\/([0-9a-f-]{36})$/i.exec(props.href);
      if (!routeId && match && UUID.test(match[1])) routeId = `local:${match[1]}`;
    }
    // Until creation completes, do not save labels or ask classifiers for the
    // unrelated temporary UUID. A later sidebar update resolves it again.
    return routeId;
  };
  /** 라벨 열쇠(vendor/renderer.js 와 같은 꼴) @param {HTMLElement} row */
  const keyOf = (row) => {
    const d = row.dataset;
    const id = rowIdOf(row);
    return id ? `thread:local:${d.appActionSidebarThreadKind || "local"}:${id}` : "";
  };
  /** @param {HTMLElement} row */
  const uuidOf = (row) => (UUID.exec(rowIdOf(row)) || [])[1];
  /** 왼쪽 목록에 그려진 대화 줄 */
  const rows = () => /** @type {HTMLElement[]} */ ([...document.querySelectorAll(`${NAV} ${ROW}`)]);
  /** @type {(tag: string, cls?: string, text?: string) => HTMLElement} */
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  // ------------------------------------------------------------ 화면 변화 감시
  /** @type {Set<(list: MutationRecord[]) => void>} */
  const sidebarSubs = new Set();
  /** @type {Set<(added: Element[]) => void>} */
  const addedSubs = new Set();
  /** @type {Element | null} */
  let nav = null;
  /** @param {Node} n */
  const own = (n) => n instanceof Element && n.matches(OWN);
  /** @param {MutationRecord} m */
  const ownOnly = (m) => {
    const t = m.target instanceof Element ? m.target : m.target.parentElement;
    if (t?.closest(OWN)) return true;
    if (m.type !== "childList") return false;
    const nodes = [...m.addedNodes, ...m.removedNodes];
    return nodes.length > 0 && nodes.every(own);
  };
  /** @param {Set<Function>} subs @param {any} arg */
  const emit = (subs, arg) => { for (const fn of subs) { try { fn(arg); } catch (e) { console.warn("[codex-memo]", e); } } };

  /** 왼쪽 목록 안의 변화인지. 목록 틀(.sidebar-navigation)이 없는 화면에서는 대화 줄 기준으로 본다 @param {Node} target */
  const inSidebar = (target) => {
    if (nav) return nav.contains(target);
    const t = target instanceof Element ? target : target.parentElement;
    return !!t && (!!t.closest(ROW) || !!t.querySelector(ROW));
  };

  const observer = new MutationObserver((list) => {
    if (!nav?.isConnected) nav = document.querySelector(NAV);
    /** @type {MutationRecord[]} */
    const side = [];
    /** @type {Element[]} */
    const added = [];
    for (const m of list) {
      if (addedSubs.size && m.type === "childList") {
        for (const n of m.addedNodes) if (n.nodeType === 1 && !own(n)) added.push(/** @type {Element} */ (n));
      }
      // 답변 본문 등 왼쪽 목록 밖의 변화는 여기서 걸러진다
      if (sidebarSubs.size && inSidebar(m.target) && !ownOnly(m)) side.push(m);
    }
    if (side.length) emit(sidebarSubs, side);
    if (added.length) emit(addedSubs, added);
  });
  const start = () => observer.observe(document.body, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["data-app-action-sidebar-thread-id", "data-app-action-sidebar-thread-selected", "data-app-action-sidebar-thread-title"],
  });
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });

  w.__cxm = {
    version: VERSION,
    ROW, NAV, kindOf, rowIdOf, keyOf, uuidOf, rows, el, sidebarTools,
    /**
     * 화면 변화 구독. 돌려준 함수를 부르면 해제.
     * @param {{sidebar?: (list: MutationRecord[]) => void, added?: (added: Element[]) => void}} handlers
     */
    watch(handlers) {
      if (handlers.sidebar) sidebarSubs.add(handlers.sidebar);
      if (handlers.added) addedSubs.add(handlers.added);
      return () => { if (handlers.sidebar) sidebarSubs.delete(handlers.sidebar); if (handlers.added) addedSubs.delete(handlers.added); };
    },
    destroy() { observer.disconnect(); sidebarSubs.clear(); addedSubs.clear(); },
  };
})();
