"""Learning status edits in hover and click previews, with revision-safe fake storage."""
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MOCK = """
window.entries=[{id:'a',term:'라우팅',meaning:'첫 뜻',partOfSpeech:'명사',status:'new',tags:['개발'],previewParagraphs:['첫 뜻']},
 {id:'b',term:'라우팅',meaning:'다른 뜻',status:'review'}];
window.rev=1;window.calls=[];window.subs=new Set();
window.codexLabels={
 vocabularyRead:async()=>JSON.parse(JSON.stringify({revision:String(rev),entries})),
 onVocabularyChanged:fn=>{subs.add(fn);return()=>subs.delete(fn)},
 vocabularyEdit:async(id,patch,revision)=>{
   calls.push({id,patch,revision});await new Promise(r=>setTimeout(r,60));
   if(window.fail)throw Error('저장 실패 테스트');
   if(window.conflict){rev++;window.conflict=false;}
   if(revision!==String(rev))throw Error('다른 창에서 변경되었습니다');
   Object.assign(entries.find(e=>e.id===id),patch);rev++;
   setTimeout(()=>subs.forEach(f=>f()),10);
   return JSON.parse(JSON.stringify({revision:String(rev),entries}));
 },vocabularyCancel:async()=>true,
 vocabularyParagraph:async(id,paragraph,revision)=>{if(window.fail)throw Error('재분석 실패 테스트');const original=entries.find(e=>e.id===id);
   return (window.lastDraft={...JSON.parse(JSON.stringify(original)),...window.CodexVocabContent.replaceParagraph(original,paragraph,'재분석 결과'),targetId:id,baseRevision:revision,action:'reanalyze'});},
 vocabularySave:async(id,revision,options)=>{if(revision!==String(rev))throw Error('revision conflict');Object.assign(entries.find(e=>e.id===id),lastDraft,options.edits);rev++;return JSON.parse(JSON.stringify({revision:String(rev),entries}));}
};
"""

class PreviewStatusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(channel='chrome', headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width': 700, 'height': 600})
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.set_content('<main><div data-selected-text-overlay-target><p id="word">라우팅 설정입니다.</p></div></main>')
        self.page.add_script_tag(content=MOCK)
        for name in ['labels/common.js', 'labels/vocabulary-content.js',
                     'labels/vendor/vocabulary-renderer.js', 'labels/hover-card.js']:
            self.page.add_script_tag(content=(ROOT / name).read_text(encoding='utf-8'))
        self.page.wait_for_function("CSS.highlights.get('codex-vocabulary-saved')?.size")

    def tearDown(self):
        self.assertEqual(self.errors, [])
        self.page.close()

    def open_preview(self, kind):
        self.page.keyboard.press('Escape')
        self.page.mouse.move(650, 550)
        self.page.wait_for_timeout(220)
        box = self.page.evaluate("""() => {const n=document.querySelector('#word').firstChild,r=new Range();
          r.setStart(n,0);r.setEnd(n,3);const b=r.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}}""")
        self.page.mouse.move(box['x'], box['y'])
        if kind == 'click':
            self.page.mouse.click(box['x'], box['y'])
        root = '.cxm-hover.cxm-on' if kind == 'hover' else '#cdx-vocabulary-inline'
        self.page.locator(root).wait_for(state='visible')
        return self.page.locator(root)

    def test_save_preserves_fields_and_reopens(self):
        for kind in ['hover', 'click']:
            with self.subTest(kind=kind):
                self.page.evaluate("entries[0].meaning='다른 창에서 바꾼 뜻';rev++")
                root = self.open_preview(kind)
                select = root.locator('select').first
                for state in ['known', 'review', 'new']:
                    select.select_option(state)
                    self.page.wait_for_function('(s)=>entries[0].status===s', arg=state)
                    self.page.wait_for_timeout(130)
                    self.assertEqual(root.locator('select').first.input_value(), state)
                select = root.locator('select').nth(1)
                select.select_option('known')
                self.page.wait_for_function("entries[1].status==='known'")
                self.page.wait_for_timeout(130)
                self.assertEqual(self.page.evaluate('entries[0].meaning'), '다른 창에서 바꾼 뜻')
                self.assertEqual(self.page.evaluate('entries[0].tags'), ['개발'])
                self.assertEqual(self.page.evaluate('entries[0].previewParagraphs'), ['첫 뜻'])
                self.assertTrue(self.page.evaluate("calls.every(c=>Object.keys(c.patch).join(',')==='status')"))
                root = self.open_preview(kind)
                self.assertEqual(root.locator('select').nth(1).input_value(), 'known')

    def test_failure_and_conflict_restore_selection(self):
        for kind in ['hover', 'click']:
            for flag in ['fail', 'conflict']:
                with self.subTest(kind=kind, flag=flag):
                    root = self.open_preview(kind)
                    self.page.evaluate('(flag)=>window[flag]=true', flag)
                    root.locator('select').first.select_option('known')
                    self.page.wait_for_function("calls.length && !document.querySelector('select:disabled')")
                    self.page.wait_for_timeout(150)
                    self.assertEqual(root.locator('select').first.input_value(), 'new')
                    self.assertEqual(self.page.evaluate('entries[0].status'), 'new')
                    self.assertIn('실패' if flag == 'fail' else '다른 창', root.inner_text())
                    self.page.evaluate('(flag)=>window[flag]=false', flag)

    def test_hover_keyboard_focus_keeps_card_open(self):
        root = self.open_preview('hover')
        root.locator('select').first.focus()
        self.page.mouse.move(650, 550)
        self.page.wait_for_timeout(350)
        self.assertTrue(root.is_visible())
        self.page.keyboard.press('ArrowDown')
        self.page.wait_for_function("entries[0].status==='review'")
        self.page.keyboard.press('Escape')
        self.assertEqual(self.page.locator('.cxm-hover.cxm-on').count(), 0)

    def test_context_save_visibility_and_unsaved_input(self):
        root = self.open_preview('click')
        root.get_by_role('button', name='단어장 열기').first.click()
        dialog = self.page.locator('#cdx-vocabulary')
        self.assertEqual(dialog.locator('.vb-analysis .vb-label').first.inner_text(), '맥락분석')
        self.page.get_by_label('새 문장', exact=True).fill('라우팅은 새 화면을 고릅니다.')
        self.page.get_by_label('새 문장 맥락분석', exact=True).fill('새 주소에 맞는 화면 선택')
        dialog.get_by_role('button', name='맥락분석 저장', exact=True).click()
        self.page.wait_for_function('entries[0].contextAnalyses?.length===1')
        self.assertEqual(self.page.evaluate('entries[0].meaning'), '첫 뜻')
        dialog.locator('[data-analysis-visible="base"]').first.uncheck()
        self.page.wait_for_function('entries[0].showContextAnalysis===false')
        dialog.locator('[data-analysis-visible]:not([data-analysis-visible="base"])').uncheck()
        self.page.wait_for_function('entries[0].contextAnalyses[0].visible===false')
        self.page.get_by_label('새 문장', exact=True).fill('저장 전 문장')
        self.page.get_by_label('새 문장 맥락분석', exact=True).fill('저장 전 분석')
        dialog.locator('.vb-navigation').get_by_role('button').first.click()
        dialog.locator('.vb-card button:text-is("열기")').first.click()
        self.assertEqual(self.page.get_by_label('새 문장', exact=True).input_value(), '저장 전 문장')
        dialog.get_by_role('button', name='입력 비우기', exact=True).click()
        dialog.get_by_role('button', name='단어장·메모 닫기').click()
        root = self.open_preview('hover')
        self.assertNotIn('첫 뜻', root.inner_text())
        self.assertNotIn('새 주소에 맞는 화면 선택', root.inner_text())
        self.assertEqual(self.page.evaluate('entries[0].contextAnalyses[0].analysis'), '새 주소에 맞는 화면 선택')

    def test_paragraph_actions_are_staged_and_toolbar_stays_visible(self):
        root=self.open_preview('click')
        root.get_by_role('button',name='단어장 열기').first.click()
        dialog=self.page.locator('#cdx-vocabulary')
        dialog.get_by_role('button',name='맥락분석 삭제: 첫 뜻',exact=True).click()
        self.assertEqual(self.page.evaluate('entries[0].meaning'),'첫 뜻')
        dialog.locator('.vb-primary').click()
        self.page.wait_for_function("entries[0].meaning===''")
        dialog.get_by_role('button',name='품사 재분석: 명사',exact=True).click()
        self.page.wait_for_function("document.querySelector('.vb-pos .vb-paragraph-text')?.textContent==='재분석 결과'")
        self.assertEqual(self.page.evaluate('entries[0].partOfSpeech'),'명사')
        dialog.locator('.vb-primary').click()
        self.page.wait_for_function("entries[0].partOfSpeech==='재분석 결과'")
        self.assertEqual(self.page.evaluate('entries[0].followups || []'),[])
        self.page.evaluate("document.querySelector('.vb-analysis').style.minHeight='1400px';document.querySelector('#cdx-vocabulary').scrollTop=900")
        self.assertTrue(dialog.locator('.vb-topbar').is_visible())
        position=dialog.locator('.vb-topbar').bounding_box()
        self.assertGreaterEqual(position['y'],0)
        self.assertLess(position['y'],400)

if __name__ == '__main__':
    unittest.main()
