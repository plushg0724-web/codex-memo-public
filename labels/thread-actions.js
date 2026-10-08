// @ts-check
// 왼쪽 목록의 대화를 Codex 자신의 대화 메뉴(오른쪽 클릭 메뉴와 같은 항목)로 옮긴다.
// 메뉴는 Codex 의 네이티브 메뉴라 화면에 띄우지 않고, 대화 줄의 React 정보에서 항목 목록(getItems)을 읽어
// 고른 항목의 onSelect 를 실행한다. 목록 필터(sidebar-filter.js)와 모델 도구(agent_tools.py)가 같이 쓴다.
(() => {
  const VERSION = 3;
  const w = /** @type {any} */ (window);
  if (w.__cxmThreadActions?.version === VERSION || !w.__cxm) return;

  const { keyOf, rowIdOf, rows: allRows } = w.__cxm;
  /** @param {number} ms */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 'local:<uuid>' 와 '<uuid>' 를 같은 대화로 본다 @param {string} rowId @param {string} id */
  const sameThread = (rowId, id) => !!rowId && !!id && (rowId === id || rowId.endsWith(":" + id) || id.endsWith(":" + rowId));
  /** @param {string} threadId */
  const rowOf = (threadId) => allRows().find((r) => sameThread(rowIdOf(r), threadId)) || null;

  /** 대화 줄에 연결된 Codex 메뉴 항목 @param {HTMLElement} row @returns {Promise<any[] | null>} */
  async function menuItems(row) {
    const fiberKey = Object.keys(row).find((k) => k.startsWith("__reactFiber"));
    let f = fiberKey ? /** @type {any} */ (row)[fiberKey] : null;
    for (let i = 0; f && i < 30; i++, f = f.return) {
      const getItems = f.memoizedProps?.getItems;
      if (typeof getItems === "function") {
        const items = await getItems();
        return Array.isArray(items) ? items : null;
      }
    }
    return null;
  }

  /** 옮길 수 있는 곳(프로젝트·섹션)과 지금 위치 @param {any[] | null} items */
  function parse(items) {
    /** @type {{id: string, name: string, group: '프로젝트' | '섹션', checked: boolean, item: any}[]} */
    const destinations = [];
    /** @type {any} */
    let remove = null;
    for (const group of items || []) {
      if (group.id === "move-thread-to-project") {
        for (const x of group.submenu || []) if (typeof x.onSelect === "function" && x.messageValues?.projectName)
          destinations.push({ id: x.id, name: String(x.messageValues.projectName), group: "프로젝트", checked: false, item: x });
      } else if (group.id === "move-to-custom-section") {
        for (const x of group.submenu || []) if (x.type === "checkbox" && typeof x.onSelect === "function" && x.messageValues?.name)
          destinations.push({ id: x.id, name: String(x.messageValues.name), group: "섹션", checked: !!x.checked, item: x });
      } else if (group.id === "remove-thread-from-project" && typeof group.onSelect === "function") {
        remove = group;
      }
    }
    return {
      destinations,
      remove,
      project: remove?.messageValues?.projectName ? String(remove.messageValues.projectName) : null,
      sections: destinations.filter((d) => d.group === "섹션" && d.checked).map((d) => d.name),
    };
  }

  // Codex 가 확인 창을 띄우면 닫힐 때까지 기다린 뒤 다음 대화로 넘어간다
  const waitDialogs = async () => { for (let i = 0; i < 600 && document.querySelector('[role="dialog"], [role="alertdialog"]'); i++) await sleep(200); };

  /** @param {string} threadId */
  async function inspect(threadId) {
    const row = rowOf(threadId);
    if (!row) throw new Error("왼쪽 목록에 보이지 않는 대화입니다. 폴더를 펼치거나 '더 보기'를 눌러 목록에 보이게 해 주세요.");
    const parsed = parse(await menuItems(row));
    if (!parsed.destinations.length && !parsed.remove) throw new Error("이 대화는 옮길 수 없습니다(Codex 메뉴를 찾지 못함).");
    return { row, ...parsed };
  }

  w.__cxmThreadActions = {
    version: VERSION,
    keyOf,
    rowOf,
    menuItems,
    parse,
    waitDialogs,
    /** 왼쪽 목록에 지금 그려진 대화 */
    rows: () => allRows().map((r) => ({
      rowId: rowIdOf(r), key: keyOf(r), title: r.dataset.appActionSidebarThreadTitle || "",
      host: r.dataset.appActionSidebarThreadHostId || "", pinned: r.dataset.appActionSidebarThreadPinned === "true",
    })).filter((r) => r.rowId),
    /** 지금 위치(프로젝트 이름·들어 있는 섹션) @param {string} threadId */
    async locate(threadId) {
      const { project, sections } = await inspect(threadId);
      return { project, sections };
    },
    /** 여러 대화를 옮길 수 있는 곳(합집합) @param {string[]} threadIds */
    async destinations(threadIds) {
      /** @type {Map<string, {id: string, name: string, group: string}>} */
      const found = new Map();
      for (const id of threadIds.slice(0, 50)) {
        try { for (const d of (await inspect(id)).destinations) found.set(d.id, { id: d.id, name: d.name, group: d.group }); } catch { /* 이 대화는 건너뜀 */ }
      }
      return [...found.values()];
    },
    /**
     * 대화들을 한 곳으로 옮긴다. destination 은 메뉴 항목 id 또는 이름('프로젝트:이름'·'섹션:이름'·'이름').
     * @param {string[]} threadIds @param {string} destination @param {(done: number, total: number) => void} [progress]
     */
    async move(threadIds, destination, progress) {
      const [prefix, ...rest] = String(destination).split(":");
      const byGroup = (prefix === "프로젝트" || prefix === "섹션") && rest.length ? { group: prefix, name: rest.join(":") } : null;
      /** @param {{id: string, name: string, group: string}} d */
      const pick = (d) => d.id === destination || (byGroup ? d.group === byGroup.group && d.name === byGroup.name : d.name === destination);
      const moved = [], skipped = [], failed = [];
      /** @type {Record<string, {project: string | null, sections: string[]}>} */
      const before = {};
      for (const [i, id] of threadIds.entries()) {
        progress?.(i, threadIds.length);
        try {
          const state = await inspect(id);
          const dest = state.destinations.find(pick);
          // 이미 그 프로젝트에 있으면 메뉴에 없고, 섹션은 이미 들어 있으면 체크돼 있다(누르면 빠지므로 건너뜀)
          if (!dest || dest.checked) { skipped.push(id); continue; }
          before[id] = { project: state.project, sections: state.sections };
          await dest.item.onSelect();
          moved.push(id);
          await sleep(350);
          await waitDialogs();
        } catch (e) { failed.push({ id, error: /** @type {any} */ (e)?.message || String(e) }); }
      }
      progress?.(threadIds.length, threadIds.length);
      return { moved, skipped, failed, before };
    },
    /** 되돌리기: 옮기기 전 위치로 @param {string} threadId @param {{project: string | null, sections: string[]}} before */
    async restore(threadId, before) {
      let state = await inspect(threadId);
      if (state.project !== before.project) {
        if (before.project == null) {
          if (!state.remove) throw new Error("프로젝트에서 빼는 메뉴를 찾지 못했습니다.");
          await state.remove.onSelect();
        } else {
          const d = state.destinations.find((x) => x.group === "프로젝트" && x.name === before.project);
          if (!d) throw new Error(`'${before.project}' 프로젝트를 찾지 못했습니다.`);
          await d.item.onSelect();
        }
        await sleep(350); await waitDialogs();
        state = await inspect(threadId);
      }
      for (const d of state.destinations.filter((x) => x.group === "섹션")) {
        if (d.checked !== before.sections.includes(d.name)) { await d.item.onSelect(); await sleep(250); }
      }
      return true;
    },
  };
})();
