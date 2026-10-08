"""저장소 캐시·외부 변경·백엔드 전송 회귀 검사. 실제 개인 데이터/백엔드는 사용하지 않는다."""

import io
import json
import os
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from memo_store import MemoStore
from cdp_bridge import BINDING, LabelsBackend, Bridge, Session


class MemoStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = MemoStore(self.temp.name)
        self.listener = Mock()
        self.store.subscribe(self.listener)

    def write_external(self, memos):
        temp = self.store.path + ".external"
        Path(temp).write_text(json.dumps(memos, ensure_ascii=False), encoding="utf-8")
        os.replace(temp, self.store.path)

    def test_repeated_reads_and_returned_values_are_independent(self):
        self.write_external([{"id": "old", "note": "외부 메모", "extra": {"tags": ["a"]}}])
        with patch("memo_store.json.load", wraps=json.load) as read:
            first = self.store.load()
            first[0]["extra"]["tags"].append("b")
            first[0]["note"] = "저장되지 않은 변경"
            self.assertEqual(self.store.load()[0]["note"], "외부 메모")
            self.assertEqual(self.store.load()[0]["extra"]["tags"], ["a"])
            self.assertEqual(read.call_count, 1)

    def test_add_update_remove_preserve_json_and_markdown(self):
        memo = self.store.add({"title": "대화", "quote": "첫 줄\n둘째 줄", "note": "메모"})
        memo["note"] = "반환값 수정"
        self.assertEqual(self.store.load()[0]["note"], "메모")
        self.store.update(memo["id"], "새 메모")
        self.assertEqual(json.loads(Path(self.store.path).read_text(encoding="utf-8"))[0]["note"], "새 메모")
        self.assertIn("> 첫 줄\n> 둘째 줄", Path(self.store.md_path).read_text(encoding="utf-8"))
        self.store.remove(memo["id"])
        self.assertEqual(self.store.load(), [])
        self.assertEqual(self.listener.call_count, 3)
        self.store.poll_external()
        self.assertEqual(self.listener.call_count, 3)

    def test_noop_changes_skip_disk_but_preserve_completion_notifications(self):
        memo = self.store.add({"note": "같은 메모"})
        self.listener.reset_mock()
        with patch.object(self.store, "_save", wraps=self.store._save) as save:
            self.store.update(memo["id"], "같은 메모")
            self.store.update("missing", "변경")
            self.store.remove("missing")
            save.assert_not_called()
        # 화면의 저장 완료/편집 종료는 기존 변경 알림을 사용한다.
        self.assertEqual(self.listener.call_count, 3)

    def test_external_replace_same_size_and_timestamp_is_detected(self):
        self.write_external([{"note": "aaaa"}])
        self.assertEqual(self.store.load()[0]["note"], "aaaa")
        stat = os.stat(self.store.path)
        temp = self.store.path + ".external"
        Path(temp).write_text('[{"note": "bbbb"}]', encoding="utf-8")
        os.utime(temp, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        os.replace(temp, self.store.path)
        self.assertEqual(self.store.load()[0]["note"], "bbbb")
        self.store.poll_external()
        self.store.poll_external()
        self.listener.assert_called_once()

    def test_in_place_external_edit_is_detected(self):
        self.write_external([{"note": "old"}])
        self.store.load()
        stat = os.stat(self.store.path)
        Path(self.store.path).write_text('[{"note": "new"}]', encoding="utf-8")
        os.utime(self.store.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000))
        self.store.poll_external()
        self.assertEqual(self.store.load()[0]["note"], "new")

    def test_deleted_and_invalid_files_can_recover(self):
        self.write_external([{"note": "old"}])
        self.store.load()
        os.remove(self.store.path)
        self.assertEqual(self.store.load(), [])
        Path(self.store.path).write_text("{broken", encoding="utf-8")
        self.assertEqual(self.store.load(), [])
        self.write_external([{"note": "recovered"}])
        self.assertEqual(self.store.load()[0]["note"], "recovered")

    def test_markdown_copy_failure_keeps_json_save_and_notification(self):
        os.makedirs(self.store.md_path)   # 다른 프로그램이 잠근 것처럼 memos.md 를 쓸 수 없는 상태
        memo = self.store.add({"note": "메모"})
        self.assertEqual(json.loads(Path(self.store.path).read_text(encoding="utf-8"))[0]["id"], memo["id"])
        self.listener.assert_called_once()
        self.assertFalse(os.path.exists(self.store.md_path + ".tmp"))

    def test_markdown_tolerates_externally_edited_entries(self):
        self.write_external([{"id": "old", "note": None}, {"id": "bare"}])
        self.store.add({"note": "새 메모", "quote": "인용"})
        text = Path(self.store.md_path).read_text(encoding="utf-8")
        self.assertIn("새 메모", text)
        self.assertIn("> 인용", text)
        self.assertEqual(len(self.store.load()), 3)

    def test_external_restore_updates_markdown_before_notification(self):
        self.store.add({"note": "before-restore"})
        observed = []
        self.store.subscribe(lambda: observed.append(Path(self.store.md_path).read_text(encoding="utf-8")))
        self.write_external([{"id": "restored", "note": "after-restore"}])
        self.store.poll_external()
        self.assertEqual(self.store.load()[0]["id"], "restored")
        self.assertIn("after-restore", observed[0])
        self.assertNotIn("before-restore", observed[0])
        with patch("memo_store.json.load", wraps=json.load) as read:
            self.store.poll_external()
            read.assert_not_called()

    def test_startup_recreates_missing_or_stale_markdown(self):
        self.write_external([{"note": "restored-at-startup"}])
        MemoStore(self.temp.name)
        self.assertIn("restored-at-startup", Path(self.store.md_path).read_text(encoding="utf-8"))
        Path(self.store.md_path).write_text("stale", encoding="utf-8")
        os.utime(self.store.md_path, ns=(1, 1))
        MemoStore(self.temp.name)
        self.assertIn("restored-at-startup", Path(self.store.md_path).read_text(encoding="utf-8"))

    def test_incomplete_external_json_preserves_last_markdown(self):
        self.store.add({"note": "last-readable"})
        Path(self.store.path).write_text("{incomplete", encoding="utf-8")
        self.store.poll_external()
        self.assertIn("last-readable", Path(self.store.md_path).read_text(encoding="utf-8"))
        self.write_external([{"note": "recovered"}])
        self.store.poll_external()
        self.assertIn("recovered", Path(self.store.md_path).read_text(encoding="utf-8"))

    def test_concurrent_additions_are_not_lost(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(lambda i: self.store.add({"note": str(i)}), range(20)))
        self.assertEqual({m["note"] for m in self.store.load()}, {str(i) for i in range(20)})
        self.assertEqual(len(json.loads(Path(self.store.path).read_text(encoding="utf-8"))), 20)

    def test_category_save_and_update_preserve_note_and_old_fields(self):
        memo = self.store.add({"note": "메모", "category": "idea"})
        self.store.update(memo["id"], category="todo")
        self.assertEqual(self.store.load()[0]["note"], "메모")
        self.assertEqual(self.store.load()[0]["category"], "todo")
        self.store.update(memo["id"], "내용 수정")
        self.assertEqual(self.store.load()[0]["category"], "todo")
        self.store.update(memo["id"], category="invalid")
        self.assertEqual(self.store.load()[0]["category"], "todo")
        old = self.store.load()[0]
        old.pop("category")
        old["extra"] = "기존 필드"
        self.write_external([old])
        self.store.update(memo["id"], category="reference")
        stored = json.loads(Path(self.store.path).read_text(encoding="utf-8"))[0]
        self.assertEqual(stored["category"], "reference")
        self.assertEqual(stored["extra"], "기존 필드")
        self.store.update(memo["id"], category="")
        self.assertEqual(self.store.load()[0]["category"], "")


class MemoClassificationBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.bridge = Bridge.__new__(Bridge)
        self.bridge.store = MemoStore(self.temp.name)
        self.bridge.sessions = {}
        self.bridge.labels = SimpleNamespace(request=self.request, call=Mock())
        self.calls = []
        self.requested = threading.Event()
        self.timer = Mock()
        self.timer_patch = patch("cdp_bridge.threading.Timer", return_value=self.timer)
        self.timer_factory = self.timer_patch.start()
        self.addCleanup(self.timer_patch.stop)
        self.session = SimpleNamespace(eval=Mock())

    def request(self, method, args, callback=None):
        self.calls.append((method, args, callback))
        if method == "memoClassify":
            self.requested.set()

    def add(self):
        self.bridge.handle(self.session, {"op": "add", "note": "해야 할 일", "quote": "인용", "title": "대화"})
        self.assertTrue(self.requested.wait(2))
        return self.bridge.store.load()[0]

    def finish(self, result=None):
        self.calls[0][2](True, result or {"category": "todo", "confidence": 0.9})

    def sheet_rows(self):
        return [args[0] for method, args, _ in self.calls if method == "sheetsAppendMemo"]

    def test_add_is_saved_before_classification_and_sheet_uses_result_once(self):
        memo = self.add()
        self.assertEqual(memo["category"], "")
        self.assertEqual(self.sheet_rows(), [])
        self.finish()
        self.timer_factory.call_args.args[1]()
        self.assertEqual(self.bridge.store.load()[0]["category"], "todo")
        self.assertEqual(len(self.sheet_rows()), 1)
        self.assertEqual(self.sheet_rows()[0]["category"], "todo")

    def test_timeout_sends_once_and_late_result_still_updates_local_store(self):
        self.add()
        self.assertEqual(self.timer_factory.call_args.args[0], 3)
        self.timer_factory.call_args.args[1]()
        self.finish()
        self.assertEqual(len(self.sheet_rows()), 1)
        self.assertEqual(self.sheet_rows()[0]["category"], "")
        self.assertEqual(self.bridge.store.load()[0]["category"], "todo")

    def test_manual_category_and_note_edits_reject_pending_result(self):
        memo = self.add()
        self.bridge.handle(self.session, {"op": "update", "id": memo["id"], "category": "idea"})
        self.finish()
        self.assertEqual(self.bridge.store.load()[0]["category"], "idea")
        self.assertEqual(self.bridge.store.load()[0]["note"], "해야 할 일")
        self.assertEqual(self.sheet_rows()[0]["category"], "idea")
        self.assertEqual(len([m for m, _, _ in self.calls if m == "memoClassify"]), 1)

    def test_manual_unclassified_choice_also_rejects_pending_result(self):
        memo = self.add()
        self.bridge.handle(self.session, {"op": "update", "id": memo["id"], "category": ""})
        self.finish()
        self.assertEqual(self.bridge.store.load()[0]["category"], "")

    def test_changed_or_deleted_memo_is_not_overwritten(self):
        memo = self.add()
        self.bridge.store.update(memo["id"], "수정한 글")
        self.finish()
        self.assertEqual(self.bridge.store.load()[0]["category"], "")
        self.bridge.store.remove(memo["id"])
        self.finish()
        self.assertEqual(self.bridge.store.load(), [])

    def test_batch_uses_current_store_and_resolves_page_after_persistence(self):
        memo = self.bridge.store.add({"note": "실제 내용"})
        self.bridge.handle(self.session, {"op": "labels", "id": 7, "method": "memoClassify",
                                          "args": [{"id": memo["id"], "note": "오래된 화면 내용"}]})
        self.assertTrue(self.requested.wait(2))
        self.assertEqual(self.calls[0][1][0]["note"], "실제 내용")
        self.finish()
        self.assertEqual(self.bridge.store.load()[0]["category"], "todo")
        self.assertIn('resolve(7, true, {"category": "todo"', self.session.eval.call_args.args[0])
        self.assertEqual(self.sheet_rows(), [])

    def test_existing_category_and_note_edit_never_trigger_reclassification(self):
        memo = self.bridge.store.add({"note": "메모", "category": "question"})
        self.bridge.handle(self.session, {"op": "update", "id": memo["id"], "note": "수정"})
        self.bridge.handle(self.session, {"op": "labels", "id": 8, "method": "memoClassify", "args": [memo]})
        self.assertEqual(self.calls, [])
        self.assertEqual(self.bridge.store.load()[0]["category"], "question")
        self.assertIn("resolve(8, true, null)", self.session.eval.call_args.args[0])

    def test_backend_failure_still_sends_unclassified_memo(self):
        self.bridge.labels.request = Mock(side_effect=BrokenPipeError())
        self.bridge.handle(self.session, {"op": "add", "note": "메모"})
        # 별도 스레드의 예외 처리 완료를 기다린다.
        for _ in range(100):
            if self.bridge.labels.request.call_count >= 2:
                break
            threading.Event().wait(0.01)
        self.assertEqual(self.bridge.labels.request.call_count, 2)
        self.assertEqual(self.bridge.store.load()[0]["category"], "")

    def test_saved_manual_category_survives_backend_failure(self):
        self.bridge.labels.request = Mock(side_effect=BrokenPipeError())
        self.bridge.handle(self.session, {"op": "add", "note": "메모", "category": "idea"})
        self.assertEqual(self.bridge.store.load()[0]["category"], "idea")
        self.bridge.labels.request.assert_called_once()

    def test_unavailable_classifier_sends_unclassified_without_error(self):
        self.add()
        self.calls[0][2](True, None)
        self.assertEqual(self.bridge.store.load()[0]["category"], "")
        self.assertEqual(len(self.sheet_rows()), 1)

    def test_external_content_change_rejects_old_result(self):
        memo = self.add()
        memo["quote"] = "외부에서 바꾼 인용"
        Path(self.bridge.store.path).write_text(json.dumps([memo]), encoding="utf-8")
        self.finish()
        self.assertEqual(self.bridge.store.load()[0]["category"], "")

    def test_deleted_memo_is_neither_recreated_nor_sent_to_sheet(self):
        memo = self.add()
        self.bridge.handle(self.session, {"op": "delete", "id": memo["id"]})
        self.timer_factory.call_args.args[1]()
        self.finish()
        self.assertEqual(self.bridge.store.load(), [])
        self.assertEqual(self.sheet_rows(), [])


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.backend = LabelsBackend.__new__(LabelsBackend)
        self.backend.lock = threading.Lock()
        self.backend.calls = {}
        self.backend.n = 0
        self.backend.closed = False
        self.backend.on_event = Mock()
        self.backend.proc = SimpleNamespace(stdin=io.StringIO(), stdout=[])
        self.session = SimpleNamespace(target={"id": "page-1"}, eval=Mock())

    def test_page_and_helper_share_protocol_and_response_mapping(self):
        callback = Mock()
        self.backend.call(self.session, 7, "read", [], "__cxmPicker")
        self.backend.request("status", [], callback)
        rows = [json.loads(line) for line in self.backend.proc.stdin.getvalue().splitlines()]
        self.assertEqual(rows, [
            {"id": "1", "sender": "page-1", "method": "read", "args": []},
            {"id": "2", "sender": "helper", "method": "status", "args": []},
        ])
        self.backend.proc.stdout = ['{"id":"1","ok":true,"value":"메모"}',
                                    '{"id":"2","ok":false,"error":"오류"}']
        self.backend._read()
        self.assertIn("window.__cxmPicker.resolve(7, true", self.session.eval.call_args.args[0])
        callback.assert_called_once_with(False, "오류")
        self.assertEqual(self.backend.calls, {})

    def test_fire_and_forget_does_not_allocate_pending_callback(self):
        self.backend.request("sheetsAppendMemo", [{}])
        self.backend.call(self.session, None, "dispose", [])
        self.assertEqual(self.backend.calls, {})
        self.assertEqual(len(self.backend.proc.stdin.getvalue().splitlines()), 2)

    def test_write_failure_removes_pending_entry(self):
        self.backend.proc.stdin = Mock()
        self.backend.proc.stdin.flush.side_effect = BrokenPipeError()
        with self.assertRaises(BrokenPipeError):
            self.backend.request("status", [], Mock())
        self.assertEqual(self.backend.calls, {})

    def test_bad_callback_does_not_stop_other_responses(self):
        self.backend.request("first", [], Mock(side_effect=RuntimeError("callback failed")))
        callback = Mock()
        self.backend.request("second", [], callback)
        self.backend.proc.stdout = ['not-json', '{"id":"1","ok":true,"value":1}',
                                    '{"id":"2","ok":true,"value":2}']
        self.backend._read()
        callback.assert_called_once_with(True, 2)
        self.assertEqual(self.backend.calls, {})

    def test_dispose_only_removes_disconnected_page_requests(self):
        other = SimpleNamespace(target={"id": "page-2"}, eval=Mock())
        self.backend.call(self.session, 1, "read", [])
        self.backend.call(other, 2, "read", [])
        self.backend.request("helper", [], Mock())
        self.backend.dispose(self.session)
        self.assertEqual(set(self.backend.calls), {"2", "3"})

    def test_eof_fails_all_pending_requests_and_rejects_new_requests(self):
        callback = Mock()
        self.backend.request("first", [], Mock(side_effect=RuntimeError("bad callback")))
        self.backend.request("second", [], callback)
        self.backend.call(self.session, 7, "read", [], "__cxmPicker")
        self.backend._read()
        callback.assert_called_once_with(False, "라벨·단어장 백엔드 연결이 끊어졌습니다.")
        self.assertIn("resolve(7, false,", self.session.eval.call_args.args[0])
        self.assertEqual(self.backend.calls, {})
        with self.assertRaisesRegex(RuntimeError, "연결이 끊어"):
            self.backend.request("after-eof", [], Mock())
        self.assertEqual(len(self.backend.proc.stdin.getvalue().splitlines()), 3)

    def test_malformed_messages_and_event_errors_do_not_lose_later_responses(self):
        callback = Mock()
        self.backend.on_event.side_effect = RuntimeError("event failed")
        self.backend.request("read", [], callback)
        self.backend.proc.stdout = ["null", "[]", '"text"', '{"id":[]}',
                                    '{"event":"changed"}', '{"id":"1","ok":true,"value":7}']
        self.backend._read()
        callback.assert_called_once_with(True, 7)
        self.assertEqual(self.backend.calls, {})

    def test_failed_page_response_does_not_stop_helper_response(self):
        self.session.eval.side_effect = RuntimeError("page closed")
        self.backend.call(self.session, 1, "read", [])
        callback = Mock()
        self.backend.request("helper", [], callback)
        self.backend.proc.stdout = ['{"id":"1","ok":true}', '{"id":"2","ok":true,"value":7}']
        self.backend._read()
        callback.assert_called_once_with(True, 7)

    def test_pipe_read_failure_settles_pending_requests(self):
        def failed_pipe():
            yield 'not-json'
            raise OSError("pipe closed")
        callback = Mock()
        self.backend.request("read", [], callback)
        self.backend.proc.stdout = failed_pipe()
        self.backend._read()
        callback.assert_called_once_with(False, "라벨·단어장 백엔드 연결이 끊어졌습니다.")
        self.assertEqual(self.backend.calls, {})

    def test_bridge_timeout_removes_only_its_callback_and_ignores_late_reply(self):
        other = Mock()
        self.backend.request("other", [], other)
        bridge = Bridge.__new__(Bridge)
        bridge.labels = self.backend
        for _ in range(10):
            with self.assertRaisesRegex(RuntimeError, "응답하지 않습니다"):
                bridge.labels_call("slow", [], timeout=0)
        self.assertEqual(set(self.backend.calls), {"1"})
        self.backend.proc.stdout = ['{"id":"2","ok":true,"value":"late"}',
                                    '{"id":"1","ok":true,"value":"kept"}']
        self.backend._read()
        other.assert_called_once_with(True, "kept")


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.bridge = SimpleNamespace(sessions={}, labels=None, js="", payload=lambda: "[]", handle=Mock(), _sessions_lock=threading.Lock())
        self.bridge.remove_session = lambda session: Bridge.remove_session(self.bridge, session)
        self.session = Session(self.bridge, {"id": "page-1", "webSocketDebuggerUrl": "ws://unused"})
        self.socket = Mock()
        self.session.ws = self.socket
        self.bridge.sessions["page-1"] = self.session

    def pending_request(self):
        sent = threading.Event()
        self.socket.send.side_effect = lambda data: sent.set()
        executor = ThreadPoolExecutor(max_workers=1)
        self.addCleanup(executor.shutdown)
        future = executor.submit(self.session.request, "Runtime.evaluate", timeout=2)
        self.assertTrue(sent.wait(1), "fake request was not sent")
        return future

    def test_send_failure_and_timeout_leave_no_pending_waiters(self):
        self.socket.send.side_effect = OSError("send failed")
        with self.assertRaises(OSError):
            self.session.request("Runtime.evaluate", timeout=0)
        self.assertEqual(self.session.waiting, {})
        self.socket.send.side_effect = None
        with self.assertRaisesRegex(RuntimeError, "응답하지 않습니다"):
            self.session.request("Runtime.evaluate", timeout=0)
        self.assertEqual(self.session.waiting, {})
        self.session._receive('{"id":2,"result":{"late":true}}')
        self.assertEqual(self.session.waiting, {})

    def test_response_key_order_whitespace_and_malformed_messages(self):
        future = self.pending_request()
        for raw in ("not-json", "null", "[]", '{"id":[]}', '{"id":true}', '{"id":99,"result":{}}'):
            self.session._receive(raw)
        self.assertFalse(future.done())
        self.session._receive('  {"result":{"value":7}, "id":1}')
        self.assertEqual(future.result(timeout=1), {"value": 7})
        self.assertEqual(self.session.waiting, {})

    def test_disconnect_wakes_waiter_and_rejects_later_requests(self):
        future = self.pending_request()
        self.session._disconnect()
        with self.assertRaisesRegex(RuntimeError, "연결이 끊어"):
            future.result(timeout=1)
        self.assertEqual(self.session.waiting, {})
        self.assertIsNone(self.session.ws)
        self.socket.close.assert_called_once()
        with self.assertRaisesRegex(RuntimeError, "아직 연결되지"):
            self.session.request("Runtime.evaluate", timeout=0)

    def test_invalid_binding_or_handler_failure_preserves_connection(self):
        def binding(payload):
            return json.dumps({"method": "Runtime.bindingCalled", "params": {"name": BINDING, "payload": payload}})
        for payload in ("{broken", "null", "[]"):
            self.session._receive(binding(payload))
        self.bridge.handle.assert_not_called()
        self.bridge.handle.side_effect = [RuntimeError("invalid operation"), None]
        self.session._receive(binding('{"op":"bad"}'))
        self.session._receive(binding('{"op":"good"}'))
        self.assertEqual(self.bridge.handle.call_count, 2)
        self.assertIs(self.session.ws, self.socket)

    def test_empty_websocket_frame_ends_session_and_settles_waiters(self):
        done, box = threading.Event(), {}
        self.session.waiting[100] = (done, box)
        self.socket.recv.return_value = ""
        with patch("cdp_bridge.websocket.create_connection", return_value=self.socket):
            self.session.run()
        self.assertTrue(done.is_set())
        self.assertIn("연결이 끊어", box["msg"]["error"]["message"])
        self.assertEqual(self.session.waiting, {})
        self.assertEqual(self.bridge.sessions, {})
        self.socket.recv.assert_called_once()
        self.socket.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
