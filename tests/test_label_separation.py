"""진행 상태 / 카테고리 분리 UI. 합성 목록과 가짜 API만 사용한다.

실행: python tests/test_label_separation.py [--screenshot]
"""
import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
U = lambda n: f"00000000-0000-4000-8000-{n:012d}"
K = lambda n: f"thread:local:local:local:{U(n)}"
ROW = "[data-app-action-sidebar-thread-row]"
LABELS = [
    {"id": "requested", "name": "요청", "backgroundColor": "#CBD5E1"},
    {"id": "in_progress", "name": "진행", "backgroundColor": "#FCD34D"},
    {"id": "completed", "name": "완료", "backgroundColor": "#86EFAC"},
    {"id": "custom_wait", "name": "회신 대기", "kind": "status", "backgroundColor": "#C4B5FD"},
    {"id": "dev", "name": "개발", "backgroundColor": "#FCA5A5"},
    {"id": "knowhow", "name": "노하우", "kind": "category", "backgroundColor": "#7DD3FC"},
    {"id": "hidden_topic", "name": "숨긴 주제", "kind": "category", "enabled": False, "backgroundColor": "#DDDDDD"},
]
for i, label in enumerate(LABELS):
    label.update({"textColor": "#111111", "description": "검사용 설명", "order": i * 10})
    label.setdefault("enabled", True)
SNAPSHOT = {
    "snapshotVersion": "1", "configRevision": "config-1",
    "config": {"labels": LABELS, "appearance": {
        "fontSizePx": 11, "borderRadiusPx": 5, "verticalPaddingPx": 1,
        "horizontalPaddingPx": 3, "gapPx": 2,
    }},
    "assignments": {K(1): "in_progress", K(2): "requested", K(6): "requested"},
    "categoryAssignments": {K(1): "dev", K(5): "hidden_topic"},
}
HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
body {margin:18px; color:#ddd; background:#181a1d; font:14px 'Segoe UI',sans-serif}
aside {width:350px} [data-app-action-sidebar-thread-row] {display:flex; align-items:center; height:30px; cursor:pointer}
[data-marquee-text] {min-width:0; overflow:hidden; white-space:nowrap}
.native-preview-row[data-app-action-sidebar-thread-row] {height:auto; min-height:30px; flex-direction:column; align-items:stretch; padding:8px 0}
.native-title-lane {display:flex; align-items:center; min-height:20px}
.native-preview {height:32px; color:#aaa; font-size:12px}
</style></head><body><aside>""" + "".join(
    f'<div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:{U(n)}" '
    f'data-app-action-sidebar-thread-kind="local" data-app-action-sidebar-thread-title="검증 대화 {n}" '
    f'onclick="window.__navigated = {n}"><span data-marquee-text><span class="native-title">검증 대화 {n}</span></span></div>'
    for n in range(1, 6)
) + (
    f'<div class="native-preview-row" data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:{U(6)}" '
    'data-app-action-sidebar-thread-kind="local" data-app-action-sidebar-thread-title="검증 대화 6" onclick="window.__navigated=6">'
    '<div class="native-title-lane"><span data-marquee-text><span class="native-title">검증 대화 6</span></span></div>'
    '<div class="native-preview">네이티브 두 줄 미리보기</div></div>'
) + '</aside></body></html>'
MOCKS = "window.__snapshot = " + json.dumps(SNAPSHOT, ensure_ascii=False) + ";" + """
window.__assigned = []; window.__calls = []; window.__listeners = []; window.__navigated = null;
window.__hold = false; window.__pending = []; window.__saved = null;
const copy = value => JSON.parse(JSON.stringify(value));
window.__changed = () => {
  window.__snapshot.snapshotVersion = String(Number(window.__snapshot.snapshotVersion) + 1);
  window.__listeners.forEach(fn => fn());
};
window.codexLabels = {
  read: async known => known === window.__snapshot.snapshotVersion ? null : copy(window.__snapshot),
  onChanged: callback => { window.__listeners.push(callback); return () => {}; },
  assign: async (key,id,kind) => {
    window.__assigned.push([key,id,kind]);
    const map = kind === 'category' ? (window.__snapshot.categoryAssignments ||= {}) : window.__snapshot.assignments;
    if (id === null) delete map[key]; else map[key] = id;
    window.__changed(); return copy(window.__snapshot);
  },
  saveConfig: async config => {
    window.__saved = copy(config); window.__snapshot.config = copy(config);
    window.__snapshot.configRevision += '-saved'; window.__changed(); return copy(window.__snapshot);
  },
  labelSuggest: async ids => {
    window.__calls.push(ids);
    const response = Object.fromEntries(ids.map(id => [id, {
      labelId: 'knowhow', confidence: id.endsWith('003') ? 0.4 : 0.96, confident: !id.endsWith('003')
    }]));
    if (window.__hold) return new Promise(resolve => window.__pending.push(() => resolve(response)));
    return response;
  },
  labelScores: async () => ({dev:0.18,knowhow:0.8,in_progress:0.99,custom_wait:0.99}),
  threadStatus: async ids => Object.fromEntries(ids.map(id => [id, {state:'ask',confidence:0.97}])),
};
"""


def check(name, condition):
    assert condition, name
    print("✔ " + name)


def row(page, n):
    return page.locator(f'{ROW}[data-app-action-sidebar-thread-title="검증 대화 {n}"]')


def badge(page, n, kind):
    return row(page, n).locator(f'.cdx-label[data-kind="{kind}"]')


def open_page(browser, errors, legacy=False, pending=False):
    page = browser.new_page(viewport={"width": 1050, "height": 850})
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("https://codex.test/", lambda route: route.fulfill(content_type="text/html; charset=utf-8", body=HTML))
    page.goto("https://codex.test/")
    page.evaluate("window.__nativeHeightBefore = document.querySelector('.native-preview-row').getBoundingClientRect().height")
    page.add_script_tag(content=MOCKS)
    if pending:
        page.evaluate("""const r=document.querySelector('[data-app-action-sidebar-thread-row]');
          r.dataset.appActionSidebarThreadId='local:client-new-thread:11111111-1111-4111-8111-111111111111';
          r.__reactFiber$test={memoizedProps:{},return:{memoizedProps:{conversationId:'00000000-0000-4000-8000-000000000001'},return:null}};""")
    if legacy:
        page.evaluate("delete window.__snapshot.categoryAssignments; window.__snapshot.assignments[Object.keys(window.__snapshot.assignments)[0]]='dev'")
    for file in ["labels/common.js", "labels/vendor/renderer.js", "labels/label-suggest.js", "labels/thread-status.js"]:
        page.add_script_tag(content=(ROOT / file).read_text(encoding="utf-8"))
    expect(badge(page, 1, "category")).to_be_visible()
    return page


def choose(page, n, kind, label_id=None):
    badge(page, n, kind).click()
    selector = f'button[data-kind="{kind}"]' + (f'[data-label-id="{label_id}"]' if label_id else '[data-unset]')
    page.locator('#cdx-label-menu ' + selector).click()
    expect(page.locator('#cdx-label-menu')).to_have_count(0)


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    errors = []
    page = open_page(browser, errors)
    expect(badge(page, 1, 'status')).to_have_text('진행')
    expect(badge(page, 1, 'category')).to_have_text('개발')
    check('한 행에 진행 상태와 카테고리가 동시에 표시', row(page, 1).locator('.cdx-label').count() == 2)
    check('원본 제목과 marquee 구조 유지', row(page, 1).locator('[data-marquee-text] .native-title').inner_text() == '검증 대화 1'
          and row(page, 1).locator('[data-marquee-text] .cdx-label').count() == 0)
    row(page, 1).locator('.native-title').click()
    check('제목 클릭은 원래 대화로 이동', page.evaluate('window.__navigated') == 1)
    page.evaluate('window.__navigated = null')
    expect(row(page, 2).locator('.cxm-label-suggest')).to_be_visible(timeout=6000)
    expect(row(page, 2).locator('.cxm-thread-status')).to_be_visible(timeout=6000)
    check('진행 상태만 지정한 행에는 추천 표시', badge(page, 2, 'status').inner_text() == '요청')
    check('이미 수동 분류한 행과 숨긴 카테고리 행은 추천 제외', row(page, 1).locator('.cxm-label-suggest').count() == 0
          and row(page, 5).locator('.cxm-label-suggest').count() == 0
          and all(U(1) not in ids and U(5) not in ids for ids in page.evaluate('window.__calls')))
    check('상태 점, 두 배지, 추천 칩이 겹치지 않음', row(page, 2).evaluate("""row => {
      const boxes = [...row.querySelectorAll('.cdx-label,.cxm-label-suggest,.cxm-thread-status')].map(el => el.getBoundingClientRect());
      return boxes.every((a,i) => boxes.every((b,j) => i===j || a.right<=b.left || b.right<=a.left));
    }"""))
    check('세로 상태는 16×20px, 두 글자를 자르지 않고 30px 행 높이 유지', badge(page, 1, 'status').evaluate("""element => {
      const box=element.getBoundingClientRect(), style=getComputedStyle(element), text=element.firstElementChild;
      return box.width===16 && box.height===20 && style.writingMode==='vertical-rl' && style.textOrientation==='upright'
        && text.scrollHeight<=text.clientHeight && element.closest('[data-app-action-sidebar-thread-row]').getBoundingClientRect().height===30;
    }"""))
    check('20px 제목 줄과 하단 미리보기의 원본 행 높이를 주입 전후 보존', row(page, 6).evaluate("""element => {
      return window.__nativeHeightBefore===68 && element.getBoundingClientRect().height===window.__nativeHeightBefore
        && element.querySelector('.native-title-lane').getBoundingClientRect().height===20
        && getComputedStyle(element.querySelector('[data-kind=status]')).fontSize==='9px';
    }"""))
    check('카테고리는 가로, 두 배지와 제목 간격은 각각 2px', row(page, 1).evaluate("""element => {
      const status=element.querySelector('[data-kind=status]').getBoundingClientRect(), category=element.querySelector('[data-kind=category]');
      const cat=category.getBoundingClientRect(), title=element.querySelector('[data-marquee-text]').getBoundingClientRect(), style=getComputedStyle(category);
      return Math.abs(cat.left-status.right-2)<0.1 && Math.abs(title.left-cat.right-2)<0.1
        && style.writingMode==='horizontal-tb' && style.paddingLeft==='3px' && style.paddingRight==='3px';
    }"""))
    check('미지정 배지는 모두 작은 ＋이고 접근성 이름으로 종류 구분', badge(page, 3, 'status').inner_text() == '＋'
          and badge(page, 3, 'category').inner_text() == '＋'
          and badge(page, 3, 'status').get_attribute('aria-label') == '진행 상태 지정'
          and badge(page, 3, 'category').get_attribute('aria-label') == '카테고리 지정'
          and badge(page, 3, 'category').bounding_box()['width'] == 16)
    check('추천 칩 앞뒤 간격도 2px', row(page, 2).evaluate("""element => {
      const category=element.querySelector('[data-kind=category]').getBoundingClientRect(), chip=element.querySelector('.cxm-label-suggest').getBoundingClientRect();
      const title=element.querySelector('[data-marquee-text]').getBoundingClientRect();
      return Math.abs(chip.left-category.right-2)<0.1 && Math.abs(title.left-chip.right-2)<0.1;
    }"""))
    for width in [320, 350]:
        page.locator('aside').evaluate('(element, width) => element.style.width = width + "px"', width)
        check(f'{width}px 사이드바에서 제목 공간 유지', row(page, 2).locator('[data-marquee-text]').evaluate('element => element.getBoundingClientRect().width') >= 48)
    badge(page, 1, 'category').click()
    check('선택 메뉴를 두 종류로 구분하고 클릭한 종류에 초점', page.locator('#cdx-label-menu [role=group]').count() == 2
          and page.evaluate("document.activeElement.dataset.kind") == 'category')
    expect(page.locator('#cdx-label-menu [data-label-id="dev"] .cxm-label-score')).to_have_text('18%')
    check('자동 확신도는 카테고리에만 표시', page.locator('#cdx-label-menu button[data-kind="status"] .cxm-label-score').count() == 0)
    check('보관함·설정은 메뉴 맨 위 항목 하나', page.evaluate("""[...document.querySelectorAll('#cdx-label-menu > button')].map(b => b.textContent)""") == ['설정…']
          and page.evaluate("document.querySelector('#cdx-label-menu').firstElementChild.classList.contains('cdx-menu-library')"))
    if '--screenshot' in sys.argv:
        index = sys.argv.index('--screenshot')
        target = Path(sys.argv[index + 1]) if len(sys.argv) > index + 1 else Path(tempfile.gettempdir()) / 'codex-memo-label-separation.png'
        target.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(target))
        print('화면:', target)
    page.keyboard.press('Escape')
    choose(page, 1, 'category', 'knowhow')
    expect(badge(page, 1, 'category')).to_have_text('노하우')
    check('카테고리 변경 후 진행 상태 보존', badge(page, 1, 'status').inner_text() == '진행')
    choose(page, 1, 'category')
    expect(badge(page, 1, 'category')).to_have_attribute('data-unset', '')
    check('카테고리 해제 후 진행 상태 보존', badge(page, 1, 'status').inner_text() == '진행')
    choose(page, 1, 'category', 'dev')
    choose(page, 1, 'status', 'completed')
    expect(badge(page, 1, 'status')).to_have_text('완료')
    check('진행 상태 변경 후 카테고리 보존', badge(page, 1, 'category').inner_text() == '개발')
    choose(page, 1, 'status')
    expect(badge(page, 1, 'status')).to_have_attribute('data-unset', '')
    check('진행 상태 해제 후 카테고리 보존', badge(page, 1, 'category').inner_text() == '개발')
    choose(page, 1, 'status', 'custom_wait')
    expect(badge(page, 1, 'status')).to_have_text('회신 대기')
    check('사용자 추가 진행 상태도 상태 자리에 표시', badge(page, 1, 'category').inner_text() == '개발')
    check('긴 사용자 상태도 20px 안에서 자르고 전체 이름은 툴팁에 보존', badge(page, 1, 'status').evaluate("""element => {
      const box=element.getBoundingClientRect(), text=element.firstElementChild;
      return box.width===16 && box.height===20 && text.scrollHeight>text.clientHeight
        && element.title.includes('회신 대기') && element.getAttribute('aria-label').includes('회신 대기')
        && element.closest('[data-app-action-sidebar-thread-row]').getBoundingClientRect().height===30;
    }"""))
    badge(page, 1, 'status').click()
    check('긴 상태 이름은 선택 메뉴에서 그대로 표시', page.locator('#cdx-label-menu [data-label-id="custom_wait"]').inner_text() == '회신 대기')
    page.keyboard.press('Escape')
    check('각 지정과 해제에 올바른 API 종류 전달', page.evaluate('window.__assigned')[:6] == [
        [K(1), 'knowhow', 'category'], [K(1), None, 'category'], [K(1), 'dev', 'category'],
        [K(1), 'completed', 'status'], [K(1), None, 'status'], [K(1), 'custom_wait', 'status']])
    expect(row(page, 2).locator('.cxm-label-suggest')).to_be_visible(timeout=6000)
    row(page, 2).locator('.cxm-label-suggest').click()
    expect(badge(page, 2, 'category')).to_have_text('노하우')
    check('추천 지정은 카테고리만 저장하고 자동 상태 점 보존', page.evaluate('window.__assigned.at(-1)') == [K(2), 'knowhow', 'category']
          and badge(page, 2, 'status').inner_text() == '요청' and row(page, 2).locator('.cxm-thread-status').count() == 1)
    expect(row(page, 3).locator('.cxm-label-suggest')).to_be_visible(timeout=6000)
    before = len(page.evaluate('window.__assigned'))
    row(page, 3).locator('.cxm-label-suggest').click()
    check('낮은 확신 칩은 카테고리 메뉴를 열고 지정하지 않음', page.evaluate('document.activeElement.dataset.kind') == 'category'
          and len(page.evaluate('window.__assigned')) == before)
    check('배지와 추천 클릭은 대화 이동을 유발하지 않음', page.evaluate('window.__navigated') is None)
    page.keyboard.press('Escape')

    page.evaluate("window.dispatchEvent(new Event('codex-labels:open-settings'))")
    expect(page.locator('#cdx-label-settings')).to_be_visible()
    check('설정창도 종류별로 구분', page.locator('.cdx-settings-group').all_text_contents() == ['진행 상태', '카테고리'])
    check('기존 라벨 종류는 읽기 전용', page.locator('select[name=kind]').is_disabled())
    check('설정의 상태 미리보기도 같은 세로 크기', page.locator('.cdx-settings-preview-badge').evaluate("element => getComputedStyle(element).writingMode==='vertical-rl' && element.getBoundingClientRect().height===20"))
    page.get_by_role('button', name='＋ 라벨 추가', exact=True).click()
    expect(page.locator('select[name=kind]')).to_be_enabled()
    check('새 라벨은 카테고리가 기본값', page.locator('select[name=kind]').input_value() == 'category')
    check('카테고리 미리보기는 가로 표시', page.locator('.cdx-settings-preview-badge').evaluate("element => getComputedStyle(element).writingMode==='horizontal-tb'"))
    page.locator('select[name=kind]').select_option('status')
    page.locator('input[name=name]').fill('배포 대기')
    page.get_by_role('button', name='저장', exact=True).click()
    expect(page.locator('#cdx-label-settings')).to_have_count(0)
    check('새 라벨의 선택한 종류를 저장', page.evaluate('window.__saved.labels.at(-1).kind') == 'status')
    check('기존 배지 모양 설정을 그대로 저장', page.evaluate('window.__saved.appearance') == SNAPSHOT['config']['appearance'])
    page.evaluate("window.dispatchEvent(new Event('codex-labels:open-settings'))")
    expect(page.locator('#cdx-label-settings')).to_be_visible()
    page.locator('.cdx-settings-nav button').filter(has_text='배포 대기').click()
    check('저장 후 새 라벨의 종류도 읽기 전용', page.locator('select[name=kind]').is_disabled()
          and page.locator('select[name=kind]').input_value() == 'status')
    page.get_by_role('button', name='취소', exact=True).click()

    expect(row(page, 4).locator('.cxm-label-suggest')).to_be_visible(timeout=6000)
    before = len(page.evaluate('window.__calls'))
    page.evaluate("window.__snapshot.config.labels.find(l=>l.id==='knowhow').name='운영 지식'; window.__snapshot.configRevision+='-rename'; window.__changed()")
    expect(row(page, 4).locator('.cxm-label-suggest')).to_have_text('운영 지식?96%', timeout=6000)
    check('설정 변경 때 추천 캐시를 비우고 다시 계산', len(page.evaluate('window.__calls')) > before)
    page.evaluate("window.__hold=true; window.dispatchEvent(new Event('cxm:auto-refresh'))")
    page.wait_for_function('window.__pending.length > 0')
    page.evaluate("key => { window.__snapshot.categoryAssignments[key]='dev'; window.__changed(); }", K(4))
    expect(badge(page, 4, 'category')).to_have_text('개발')
    page.evaluate("window.__hold=false; window.__pending.splice(0).forEach(resolve=>resolve())")
    expect(row(page, 3).locator('.cxm-label-suggest')).to_be_visible(timeout=6000)
    check('늦은 추천 응답이 수동 카테고리를 덮거나 칩을 복원하지 않음', row(page, 4).locator('.cxm-label-suggest').count() == 0
          and badge(page, 4, 'category').inner_text() == '개발')
    page.close()

    page = open_page(browser, errors, legacy=True)
    expect(badge(page, 1, 'category')).to_have_text('개발')
    expect(badge(page, 1, 'status')).to_have_attribute('data-unset', '')
    expect(row(page, 2).locator('.cxm-label-suggest')).to_be_visible(timeout=6000)
    check('이전 단일 assignments의 분류를 카테고리로 추론', row(page, 1).locator('.cxm-label-suggest').count() == 0
          and badge(page, 2, 'status').inner_text() == '요청')
    page.evaluate("Object.assign(window.__snapshot.config.appearance,{gapPx:4,horizontalPaddingPx:5,verticalPaddingPx:2}); window.__snapshot.configRevision+='-appearance'; window.__changed()")
    expect(badge(page, 1, 'category')).to_have_css('padding-left', '5px')
    check('기존 간격과 카테고리 여백 설정은 계속 작동', badge(page, 1, 'category').evaluate("element => getComputedStyle(element).marginRight==='4px' && getComputedStyle(element).paddingTop==='2px'")
          and badge(page, 2, 'status').evaluate("element => getComputedStyle(element).marginRight==='4px'"))
    page.close()

    page = browser.new_page()
    page.evaluate("() => { window.__messages=[]; window.__codexMemoBridge = text => { const msg=JSON.parse(text); window.__messages.push(msg); window.__cxlBridge.resolve(msg.id,true,{}); }; }")
    pending = open_page(browser, errors, pending=True)
    check('임시 목록 ID에도 실제 대화의 저장된 두 라벨 표시', badge(pending, 1, 'status').inner_text() == '진행'
          and badge(pending, 1, 'category').inner_text() == '개발'
          and badge(pending, 1, 'status').get_attribute('data-key') == K(1))
    choose(pending, 1, 'status', 'requested')
    choose(pending, 1, 'category', 'knowhow')
    check('임시 ID의 선택 메뉴는 실제 대화 ID로 두 종류를 저장', pending.evaluate('window.__assigned') == [
        [K(1), 'requested', 'status'], [K(1), 'knowhow', 'category']])
    # 배지는 다음 프레임에 다시 그려지므로, 지정 결과가 보인 뒤에 목록 ID 를 바꾼다(경쟁 상태 방지)
    expect(badge(pending, 1, 'category')).to_have_text('노하우')
    pending.evaluate("document.querySelector('[data-app-action-sidebar-thread-row]').dataset.appActionSidebarThreadId='local:00000000-0000-4000-8000-000000000001'")
    expect(badge(pending, 1, 'status')).to_have_text('요청')
    expect(badge(pending, 1, 'category')).to_have_text('노하우')
    expect(badge(pending, 1, 'category')).to_have_attribute('data-key', K(1))
    check('목록 ID가 정식 ID로 바뀌어도 배정 유지', badge(pending, 1, 'category').inner_text() == '노하우'
          and badge(pending, 1, 'category').get_attribute('data-key') == K(1))
    pending.close()

    page.add_script_tag(content=(ROOT / 'labels/shim.js').read_text(encoding='utf-8'))
    page.evaluate("async () => { await window.codexLabels.assign('test','dev','category'); await window.codexLabels.assign('test',null,'status'); await window.codexLabels.assign('test','dev'); }")
    check('화면 bridge는 명시한 종류를 전달하고 예전 2인자 계약 보존', page.evaluate('window.__messages.map(msg=>msg.args)') == [
        ['test', 'dev', 'category'], ['test', None, 'status'], ['test', 'dev']])
    check('페이지 JavaScript 오류 없음', not errors)
    browser.close()

print('\n결과: 모두 통과')
