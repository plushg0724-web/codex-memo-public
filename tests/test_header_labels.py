"""Header label behavior with isolated assignments; never edits user data."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'output/playwright/header-labels'
OUT.mkdir(parents=True, exist_ok=True)
renderer = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'labels/vendor/renderer.js'
# Reuse the existing isolated label fixtures without running their scenarios.
fixtures = {'__file__': str(ROOT / 'tests/test_label_separation.py')}
exec((ROOT / 'tests/test_label_separation.py').read_text(encoding='utf-8').split('with sync_playwright() as p:')[0], fixtures)
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={'width': 900, 'height': 640})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.set_content(fixtures['HTML'])
    page.evaluate('''() => {
      const row=document.querySelector('[data-app-action-sidebar-thread-row]'); row.dataset.appActionSidebarThreadSelected='true';
      document.body.insertAdjacentHTML('afterbegin', '<header style="display:flex;height:40px"><span data-app-shell-titlebar-content style="display:flex;align-items:center;max-width:100%"><div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">検証</div></span></header>');
      document.querySelector('[data-app-shell-titlebar-content] div').textContent=row.dataset.appActionSidebarThreadTitle;
    }''')
    page.add_script_tag(content=fixtures['MOCKS'])
    page.add_script_tag(content=(ROOT / 'labels/common.js').read_text(encoding='utf-8'))
    page.add_script_tag(content=renderer.read_text(encoding='utf-8'))
    header = page.locator('.cdx-header-labels')
    status = header.locator('[data-kind=status]')
    category = header.locator('[data-kind=category]')
    expect(status).to_have_text('상태: 진행')
    expect(category).to_have_text('카테고리: 개발')
    category.click()
    page.locator('#cdx-label-menu [data-label-id=knowhow]').click()
    expect(category).to_have_text('카테고리: 노하우')
    expect(status).to_have_text('상태: 진행')
    expect(page.locator('[data-app-action-sidebar-thread-row]').first.locator('.cdx-label[data-kind=category]')).to_have_text('노하우')
    print('PASS header assignment updates sidebar and preserves status')
    status.focus()
    page.keyboard.press('Enter')
    page.locator('#cdx-label-menu [data-label-id=requested]').click()
    expect(status).to_have_text('상태: 요청')
    page.evaluate("window.__snapshot.assignments[Object.keys(window.__snapshot.assignments)[0]]='completed'; window.__changed()")
    expect(status).to_have_text('상태: 완료')
    print('PASS keyboard and external updates')
    status.click()
    page.evaluate('''() => {
      const rows=document.querySelectorAll('[data-app-action-sidebar-thread-row]'); rows[0].dataset.appActionSidebarThreadSelected='false'; rows[1].dataset.appActionSidebarThreadSelected='true';
    }''')
    expect(header).to_have_count(0)
    expect(page.locator('#cdx-label-menu')).to_have_count(0)
    page.evaluate("document.querySelector('[data-app-shell-titlebar-content] div').textContent='검증 대화 2'")
    expect(status).to_have_text('상태: 요청')
    expect(category).to_have_text('카테고리: 미지정')
    category.click()
    page.locator('#cdx-label-menu [data-label-id=dev]').click()
    assigned = page.evaluate('window.__assigned')
    assert assigned[-1] == [fixtures['K'](2), 'dev', 'category'], assigned
    print('PASS navigation closes old menu and uses the new conversation key')
    page.evaluate('''() => {
      const host=document.querySelector('[data-app-shell-titlebar-content]');
      const replacement=host.cloneNode(true); replacement.querySelector('.cdx-header-labels').remove(); host.replaceWith(replacement);
    }''')
    expect(header).to_have_count(1)
    expect(category).to_have_text('카테고리: 개발')
    page.evaluate('''() => {
      const hidden=document.createElement('div');hidden.setAttribute('aria-hidden','true');hidden.append(document.querySelector('[data-app-shell-titlebar-content]').cloneNode(true));hidden.querySelector('.cdx-header-labels').remove();document.body.prepend(hidden);
    }''')
    expect(header).to_have_count(1)
    print('PASS remounted titlebar and hidden measurement copy')
    page.evaluate("() => { window.__savedAssign=window.codexLabels.assign; window.codexLabels.assign=async()=>{throw Error('저장 실패 검증')}; }")
    status.click()
    page.locator('#cdx-label-menu [data-label-id=completed]').click()
    expect(page.locator('#cdx-label-error')).to_contain_text('저장 실패 검증')
    expect(status).to_have_text('상태: 요청')
    page.keyboard.press('Escape')
    print('PASS failed save preserves displayed value')
    page.set_viewport_size({'width': 420, 'height': 640})
    expect(status).to_be_visible()
    expect(category).to_be_visible()
    assert header.evaluate('e => e.getBoundingClientRect().right <= innerWidth')
    page.screenshot(path=str(OUT / 'header-isolated.png'))
    page.evaluate("document.querySelector('[data-app-action-sidebar-thread-selected=true]').dataset.appActionSidebarThreadSelected='false'")
    expect(header).to_have_count(0)
    page.evaluate("window.codexLabels.assign=window.__savedAssign; window.__cxmThreads={currentId:()=> '00000000-0000-4000-8000-000000000002'}; document.querySelector('[data-app-shell-titlebar-content] div').textContent='목록 밖 대화'")
    expect(status).to_have_text('상태: 요청')
    expect(category).to_have_text('카테고리: 개발')
    category.click()
    page.locator('#cdx-label-menu [data-label-id=knowhow]').click()
    assert page.evaluate('window.__assigned')[-1] == [fixtures['K'](2), 'knowhow', 'category']
    print('PASS omitted sidebar row uses routed ID and assigns to that conversation')
    page.evaluate("window.__cxmThreads.currentId=()=> '00000000-0000-4000-8000-000000000003'; document.querySelector('[data-app-shell-titlebar-content] div').textContent='목록 밖 대화'")
    expect(category).to_have_text('카테고리: 미지정')
    expect(status).to_have_text('상태: 미지정')
    print('PASS duplicate titles do not reuse the previous conversation labels')
    assert not errors, errors
    print('PASS narrow layout, no selected conversation, no JavaScript errors')
    browser.close()
