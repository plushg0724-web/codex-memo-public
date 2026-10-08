"""labels/shim.js: 동시에 나간 단어장 읽기는 한 요청으로 묶고, 각자 사본을 받으며, 변경 신호·쓰기 뒤에는 새로 읽는다 (설치된 Chrome 사용)."""

import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FAKE = """
window.__sent = [];
// 도우미 대신: 요청을 기록하고 조금 뒤에 답한다
window.__codexMemoBridge = (raw) => {
  const m = JSON.parse(raw); window.__sent.push(m.method);
  setTimeout(() => window.__cxlBridge.resolve(m.id, true, m.method === 'vocabularyRead'
    ? {revision: 'r' + window.__sent.length, entries: [{id: 'a', term: 'ship'}]} : {ok: true}), 20);
};
"""


class ShimReadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(channel="chrome", headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.addCleanup(self.page.close)
        self.page.set_content("<!doctype html><html><body></body></html>")
        self.page.add_script_tag(content=FAKE)
        self.page.add_script_tag(content=(ROOT / "labels" / "shim.js").read_text(encoding="utf-8"))

    def test_concurrent_reads_share_one_request(self):
        r = self.page.evaluate("""async () => {
          const api = window.codexLabels;
          const [a, b, c] = await Promise.all([api.vocabularyRead(), api.vocabularyRead(), api.vocabularyRead()]);
          a.entries[0].term = '바뀜';   // 받은 쪽이 고쳐도 다른 쪽에는 영향 없음
          return {sent: window.__sent.slice(), same: a.revision === b.revision && b.revision === c.revision, b: b.entries[0].term};
        }""")
        self.assertEqual(r, {"sent": ["vocabularyRead"], "same": True, "b": "ship"})

    def test_change_signal_and_writes_start_a_new_read(self):
        sent = self.page.evaluate("""async () => {
          const api = window.codexLabels;
          const first = api.vocabularyRead();
          window.__cxlBridge.emit('vocabulary-changed');      // 읽는 중에 바뀌었다는 신호 → 다음 읽기는 새로
          const second = api.vocabularyRead();
          await Promise.all([first, second]);
          const third = api.vocabularyRead();
          await api.vocabularyEdit('a', {favorite: true}, 'r');  // 쓰기 → 다음 읽기는 새로
          await Promise.all([third, api.vocabularyRead()]);
          await api.vocabularyRead();                            // 끝난 읽기를 다시 쓰지 않는다
          return window.__sent.slice();
        }""")
        self.assertEqual(sent, ["vocabularyRead", "vocabularyRead", "vocabularyRead", "vocabularyEdit", "vocabularyRead", "vocabularyRead"])


if __name__ == "__main__":
    unittest.main()
