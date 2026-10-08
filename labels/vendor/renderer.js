(() => {
  'use strict';
  if (window.__codexLabelsInstalled) {
    // 도우미를 업데이트해 다시 연결했을 때 열린 화면에도 정렬 수정을 적용한다.
    const rules = document.getElementById('codex-label-styles')?.sheet?.cssRules || [];
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule && rule.selectorText.includes('.cdx-label[data-kind="status"] .cdx-label-text')) {
        rule.style.display = 'flex'; rule.style.alignItems = 'center'; rule.style.justifyContent = 'center';
      }
    }
    return;
  }
  if (!window.codexLabels) return;
  window.__codexLabelsInstalled = true;
  const api = window.codexLabels;
  const threadSel='[data-app-action-sidebar-thread-row]';
  const projectSel='[data-app-action-sidebar-project-row]';
  const rowSelector=threadSel+','+projectSel;
  const ownSelector='#cdx-label-menu,#cdx-label-error,#cdx-label-settings,.cdx-label,.cdx-header-labels';
  const statusIds=new Set(['requested','in_progress','in_review','completed','on_hold']);
  const labelKind=label=>label?.kind||(statusIds.has(label?.id)?'status':'category');
  const kindNames={status:'진행 상태',category:'카테고리'};
  function assignment(snap,key,kind){
    const id=kind==='category'?snap.categoryAssignments?.[key]:snap.assignments?.[key];
    if(id&&labelKind(snap.config.labels.find(label=>label.id===id))===kind)return id;
    if(kind==='category'&&!snap.categoryAssignments){
      const legacy=snap.assignments?.[key];
      if(legacy&&labelKind(snap.config.labels.find(label=>label.id===legacy))==='category')return legacy;
    }
    return null;
  }
  const rows=new Map(),dirtyRows=new Set();
  let labels=new Map(),snapshot,menu=null,menuKey=null,opener=null,settings=null,openingSettings=false;
  let frame=0,reading=false,writing=false,readPending=false,readEpoch=0,disposed=false,lastReport='';
  let readQueue=Promise.resolve();
  const style=document.createElement('style');style.id='codex-label-styles';
  style.textContent=`
    .cdx-label{display:inline-flex!important;align-items:center;justify-content:center;flex-shrink:0;white-space:nowrap;line-height:1.4;vertical-align:middle;font-family:inherit;font-weight:600;cursor:pointer;user-select:none;max-width:min(140px,28%);overflow:hidden;text-overflow:ellipsis}
    .cdx-label-host{display:flex!important;flex-direction:row!important;align-items:center!important;min-width:0}
    .cdx-label[data-unset]{opacity:0.28;background:transparent!important;color:inherit!important;border:1px dashed currentColor}
    .cdx-label-text{display:block;flex-shrink:0;max-width:100%;max-height:100%;overflow:hidden;text-overflow:ellipsis}
    .cdx-label[data-kind="status"] .cdx-label-text,#cdx-label-settings .cdx-settings-preview-badge[data-kind="status"] .cdx-label-text{display:flex;align-items:center;justify-content:center;width:14px;height:20px;text-overflow:clip}
    [data-app-action-sidebar-thread-row]:hover .cdx-label,[data-app-action-sidebar-project-row]:hover .cdx-label,.cdx-label:focus-visible{opacity:1}
    .cdx-label:focus-visible{outline:2px solid #7dd3fc;outline-offset:2px}
    .cdx-header-labels{display:inline-flex;align-items:center;gap:6px;min-width:0;flex-shrink:1;margin-inline-start:6px;pointer-events:auto;-webkit-app-region:no-drag}
    .cdx-header-labels .cdx-label{max-width:150px;min-width:0;border:1px solid currentColor;border-radius:6px;padding:3px 7px;font-size:11px;line-height:1.4;writing-mode:horizontal-tb;opacity:1}
    @media(max-width:540px){.cdx-header-labels{gap:4px;margin-inline-start:4px}.cdx-header-labels .cdx-label{max-width:100px;padding:3px 5px}}
    #cdx-label-menu{position:fixed;z-index:2147483647;box-sizing:border-box;width:220px;padding:8px;border:1px solid #52565e;border-radius:10px;background:#202123;color:#f5f6f7;box-shadow:0 8px 30px #0006;font:13px/1.5 'Segoe UI','Malgun Gothic',sans-serif;max-height:80vh;overflow:auto}
    #cdx-label-menu button{display:flex;align-items:center;gap:9px;width:100%;background:transparent;color:inherit;border:0;border-radius:5px;padding:8px;text-align:left;cursor:pointer;font:inherit}
    #cdx-label-menu button:hover,#cdx-label-menu button:focus-visible{background:#3a3d42;outline:1px solid #7dd3fc}
    #cdx-label-menu button:disabled{opacity:.5;cursor:wait}#cdx-label-menu .swatch{width:12px;height:12px;border-radius:3px;flex-shrink:0}
    #cdx-label-menu .notice{margin:6px 8px;color:#ffbd86;font-size:12px}#cdx-label-menu .caption{padding:4px 8px;color:#b6bdc7;font-size:11px}
    #cdx-label-error{position:fixed;bottom:18px;right:18px;z-index:2147483647;max-width:420px;padding:12px;border:1px solid #fb923c;border-radius:8px;background:#202123;color:#fff;font:13px/1.5 sans-serif;display:flex;align-items:flex-start;gap:10px}#cdx-label-error button{flex-shrink:0;border:0;background:none;color:#b6bdc7;font-size:16px;line-height:1;padding:0 2px;cursor:pointer}#cdx-label-error button:hover{color:#fff}
    #cdx-label-settings{position:fixed;inset:0;margin:auto;padding:0;width:min(720px,calc(100vw - 32px));max-width:none;max-height:calc(100vh - 32px);border:1px solid #4b4e54;border-radius:14px;background:#202123;color:#f5f6f7;box-shadow:0 20px 80px #0008;font:13px/1.5 'Segoe UI','Malgun Gothic',sans-serif;color-scheme:dark;overflow:auto}
    #cdx-label-settings::backdrop{background:#0008}
    #cdx-label-settings *,#cdx-label-settings *::before,#cdx-label-settings *::after{box-sizing:border-box}
    #cdx-label-settings [hidden]{display:none!important}
    #cdx-label-settings form{margin:0;padding:0}#cdx-label-settings h2{margin:0;font-size:20px;font-weight:600;line-height:1.4}#cdx-label-settings p{margin:6px 0 0}
    #cdx-label-settings .cdx-settings-head{padding:22px 24px 16px;border-bottom:1px solid #3c3f44}
    #cdx-label-settings .cdx-settings-subtitle,#cdx-label-settings .cdx-settings-help{color:#aeb5bf;font-size:12px}
    #cdx-label-settings .cdx-settings-body{display:grid;grid-template-columns:142px minmax(0,1fr);gap:22px;padding:20px 24px}
    #cdx-label-settings .cdx-settings-nav{display:flex;flex-direction:column;gap:5px;align-self:start}
    #cdx-label-settings button{border:1px solid #555963;border-radius:7px;background:#303237;color:inherit;padding:8px 12px;font:inherit;cursor:pointer}
    #cdx-label-settings button:hover{background:#3c4046}#cdx-label-settings button:focus-visible,#cdx-label-settings input:focus-visible,#cdx-label-settings textarea:focus-visible,#cdx-label-settings select:focus-visible{outline:2px solid #7dd3fc;outline-offset:2px}
    #cdx-label-settings button:disabled{opacity:.5;cursor:default}#cdx-label-settings .cdx-settings-nav button{display:flex;align-items:center;gap:8px;width:100%;border-color:transparent;background:transparent;text-align:left;overflow-wrap:anywhere}
    #cdx-label-settings .cdx-settings-nav button[aria-pressed="true"]{border-color:#606873;background:#34383e}
    #cdx-label-settings .cdx-settings-nav .cdx-settings-add{margin-top:8px;border:1px dashed #606873;color:#7dd3fc}
    #cdx-label-settings .cdx-settings-dot{width:10px;height:10px;flex:none;border-radius:3px}
    #cdx-label-settings .cdx-settings-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}
    #cdx-label-settings .cdx-settings-field{display:flex;flex-direction:column;gap:5px;min-width:0;font-size:12px;color:#cbd1d8}
    #cdx-label-settings .cdx-settings-wide{grid-column:1/-1}
    #cdx-label-settings input:not([type="checkbox"]):not([type="color"]),#cdx-label-settings textarea,#cdx-label-settings select{width:100%;min-height:35px;border:1px solid #565b64;border-radius:6px;background:#17191c;color:#f5f6f7;padding:7px 9px;font-family:inherit;font-size:13px;line-height:1.4}
    #cdx-label-settings .cdx-settings-group{margin:7px 0 2px;color:#aeb5bf;font-size:11px}
    #cdx-label-settings textarea{resize:vertical;min-height:60px;max-height:150px}
    #cdx-label-settings input[type="color"]{width:38px;height:35px;flex:none;padding:3px;border:1px solid #565b64;border-radius:6px;background:#17191c;cursor:pointer}
    #cdx-label-settings .cdx-settings-color{display:flex;gap:7px}#cdx-label-settings .cdx-settings-color input[type="text"]{min-width:0;font-family:monospace}
    #cdx-label-settings .cdx-settings-check{display:flex;gap:8px;align-items:center;color:#e0e5eb}#cdx-label-settings input[type="checkbox"]{width:15px;height:15px;accent-color:#7dd3fc}
    #cdx-label-settings .cdx-settings-preview{margin-top:17px;padding:13px 15px;border:1px solid #40454d;border-radius:8px;background:#181a1d}
    #cdx-label-settings .cdx-settings-preview-row{display:flex;align-items:center;margin-top:8px;min-height:32px;color:#e4e7ec}
    #cdx-label-settings .cdx-settings-preview-badge{display:inline-flex;align-items:center;justify-content:center;line-height:1.4;font-weight:600;white-space:nowrap;flex-shrink:0;max-width:160px;overflow:hidden;text-overflow:ellipsis}
    #cdx-label-settings details,#cdx-label-settings .cdx-settings-updates{margin-top:17px;border-top:1px solid #3c3f44;padding-top:12px}#cdx-label-settings summary{cursor:pointer;color:#dbe1e9}#cdx-label-settings .cdx-settings-appearance{margin-top:12px}
    #cdx-label-settings .cdx-update-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
    #cdx-label-settings .cdx-settings-status{margin:0 24px 16px;padding:11px 13px;border:1px solid #9c7145;border-radius:7px;background:#3c3025;color:#ffd4a5;font-size:12px;overflow-wrap:anywhere}
    #cdx-label-settings .cdx-settings-status button{margin-top:8px;font-size:12px}
    #cdx-label-settings .cdx-settings-footer{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:16px 24px;border-top:1px solid #3c3f44}
    #cdx-label-settings .cdx-settings-file{margin-right:auto;font-size:12px;color:#bfc7d2;background:transparent;border-color:transparent;padding-left:0}
    #cdx-label-settings .cdx-settings-save{background:#7dd3fc;color:#082f49;border-color:#7dd3fc;font-weight:600}#cdx-label-settings .cdx-settings-save:hover{background:#a2e0ff}
    #cdx-label-settings .cdx-settings-tabs{display:flex;gap:6px;padding:14px 24px 0;border-bottom:1px solid #3c3f44}
    #cdx-label-settings .cdx-settings-tabs button{background:transparent;border-color:transparent;border-radius:7px 7px 0 0;color:#bfc7d2;padding:9px 12px}
    #cdx-label-settings .cdx-settings-tabs button[aria-selected="true"]{color:#7dd3fc;border-bottom:2px solid #7dd3fc;background:#292d33}
    #cdx-label-settings .cdx-settings-section{padding:22px 24px;min-height:280px}
    #cdx-label-settings .cdx-settings-section h3{font-size:15px;margin:0 0 6px}
    #cdx-label-settings .cdx-settings-draft-note{margin-right:auto;font-size:12px;color:#ffd4a5}
    #cdx-label-settings .cdx-settings-dismiss{margin:0 24px 16px;padding:12px;border:1px solid #9c7145;border-radius:7px;background:#3c3025;color:#ffd4a5}
    #cdx-label-settings .cdx-settings-dismiss-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
    @media(max-width:540px){#cdx-label-settings .cdx-settings-body{grid-template-columns:1fr;padding:16px;gap:14px}#cdx-label-settings .cdx-settings-nav{flex-direction:row;flex-wrap:wrap}#cdx-label-settings .cdx-settings-nav button{width:auto}#cdx-label-settings .cdx-settings-head,#cdx-label-settings .cdx-settings-footer{padding:16px}#cdx-label-settings .cdx-settings-status{margin:0 16px 16px}}
  `;
  document.head.append(style);
  // [codex-memo 변경] 알림에 닫기 버튼을 달고 12초 뒤 저절로 닫는다(원본은 다음 저장 성공 전까지 계속 떠 있음)
  let errorTimer=0;
  function clearError(){clearTimeout(errorTimer);document.getElementById('cdx-label-error')?.remove();}
  function error(e){let box=document.getElementById('cdx-label-error');if(!box){box=document.createElement('div');box.id='cdx-label-error';box.role='alert';document.body.append(box);}
    const text=document.createElement('span');text.textContent='라벨: '+(e?.message||String(e));
    const close=document.createElement('button');close.type='button';close.textContent='×';close.title='닫기';close.setAttribute('aria-label','알림 닫기');close.addEventListener('click',clearError);
    box.replaceChildren(text,close);clearTimeout(errorTimer);errorTimer=setTimeout(clearError,12000);}
  function compactBadgeStyle(label,kind,appearance){
    const status=kind==='status',unset=!label;
    return {backgroundColor:label?.backgroundColor||'transparent',color:label?.textColor||'inherit',
      fontSize:(status?Math.min(appearance.fontSizePx,9):appearance.fontSizePx)+'px',borderRadius:appearance.borderRadiusPx+'px',
      boxSizing:'border-box',writingMode:status?'vertical-rl':'horizontal-tb',textOrientation:'upright',lineHeight:'1.2',
      width:status||unset?'16px':'auto',height:status&&!unset?'20px':unset?'16px':'auto',maxHeight:status?'20px':'26px',
      padding:status?'0':unset?'1px 0':`${appearance.verticalPaddingPx}px ${appearance.horizontalPaddingPx}px`,marginInlineEnd:'',marginRight:appearance.gapPx+'px'};
  }
  function identity(row){
    const d=row.dataset;
    // [codex-memo 변경] host(local·durable·remote-ssh-… 등)는 Codex 버전·실행 환경에 따라 바뀌므로 열쇠에서 뺀다(항상 local).
    if(row.matches(threadSel))return window.__cxm ? window.__cxm.keyOf(row) :
      d.appActionSidebarThreadId ? `thread:local:${d.appActionSidebarThreadKind||'local'}:${d.appActionSidebarThreadId}` : null;
    return d.appActionSidebarProjectId ? `project:${d.appActionSidebarProjectId}` : null;
  }
  function titleNode(row){
    const title=row.getAttribute('data-app-action-sidebar-thread-title')||row.getAttribute('data-app-action-sidebar-project-label');
    if(!title)return null;
    const walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);
    for(let node;node=walker.nextNode();){if(node.parentElement.closest('.cdx-label'))continue;if(node.textContent.trim()===title.trim())return node;}
    return null;
  }
  function observeRow(row,state){
    state.observer.observe(row,{childList:true,subtree:true,characterData:true,attributes:true,
      attributeFilter:['data-app-action-sidebar-thread-title','data-app-action-sidebar-thread-id',
        'data-app-action-sidebar-thread-host-id','data-app-action-sidebar-thread-kind',
        'data-app-action-sidebar-project-label','data-app-action-sidebar-project-id']});
  }
  function registerRow(row){
    if(rows.has(row)||!row.isConnected)return;
    const state={badges:{},host:null,views:{},observer:new MutationObserver(mutations=>{
      if(mutations.some(m=>!(m.target instanceof Element?m.target:m.target.parentElement)?.closest(ownSelector))){
        dirtyRows.add(row);schedule();
      }
    })};
    rows.set(row,state);observeRow(row,state);dirtyRows.add(row);schedule();
  }
  function unregisterRow(row){
    if(row.isConnected&&row.matches(rowSelector))return;
    const state=rows.get(row);if(!state)return;
    state.observer.disconnect();Object.values(state.badges).forEach(badge=>badge.remove());state.host?.classList.remove('cdx-label-host');rows.delete(row);dirtyRows.delete(row);schedule();
  }
  function visitRows(node,visit){
    if(!(node instanceof Element)||node.closest(ownSelector))return;
    if(node.matches(rowSelector))visit(node);
    node.querySelectorAll(rowSelector).forEach(visit);
  }
  function paintRow(row,state){
    const key=identity(row),node=key&&titleNode(row);
    if(!node){Object.values(state.badges).forEach(badge=>badge.remove());state.host?.classList.remove('cdx-label-host');state.badges={};state.host=null;state.views={};return;}
    // The title's marquee translates every descendant. Keep the badge beside
    // its viewport, so hovering a long title never moves the menu trigger.
    const marquee=node.parentElement.closest('[data-marquee-text]');
    const anchor=marquee&&row.contains(marquee)?marquee:node;
    const host=anchor.parentNode;
    if(state.host!==host){state.host?.classList.remove('cdx-label-host');state.host=host;host.classList.add('cdx-label-host');}
    for(const kind of ['status','category']){
      let badge=state.badges[kind];
      if(!badge||!row.contains(badge)){
        badge=document.createElement('span');badge.className='cdx-label';badge.role='button';badge.tabIndex=0;
        badge.setAttribute('aria-haspopup','menu');badge.dataset.kind=kind;state.badges[kind]=badge;delete state.views[kind];
      }
      const next=kind==='status'&&state.badges.category?.parentNode===host?state.badges.category:anchor;
      if(badge.parentNode!==host||!(badge.compareDocumentPosition(next)&Node.DOCUMENT_POSITION_FOLLOWING))host.insertBefore(badge,next);
      const id=assignment(snapshot,key,kind),label=labels.get(id),a=snapshot.config.appearance;
      const view=JSON.stringify([key,id,label?.name,label?.description,label?.backgroundColor,label?.textColor,
        a.fontSizePx,a.borderRadiusPx,a.verticalPaddingPx,a.horizontalPaddingPx,a.gapPx]);
      if(view===state.views[kind])continue;
      state.views[kind]=view;badge.dataset.key=key;badge.dataset.labelId=id||'';badge.replaceChildren(element('span','cdx-label-text',label?label.name:'＋'));
      badge.toggleAttribute('data-unset',!label);
      badge.setAttribute('aria-label',label?`${kindNames[kind]} ${label.name} 변경`:`${kindNames[kind]} 지정`);
      badge.title=label?`${kindNames[kind]}: ${label.name}${label.description?' · '+label.description:''} · 클릭하여 변경`:`${kindNames[kind]} 지정`;
      Object.assign(badge.style,compactBadgeStyle(label,kind,a));
    }
  }
  // Use the selected row's canonical key; never identify a conversation by title.
  window.__codexLabelsHeaderInstalled=true;
  let headerLabels=null,headerKey=null;
  const titleSelector='[data-app-shell-titlebar-content]';
  function paintHeader(){
    const selected=document.querySelector(threadSel+'[data-app-action-sidebar-thread-selected="true"]');
    // Filters, collapsed projects and virtualized lists may omit the open row.
    // The app router provides the actual conversation ID independently of the sidebar.
    const routed=window.__cxmThreads?.currentId();
    const selectedKey=selected&&identity(selected);
    const key=routed ? (selectedKey?.endsWith(':'+routed) ? selectedKey : `thread:local:local:local:${routed}`) : selectedKey;
    const title=key===selectedKey ? selected?.dataset.appActionSidebarThreadTitle : null;
    const host=key&&[...document.querySelectorAll(titleSelector)].find(node=>
      !node.closest('[aria-hidden="true"]')&&node.getBoundingClientRect().width>0&&
      [...node.childNodes].some(child=>child!==headerLabels&&child.textContent.trim()&&
        (!title||child.textContent.trim()===title.trim())));
    if(!host){if(headerKey&&menuKey===headerKey)closeMenu();headerLabels?.remove();headerKey=null;return;}
    if(headerKey&&headerKey!==key&&menuKey===headerKey)closeMenu();
    headerKey=key;
    if(!headerLabels){
      headerLabels=element('span','cdx-header-labels');
      headerLabels.setAttribute('role','group');headerLabels.setAttribute('aria-label','현재 대화 라벨');
      for(const kind of ['status','category']){
        const badge=button('', 'cdx-label');badge.dataset.kind=kind;badge.setAttribute('aria-haspopup','menu');headerLabels.append(badge);
      }
    }
    if(headerLabels.parentNode!==host)host.append(headerLabels);
    for(const badge of headerLabels.children){
      const kind=badge.dataset.kind,id=assignment(snapshot,key,kind),label=labels.get(id);
      const text=(kind==='status'?'상태':'카테고리')+': '+(label?.name||'미지정');
      if(badge.textContent!==text)badge.textContent=text;
      badge.dataset.key=key;badge.dataset.labelId=id||'';
      badge.setAttribute('aria-label',text+' 변경');badge.title=text+' · 클릭하여 변경';
      badge.style.backgroundColor=label?.backgroundColor||'transparent';badge.style.color=label?.textColor||'inherit';
    }
  }
  function paint(){
    if(!snapshot)return;
    for(const row of dirtyRows){
      const state=rows.get(row);if(!state)continue;
      if(!row.isConnected){unregisterRow(row);continue;}
      state.observer.disconnect();
      try{paintRow(row,state);}finally{observeRow(row,state);}
    }
    dirtyRows.clear();
    paintHeader();
    const counts={rows:rows.size,badges:[...rows.values()].filter(state=>state.badges.status?.isConnected&&state.badges.category?.isConnected).length};
    const report=JSON.stringify(counts);
    if(api.report&&report!==lastReport){lastReport=report;api.report(counts).catch(()=>{lastReport='';});}
  }
  function schedule(){if(frame||disposed)return;frame=requestAnimationFrame(()=>{frame=0;paint();});}
  function acceptSnapshot(next){
    if(!next||disposed||next.snapshotVersion&&snapshot?.snapshotVersion===next.snapshotVersion)return;
    const previous=snapshot,configChanged=!previous||previous.configRevision!==next.configRevision;
    snapshot=next;
    if(configChanged)labels=new Map(next.config.labels.filter(label=>label.enabled).map(label=>[label.id,label]));
    for(const row of rows.keys()){
      const key=identity(row);
      if(configChanged||['status','category'].some(kind=>assignment(previous,key,kind)!==assignment(next,key,kind)))dirtyRows.add(row);
    }
    // Report readiness even when the current screen has no sidebar rows (for
    // example Usage/settings). The launcher must not mistake 0/0 for a hang.
    schedule();
    settingsChangedExternally();
    if(menu&&opener?.isConnected)showMenu(opener);
  }
  function beginWrite(){writing=true;readEpoch++;}
  function endWrite(){writing=false;if(readPending)read();}
  function fetchSnapshot(knownVersion){
    // Settings dialogs and background refreshes share one read lane. A slow
    // response must not arrive after a newer response and roll the UI back.
    const request=readQueue.then(()=>{
      if(disposed)throw Error('라벨 화면이 종료되었습니다.');
      return api.read(knownVersion);
    });
    readQueue=request.catch(()=>{});return request;
  }
  async function readFresh(){
    const epoch=++readEpoch,next=await fetchSnapshot();
    if(disposed||epoch!==readEpoch){read();throw Error('설정이 변경되었습니다. 다시 불러와 주세요.');}
    return next;
  }
  function closeMenu(focus=false){menu?.remove();menu=null;menuKey=null;if(focus&&opener?.isConnected)opener.focus({preventScroll:true});}
  function onScroll(event){
    if(!menu)return;
    // Streaming chat and the menu itself can scroll independently of the badge.
    // Only an ancestor scroll can move its anchor and invalidate this position.
    const target=event.target;
    if(target===document||(target instanceof Element&&opener&&target.contains(opener)))closeMenu();
  }
  function showMenu(badge){
    closeMenu();opener=badge;menuKey=badge.dataset.key;
    menu=document.createElement('div');menu.id='cdx-label-menu';menu.role='menu';menu.dataset.key=menuKey;menu.setAttribute('aria-label','진행 상태 및 카테고리');
    const add=(text,color,action,container=menu)=>{const b=document.createElement('button');b.type='button';b.role='menuitem';if(color){const dot=document.createElement('span');dot.className='swatch';dot.style.backgroundColor=color;b.append(dot);}b.append(document.createTextNode(text));b.addEventListener('click',action);container.append(b);return b;};
    const choose=(id,kind)=>async()=>{
      if(writing)return;beginWrite();const key=menuKey;menu.querySelectorAll('button').forEach(b=>b.disabled=true);
      try{acceptSnapshot(await api.assign(key,id,kind));closeMenu(true);clearError();}
      catch(e){error(e);menu?.querySelectorAll('button').forEach(b=>b.disabled=false);}finally{endWrite();}
    };
    // [codex-memo 변경] 보관함과 설정은 한 창(탭으로 오감)이므로 메뉴 맨 위 항목 하나로 연다
    add(api.vocabularyRead?'보관함 · 설정…':'설정…',null,()=>{if(api.vocabularyRead){closeMenu();window.dispatchEvent(new Event('codex-labels:open-vocabulary'));}else showSettings().catch(error);}).classList.add('cdx-menu-library');
    for(const kind of ['status','category']){
      const group=element('div');group.role='group';group.dataset.kind=kind;group.setAttribute('aria-label',kindNames[kind]);
      group.append(element('div','caption',kindNames[kind]));
      for(const l of [...snapshot.config.labels].filter(l=>l.enabled&&labelKind(l)===kind).sort((a,b)=>a.order-b.order)){
        const option=add(l.name,l.backgroundColor,choose(l.id,kind),group);option.dataset.kind=kind;option.dataset.labelId=l.id;
        if(assignment(snapshot,menuKey,kind)===l.id)option.setAttribute('aria-current','true');
      }
      const unset=add(kindNames[kind]+' 해제',null,choose(null,kind),group);unset.dataset.kind=kind;group.lastChild.dataset.unset='';menu.append(group);
    }
    if(api.paseoRpc)add('Paseo 연결…',null,()=>{closeMenu();window.dispatchEvent(new Event('codex-labels:open-paseo'));});
    if(snapshot.configError){const p=document.createElement('p');p.className='notice';p.textContent='설정 오류로 마지막 정상 설정을 표시합니다: '+snapshot.configError;menu.append(p);}
    document.body.append(menu);const r=badge.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(r.left,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(r.bottom+6,innerHeight-menu.offsetHeight-8))+'px';
    const group=menu.querySelector(`[role=group][data-kind="${badge.dataset.kind==='category'?'category':'status'}"]`);
    const focus=group.querySelector('[aria-current=true]')||group.querySelector('button');focus?.focus({preventScroll:true});focus?.scrollIntoView({block:'nearest'});
  }
  function element(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
  function button(text,className,action){const node=element('button',className,text);node.type='button';if(action)node.addEventListener('click',action);return node;}
  function closeSettings(discard=false){
    if(!settings||settings.saving||settings.restarting)return;
    if(settings.dialog.querySelector('[data-settings-busy="true"]')){settings.dismissMessage('설정을 저장하고 있습니다. 완료된 뒤 닫아 주세요.');return;}
    if(discard!==true&&JSON.stringify(settings.draft)!==settings.savedConfig){settings.dismissMessage('저장하지 않은 라벨 편집 내용이 있습니다.',true);return;}
    const {dialog,returnFocus}=settings;settings=null;dialog.close();dialog.remove();
    if(returnFocus?.isConnected)returnFocus.focus();else if(opener?.isConnected)opener.focus();
  }
  function settingsChangedExternally(){
    if(!settings||settings.saving)return;
    const changed=snapshot.configRevision!==settings.revision;
    if(changed||snapshot.configError){
      settings.conflict=true;settings.save.disabled=true;
      settings.message(snapshot.configError?'설정 파일에 오류가 있습니다. 파일을 수정한 뒤 다시 불러와 주세요. '+snapshot.configError:'다른 곳에서 라벨 설정을 변경했습니다. 현재 편집 내용은 유지했습니다. 파일 설정을 다시 불러온 뒤 수정해 주세요.',true);
      settings.updateControls?.();
    }
  }
  async function showSettings(requestedTab='labels'){
    const tab=['labels','vocabulary','automation'].includes(requestedTab)?requestedTab:'labels';
    if(settings){settings.selectTab(tab,true);return;}
    if(openingSettings)return;openingSettings=true;closeMenu();
    const returnFocus=document.activeElement;
    let fresh;
    try{fresh=await readFresh();}finally{openingSettings=false;}
    if(disposed)return;
    acceptSnapshot(fresh);
    const dialog=element('dialog');dialog.id='cdx-label-settings';dialog.setAttribute('aria-labelledby','cdx-label-settings-title');dialog.setAttribute('aria-describedby','cdx-label-settings-description');
    const form=element('form'),head=element('div','cdx-settings-head');form.noValidate=true;
    const title=element('h2',null,'설정');title.id='cdx-label-settings-title';
    const description=element('p','cdx-settings-subtitle','라벨 표시, 단어장·메모와 자동 판단을 한곳에서 관리합니다.');description.id='cdx-label-settings-description';
    head.append(title,description);form.append(head);
    const tabs=element('div','cdx-settings-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','설정 영역');form.append(tabs);
    const panels={},tabButtons={};
    // [codex-memo 변경] 맨 앞 '보관함' 탭: 설정을 닫고 단어장 보관함으로 간다 (작성 중이던 단어장 창이 있으면 그 창의 보관함)
    if(api.vocabularyRead){
      const library=button('보관함',null,()=>{closeSettings();if(!settings)window.dispatchEvent(new Event('codex-labels:open-vocabulary'));});
      library.id='cdx-settings-tab-library';library.setAttribute('role','tab');library.setAttribute('aria-selected','false');library.tabIndex=-1;tabs.append(library);
    }
    for(const [key,name] of [['labels','라벨'],['vocabulary','단어장·메모'],['automation','자동 판단']]){
      const tabButton=button(name,null,()=>selectTab(key));tabButton.id='cdx-settings-tab-'+key;tabButton.setAttribute('role','tab');tabButton.setAttribute('aria-controls','cdx-settings-panel-'+key);tabs.append(tabButton);tabButtons[key]=tabButton;
      const panel=element('section');panel.id='cdx-settings-panel-'+key;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tabButton.id);panel.tabIndex=0;panel.hidden=true;panels[key]=panel;form.append(panel);
    }
    panels.vocabulary.className='cdx-settings-section';panels.automation.className='cdx-settings-section';
    panels.vocabulary.append(element('h3',null,'단어장 요약'),element('p','cdx-settings-help','모델과 추론 강도는 다음 요약부터 적용됩니다. 이미 저장한 단어와 메모는 유지됩니다.'),element('div','cxm-settings-model','모델 설정을 불러오는 중…'));
    panels.automation.append(element('h3',null,'자동 판단'),element('p','cdx-settings-help','추천·분류에 필요한 확신의 기준을 설정합니다. 변경한 값은 바로 저장됩니다.'),element('div','cxm-settings-auto','자동 판단 설정을 불러오는 중…'));
    const body=element('div','cdx-settings-body'),nav=element('div','cdx-settings-nav');nav.setAttribute('aria-label','편집할 라벨');
    const editor=element('div'),fields=element('div','cdx-settings-fields');editor.append(element('p','cdx-settings-help','이름과 색상을 바꾸면 같은 라벨을 사용하는 모든 작업에 적용됩니다.'),fields);body.append(nav,editor);panels.labels.append(body);
    const state={dialog,returnFocus,tab,draft:JSON.parse(JSON.stringify(fresh.config)),savedConfig:JSON.stringify(fresh.config),existingIds:new Set(fresh.config.labels.map(label=>label.id)),revision:fresh.configRevision,selected:fresh.config.labels[0]?.id,saving:false,conflict:false};settings=state;
    const inputs={},appearanceInputs={},navItems=new Map();
    const addLabel=button('＋ 라벨 추가','cdx-settings-add',()=>{
      if(state.saving||state.draft.labels.length>=100)return;
      const id='label_'+Array.from(crypto.getRandomValues(new Uint8Array(16)),value=>value.toString(16).padStart(2,'0')).join('');
      const orders=state.draft.labels.map(label=>label.order).filter(Number.isFinite);
      state.draft.labels.push({id,kind:'category',name:'새 라벨',backgroundColor:'#7DD3FC',textColor:'#082F49',
        order:Math.min(10000,Math.max(0,...orders)+10),enabled:true,description:''});
      rebuildNav();selectLabel(id);inputs.name.focus();inputs.name.select();
    });
    const current=()=>state.draft.labels.find(label=>label.id===state.selected);
    function field(container,labelText,input,wide=false){
      const label=element('label','cdx-settings-field'+(wide?' cdx-settings-wide':''));label.append(element('span',null,labelText),input);container.append(label);return label;
    }
    function textField(key,labelText,options={}){
      const input=element(options.multiline?'textarea':'input');if(!options.multiline)input.type=options.type||'text';
      input.name=key;if(options.required)input.required=true;if(options.maxLength)input.maxLength=options.maxLength;
      if(options.type==='number'){input.step='1';input.min='-1000000';input.max='1000000';input.required=true;}
      field(fields,labelText,input,options.wide);inputs[key]=input;
      input.addEventListener('input',()=>{const label=current();label[key]=options.type==='number'?(input.value===''?NaN:Number(input.value)):input.value;if(key==='name')input.setCustomValidity(input.value.trim()?'':'라벨 이름을 입력해 주세요.');updatePreview();});
      return input;
    }
    textField('name','라벨 이름',{required:true,maxLength:30,wide:true});
    const kindInput=element('select');kindInput.name='kind';inputs.kind=kindInput;
    for(const kind of ['status','category']){const option=element('option',null,kindNames[kind]);option.value=kind;kindInput.append(option);}
    field(fields,'라벨 종류',kindInput,true);
    const kindHelp=element('div','cdx-settings-help cdx-settings-wide');fields.append(kindHelp);
    kindInput.addEventListener('change',()=>{
      if(state.existingIds.has(state.selected))return;
      current().kind=kindInput.value;rebuildNav();updatePreview();
    });
    for(const [key,labelText] of [['backgroundColor','배경색'],['textColor','글자색']]){
      const group=element('div','cdx-settings-color'),picker=element('input'),hex=element('input');picker.type='color';picker.setAttribute('aria-label',labelText+' 선택');hex.type='text';hex.name=key;hex.required=true;hex.pattern='#[0-9a-fA-F]{6}';hex.maxLength=7;hex.spellcheck=false;hex.setAttribute('aria-label',labelText+' HEX');hex.title='#7DD3FC처럼 #과 6자리 색상 코드를 입력해 주세요.';group.append(picker,hex);
      const wrapper=element('div','cdx-settings-field');wrapper.append(element('span',null,labelText),group);fields.append(wrapper);inputs[key]=hex;inputs[key+'Picker']=picker;
      picker.addEventListener('input',()=>{hex.value=picker.value.toUpperCase();current()[key]=hex.value;updatePreview();});
      hex.addEventListener('input',()=>{current()[key]=hex.value;if(/^#[0-9a-f]{6}$/i.test(hex.value))picker.value=hex.value;updatePreview();});
    }
    textField('description','설명',{multiline:true,wide:true});
    textField('order','메뉴 표시 순서',{type:'number'});
    const enabled=element('input');enabled.type='checkbox';enabled.name='enabled';inputs.enabled=enabled;
    const enabledField=element('label','cdx-settings-check');enabledField.append(enabled,document.createTextNode('라벨 사용'));fields.append(enabledField);
    enabled.addEventListener('change',()=>{current().enabled=enabled.checked;updatePreview();});
    const preview=element('div','cdx-settings-preview'),previewCaption=element('div','cdx-settings-help','미리보기'),previewRow=element('div','cdx-settings-preview-row'),previewBadge=element('span','cdx-settings-preview-badge'),previewHelp=element('p','cdx-settings-help');previewRow.append(previewBadge,document.createTextNode('프로젝트명'));preview.append(previewCaption,previewRow,previewHelp);editor.append(preview);
    const appearance=element('details'),appearanceTitle=element('summary',null,'배지 모양 · 모든 라벨에 적용'),appearanceFields=element('div','cdx-settings-fields cdx-settings-appearance');appearance.append(appearanceTitle,appearanceFields);editor.append(appearance);
    if(typeof api.checkUpdate==='function'&&typeof api.stageUpdate==='function'){
      const updates=element('section','cdx-settings-updates'),summary=element('strong',null,'Codex Labels 업데이트');
      summary.id='cdx-settings-updates-title';updates.setAttribute('aria-labelledby',summary.id);
      const versions=element('p','cdx-settings-help');versions.hidden=true;
      const codexNotice=element('div','cdx-settings-preview');codexNotice.id='cdx-codex-notice';codexNotice.hidden=true;
      const codexTitle=element('strong'),codexDetail=element('p','cdx-settings-help');codexNotice.append(codexTitle,codexDetail);
      const message=element('p','cdx-settings-help','새 버전을 직접 확인합니다. 다운로드 후 설치 시점을 선택할 수 있습니다.');message.setAttribute('role','status');
      const restartNotice=element('p','cdx-settings-help','열린 작업이 중단될 수 있습니다. 저장하지 않은 라벨 편집 내용은 사라집니다.');restartNotice.hidden=true;
      const editNotice=element('p','cdx-settings-help');editNotice.hidden=true;
      let busy=false,result=null;
      const check=button('업데이트 확인',null,()=>runUpdate(false));
      const download=button('다운로드 및 다음 실행에 적용',null,()=>runUpdate(true));download.hidden=true;
      const restart=button('설치하고 다시 실행',null,()=>restartUpdate());restart.hidden=true;
      const rollback=button('이전 버전으로 돌아가기',null,()=>restartUpdate(true));rollback.hidden=true;
      const recoveryNotice=element('p','cdx-settings-help');recoveryNotice.hidden=true;
      const hasDraft=()=>JSON.stringify(state.draft)!==state.savedConfig;
      const updateControls=()=>{
        check.disabled=busy||state.saving||state.restarting;download.disabled=check.disabled;
        download.hidden=!result?.available||!!result?.pendingRestart;
        restart.hidden=!result?.pendingRestart||typeof api.restartUpdate!=='function';
        restart.disabled=check.disabled||hasDraft()||state.conflict||!!dialog.querySelector('[data-settings-busy="true"]');
        rollback.hidden=!result?.rollbackAvailable||typeof api.rollbackUpdate!=='function';
        rollback.disabled=check.disabled||hasDraft()||state.conflict||!!dialog.querySelector('[data-settings-busy="true"]');
        restartNotice.hidden=restart.hidden&&rollback.hidden;
        editNotice.hidden=(restart.hidden&&rollback.hidden)||(!hasDraft()&&!state.conflict);
        editNotice.textContent=state.conflict?'파일 설정을 다시 불러온 뒤 설치해 주세요.':'라벨 편집 내용을 먼저 저장하거나 취소해 주세요. 저장하면 설정창을 다시 열어 설치할 수 있습니다.';
      };
      state.updateControls=updateControls;
      function showUpdateStatus(){
        recoveryNotice.textContent=result.recoveryNotice||'';recoveryNotice.hidden=!result.recoveryNotice;
        const changed=result.codex?.state==='changed';
        codexNotice.hidden=!changed;check.textContent=changed?'Labels 업데이트 확인':'업데이트 확인';
        if(changed){
          codexTitle.textContent=result.codex.newer?'새 Codex 버전 감지됨':'원본 Codex 버전 변경 감지됨';
          codexDetail.textContent=`Labels 기반: ${result.codex.baseVersion} · 설치된 원본: ${result.codex.installedVersion}. Labels를 다시 실행하면 새 Codex에 맞춰 자동으로 준비합니다. 준비에 실패하면 기존 실행본을 계속 사용합니다.`;
        }
        versions.hidden=false;
        versions.textContent=`실행 중: ${result.currentVersion?'v'+result.currentVersion:'버전 확인 불가'}`;
        if(result.downloadedVersion)versions.textContent+=` · 다운로드된 버전: v${result.downloadedVersion}`;
        if(result.latestVersion)versions.textContent+=` · 최근 확인한 공개 버전: v${result.latestVersion}`;
        message.textContent=result.pendingRestart
          ?(typeof api.restartUpdate==='function'?'다운로드 완료 · 설치 대기 중입니다. 설치하고 다시 실행하거나 나중에 진행할 수 있습니다.':'적용 준비 완료. Labels를 완전히 종료한 뒤 다시 실행해 주세요.')
          :result.available?'새 버전을 다운로드할 수 있습니다. 다운로드 후 설치 시점을 선택하세요.'
          :result.latestVersion?'최근 확인 결과, 설치할 새 정식 버전이 없습니다.':'공개 업데이트는 아직 확인하지 않았습니다. 업데이트 확인을 눌러 새 버전을 확인하세요.';
      }
      async function runUpdate(install){
        if(busy||state.saving||state.restarting)return;busy=true;updateControls();
        message.textContent=install?'다운로드하고 파일을 검증하고 있습니다…':'새 버전을 확인하고 있습니다…';
        try{
          result={...result,...await (install?api.stageUpdate():api.checkUpdate())};showUpdateStatus();
        }catch(error){message.textContent=(error?.message||String(error))+' 다시 시도해 주세요.';}
        finally{busy=false;updateControls();}
      }
      async function restartUpdate(rollingBack=false){
        if(busy||state.saving||state.restarting||hasDraft()||state.conflict||dialog.querySelector('[data-settings-busy="true"]')||(rollingBack?!result?.rollbackAvailable:!result?.pendingRestart))return;
        state.restarting=true;busy=true;
        dialog.setAttribute('aria-busy','true');
        const controls=[...form.querySelectorAll('button,input,textarea,select')];controls.forEach(control=>control.disabled=true);
        message.textContent=rollingBack?'이전 버전 복구를 준비하고 있습니다…':'설치 도구를 준비하고 있습니다…';updateControls();
        try{
          const response=await (rollingBack?api.rollbackUpdate():api.restartUpdate());
          if(!response?.restarting)throw Error('설치 도구의 시작을 확인하지 못했습니다.');
          message.textContent=rollingBack?'Labels를 종료하고 이전 버전으로 돌아갑니다. 완료되면 자동으로 다시 열립니다.':'Labels를 종료하고 업데이트를 설치합니다. 완료되면 자동으로 다시 열립니다.';
        }catch(error){
          state.restarting=false;busy=false;controls.forEach(control=>control.disabled=false);
          dialog.removeAttribute('aria-busy');dialog.dispatchEvent(new Event('codex-labels:settings-unlocked'));
          inputs.kind.disabled=state.existingIds.has(state.selected);addLabel.disabled=state.draft.labels.length>=100;state.save.disabled=state.conflict;updateControls();
          message.textContent=(error?.message||String(error))+' 다시 시도해 주세요.';
        }
      }
      async function readUpdateStatus(){
        busy=true;updateControls();message.textContent='이 PC의 업데이트 상태를 확인하고 있습니다…';
        try{
          if(typeof api.updateStatus==='function'){
            try{result=await api.updateStatus();showUpdateStatus();}catch{result=null;}
          }
          if(result?.pendingRestart)return;
          message.textContent='공개 최신 버전을 자동으로 확인하고 있습니다…';
          result={...result,...await api.checkUpdate()};showUpdateStatus();
        }
        catch(error){message.textContent='공개 최신 버전을 확인하지 못했습니다. 업데이트 확인을 눌러 다시 시도해 주세요. '+(error?.message||String(error));}
        finally{busy=false;updateControls();}
      }
      const actions=element('div','cdx-update-actions');actions.append(check,download,restart,rollback);
      updates.append(summary,versions,codexNotice,message,recoveryNotice,restartNotice,editNotice,actions);editor.append(updates);
      readUpdateStatus();
    }
    const appearanceSpecs=[['fontSizePx','글자 크기 (px)',8,32],['borderRadiusPx','둥근 모서리 (px)',0,30],['horizontalPaddingPx','좌우 여백 (px)',0,30],['verticalPaddingPx','상하 여백 (px)',0,20],['gapPx','제목과의 간격 (px)',0,40]];
    for(const [key,labelText,min,max] of appearanceSpecs){
      const input=element('input');input.type='number';input.name=key;input.required=true;input.min=String(min);input.max=String(max);input.step='1';appearanceInputs[key]=input;field(appearanceFields,labelText,input);
      input.addEventListener('input',()=>{state.draft.appearance[key]=input.value===''?NaN:Number(input.value);updatePreview();});
    }
    const status=element('div','cdx-settings-status');status.hidden=true;status.role='alert';
    const statusText=element('div'),reload=button('파일 설정 다시 불러오기',null,async()=>{
      if(state.saving)return;
      reload.disabled=true;
      try{
        const next=await readFresh();if(settings!==state)return;
        if(next.configError)throw new Error('설정 파일 오류가 남아 있습니다: '+next.configError);
        acceptSnapshot(next);state.draft=JSON.parse(JSON.stringify(next.config));state.savedConfig=JSON.stringify(next.config);state.existingIds=new Set(next.config.labels.map(label=>label.id));state.revision=next.configRevision;state.conflict=false;state.save.disabled=false;status.hidden=true;
        rebuildNav();selectLabel(state.draft.labels.some(label=>label.id===state.selected)?state.selected:state.draft.labels[0]?.id);fillAppearance();inputs.name.focus();
      }catch(e){state.message(e?.message||String(e),true);}finally{reload.disabled=false;}
    });reload.title='현재 편집 내용을 취소하고 파일에 저장된 설정을 가져옵니다.';status.append(statusText,reload);panels.labels.append(status);
    state.message=(text,canReload=false)=>{statusText.textContent=text;reload.hidden=!canReload;status.hidden=false;};
    const dismiss=element('div','cdx-settings-dismiss');dismiss.hidden=true;dismiss.setAttribute('role','alert');
    const dismissText=element('div'),dismissActions=element('div','cdx-settings-dismiss-actions');
    const keepEditing=button('계속 편집',null,()=>{dismiss.hidden=true;selectTab('labels',true);}),discard=button('편집 취소하고 닫기',null,()=>closeSettings(true));dismissActions.append(keepEditing,discard);dismiss.append(dismissText,dismissActions);form.append(dismiss);
    state.dismissMessage=(text,canDiscard=false)=>{dismissText.textContent=text;dismissActions.hidden=!canDiscard;dismiss.hidden=false;state.waitingToClose=!canDiscard;if(canDiscard)keepEditing.focus();};
    const footer=element('div','cdx-settings-footer'),fileButton=button('설정 파일 열기','cdx-settings-file',()=>api.openConfig().catch(e=>state.message(e?.message||String(e)))),cancel=button('취소',null,()=>closeSettings()),save=button('저장','cdx-settings-save'),draftNote=element('span','cdx-settings-draft-note');draftNote.setAttribute('role','status');save.type='submit';state.save=save;footer.append(fileButton,draftNote,cancel,save);form.append(footer);dialog.append(form);
    function updateFooter(){
      const isLabels=state.tab==='labels',pending=!!dialog.querySelector('[data-settings-busy="true"]');
      if(!pending&&state.waitingToClose){dismiss.hidden=true;state.waitingToClose=false;}
      fileButton.hidden=!isLabels;save.hidden=!isLabels;cancel.textContent=isLabels?'취소':'닫기';
      save.disabled=state.saving||state.restarting||state.conflict||pending;
      draftNote.hidden=isLabels;draftNote.textContent=JSON.stringify(state.draft)!==state.savedConfig?'저장하지 않은 라벨 편집 내용이 있습니다.':'';
      state.updateControls?.();
    }
    function selectTab(key,focus=false){
      state.tab=key;
      for(const name of Object.keys(panels)){const active=name===key;panels[name].hidden=!active;tabButtons[name].setAttribute('aria-selected',String(active));tabButtons[name].tabIndex=active?0:-1;}
      updateFooter();if(focus)tabButtons[key].focus();
    }
    state.selectTab=selectTab;
    tabs.addEventListener('keydown',event=>{
      const keys=Object.keys(tabButtons),index=keys.indexOf(state.tab);let next;
      if(event.key==='ArrowRight')next=keys[(index+1)%keys.length];
      else if(event.key==='ArrowLeft')next=keys[(index+keys.length-1)%keys.length];
      else if(event.key==='Home')next=keys[0];else if(event.key==='End')next=keys[keys.length-1];
      if(next){event.preventDefault();selectTab(next,true);}
    });
    dialog.addEventListener('codex-labels:settings-busy',updateFooter);
    function fillAppearance(){for(const [key] of appearanceSpecs)appearanceInputs[key].value=state.draft.appearance[key];updatePreview();}
    function rebuildNav(){
      nav.replaceChildren();navItems.clear();
      for(const kind of ['status','category']){
        nav.append(element('div','cdx-settings-group',kindNames[kind]));
        for(const label of [...state.draft.labels].filter(label=>labelKind(label)===kind).sort((a,b)=>a.order-b.order)){
          const select=button('',null,()=>selectLabel(label.id)),dot=element('span','cdx-settings-dot'),text=element('span');select.append(dot,text);select.dataset.kind=kind;select.dataset.labelId=label.id;select.setAttribute('aria-pressed','false');nav.append(select);navItems.set(label.id,{select,dot,text});
        }
      }
      addLabel.disabled=state.draft.labels.length>=100;
      addLabel.title=addLabel.disabled?'라벨은 최대 100개까지 추가할 수 있습니다.':'새 라벨을 추가합니다. 저장을 눌러 적용하세요.';
      nav.append(addLabel);
    }
    function selectLabel(id){
      state.selected=id;const label=current();fields.hidden=!label;preview.hidden=!label;if(!label)return;
      for(const key of ['name','description','order','backgroundColor','textColor'])inputs[key].value=label[key];
      inputs.kind.value=labelKind(label);inputs.kind.disabled=state.existingIds.has(label.id);
      kindHelp.textContent=inputs.kind.disabled?'저장된 라벨의 종류는 변경할 수 없습니다. 다른 종류가 필요하면 새 라벨을 추가하세요.':'진행 상태는 작업 단계, 카테고리는 대화의 주제를 나타냅니다.';
      inputs.name.setCustomValidity(label.name.trim()?'':'라벨 이름을 입력해 주세요.');inputs.enabled.checked=label.enabled;
      for(const key of ['backgroundColor','textColor'])inputs[key+'Picker'].value=/^#[0-9a-f]{6}$/i.test(label[key])?label[key]:'#000000';
      updatePreview();
    }
    function updatePreview(){
      updateFooter();
      for(const label of state.draft.labels){const item=navItems.get(label.id);if(!item)continue;item.text.textContent=(label.name||'이름 없음')+(label.enabled?'':' · 숨김');item.dot.style.backgroundColor=/^#[0-9a-f]{6}$/i.test(label.backgroundColor)?label.backgroundColor:'#6b7280';item.select.setAttribute('aria-pressed',String(label.id===state.selected));}
      const label=current();if(!label)return;const a=state.draft.appearance;
      const kind=labelKind(label);previewBadge.dataset.kind=kind;previewBadge.title=label.name;
      previewBadge.replaceChildren(element('span','cdx-label-text',label.name||'라벨'));Object.assign(previewBadge.style,compactBadgeStyle(label,kind,a));
      previewHelp.textContent=label.enabled?'상태는 세로, 카테고리는 가로로 표시합니다. 긴 이름은 마우스를 올려 확인하세요. 저장 전에는 실제 사이드바에 반영되지 않습니다.':'사용을 끄면 선택 메뉴와 배지에서 숨겨집니다. 기존 지정 정보는 유지됩니다.';
    }
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(state.tab!=='labels'||state.saving||state.restarting||state.conflict||dialog.querySelector('[data-settings-busy="true"]'))return;
      const invalid=state.draft.labels.find(label=>!label.name.trim()||label.name.length>30||!/^#[0-9a-f]{6}$/i.test(label.backgroundColor)||!/^#[0-9a-f]{6}$/i.test(label.textColor)||!Number.isFinite(label.order));
      if(invalid){selectLabel(invalid.id);form.reportValidity();return;}
      if(Object.values(appearanceInputs).some(input=>!input.validity.valid))appearance.open=true;
      if(!form.reportValidity())return;
      if(typeof api.saveConfig!=='function'){state.message('설정 저장 기능을 사용할 수 없습니다. 최신 라벨 앱으로 다시 실행해 주세요.');return;}
      state.saving=true;beginWrite();dialog.setAttribute('aria-busy','true');save.textContent='저장 중…';
      const controls=[...form.querySelectorAll('button,input,textarea,select')];controls.forEach(control=>control.disabled=true);
      try{
        const next=await api.saveConfig({labels:state.draft.labels,appearance:state.draft.appearance},state.revision);
        acceptSnapshot(next);state.savedConfig=JSON.stringify(state.draft);state.saving=false;closeSettings(true);clearError();
      }catch(e){state.message(e?.message||String(e),true);}
      finally{state.saving=false;endWrite();if(settings===state){controls.forEach(control=>control.disabled=false);inputs.kind.disabled=state.existingIds.has(state.selected);addLabel.disabled=state.draft.labels.length>=100;updateFooter();save.textContent='저장';dialog.removeAttribute('aria-busy');dialog.dispatchEvent(new Event('codex-labels:settings-unlocked'));settingsChangedExternally();}}
    });
    // Native modal focus handling is supplemented for predictable Tab/Escape behavior.
    dialog.addEventListener('cancel',event=>{event.preventDefault();closeSettings();});
    dialog.addEventListener('keydown',event=>{
      event.stopPropagation();
      if(event.key==='Escape'){event.preventDefault();closeSettings();return;}
      if(event.key==='Tab'){
        const focusable=[...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary')].filter(node=>node.tabIndex>=0&&node.getClientRects().length);
        if(!focusable.length){event.preventDefault();return;}
        const first=focusable[0],last=focusable[focusable.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
    });
    rebuildNav();selectLabel(state.selected);fillAppearance();selectTab(tab);document.body.append(dialog);dialog.showModal();if(tab==='labels')inputs.name.focus();else tabButtons[tab].focus();settingsChangedExternally();
  }
  for(const type of ['pointerdown','mousedown','click','dblclick','contextmenu'])document.addEventListener(type,e=>{
    if(!(e.target instanceof Element))return;
    const badge=e.target.closest('.cdx-label');
    if(badge){e.preventDefault();e.stopImmediatePropagation();if(type==='click')showMenu(badge);return;}
    if(menu&&!menu.contains(e.target)&&type==='pointerdown')closeMenu();
  },true);
  document.addEventListener('keydown',e=>{
    const badge=e.target instanceof Element&&e.target.closest('.cdx-label');
    if(badge&&(e.key==='Enter'||e.key===' ')){e.preventDefault();e.stopImmediatePropagation();showMenu(badge);return;}
    if(!menu)return;
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();closeMenu(true);return;}
    if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();const buttons=[...menu.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();}
  },true);
  document.addEventListener('scroll',onScroll,true);window.addEventListener('resize',()=>closeMenu());
  async function read(){
    if(disposed)return;
    readPending=true;
    // Prime the first local snapshot before a hidden startup window is shown.
    // Subsequent background refreshes still wait for visibility.
    if(reading||writing||(document.hidden&&snapshot))return;
    readPending=false;reading=true;const epoch=readEpoch;
    try{
      const next=await fetchSnapshot(snapshot?.snapshotVersion);
      if(epoch===readEpoch){acceptSnapshot(next);clearError();}else readPending=true;  // [codex-memo 변경] 다시 읽기에 성공하면 이전 알림을 닫는다
    }catch(e){if(!disposed)error(e);}
    finally{reading=false;if(readPending&&!disposed)read();}
  }
  // Discovery only inspects changed subtrees. Chat mutations never schedule a
  // repaint of existing rows; row-local observers handle identity/title changes.
  const discovery=new MutationObserver(mutations=>{
    for(const mutation of mutations){
      const target=mutation.target instanceof Element?mutation.target:mutation.target.parentElement;
      if(!target?.closest(ownSelector)&&(
        target?.closest(titleSelector)||
        mutation.type==='attributes'&&mutation.attributeName==='data-app-action-sidebar-thread-selected'||
        [...mutation.addedNodes,...mutation.removedNodes].some(node=>node instanceof Element&&
          !node.matches(ownSelector)&&(node.matches(titleSelector)||node.querySelector(titleSelector)))))schedule();
      if(mutation.type==='attributes'){
        if(mutation.target.matches(rowSelector))registerRow(mutation.target);else unregisterRow(mutation.target);
        continue;
      }
      for(const node of mutation.removedNodes)visitRows(node,unregisterRow);
      for(const node of mutation.addedNodes)visitRows(node,registerRow);
    }
  });
  function start(){
    discovery.observe(document.body,{childList:true,subtree:true,attributes:true,
      attributeFilter:['data-app-action-sidebar-thread-row','data-app-action-sidebar-project-row','data-app-action-sidebar-thread-selected'],characterData:true});
    document.querySelectorAll(rowSelector).forEach(registerRow);
    unsubscribe=api.onChanged?.(read);read();
    poll=setInterval(()=>{if(!document.hidden)read();},30000);
  }
  function stop(){
    disposed=true;headerLabels?.remove();discovery.disconnect();for(const state of rows.values())state.observer.disconnect();
    rows.clear();dirtyRows.clear();cancelAnimationFrame(frame);frame=0;clearInterval(poll);unsubscribe?.();unsubscribe=undefined;
    window.removeEventListener('focus',read);document.removeEventListener('visibilitychange',visible);document.removeEventListener('scroll',onScroll,true);
    window.removeEventListener('codex-labels:open-settings',openSettingsEvent);
  }
  function visible(){if(!document.hidden)read();}
  let unsubscribe,poll;
  const openSettingsEvent = event => {void showSettings(event.detail?.tab).catch(error);};
  window.addEventListener('codex-labels:open-settings',openSettingsEvent);
  window.addEventListener('focus',read);document.addEventListener('visibilitychange',visible);
  window.addEventListener('pagehide',stop,{once:true});
  start();
})();
