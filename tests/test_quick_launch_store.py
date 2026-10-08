"""바로 실행 목록의 저장 실패·무변경·동시 변경 회귀 검사. 프로그램이나 UI는 실행하지 않는다."""

import json
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import socket
import time
from quick_launch import QuickLaunch, open_ports


class QuickLaunchStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.script = self.directory / "unused.cmd"
        self.script.write_text("@echo off\n", encoding="utf-8")
        self.path = self.directory / "shortcuts.json"
        self.launcher = QuickLaunch(str(self.path), str(self.directory / "logs"), legacy=())
        self.first = self.launcher.save(self.fields("first"))
        self.second = self.launcher.save(self.fields("second"))
        self.listener = Mock()
        self.launcher.subscribe(self.listener)

    def fields(self, name):
        return {"name": name, "path": str(self.script)}

    def test_failed_add_update_remove_and_move_preserve_memory_and_disk(self):
        operations = {
            "add": lambda: self.launcher.save(self.fields("third")),
            "update": lambda: self.launcher.save(self.fields("changed"), self.first["id"]),
            "remove": lambda: self.launcher.remove(self.first["id"]),
            "move": lambda: self.launcher.move(self.second["id"], -1),
        }
        original = self.launcher.list()
        data = self.path.read_bytes()
        for name, operation in operations.items():
            with self.subTest(operation=name), patch("quick_launch.os.replace", side_effect=OSError("disk unavailable")):
                with self.assertRaises(OSError):
                    operation()
                self.assertEqual(self.launcher.list(), original)
                self.assertEqual(self.path.read_bytes(), data)
                self.listener.assert_not_called()
        # 실패했던 변경이 이후 성공한 저장에 섞이지 않아야 한다.
        self.launcher.save(self.fields("third"))
        self.assertEqual([item["name"] for item in self.launcher.list()], ["first", "second", "third"])
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), self.launcher.list())
        self.listener.assert_called_once()

    def test_backup_failure_preserves_saved_and_in_memory_list(self):
        original = self.launcher.list()
        data = self.path.read_bytes()
        with patch("quick_launch.shutil.copyfile", side_effect=OSError("backup failed")):
            with self.assertRaises(OSError):
                self.launcher.remove(self.first["id"])
        self.assertEqual(self.launcher.list(), original)
        self.assertEqual(self.path.read_bytes(), data)
        self.listener.assert_not_called()

    def test_noop_operations_skip_file_writes_but_keep_completion_notifications(self):
        with patch.object(self.launcher, "_write", wraps=self.launcher._write) as write:
            self.launcher.save(self.fields("first"), self.first["id"])
            self.launcher.remove("missing")
            self.launcher.move(self.first["id"], -1)
            self.launcher.move("missing", 1)
            write.assert_not_called()
        self.assertEqual(self.listener.call_count, 3)

    def test_saved_return_values_and_list_reads_do_not_change_internal_state(self):
        self.first["name"] = "unsaved returned value"
        read = self.launcher.list()
        read[0]["name"] = "unsaved list value"
        item = self.launcher.get(self.first["id"])
        item["name"] = "unsaved get value"
        self.assertEqual(self.launcher.list()[0]["name"], "first")
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))[0]["name"], "first")

    def test_successful_updates_preserve_order_and_backup(self):
        before = self.path.read_bytes()
        self.launcher.save(self.fields("renamed"), self.first["id"])
        self.assertEqual(Path(str(self.path) + ".bak").read_bytes(), before)
        self.launcher.move(self.second["id"], -1)
        self.assertEqual([item["name"] for item in self.launcher.list()], ["second", "renamed"])
        self.launcher.remove(self.first["id"])
        self.assertEqual(self.launcher.list(), [self.second])
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), [self.second])
        self.assertEqual(self.listener.call_count, 3)

    def test_concurrent_additions_are_not_lost(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(lambda n: self.launcher.save(self.fields(str(n))), range(20)))
        names = {item["name"] for item in self.launcher.list()}
        self.assertEqual(names, {"first", "second"} | {str(n) for n in range(20)})
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), self.launcher.list())


class PortProbeTests(unittest.TestCase):
    def test_open_ports_checks_together_and_matches_saved_values(self):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen()
        self.addCleanup(server.close)
        live = server.getsockname()[1]
        closed = [socket.socket() for _ in range(4)]
        for s in closed:
            s.bind(("127.0.0.1", 0))
        ports = [s.getsockname()[1] for s in closed]
        for s in closed:
            s.close()   # 바인드만 했다가 닫아 응답하지 않는 포트
        started = time.monotonic()
        found = open_ports([live, str(live), *ports, 0, None, "", "bad", 70000])
        elapsed = time.monotonic() - started
        self.assertEqual(found, {live})
        # 닫힌 포트 4개를 차례로 기다리면 0.6초 이상 걸린다
        self.assertLess(elapsed, 0.5)
        launcher = QuickLaunch.__new__(QuickLaunch)
        launcher.runs = {}
        self.assertEqual(launcher.state({"id": "a", "port": str(live)}, found), "port")
        self.assertEqual(launcher.state({"id": "b", "port": ports[0]}, found), "idle")

if __name__ == "__main__":
    unittest.main()
