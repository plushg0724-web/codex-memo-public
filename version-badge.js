// @ts-check
// 왼쪽 사이드바 도구 줄의 버전 버튼. 누르면 기존 Codex 메모 설정 창을 연다.
(() => {
  const VERSION = 4;
  const w = /** @type {any} */ (window);
  if (w.__cxmVersionBadge?.version === VERSION) {
    w.__cxmVersionBadge.refresh();
    return;
  }
  try { w.__cxmVersionBadge?.destroy(); } catch { /* 예전 버전 */ }

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .cxm-version-badge { flex-shrink: 0; padding: 4px 6px; font: inherit; font-size: 11px; line-height: 16px;
      color: var(--color-token-text-tertiary, #8b8f97); background: transparent; border: 1px solid transparent;
      border-radius: 6px; cursor: pointer; pointer-events: auto; }
    .cxm-version-badge:hover { color: var(--color-token-text-primary, #d7d9dd); background: var(--color-token-bg-hover, #80808018); }
    .cxm-version-badge:focus-visible { outline: 2px solid #588ca1; outline-offset: 2px; }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  // Codex 가 사이드바를 다시 그리면 표시가 사라지므로 주기적으로 확인해 다시 붙인다
  const attach = () => {
    const tools = w.__cxm?.sidebarTools?.();
    if (!tools) return;
    let badge = /** @type {HTMLElement | null} */ (document.querySelector(".cxm-version-badge"));
    if (!badge) {
      badge = document.createElement("button");
      /** @type {HTMLButtonElement} */ (badge).type = "button";
      badge.className = "cxm-version-badge";
      badge.title = "Codex 메모 설정 열기";
      badge.setAttribute("aria-label", "Codex 메모 설정 열기");
      badge.addEventListener("click", () => window.dispatchEvent(new CustomEvent("codex-labels:open-settings")));
    }
    if (badge.parentElement !== tools || badge !== tools.firstElementChild) tools.prepend(badge);
    const text = `Codex 메모 v${w.__cxmAppVersion || "?"}`;
    if (badge.textContent !== text) badge.textContent = text;
  };
  attach();
  // 왼쪽 목록이 바뀔 때 다시 붙인다(common.js). 사이드바가 통째로 다시 만들어지는 경우를 위해 가끔 확인도 한다.
  const unwatch = w.__cxm?.watch({ sidebar: attach });
  const timer = setInterval(attach, unwatch ? 10000 : 2000);

  const runtime = {
    version: VERSION,
    refresh: attach,
    destroy() {
      clearInterval(timer);
      unwatch?.();
      document.querySelectorAll(".cxm-version-badge").forEach((n) => n.remove());
      document.querySelectorAll(".cxm-sidebar-tools:empty").forEach((n) => n.remove());
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
      if (w.__cxmVersionBadge === runtime) delete w.__cxmVersionBadge;
    },
  };
  w.__cxmVersionBadge = runtime;
})();
