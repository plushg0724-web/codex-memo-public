// @ts-check
// Small read-only view inside the existing pet. All reads are user initiated.
(() => {
  const w = /** @type {any} */ (window);
  const model = w.__cxmTaskProgressModel;
  if (!model) return;
  const CACHE = 'cxm-pet-progress-snapshot-v1', FIRST_PROJECT = 'cxm-pet-progress-show-mmh';
  function mount(host, onLayout) {
    let destroyed = false, selected = '', snapshot = null, lastReadAt = null, showFirstProject = true;
    let busy = false, epoch = 0, timeout = 0, cacheWarning = '';
    const cleanups = [];
    const on = (node, event, fn) => { node.addEventListener(event, fn); cleanups.push(() => node.removeEventListener(event, fn)); };
    const el = (tag, cls = '', text = '') => {
      const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
    };
    const button = (cls, text) => {
      const node = /** @type {HTMLButtonElement} */ (el('button', cls, text)); node.type = 'button'; return node;
    };
    const style = el('style');
    style.textContent = `
      #cxm-task-pet .cxm-progress { padding-top:2px; }
      #cxm-task-pet .cxm-progress-note { color:var(--pet-muted); font-size:11px; margin:0 0 10px; overflow-wrap:anywhere; }
      #cxm-task-pet .cxm-progress-tools { display:flex; flex-wrap:wrap; align-items:center; gap:7px; margin:8px 0; }
      #cxm-task-pet .cxm-progress-tools label { display:flex; align-items:center; gap:4px; font-size:11px; }
      /* Codex 기본 CSS 가 모든 checkbox 를 appearance:none·0px 로 만든다. 여기서는 되살린다. */
      #cxm-task-pet .cxm-progress-tools input[type=checkbox] { appearance:auto; -webkit-appearance:checkbox; width:14px; height:14px; margin:0;
        opacity:1; position:static; accent-color:var(--pet-accent); }
      #cxm-task-pet .cxm-progress-btn { background:var(--pet-mint); color:var(--pet-accent); border-radius:8px; padding:5px 10px; font-weight:700; }
      #cxm-task-pet .cxm-progress-btn:disabled { cursor:wait; opacity:.65; }
      #cxm-task-pet .cxm-progress-link { background:transparent; color:var(--pet-muted); padding:4px 2px; font-size:11px;
        text-decoration:underline; text-underline-offset:2px; }
      #cxm-task-pet .cxm-progress-link:disabled { opacity:.5; }
      #cxm-task-pet .cxm-progress-detail .cxm-pet-head { justify-content:space-between; }
      #cxm-task-pet .cxm-progress-list { display:grid; gap:6px; }
      #cxm-task-pet .cxm-progress-row { display:grid; grid-template-columns:minmax(0,1fr) 68px; text-align:left;
        gap:2px 8px; padding:10px; border:1px solid var(--pet-line); border-radius:10px; background:var(--pet-card); }
      #cxm-task-pet .cxm-progress-row[aria-expanded=true] { border-color:var(--pet-accent); }
      #cxm-task-pet .cxm-progress-name { font-weight:700; }
      #cxm-task-pet .cxm-progress-stage { color:var(--pet-muted); font-size:11px; overflow-wrap:anywhere; }
      #cxm-task-pet .cxm-progress-value { grid-column:2; grid-row:1 / span 2; text-align:right; align-self:center; font-size:11px; }
      #cxm-task-pet .cxm-progress-meter { display:block; height:4px; width:64px; margin-top:4px; border-radius:4px; overflow:hidden; background:var(--pet-line); }
      #cxm-task-pet .cxm-progress-fill { display:block; height:100%; background:var(--pet-accent); }
      #cxm-task-pet .cxm-progress-detail { margin-top:10px; border-top:1px solid var(--pet-line); padding-top:10px; overflow-wrap:anywhere; }
      #cxm-task-pet .cxm-progress-detail h3 { font-size:13px; margin:0; }
      #cxm-task-pet .cxm-progress-detail h4 { font-size:11px; margin:10px 0 3px; }
      #cxm-task-pet .cxm-progress-detail p { margin:3px 0; font-size:11px; }
      #cxm-task-pet .cxm-progress-detail ul { padding-left:18px; font-size:11px; margin:4px 0; }
      #cxm-task-pet .cxm-progress-detail a { color:var(--pet-accent); text-decoration:underline; }
      #cxm-task-pet .cxm-progress-meta { white-space:pre-line; color:var(--pet-muted); font-size:10px; }
      #cxm-task-pet .cxm-progress-error { background:var(--pet-warn-bg); color:var(--pet-warn-ink); border-radius:8px; padding:8px; }
    `;
    host.classList.add('cxm-progress');
    const connection = el('p', 'cxm-progress-note', 'Space / OpenProject 미연결 · JSON 파일로 수동 갱신');
    const tools = el('div', 'cxm-progress-tools');
    const sync = button('cxm-progress-btn', '수동 동기화 · JSON');
    sync.title = '원본에서 내보낸 JSON 파일을 선택해 읽습니다';
    const example = button('cxm-progress-link', '초기 예시 보기');
    const file = /** @type {HTMLInputElement} */ (el('input')); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    const toggle = /** @type {HTMLInputElement} */ (el('input')); toggle.type = 'checkbox';
    const label = el('label'); label.append(toggle, document.createTextNode('프로젝트 A 표시'));
    tools.append(sync, example, label, file);
    const notice = el('p', 'cxm-progress-note'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    const meta = el('p', 'cxm-progress-note cxm-progress-meta');
    const list = el('div', 'cxm-progress-list'); list.setAttribute('aria-label', '4개 업무 진척');
    const detail = el('section', 'cxm-progress-detail'); detail.id = 'cxm-progress-detail'; detail.hidden = true;
    host.append(style, connection, tools, notice, list, detail, meta);
    try {
      showFirstProject = localStorage.getItem(FIRST_PROJECT) !== 'false';
      const saved = JSON.parse(localStorage.getItem(CACHE) || 'null');
      if (saved) {
        snapshot = model.normalize(saved.snapshot);
        lastReadAt = typeof saved.lastReadAt === 'string' && Number.isFinite(Date.parse(saved.lastReadAt)) ? saved.lastReadAt : null;
      }
    } catch { cacheWarning = '저장된 자료를 읽지 못했습니다. JSON을 다시 가져와 주세요.'; }
    toggle.checked = showFirstProject;
    const dateText = value => value ? new Date(value).toLocaleString('ko-KR', {hour12: false}) : '미정';
    const sampleMode = () => snapshot?.source.kind === 'sample';
    function renderDetail() {
      detail.replaceChildren(); detail.hidden = !selected;
      if (!selected) return;
      const row = model.rows(snapshot).find(item => item.id === selected);
      if (!row) return;
      const header = el('div', 'cxm-pet-head'), title = el('h3', '', row.name + ' 상세');
      const close = button('cxm-progress-link', '상세 닫기');
      close.onclick = () => {
        const id = selected; selected = ''; render();
        list.querySelector(`[data-project="${id}"]`)?.focus();
      };
      header.append(title, close); detail.append(header);
      const field = (title, body) => detail.append(el('h4', '', title), el('p', '', body));
      field('단계', row.stage);
      if (row.summary) field('현황', row.summary);
      field('체크리스트', row.progress.percent == null
        ? '진척 미정 · 전체 체크리스트가 확인되어야 계산합니다.'
        : `${row.progress.done}/${row.progress.total} 완료 · ${row.progress.percent}% (명시된 전체 체크리스트 기준)`);
      if (row.checklist?.items.length) {
        const items = el('ul');
        for (const item of row.checklist.items) items.append(el('li', '', `${item.done ? '완료 ✓' : '미완료 ○'} · ${item.text}`));
        detail.append(items);
        if (!row.checklist.complete) detail.append(el('p', '', '일부 체크리스트 · 전체 범위 미확인'));
      }
      field('차단 사유', row.blockers?.join('\n') || '미기록');
      field('다음 행동', row.nextAction || '원본에서 다음 행동을 확인해 주세요.');
      const source = row.source;
      field('출처', source ? `${source.label}${source.ref ? '\n' + source.ref : ''}` : '아직 가져온 원본이 없습니다.');
      if (sampleMode() || source?.kind === 'sample') detail.append(el('p', '', '초기 예시 · 현재 API 동기화 자료가 아닙니다.'));
      if (source?.url) {
        const link = /** @type {HTMLAnchorElement} */ (el('a', '', '원본 열기 ↗'));
        link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; detail.append(link);
      } else detail.append(el('p', '', '원본 링크 미등록'));
      field('원본 마지막 갱신', dateText(source?.updatedAt));
      field('마지막 동기화', sampleMode() ? '없음 · 초기 예시' : lastReadAt ? `${dateText(lastReadAt)} · JSON 가져온 시각` : '없음');
    }
    function render() {
      host.dataset.phase = busy ? 'loading' : snapshot?.projects.length ? 'ready' : 'empty';
      host.setAttribute('aria-busy', String(busy));
      sync.disabled = busy; example.disabled = busy;
      sync.textContent = busy ? '자료 읽는 중…' : '수동 동기화 · JSON';
      list.replaceChildren();
      for (const row of model.rows(snapshot)) {
        if (row.id === 'mmh' && !showFirstProject) continue;
        const node = button('cxm-progress-row', ''); node.dataset.project = row.id;
        node.setAttribute('aria-expanded', String(selected === row.id)); node.setAttribute('aria-controls', detail.id);
        node.append(el('span', 'cxm-progress-name', row.name), el('span', 'cxm-progress-stage', row.stage));
        const value = el('span', 'cxm-progress-value', row.progress.percent == null ? '미정' : `${row.progress.done}/${row.progress.total} · ${row.progress.percent}%`);
        if (row.progress.percent != null) {
          const meter = el('span', 'cxm-progress-meter'); meter.setAttribute('role', 'progressbar');
          meter.setAttribute('aria-label', row.name + ' 체크리스트 완료율'); meter.setAttribute('aria-valuenow', String(row.progress.percent));
          meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100');
          const fill = el('span', 'cxm-progress-fill'); fill.style.width = `${row.progress.percent}%`; meter.append(fill); value.append(meter);
        }
        node.append(value);
        node.onclick = () => {
          selected = selected === row.id ? '' : row.id; render();
          list.querySelector(`[data-project="${row.id}"]`)?.focus();
          if (selected) detail.scrollIntoView({block: 'nearest'});
        };
        list.append(node);
      }
      meta.textContent = snapshot ? `${sampleMode() ? '초기 예시 · 현재 동기화 아님' : '가져온 JSON · 원본의 현재 상태 미확인'}\n원본 갱신: ${dateText(snapshot.source.updatedAt)}\n마지막 동기화: ${sampleMode() ? '없음' : lastReadAt ? dateText(lastReadAt) + ' (JSON)' : '없음'}` : '마지막 동기화: 없음';
      renderDetail(); onLayout();
    }
    function message(text, error = false) {
      notice.textContent = text; notice.classList.toggle('cxm-progress-error', error);
      if (error) host.dataset.phase = 'error';
    }
    async function refresh(read) {
      if (destroyed || busy) return;
      busy = true; const token = ++epoch;
      render(); message('자료를 읽고 있어요. 이전 자료는 유지합니다.');
      try {
        const raw = await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
          timeout = window.setTimeout(() => reject(Error('읽기 시간이 초과되었습니다. 다시 가져와 주세요.')), 15000);
        })]);
        if (destroyed || token !== epoch) return;
        const parsed = typeof raw === 'string' ? model.parse(raw) : model.normalize(raw);
        const next = await model.createAdapter(parsed.source.kind, () => parsed).read();
        if (destroyed || token !== epoch) return;
        snapshot = next; lastReadAt = sampleMode() ? null : new Date().toISOString();
        cacheWarning = '';
        try { localStorage.setItem(CACHE, JSON.stringify({snapshot, lastReadAt})); }
        catch { cacheWarning = '화면 저장이 제한되어 다시 열면 자료가 사라질 수 있습니다.'; }
        busy = false; render();
        message(cacheWarning || (sampleMode() ? '기능 안내용 가상 예시입니다. 실제 업무 자료가 아니며 완료율을 추정하지 않습니다.'
          : snapshot.projects.length ? 'JSON을 가져왔습니다. 최신 여부는 원본 갱신 시각을 확인하세요.' : '가져온 자료에 업무 항목이 없습니다.'));
      } catch (error) {
        if (destroyed || token !== epoch) return;
        busy = false; render();
        message(`${error instanceof Error ? error.message : '자료를 읽지 못했습니다.'} 이전 자료는 유지됩니다.`, true);
      } finally { clearTimeout(timeout); }
    }
    on(sync, 'click', () => { if (!busy) { file.value = ''; file.click(); } });
    on(file, 'change', () => {
      const selectedFile = file.files?.[0];
      if (!selectedFile || busy) return;
      void refresh(() => {
        if (selectedFile.size > model.MAX_BYTES) throw Error('JSON은 128 KiB 이하여야 합니다.');
        return selectedFile.text();
      });
    });
    on(example, 'click', () => { void refresh(model.sample); });
    on(toggle, 'change', () => {
      showFirstProject = toggle.checked;
      if (!showFirstProject && selected === 'mmh') selected = '';
      try { localStorage.setItem(FIRST_PROJECT, String(showFirstProject)); } catch { /* renderer preference only */ }
      render();
    });
    render();
    message(cacheWarning || (snapshot ? '저장된 자료입니다. 수동 동기화로 새 JSON을 가져올 수 있습니다.'
      : '아직 읽은 자료가 없어요. JSON을 가져오거나 초기 예시를 살펴보세요.'), !!cacheWarning);
    return {refresh, destroy() { destroyed = true; epoch++; clearTimeout(timeout); cleanups.splice(0).forEach(fn => fn()); host.replaceChildren(); }};
  }
  w.__cxmTaskProgress = {mount};
})();
