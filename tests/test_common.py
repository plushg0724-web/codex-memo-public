"""공통 도구(labels/common.js): 열쇠·라벨 종류와 화면 변화 감시(왼쪽 목록 변화·새 요소만 알림).

실행: python tests/test_common.py
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
HTML = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="sidebar-navigation"><div id="list">
  <div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:00000000-0000-4000-8000-000000000001"
       data-app-action-sidebar-thread-kind="local" data-app-action-sidebar-thread-title="대화"><span id="title">대화</span></div>
</div></div>
<main id="chat"><p id="answer">답변</p></main></body></html>"""

ok = True
def check(name, cond, extra=""):
    global ok
    ok &= bool(cond)
    print(("✔ " if cond else "✘ ") + name, extra)


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    page = b.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.set_content(HTML)
    page.add_script_tag(content=(ROOT / "labels" / "common.js").read_text(encoding="utf-8"))
    c = "window.__cxm"
    check("열쇠·uuid", page.evaluate(f"(() => {{ const r = document.querySelector({c}.ROW); return [{c}.keyOf(r), {c}.uuidOf(r)]; }})()")
          == ["thread:local:local:local:00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"])
    check("라벨 종류", page.evaluate(f"[{c}.kindOf({{id: 'completed'}}), {c}.kindOf({{id: 'x'}}), {c}.kindOf({{id: 'completed', kind: 'category'}}), {c}.kindOf('on_hold')]")
          == ["status", "category", "category", "status"])
    page.evaluate("""const row = document.querySelector('[data-app-action-sidebar-thread-row]');
      row.dataset.appActionSidebarThreadId = 'local:client-new-thread:11111111-1111-4111-8111-111111111111';
      row.__reactFiber$test = {memoizedProps:{}, return:{memoizedProps:{conversationId:'00000000-0000-4000-8000-000000000001'},return:null}};""")
    check("임시 목록 ID 대신 같은 줄의 실제 대화 ID 사용", page.evaluate(f"(() => {{ const r=document.querySelector({c}.ROW); return [{c}.rowIdOf(r),{c}.keyOf(r),{c}.uuidOf(r)]; }})()")
          == ["local:00000000-0000-4000-8000-000000000001", "thread:local:local:local:00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"])
    page.evaluate("document.querySelector('[data-app-action-sidebar-thread-row]').__reactFiber$test.return.memoizedProps = {href:'/local/00000000-0000-4000-8000-000000000001'}")
    check("실제 대화 링크로도 해결", page.evaluate(f"{c}.uuidOf(document.querySelector({c}.ROW))") == "00000000-0000-4000-8000-000000000001")
    page.evaluate("document.querySelector('[data-app-action-sidebar-thread-row]').__reactFiber$test.return.memoizedProps = {conversationId:'client-new-thread:11111111-1111-4111-8111-111111111111',href:'/settings'}")
    check("생성 전 임시 UUID에는 라벨 저장과 분류를 요청하지 않음", page.evaluate(f"(() => {{ const r=document.querySelector({c}.ROW); return [{c}.keyOf(r),{c}.uuidOf(r)??null]; }})()") == ["", None])
    page.evaluate("""const r=document.querySelector('[data-app-action-sidebar-thread-row]');
      r.dataset.appActionSidebarThreadId='local:00000000-0000-4000-8000-000000000001'; delete r.__reactFiber$test;""")
    page.evaluate(f"""window.__log = []; window.__off = {c}.watch({{
        sidebar: (list) => __log.push('sidebar:' + list.length),
        added: (els) => __log.push('added:' + els.map(e => e.id || e.className).join(',')) }}); 0""")  # 함수를 돌려주면 Playwright 가 불러 버린다
    log = lambda: page.evaluate("(async () => { await new Promise(r => setTimeout(r, 30)); const l = [...__log]; __log.length = 0; return l; })()")

    page.evaluate("for (let i = 0; i < 50; i++) document.getElementById('answer').firstChild.data += '토큰'")
    check("답변이 흘러나와도(본문 글자 변화) 알리지 않음", log() == [])
    page.evaluate("const s = document.createElement('span'); s.id = 'tok'; document.getElementById('answer').append(s)")
    l = log(); check("본문에 요소가 붙으면 added 만", l == ["added:tok"], l)
    page.evaluate("document.getElementById('title').firstChild.data = '새 제목'")
    l = log(); check("목록 글자 변화는 sidebar", l == ["sidebar:1"], l)
    page.evaluate("document.querySelector('[data-app-action-sidebar-thread-row]').dataset.appActionSidebarThreadSelected = 'true'")
    check("선택 표시 바뀜은 sidebar", log() == ["sidebar:1"])
    page.evaluate("document.querySelector('[data-app-action-sidebar-thread-row]').classList.add('cxm-filter-hidden')")
    check("우리가 바꾸는 class 는 알리지 않음(반복 방지)", log() == [])
    page.evaluate("const d = document.createElement('span'); d.className = 'cxm-thread-status'; d.textContent = '답 필요'; document.querySelector('[data-app-action-sidebar-thread-row]').prepend(d)")
    check("우리 표시를 붙이기만 하면 알리지 않음", log() == [])
    page.evaluate("document.querySelector('.cxm-thread-status').textContent = '막힘'")
    check("우리 표시 안의 변화도 알리지 않음", log() == [])
    page.evaluate("const r = document.querySelector('[data-app-action-sidebar-thread-row]').cloneNode(true); r.id = 'row2'; document.getElementById('list').append(r)")
    check("새 대화 줄은 sidebar + added", sorted(log()) == ["added:row2", "sidebar:1"])
    page.evaluate("__off()")
    page.evaluate("document.getElementById('title').firstChild.data = '또'")
    check("해제하면 더 알리지 않음", log() == [])

    # 목록 틀이 없는 화면: 대화 줄 기준
    p2 = b.new_page()
    p2.set_content(HTML.replace('class="sidebar-navigation"', 'class="other"'))
    p2.add_script_tag(content=(ROOT / "labels" / "common.js").read_text(encoding="utf-8"))
    p2.evaluate("window.__log = []; window.__cxm.watch({sidebar: () => __log.push('s')}); 0")
    p2.evaluate("document.getElementById('title').firstChild.data = 'x'; document.getElementById('answer').firstChild.data = 'y'")
    check("목록 틀이 없어도 대화 줄 변화는 알림, 본문은 아님", p2.evaluate("new Promise(r => setTimeout(() => r(__log), 30))") == ["s"])
    # An app update changes __cxmAppVersion without reloading the native window.
    # Check the visible badge, including repeated injection and sidebar replacement.
    badge_page = b.new_page()
    badge_page.on("pageerror", lambda e: errors.append(str(e)))
    badge_page.set_content(HTML)
    badge_page.add_script_tag(content=(ROOT / "labels" / "common.js").read_text(encoding="utf-8"))
    badge_page.evaluate("""() => {
      window.__cxmAppVersion='1.11.0'; window.__badgeIntervals=new Map();
      const set=window.setInterval.bind(window),clear=window.clearInterval.bind(window);
      window.setInterval=(fn,ms,...args)=>{const id=set(fn,ms,...args);__badgeIntervals.set(id,()=>fn(...args));return id;};
      window.clearInterval=id=>{__badgeIntervals.delete(id);clear(id);};
    }""")
    badge_script = (ROOT / "version-badge.js").read_text(encoding="utf-8")
    badge_page.add_script_tag(content=badge_script)
    badge = lambda: badge_page.locator(".cxm-version-badge").inner_text()
    check("버전 배지에 현재 앱 버전 표시", badge() == "Codex 메모 v1.11.0")
    check("버전은 목록 앞의 도구 줄에 있는 버튼", badge_page.evaluate("document.querySelector('.cxm-version-badge').tagName==='BUTTON' && document.querySelector('.cxm-sidebar-tools').nextElementSibling.id==='list'"))
    badge_page.evaluate("window.__settingsOpens=0; window.addEventListener('codex-labels:open-settings',()=>window.__settingsOpens++)")
    badge_page.get_by_role("button", name="Codex 메모 설정 열기").click()
    badge_page.get_by_role("button", name="Codex 메모 설정 열기").press("Enter")
    check("버전 클릭과 키보드로 기존 설정 열기", badge_page.evaluate("window.__settingsOpens===2"))
    badge_page.evaluate("window.__oldBadge=document.querySelector('.cxm-version-badge'); window.__oldBadgeRuntime=window.__cxmVersionBadge; window.__oldSheets=document.adoptedStyleSheets.length; window.__cxmAppVersion='1.12.2'")
    badge_page.add_script_tag(content=badge_script)
    check("앱 업데이트 후 같은 배지 코드 재주입 시 즉시 버전 갱신", badge() == "Codex 메모 v1.12.2")
    check("같은 배지 재주입 시 요소·스타일·타이머 중복 없음", badge_page.evaluate("document.querySelectorAll('.cxm-version-badge').length===1 && document.querySelector('.cxm-version-badge')===__oldBadge && window.__cxmVersionBadge===__oldBadgeRuntime && document.adoptedStyleSheets.length===__oldSheets && __badgeIntervals.size===1"))
    badge_page.evaluate("window.__cxmAppVersion='1.12.3'; [...__badgeIntervals.values()].forEach(fn=>fn())")
    check("재주입 없이 주기 확인할 때도 최신 앱 버전 표시", badge() == "Codex 메모 v1.12.3")
    badge_page.evaluate("document.querySelector('.sidebar-navigation').outerHTML='<div class=sidebar-navigation><div id=new-list></div></div>'; window.__cxmAppVersion='1.12.4'; [...__badgeIntervals.values()].forEach(fn=>fn())")
    check("사이드바가 교체돼도 최신 배지 하나만 다시 부착", badge() == "Codex 메모 v1.12.4" and badge_page.evaluate("document.querySelectorAll('.cxm-version-badge').length===1 && document.querySelector('.cxm-sidebar-tools').nextElementSibling.id==='new-list'"))
    badge_page.evaluate("window.__cxmVersionBadge.destroy()")
    check("배지 정리 시 타이머·배지·스타일·런타임 제거", badge_page.evaluate("__badgeIntervals.size===0 && !document.querySelector('.cxm-version-badge') && document.adoptedStyleSheets.length===__oldSheets-1 && !window.__cxmVersionBadge"))
    badge_page.add_script_tag(content=badge_script)
    check("배지를 정리한 뒤 재주입해도 정상 복구", badge() == "Codex 메모 v1.12.4" and badge_page.evaluate("__badgeIntervals.size===1"))
    badge_page.evaluate("window.__cxmVersionBadge.destroy(); document.querySelector('.sidebar-navigation').remove(); window.__cxmAppVersion='1.12.5'")
    badge_page.add_script_tag(content=badge_script)
    check("사이드바가 없는 화면에서는 배지를 잘못 만들지 않음", badge_page.locator(".cxm-version-badge").count() == 0)
    badge_page.evaluate("const nav=document.createElement('div'); nav.className='sidebar-navigation'; document.body.prepend(nav); [...__badgeIntervals.values()].forEach(fn=>fn())")
    check("늦게 열린 사이드바에도 현재 버전 표시", badge() == "Codex 메모 v1.12.5")
    badge_page.evaluate("window.__cxmVersionBadge.destroy()")
    check("페이지 오류 없음", not errors, errors)
    b.close()

print("\n결과:", "모두 통과" if ok else "실패 있음")
sys.exit(0 if ok else 1)
