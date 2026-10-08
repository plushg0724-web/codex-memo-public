"""메모·단어장 통합 화면 테스트 (Codex 화면을 흉내 낸 페이지 + 가짜 저장소).

실행: python tests/test_ui.py   (설치된 Chrome 을 headless 로 사용, 브라우저 내려받기 없음)
"""
import sys, json
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
read = lambda p: (ROOT / p).read_text(encoding="utf-8")
LONG = "이 문장은 메모 전용 테스트를 위한 아주 긴 문장입니다. " * 6

HTML = f"""<!doctype html><html><head><meta charset="utf-8"></head><body style="font:16px sans-serif">
<div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-selected="true"
     data-app-action-sidebar-thread-id="local:test-thread" data-app-action-sidebar-thread-title="테스트 대화"></div>
<main><div data-selected-text-overlay-target>
<p id="p1">요청을 어느 서버로 보낼지 정하는 라우팅 설정을 바꿨습니다.</p>
<p id="p2">{LONG}</p>
<p id="p3">네트워크 장비의 라우팅 표를 확인했습니다.</p>
<p id="p4">웹 페이지 라우팅 방식을 바꿨습니다.</p>
<p id="p5">모바일 앱 화면 라우팅 구조를 정리했습니다.</p>
</div></main></body></html>"""

MOCKS = r"""
// Codex 선택 툴바 흉내: 본문에서 선택하면 툴바가 뜬다
document.addEventListener('mouseup', () => setTimeout(() => {
  window.__toolbarTicks = (window.__toolbarTicks || 0) + 1;   // drag() 가 이 처리가 끝났는지 기다린다
  document.querySelectorAll('div[role=presentation].pointer-events-auto').forEach(t => t.remove());
  const s = getSelection(); if (!s || s.isCollapsed || window.__noToolbar) return;   // __noToolbar: 'Your dot' 처럼 툴바가 없는 화면
  const t = document.createElement('div'); t.setAttribute('role', 'presentation'); t.className = 'pointer-events-auto';
  t.style.cssText = 'position:fixed;top:4px;left:4px;display:flex;gap:4px';
  for (const n of ['채팅에 추가', '자세히 보기']) { const b = document.createElement('button'); b.className = 'tb'; b.textContent = n; t.append(b); }
  document.body.append(t);
}, 20));
// 가짜 단어장 저장소
const vocab = { version: 2, revision: 'r0', entries: [] }; let rev = 0;
const snap = () => JSON.parse(JSON.stringify({ ...vocab, revision: 'r' + rev }));
window.__classifyCalls = [];
const nativeSetInterval = window.setInterval;
window.setInterval = (fn, ms, ...args) => {
  if (ms === 30000 && String(fn).includes('classifierGet')) window.__classifierProbe = fn;
  return nativeSetInterval(fn, ms, ...args);
};
window.__thresholds = {label: 0.8, status: 0.9, memo: 0.6, sense: 0.8};
window.__model = {model: 'gpt-6-luna', effort: 'high', fast: true};
window.__guide = {guide: '기본 지침', defaultGuide: '기본 지침', custom: false, limit: 4000};
window.__config = {labels: [
  {id:'requested',kind:'status',name:'요청',backgroundColor:'#CBD5E1',textColor:'#111111',description:'',order:0,enabled:true},
  {id:'dev',kind:'category',name:'개발',backgroundColor:'#FCA5A5',textColor:'#111111',description:'',order:10,enabled:true}
], appearance:{fontSizePx:11,borderRadiusPx:5,verticalPaddingPx:1,horizontalPaddingPx:3,gapPx:2}};
window.__configRevision = 'config-0';
const labelSnapshot = () => JSON.parse(JSON.stringify({config:window.__config, configRevision:window.__configRevision,
  snapshotVersion:window.__configRevision,assignments:{},categoryAssignments:{}}));
window.addEventListener('cxm:auto-refresh', () => { window.__refreshEvents = (window.__refreshEvents || 0) + 1; });
window.codexLabels = {
  read: async () => labelSnapshot(), onChanged: () => () => {}, report: async () => true,
  openConfig: async () => true,
  saveConfig: async (value) => { window.__config = value; window.__configRevision += '-saved'; window.__labelSaves = (window.__labelSaves || 0) + 1; return labelSnapshot(); },
  vocabularyModels: async () => [
    {id:'gpt-6-luna',name:'GPT-6 Luna',efforts:['low','high'],defaultEffort:'high',fast:true},
    {id:'test-model',name:'Test Model',efforts:['low','medium'],defaultEffort:'medium',fast:false}],
  vocabularyModel: async () => ({...window.__model}),
  vocabularySetModel: async (model, effort) => { if(window.__failModel) throw Error('모델 저장 실패 테스트'); return (window.__model = {...window.__model,model,effort}); },
  vocabularySetFast: async (fast) => (window.__model = {...window.__model, fast}),
  vocabularyGuide: async () => ({...window.__guide}),
  vocabularySetGuide: async (text) => { const g = (text ?? '').trim(); return (window.__guide = {...window.__guide, guide: g || window.__guide.defaultGuide, custom: !!g}); },
  classifierGet: async () => ({available: !!window.__classifierOn, mode: 'mica'}),
  memoScores: async () => ({todo: 0.12, idea: 0.71, question: 0.07, reference: 0.1}),
  autoSettings: async () => ({mode: 'jev', available: true, jevKey: true, thresholds: window.__thresholds,
    defaults: {label: 0.6, status: 0.9, memo: 0.6, sense: 0.8}}),
  thresholdsSet: async (patch) => { if(window.__failThreshold) throw Error('기준 저장 실패 테스트'); (window.__thresholdCalls ||= []).push(patch); Object.assign(window.__thresholds, patch); return window.__thresholds; },
  autoRefresh: async () => { window.__autoRefreshed = (window.__autoRefreshed || 0) + 1; return true; },
  memoClassify: async (memo) => {
    window.__classifyCalls.push(memo.id);
    await new Promise(r => setTimeout(r, 20));
    const current = memoStore.find(m => m.id === memo.id);
    if (!window.__classifierOn || !current || current.category || /애매/.test(current.note)) return null;
    current.category = 'reference';
    window.__codexMemo.setMemos(JSON.parse(JSON.stringify(memoStore)));
    return {category: 'reference', confidence: 0.9};
  },
  vocabularyRead: async () => snap(),
  onVocabularyChanged: (fn) => { (window.__vocabListeners ||= new Set()).add(fn); return () => window.__vocabListeners.delete(fn); },
  vocabularySummarize: async (i) => {
    window.__summarizeCalls = (window.__summarizeCalls || 0) + 1; window.__lastJudge = i.judge;
    const known = i.judge ? vocab.entries.filter(e => e.term === i.term) : [];
    const same = known.length && /네트워크/.test(i.context) ? known[0] : null;
    return (window.__lastDraft = { id: '00000000-0000-4000-8000-' + String(Date.now() + window.__summarizeCalls).padStart(12, '0').slice(-12),
      term: i.term, context: i.context, source: i.source,
      meaning: same ? same.meaning : i.term + (known.length ? '의 새 뜻' : '의 테스트 뜻'), usage: '이 문맥에서 ' + i.term + '은(는) 이렇게 쓰임', matchedId: same ? same.id : '',
      definitions: ['(네트워크) 경로를 정하는 일', '(웹) 주소에 맞는 화면을 고르는 일'], definitionIndex: known.length ? -1 : 0,
      example: '', partOfSpeech: '명사', explanation: '', tags: ['개발'],
      favorite: false, status: 'new', model: 'gpt-6-luna', effort: 'high', savedAt: Date.now(), updatedAt: Date.now() });
  },
  vocabularyCancel: async () => true,
  vocabularyJudge: async (i) => {
    if (!window.__micaOn) return null;
    const known = vocab.entries.filter(e => e.term === i.term);
    if (/네트워크/.test(i.context)) return { choice: known[0].id, confidence: 0.97, via: 'Mica' };
    if (/모바일/.test(i.context)) return { choice: 'new', confidence: 0.9, via: 'Mica' };
    return null;
  },
  // 저장 순서 그대로 돌려준다 (글자 비슷함 순서와 달라야 Mica 순서를 쓴 게 드러남)
  vocabularySenseRank: async (term) => window.__micaOn ? vocab.entries.filter(e => e.term === term).map(e => e.id) : null,
  vocabularyUsage: async () => '라우터 표의 경로를 가리킴 (GPT)',
  vocabularySave: async (id, r, o) => { window.__lastDraftSaved = id; const { usage, matchedId, ...d } = window.__lastDraft;
    vocab.entries.push({ ...d, id }); rev++; setTimeout(() => window.__vocabListeners?.forEach(f => f()), 40); return snap(); },  // 실제 백엔드처럼 변경 신호
  vocabularyEdit: async (id, patch, revision) => { if(revision !== snap().revision) throw Error('revision conflict'); Object.assign(vocab.entries.find(e=>e.id===id),patch);rev++;return snap(); }, vocabularyDelete: async () => snap(),
};
// 가짜 메모 도우미 (codex_memo.py 대신)
const memoStore = []; let mid = 0;
window.__codexMemoBridge = (raw) => { const m = JSON.parse(raw); setTimeout(() => {
  if (m.op === 'labels') {
    Promise.resolve().then(() => window.codexLabels[m.method](...m.args))
      .then(value => window[m.cb].resolve(m.id,true,value), error => window[m.cb].resolve(m.id,false,error.message));
    return;
  }
  if (m.op === 'add') memoStore.push({ id: 'm' + (++mid), created: '2026-10-02 12:00', title: m.title, conv: m.conv, quote: m.quote, note: m.note, exact: m.exact, prefix: m.prefix, suffix: m.suffix });
  if (m.op === 'update') {
    const current = memoStore.find(x => x.id === m.id);
    if (m.note !== undefined) current.note = m.note;
    if (m.category !== undefined) current.category = m.category;
  }
  if (m.op === 'delete') memoStore.splice(memoStore.findIndex(x => x.id === m.id), 1);
  window.__codexMemo && window.__codexMemo.setMemos(JSON.parse(JSON.stringify(memoStore)));
}, 10); };
window.__memoStore = memoStore;
"""


def drag(page, sel, start, end):
    box = page.evaluate(f"""(() => {{ const n = document.querySelector('{sel}').firstChild; const r = new Range();
      r.setStart(n, {start}); r.setEnd(n, {start} + 1); const a = r.getBoundingClientRect();
      r.setStart(n, {end} - 1); r.setEnd(n, {end}); const b = r.getBoundingClientRect();
      return [a.left + 1, a.top + a.height / 2, b.right - 1, b.top + b.height / 2]; }})()""")
    ticks = page.evaluate("window.__toolbarTicks || 0")
    page.mouse.click(10, 300)
    # 가짜 툴바(왼쪽 위 고정)는 마우스를 뗀 20ms 뒤에 다시 그려진다. 그 처리 전에 드래그를 시작하면
    # 드래그 중인 선택으로 툴바가 생겨 드래그 끝 지점을 가리므로, 클릭의 처리가 끝날 때까지 기다린다.
    page.wait_for_function(f"(window.__toolbarTicks || 0) > {ticks}")
    page.mouse.move(box[0], box[1]); page.mouse.down()
    page.mouse.move((box[0] + box[2]) / 2, box[1], steps=5); page.mouse.move(box[2], box[3], steps=5); page.mouse.up()
    page.wait_for_timeout(300)


def toolbar(page):
    return page.evaluate("[...document.querySelectorAll('div[role=presentation].pointer-events-auto button')].map(b => b.textContent)")


ok = True
def check(name, cond, extra=""):
    global ok
    ok &= bool(cond)
    print(("✔ " if cond else "✘ ") + name, extra)


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    page = b.new_page(viewport={"width": 1200, "height": 800})
    page.set_default_timeout(6000)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    accept_discard = lambda dialog: dialog.accept()
    page.on("dialog", accept_discard)
    page.set_content(HTML)
    page.add_script_tag(content=MOCKS)
    page.add_script_tag(content=read("labels/common.js"))
    # 실제 주입 순서(cdp_bridge.labels_script)처럼 단어장 문단 도구를 단어장 화면보다 먼저 넣는다
    page.add_script_tag(content=read("labels/vocabulary-content.js"))
    page.add_script_tag(content=read("labels/vendor/vocabulary-renderer.js"))
    page.add_script_tag(content=read("labels/vendor/renderer.js"))
    page.add_script_tag(content=read("labels/model-picker.js"))
    page.add_script_tag(content=read("labels/memo-vocab.js"))
    page.add_script_tag(content=read("labels/hover-card.js"))
    page.add_script_tag(content=read("inject.js"))
    page.wait_for_timeout(300)

    # 1) 짧은 선택 → [단어장·메모] 하나
    text = page.evaluate("document.getElementById('p1').textContent")
    i = text.index("라우팅")
    drag(page, "#p1", i, i + 3)
    tb = toolbar(page)
    check("짧은 선택: 툴바에 '단어장·메모'만 (메모 버튼 따로 없음)", "단어장·메모" in tb and "메모" not in tb, tb)
    page.wait_for_timeout(500)
    check("떠 있는 메모 버튼 안 뜸", page.evaluate("getComputedStyle(document.querySelector('#cxm-root .cxm-btn')).display") == "none")

    # 2) 누르면 통합 창
    page.click(".cdx-vocabulary-action")
    page.wait_for_timeout(400)
    check("창 제목 '단어장 · 메모'", page.text_content("#cdx-vocabulary-title") == "단어장 · 메모")
    check("내 메모 입력란 표시", page.is_visible("#cdx-vocabulary .cxm-vmemo textarea"))
    page.wait_for_timeout(500)
    check("AI 뜻 표시", "라우팅의 테스트 뜻" in page.text_content("#cdx-vocabulary .vb-meaning"))
    defs = page.locator("#cdx-vocabulary .vb-definitions li")
    check("이 문맥 뜻 아래 사전적 의미, 지금 문맥 번호 강조", page.is_visible("#cdx-vocabulary .vb-definitions") and defs.count() == 2
          and "이 문맥" in defs.nth(0).inner_text() and "vb-def-here" in (defs.nth(0).get_attribute("class") or "")
          and page.locator("#cdx-vocabulary .vb-pane:not(.vb-library) .vb-label").first.inner_text() == "맥락분석")
    check("작성 화면에는 보관함 목록과 모델 선택이 보이지 않음", not page.is_visible("#cdx-vocabulary .vb-library")
          and page.locator("#cdx-vocabulary .cxm-model select").count() == 0)
    check("단어가 핵심 뜻보다 크고 원문 문맥은 기본 접힘", page.evaluate("""() => {
      const word=document.querySelector('#cdx-vocabulary .vb-pane:not(.vb-library) h3');
      const meaning=document.querySelector('#cdx-vocabulary .vb-meaning');
      return parseFloat(getComputedStyle(word).fontSize)>parseFloat(getComputedStyle(meaning).fontSize)
        && !document.querySelector('#cdx-vocabulary .vb-context').open;
    }"""))
    check("짧은 단어는 메모란에 인용을 다시 보여주지 않음", page.locator("#cdx-vocabulary .cxm-vmemo-quote").count() == 0)
    check("버튼 순서: 저장 두 개 앞, 뜻 편집 등은 보조", page.evaluate("""[...document.querySelectorAll('#cdx-vocabulary .vb-actions button')]
        .filter(b => !b.hidden).sort((a, b) => +getComputedStyle(a).order - +getComputedStyle(b).order).map(b => b.textContent).slice(0, 2).join('|')""") == "단어장에 저장|메모만 저장")
    check("원문과 조작 버튼이 메모 입력란보다 위", page.evaluate("!!(document.querySelector('#cdx-vocabulary .vb-context').compareDocumentPosition(document.querySelector('#cdx-vocabulary .cxm-vmemo')) & Node.DOCUMENT_POSITION_FOLLOWING)"))
    check("메모 비었을 때 저장 버튼 '단어장에 저장'", page.text_content("#cdx-vocabulary .vb-primary") == "단어장에 저장")

    # 3) 메모 입력 → [뜻+메모 저장]
    page.fill("#cdx-vocabulary .cxm-vmemo textarea", "라우팅 메모 테스트")
    check("메모 입력 시 '뜻+메모 저장'", page.text_content("#cdx-vocabulary .vb-primary") == "뜻+메모 저장")
    page.click("#cdx-vocabulary .vb-open-archive")
    check("작성 도중 보관함 이동은 메모를 저장하지 않음", page.evaluate("window.__memoStore.length") == 0)
    page.click("#cdx-vocabulary .vb-back-compose")
    check("보관함에서 돌아오면 입력한 메모 유지", page.input_value("#cdx-vocabulary .cxm-vmemo textarea") == "라우팅 메모 테스트")
    page.click("#cdx-vocabulary .vb-settings")
    page.wait_for_timeout(200)
    settings = page.locator('#cdx-label-settings')
    check("단어장 설정도 공통 설정창의 같은 탭에서 열림", settings.get_by_role('tab', name='단어장·메모', exact=True).get_attribute('aria-selected') == 'true')
    model_selects = settings.locator('.cxm-settings-model select')
    check("모델과 추론 강도는 설정에만 있고 현재 값 표시", model_selects.count() == 2
          and model_selects.nth(0).input_value() == 'gpt-6-luna' and model_selects.nth(1).input_value() == 'high')
    fast = settings.locator('#cxm-settings-fast')
    check("FAST 기본 켜짐", fast.is_checked() and not fast.is_disabled())
    fast.uncheck(); page.wait_for_timeout(100)
    check("FAST 끄기 저장", page.evaluate("window.__model.fast") is False and not fast.is_checked())
    fast.check(); page.wait_for_timeout(100)
    check("FAST 다시 켜기 저장", page.evaluate("window.__model.fast") is True)
    guide = settings.locator('#cxm-settings-guide-text')
    guide_save = settings.get_by_role('button', name='지침 저장', exact=True)
    check("작성 지침 표시, 바꾸기 전에는 저장 비활성", guide.input_value() == '기본 지침' and guide_save.is_disabled())
    guide.fill('예문은 영어로 쓰세요.')
    guide_save.click(); page.wait_for_timeout(100)
    check("작성 지침 저장", page.evaluate("window.__guide.guide") == '예문은 영어로 쓰세요.' and guide_save.is_disabled()
          and '저장했습니다' in settings.inner_text())
    settings.get_by_role('button', name='기본 지침으로 복원', exact=True).click(); page.wait_for_timeout(100)
    check("기본 지침으로 복원", guide.input_value() == '기본 지침' and page.evaluate("window.__guide.custom") is False)
    settings.get_by_role('tab', name='라벨', exact=True).click()
    settings.locator('input[name=name]').fill('임시 요청')
    settings.get_by_role('tab', name='단어장·메모', exact=True).click()
    check("모델 설정으로 이동해도 라벨 초안 자동 저장 안 함", page.evaluate("window.__labelSaves || 0") == 0)
    settings.get_by_role('tab', name='라벨', exact=True).click()
    check("탭을 오가도 라벨 편집 내용 유지", settings.locator('input[name=name]').input_value() == '임시 요청')
    settings.locator('input[name=name]').fill('요청')
    settings.get_by_role('tab', name='단어장·메모', exact=True).click()
    model_selects.nth(0).select_option('test-model')
    page.wait_for_timeout(120)
    check("모델 변경 시 지원하는 추론 강도로 조정", page.evaluate("window.__model") == {'model':'test-model','effort':'medium','fast':True}
          and model_selects.nth(1).locator('option').evaluate_all('(options)=>options.map(o=>o.value)') == ['low','medium'])
    check("FAST 미지원 모델이면 FAST 비활성", fast.is_disabled() and '지원하지 않습니다' in settings.inner_text())
    model_selects.nth(1).select_option('low')
    page.wait_for_timeout(100)
    check("추론 강도 변경 저장", page.evaluate("window.__model.effort") == 'low')
    if len(sys.argv) > 1: page.screenshot(path=str(Path(sys.argv[1]).with_name('settings-model.png')))
    page.evaluate('window.__failModel=true')
    model_selects.nth(0).select_option('gpt-6-luna')
    page.wait_for_timeout(120)
    check("모델 저장 실패 시 기존 선택 복구와 오류 표시", model_selects.nth(0).input_value() == 'test-model'
          and model_selects.nth(1).input_value() == 'low' and '모델 저장 실패 테스트' in settings.inner_text())
    page.evaluate('window.__failModel=false')
    page.keyboard.press('Escape')
    check("설정을 닫아도 작성 중인 메모 유지", settings.count() == 0
          and page.input_value("#cdx-vocabulary .cxm-vmemo textarea") == "라우팅 메모 테스트")
    if len(sys.argv) > 1: page.screenshot(path=str(Path(sys.argv[1]).with_name('compose.png')))
    page.click("#cdx-vocabulary .vb-primary")
    page.wait_for_timeout(400)
    store = page.evaluate("JSON.parse(JSON.stringify(window.__memoStore))")
    check("단어 1개 저장", page.evaluate("window.__lastDraftSaved") is not None)
    check("메모 1개 저장 (위치·대화 포함)", len(store) == 1 and store[0]["exact"] == "라우팅" and store[0]["conv"] == "test-thread"
          and store[0]["note"] == "라우팅 메모 테스트", json.dumps(store, ensure_ascii=False)[:200])
    check("탭 개수 '전체 2 · 단어 1 · 메모 1'", page.evaluate("[...document.querySelectorAll('#cdx-vocabulary .cxm-tabs button')].map(b => b.textContent).join(' ')") == "전체2 단어1 메모1")
    check("목록에 메모 카드", page.locator("#cdx-vocabulary .cxm-memo-card").count() == 1)

    # 4) 별도 보관함에서 종류 필터 / 검색
    page.click("#cdx-vocabulary .vb-open-archive")
    check("보관함은 작성 화면과 분리", page.get_attribute("#cdx-vocabulary", "data-view") == 'archive'
          and not page.is_visible("#cdx-vocabulary .vb-pane:not(.vb-library)"))
    # 보관함과 설정은 한 창처럼 탭으로 오간다
    tabs = page.locator("#cdx-vocabulary .vb-tabs [role=tab]")
    check("보관함 위에 보관함·설정 탭 줄(설정 버튼 대신)", page.is_visible("#cdx-vocabulary .vb-tabs") and tabs.all_inner_texts() == ["보관함", "라벨", "단어장·메모", "자동 판단"]
          and tabs.first.get_attribute("aria-selected") == "true" and not page.is_visible("#cdx-vocabulary .vb-settings"))
    tabs.filter(has_text="자동 판단").click()
    page.wait_for_timeout(200)
    settings = page.locator('#cdx-label-settings')
    check("설정 탭을 누르면 그 탭으로 설정 열림", settings.count() == 1
          and settings.get_by_role('tab', name='자동 판단', exact=True).get_attribute('aria-selected') == 'true')
    settings.get_by_role('tab', name='보관함', exact=True).click()
    page.wait_for_timeout(200)
    check("설정의 보관함 탭으로 돌아오면 작성 중인 메모 유지", settings.count() == 0 and page.get_attribute("#cdx-vocabulary", "data-view") == 'archive'
          and page.is_visible("#cdx-vocabulary .vb-library"))
    page.click("#cdx-vocabulary .vb-back-compose")
    check("작성 화면에서는 탭 줄 대신 설정 버튼", not page.is_visible("#cdx-vocabulary .vb-tabs") and page.is_visible("#cdx-vocabulary .vb-settings"),
          (page.get_attribute("#cdx-vocabulary", "data-view"), page.is_visible("#cdx-vocabulary .vb-tabs"), page.is_visible("#cdx-vocabulary .vb-settings")))
    page.click("#cdx-vocabulary .vb-open-archive")
    page.click("#cdx-vocabulary .cxm-tabs button[data-kind=memo]")
    check("메모 탭에서 즐겨찾기·학습 상태 필터 숨김", not page.is_visible("#cdx-vocabulary .vb-filters"))
    check("필터 '메모': 메모 카드만", page.locator("#cdx-vocabulary .vb-card").count() == 1 and page.locator("#cdx-vocabulary .cxm-memo-card").count() == 1)
    page.click("#cdx-vocabulary .cxm-tabs button[data-kind=word]")
    check("필터 '단어': 메모 카드 없음", page.locator("#cdx-vocabulary .cxm-memo-card").count() == 0 and page.locator("#cdx-vocabulary .vb-card").count() == 1)
    page.click("#cdx-vocabulary .cxm-tabs button[data-kind=all]")
    page.fill("#cdx-vocabulary .vb-search", "메모 테스트")
    check("검색 '메모 테스트': 메모 카드 검색됨", page.locator("#cdx-vocabulary .cxm-memo-card").count() == 1)
    page.fill("#cdx-vocabulary .vb-search", "")

    # 5) 메모 카드 수정
    page.click("#cdx-vocabulary .cxm-memo-card button:text('수정')")
    page.fill("#cdx-vocabulary .cxm-memo-card textarea", "수정된 메모")
    page.click("#cdx-vocabulary .cxm-memo-card button:text('저장')")
    page.wait_for_timeout(200)
    check("메모 카드 수정 반영", page.evaluate("window.__memoStore[0].note") == "수정된 메모")

    # 6) 메모만 저장 (단어장 저장 없이)
    page.click("#cdx-vocabulary .vb-close")
    page.wait_for_timeout(200)
    j = text.index("서버")
    drag(page, "#p1", j, j + 2)
    page.click(".cdx-vocabulary-action")
    page.wait_for_timeout(400)
    page.fill("#cdx-vocabulary .cxm-vmemo textarea", "서버 메모만")
    page.remove_listener("dialog", accept_discard)
    page.once("dialog", lambda dialog: dialog.dismiss())
    page.click("#cdx-vocabulary .vb-close")
    check("편집하지 않은 신규 초안도 닫기 취소 시 유지", page.locator("#cdx-vocabulary").count() == 1)
    page.on("dialog", accept_discard)
    draft_id = page.evaluate("window.__lastDraft.id")
    calls_before_archive = page.evaluate("window.__summarizeCalls")
    page.click("#cdx-vocabulary .vb-open-archive")
    page.get_by_role("button", name="라우팅 뜻 열기", exact=True).click()
    check("작성 초안을 둔 채 저장된 단어 열람 가능", page.text_content("#cdx-vocabulary .vb-meaning .vb-paragraph-text") == "라우팅의 테스트 뜻")
    check("보관된 초안을 덮어쓸 AI 요청 차단", page.get_by_role("button", name="다시 분석", exact=True).is_disabled()
          and page.get_by_role("button", name="새 의미 추가", exact=True).is_disabled()
          and page.get_by_role("textbox", name="저장된 단어에 추가 질문", exact=True).is_disabled())
    page.click("#cdx-vocabulary .vb-back-compose")
    check("작성으로 돌아오면 초안과 메모 복원", page.evaluate("window.__lastDraft.id") == draft_id
          and page.evaluate("window.__summarizeCalls") == calls_before_archive
          and page.text_content("#cdx-vocabulary .vb-meaning .vb-paragraph-text") == "서버의 테스트 뜻"
          and page.input_value("#cdx-vocabulary .cxm-vmemo textarea") == "서버 메모만")
    page.click("#cdx-vocabulary button:text('메모만 저장')")   # (Ctrl+Enter 는 아래 따로 확인)
    page.wait_for_timeout(300)
    check("메모만 저장 → 메모 2개", page.evaluate("window.__memoStore.length") == 2)
    page.click("#cdx-vocabulary .vb-close")
    page.wait_for_timeout(700)
    check("본문 형광펜 2곳", page.evaluate("CSS.highlights.get('codex-memo')?.size") == 2)

    # 7-1) 저장된 단어(밑줄)·메모(형광펜)에 마우스를 올리면 카드
    box = page.evaluate("""(() => { const n = document.getElementById('p1').firstChild; const i = n.data.indexOf('라우팅');
      const r = new Range(); r.setStart(n, i); r.setEnd(n, i + 3); const b = r.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()""")
    page.mouse.move(box[0], box[1])
    page.wait_for_timeout(600)
    hover = page.text_content(".cxm-hover") if page.locator(".cxm-hover.cxm-on").count() else ""
    check("마우스 올림: 단어 뜻과 메모가 함께", "라우팅의 테스트 뜻" in hover and "수정된 메모" in hover, hover[:80])
    page.mouse.move(5, 790)
    page.wait_for_timeout(200)
    check("벗어나면 카드 숨김", page.locator(".cxm-hover.cxm-on").count() == 0)
    # 클릭해서 자세히 보기 카드가 열리면, 마우스를 계속 올려 두어도 미리보기 카드가 겹쳐 뜨지 않음
    page.mouse.move(box[0], box[1])
    page.wait_for_timeout(600)
    page.mouse.click(box[0], box[1])
    page.wait_for_timeout(200)
    page.mouse.move(box[0] + 2, box[1])
    page.wait_for_timeout(600)
    check("자세히 보기가 열리면 미리보기 카드는 닫힘", page.locator("#cdx-vocabulary-inline").count() == 1
          and page.locator(".cxm-hover.cxm-on").count() == 0)
    page.keyboard.press("Escape")
    page.mouse.move(5, 790)
    page.wait_for_timeout(200)
    page.mouse.move(box[0], box[1])
    page.wait_for_timeout(600)
    check("자세히 보기를 닫으면 미리보기 카드 다시 뜸", page.locator("#cdx-vocabulary-inline").count() == 0
          and page.locator(".cxm-hover.cxm-on").count() == 1)
    page.mouse.move(5, 790)
    page.wait_for_timeout(200)
    j2 = text.index("서버")
    box = page.evaluate(f"""(() => {{ const n = document.getElementById('p1').firstChild; const r = new Range(); r.setStart(n, {j2}); r.setEnd(n, {j2 + 2});
      const b = r.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }})()""")
    page.mouse.move(box[0], box[1])
    page.wait_for_timeout(600)
    hover = page.text_content(".cxm-hover") if page.locator(".cxm-hover.cxm-on").count() else ""
    check("메모만 있는 글: 메모만 보여줌", "서버 메모만" in hover and "단어장" not in hover.replace("클릭하면", ""), hover[:80])
    page.mouse.move(5, 790)

    # 7) 긴 선택 → [메모] 버튼 (단어장은 160자 제한)
    drag(page, "#p2", 0, 185)
    tb = toolbar(page)
    check("긴 선택: 툴바에 '메모'", "메모" in tb and not any("단어장" in t for t in tb), tb)

    # 8) 목록에서 열기(선택 없이) → 메모 입력란 숨김
    page.evaluate("getSelection().removeAllRanges(); window.dispatchEvent(new Event('codex-labels:open-vocabulary'))")
    page.wait_for_timeout(300)
    check("목록에서 연 창: 메모 입력란 숨김", not page.is_visible("#cdx-vocabulary .cxm-vmemo"))
    check("메모 카드 2개", page.locator("#cdx-vocabulary .cxm-memo-card").count() == 2)
    if len(sys.argv) > 1: page.screenshot(path=sys.argv[1])
    check("메모 카드에 복사 버튼", page.locator("#cdx-vocabulary .cxm-memo-card button:text('복사')").count() == 2)
    page.evaluate("window.__cxmOpenLibrary('word')")
    check("열린 창에서 필터만 '단어'로", page.get_attribute("#cdx-vocabulary .cxm-tabs button[aria-selected=true]", "data-kind") == "word"
          and page.locator("#cdx-vocabulary .cxm-memo-card").count() == 0)
    page.click("#cdx-vocabulary .vb-close")
    page.wait_for_timeout(200)
    page.evaluate("window.__cxmOpenLibrary('memo')")   # 트레이·Ctrl+Alt+M 이 부르는 것
    page.wait_for_timeout(400)
    check("메모 필터로 열기", page.is_visible("#cdx-vocabulary") and page.get_attribute("#cdx-vocabulary .cxm-tabs button[aria-selected=true]", "data-kind") == "memo"
          and page.locator("#cdx-vocabulary .cxm-memo-card").count() == 2
          and page.locator("#cdx-vocabulary .vb-card:not(.cxm-memo-card)").count() == 0)
    page.click("#cdx-vocabulary .cxm-memo-card button:text('삭제')")
    page.click("#cdx-vocabulary .cxm-memo-card button:text('삭제 확인')")
    page.wait_for_timeout(200)
    check("메모 삭제 (두 번 눌러)", page.evaluate("window.__memoStore.length") == 1)

    # 9) 'Your dot' 처럼 Codex 툴바가 없는 화면: 떠 있는 버튼이 대신한다
    page.evaluate("window.__noToolbar = true")
    k = text.index("설정")
    drag(page, "#p1", k, k + 2)
    page.wait_for_timeout(600)
    btn = "#cxm-root .cxm-btn"
    check("툴바 없음 + 짧은 선택: 떠 있는 '단어장·메모'", page.is_visible(btn) and "단어장·메모" in page.text_content(btn))
    page.click(btn)
    page.wait_for_timeout(500)
    check("→ 단어장·메모 창 + 내 메모 입력란", page.is_visible("#cdx-vocabulary") and page.is_visible("#cdx-vocabulary .cxm-vmemo textarea")
          and page.text_content("#cdx-vocabulary .vb-pane:not(.vb-library) h3") == "설정")
    check("→ 떠 있는 버튼 숨김", not page.is_visible(btn))
    page.click("#cdx-vocabulary .vb-close")
    page.wait_for_timeout(200)
    drag(page, "#p2", 0, 185)
    page.wait_for_timeout(600)
    check("툴바 없음 + 긴 선택: 떠 있는 '메모'", page.is_visible(btn) and page.text_content(btn) == "📝 메모")
    page.click(btn)
    page.wait_for_timeout(300)
    check("→ 메모 창", page.is_visible("#cxm-root .cxm-pop"))

    # 10) 같은 단어 · 여러 뜻: 저장된 뜻과 비교해 이 문맥에 맞는 뜻을 고르거나 새 의미로
    def open_word(pid, word):
        t = page.evaluate(f"document.getElementById('{pid}').textContent")
        i = t.index(word)
        drag(page, f"#{pid}", i, i + len(word))
        page.wait_for_timeout(600)
        page.click(".cdx-vocabulary-action")
        page.wait_for_timeout(700)

    calls = page.evaluate("window.__summarizeCalls")
    open_word("p1", "라우팅")
    check("등록된 단어 드래그: 맥락분석 화면", page.text_content("#cdx-vocabulary-title") == "맥락분석"
          and not page.is_visible("#cdx-vocabulary .cxm-vmemo")
          and page.evaluate("window.__summarizeCalls") == calls)
    page.click("#cdx-vocabulary .vb-close"); page.wait_for_timeout(200)
    open_word("p3", "라우팅")
    check("다른 문장의 분석을 별도 입력란에 표시", page.get_by_label("새 문장 맥락분석", exact=True).input_value() == "라우터 표의 경로를 가리킴 (GPT)")
    page.click("#cdx-vocabulary button:text-is('맥락분석 저장')"); page.wait_for_timeout(250)
    check("같은 단어에 다른 문장의 분석 추가 저장", page.evaluate("vocab.entries[0].contextAnalyses.length") == 1
          and page.evaluate("vocab.entries[0].meaning") == "라우팅의 테스트 뜻")
    page.click("#cdx-vocabulary .vb-close"); page.wait_for_timeout(200)
    # 여러 뜻의 미리보기 정렬을 위한 독립된 두 번째 뜻 fixture
    page.evaluate("""() => {vocab.entries.push({...vocab.entries[0],id:'00000000-0000-4000-8000-000000000099',meaning:'라우팅의 새 뜻',context:document.querySelector('#p4').textContent,contextAnalyses:[]});rev++;window.__vocabListeners.forEach(f=>f());}""")
    page.wait_for_timeout(600)
    k4 = page.evaluate("document.getElementById('p4').textContent").index("라우팅")
    box = page.evaluate(f"""(() => {{ const n = document.getElementById('p4').firstChild; const r = new Range(); r.setStart(n, {k4}); r.setEnd(n, {k4 + 3});
      const b = r.getBoundingClientRect(); return [b.left + 4, b.top + b.height / 2]; }})()""")
    page.mouse.move(box[0], box[1] + 30); page.mouse.move(box[0], box[1], steps=3)
    page.wait_for_timeout(700)
    first = page.evaluate("document.querySelector('.cxm-hover.cxm-on .cxm-h-item .cxm-h-text')?.textContent || ''")
    check("마우스 올림: 지금 문단에 가까운 뜻이 맨 위", first == "라우팅의 새 뜻"
          and "이 문맥에 가까운 뜻" in page.text_content(".cxm-hover"), first)
    page.mouse.move(5, 790)

    # 11) 여러 뜻은 저장 대상을 명시적으로 선택한다. 드래그 경로에서 Mica 자동 판단은 호출하지 않는다.
    page.evaluate("window.__micaOn = true")
    open_word("p5", "라우팅")
    check("여러 뜻은 맥락분석 저장 대상을 선택", page.get_by_label("맥락분석을 저장할 뜻").input_value() == ""
          and page.get_by_role("button",name="맥락분석 받기",exact=True).is_disabled())
    page.click("#cdx-vocabulary .vb-close"); page.wait_for_timeout(900)

    page.mouse.move(box[0], box[1] + 30); page.mouse.move(box[0], box[1], steps=3)   # p4 의 '라우팅'
    page.wait_for_timeout(800)
    first = page.evaluate("document.querySelector('.cxm-hover.cxm-on .cxm-h-item .cxm-h-text')?.textContent || ''")
    check("마우스 카드: Mica 순서를 글자 비슷함보다 먼저 씀", first == "라우팅의 테스트 뜻", first)
    page.mouse.move(5, 790)

    # 12) 메모 분류 필터·수동 변경·기존 미분류 일괄 분류
    page.evaluate("""(() => {
      const categories = ['todo', 'idea', 'question', 'reference', undefined, ''];
      window.__memoStore.splice(0, window.__memoStore.length, ...categories.map((category, i) => ({
        id: 'category-' + i, created: '2026-10-02 12:00', title: '분류 대화', quote: '테스트 인용',
        note: i === 5 ? '애매한 메모' : '분류 메모 ' + i, ...(category === undefined ? {} : {category})
      })));
      window.__codexMemo.setMemos(JSON.parse(JSON.stringify(window.__memoStore)));
      window.__cxmOpenLibrary('memo');
    })()""")
    page.wait_for_timeout(200)
    filters = "#cdx-vocabulary .cxm-category-filters"
    check("메모 탭에 분류 칩 6개", page.is_visible(filters) and page.locator(filters + " button").count() == 6)
    check("분류기 꺼짐: 일괄 분류 버튼 숨김", not page.is_visible("#cdx-vocabulary .cxm-classify"))
    for category, label in [('todo', '할 일'), ('idea', '아이디어'), ('question', '질문'), ('reference', '참고'), ('', '미분류')]:
        page.locator(filters + f' button[data-category="{category}"]').click()
        count = 2 if category == '' else 1
        check(f"분류 필터 {label}", page.locator("#cdx-vocabulary .cxm-memo-card").count() == count)
    page.fill("#cdx-vocabulary .vb-search", "애매")
    check("분류와 검색을 함께 적용", page.locator("#cdx-vocabulary .cxm-memo-card").count() == 1
          and "애매" in page.text_content("#cdx-vocabulary .cxm-memo-note"))
    page.fill("#cdx-vocabulary .vb-search", "")
    page.locator(filters + ' button[data-category="all"]').click()
    page.locator("#cdx-vocabulary .cxm-category-chip").last.click()
    page.locator('#cdx-vocabulary .cxm-category-menu:visible button[data-category="idea"]').click()
    page.wait_for_timeout(100)
    check("분류 칩 메뉴 수동 변경 저장 (내용 보존)", page.evaluate("window.__memoStore[0].category") == 'idea'
          and page.evaluate("window.__memoStore[0].note") == '분류 메모 0')
    page.locator("#cdx-vocabulary .cxm-category-chip").last.click()
    page.locator('#cdx-vocabulary .cxm-category-menu:visible button[data-category=""]').click()
    page.wait_for_timeout(100)
    check("수동으로 미분류 선택 가능", page.evaluate("window.__memoStore[0].category") == '')
    page.locator("#cdx-vocabulary .cxm-category-chip").last.click()
    page.wait_for_timeout(150)
    idea = page.locator('#cdx-vocabulary .cxm-category-menu:visible button[data-category="idea"]')
    check("직접 고를 때 분류마다 확신 % 표시", idea.text_content() == "아이디어71%"
          and page.locator('#cdx-vocabulary .cxm-category-menu:visible button[data-category="todo"] small').text_content() == "12%"
          and "cxm-top" in (idea.get_attribute("class") or ""), idea.text_content())
    page.locator("#cdx-vocabulary .cxm-category-chip").last.click()

    # 자동 판단 설정: 기준 확신 슬라이더·다시 판단
    page.evaluate("window.dispatchEvent(new CustomEvent('codex-labels:open-settings',{detail:{tab:'automation'}}))")
    page.wait_for_timeout(150)
    rows = page.locator("#cdx-label-settings .cxm-auto-row")
    check("자동 판단 설정: 슬라이더 4개와 현재 기준 %", rows.count() == 4
          and rows.nth(1).locator("output").text_content() == "90%"
          and "JEV" in page.text_content("#cdx-label-settings .cxm-settings-auto"))
    page.evaluate("""() => { const i = document.querySelectorAll('#cdx-label-settings .cxm-auto-row input')[0];
      i.value = '65'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); }""")
    page.wait_for_timeout(150)
    check("슬라이더를 놓으면 기준 저장 + 화면에 다시 거르기 알림", page.evaluate("window.__thresholdCalls") == [{"label": 0.65}]
          and rows.nth(0).locator("output").text_content() == "65%" and page.evaluate("window.__refreshEvents") == 1)
    page.click("#cdx-label-settings .cxm-auto-actions button:has-text('다시 판단')")
    page.wait_for_timeout(150)
    check("'다시 판단' → 기억한 판단 버리고 다시 묻기", page.evaluate("window.__autoRefreshed") == 1 and page.evaluate("window.__refreshEvents") == 2)
    page.click("#cdx-label-settings .cxm-auto-actions button:has-text('기본값')")
    page.wait_for_timeout(150)
    check("기본값 버튼", rows.nth(0).locator("output").text_content() == "60%")
    if len(sys.argv) > 1: page.screenshot(path=str(Path(sys.argv[1]).with_name('settings-automation.png')))
    page.evaluate("window.__failThreshold=true; const i=document.querySelector('#cdx-label-settings .cxm-auto-row input'); i.value='91'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change'))")
    page.wait_for_timeout(150)
    check("기준 저장 실패 시 값 복구와 오류 표시", rows.nth(0).locator('input').input_value() == '60'
          and '기준 저장 실패 테스트' in page.text_content('#cdx-label-settings') and page.evaluate('window.__thresholds.label') == 0.6)
    page.evaluate('window.__failThreshold=false')
    page.keyboard.press('Escape')
    page.locator(filters + ' button[data-category="todo"]').click()
    check("분류에 맞는 메모가 없으면 빈 결과 안내", page.locator("#cdx-vocabulary .cxm-memo-card").count() == 0
          and page.text_content("#cdx-vocabulary .vb-empty") == '일치하는 메모가 없습니다.')
    page.locator(filters + ' button[data-category="all"]').click()
    page.click("#cdx-vocabulary .cxm-tabs button[data-kind=word]")
    check("단어 탭에서는 분류 필터 숨김", not page.is_visible(filters))
    page.click("#cdx-vocabulary .cxm-tabs button[data-kind=memo]")
    page.evaluate("window.__classifierOn = true; window.__classifierProbe()")
    page.wait_for_timeout(100)
    check("나중에 분류기를 켜면 버튼 표시", page.text_content("#cdx-vocabulary .cxm-classify") == '미분류 3개 분류하기'
          and page.is_visible("#cdx-vocabulary .cxm-classify"))
    page.locator("#cdx-vocabulary .cxm-memo-card button:text('수정')").last.click()
    page.locator("#cdx-vocabulary .cxm-memo-card textarea").fill("저장 전 작성 중인 글")
    page.evaluate("window.__codexMemo.setMemos(JSON.parse(JSON.stringify(window.__memoStore)))")
    check("백그라운드 갱신은 편집 포커스를 보존", page.evaluate("document.activeElement.matches('.cxm-memo-card textarea')")
          and page.input_value("#cdx-vocabulary .cxm-memo-card textarea") == '저장 전 작성 중인 글')
    page.click("#cdx-vocabulary .cxm-classify")
    page.wait_for_timeout(300)
    check("일괄 분류는 미분류만 요청", sorted(page.evaluate("window.__classifyCalls")) == ['category-0', 'category-4', 'category-5'])
    check("기존 메모 분류 결과 반영, 낮은 확신은 미분류", page.evaluate("window.__memoStore[4].category") == 'reference'
          and page.evaluate("window.__memoStore[5].category") == '')
    check("분류 갱신 중 미저장 편집 내용 보존", page.input_value("#cdx-vocabulary .cxm-memo-card textarea") == '저장 전 작성 중인 글')
    check("일괄 분류 후 남은 개수 갱신", page.text_content("#cdx-vocabulary .cxm-classify") == '미분류 1개 분류하기')
    page.evaluate("window.__classifierOn = false; window.__classifierProbe()")
    page.wait_for_timeout(100)
    check("분류기가 꺼지면 버튼 다시 숨김", not page.is_visible("#cdx-vocabulary .cxm-classify"))
    styles = page.evaluate("document.adoptedStyleSheets.length")
    page.add_script_tag(content=read("labels/memo-vocab.js"))
    check("같은 버전 재주입 시 중복 설치 없음", page.evaluate("document.adoptedStyleSheets.length") == styles)
    page.remove_listener("dialog", accept_discard)
    result = page.evaluate("window.__cxmVocabHooks.destroy()")
    check("미저장 편집의 폐기를 취소하면 화면과 기능 보존", result is False
          and page.locator('#cdx-vocabulary').count() == 1
          and page.evaluate('document.adoptedStyleSheets.length') == styles
          and page.input_value('#cdx-vocabulary .cxm-memo-card textarea') == '저장 전 작성 중인 글')
    page.once('dialog', lambda dialog: dialog.accept())
    page.evaluate("window.__cxmVocabHooks.destroy()")
    check("destroy가 창과 스타일 정리", not page.locator("#cdx-vocabulary").count()
          and page.evaluate("document.adoptedStyleSheets.length") == styles - 1)

    check("페이지 오류 없음", not errors, errors[:3])
    b.close()
print("\n결과:", "모두 통과" if ok else "실패 있음")
sys.exit(0 if ok else 1)
