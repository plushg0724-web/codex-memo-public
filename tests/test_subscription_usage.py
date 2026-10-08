"""구독 할당량 표시: 실제 Chromium에서 환산 표시·저장·실패·재주입·주기 갱신 검증."""
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = (ROOT / 'labels/subscription-usage.js').read_text(encoding='utf-8')
FIXTURE = """
window.__calls = []; window.__fail = false; window.__fee = 159000; window.__percent = 32;
window.__codexMemoBridge = raw => {
  const m = JSON.parse(raw); window.__calls.push(m);
  if (m.method === 'subscriptionFeeSet') window.__fee = m.args[0];
  const budget = window.__fee * 7 / 30;
  const value = m.method === 'subscriptionFeeSet' ? window.__fee : {
    status: 'ready', feeKrw: window.__fee, periodDays: 30, dailyKrw: window.__fee/30,
    observedAt: Date.now(), message: '', window: {usedPercent: window.__percent,
      windowDurationMins:10080, resetsAt:Math.floor(Date.now()/1000)+3600,
      budgetKrw:Math.round(budget), usedKrw:Math.round(budget*window.__percent/100),
      remainingKrw:Math.round(budget*(1-window.__percent/100)), subscriptionPercent:window.__percent*7/30}
  };
  setTimeout(() => window.__cxmUsage?.resolve(m.id, !window.__fail, window.__fail ? '연결 실패' : value), 5);
};
"""


class SubscriptionUsageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(channel='chrome', headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width': 900, 'height': 720})
        self.addCleanup(self.page.close)
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.set_content('<html><body style="background:#202020;color:#eee"><nav class="sidebar-navigation" style="width:260px"><div>대화 목록</div></nav></body></html>')
        self.page.add_script_tag(content=FIXTURE)
        self.page.add_script_tag(content=(ROOT / 'labels/common.js').read_text(encoding='utf-8'))
        self.page.add_script_tag(content=SCRIPT)
        self.page.wait_for_function("document.querySelector('.cxm-subscription')?.textContent.includes('11,872')")

    def open(self):
        self.page.locator('.cxm-subscription').click()
        self.page.wait_for_selector('#cxm-subscription-dialog[open]')

    def test_amount_and_period_are_explicit(self):
        self.assertIn('7.47%', self.page.locator('.cxm-subscription').inner_text())
        self.assertIn('이번 7일 사용분', self.page.locator('.cxm-subscription').inner_text())
        self.open()
        text = self.page.locator('#cxm-subscription-dialog').inner_text()
        for expected in ('37,100', '25,228', '5,300', '32% 사용 / 68% 남음', '전체 30일 누계'):
            self.assertIn(expected, text)
        output = ROOT / 'output/playwright/subscription-usage'
        output.mkdir(parents=True, exist_ok=True)
        self.page.screenshot(path=str(output / 'meter-dialog.png'))
        self.assertEqual(self.errors, [])

    def test_draft_survives_refresh_then_fee_save_recalculates(self):
        self.open()
        self.page.locator('#cxm-usage-fee').fill('300000')
        self.page.get_by_role('button', name='지금 갱신').click()
        self.page.wait_for_function('window.__cxmUsage && !document.querySelector(".cxm-usage-actions button").disabled')
        self.assertEqual(self.page.locator('#cxm-usage-fee').input_value(), '300000')
        self.page.get_by_role('button', name='저장', exact=True).click()
        self.page.wait_for_function("document.querySelector('.cxm-usage-amount').textContent.includes('22,400')")
        self.assertIn('7.47%', self.page.locator('.cxm-usage-amount').inner_text())
        self.page.keyboard.press('Escape')
        self.page.wait_for_selector('#cxm-subscription-dialog', state='detached')
        self.open()
        self.assertEqual(self.page.locator('#cxm-usage-fee').input_value(), '300000')

    def test_failure_preserves_old_amount_with_stale_marker_and_recovers(self):
        self.page.evaluate('window.__fail = true; window.__cxmSubscription.refresh(true)')
        badge = self.page.locator('.cxm-subscription')
        self.assertIn('11,872', badge.inner_text())
        self.assertIn('이전 값', badge.inner_text())
        self.page.evaluate('window.__fail = false; window.__percent = 33; window.__cxmSubscription.refresh(true)')
        self.assertIn('12,243', badge.inner_text())
        self.assertNotIn('이전 값', badge.inner_text())

    def test_reinjection_does_not_duplicate_and_sidebar_rebuild_reattaches(self):
        self.page.add_script_tag(content=SCRIPT)
        self.assertEqual(self.page.locator('.cxm-subscription').count(), 1)
        self.page.evaluate("document.querySelector('.sidebar-navigation').innerHTML='<div>다시 그린 목록</div>'; window.__cxmSubscription.attach()")
        self.assertEqual(self.page.locator('.sidebar-navigation .cxm-subscription').count(), 1)
        self.page.evaluate('window.__cxmSubscription.destroy()')
        self.assertEqual(self.page.locator('.cxm-subscription').count(), 0)
        self.page.add_script_tag(content=SCRIPT)
        self.page.wait_for_selector('.cxm-subscription')
        self.assertEqual(self.errors, [])

    def test_polling_updates_without_clicking(self):
        self.page.clock.install()
        # Reinstall after fake timers are active.
        self.page.evaluate('window.__cxmSubscription.destroy()')
        self.page.add_script_tag(content=SCRIPT)
        self.page.clock.run_for(20)
        self.page.evaluate('window.__percent = 34')
        self.page.clock.run_for(15020)
        self.assertIn('12,614', self.page.locator('.cxm-subscription').inner_text())


if __name__ == '__main__':
    unittest.main()
