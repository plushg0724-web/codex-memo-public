"""왼쪽 목록 필터·필터 관리 창·수정 모드 (labels/sidebar-filter.js, filter-window.js). 합성 목록, 가짜 라벨 API, 가짜 Codex 대화 메뉴만 사용한다.

실행: python tests/test_sidebar_filter.py
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
U = lambda n: f"local:00000000-0000-4000-8000-{n:012d}"
K = lambda n: f"thread:local:local:{U(n)}"

ROWS = "".join(
    f'<div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="{U(n)}" '
    f'data-app-action-sidebar-thread-kind="local" data-app-action-sidebar-thread-title="대화 {n}" '
    f'class="relative" style="height:28px" onclick="window.__opened.push({n})">대화 {n}</div>'
    for n in range(1, 7))
HTML = f"""<!doctype html><html><head><meta charset="utf-8"></head><body style="font:14px sans-serif">
<div class="sidebar-navigation" style="display:flex;flex-direction:column;width:300px;height:600px">
  <div>Codex</div>
  <div class="scroller" style="overflow-y:auto;flex:1"><div>{ROWS}</div></div>
</div></body></html>"""

MOCKS = r"""
window.__opened = []; window.__moves = []; window.__assignCalls = [];
const labels = [
  {id:'requested', name:'요청', enabled:true, order:0}, {id:'in_progress', name:'진행', enabled:true, order:1},
  {id:'completed', name:'완료', enabled:true, order:2}, {id:'dev', name:'개발', enabled:true, order:3},
  {id:'knowhow', name:'노하우', kind:'category', enabled:true, order:4},
];
const K = n => `thread:local:local:local:00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let snap = { snapshotVersion:'1', config:{labels},
  assignments:{[K(1)]:'in_progress', [K(2)]:'requested', [K(3)]:'in_progress'},
  categoryAssignments:{[K(1)]:'dev', [K(4)]:'knowhow'} };
const listeners = new Set();
window.codexLabels = {
  read: async () => snap,
  onChanged: f => { listeners.add(f); return () => listeners.delete(f); },
  assignMany: async (keys, id, kind) => {
    window.__assignCalls.push({keys, id, kind});
    const field = kind === 'status' ? 'assignments' : 'categoryAssignments';
    const next = {...snap[field]};
    for (const k of keys) { if (id === null) delete next[k]; else next[k] = id; }
    snap = {...snap, [field]: next, snapshotVersion: String(Number(snap.snapshotVersion) + 1)};
    return snap;
  },
};
// 가짜 Codex 대화 메뉴: 줄의 React fiber 위쪽에 getItems 가 있다. 대화 5 는 이미 '회사내규' 프로젝트·'sns' 섹션에 있다.
document.querySelectorAll('[data-app-action-sidebar-thread-row]').forEach(row => {
  const n = Number(row.dataset.appActionSidebarThreadTitle.split(' ')[1]);
  const projects = [['p1','회사내규'], ['p2','쇼핑몰']].filter(([id]) => !(n === 5 && id === 'p1'));
  const getItems = async () => [
    {id:'rename-thread', onSelect(){ window.__moves.push(['rename', n]); }},
    {id:'move-thread-to-project', submenu: projects.map(([id, name]) => ({id:`move-thread-to-project:${id}`, messageValues:{projectName:name},
      onSelect(){ window.__moves.push([id, n]); }}))},
    {id:'move-to-custom-section', submenu:[
      {id:'move-to-custom-section:s1', type:'checkbox', checked: n === 5, messageValues:{name:'sns'}, onSelect(){ window.__moves.push(['s1', n]); }},
      {id:'custom-section-separator', type:'separator'},
      {id:'new-custom-section', onSelect(){ window.__moves.push(['new', n]); }}]},
    ...(n === 5 ? [{id:'remove-thread-from-project', messageValues:{projectName:'회사내규'}, onSelect(){ window.__moves.push(['remove', n]); }}] : []),
    {id:'delete-thread', onSelect(){ window.__moves.push(['DELETE', n]); }},
  ];
  row.__reactFiber$test = {memoizedProps:{}, return:{memoizedProps:{x:1}, return:{memoizedProps:{getItems}, return:null}}};
});
"""

ok = True
def check(name, cond, extra=""):
    global ok
    ok &= bool(cond)
    print(("✔ " if cond else "✘ ") + name, extra)


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    page = b.new_page(viewport={"width": 900, "height": 700})
    page.set_default_timeout(5000)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    # about:blank 은 localStorage 를 못 쓰므로 가짜 주소로 띄운다
    page.route("http://cxm.test/", lambda route: route.fulfill(body=HTML, content_type="text/html; charset=utf-8"))
    page.goto("http://cxm.test/")
    page.add_script_tag(content=MOCKS)
    page.add_script_tag(content=(ROOT / "labels" / "common.js").read_text(encoding="utf-8"))
    page.add_script_tag(content=(ROOT / "labels" / "thread-actions.js").read_text(encoding="utf-8"))
    page.add_script_tag(content=(ROOT / "labels" / "sidebar-filter.js").read_text(encoding="utf-8"))
    page.add_script_tag(content=(ROOT / "labels" / "filter-window.js").read_text(encoding="utf-8"))
    page.wait_for_timeout(200)

    visible = lambda: page.evaluate("[...document.querySelectorAll('[data-app-action-sidebar-thread-row]')].filter(r => getComputedStyle(r).display !== 'none').map(r => +r.dataset.appActionSidebarThreadTitle.split(' ')[1])")
    check("필터 막대가 목록 바로 위", page.evaluate("document.querySelector('.cxm-filter').nextElementSibling.classList.contains('scroller')"))
    check("처음엔 모두 표시", visible() == [1, 2, 3, 4, 5, 6])
    btn = page.locator(".cxm-filter-open")
    fw = page.locator(".cxm-fw")
    item = lambda kind, name: page.locator(f".cxm-fw-col[data-kind='{kind}'] .cxm-fw-item", has_text=name)
    def toggle(kind, name):
        item(kind, name).locator("input").click(); page.wait_for_timeout(80)
    def only(kind, name):
        item(kind, name).hover(); item(kind, name).locator("button.cxm-fw-only").click(); page.wait_for_timeout(80)

    check("막대에는 필터 버튼 하나(전체), 저장한 필터가 없으면 고르기 숨김", btn.inner_text() == "필터: 전체" and not page.locator(".cxm-preset-sel").is_visible())
    btn.click()
    check("필터 관리 창이 열림", fw.is_visible() and page.inner_text(".cxm-fw-head h2") == "대화 필터")
    names = page.locator(".cxm-fw-col[data-kind='status'] .cxm-fw-name").all_inner_texts()
    check("진행 상태 목록(상태 라벨 + 라벨 없음)", names == ["요청", "진행", "완료", "라벨 없음"], names)
    ns = page.locator(".cxm-fw-col[data-kind='status'] .cxm-fw-n").all_inner_texts()
    check("값마다 대화 수", ns == ["1", "2", "0", "3"], ns)
    check("카테고리 목록", page.locator(".cxm-fw-col[data-kind='category'] .cxm-fw-name").all_inner_texts() == ["개발", "노하우", "라벨 없음"])
    check("표시 개수", page.inner_text(".cxm-fw-count") == "왼쪽 목록 6개 모두 표시")
    toggle("status", "요청")
    check("체크를 끄면 그 상태만 뺌(창을 연 채로 바로 반영)", visible() == [1, 3, 4, 5, 6] and fw.is_visible(), visible())
    check("막대 버튼에 '제외'", btn.inner_text() == "필터: 요청 제외")
    check("창의 표시 개수", page.inner_text(".cxm-fw-count") == "왼쪽 목록 5 / 6개 표시")
    toggle("status", "라벨 없음")
    check("여러 개 빼기", visible() == [1, 3], visible())
    check("막대 버튼 요약", btn.inner_text() == "필터: 진행 상태 2개 숨김")
    states = page.locator(".cxm-fw-col[data-kind='status'] .cxm-fw-item").evaluate_all("rs => rs.map(r => [r.querySelector('.cxm-fw-name').textContent, r.classList.contains('cxm-off'), r.querySelector('.cxm-fw-state').textContent])")
    check("보임/숨김 표시", states == [["요청", True, "숨김"], ["진행", False, "보임"], ["완료", False, "보임"], ["라벨 없음", True, "숨김"]], states)
    check("숨긴 항목은 취소선", item("status", "요청").locator(".cxm-fw-name").evaluate("s => getComputedStyle(s).textDecorationLine") == "line-through")
    check("체크한 칸에 포커스 유지", page.evaluate("document.activeElement?.dataset.value") == "none")
    check("열 제목에 보이는 개수", page.inner_text(".cxm-fw-col[data-kind='status'] h3 span") == "2/4 보임")
    only("category", "개발")
    check("'이것만'으로 한 카테고리만", visible() == [1] and btn.inner_text() == "필터: 진행 상태 2개 숨김 · 개발만", (visible(), btn.inner_text()))
    before = page.evaluate("window.__cxmSidebarFilter.state().filter")
    flip = page.locator(".cxm-fw-col[data-kind='status'] .cxm-fw-colfoot button", has_text="반전")
    flip.click(); page.wait_for_timeout(80)
    after = page.evaluate("window.__cxmSidebarFilter.state().filter")
    all_status = page.locator(".cxm-fw-col[data-kind='status'] input").evaluate_all("is => is.map(i => i.dataset.value)")
    check("반전: 보임과 숨김이 바뀜(카테고리는 그대로)", sorted(after["status"]) == sorted(v for v in all_status if v not in before["status"])
          and after["category"] == before["category"], (before, after))
    page.locator(".cxm-fw-col[data-kind='status'] .cxm-fw-colfoot button", has_text="반전").click(); page.wait_for_timeout(80)
    check("두 번 반전하면 원래대로", page.evaluate("window.__cxmSidebarFilter.state().filter") == before and visible() == [1])

    # 저장한 필터
    page.fill(".cxm-fw-save input", "진행 중 개발")
    page.click(".cxm-fw-save button")
    rows = lambda: page.locator(".cxm-fw-preset").evaluate_all("rs => rs.map(r => [r.querySelector('.cxm-fw-pname')?.textContent, !!r.querySelector('.cxm-fw-tag')])")
    check("지금 필터 저장(사용 중 표시)", rows() == [["진행 중 개발", True]], rows())
    check("막대 버튼이 저장한 필터 이름", btn.inner_text() == "필터: 진행 중 개발")
    check("빈 이름은 안내", (page.click(".cxm-fw-save button"), page.inner_text(".cxm-fw-msg"))[1] == "필터 이름을 입력하세요.")
    page.locator(".cxm-fw-colfoot").first.locator("button", has_text="모두 보기").click(); page.wait_for_timeout(80)
    check("모두 보기(진행 상태)", btn.inner_text() == "필터: 개발만" and rows() == [["진행 중 개발", False]])
    page.locator(".cxm-fw-preset .cxm-fw-pname").click(); page.wait_for_timeout(80)
    check("저장한 필터 쓰기", visible() == [1] and page.evaluate("window.__cxmSidebarFilter.state().filter") == {"status": ["requested", "none"], "category": ["knowhow", "none"]})
    page.locator(".cxm-fw-preset button", has_text="이름").click()
    page.locator(".cxm-fw-preset input").fill("개발 진행")
    page.wait_for_timeout(2300)   # 목록이 다시 그려져도 입력이 끊기지 않음
    page.locator(".cxm-fw-preset input").press("Enter"); page.wait_for_timeout(80)
    check("이름 바꾸기", rows() == [["개발 진행", True]], rows())
    page.click(".cxm-fw-foot button:text('필터 끄기 (모두 보기)')"); page.wait_for_timeout(80)
    check("필터 끄기", visible() == [1, 2, 3, 4, 5, 6] and btn.inner_text() == "필터: 전체")
    toggle("category", "라벨 없음")
    page.locator(".cxm-fw-preset button", has_text="덮어쓰기").click(); page.wait_for_timeout(80)
    check("덮어쓰기", page.evaluate("window.__cxmSidebarFilter.presets()[0]") ["category"] == ["none"] and rows() == [["개발 진행", True]])
    page.keyboard.press("Escape"); page.wait_for_timeout(50)
    check("Esc 로 창 닫기", not fw.is_visible())
    sel = page.locator(".cxm-preset-sel")
    check("막대의 저장한 필터 고르기", sel.is_visible() and sel.evaluate("s => [...s.options].map(o => o.textContent)") == ["저장한 필터", "개발 진행"] and sel.input_value() != "")
    btn.click(); page.locator(".cxm-fw-colfoot").nth(1).locator("button", has_text="모두 보기").click(); page.wait_for_timeout(50)
    page.mouse.click(5, 5); page.wait_for_timeout(50)
    check("창 바깥을 누르면 닫힘", not fw.is_visible())
    sel.select_option(label="개발 진행"); page.wait_for_timeout(80)
    check("막대에서 저장한 필터 쓰기", visible() == [1, 4], visible())
    btn.click(); page.locator(".cxm-fw-preset button", has_text="삭제").click(); page.wait_for_timeout(50)
    check("삭제", page.locator(".cxm-fw-empty").is_visible() and not sel.is_visible())
    page.click(".cxm-fw-foot .cxm-fw-close")
    btn.click(); only("category", "라벨 없음"); page.keyboard.press("Escape")
    check("카테고리 없는 대화만", visible() == [2, 3, 5, 6], visible())
    check("필터를 기억(숨길 값 목록)", page.evaluate("JSON.parse(localStorage.getItem('cxm-sidebar-filter'))") == {"status": [], "category": ["dev", "knowhow"]})

    # 수정 모드
    page.click(".cxm-filter button:text('수정')")
    row = lambda n: page.locator(f"[data-app-action-sidebar-thread-title='대화 {n}']")
    row(2).click(); page.wait_for_timeout(80)
    check("수정 중 줄을 눌러도 대화가 열리지 않음", page.evaluate("window.__opened") == [])
    row(6).click(modifiers=["Shift"]); page.wait_for_timeout(80)
    state = page.evaluate("window.__cxmSidebarFilter.state()")
    check("Shift 로 보이는 줄만 범위 선택", sorted(state["picked"]) == sorted([K(2), K(3), K(5), K(6)]), state["picked"])
    check("선택 개수 표시", "4개 선택" in page.inner_text(".cxm-filter-edit"))
    row(3).click(); page.wait_for_timeout(80)
    check("다시 누르면 선택 해제", K(3) not in page.evaluate("window.__cxmSidebarFilter.state()")["picked"])

    edit_sel = page.locator(".cxm-filter-edit select")
    edit_sel.nth(1).select_option("knowhow"); page.wait_for_timeout(200)
    calls = page.evaluate("window.__assignCalls")
    check("카테고리 한꺼번에 바꾸기", len(calls) == 1 and calls[0]["kind"] == "category" and calls[0]["id"] == "knowhow"
          and sorted(calls[0]["keys"]) == sorted([K(2), K(5), K(6)]), calls)
    check("바뀐 대화는 선택 중이라 필터에 걸려도 남아 있음", visible() == [2, 3, 5, 6], visible())
    check("완료 안내", "3개 대화의 카테고리를 '노하우'" in page.inner_text(".cxm-filter-msg"))
    edit_sel.nth(0).select_option("__none"); page.wait_for_timeout(200)
    calls = page.evaluate("window.__assignCalls")
    check("진행 상태 지우기(id=null)", calls[-1]["kind"] == "status" and calls[-1]["id"] is None)

    # 옮기기
    page.wait_for_function("document.querySelectorAll('.cxm-filter-edit select')[2].options.length > 1")
    move_opts = page.evaluate("[...document.querySelectorAll('.cxm-filter-edit select')[2].querySelectorAll('option')].map(o => (o.parentElement.label || '') + ':' + o.textContent)")
    check("옮길 곳 목록(프로젝트·섹션, 새 섹션 제외)", move_opts == [":옮길 곳 고르기…", "프로젝트:회사내규", "프로젝트:쇼핑몰", "섹션:sns"], move_opts)
    edit_sel.nth(2).select_option("move-thread-to-project:p1")
    page.click(".cxm-filter-edit button:text('옮기기')")
    page.wait_for_function("!window.__cxmSidebarFilter.state().busy && document.querySelector('.cxm-filter-msg').textContent.includes('옮김')")
    moves = page.evaluate("window.__moves")
    check("프로젝트로 옮기기는 Codex 메뉴 항목 실행, 이미 있는 대화는 건너뜀", sorted(moves) == sorted([["p1", 2], ["p1", 6]]), moves)
    check("결과 안내", page.inner_text(".cxm-filter-msg") == "2개 옮김, 1개는 이미 그곳에 있거나 옮길 수 없어 건너뜀", page.inner_text(".cxm-filter-msg"))
    page.evaluate("window.__moves.length = 0")
    edit_sel.nth(2).select_option("move-to-custom-section:s1")
    page.click(".cxm-filter-edit button:text('옮기기')")
    page.wait_for_function("!window.__cxmSidebarFilter.state().busy && window.__moves.length >= 2")
    page.wait_for_timeout(100)
    moves = page.evaluate("window.__moves")
    check("섹션은 이미 들어 있으면(체크됨) 건너뜀, 다른 메뉴 항목은 안 누름", sorted(moves) == sorted([["s1", 2], ["s1", 6]]), moves)

    # 모두 선택은 보이는 줄만
    page.click(".cxm-filter button:text('선택 해제')")
    btn.click(); only("category", "노하우"); page.keyboard.press("Escape")
    page.click(".cxm-filter button:text('모두 선택')"); page.wait_for_timeout(80)
    check("모두 선택은 보이는 대화만", sorted(page.evaluate("window.__cxmSidebarFilter.state()")["picked"]) == sorted([K(2), K(4), K(5), K(6)]))

    page.keyboard.press("Escape"); page.wait_for_timeout(80)
    st = page.evaluate("window.__cxmSidebarFilter.state()")
    check("Esc 로 수정 끝내고 선택 비움", not st["editing"] and st["picked"] == [])
    row(2).click(); page.wait_for_timeout(50)
    check("수정이 끝나면 줄 클릭이 다시 대화를 연다", page.evaluate("window.__opened") == [2])

    # 모델 도구가 쓰는 필터 API (setFilter·exportState·importState·savePreset(이름, 필터))
    fa = "window.__cxmSidebarFilter"
    before = page.evaluate(f"{fa}.exportState()")
    page.evaluate(f"{fa}.setFilter({{status: ['requested']}})"); page.wait_for_timeout(80)
    check("setFilter: 넣은 쪽만", page.evaluate(f"{fa}.state().filter") == {"status": ["requested"], "category": before["filter"]["category"]})
    page.evaluate(f"{fa}.savePreset('모델 필터', {{status: ['none'], category: []}})")
    check("savePreset(이름, 필터)", page.evaluate(f"{fa}.presets().find(p => p.name === '모델 필터')")["status"] == ["none"])
    page.evaluate(f"{fa}.importState({json.dumps(before)})"); page.wait_for_timeout(80)
    check("importState 로 되돌리기", page.evaluate(f"{fa}.exportState()") == before)
    check("바깥 표시(개수·숨김 칩) 없음", page.locator(".cxm-filter-chips, .cxm-chip").count() == 0)

    # 모델 도구가 쓰는 위치 확인·되돌리기
    page.evaluate("""const r=document.querySelector('[data-app-action-sidebar-thread-title="대화 5"]');
      r.dataset.appActionSidebarThreadId='local:client-new-thread:11111111-1111-4111-8111-111111111111';
      r.__reactFiber$test.memoizedProps.conversationId='00000000-0000-4000-8000-000000000005';""")
    check("모델 대화 목록도 임시 ID 대신 실제 ID와 라벨 열쇠 반환", page.evaluate("window.__cxmThreadActions.rows().find(r=>r.title==='대화 5')")['rowId'] == U(5)
          and page.evaluate("window.__cxmThreadActions.rows().find(r=>r.title==='대화 5')")['key'] == K(5))
    loc = page.evaluate(f"window.__cxmThreadActions.locate('{U(5)[6:]}')")
    check("위치 확인(프로젝트·섹션, uuid 만으로도 찾음)", loc == {"project": "회사내규", "sections": ["sns"]}, loc)
    page.evaluate("window.__moves.length = 0")
    page.evaluate(f"window.__cxmThreadActions.restore('{U(5)}', {{project: null, sections: []}})")
    moves = page.evaluate("window.__moves")
    check("되돌리기: 프로젝트에서 빼고 섹션 해제", moves == [["remove", 5], ["s1", 5]], moves)
    err = page.evaluate("window.__cxmThreadActions.locate('local:없는-대화').then(() => '', e => e.message)")
    check("목록에 없는 대화는 안내", "왼쪽 목록에 보이지 않는" in err, err)

    # 예전 저장값('진행'만 보기)은 나머지를 숨기는 체크 목록으로 바뀐다
    p2 = b.new_page()
    p2.route("http://cxm.test/", lambda route: route.fulfill(body=HTML, content_type="text/html; charset=utf-8"))
    p2.goto("http://cxm.test/")
    p2.evaluate("localStorage.setItem('cxm-sidebar-filter', JSON.stringify({status: 'in_progress', category: 'all'}))")
    p2.add_script_tag(content=MOCKS)
    p2.add_script_tag(content=(ROOT / "labels" / "common.js").read_text(encoding="utf-8"))
    p2.add_script_tag(content=(ROOT / "labels" / "thread-actions.js").read_text(encoding="utf-8"))
    p2.add_script_tag(content=(ROOT / "labels" / "sidebar-filter.js").read_text(encoding="utf-8"))
    p2.wait_for_timeout(300)
    st = p2.evaluate("window.__cxmSidebarFilter.state().filter")
    check("예전 저장값 변환", st == {"status": ["requested", "completed", "none"], "category": []}, st)
    check("변환 후 버튼", p2.locator(".cxm-filter-open").inner_text() == "필터: 진행만")
    p2.close()

    page.evaluate("window.__cxmSidebarFilter.destroy()")
    check("destroy 가 막대·숨김 정리", page.evaluate("!document.querySelector('.cxm-filter')") and visible() == [1, 2, 3, 4, 5, 6])
    check("페이지 오류 없음", not errors, errors)
    b.close()

print("\n결과:", "모두 통과" if ok else "실패 있음")
sys.exit(0 if ok else 1)
