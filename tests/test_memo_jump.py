"""메모 위치로 이동: 다른 대화의 메모를 누르면 그 대화를 열고 메모한 글로 스크롤·반짝임, 없어진 대화는 표시 (설치된 Chrome 사용)."""

import time
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
read = lambda p: (ROOT / p).read_text(encoding="utf-8")
A = "01a1102e-0000-7000-8000-00000000000a"
B = "01a1102e-0000-7000-8000-00000000000b"
GONE = "01a1102e-0000-7000-8000-00000000000c"
CHAT = "44444444-4444-4444-8444-444444444444"
# 왼쪽 목록 두 대화. 줄을 누르면 Codex 처럼 선택 표시와 본문이 바뀐다.
HTML = f"""<!doctype html><html><head><meta charset="utf-8"></head><body>
<nav><div class="row" data-app-action-sidebar-thread-id="local:{A}" data-app-action-sidebar-thread-title="대화 A" data-app-action-sidebar-thread-selected="true">대화 A</div>
<div class="row" data-app-action-sidebar-thread-id="local:{B}" data-app-action-sidebar-thread-title="대화 B">대화 B</div></nav>
<main><div data-selected-text-overlay-target="m" id="msg"><p>대화 A 의 본문입니다.</p></div></main>
</body></html>"""
CODEX = f"""
const bodies = {{'{A}': '<p>대화 A 의 본문입니다.</p>',
  '{B}': '<p>' + '앞 문단입니다. '.repeat(400) + '</p><p id="target">여기가 메모한 라우팅 설정 문장입니다.</p>'}};
document.querySelectorAll('.row').forEach(row => row.addEventListener('click', () => {{
  document.querySelectorAll('.row').forEach(r => r.removeAttribute('data-app-action-sidebar-thread-selected'));
  row.setAttribute('data-app-action-sidebar-thread-selected', 'true');
  if (window.__router) window.__router.state.location.pathname = '/local/' + row.getAttribute('data-app-action-sidebar-thread-id').slice(6);
  setTimeout(() => {{ document.getElementById('msg').innerHTML = bodies[row.getAttribute('data-app-action-sidebar-thread-id').slice(6)]; }}, 120);
}}));
window.__sent = [];
window.__codexMemoBridge = (raw) => {{ window.__sent.push(JSON.parse(raw)); }};
// Codex 앱 라우터 흉내: ChatGPT 채팅은 /c/<id>, Codex 대화는 /local/<id>
window.__router = {{state: {{location: {{pathname: '/local/{A}'}}}}, navigate: (path) => {{
  window.__router.state.location.pathname = path;
  if (path.startsWith('/c/')) {{
    document.querySelectorAll('.row').forEach(r => r.removeAttribute('data-app-action-sidebar-thread-selected'));
    document.title = '채팅 제목';
    setTimeout(() => {{ document.getElementById('msg').innerHTML = '<p>채팅 답변에서 메모한 문장입니다.</p>'; }}, 120);
  }}
}}}};
document.querySelector('nav .row').__reactFiber$test = {{memoizedProps: {{value: {{router: window.__router}}}}}};
window.__states = [];
window.codexLabels = {{
  vocabularyRead: async () => ({{revision: 'r', entries: []}}), onVocabularyChanged: () => () => {{}},
  vocabularyCancel: async () => true, vocabularyModels: async () => [], vocabularyModel: async () => ({{}}),
  threadStates: async (ids) => {{ window.__states.push(ids); return Object.fromEntries(ids.map(id => [id, id === '{GONE}' ? 'missing' : 'ok'])); }},
}};
"""
MEMOS = [
    {"id": "m1", "created": "2026-10-06 10:00", "conv": B, "title": "대화 B", "quote": "라우팅 설정", "note": "B 에서 쓴 메모",
     "exact": "라우팅 설정", "prefix": "여기가 메모한 ", "suffix": " 문장입니다."},
    {"id": "m2", "created": "2026-10-06 10:01", "conv": GONE, "title": "지운 대화", "quote": "없어진 글", "note": "지운 대화의 메모",
     "exact": "없어진 글", "prefix": "", "suffix": ""},
    {"id": "m3", "created": "2026-10-06 10:02", "conv": "title:예전 창", "title": "예전", "quote": "옛 글", "note": "예전 메모"},
    {"id": "m4", "created": "2026-10-06 10:03", "conv": "chat:" + CHAT, "title": "채팅 제목", "quote": "메모한 문장", "note": "채팅에서 쓴 메모",
     "exact": "메모한 문장", "prefix": "채팅 답변에서 ", "suffix": "입니다."},
]


class MemoJumpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(channel="chrome", headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 1000, "height": 700})
        self.addCleanup(self.page.close)
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.set_content(HTML)
        self.page.add_script_tag(content=CODEX)
        for f in ("labels/common.js", "labels/vendor/vocabulary-renderer.js", "labels/thread-open.js", "labels/memo-vocab.js", "inject.js"):
            self.page.add_script_tag(content=read(f))
        self.page.evaluate("m => window.__codexMemo.setMemos(m)", MEMOS)
        self.page.evaluate("window.dispatchEvent(new CustomEvent('codex-labels:open-vocabulary', {detail: {kind: 'memo'}}))")
        self.page.locator("#cdx-vocabulary .cxm-memo-card").first.wait_for(timeout=3000)

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def card(self, note):
        return self.page.locator("#cdx-vocabulary .cxm-memo-card", has_text=note)

    def test_states_marked_on_cards(self):
        self.page.wait_for_function("document.querySelector('#cdx-vocabulary .cxm-thread-badge')", timeout=3000)
        self.assertEqual(self.page.evaluate("window.__states"), [[B, GONE]], "대화 id 가 있는 메모만 한 번에 묻는다")
        gone = self.card("지운 대화의 메모")
        self.assertEqual(gone.locator(".cxm-thread-badge").inner_text(), "대화 없음 (삭제됨)")
        self.assertTrue(gone.locator(".cxm-memo-go").is_disabled())
        self.assertTrue(self.card("예전 메모").locator(".cxm-memo-go").is_disabled())
        self.assertFalse(self.card("B 에서 쓴 메모").locator(".cxm-memo-go").is_disabled())
        self.assertEqual(self.card("B 에서 쓴 메모").locator(".cxm-thread-badge").count(), 0)

    def test_jump_opens_thread_and_flashes_memo(self):
        self.card("B 에서 쓴 메모").locator(".cxm-memo-go").click()
        self.page.wait_for_function("CSS.highlights.get('cxm-memo-flash')", timeout=8000)
        self.assertEqual(self.page.locator("#cdx-vocabulary").count(), 0, "보관함을 닫고 대화를 보여준다")
        self.assertEqual(self.page.get_attribute(f'[data-app-action-sidebar-thread-id="local:{B}"]', "data-app-action-sidebar-thread-selected"), "true")
        flashed = self.page.evaluate("""() => { const r = [...CSS.highlights.get('cxm-memo-flash')][0];
          return r.startContainer.data.slice(r.startOffset, r.endOffset); }""")
        self.assertEqual(flashed, "라우팅 설정")
        self.page.wait_for_timeout(800)   # 부드러운 스크롤이 끝날 때까지
        box = self.page.evaluate("document.getElementById('target').getBoundingClientRect().top")
        self.assertTrue(0 <= box <= 700, f"메모한 문장이 화면 안으로 스크롤됨 ({box})")
        self.assertEqual(self.page.inner_text(".cxm-jump-toast"), "메모한 위치입니다.")
        time.sleep(1.8)
        self.assertFalse(self.page.evaluate("CSS.highlights.has('cxm-memo-flash')"), "반짝임은 잠깐만")


    def test_chat_memo_is_not_a_codex_thread_and_opens_the_chat(self):
        self.page.wait_for_function("document.querySelector('#cdx-vocabulary .cxm-thread-badge')", timeout=3000)
        self.assertNotIn(CHAT, self.page.evaluate("window.__states.flat()"), "채팅은 Codex 대화 상태를 묻지 않는다")
        card = self.card("채팅에서 쓴 메모")
        self.assertIn("채팅", card.locator(".cxm-memo-meta").inner_text())
        self.assertFalse(card.locator(".cxm-memo-go").is_disabled())
        card.locator(".cxm-memo-go").click()
        self.page.wait_for_function("CSS.highlights.get('cxm-memo-flash')", timeout=8000)
        self.assertEqual(self.page.evaluate("window.__router.state.location.pathname"), f"/c/{CHAT}")
        self.assertEqual(self.page.inner_text(".cxm-jump-toast"), "메모한 위치입니다.")

    def test_new_memo_in_chat_is_saved_with_chat_id(self):
        self.page.evaluate(f"window.__router.navigate('/c/{CHAT}')")
        self.page.wait_for_function("document.title === '채팅 제목'")
        self.assertEqual(self.page.evaluate("window.__cxmThreads.currentConv()"), "chat:" + CHAT)
        self.assertIsNone(self.page.evaluate("window.__cxmThreads.currentId()"), "채팅은 Codex 대화로 보지 않는다")
        self.assertIsNone(self.page.evaluate(f"window.__cxmThreads.uuidOf('chat:{CHAT}')"))
        self.assertEqual(self.page.evaluate(f"window.__cxmThreads.chatOf('chat:{CHAT}')"), CHAT)
        self.page.evaluate(f"window.__router.navigate('/g/g-abc/c/{CHAT}')")
        self.assertEqual(self.page.evaluate("window.__cxmThreads.currentChat()"), CHAT, "GPT 채팅 경로도 채팅이다")


if __name__ == "__main__":
    unittest.main()
