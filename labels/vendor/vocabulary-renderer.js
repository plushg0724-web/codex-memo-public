(function installVocabulary(factory) {
  'use strict';
  const inlineCore=factory();
  if(typeof window==='undefined'){module.exports=inlineCore;return;}
  let highlights=null;
  const api=window.codexLabels;
  const VERSION=7;
  if(!api?.vocabularyRead)return;
  const previous=window.__codexVocabularyRuntime;
  if(previous?.version===VERSION)return;
  if(previous){previous.replace(()=>installVocabulary(factory));return;}
  // 이전 버전은 정리 핸들을 제공하지 않는다. 열린 창과 입력은 다음 페이지 로드까지 보존한다.
  if(window.__codexVocabularyInstalled)return;
  window.__codexVocabularyInstalled=true;
  let pendingInstall=null;
  const runtime={version:VERSION,replace(install){if(dialogState)pendingInstall=install;else {dispose();install();}}};
  window.__codexVocabularyRuntime=runtime;
  const targetSelector='[data-selected-text-overlay-target]';
  const toolbarSelector='div[role="presentation"].pointer-events-auto';
  let selected=null, dialogState=null, frame=0, disposed=false, cached=null, cacheAt=0, cacheRead=null, cacheEpoch=0;
  const key=value=>(value||'').normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g,' ').trim();
  const uuid=()=>{if(crypto.randomUUID)return crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);};
  const buttons=new Set();
  const style=document.createElement('style');style.id='cdx-vocabulary-style';
  style.textContent=`
    .cdx-vocabulary-action{position:relative;white-space:nowrap;flex-shrink:0;margin-inline-start:2px;padding-inline-start:10px!important}
    .cdx-vocabulary-action::before{content:"";position:absolute;inset-block:4px;inset-inline-start:0;width:1px;background:currentColor;opacity:.34;pointer-events:none}
    #cdx-vocabulary{position:fixed;inset:0;margin:auto;--vb-bg:var(--color-surface,#fff);--vb-soft:var(--color-surface-secondary,#f5f5f5);--vb-ink:var(--color-text,#202123);--vb-muted:var(--color-text-secondary,#70747b);--vb-line:var(--color-border,#d9dce0);box-sizing:border-box;width:min(780px,calc(100vw - 32px));max-width:none;max-height:calc(100vh - 48px);padding:0;border:1px solid var(--vb-line);border-radius:18px;background:var(--vb-bg);color:var(--vb-ink);box-shadow:0 24px 90px #0005;font:13px/1.6 'Segoe UI','Malgun Gothic',sans-serif;overflow:auto}
    .dark #cdx-vocabulary{--vb-bg:var(--color-surface,#202123);--vb-soft:var(--color-surface-secondary,#292a2e);--vb-ink:var(--color-text,#f0f1f3);--vb-muted:var(--color-text-secondary,#a6a9b1);--vb-line:var(--color-border,#41434a);color-scheme:dark}
    #cdx-vocabulary::backdrop{background:#0006}#cdx-vocabulary *{box-sizing:border-box}#cdx-vocabulary [hidden]{display:none!important}
    #cdx-vocabulary h2,#cdx-vocabulary h3,#cdx-vocabulary p{margin:0}#cdx-vocabulary h2{font-weight:600;font-size:21px;letter-spacing:-.5px}#cdx-vocabulary h3{font-weight:600;font-size:18px;overflow-wrap:anywhere}
    #cdx-vocabulary .vb-head{display:flex;justify-content:space-between;gap:16px;padding:22px 24px 18px;border-bottom:1px solid var(--vb-line)}#cdx-vocabulary .vb-subtitle{font-size:12px;color:var(--vb-muted);margin-top:3px}
    #cdx-vocabulary button{border:1px solid var(--vb-line);border-radius:8px;background:transparent;color:inherit;padding:7px 11px;font:inherit;cursor:pointer;white-space:nowrap}#cdx-vocabulary button:hover{background:var(--vb-soft)}#cdx-vocabulary button:disabled{opacity:.45;cursor:default}#cdx-vocabulary button:focus-visible,#cdx-vocabulary input:focus-visible{outline:2px solid #548de8;outline-offset:2px}
    #cdx-vocabulary .vb-close{align-self:start;border:0;font-size:17px;padding:2px 9px}#cdx-vocabulary .vb-main{display:block}#cdx-vocabulary .vb-pane{padding:24px;min-width:0}
    #cdx-vocabulary .vb-head-actions,#cdx-vocabulary .vb-navigation{display:flex;align-items:center;gap:8px;flex-wrap:wrap}#cdx-vocabulary .vb-head-actions{flex-shrink:0;flex-wrap:nowrap;align-self:start}#cdx-vocabulary .vb-navigation{padding:12px 24px;border-bottom:1px solid var(--vb-line)}#cdx-vocabulary .vb-navigation button{font-size:12px}#cdx-vocabulary .vb-settings{font-size:12px;padding:5px 9px}#cdx-vocabulary .vb-tabs{display:flex;gap:6px;padding:4px 24px 0;border-bottom:1px solid var(--vb-line)}#cdx-vocabulary .vb-tabs[hidden]{display:none}#cdx-vocabulary .vb-tabs button{border-color:transparent;border-radius:7px 7px 0 0;color:var(--vb-muted);padding:9px 12px}#cdx-vocabulary .vb-tabs button[aria-selected="true"]{color:#7dd3fc;border-bottom:2px solid #7dd3fc;background:var(--vb-soft)}
    #cdx-vocabulary .vb-word{font-size:28px;font-weight:650;line-height:1.3;letter-spacing:-.6px}#cdx-vocabulary .vb-label{display:block;font-size:11px;color:var(--vb-muted);font-weight:600;margin:20px 0 5px}#cdx-vocabulary .vb-definitions ol{margin:0 0 0 20px;padding:0}#cdx-vocabulary .vb-definitions li{font-size:13px;color:var(--vb-muted);margin:2px 0;overflow-wrap:anywhere}#cdx-vocabulary .vb-definitions li.vb-def-here{color:var(--vb-ink);font-weight:600}#cdx-vocabulary .vb-definitions li.vb-def-here em{font-style:normal;font-size:11px;font-weight:600;color:#2aa5c7;margin-left:6px}#cdx-vocabulary .vb-def-none{font-size:12px;color:var(--vb-muted);margin-top:4px}#cdx-vocabulary .vb-card .vb-card-defs{font-size:12px}#cdx-vocabulary .vb-meaning{white-space:pre-wrap;overflow-wrap:anywhere;font-size:17px;font-weight:500;line-height:1.75}#cdx-vocabulary .vb-explanation{margin-top:18px;padding-top:14px;border-top:1px solid var(--vb-line);white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;color:var(--vb-muted)}#cdx-vocabulary .vb-explanation::before{content:'참고';display:block;font-size:11px;font-weight:600;margin-bottom:4px}#cdx-vocabulary .vb-example{margin-top:14px;padding:12px 14px;border-radius:9px;background:var(--vb-soft);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--vb-muted)}#cdx-vocabulary .vb-example::before{content:'예문';display:block;font-size:11px;font-weight:600;margin-bottom:4px}
    #cdx-vocabulary .vb-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:20px}#cdx-vocabulary .vb-primary{background:var(--vb-ink);color:var(--vb-bg);border-color:transparent}#cdx-vocabulary .vb-primary:hover{opacity:.85;background:var(--vb-ink)}
    #cdx-vocabulary .vb-search{width:100%;margin:12px 0;padding:9px 11px;border:1px solid var(--vb-line);border-radius:8px;background:var(--vb-bg);color:inherit;font:inherit}#cdx-vocabulary .vb-library-head{display:flex;align-items:center;justify-content:space-between;gap:8px}#cdx-vocabulary .vb-library-head h3{font-size:14px}#cdx-vocabulary .vb-refresh{font-size:11px;padding:4px 7px}
    #cdx-vocabulary .vb-list{display:flex;flex-direction:column;gap:10px;max-height:min(56vh,560px);overflow:auto}#cdx-vocabulary .vb-card{border:1px solid var(--vb-line);border-radius:10px;padding:14px}#cdx-vocabulary .vb-card-head{display:flex;align-items:start;justify-content:space-between;gap:8px}#cdx-vocabulary .vb-card strong{overflow-wrap:anywhere;font-size:16px}#cdx-vocabulary .vb-card p{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--vb-muted);font-size:13px;margin-top:7px}#cdx-vocabulary .vb-card button{padding:3px 8px;font-size:12px}#cdx-vocabulary .vb-card button[data-confirm]{color:#cc5656}
    #cdx-vocabulary .vb-empty{color:var(--vb-muted);padding:18px 0;font-size:12px}#cdx-vocabulary .vb-notice{padding:12px 24px;border-top:1px solid var(--vb-line);color:var(--vb-muted);font-size:12px;white-space:pre-wrap}#cdx-vocabulary .vb-notice[data-error]{color:#ce5e39}#cdx-vocabulary .vb-note{font-size:11px;color:var(--vb-muted);margin-top:16px}
    @media(max-width:620px){#cdx-vocabulary{width:calc(100vw - 20px);max-height:calc(100vh - 24px)}#cdx-vocabulary .vb-head{padding:18px;gap:8px}#cdx-vocabulary .vb-head-actions{gap:4px}#cdx-vocabulary .vb-pane{padding:18px}#cdx-vocabulary .vb-navigation{padding:10px 18px}#cdx-vocabulary .vb-word{font-size:25px}#cdx-vocabulary .vb-list{max-height:52vh}}
  `;
  style.textContent+=`
    #cdx-vocabulary .vb-meta{font-size:12px;color:var(--vb-muted);margin-top:8px;overflow-wrap:anywhere}
    #cdx-vocabulary .vb-context{margin-top:16px;border-top:1px solid var(--vb-line);padding-top:10px}
    #cdx-vocabulary .vb-context summary{cursor:pointer;font-size:12px}#cdx-vocabulary .vb-context p{white-space:pre-wrap;overflow-wrap:anywhere;max-height:140px;overflow:auto;font-size:12px;margin-top:8px}
    #cdx-vocabulary .vb-editor label{display:block;font-size:12px;margin-top:12px}#cdx-vocabulary .vb-editor input:not([type=checkbox]),#cdx-vocabulary textarea,#cdx-vocabulary select{display:block;width:100%;min-width:0;padding:8px;border:1px solid var(--vb-line);border-radius:8px;background:var(--vb-bg);color:inherit;font:inherit}
    #cdx-vocabulary textarea{resize:vertical}#cdx-vocabulary textarea:focus-visible,#cdx-vocabulary select:focus-visible{outline:2px solid #548de8;outline-offset:2px}
    #cdx-vocabulary .vb-filters{display:flex;gap:8px;align-items:center;margin-bottom:12px}#cdx-vocabulary .vb-filters select{width:auto;max-width:100%;flex:1}#cdx-vocabulary .vb-filters label{white-space:nowrap;font-size:12px}
    #cdx-vocabulary .vb-card-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
    #cdx-vocabulary .vb-paragraph{display:flex;align-items:flex-start;gap:9px;margin:5px 0;white-space:normal;font:inherit;color:inherit}
    #cdx-vocabulary .vb-paragraph>input{flex:0 0 auto;margin:6px 0 0;accent-color:#298ba8}
    /* [codex-memo 변경] Codex 기본 CSS가 체크박스를 appearance:none·크기 0으로 숨긴다. 단어장 창 안에서는 되돌린다. */
    #cdx-vocabulary input[type=checkbox]{appearance:auto;-webkit-appearance:checkbox;width:15px;height:15px;min-width:15px;opacity:1;position:static;cursor:pointer}
    #cdx-vocabulary .vb-paragraph>span{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
    #cdx-vocabulary .vb-preview-help{font-size:11px;color:var(--vb-muted);margin:12px 0 7px}
    #cdx-vocabulary .vb-followups,#cdx-vocabulary .vb-followup-form,#cdx-vocabulary .vb-editor-pins{margin-top:18px;padding-top:14px;border-top:1px solid var(--vb-line)}
    #cdx-vocabulary .vb-followups h4{font-size:13px;font-weight:600;line-height:1.6;margin:14px 0 5px}
    #cdx-vocabulary .vb-followup-form label{display:block;font-size:12px;margin-bottom:6px}
    #cdx-vocabulary .vb-followup-form button{margin-top:8px}
    #cdx-vocabulary .vb-presets{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px}#cdx-vocabulary .vb-presets button{margin-top:6px}
    /* [codex-memo 변경] 단어장 UI 다듬기: 문단 고정 체크는 평소엔 흐리게, 고정한 문단은 색 띠로 표시. 더 알아보기 영역은 카드로 묶는다. */
    #cdx-vocabulary .vb-paragraph{margin:1px -8px;padding:5px 8px;border-radius:8px;cursor:pointer;transition:background .12s}
    #cdx-vocabulary .vb-paragraph:hover{background:var(--vb-soft)}
    #cdx-vocabulary .vb-paragraph>input{margin:calc(.5lh - 7.5px) 0 0;opacity:.3;transition:opacity .12s}
    #cdx-vocabulary .vb-paragraph:hover>input,#cdx-vocabulary .vb-paragraph>input:checked,#cdx-vocabulary .vb-paragraph>input:focus-visible{opacity:1}
    #cdx-vocabulary .vb-paragraph:has(>input:checked){background:rgba(41,139,168,.1);box-shadow:inset 3px 0 #298ba8}
    #cdx-vocabulary .vb-example .vb-paragraph:hover{background:transparent}
    #cdx-vocabulary .vb-meaning .vb-paragraph{margin-block:2px}
    #cdx-vocabulary .vb-preview-help{display:flex;align-items:center;gap:6px;margin:8px 0 4px}
    #cdx-vocabulary .vb-preview-help b{font-weight:600;color:#298ba8}
    #cdx-vocabulary .vb-definitions li.vb-def-here em{display:inline-block;margin-left:8px;padding:0 7px;border-radius:999px;background:rgba(42,165,199,.14);line-height:18px;vertical-align:1px;white-space:nowrap}
    #cdx-vocabulary .vb-definitions li::marker{font-size:12px}
    #cdx-vocabulary .vb-followups h4{display:flex;align-items:center;gap:8px;color:var(--vb-ink)}
    #cdx-vocabulary .vb-followup-form{margin-top:20px;padding:14px 16px 16px;border:1px solid var(--vb-line);border-radius:12px;background:var(--vb-soft)}
    #cdx-vocabulary .vb-followup-form>textarea,#cdx-vocabulary .vb-followup-form>select{display:block;width:100%;box-sizing:border-box;margin-top:8px;padding:8px;background:var(--vb-bg);color:var(--vb-ink);border:1px solid var(--vb-line);border-radius:8px;font:inherit}
    #cdx-vocabulary .vb-context-record{margin-top:10px;padding:10px;border:1px solid var(--vb-line);border-radius:8px}
    #cdx-vocabulary .vb-topbar{position:sticky;top:0;z-index:3;margin:-24px -24px 20px;padding:18px 24px 12px;background:var(--vb-bg);border-bottom:1px solid var(--vb-line);box-shadow:0 5px 12px #0001}
    #cdx-vocabulary .vb-topbar .vb-actions{margin-top:12px}#cdx-vocabulary .vb-topbar .vb-context{margin-top:10px;padding-top:8px}
    #cdx-vocabulary .vb-topbar .vb-context[open]{max-height:28vh;overflow:auto}
    #cdx-vocabulary .vb-paragraph-content{display:flex;gap:8px;flex:1;min-width:0;align-items:flex-start}
    #cdx-vocabulary .vb-paragraph-content>input{flex-shrink:0;margin:calc(.5lh - 7.5px) 0 0;accent-color:#298ba8}
    #cdx-vocabulary .vb-paragraph-tools{display:flex;gap:3px;flex-shrink:0;padding-top:2px}
    #cdx-vocabulary .vb-paragraph-tools button{font-size:11px;padding:2px 5px;border-radius:5px;color:var(--vb-muted)}
    #cdx-vocabulary .vb-paragraph-tools button:hover{color:var(--vb-ink)}#cdx-vocabulary .vb-paragraph:has(.vb-paragraph-content>input:checked){background:rgba(41,139,168,.1)}
    @media(max-width:560px){#cdx-vocabulary .vb-topbar{margin:-14px -14px 16px;padding:12px 14px 10px}#cdx-vocabulary .vb-paragraph{flex-wrap:wrap}#cdx-vocabulary .vb-paragraph-content{flex-basis:calc(100% - 90px)}}
    #cdx-vocabulary .vb-followup-form .vb-label{margin-top:0}
    #cdx-vocabulary .vb-presets{gap:6px;margin:2px 0 12px}
    #cdx-vocabulary .vb-presets button{margin-top:0;border-radius:999px;padding:6px 13px;background:var(--vb-bg);font-size:13px}
    #cdx-vocabulary .vb-presets button:hover:not(:disabled){border-color:#298ba8;color:#298ba8;background:var(--vb-bg)}
    #cdx-vocabulary .vb-presets button[data-busy]{opacity:1;border-color:#298ba8;color:#298ba8;animation:vb-pulse 1.2s ease-in-out infinite}
    @keyframes vb-pulse{50%{background:rgba(41,139,168,.12)}}
    #cdx-vocabulary .vb-ask{display:flex;gap:8px;align-items:flex-end}
    #cdx-vocabulary .vb-ask textarea{flex:1;min-height:40px;background:var(--vb-bg)}
    #cdx-vocabulary .vb-followup-form .vb-ask button{margin-top:0;flex-shrink:0}
    #cdx-vocabulary .vb-followup-form label.vb-ask-label{font-size:12px;color:var(--vb-muted);margin-bottom:6px}
    #cdx-vocabulary .vb-primary:disabled{background:transparent;color:var(--vb-muted);border-color:var(--vb-line);opacity:1}
    #cdx-vocabulary .vb-notice:empty{display:none}
    #cdx-vocabulary .vb-draft-banner{margin:14px 0;padding:9px 12px;border-radius:8px;background:var(--vb-soft);font-size:12px}
  `;
  document.head.append(style);
  // [codex-memo 변경] 메모 통합용 연결 지점. 정의되지 않으면 원본과 같은 동작.
  const hook=(name,...args)=>{try{return window.__cxmVocabHooks?.[name]?.(...args);}catch(e){console.warn('[codex-memo]',e);}};
  function el(tag,cls,value){const n=document.createElement(tag);if(cls)n.className=cls;if(value!==undefined)n.textContent=value;return n;}
  function button(label,cls,action){const n=el('button',cls,label);n.type='button';n.addEventListener('click',action);return n;}
  function capture(){
    const s=window.getSelection();if(!s||s.isCollapsed||s.rangeCount!==1)return null;
    const range=s.getRangeAt(0), parent=range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement;
    const target=parent?.closest(targetSelector);
    if(!target||parent.closest('input,textarea,[contenteditable="true"],#cdx-vocabulary'))return null;
    const term=s.toString().trim();if(!term||term.length>160)return null;
    const block=parent.closest('p,li,pre,td,blockquote')||parent;
    const content=block.textContent||'', prefix=range.cloneRange();
    // Locate the actual occurrence, not the first matching word in a paragraph.
    prefix.selectNodeContents(block);prefix.setEnd(range.startContainer,range.startOffset);
    const selectedText=range.toString();
    const offset=prefix.toString().length+selectedText.length-selectedText.trimStart().length;
    const start=Math.max(0,offset-450);
    const localPath=location.pathname;
    return {term,context:content.slice(start,start+1600).trim(),source:{title:document.title.slice(0,200),
      path:localPath.length<=300&&/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(localPath)?localPath:''}};
  }
  function addToolbar(toolbar){
    if(!selected||dialogState||!toolbar.matches(toolbarSelector)||toolbar.querySelector('.cdx-vocabulary-action'))return;
    const native=[...toolbar.querySelectorAll('button')].find(b=>['채팅에 추가','Add to chat'].includes(b.textContent.trim()));
    if(!native||!toolbar.getClientRects().length)return;
    const b=button('단어장',native.className+' cdx-vocabulary-action',()=>{});
    b.title='선택한 단어의 뜻을 요약하고 저장';buttons.add(b);native.insertAdjacentElement('afterend',b);markButtons();
  }
  function scan(node){
    if(!(node instanceof Element)||node.closest('#cdx-vocabulary'))return;
    if(node.matches(toolbarSelector))addToolbar(node);
    const parent=node.closest(toolbarSelector);if(parent)addToolbar(parent);
    node.querySelectorAll(toolbarSelector).forEach(addToolbar);
  }
  function markButtons(){
    const exists=selected&&cached?.entries.some(e=>key(e.term)===key(selected.term));
    for(const b of buttons){const label=hook('buttonLabel',exists)||(exists?'✓ 단어장':'단어장');if(b.textContent!==label)b.textContent=label;b.title=exists?'저장된 뜻 보기 · 새 의미 추가':'선택한 단어의 뜻을 요약하고 저장';}
  }
  function remember(snapshot){cacheEpoch++;cached=snapshot;cacheAt=Date.now();markButtons();highlights?.setSnapshot(snapshot);}
  function checkSaved(){
    markButtons();if(cacheRead||Date.now()-cacheAt<3000)return;
    const epoch=cacheEpoch;
    cacheRead=api.vocabularyRead().then(data=>{if(!disposed&&epoch===cacheEpoch)remember(data);}).catch(()=>{if(epoch===cacheEpoch){cached=null;markButtons();}}).finally(()=>{cacheRead=null;});
  }
  function updateSelection(){
    frame=0;if(disposed||dialogState)return;
    selected=capture();
    for(const b of buttons)if(!selected||!b.isConnected){b.remove();buttons.delete(b);}
    if(selected){document.querySelectorAll(toolbarSelector).forEach(addToolbar);checkSaved();}
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(updateSelection);}
  const observer=new MutationObserver(records=>{
    if(!selected||dialogState)return;
    for(const m of records)for(const node of m.addedNodes)scan(node);
  });
  observer.observe(document.body,{childList:true,subtree:true});
  function toolbarEvent(e){
    if(!(e.target instanceof Element)||!e.target.closest('.cdx-vocabulary-action'))return;
    e.preventDefault();e.stopImmediatePropagation();
    if(e.type==='click'){const input=capture()||selected;if(input)open(input);}
  }
  for(const name of ['pointerdown','mousedown','click'])document.addEventListener(name,toolbarEvent,true);
  document.addEventListener('selectionchange',schedule);
  const revisionDraft=s=>!!s.draft?.targetId;
  const editorStates=s=>[s,s.composeState,s.wordState].filter(Boolean);
  const unsavedEditor=state=>!!(state?.dirty||state?.draft||state?.contextDirty);
  const pendingRevision=s=>editorStates(s).some(revisionDraft);
  const unsavedEditors=s=>editorStates(s).some(unsavedEditor);
  const parkedChanges=s=>[s.composeState,s.wordState].some(unsavedEditor);
  function discard(state,editsOnly=false){return !(editsOnly?state?.dirty:unsavedEditor(state))||window.confirm('저장하지 않은 내용을 버릴까요?');}
  function otherEditorReady(s){
    if(!parkedChanges(s))return true;
    message(s,'다른 화면에 저장하지 않은 내용이 있습니다.',true);return false;
  }
  function close(){
    if(dialogState?.contextLoading){message(dialogState,'맥락분석을 받는 중입니다. 잠시 기다려 주세요.');return;}
    const s=dialogState;if(!s||s.writing)return;
    if((unsavedEditors(s)||hook('hasUnsaved',s))&&!window.confirm('저장하지 않은 수정 내용을 버리고 닫을까요?'))return;
    dialogState=null;hook('closed',s);api.vocabularyCancel().catch(()=>{});s.dialog.close();s.dialog.remove();
    if(s.opener?.isConnected)s.opener.focus({preventScroll:true});selected=null;
    if(pendingInstall){const install=pendingInstall;pendingInstall=null;dispose();queueMicrotask(install);}
  }
  function message(s,value,isError=false){if(dialogState!==s)return;s.notice.textContent=value;s.notice.toggleAttribute('data-error',isError);}
  function controls(s){
    const locked=s.busy||s.writing||s.refreshing||s.contextLoading,parked=parkedChanges(s);
    s.save.disabled=locked||!(s.draft||s.saved&&(s.editing||s.paragraphEdits))||(pendingRevision(s)&&!revisionDraft(s));
    s.save.textContent=s.paragraphEdits?'변경 저장':revisionDraft(s)?(s.draft.action==='followup'?'답변 저장':'저장'):s.saved?(s.editing?'저장':'저장됨'):(hook('saveLabel',s)||'단어장에 저장');
    s.edit.disabled=locked||!!s.contextDirty||!(s.draft||s.saved);s.edit.textContent=s.editing?'편집 취소':'편집';
    s.retry.disabled=locked||parked;s.retry.hidden=!!s.saved||!s.input;
    s.add.hidden=!s.saved;s.add.disabled=locked||parked||unsavedEditor(s);
    s.cancel.hidden=!s.busy;s.refresh.disabled=locked;
    s.cancel.disabled=!!s.cancelling;
    s.reanalyze.hidden=!s.saved;s.reanalyze.disabled=locked||unsavedEditors(s)||s.editing;
    s.discardDraft.hidden=!s.draft&&!s.paragraphEdits;s.discardDraft.disabled=locked;
    s.discardDraft.textContent=revisionDraft(s)?'되돌리기':'버리기';
    s.draftBanner.hidden=!revisionDraft(s);
    s.followupForm.hidden=!s.saved;s.question.disabled=locked||unsavedEditors(s)||s.editing;
    s.followupSubmit.disabled=s.question.disabled||!s.question.value.trim();
    for(const preset of s.presets.querySelectorAll('button'))preset.disabled=s.question.disabled;
    const requestHint=parked?'다른 화면의 작성 내용을 먼저 저장하거나 버리세요.':'';
    for(const action of [s.retry,s.add,s.reanalyze,s.followupSubmit,...s.presets.querySelectorAll('button')])action.title=requestHint;
    for(const field of Object.values(s.fields))field.disabled=locked;
    for(const field of s.summary.querySelectorAll('[data-preview-paragraph]'))field.disabled=locked;
    for(const action of s.summary.querySelectorAll('[data-paragraph-action]'))action.disabled=locked||s.editing||!!s.contextDirty;
    for(const field of s.summary.querySelectorAll('[data-analysis-visible]'))field.disabled=locked||!!s.contextDirty||!!s.paragraphEdits;
    s.contextForm.hidden=!s.saved||s.editing||!!s.draft;
    const contextLocked=locked||parked||s.editing||!!s.draft||!!s.paragraphEdits;
    s.contextSentence.disabled=contextLocked;s.contextAnswer.disabled=contextLocked;s.contextSense.disabled=contextLocked;
    s.contextAnalyze.disabled=contextLocked||!s.contextSentence.value.trim()||!s.contextSense.value;
    s.contextSave.disabled=contextLocked||!s.contextSentence.value.trim()||!s.contextAnswer.value.trim()||!s.contextSense.value;
    s.contextDiscard.disabled=locked;
    for(const button of s.list.querySelectorAll('button'))button.disabled=locked;
    s.composeButton.disabled=locked&&s.editorKind!=='compose';
    s.archiveButton.disabled=locked;
  }
  // Keep the actual editor nodes, including selection and hook-owned memo input,
  // while the archive or another detail is visible. Switching views never saves.
  const editorKeys=['input','draft','saved','editing','dirty','newSense','editRevision','previewParagraphs','fields','title','preview','meta','meaning','definitions','explanation','example','followups','editor','editorPins','contextBox','context','source','save','edit','retry','add','cancel','reanalyze','discardDraft','draftBanner','followupForm','question','followupSubmit','presets','contextForm','contextSentence','contextAnswer','contextSense','contextAnalyze','contextSave','contextDiscard','contextDirty','contextLoading','contextMode','contexts','pos','paragraphEdits','previewItem'];
  function parkEditor(s){
    const state={nodes:[...s.summary.childNodes],notice:s.notice.textContent,noticeError:s.notice.hasAttribute('data-error')};for(const name of editorKeys)state[name]=s[name];
    s[s.editorKind==='compose'?'composeState':'wordState']=state;
  }
  function switchEditor(s,kind){
    if(s.editorKind===kind)return true;
    if(s.busy||s.writing||s.refreshing||s.contextLoading)return false;
    parkEditor(s);const state=s[kind==='compose'?'composeState':'wordState'];
    s.editorKind=kind;
    if(state){for(const name of editorKeys)s[name]=state[name];s.summary.replaceChildren(...state.nodes);message(s,state.notice,state.noticeError);s[kind==='compose'?'composeState':'wordState']=null;}
    else {s.summary.replaceChildren();s.fields={};s.draft=null;s.saved=null;s.editing=false;s.dirty=false;s.newSense=false;buildSummary(s,null);}
    return true;
  }
  function setView(s,mode){
    s.mode=mode;s.dialog.dataset.view=mode;
    s.summary.hidden=mode==='archive';s.library.hidden=mode!=='archive';
    s.archiveButton.hidden=mode==='archive';s.archiveButton.textContent=mode==='detail'?'← 보관함으로':'보관함';
    s.composeButton.hidden=!s.hasCompose||mode==='compose';
    s.archiveButton.parentElement.hidden=s.archiveButton.hidden&&s.composeButton.hidden;
    // [codex-memo 변경] 보관함은 설정과 한 창처럼 탭으로 오간다. 보관함에서는 탭 줄이 설정 버튼을 대신한다.
    s.tabs.hidden=mode!=='archive';s.settings.hidden=mode==='archive';
    s.heading.textContent=mode==='archive'?'보관함':s.contextMode?'맥락분석':mode==='detail'?'저장한 단어':'단어장 · 메모';
    s.subtitle.textContent='';s.subtitle.hidden=true;
    hook('viewChanged',s,mode);controls(s);
    if(s.dialog.open)(mode==='archive'?s.search:s.title).focus({preventScroll:true});
  }
  function showArchive(s,kind){if(s.busy||s.writing||s.refreshing||s.contextLoading)return;setView(s,'archive');if(kind)hook('libraryKind',s,kind);}
  function showCompose(s){if(!s.hasCompose||!switchEditor(s,'compose'))return;setView(s,'compose');}
  function openStored(s,item){
    if(s.busy||s.writing||s.refreshing)return;
    const editor=s.editorKind==='word'?s:s.wordState;
    if(editor?.saved?.id!==item.id&&!discard(editor))return;
    if(!switchEditor(s,'word'))return;
    if(s.saved?.id!==item.id)showItem(s,item);
    setView(s,'detail');message(s,revisionDraft(s)?'아직 저장하지 않은 결과입니다.':'');
  }
  function fill(s,item){
    for(const name of ['meaning','example','partOfSpeech','explanation'])s.fields[name].value=item[name]||'';
    s.fields.tags.value=(item.tags||[]).join(', ');s.fields.favorite.checked=!!item.favorite;s.fields.status.value=item.status||'new';
  }
  function collect(s){return {meaning:s.fields.meaning.value,example:s.fields.example.value,partOfSpeech:s.fields.partOfSpeech.value,
    explanation:s.fields.explanation.value,tags:s.fields.tags.value.split(',').map(t=>t.trim()).filter(Boolean),
    favorite:s.fields.favorite.checked,status:s.fields.status.value};}
  const paragraphs=item=>window.CodexVocabContent.paragraphs(item);
  const selections=item=>window.CodexVocabContent.normalizeSelections(item);
  function syncParagraphChecks(s){
    const selected=new Set(s.previewParagraphs||[]);
    for(const check of s.summary.querySelectorAll('[data-preview-paragraph]'))check.checked=selected.has(check.dataset.previewParagraph);
    drawPinHelp(s);
  }
  // [codex-memo 변경] 고정한 문단 수를 보여준다.
  function drawPinHelp(s){
    if(!s.pinHelp)return;const n=(s.previewParagraphs||[]).length;
    s.pinHelp.replaceChildren(n?el('b','','미리보기 고정 '+n+'개'):document.createTextNode('맥락분석 체크는 미리보기 표시, 나머지 체크는 상단 고정'));
  }
  async function selectParagraph(s,text,checked){
    if(s.busy||s.writing||s.refreshing){syncParagraphChecks(s);return;}
    if(pendingRevision(s)&&!s.draft&&!s.editing){syncParagraphChecks(s);message(s,'저장 전 분석 결과를 먼저 저장하거나 원본으로 되돌리세요.',true);return;}
    const selected=new Set(s.previewParagraphs||[]);if(checked)selected.add(text);else selected.delete(text);
    const previewParagraphs=[...selected];
    if(s.draft||s.editing){s.previewParagraphs=previewParagraphs;s.dirty=true;syncParagraphChecks(s);return;}
    if(!s.saved)return;
    const id=s.saved.id,revision=s.editRevision;
    await mutate(s,()=>api.vocabularyEdit(id,{previewParagraphs},revision),()=>{
      const item=s.snapshot.entries.find(entry=>entry.id===id);
      if(item&&s.saved?.id===id){s.saved=item;s.editRevision=s.snapshot.revision;s.previewParagraphs=selections(item);}
      message(s,'미리보기 고정을 바꿨습니다.');
    });
    if(dialogState===s)syncParagraphChecks(s);
  }
  function paragraphRow(s,paragraph){
    const row=el('div','vb-paragraph'),label=el('label','vb-paragraph-content'),check=el('input');check.type='checkbox';
    const finish=()=>{label.append(check,el('span','vb-paragraph-text',paragraph.text));row.append(label,paragraphActions(s,paragraph));return row;};
    if(paragraph.kind==='meaning'){
      check.dataset.analysisVisible='base';check.checked=(s.draft||s.saved)?.showContextAnalysis!==false;
      check.title='미리보기 표시';check.setAttribute('aria-label','맥락분석 미리보기 표시: '+paragraph.text);
      check.addEventListener('change',()=>setAnalysisVisibility(s,{showContextAnalysis:check.checked}));
      return finish();
    }
    check.dataset.previewParagraph=paragraph.text;check.checked=(s.previewParagraphs||[]).includes(paragraph.text);
    check.title='미리보기에 고정';check.setAttribute('aria-label','미리보기에 고정: '+paragraph.text);
    check.addEventListener('change',()=>selectParagraph(s,paragraph.text,check.checked));
    return finish();
  }
  function paragraphActions(s,paragraph){
    const tools=el('span','vb-paragraph-tools');
    for(const [name,action] of [['재분석',()=>reanalyzeParagraph(s,paragraph)],['삭제',()=>deleteParagraph(s,paragraph)]]){
      const b=button(name,'',action);b.dataset.paragraphAction=name;b.setAttribute('aria-label',paragraph.label+' '+name+': '+paragraph.text);tools.append(b);
    }
    return tools;
  }
  function displayItem(s){return s.draft||s.previewItem||s.saved;}
  function deleteParagraph(s,paragraph){
    if(s.busy||s.writing||s.editing||s.contextLoading||s.contextDirty)return;
    const item=displayItem(s),patch=window.CodexVocabContent.replaceParagraph(item,paragraph,'');
    s.paragraphEdits={...s.paragraphEdits,...patch};
    if(s.draft)s.draft={...s.draft,...patch};else s.previewItem={...item,...patch};
    s.dirty=true;detail(s,displayItem(s));message(s,'문단을 삭제했습니다. 저장하면 반영됩니다. 원본으로 되돌릴 수 있습니다.');
  }
  async function reanalyzeParagraph(s,paragraph){
    if(s.busy||s.writing||s.editing||s.contextLoading||s.contextDirty||!s.saved||unsavedEditors(s)){message(s,'작성 중인 내용을 먼저 저장하거나 버린 뒤 문단을 재분석하세요.',true);return;}
    if(!api.vocabularyParagraph){message(s,'도우미 연결을 새로 고친 뒤 다시 시도하세요.',true);return;}
    const original=s.saved,revision=s.editRevision,operation=s.operation=(s.operation||0)+1;s.busy=true;s.cancelled=false;controls(s);
    message(s,paragraph.label+' 문단을 재분석하는 중…');
    try{
      const draft=await api.vocabularyParagraph(original.id,{kind:paragraph.kind,text:paragraph.text,...(paragraph.recordId?{recordId:paragraph.recordId}:{})},revision);
      if(dialogState!==s||s.cancelled||s.operation!==operation)return;
      if(draft.targetId!==original.id)throw Error('재분석 대상이 맞지 않습니다.');
      s.paragraphEdits={};s.draft=draft;s.dirty=false;s.previewItem=null;detail(s,s.draft);message(s,'이 문단만 재분석했습니다. 확인한 뒤 저장하세요.');
    }catch(error){if(dialogState===s&&!s.cancelled&&s.operation===operation){await api.vocabularyCancel().catch(()=>{});message(s,error.message||'문단을 재분석하지 못했습니다. 원본은 유지됩니다.',true);}}
    finally{if(dialogState===s&&s.operation===operation){s.busy=false;controls(s);}}
  }
  function drawParagraphs(s,box,items){box.replaceChildren(...items.map(item=>paragraphRow(s,item)));}
  async function setAnalysisVisibility(s,patch){
    if(s.busy||s.writing||s.refreshing||s.contextLoading||s.contextDirty)return;
    if(s.draft||s.editing){if(s.draft)s.draft={...s.draft,...patch};else s.saved={...s.saved,...patch};s.dirty=true;
      for(const check of s.summary.querySelectorAll('[data-analysis-visible="base"]'))check.checked=(s.draft||s.saved).showContextAnalysis!==false;
      controls(s);return;}
    if(!s.saved||pendingRevision(s))return;
    const id=s.saved.id;
    await mutate(s,()=>api.vocabularyEdit(id,patch,s.editRevision),()=>showItem(s,s.snapshot.entries.find(e=>e.id===id)));
    if(dialogState===s&&s.saved)detail(s,s.saved);
  }
  function drawContexts(s,item){
    s.contexts.replaceChildren();s.contexts.hidden=!(item.contextAnalyses||[]).length;
    if(s.contexts.hidden)return;
    s.contexts.append(el('span','vb-label','다른 문장의 맥락분석'));
    for(const context of item.contextAnalyses){
      const block=el('section','vb-context-record'),row=el('label','vb-paragraph'),check=el('input');check.type='checkbox';
      check.dataset.analysisVisible=context.id;check.checked=context.visible;check.setAttribute('aria-label','다른 문장 맥락분석 미리보기 표시: '+context.context);
      check.addEventListener('change',()=>setAnalysisVisibility(s,{contextAnalyses:(s.draft||s.saved).contextAnalyses.map(c=>c.id===context.id?{...c,visible:check.checked}:c)}));
      row.append(check,el('span','',context.analysis));block.append(el('p','vb-meta',context.context),row,paragraphActions(s,{text:context.analysis,label:'다른 문장 맥락분석',kind:'context',recordId:context.id}));s.contexts.append(block);
    }
  }
  async function analyzeContext(s){
    if(s.contextAnalyze.disabled)return;
    const sentence=s.contextSentence.value.trim(),id=s.contextSense.value;s.contextLoading=true;controls(s);message(s,'맥락분석을 받는 중…');
    try{const answer=await api.vocabularyUsage({term:s.saved.term,context:sentence},id);
      if(dialogState!==s)return;
      if(!answer?.trim())throw Error('맥락분석을 받지 못했습니다. 직접 입력하거나 다시 시도하세요.');
      s.contextAnswer.value=answer;s.contextDirty=true;message(s,'맥락분석을 확인한 뒤 저장하세요.');
    }catch(error){message(s,error.message,true);}finally{s.contextLoading=false;if(dialogState===s)controls(s);}
  }
  async function saveContext(s){
    if(s.contextSave.disabled)return;
    const id=s.contextSense.value,item=s.snapshot.entries.find(e=>e.id===id);
    if(!item)return;
    const context=s.contextSentence.value.trim(),analysis=s.contextAnswer.value.trim();
    if(item.context===context&&item.meaning===analysis||(item.contextAnalyses||[]).some(c=>c.context===context&&c.analysis===analysis)){message(s,'이미 저장한 맥락분석입니다.',true);return;}
    const record={id:uuid(),context,analysis,source:context===s.selectionInput?.context?s.selectionInput.source||{}:{},createdAt:Date.now(),visible:true};
    await mutate(s,()=>api.vocabularyEdit(id,{contextAnalyses:[...(item.contextAnalyses||[]),record]},s.snapshot.revision),()=>{
      s.contextDirty=false;s.contextSentence.value='';s.contextAnswer.value='';showItem(s,s.snapshot.entries.find(e=>e.id===id));message(s,'새 문장의 맥락분석을 저장했습니다.');
    });
  }
  function drawEditorPins(s){
    if(!s.editing)return;
    const item={...(s.draft||s.saved),...collect(s),previewParagraphs:s.previewParagraphs};
    s.previewParagraphs=selections(item);
    s.editorPins.replaceChildren(el('p','vb-preview-help','미리보기에 고정할 문단'));
    for(const paragraph of paragraphs(item))s.editorPins.append(paragraphRow(s,paragraph));
  }
  // [codex-memo 변경] 사전적 의미 목록. 지금 문맥에 해당하는 뜻을 강조하고, 해당하는 뜻이 없으면 '사전에 없는 쓰임'.
  function drawDefinitions(s,box,item){
    const defs=Array.isArray(item.definitions)?item.definitions:[];box.replaceChildren();box.hidden=!defs.length;if(!defs.length)return;
    const list=el('ol');defs.forEach((d,i)=>{const li=el('li',i===item.definitionIndex?'vb-def-here':'');const row=paragraphRow(s,{text:d.trim(),label:'사전적 의미',kind:'definition'});if(i===item.definitionIndex)row.querySelector('.vb-paragraph-text').append(el('em','','이 문맥'));li.append(row);list.append(li);});
    box.append(el('span','vb-label','사전 뜻'),list);
    if(item.definitionIndex===-1)box.append(el('p','vb-def-none','사전에 없는 쓰임'));
  }
  const circled=i=>'①②③④'[i]||String(i+1);
  const shortDefinitions=item=>(item.definitions||[]).map((d,i)=>circled(i)+' '+d).join('  ');
  function detail(s,item){
    s.title.textContent=item.term;s.previewParagraphs=selections(item);drawPinHelp(s);
    const parts=paragraphs(item);
    drawParagraphs(s,s.meaning,parts.filter(p=>p.kind==='meaning'));
    drawContexts(s,item);
    s.meta.textContent=(item.tags||[]).join(' · ');s.pos.replaceChildren(el('span','vb-label','품사'),...parts.filter(p=>p.kind==='partOfSpeech').map(p=>paragraphRow(s,p)));s.pos.hidden=!item.partOfSpeech;
    drawParagraphs(s,s.explanation,parts.filter(p=>p.kind==='explanation'));s.explanation.hidden=!item.explanation;
    drawDefinitions(s,s.definitions,item);
    drawParagraphs(s,s.example,parts.filter(p=>p.kind==='example'));s.example.hidden=!item.example;
    s.followups.replaceChildren();s.followups.hidden=!(item.followups||[]).length;
    if(!s.followups.hidden){
      s.followups.append(el('span','vb-label','추가 설명'));
      let question=null;
      for(const paragraph of parts.filter(p=>p.kind==='followup')){
        if(paragraph.label!==question){question=paragraph.label;s.followups.append(el('h4','',question));}
        s.followups.append(paragraphRow(s,paragraph));
      }
    }
    // [codex-memo 변경] 이미 받은 기본 설명(첫 요약에 함께 옴)은 버튼을 숨긴다.
    if(s.presets){const asked=new Set((item.followups||[]).map(f=>f.question));let shown=0;
      for(const b of s.presets.querySelectorAll('button[data-question]')){b.hidden=asked.has(b.dataset.question);if(!b.hidden)shown++;}
      s.presets.hidden=!shown;}
    s.context.textContent=item.context||'저장된 원문 문맥이 없습니다.';
    s.source.textContent=[item.source?.title,item.source?.path].filter(Boolean).join(' · ');
    s.contextBox.hidden=false;s.editor.hidden=!s.editing;s.preview.hidden=s.editing;
    fill(s,item);drawEditorPins(s);controls(s);
  }
  function showItem(s,item){
    s.paragraphEdits=null;s.previewItem=null;
    hook('usage',s,'',null);s.newSense=false;
    if(s.saved?.id!==item.id&&s.question)s.question.value='';
    if(s.saved?.id!==item.id){s.contextSentence.value='';s.contextAnswer.value='';s.contextDirty=false;}
    s.saved=item;s.draft=null;s.editing=false;s.dirty=false;s.editRevision=s.snapshot.revision;
    s.contextSense.replaceChildren();for(const entry of s.snapshot.entries.filter(e=>key(e.term)===key(item.term))){const option=el('option','',entry.meaning);option.value=entry.id;s.contextSense.append(option);}s.contextSense.value=item.id;
    s.input=s.selectionInput&&key(s.selectionInput.term)===key(item.term)?s.selectionInput:{term:item.term,context:item.context||'',source:item.source};
    detail(s,item);
  }
  async function mutate(s,action,onSuccess){
    if(s.busy||s.writing||s.refreshing)return;
    s.writing=true;controls(s);
    try{const snapshot=await action();if(dialogState!==s)return false;s.snapshot=snapshot;remember(snapshot);drawList(s);onSuccess?.();return true;}
    catch(e){message(s,e.message||'단어장 변경에 실패했습니다.',true);return false;}
    finally{if(dialogState===s){s.writing=false;controls(s);}}
  }
  function libraryRows(s){
    const entries=s.snapshot?.entries||[];
    if(s.listEntries!==entries){
      s.listEntries=entries;
      s.listRows=entries.map(item=>({item,
        search:key([item.term,item.meaning,item.explanation,item.context,...(item.tags||[]),...(item.definitions||[]),...(item.followups||[]).flatMap(f=>[f.question,f.answer]),...(item.contextAnalyses||[]).flatMap(c=>[c.context,c.analysis])].join(' ')),
        definitions:shortDefinitions(item),
        metadata:[item.partOfSpeech,...(item.tags||[]),({new:'미학습',review:'복습 필요',known:'숙지함'})[item.status||'new']].filter(Boolean).join(' · ')
      }));
    }
    return s.listRows;
  }
  function drawList(s){
    const q=key(s.search.value);s.list.replaceChildren();
    const items=libraryRows(s).filter(({item,search})=>search.includes(q)&&(!s.favorites.checked||item.favorite)&&(!s.statusFilter.value||(item.status||'new')===s.statusFilter.value));
    s.count.textContent='저장한 뜻 '+(s.snapshot?.entries.length??0);
    if(!items.length){s.list.append(el('p','vb-empty',q||s.favorites.checked||s.statusFilter.value?'일치하는 단어가 없습니다.':'저장한 단어가 여기에 표시됩니다.'));hook('drawList',s,q);return;}
    for(const {item,definitions,metadata} of items){
      const card=el('article','vb-card'),head=el('div','vb-card-head'),actions=el('div','vb-card-actions');
      head.append(el('strong','',item.term));card.append(head,el('p','',item.meaning));if(definitions)card.append(el('p','vb-card-defs','사전: '+definitions));
      if(item.example)card.append(el('p','',item.example));
      card.append(el('p','',metadata));
      const view=button('열기','',()=>openStored(s,item));
      view.setAttribute('aria-label',item.term+' 뜻 열기');
      const favorite=button(item.favorite?'★':'☆','',()=>{
        if(unsavedEditors(s)){message(s,'작성 중인 내용을 저장하거나 버린 뒤 즐겨찾기를 변경하세요.',true);return;}
        mutate(s,()=>api.vocabularyEdit(item.id,{favorite:!item.favorite},s.snapshot.revision),()=>{
          if(s.saved?.id===item.id)showItem(s,s.snapshot.entries.find(e=>e.id===item.id));message(s,'즐겨찾기를 변경했습니다.');
        });
      });favorite.setAttribute('aria-label',item.term+' 즐겨찾기');favorite.setAttribute('aria-pressed',String(!!item.favorite));
      const del=button('삭제','',()=>{
        if(s.busy||s.writing||s.refreshing)return;
        if(unsavedEditors(s)){message(s,'작성 중인 내용을 저장하거나 버린 뒤 삭제하세요.',true);return;}
        if(!del.hasAttribute('data-confirm')){del.setAttribute('data-confirm','');del.textContent='삭제 확인';return;}
        mutate(s,()=>api.vocabularyDelete(item.id,s.snapshot.revision),()=>{
          if(s.saved?.id===item.id){s.saved=null;s.draft=null;s.dirty=false;s.editing=false;s.editor.hidden=true;s.preview.hidden=false;
            s.meaning.textContent='삭제된 항목입니다.';s.contextBox.hidden=true;s.example.hidden=true;s.explanation.hidden=true;s.definitions.hidden=true;s.followups.hidden=true;s.meta.textContent='';}
          message(s,'“'+item.term+'”을 삭제했습니다.');
        });
      });del.setAttribute('aria-label',item.term+' 삭제');actions.append(view,favorite,del);card.append(actions);s.list.append(card);
    }
    hook('drawList',s,q);
    controls(s);
  }
  async function refresh(s){
    if(s.busy||s.writing||s.refreshing)return false;
    if(unsavedEditors(s)){message(s,'작성 중인 내용을 저장하거나 버린 뒤 새로고침하세요.',true);return false;}
    s.refreshing=true;controls(s);
    try{const data=await api.vocabularyRead();if(dialogState!==s)return false;s.snapshot=data;remember(data);drawList(s);
      if(s.saved){const current=data.entries.find(e=>e.id===s.saved.id);if(current)showItem(s,current);else {s.saved=null;s.editing=false;s.editor.hidden=true;s.preview.hidden=false;s.definitions.hidden=true;s.followups.hidden=true;s.meaning.textContent='다른 창에서 삭제된 항목입니다.';}}
      message(s,'');return true;
    }catch(e){message(s,e.message,true);return false;}finally{if(dialogState===s){s.refreshing=false;controls(s);}}
  }
  // [codex-memo 변경] judge: 이미 저장된 뜻과 비교해 이 문맥에 맞는 뜻을 고르거나 새 의미로 정리한다
  async function summarize(s,judge=false){
    if(!s.input||s.busy||s.writing||s.refreshing||!otherEditorReady(s)||!discard(s))return;
    const operation=s.operation=(s.operation||0)+1;
    const known=judge?(s.snapshot?.entries||[]).filter(e=>key(e.term)===key(s.input.term)):[];
    hook('usage',s,'',null);s.newSense=false;
    s.busy=true;s.cancelled=false;s.draft=null;s.saved=null;s.editing=false;s.dirty=false;s.editor.hidden=true;s.preview.hidden=false;
    s.title.textContent=s.input.term;s.meaning.textContent='뜻을 요약하고 있습니다…';s.example.hidden=true;s.explanation.hidden=true;s.definitions.hidden=true;s.followups.hidden=true;s.meta.textContent='';
    s.contextBox.hidden=false;s.context.textContent=s.input.context||'주변 문맥이 없습니다.';s.source.textContent=[s.input.source?.title,s.input.source?.path].filter(Boolean).join(' · ');controls(s);
    message(s,known.length?`현재 Codex 로그인으로 뜻을 정리하는 중 · 저장된 뜻 ${known.length}개와 비교합니다.`:'뜻을 정리하는 중…');
    try{
      // [codex-memo 변경] 로컬 판단 모델 Mica 가 확신하면(0.1초) 그 판단을 쓰고, 모르면 GPT 가 판단한다
      let micaNew=false;
      if(known.length&&api.vocabularyJudge){
        const j=await api.vocabularyJudge(s.input).catch(()=>null);if(dialogState!==s||s.cancelled||s.operation!==operation)return;
        const hit=j&&j.choice!=='new'&&known.find(e=>e.id===j.choice);
        if(hit){
          s.busy=false;showItem(s,hit);hook('usage',s,'',hit,j);
          message(s,`${j.via||'분류기'} 가 저장된 뜻 ${known.length}개 중 이 문맥에 맞는 뜻을 골랐습니다 (확신 ${Math.round(j.confidence*100)}%).`);
          return;
        }
        micaNew=!!j&&j.choice==='new';
        if(micaNew)message(s,`${j.via||'분류기'} 판단: 저장된 뜻과 다른 새 의미입니다 (확신 ${Math.round(j.confidence*100)}%). 새 뜻을 정리하는 중…`);
      }
      const draft=await api.vocabularySummarize({...s.input,judge:!!known.length&&!micaNew});if(dialogState!==s||s.cancelled||s.operation!==operation)return;
      const matched=draft.matchedId&&known.find(e=>e.id===draft.matchedId);
      if(matched){
        s.busy=false;showItem(s,matched);hook('usage',s,draft.usage,matched);
        if(!matched.definitions?.length&&draft.definitions?.length)api.vocabularyEdit(matched.id,{definitions:draft.definitions,definitionIndex:draft.definitionIndex},s.snapshot.revision)
          .then(data=>{if(dialogState!==s)return;s.snapshot=data;remember(data);const updated=data.entries.find(e=>e.id===matched.id);if(updated&&s.saved?.id===updated.id&&!s.editing&&!s.draft){s.saved=updated;s.editRevision=data.revision;drawDefinitions(s,s.definitions,updated);}drawList(s);}).catch(()=>{});
        message(s,known.length>1?`저장된 뜻 ${known.length}개 중 이 문맥에 맞는 뜻입니다. 다른 뜻이면 “새 의미 추가”를 누르세요.`:'저장된 뜻과 같은 뜻으로 쓰였습니다.');
        return;
      }
      s.draft=draft;s.newSense=known.length>0;detail(s,draft);hook('usage',s,draft.usage,null);
      message(s,known.length?`저장된 뜻 ${known.length}개와 다른, 이 문맥의 새 의미입니다. 맞으면 저장하세요.`:'확인하고 저장하세요.');
    }catch(e){if(dialogState===s&&!s.cancelled&&s.operation===operation){s.meaning.textContent='요약을 완료하지 못했습니다.';message(s,e.message,true);}}
    finally{if(dialogState===s&&s.operation===operation){s.busy=false;controls(s);}}
  }
  async function save(s){
    if(!s.snapshot||!s.draft&&!(s.saved&&(s.editing||s.paragraphEdits)))return;
    if(pendingRevision(s)&&!revisionDraft(s)){message(s,'저장 전 분석 결과를 먼저 저장하거나 원본으로 되돌리세요.',true);return;}
    const edited=s.editing?collect(s):{};
    const draft=s.draft,existing=s.saved;
    const item=draft||existing;
    const patch={...s.paragraphEdits,...edited,...(item.showContextAnalysis!==undefined?{showContextAnalysis:item.showContextAnalysis}:{}),...(item.contextAnalyses!==undefined&&!s.paragraphEdits?.contextAnalyses?{contextAnalyses:item.contextAnalyses}:{}),previewParagraphs:selections({...item,...s.paragraphEdits,...edited,previewParagraphs:s.previewParagraphs})};
    const replacing=!!draft?.targetId;
    await mutate(s,()=>draft?api.vocabularySave(draft.id,replacing?draft.baseRevision:s.snapshot.revision,{mode:replacing?'replace':'add',...(replacing?{targetId:draft.targetId}:{}),edits:patch}):api.vocabularyEdit(existing.id,patch,s.editRevision),()=>{
      const item=s.snapshot.entries.find(e=>e.id===(draft?.targetId||existing?.id||draft?.id))||(!replacing&&s.snapshot.entries.find(e=>key(e.term)===key(draft?.term)));
      if(draft?.action==='followup')s.question.value='';
      if(item)showItem(s,item);message(s,'저장했습니다.');hook('saved',s,item);
    });
  }
  function toggleEdit(s){
    if(s.busy||s.writing||s.refreshing||!(s.draft||s.saved))return;
    if(s.editing){if(!discard(s,true))return;s.editing=false;s.dirty=false;detail(s,s.draft||s.saved);return;}
    const previewParagraphs=s.previewParagraphs;s.editing=true;detail(s,{...displayItem(s),previewParagraphs});s.fields.meaning.focus();
  }
  async function revise(s,action,preset){
    if(s.busy||s.writing||s.refreshing||!s.saved)return;
    if(!otherEditorReady(s))return;
    if(s.editing||unsavedEditor(s)){message(s,'작성 중인 내용을 저장하거나 버린 뒤 요청하세요.',true);return;}
    const question=(preset??s.question.value).trim();
    if(action==='followup'&&!question){s.question.focus();return;}
    const method=action==='followup'?api.vocabularyFollowup:api.vocabularyReanalyze;
    if(!method){message(s,'도우미 연결을 새로 고친 뒤 다시 시도하세요.',true);return;}
    const original=s.saved,revision=s.editRevision,operation=s.operation=(s.operation||0)+1;
    s.busy=true;s.cancelled=false;hook('usage',s,'',null);controls(s);
    message(s,action==='followup'?'답변을 받는 중…':'다시 분석하는 중…');
    try{
      const draft=await (action==='followup'?method(original.id,question,revision):method(original.id,revision));
      if(dialogState!==s||s.cancelled||s.operation!==operation)return;
      if(draft?.targetId!==original.id)throw Error('수정 결과의 대상이 맞지 않습니다. 원본은 유지됩니다.');
      s.draft=draft;s.saved=original;s.editing=false;s.dirty=false;detail(s,draft);hook('usage',s,draft.usage,null);
      if(action==='followup'){const heads=s.followups.querySelectorAll('h4');heads[heads.length-1]?.scrollIntoView({block:'start',behavior:'smooth'});}
      message(s,action==='followup'?'답변을 확인하고 저장하세요.':'다시 분석했습니다. 저장하면 기존 내용을 바꿉니다.');
    }catch(e){if(dialogState===s&&!s.cancelled&&s.operation===operation)message(s,e.message||'답변을 받지 못했습니다. 원본은 유지됩니다.',true);}
    finally{if(dialogState===s&&s.operation===operation){s.busy=false;controls(s);}}
  }
  async function discardAnalysis(s){
    if(s.busy||s.writing||s.refreshing||!(s.draft||s.paragraphEdits)||!discard(s))return;
    const original=s.saved,operation=s.operation=(s.operation||0)+1;
    s.busy=true;s.cancelling=true;s.draft=null;s.paragraphEdits=null;s.previewItem=null;s.dirty=false;s.editing=false;
    if(original)showItem(s,original);
    else {
      s.previewParagraphs=[];s.editor.hidden=true;s.preview.hidden=false;
      s.meaning.textContent='요약 결과를 버렸습니다.';
      s.meta.textContent='';s.example.hidden=true;s.explanation.hidden=true;s.definitions.hidden=true;s.followups.hidden=true;
      hook('usage',s,'',null);
    }
    message(s,original?'원본으로 되돌렸습니다.':'저장 전 요약 결과를 버렸습니다.');controls(s);
    try{await api.vocabularyCancel();}
    catch(e){message(s,e.message||'요약 결과 정리를 완료하지 못했습니다.',true);}
    finally{if(dialogState===s&&s.operation===operation){s.busy=false;s.cancelling=false;controls(s);}}
  }
  async function cancelOperation(s){
    if(!s.busy||s.cancelling)return;
    s.cancelled=true;s.cancelling=true;s.operation=(s.operation||0)+1;
    const operation=s.operation;
    if(s.saved)detail(s,s.saved);else s.meaning.textContent='요약을 취소했습니다.';
    message(s,'요청을 취소하는 중…');controls(s);
    try{await api.vocabularyCancel();if(dialogState===s)message(s,'취소한 결과는 저장하지 않습니다.');}
    catch(e){message(s,e.message||'취소 응답을 받지 못했습니다.',true);}
    finally{if(dialogState===s&&s.operation===operation){s.busy=false;s.cancelling=false;controls(s);}}
  }
  function buildSummary(s,input){
    s.contextDirty=false;s.contextLoading=false;s.contextMode=false;s.paragraphEdits=null;s.previewItem=null;
    const summary=s.summary;
    s.title=el('h3','vb-word',input?.term||'저장한 단어');s.title.tabIndex=-1;summary.append(s.title);
    s.preview=el('div','vb-analysis');s.meta=el('p','vb-meta');s.meaning=el('div','vb-meaning',input?'단어장을 불러오고 있습니다…':'답변에서 단어나 구절을 선택하거나, 저장한 뜻을 열어 보세요.');
    s.explanation=el('div','vb-explanation');s.explanation.hidden=true;s.example=el('div','vb-example');s.example.hidden=true;
    s.definitions=el('div','vb-definitions');s.definitions.hidden=true;
    s.followups=el('section','vb-followups');s.followups.hidden=true;
    s.previewParagraphs=[];s.draftBanner=el('p','vb-draft-banner','아직 저장하지 않은 결과입니다.');s.draftBanner.hidden=true;
    // [codex-memo 변경] 맥락적 의미를 먼저, 그 아래 사전적 의미(지금 문맥에 해당하는 번호 강조)
    s.pos=el('div','vb-pos');s.contexts=el('section');s.pinHelp=el('p','vb-preview-help');s.preview.append(s.meta,s.pinHelp,el('span','vb-label','맥락분석'),s.meaning,s.pos,s.contexts,s.definitions,s.explanation,s.example,s.followups);s.editor=el('div','vb-editor');s.editor.hidden=true;
    for(const [name,label,limit,rows] of [['meaning','맥락분석',1600,3],['partOfSpeech','품사',80,0],['explanation','참고',800,2],['example','예문',600,2],['tags','태그 (쉼표로 구분)',124,0]]){
      const wrapper=el('label','',label),field=el(rows?'textarea':'input');field.maxLength=limit;if(rows)field.rows=rows;
      field.addEventListener('input',()=>{s.dirty=true;drawEditorPins(s);});s.fields[name]=field;wrapper.append(field);s.editor.append(wrapper);
    }
    const statusLabel=el('label','','학습 상태');s.fields.status=el('select');s.fields.status.setAttribute('aria-label','학습 상태');
    for(const [value,label] of [['new','미학습'],['review','복습 필요'],['known','숙지함']]){const option=el('option','',label);option.value=value;s.fields.status.append(option);}
    s.fields.status.addEventListener('change',()=>{s.dirty=true;});statusLabel.append(s.fields.status);s.editor.append(statusLabel);
    const favoriteLabel=el('label');s.fields.favorite=el('input');s.fields.favorite.type='checkbox';s.fields.favorite.addEventListener('change',()=>{s.dirty=true;});favoriteLabel.append(s.fields.favorite,document.createTextNode(' 즐겨찾기'));s.editor.append(favoriteLabel);
    s.editorPins=el('section','vb-editor-pins');s.editor.append(s.editorPins);
    s.contextBox=el('details','vb-context');s.contextBox.hidden=true;s.contextBox.open=false;s.context=el('p');s.source=el('p','vb-meta');s.contextBox.append(el('summary','','원문'),s.context,s.source);
    const actions=el('div','vb-actions');s.save=button('단어장에 저장','vb-primary',()=>save(s));s.edit=button('편집','',()=>toggleEdit(s));
    s.retry=button('다시 요약','',()=>summarize(s,true));s.add=button('새 의미 추가','',()=>summarize(s,false));
    s.cancel=button('요청 취소','',()=>cancelOperation(s));
    s.reanalyze=button('다시 분석','',()=>revise(s,'reanalyze'));s.discardDraft=button('원본으로 되돌리기','',()=>discardAnalysis(s));
    s.followupForm=el('section','vb-followup-form');s.followupForm.hidden=true;
    const questionLabel=el('label','vb-ask-label','직접 질문');questionLabel.hidden=true;s.question=el('textarea');s.question.rows=2;s.question.maxLength=2000;s.question.placeholder='궁금한 점을 직접 물어보세요';s.question.setAttribute('aria-label','저장된 단어에 추가 질문');
    s.question.addEventListener('input',()=>controls(s));
    s.question.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();if(!s.followupSubmit.disabled)revise(s,'followup');}});
    s.followupSubmit=button('질문하기','',()=>revise(s,'followup'));s.followupSubmit.title='Ctrl+Enter';s.question.id='vb-question-'+Date.now();questionLabel.htmlFor=s.question.id;
    // [codex-memo 변경] 자주 쓰는 추가 질문을 버튼 하나로 요청한다. 결과는 일반 추가 답변과 같이 확인 후 저장된다.
    s.presets=el('div','vb-presets');for(const p of window.CodexVocabContent?.PRESETS||[]){const b=button(p.label,'',async()=>{b.dataset.busy='';b.textContent=p.label+' 받는 중…';try{await revise(s,'followup',p.question);}finally{delete b.dataset.busy;b.textContent=p.label;}});b.dataset.preset=p.label;b.dataset.question=p.question;s.presets.append(b);}
    const ask=el('div','vb-ask');ask.append(s.question,s.followupSubmit);s.followupForm.append(el('span','vb-label','더 알아보기'),s.presets,questionLabel,ask);
    s.contextForm=el('section','vb-followup-form');s.contextForm.hidden=true;
    s.contextSense=el('select');s.contextSense.setAttribute('aria-label','맥락분석을 저장할 뜻');
    s.contextSentence=el('textarea');s.contextSentence.rows=3;s.contextSentence.maxLength=1600;s.contextSentence.setAttribute('aria-label','새 문장');s.contextSentence.placeholder='같은 단어가 쓰인 다른 문장';
    s.contextAnswer=el('textarea');s.contextAnswer.rows=3;s.contextAnswer.maxLength=1600;s.contextAnswer.setAttribute('aria-label','새 문장 맥락분석');s.contextAnswer.placeholder='맥락분석을 받거나 직접 입력하세요';
    for(const field of [s.contextSentence,s.contextAnswer])field.addEventListener('input',()=>{s.contextDirty=true;controls(s);});
    s.contextSense.addEventListener('change',()=>{
      const id=s.contextSense.value,entry=s.snapshot.entries.find(e=>e.id===id),sentence=s.contextSentence.value;
      if(s.contextDirty&&!window.confirm('작성 중인 맥락분석을 버리고 다른 뜻을 선택할까요?')){s.contextSense.value=s.saved.id;return;}
      if(entry){showItem(s,entry);s.contextSentence.value=sentence;s.contextAnswer.value='';s.contextDirty=false;}controls(s);
    });
    s.contextAnalyze=button('맥락분석 받기','',()=>analyzeContext(s));s.contextSave=button('맥락분석 저장','',()=>saveContext(s));
    s.contextDiscard=button('입력 비우기','',()=>{s.contextSentence.value='';s.contextAnswer.value='';s.contextDirty=false;controls(s);});
    const contextActions=el('div','vb-actions');contextActions.append(s.contextAnalyze,s.contextSave,s.contextDiscard);
    s.contextForm.append(el('span','vb-label','다른 문장의 맥락분석'),s.contextSense,s.contextSentence,s.contextAnswer,contextActions);
    actions.append(s.save,s.edit,s.retry,s.add,s.reanalyze,s.discardDraft,s.cancel);
    const topbar=el('div','vb-topbar');topbar.append(s.title,actions,s.contextBox);summary.prepend(topbar);summary.append(s.draftBanner,s.preview,s.editor,s.followupForm,s.contextForm);
  }
  async function open(input,entryId=null,editEntry=false,libraryKind){
    if(dialogState){if(!input&&!entryId)showArchive(dialogState,libraryKind);return;}
    const dialog=el('dialog');dialog.id='cdx-vocabulary';dialog.setAttribute('aria-labelledby','cdx-vocabulary-title');
    const s={dialog,input,selectionInput:input,opener:document.activeElement,snapshot:null,draft:null,saved:null,busy:false,writing:false,refreshing:false,editing:false,dirty:false,fields:{},hasCompose:!!input,editorKind:entryId?'word':'compose',composeState:null,wordState:null};dialogState=s;
    const head=el('header','vb-head'),titles=el('div'),title=el('h2','','단어장 · 메모');title.id='cdx-vocabulary-title';
    s.heading=title;s.subtitle=el('p','vb-subtitle');titles.append(title,s.subtitle);
    const headActions=el('div','vb-head-actions');s.settings=button('설정','vb-settings',()=>window.dispatchEvent(new CustomEvent('codex-labels:open-settings',{detail:{tab:'vocabulary'}})));s.settings.setAttribute('aria-label','단어장·메모 설정 열기');
    const closeButton=button('×','vb-close',close);closeButton.setAttribute('aria-label','단어장·메모 닫기');headActions.append(s.settings,closeButton);head.append(titles,headActions);
    // [codex-memo 변경] 보관함 · 설정 탭 줄. 설정 탭을 누르면 공통 설정 창(renderer.js)을 그 탭으로 연다.
    s.tabs=el('div','vb-tabs');s.tabs.setAttribute('role','tablist');s.tabs.setAttribute('aria-label','보관함 · 설정');
    for(const [tab,name] of [['library','보관함'],['labels','라벨'],['vocabulary','단어장·메모'],['automation','자동 판단']]){
      const t=button(name,'',tab==='library'?()=>{}:()=>window.dispatchEvent(new CustomEvent('codex-labels:open-settings',{detail:{tab}})));
      t.setAttribute('role','tab');t.setAttribute('aria-selected',String(tab==='library'));t.dataset.tab=tab;s.tabs.append(t);
    }
    const navigation=el('nav','vb-navigation');navigation.setAttribute('aria-label','단어장·메모 화면 이동');
    s.archiveButton=button('보관함','vb-open-archive',()=>showArchive(s));s.composeButton=button('← 작성 중','vb-back-compose',()=>showCompose(s));navigation.append(s.archiveButton,s.composeButton);
    const main=el('div','vb-main'),summary=el('section','vb-pane vb-summary'),library=el('section','vb-pane vb-library');s.summary=summary;s.library=library;
    summary.setAttribute('aria-label','단어 뜻과 메모');library.setAttribute('aria-label','단어장·메모 보관함');
    buildSummary(s,input);
    const libraryHead=el('div','vb-library-head');s.count=el('h3','','저장한 뜻');s.refresh=button('새로고침','vb-refresh',()=>refresh(s));libraryHead.append(s.count,s.refresh);
    s.search=el('input','vb-search');s.search.type='search';s.search.placeholder='단어, 뜻, 태그, 원문 검색';s.search.setAttribute('aria-label','저장한 단어 검색');s.search.addEventListener('input',()=>drawList(s));
    const filters=el('div','vb-filters'),favoritesLabel=el('label');s.favorites=el('input');s.favorites.type='checkbox';s.favorites.addEventListener('change',()=>drawList(s));favoritesLabel.append(s.favorites,document.createTextNode(' 즐겨찾기만'));
    s.statusFilter=el('select');s.statusFilter.setAttribute('aria-label','학습 상태 필터');for(const [value,label] of [['','전체 상태'],['new','미학습'],['review','복습 필요'],['known','숙지함']]){const option=el('option','',label);option.value=value;s.statusFilter.append(option);}s.statusFilter.addEventListener('change',()=>drawList(s));filters.append(favoritesLabel,s.statusFilter);
    s.list=el('div','vb-list');library.append(libraryHead,s.search,filters,s.list);main.append(summary,library);
    s.notice=el('div','vb-notice','단어장을 불러오고 있습니다…');s.notice.setAttribute('role','status');s.notice.setAttribute('aria-live','polite');
    dialog.append(head,s.tabs,navigation,main,s.notice);document.body.append(dialog);hook('opened',s,{message:(v,e)=>message(s,v,e),controls:()=>controls(s),drawList:()=>drawList(s),showArchive:kind=>showArchive(s,kind),showCompose:()=>showCompose(s)});setView(s,input?'compose':entryId?'detail':'archive');if(libraryKind)hook('libraryKind',s,libraryKind);
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}});
    for(const b of buttons)b.remove();buttons.clear();selected=null;dialog.showModal();window.getSelection()?.removeAllRanges();
    if(!await refresh(s)||dialogState!==s)return;
    if(entryId){
      const item=s.snapshot.entries.find(e=>e.id===entryId);
      if(item){showItem(s,item);if(editEntry)toggleEdit(s);message(s,'');}
      else message(s,'이 항목은 삭제되었거나 다른 창에서 변경되었습니다.',true);
    }else if(input){
      const matches=s.snapshot.entries.filter(e=>key(e.term)===key(input.term));
      const same=matches.find(e=>e.context===input.context||(e.contextAnalyses||[]).some(c=>c.context===input.context));
      if(matches.length){
        showItem(s,same||matches[0]);s.contextMode=true;s.heading.textContent='맥락분석';
        s.dialog.querySelectorAll('.cxm-vmemo,.cxm-only').forEach(node=>node.hidden=true);
        s.contextSentence.value=input.context||'';
        const stored=(same?.contextAnalyses||[]).find(c=>c.context===input.context);
        if(same){s.contextAnswer.value=stored?.analysis||same.meaning;message(s,'저장된 맥락분석입니다.');}
        else if(matches.length===1){controls(s);await analyzeContext(s);}
        else{const option=el('option','','분석할 뜻을 선택하세요');option.value='';s.contextSense.prepend(option);s.contextSense.value='';message(s,'여러 뜻이 있습니다. 분석할 뜻을 선택한 뒤 맥락분석을 받으세요.');}
        controls(s);s.contextForm.scrollIntoView({block:'nearest'});
      }else await summarize(s,false);
    }
  }
  function showLibrary(event){const kind=event?.detail?.kind;open(null,null,false,['all','word','memo'].includes(kind)?kind:'all');}
  window.addEventListener('codex-labels:open-vocabulary',showLibrary);
  highlights=inlineCore.install({api,onSnapshot:remember,openEntry:(id,edit)=>open(null,id,edit)});
  function dispose(){
    if(disposed)return;
    disposed=true;highlights?.dispose();observer.disconnect();cancelAnimationFrame(frame);api.vocabularyCancel().catch(()=>{});
    for(const name of ['pointerdown','mousedown','click'])document.removeEventListener(name,toolbarEvent,true);
    document.removeEventListener('selectionchange',schedule);window.removeEventListener('codex-labels:open-vocabulary',showLibrary);
    if(dialogState){hook('closed',dialogState);dialogState.dialog.remove();dialogState=null;}
    for(const b of buttons)b.remove();buttons.clear();style.remove();window.removeEventListener('pagehide',dispose);
    if(window.__codexVocabularyRuntime===runtime){delete window.__codexVocabularyRuntime;delete window.__codexVocabularyInstalled;}
  }
  window.addEventListener('pagehide',dispose,{once:true});
})(() => {
  // This factory is also exported under Node for matcher regression tests. It
  // has no native/IPC access and does not touch the DOM until install() is called.
  const graphemes = new Intl.Segmenter('en', {granularity:'grapheme'});
  const WORD = /[\p{L}\p{N}\p{M}_]/u;
  // [codex-memo 변경] 한국어 본문: 'SELinux가'·'DPAPI로'처럼 영문 단어에 바로 붙은 조사도 경계로 본다.
  // 한글과 한글이 아닌 글자 사이는 단어 경계, 한글 단어 뒤에는 흔한 조사(최대 2개)까지 허용.
  const HANGUL = /\p{Script=Hangul}/u;
  const PARTICLE = /^(?:에서|에게|으로|까지|부터|처럼|보다|이나|이랑|이다|입니다|이고|이며|하고|이라는|라는|이란|은|는|이|가|을|를|의|에|께|로|와|과|도|만|나|랑|들|란){1,2}(?![\p{L}\p{N}\p{M}_])/u;
  const joined = (a,b) => !!a&&!!b&&WORD.test(a)&&WORD.test(b)&&HANGUL.test(a)===HANGUL.test(b);
  const charAt = (text,index) => String.fromCodePoint(text.codePointAt(index)||0).replace('\0','');
  const fold = value => value.normalize('NFKC').toLocaleLowerCase('en').replace(/ς/g,'σ');
  function normalizedMap(value) {
    let text = ''; const starts = [], ends = [];
    for (const {segment,index} of graphemes.segment(value)) {
      for (const char of fold(segment)) {
        if (/\s/u.test(char)) {
          if (!text || text.endsWith(' ')) { if(text)ends[ends.length-1]=index+segment.length; continue; }
          text+=' '; starts.push(index); ends.push(index+segment.length);
        } else {
          text+=char;
          for(let i=0;i<char.length;i++){starts.push(index);ends.push(index+segment.length);}
        }
      }
    }
    if(text.endsWith(' ')){text=text.slice(0,-1);starts.pop();ends.pop();}
    return {text,starts,ends};
  }
  const termKey = value => normalizedMap(value).text;
  const beforeChar = (text,index) => {
    if(!index)return '';
    const last=text.charCodeAt(index-1);
    return last>=0xDC00&&last<=0xDFFF&&index>1?text.slice(index-2,index):text[index-1];
  };
  function createMatcher(entries) {
    const groups = new Map(), root = {next:new Map()};
    for(const entry of entries.slice(0,2000)) {
      if(typeof entry?.term!=='string'||!entry.term.trim()||entry.term.length>160)continue;
      const key=termKey(entry.term);if(!key)continue;
      if(!groups.has(key))groups.set(key,[]);groups.get(key).push(entry);
    }
    for(const key of groups.keys()) {
      let node=root;
      // UTF-16 positions deliberately agree with DOM Range offsets.
      for(let i=0;i<key.length;i++){
        if(!node.next.has(key[i]))node.next.set(key[i],{next:new Map()});
        node=node.next.get(key[i]);
      }
      node.key=key;
    }
    function find(value) {
      const {text,starts,ends}=normalizedMap(value),found=[];
      for(let i=0;i<text.length;i++) {
        if(joined(beforeChar(text,i),charAt(text,i))||(i>0&&starts[i]===starts[i-1]))continue;
        let node=root,last=null;
        for(let j=i;j<text.length;j++) {
          node=node.next.get(text[j]);if(!node)break;
          const end=j+1,next=charAt(text,end);
          if(node.key&&(!joined(beforeChar(text,end),next)||(HANGUL.test(next)&&PARTICLE.test(text.slice(end,end+8))))&&
            (end===text.length||ends[end-1]!==ends[end]))last={key:node.key,end};
        }
        if(last){found.push({key:last.key,start:starts[i],end:ends[last.end-1]});i=last.end-1;}
      }
      return found;
    }
    return {groups,find,signature:JSON.stringify([...groups.keys()].sort())};
  }

  function install({api,onSnapshot,openEntry}) {
    const ROOT='[data-selected-text-overlay-target],[data-message-author-role="user"],[data-message-author-role="assistant"]';
    const BLOCK='p,div,section,article,header,footer,li,ul,ol,dt,dd,dl,td,th,tr,tbody,thead,table,blockquote,h1,h2,h3,h4,h5,h6,figure,figcaption';
    const OWN='[data-cdx-vocabulary-ui],#cdx-vocabulary,.cdx-vocabulary-action';
    const EXCLUDE=OWN+',a,pre,code,kbd,samp,input,textarea,button,select,option,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="textbox"],[role="toolbar"],div[role="presentation"].pointer-events-auto,script,style,noscript,svg,math,iframe,canvas,video,audio,[hidden],[aria-hidden="true"],[inert]';
    const NAME='codex-vocabulary-saved';
    const supported=!!globalThis.CSS?.highlights&&typeof globalThis.Highlight==='function';
    let matcher=createMatcher([]),snapshot=null,stopped=false,timer=0,readTimer=0,epoch=0,reading=false,readAgain=false,popup=null,pointer=null;
    const records=new Map(),pending=new Set(),nodeMatches=new WeakMap();
    const paint=supported?new Highlight():null;
    if(paint){
      CSS.highlights.set(NAME,paint);
      // [codex-memo 변경] 새 강조 객체를 스타일 기능에 알린다. 열린 창 때문에 교체가 늦어진 경우도 포함.
      window.dispatchEvent(new Event('codex-vocabulary:highlight-ready'));
    }
    const style=document.createElement('style');style.dataset.cdxVocabularyUi='';
    style.textContent=`
      ::highlight(codex-vocabulary-saved){text-decoration-line:underline;text-decoration-style:dotted;text-decoration-color:#64858e;text-decoration-thickness:1px}
      .dark ::highlight(codex-vocabulary-saved){text-decoration-color:#97c5d0}
      #cdx-vocabulary-access,#cdx-vocabulary-inline{--vi-bg:var(--color-surface,#fff);--vi-ink:var(--color-text,#202123);--vi-line:var(--color-border,#cdd3d7);--vi-muted:var(--color-text-secondary,#58636b);font:13px/1.6 'Segoe UI','Malgun Gothic',sans-serif;color:var(--vi-ink);background:var(--vi-bg);border:1px solid var(--vi-line);border-radius:10px;box-sizing:border-box}
      .dark #cdx-vocabulary-access,.dark #cdx-vocabulary-inline{--vi-bg:var(--color-surface,#23252a);--vi-ink:var(--color-text,#f1f3f5);--vi-line:var(--color-border,#50545b);--vi-muted:var(--color-text-secondary,#b8c0c8);color-scheme:dark}
      #cdx-vocabulary-access{position:static;margin-left:auto;padding:4px 6px;font-size:11px;line-height:16px;border-color:transparent;background:transparent;border-radius:6px;cursor:pointer;max-width:100%}
      #cdx-vocabulary-access:hover{background:var(--color-token-bg-hover,#80808018)}
      #cdx-vocabulary-access[hidden]{display:none!important}
      #cdx-vocabulary-inline{position:fixed;z-index:10001;width:min(360px,calc(100vw - 24px));max-height:min(480px,calc(100vh - 24px));padding:16px;box-shadow:0 12px 42px #0003;overflow:auto;overscroll-behavior:contain;overflow-wrap:anywhere}
      #cdx-vocabulary-inline h3,#cdx-vocabulary-inline p{margin:0}#cdx-vocabulary-inline h3{font-size:17px;padding-right:28px}
      #cdx-vocabulary-inline .vi-sub{color:var(--vi-muted);font-size:11px;margin:5px 0 12px}
      #cdx-vocabulary-inline .vi-sense{border-top:1px solid var(--vi-line);padding-top:10px;margin-top:10px}
      #cdx-vocabulary-inline .vi-meta{color:var(--vi-muted);font-size:11px;margin-bottom:6px}
      #cdx-vocabulary-inline .vi-meaning,#cdx-vocabulary-inline .vi-example,#cdx-vocabulary-inline .vi-explanation{white-space:pre-wrap}
      #cdx-vocabulary-inline .vi-example,#cdx-vocabulary-inline .vi-explanation{color:var(--vi-muted);font-size:12px;margin-top:7px}#cdx-vocabulary-inline .vi-defs{color:var(--vi-muted);font-size:12px;margin-top:6px}
      #cdx-vocabulary-inline .vi-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
      #cdx-vocabulary-inline .vi-actions label{display:flex;align-items:center;gap:4px;font-size:12px}
      #cdx-vocabulary-inline select{font:inherit;color:var(--vi-ink);background:var(--vi-bg);border:1px solid var(--vi-line);border-radius:999px;padding:4px 8px;cursor:pointer}
      #cdx-vocabulary-inline button{font:inherit;color:inherit;background:transparent;border:1px solid var(--vi-line);border-radius:6px;padding:4px 8px;cursor:pointer}
      #cdx-vocabulary-inline button:disabled,#cdx-vocabulary-inline select:disabled{opacity:.5;cursor:default}
      #cdx-vocabulary-inline .vi-close{position:absolute;right:10px;top:10px;border:0;font-size:17px;padding:0 7px}
      #cdx-vocabulary-inline .vi-word{display:block;width:100%;text-align:left;margin-top:7px}
      #cdx-vocabulary-inline .vi-status{font-size:12px;white-space:pre-wrap;margin-top:10px}
      #cdx-vocabulary-access:focus-visible,#cdx-vocabulary-inline button:focus-visible,#cdx-vocabulary-inline select:focus-visible,#cdx-vocabulary-inline:focus-visible{outline:2px solid #588ca1;outline-offset:3px}
      @media(forced-colors:active){::highlight(codex-vocabulary-saved){text-decoration-color:LinkText}#cdx-vocabulary-access,#cdx-vocabulary-inline{border-color:ButtonText}}
    `;
    document.head.append(style);
    function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
    function button(text,cls,action){const n=el('button',cls,text);n.type='button';n.addEventListener('click',action);return n;}
    const access=button('저장된 단어','',()=>{if(!supported)openEntry(null,false);else show(null,access);});
    access.id='cdx-vocabulary-access';access.dataset.cdxVocabularyUi='';access.hidden=supported;
    access.setAttribute('aria-label','이 대화의 저장된 단어 보기');access.setAttribute('aria-haspopup','dialog');access.setAttribute('aria-expanded','false');
    access.setAttribute('aria-keyshortcuts','Alt+Shift+V');access.title=supported?'밑줄 단어의 저장된 뜻 보기 · Alt+Shift+V':'이 실행본에서는 본문 강조를 지원하지 않습니다. 단어장은 열 수 있습니다.';
    const attachAccess=()=>{
      const tools=window.__cxm?.sidebarTools?.();
      if(tools&&access.parentElement!==tools)tools.append(access);
      else if(!access.isConnected&&!window.__cxm?.sidebarTools)document.body.prepend(access);
    };
    attachAccess();
    const unwatchAccess=window.__cxm?.watch({sidebar:attachAccess});
    const element=node=>node?.nodeType===1?node:node?.parentElement;
    function own(node){return !!element(node)?.closest(OWN);}
    function rootFor(node){const e=element(node);return e?.closest(ROOT)||null;}
    function unitFor(node){const e=element(node),root=rootFor(e);if(!root)return null;const block=e.closest(BLOCK);return block&&root.contains(block)?block:root;}
    function excluded(node){return !!element(node)?.closest(EXCLUDE);}
    function viable(unit){return unit.isConnected&&!!rootFor(unit)&&!excluded(unit);}
    function removeRanges(record){
      for(const hit of record.hits)paint?.delete(hit.range);
      for(const node of record.nodes)nodeMatches.delete(node);
      record.hits=[];record.nodes.clear();
    }
    function forget(unit){const record=records.get(unit);if(record)removeRanges(record);records.delete(unit);pending.delete(unit);intersection?.unobserve(unit);}
    function queue(unit){
      if(!unit||!supported||stopped)return;
      if(!viable(unit)){forget(unit);return;}
      let record=records.get(unit);
      if(!record){record={hits:[],nodes:new Set(),visible:!intersection,dirty:true};records.set(unit,record);intersection?.observe(unit);}
      else{removeRanges(record);record.dirty=true;}
      if(popup?.unit===unit)hide(false);
      pending.add(unit);schedule();
    }
    function queueTree(node,invalidate=false){
      const e=element(node);if(!e||own(e))return;
      // Existing records must be invalidated even after their eligibility changes.
      if(invalidate)for(const unit of records.keys())if((unit===e||e.contains(unit))&&!viable(unit))forget(unit);
      queue(unitFor(e));
      if(e.matches(ROOT)||rootFor(e)){
        if(!excluded(e)){if(e.matches(BLOCK)||e.matches(ROOT))queue(e);for(const n of e.querySelectorAll(BLOCK))queue(n);}
      }else for(const root of e.querySelectorAll(ROOT)){
        queue(root);for(const n of root.querySelectorAll(BLOCK))queue(n);
      }
    }
    const intersection=typeof IntersectionObserver==='function'?new IntersectionObserver(changes=>{
      for(const {target,isIntersecting} of changes){const r=records.get(target);if(!r)continue;r.visible=isIntersecting;if(isIntersecting&&r.dirty)pending.add(target);}
      schedule();
    },{rootMargin:'600px'}):null;
    function schedule(){if(!timer&&!stopped&&pending.size)timer=setTimeout(flush,40);}
    function runs(unit){
      const result=[];let spans=[],text='';
      const flush=()=>{if(text)result.push({text,spans});spans=[];text='';};
      const stack=[...unit.childNodes].reverse();
      if(excluded(unit))return result;
      while(stack.length){
        const node=stack.pop();
        if(node.nodeType===3){if(node.data){spans.push({node,start:text.length,end:text.length+node.data.length});text+=node.data;}continue;}
        if(node.nodeType!==1)continue;
        if(node.matches(EXCLUDE)||node.matches(BLOCK)||node.matches(ROOT)||node.tagName==='BR'||node.tagName==='HR'){flush();continue;}
        const css=getComputedStyle(node);
        if(css.display==='none'||css.visibility==='hidden'||css.visibility==='collapse'){flush();continue;}
        for(let i=node.childNodes.length-1;i>=0;i--)stack.push(node.childNodes[i]);
      }
      flush();return result;
    }
    function spanAt(spans,offset,isEnd=false){
      let lo=0,hi=spans.length-1;
      while(lo<hi){const mid=(lo+hi)>>1;if(spans[mid].end<offset||(!isEnd&&spans[mid].end===offset))lo=mid+1;else hi=mid;}
      return {span:spans[lo],index:lo};
    }
    function scanUnit(unit,record){
      record.dirty=false;removeRanges(record);
      if(!matcher.groups.size)return;
      // [codex-memo 변경] 지금 안 보이는 문단은 다시 보일 때(IntersectionObserver) 칠하도록 dirty 로 남긴다
      const css=getComputedStyle(unit);if(!unit.getClientRects().length||css.display==='none'||css.visibility==='hidden'||css.visibility==='collapse'){record.dirty=true;return;}
      for(const run of runs(unit))for(const match of matcher.find(run.text)){
        const first=spanAt(run.spans,match.start),last=spanAt(run.spans,match.end,true);
        const bounds={startContainer:first.span.node,startOffset:match.start-first.span.start,endContainer:last.span.node,endOffset:match.end-last.span.start};
        let range;
        if(typeof StaticRange==='function')range=new StaticRange(bounds);
        else{range=document.createRange();range.setStart(bounds.startContainer,bounds.startOffset);range.setEnd(bounds.endContainer,bounds.endOffset);}
        const hit={key:match.key,range,unit};record.hits.push(hit);paint.add(range);
        for(let i=first.index;i<=last.index;i++){
          const node=run.spans[i].node;record.nodes.add(node);
          if(!nodeMatches.has(node))nodeMatches.set(node,[]);nodeMatches.get(node).push(hit);
        }
      }
    }
    function flush(){
      timer=0;if(stopped)return;
      const started=performance.now();let count=0;
      for(const unit of [...pending]){
        pending.delete(unit);const record=records.get(unit);if(!record)continue;
        if(!viable(unit)){forget(unit);continue;}
        if(!record.visible)continue;
        scanUnit(unit,record);
        if(++count>=24||performance.now()-started>8)break;
      }
      updateAccess();schedule();
    }
    function foundKeys(){const keys=new Set();for(const record of records.values())for(const hit of record.hits)keys.add(hit.key);return keys;}
    function updateAccess(){
      attachAccess();
      const count=foundKeys().size;
      const label=supported?'저장된 단어 · '+count:'단어장';if(access.textContent!==label)access.textContent=label;
      const hidden=supported&&(!count||!!document.querySelector('#cdx-vocabulary'));
      if(access.hidden!==hidden)access.hidden=hidden;
    }
    function liveRange(hit){
      const b=hit.range;if(!b.startContainer.isConnected||!b.endContainer.isConnected)return null;
      try{const r=document.createRange();r.setStart(b.startContainer,b.startOffset);r.setEnd(b.endContainer,b.endOffset);return r;}catch{return null;}
    }
    function hitAt(x,y){
      // [codex-memo 변경] 본문 표시를 끄면(labels/vocab-highlight.js 가 칠하기를 뗌) 클릭 카드도 열지 않는다
      if(paint&&CSS.highlights.get(NAME)!==paint)return null;
      let caret=document.caretPositionFromPoint?.(x,y);
      if(!caret){const r=document.caretRangeFromPoint?.(x,y);if(r)caret={offsetNode:r.startContainer,offset:r.startOffset};}
      if(!caret||excluded(caret.offsetNode))return null;
      for(const hit of nodeMatches.get(caret.offsetNode)||[]){
        const r=liveRange(hit);if(!r||!r.isPointInRange(caret.offsetNode,caret.offset))continue;
        for(const rect of r.getClientRects())if(x>=rect.left&&x<=rect.right&&y>=rect.top&&y<=rect.bottom)return hit;
      }
      return null;
    }
    function hide(restore=true){
      if(!popup)return;const old=popup;popup=null;const focused=old.node.contains(document.activeElement);old.node.remove();access.setAttribute('aria-expanded','false');
      if(restore&&focused&&!access.hidden)access.focus({preventScroll:true});
    }
    function position(p){
      const box=p.node.getBoundingClientRect(),w=document.documentElement.clientWidth,h=window.innerHeight;
      const anchor=p.anchor||access.getBoundingClientRect();
      const left=Math.max(12,Math.min(anchor.left,w-box.width-12));
      const top=Math.max(12,Math.min(anchor.bottom+8,h-box.height-12));
      p.node.style.left=left+'px';p.node.style.top=top+'px';
    }
    function show(hit,opener){
      if(stopped||document.querySelector('#cdx-vocabulary'))return;
      const anchor=hit?liveRange(hit)?.getBoundingClientRect():opener?.getBoundingClientRect();
      if(hit&&!anchor)return;
      hide(false);
      const node=el('div');node.id='cdx-vocabulary-inline';node.dataset.cdxVocabularyUi='';node.tabIndex=-1;
      node.setAttribute('role','dialog');node.setAttribute('aria-label','저장된 단어 뜻');
      const p={node,key:hit?.key||null,unit:hit?.unit||null,anchor,writing:false};popup=p;access.setAttribute('aria-expanded','true');document.body.append(node);
      drawPopup(p);position(p);node.focus({preventScroll:true});
    }
    function drawPopup(p){
      if(popup!==p)return;
      const hadFocus=p.node.contains(document.activeElement);p.node.replaceChildren();
      const close=button('×','vi-close',()=>hide());close.setAttribute('aria-label','저장된 뜻 닫기');p.node.append(close);
      if(!p.key){
        p.node.append(el('h3','','이 대화의 저장된 단어'),el('p','vi-sub','단어를 고르세요'));
        for(const key of [...foundKeys()].sort()){
          const entries=matcher.groups.get(key);if(!entries?.length)continue;
          const b=button(entries[0].term+' · '+entries.length+'개 뜻','vi-word',()=>{p.key=key;drawPopup(p);position(p);p.node.focus();});
          p.node.append(b);
        }
      }else{
        const entries=matcher.groups.get(p.key);if(!entries?.length){hide();return;}
        p.node.append(el('h3','',entries[0].term),el('p','vi-sub','저장된 뜻 '+entries.length+'개'));
        for(const item of entries){
          const card=el('section','vi-sense');card.append(el('p','vi-meta',[item.partOfSpeech,...(item.tags||[])].filter(Boolean).join(' · ')));
          if(item.showContextAnalysis!==false)card.append(el('p','vi-meta','맥락분석'),el('p','vi-meaning',item.meaning));
          for(const context of item.contextAnalyses||[])if(context.visible)card.append(el('p','vi-meta',context.context),el('p','vi-meaning',context.analysis));
          if(item.definitions?.length)card.append(el('p','vi-defs','사전: '+item.definitions.map((d,i)=>('①②③④'[i]||i+1)+' '+d).join('  ')));
          if(item.explanation)card.append(el('p','vi-explanation',item.explanation));if(item.example)card.append(el('p','vi-example',item.example));
          const actions=el('div','vi-actions');
          const statusLabel=el('label','','학습 상태 '),statusSelect=el('select');
          statusSelect.setAttribute('aria-label',item.term+' 학습 상태');
          for(const [value,label] of [['new','미학습'],['review','복습 필요'],['known','숙지함']]){const option=el('option','',label);option.value=value;statusSelect.append(option);}
          statusSelect.value=item.status||'new';statusSelect.disabled=p.writing;
          statusSelect.addEventListener('change',async()=>{
            if(p.writing)return;
            const status=statusSelect.value,previous=item.status||'new';p.writing=true;
            for(const control of p.node.querySelectorAll('button,select'))control.disabled=true;
            p.status.textContent='저장 중…';
            try{
              const current=await api.vocabularyRead();
              if(!current.entries.some(entry=>entry.id===item.id))throw new Error('삭제된 단어입니다. 단어장을 새로고침해 주세요.');
              const data=await api.vocabularyEdit(item.id,{status},current.revision);
              if(!stopped)onSnapshot(data);
              if(popup===p)p.status.textContent='학습 상태를 저장했습니다.';
            }catch(error){if(popup===p){statusSelect.value=previous;p.status.textContent=error.message||'저장하지 못했습니다. 다시 시도해 주세요.';p.status.setAttribute('role','alert');}}
            finally{p.writing=false;if(popup===p)for(const control of p.node.querySelectorAll('button,select'))control.disabled=false;}
          });
          statusLabel.append(statusSelect);actions.append(statusLabel);
          actions.append(button('단어장 열기','',()=>{hide(false);openEntry(item.id,false);}),button('수정','',()=>{hide(false);openEntry(item.id,true);}));
          const del=button('삭제','',async()=>{
            if(p.writing)return;
            if(!del.dataset.confirm){del.dataset.confirm='yes';del.textContent='삭제 확인';return;}
            p.writing=true;for(const b of p.node.querySelectorAll('button,select'))b.disabled=true;
            try{const data=await api.vocabularyDelete(item.id,snapshot.revision);if(!stopped)onSnapshot(data);}
            catch(error){if(popup===p){p.status.textContent=error.message||'삭제하지 못했습니다. 단어장을 새로고침해 주세요.';p.status.setAttribute('role','alert');}}
            finally{p.writing=false;if(popup===p)for(const b of p.node.querySelectorAll('button,select'))b.disabled=false;}
          });del.setAttribute('aria-label',item.term+' 뜻 삭제');actions.append(del);card.append(actions);p.node.append(card);
        }
      }
      p.status=el('p','vi-status');p.status.setAttribute('role','status');p.node.append(p.status);
      if(hadFocus)p.node.focus({preventScroll:true});
    }
    function setSnapshot(data){
      if(stopped||!Array.isArray(data?.entries))return;
      epoch++;snapshot=data;
      const next=createMatcher(data.entries),changed=next.signature!==matcher.signature;matcher=next;
      if(changed){for(const [unit,r] of records){removeRanges(r);r.dirty=true;pending.add(unit);}schedule();}
      if(popup){drawPopup(popup);if(popup)position(popup);}
      updateAccess();
    }
    async function refresh(){
      if(stopped)return;
      if(reading){readAgain=true;return;}reading=true;const requestEpoch=epoch;
      try{const data=await api.vocabularyRead();if(!stopped&&requestEpoch===epoch)onSnapshot(data);else readAgain=true;}
      catch{if(!stopped){access.title='단어장을 읽지 못했습니다. 새로고침해 주세요.';}}
      finally{reading=false;if(readAgain&&!stopped){readAgain=false;requestRefresh();}}
    }
    function requestRefresh(){if(stopped||readTimer)return;readTimer=setTimeout(()=>{readTimer=0;refresh();},25);}
    function changed(){epoch++;requestRefresh();}
    const unsubscribe=typeof api.onVocabularyChanged==='function'?api.onVocabularyChanged(changed):null;
    const mutations=new MutationObserver(changes=>{
      let removed=false;
      for(const change of changes){
        if(own(change.target))continue;
        if(change.type==='characterData'){queue(unitFor(change.target));continue;}
        // [codex-memo 변경] class·style 은 스크롤·가상 목록에서 자주 바뀐다. 본문 밖(목록 틀 등)의 변화는
        // 칠할 글자를 바꾸지 않으므로 건너뛰고(스크롤 지연 방지), 본문 안이면 그 문단만 다시 본다.
        if(change.type==='attributes'&&(change.attributeName==='class'||change.attributeName==='style')){
          if(rootFor(change.target))queue(unitFor(change.target));continue;
        }
        if(change.type==='attributes'){queueTree(change.target,true);continue;}
        queue(unitFor(change.target));
        for(const node of change.addedNodes)if(node.nodeType===1&&!own(node))queueTree(node);
        for(const node of change.removedNodes)if(node.nodeType===1&&!own(node))removed=true;
      }
      if(removed){for(const unit of records.keys())if(!unit.isConnected)forget(unit);if(popup?.unit&&!popup.unit.isConnected)hide(false);}
      if(document.querySelector('#cdx-vocabulary'))hide(false);
      updateAccess();
    });
    mutations.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['hidden','aria-hidden','inert','contenteditable','role','class','style','data-selected-text-overlay-target','data-message-author-role']});
    function onPointer(e){if(!own(e.target))pointer={x:e.clientX,y:e.clientY,id:e.pointerId};}
    function onClick(e){
      if(own(e.target))return;
      if(popup)hide(false);
      if(e.defaultPrevented||e.button!==0||e.detail!==1||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey||excluded(e.target)||document.querySelector('#cdx-vocabulary'))return;
      if(pointer&&Math.hypot(e.clientX-pointer.x,e.clientY-pointer.y)>6)return;
      if(!window.getSelection()?.isCollapsed)return;
      const hit=hitAt(e.clientX,e.clientY);if(hit)show(hit);
    }
    function onKey(e){
      if(e.key==='Escape'&&popup){e.preventDefault();e.stopPropagation();hide();return;}
      if(e.altKey&&e.shiftKey&&!e.ctrlKey&&!e.metaKey&&e.code==='KeyV'&&!excluded(e.target)&&!access.hidden){e.preventDefault();if(supported)show(null,access);else openEntry(null,false);}
    }
    function onVisibility(){if(!document.hidden)changed();else hide(false);}
    function onFocus(){changed();}
    function onScroll(e){if(popup&&!popup.node.contains(e.target))hide(false);}
    function onResize(){hide(false);}
    document.addEventListener('pointerdown',onPointer,true);document.addEventListener('click',onClick,true);document.addEventListener('keydown',onKey,true);
    document.addEventListener('visibilitychange',onVisibility);window.addEventListener('focus',onFocus);
    document.addEventListener('scroll',onScroll,true);window.addEventListener('resize',onResize);
    queueTree(document.body);requestRefresh();
    function dispose(){
      stopped=true;clearTimeout(timer);clearTimeout(readTimer);mutations.disconnect();intersection?.disconnect();unsubscribe?.();hide(false);
      for(const r of records.values())removeRanges(r);records.clear();pending.clear();
      if(paint&&CSS.highlights.get(NAME)===paint)CSS.highlights.delete(NAME);
      document.removeEventListener('pointerdown',onPointer,true);document.removeEventListener('click',onClick,true);document.removeEventListener('keydown',onKey,true);
      document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('focus',onFocus);
      document.removeEventListener('scroll',onScroll,true);window.removeEventListener('resize',onResize);style.remove();access.remove();
      unwatchAccess?.();document.querySelectorAll('.cxm-sidebar-tools:empty').forEach(n=>n.remove());
    }
    return {setSnapshot,dispose};
  }
  return {normalizedMap,termKey,createMatcher,install};
});
