"""Codex 가 일반 모드로 켜졌을 때 묻는 조건 검사 (App.on_codex_state). 화면·Codex 는 쓰지 않는다.

실행: python -m unittest tests/test_watch.py -v
"""

import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from codex_memo import App, WATCH_CONFIRM


def fake_app():
    app = SimpleNamespace(plain_seen=0, declined=frozenset(), quiet_until=0.0, restarting=False, asked=[])
    app.ask_restart = lambda pids: (app.asked.append(pids), setattr(app, "plain_seen", 0))
    return app


def tick(app, pids, memo_mode=False):
    App.on_codex_state(app, frozenset(pids), memo_mode)


class WatchTests(unittest.TestCase):
    def test_asks_after_consecutive_plain_checks(self):
        app = fake_app()
        for _ in range(WATCH_CONFIRM - 1):
            tick(app, {1, 2})
        self.assertEqual(app.asked, [], "한 번 보고 바로 묻지 않는다")
        tick(app, {1, 2})
        self.assertEqual(app.asked, [frozenset({1, 2})])

    def test_memo_mode_or_not_running_resets(self):
        app = fake_app()
        tick(app, {1})
        tick(app, {1}, memo_mode=True)      # 메모 모드로 켜짐
        tick(app, {1})
        self.assertEqual(app.asked, [])
        tick(app, set())                    # Codex 꺼짐
        tick(app, {5})
        self.assertEqual(app.asked, [])

    def test_declined_codex_is_not_asked_again_until_relaunch(self):
        app = fake_app()
        app.declined = frozenset({1, 2})
        for _ in range(5):
            tick(app, {1, 2, 3})            # 같은 Codex (자식 프로세스만 늘어남)
        self.assertEqual(app.asked, [])
        for _ in range(WATCH_CONFIRM):
            tick(app, {7, 8})               # 업데이트 등으로 새로 켜진 Codex
        self.assertEqual(app.asked, [frozenset({7, 8})])

    def test_quiet_while_restarting_or_just_launched(self):
        app = fake_app()
        app.restarting = True
        for _ in range(5):
            tick(app, {1})
        app.restarting = False
        app.quiet_until = time.time() + 60
        for _ in range(5):
            tick(app, {1})
        self.assertEqual(app.asked, [])


if __name__ == "__main__":
    unittest.main()
