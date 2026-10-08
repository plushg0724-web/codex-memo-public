"""단어장 단어 본문 표시 검사: 한국어 조사·제외 영역·본문 변경·종류별 모양(즐겨찾기·학습 상태)·켜고 끄기·설정 창 (설치된 Chrome 사용)."""

import time
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
read = lambda p: (ROOT / p).read_text(encoding="utf-8")
HTML = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<nav class="sidebar-navigation" id="side"><div>SELinux 사이드바</div></nav>
<div id="outer"><main id="scroller">
 <div data-selected-text-overlay-target="a" id="msg">
  <p id="p1">항: SELinux가 컨테이너를 막습니다.</p>
  <p id="p2">토큰을 DPAPI로 보호하고 <code>SELinux</code> 코드는 빼고, SELinuxes 는 다른 단어.</p>
  <ul><li id="li">단어장은 좋고 단어장이해는 아님</li></ul>
 </div>
</main></div>
<textarea id="composer">SELinux 입력란</textarea>
</body></html>"""
FAKE = """
window.__entries = [{id:'a',term:'SELinux',meaning:'보안 모듈',favorite:true},{id:'b',term:'DPAPI',meaning:'암호화 API',status:'review'},{id:'c',term:'단어장',meaning:'단어 모음',status:'new'}];
window.__subs = new Set();
window.codexLabels = {
  vocabularyRead: async () => ({revision: 1, entries: window.__entries}),
  onVocabularyChanged: (fn) => { window.__subs.add(fn); return () => window.__subs.delete(fn); },
  vocabularyCancel: async () => true,
  vocabularyModels: async () => [], vocabularyModel: async () => ({}),
};
"""


class VocabHighlightTests(unittest.TestCase):
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
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        # localStorage 가 되도록 http 주소로 연다 (about:blank 은 저장소 없음)
        self.page.route("http://cxm.test/", lambda r: r.fulfill(body=HTML, content_type="text/html; charset=utf-8"))
        self.page.goto("http://cxm.test/")
        for s in (FAKE, read("labels/common.js"), read("labels/vendor/vocabulary-renderer.js"),
                  read("labels/hover-card.js"), read("labels/vocab-highlight.js")):
            self.page.add_script_tag(content=s)
        self.wait_terms(["SELinux", "DPAPI", "단어장"])

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def terms(self):
        return self.page.evaluate("""() => { const h = CSS.highlights.get('codex-vocabulary-saved');
          return h ? [...h].map(r => { const x = new Range(); x.setStart(r.startContainer, r.startOffset); x.setEnd(r.endContainer, r.endOffset); return x.toString(); }).sort() : null; }""")

    def wait_terms(self, want, timeout=3.0):
        end = time.time() + timeout
        while time.time() < end:
            if self.terms() == sorted(want):
                return
            time.sleep(0.05)
        self.assertEqual(self.terms(), sorted(want))

    def test_korean_particles_and_exclusions(self):
        # 'SELinux가'·'DPAPI로'·'단어장은' 은 칠하고, code·사이드바·입력란·'SELinuxes'·'단어장이해' 는 칠하지 않는다
        starts = self.page.evaluate("""[...CSS.highlights.get('codex-vocabulary-saved')].map(r => r.startContainer.parentElement.id || r.startContainer.parentElement.tagName).sort()""")
        self.assertEqual(starts, ["li", "p1", "p2"])

    def test_streaming_and_vocabulary_change(self):
        self.page.evaluate("""() => { const p = document.createElement('p'); p.id = 'p3'; p.textContent = '새 답변: DPAPI의 범위';
          document.getElementById('msg').append(p); }""")
        self.wait_terms(["SELinux", "DPAPI", "DPAPI", "단어장"])
        self.page.evaluate("""() => { window.__entries = [...window.__entries, {id:'d', term:'컨테이너', meaning:'x'}];
          for (const f of window.__subs) f(); }""")
        self.wait_terms(["SELinux", "DPAPI", "DPAPI", "단어장", "컨테이너"])

    def test_outer_style_changes_do_not_rescan(self):
        # 스크롤·가상 목록처럼 본문 밖 틀의 style 이 계속 바뀌어도 칠한 범위를 지우거나 다시 계산하지 않는다
        same = self.page.evaluate("""async () => {
          const before = [...CSS.highlights.get('codex-vocabulary-saved')];
          const outer = document.getElementById('outer');
          for (let i = 0; i < 200; i++) { outer.style.transform = `translateY(${i}px)`; outer.className = 'c' + i; await null; }
          await new Promise(r => setTimeout(r, 150));
          const after = [...CSS.highlights.get('codex-vocabulary-saved')];
          return after.length === before.length && after.every((r, i) => r === before[i]);
        }""")
        self.assertTrue(same)

    def layer(self, kind):
        return self.page.evaluate("""(k) => { const h = CSS.highlights.get('cxm-vhl-' + k);
          return h ? [...h].map(r => r.startContainer.data.slice(r.startOffset, r.endOffset)).sort() : null; }""", kind)

    def wait_layer(self, kind, want, timeout=3.0):
        end = time.time() + timeout
        while time.time() < end:
            if self.layer(kind) == want:
                return
            time.sleep(0.05)
        self.assertEqual(self.layer(kind), want)

    def rule(self, name):
        return self.page.evaluate("""(n) => { for (const s of document.adoptedStyleSheets) for (const r of s.cssRules)
          if (r.selectorText === '::highlight(' + n + ')') return r.cssText; return ''; }""", name)

    def test_kinds_and_default_emphasis(self):
        # 즐겨찾기·복습 필요·기본을 따로 칠하고, 원본 칠하기는 보이지 않게(카드용으로만) 둔다
        self.wait_layer("favorite", ["SELinux"])
        self.wait_layer("review", ["DPAPI"])
        self.wait_layer("base", ["단어장"])
        self.assertIn("transparent", self.rule("codex-vocabulary-saved"))
        base = self.rule("cxm-vhl-base")
        self.assertIn("underline 2px rgb(42, 165, 199)", base); self.assertIn("rgba(42, 165, 199, 0.2)", base)   # 실선(기본값은 축약형에서 생략)
        self.assertIn("3px", self.rule("cxm-vhl-favorite"))
        # 단어장에서 즐겨찾기를 바꾸면 다시 나눈다
        self.page.evaluate("""() => { window.__entries = window.__entries.map(e => e.id === 'c' ? {...e, favorite: true} : e);
          for (const f of window.__subs) f(); }""")
        self.wait_layer("favorite", ["SELinux", "단어장"])
        self.wait_layer("base", [])
        # 본문이 늘면 새 범위도 종류에 맞게
        self.page.evaluate("""() => { const p = document.createElement('p'); p.textContent = '새 답변: DPAPI의 범위'; document.getElementById('msg').append(p); }""")
        self.wait_layer("review", ["DPAPI", "DPAPI"])
        # 본문이 바뀌어 단어가 사라지면 그 범위만 뺀다
        self.page.evaluate("document.getElementById('p2').textContent = '이제 아무 단어도 없음'")
        self.wait_layer("review", ["DPAPI"])
        self.assertEqual(self.layer("favorite"), ["SELinux", "단어장"])

    def test_custom_style_off_and_persistence(self):
        api = "window.__cxmVocabHighlight"
        self.page.evaluate(f"{api}.setStyle('favorite', {{line: 'wavy', lineColor: '#ff0000', bgAlpha: 40, text: '#00ff00'}})")
        fav = self.rule("cxm-vhl-favorite")
        self.assertIn("wavy", fav); self.assertIn("rgb(255, 0, 0)", fav); self.assertIn("0.4", fav); self.assertIn("rgb(0, 255, 0)", fav)
        self.page.evaluate(f"{api}.setStyle('favorite', {{line: 'bogus', thickness: 9}})")   # 잘못된 값은 무시
        self.assertIn("wavy", self.rule("cxm-vhl-favorite"))
        saved = self.page.evaluate("JSON.parse(localStorage.getItem('cxm-vocab-highlight'))")
        self.assertEqual(saved["styles"]["favorite"]["line"], "wavy")
        self.page.evaluate(f"{api}.setOn(false)")
        self.assertIsNone(self.terms())   # 원본을 떼어 냄 → 마우스 올림·클릭 카드도 쉼
        self.assertIsNone(self.layer("favorite"))
        # 다시 주입(새 버전)돼도 설정을 유지
        self.page.evaluate(f"{api}.destroy()")
        self.assertEqual(len(self.terms()), 3)
        self.page.add_script_tag(content=read("labels/vocab-highlight.js"))
        self.assertFalse(self.page.evaluate(f"{api}.on"))
        self.assertIsNone(self.terms())
        self.page.evaluate(f"{api}.setOn(true)")
        self.wait_layer("favorite", ["SELinux"])
        self.assertIn("wavy", self.rule("cxm-vhl-favorite"))
        self.page.evaluate(f"{api}.reset()")
        self.assertIn("underline 3px rgb(242, 169, 0)", self.rule("cxm-vhl-favorite"))

    def test_old_setting_is_migrated(self):
        self.page.evaluate("window.__cxmVocabHighlight.destroy(); localStorage.setItem('cxm-vocab-highlight', 'underline')")
        self.page.add_script_tag(content=read("labels/vocab-highlight.js"))
        c = self.page.evaluate("window.__cxmVocabHighlight.config")
        self.assertTrue(c["on"])
        self.assertEqual({k: v["bgAlpha"] for k, v in c["styles"].items()}, {"base": 0, "review": 0, "known": 0, "favorite": 0})

    def replace_renderer(self):
        # Model a renderer update while the style module keeps its version.
        self.page.evaluate("window.__codexVocabularyRuntime.version = -1")
        self.page.add_script_tag(content=read("labels/vendor/vocabulary-renderer.js"))

    def test_renderer_replacement_preserves_styles_and_streaming(self):
        self.page.evaluate("""() => {
          window.__oldPaint = CSS.highlights.get('codex-vocabulary-saved');
          window.__cxmVocabHighlight.setStyle('favorite', {line:'wavy', lineColor:'#ff0000'});
        }""")
        self.replace_renderer()
        self.wait_terms(["SELinux", "DPAPI", "단어장"])
        self.assertTrue(self.page.evaluate("CSS.highlights.get('codex-vocabulary-saved') !== window.__oldPaint"))
        self.wait_layer("favorite", ["SELinux"])
        self.wait_layer("review", ["DPAPI"])
        self.wait_layer("base", ["단어장"])
        self.assertIn("wavy", self.rule("cxm-vhl-favorite"))
        self.page.evaluate("""() => {
          const p = document.createElement('p'); p.textContent = '새 답변: DPAPI의 범위';
          document.getElementById('msg').append(p);
        }""")
        self.wait_layer("review", ["DPAPI", "DPAPI"])
        self.page.evaluate("document.getElementById('p1').textContent = '교체된 답변'")
        self.wait_layer("favorite", [])

    def test_renderer_replacement_keeps_highlights_off(self):
        self.page.evaluate("window.__cxmVocabHighlight.setOn(false)")
        self.replace_renderer()
        self.page.wait_for_timeout(250)
        self.assertIsNone(self.terms())
        self.assertIsNone(self.layer("favorite"))
        self.assertFalse(self.page.evaluate("window.__cxmVocabHighlight.on"))
        self.page.evaluate("window.__cxmVocabHighlight.setOn(true)")
        self.wait_layer("favorite", ["SELinux"])
        self.wait_layer("review", ["DPAPI"])

    def test_deferred_renderer_replacement_reconnects_styles(self):
        self.page.evaluate("window.dispatchEvent(new CustomEvent('codex-labels:open-vocabulary', {detail:{kind:'word'}}))")
        self.page.locator("#cdx-vocabulary .vb-close").wait_for()
        self.page.evaluate("window.__oldPaint = CSS.highlights.get('codex-vocabulary-saved')")
        self.replace_renderer()
        self.assertTrue(self.page.evaluate("CSS.highlights.get('codex-vocabulary-saved') === window.__oldPaint"))
        # Reinjecting the style module before the dialog closes must also work.
        self.page.add_script_tag(content=read("labels/vocab-highlight.js"))
        self.page.locator("#cdx-vocabulary .vb-close").click()
        self.page.wait_for_function("CSS.highlights.get('codex-vocabulary-saved') !== window.__oldPaint")
        self.wait_terms(["SELinux", "DPAPI", "단어장"])
        self.wait_layer("favorite", ["SELinux"])
        self.wait_layer("review", ["DPAPI"])

    def test_latest_vocabulary_read_wins(self):
        self.page.evaluate("""() => {
          window.__cxmVocabHighlight.destroy();
          window.__kindReads = []; window.__kindChanges = new Set();
          window.codexLabels.vocabularyRead = () => new Promise(resolve => window.__kindReads.push(resolve));
          window.codexLabels.onVocabularyChanged = fn => { window.__kindChanges.add(fn); return () => window.__kindChanges.delete(fn); };
        }""")
        self.page.add_script_tag(content=read("labels/vocab-highlight.js"))
        self.page.evaluate("""() => {
          window.__kindChanges.forEach(fn => fn());
          window.__kindReads[1]({entries: [{term: 'SELinux', favorite: true}]});
        }""")
        self.wait_layer("favorite", ["SELinux"])
        self.page.evaluate("window.__kindReads[0]({entries: [{term: 'SELinux', status: 'new'}]})")
        self.page.wait_for_timeout(100)
        self.assertEqual(self.layer("favorite"), ["SELinux"])

    def test_destroy_cancels_deferred_mount_and_read(self):
        self.page.evaluate("""() => {
          window.__cxmVocabHighlight.destroy();
          window.codexLabels.vocabularyRead = () => new Promise(resolve => { window.__pendingKindRead = resolve; });
        }""")
        self.page.add_script_tag(content=read("labels/vocab-highlight.js"))
        self.page.evaluate("""() => {
          window.dispatchEvent(new Event('codex-labels:open-settings'));
          window.__cxmVocabHighlight.destroy();
          const dialog = document.createElement('dialog'); dialog.id = 'cdx-label-settings';
          const panel = document.createElement('section'); panel.id = 'cdx-settings-panel-vocabulary';
          dialog.append(panel); document.body.append(dialog);
          window.__pendingKindRead({entries: [{term: 'SELinux', favorite: true}]});
        }""")
        self.page.wait_for_timeout(100)
        self.assertEqual(self.page.locator(".cxm-vhl-settings").count(), 0)
        self.assertIsNone(self.layer("favorite"))

    def test_library_toggle_and_settings_panel(self):
        self.page.evaluate("window.dispatchEvent(new CustomEvent('codex-labels:open-vocabulary', {detail: {kind: 'word'}}))")
        sel = self.page.locator("#cdx-vocabulary .vb-filters .cxm-vhl select")
        sel.wait_for(timeout=3000)
        self.assertEqual(sel.input_value(), "on")
        sel.select_option("off")
        self.assertFalse(self.page.evaluate("window.__cxmVocabHighlight.on"))
        self.assertIsNone(self.terms())
        sel.select_option("on")
        # '스타일…' 은 공통 설정 창의 단어장·메모 탭을 연다 (여기서는 그 창 대신 가짜 패널로 확인)
        opened = self.page.evaluate("""() => new Promise(r => { window.addEventListener('codex-labels:open-settings', e => r(e.detail.tab), {once: true});
          document.querySelector('#cdx-vocabulary .cxm-vhl button').click(); })""")
        self.assertEqual(opened, "vocabulary")
        self.page.evaluate("""() => { const d = document.createElement('dialog'); d.id = 'cdx-label-settings';
          const p = document.createElement('section'); p.id = 'cdx-settings-panel-vocabulary'; d.append(p); document.body.append(d); d.show(); }""")
        rows = self.page.locator("#cdx-label-settings .cxm-vhl-row")
        rows.first.wait_for(timeout=3000)
        self.assertEqual(rows.count(), 4)
        fav = self.page.locator("#cdx-label-settings .cxm-vhl-row[data-kind=favorite]")
        fav.locator("select").first.select_option("double")
        self.assertIn("double", self.rule("cxm-vhl-favorite"))
        self.assertIn("double", fav.locator(".cxm-vhl-sample").get_attribute("style"))
        fav.locator("input[type=range]").fill("50")
        self.assertIn("0.5", self.rule("cxm-vhl-favorite"))
        self.page.evaluate("document.querySelector('#cdx-label-settings .cxm-vhl-actions button').click()")
        self.assertEqual(fav.locator("select").first.input_value(), "solid")


if __name__ == "__main__":
    unittest.main()
