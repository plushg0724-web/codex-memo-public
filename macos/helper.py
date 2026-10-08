"""Headless shared backend for the native macOS menu app. JSON-lines IPC only."""
import fcntl
import json
import os
from pathlib import Path
import signal
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from agent_tools import AgentTools
from cdp_bridge import Bridge
from codex_app import codex_pids, close_codex, launch_codex, focus_codex, debug_port_alive
from control_server import ControlServer
from memo_store import MemoStore
from paths import DATA_DIR, MEMO_DIR, migrate_legacy, version

OUTPUT_LOCK = threading.Lock()


def emit(value):
    with OUTPUT_LOCK:
        print(json.dumps(value, ensure_ascii=False), flush=True)


class Helper:
    def __init__(self):
        # New data, control tokens and helper logs are private to this macOS user.
        os.umask(0o077)
        os.makedirs(DATA_DIR, mode=0o700, exist_ok=True)
        os.chmod(DATA_DIR, 0o700)
        self.lock_file = open(os.path.join(DATA_DIR, "mac-helper.lock"), "a")
        try:
            fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock_file.close()
            raise RuntimeError("Codex 메모가 이미 실행 중입니다.")
        migrate_legacy()
        self.store = MemoStore(MEMO_DIR)
        self.stopped = threading.Event()
        self.commands = threading.Lock()
        self.bridge = Bridge(self.store, on_error=lambda message: emit({"event": "error", "message": message}),
                             on_pet_settings=lambda: emit({"event": "petSettings"}))
        self.control = None
        try:
            self.bridge.start()
            control = ControlServer(AgentTools(self.bridge, self.store))
            try:
                control.start()
            except Exception:
                control.httpd.server_close()
                raise
            self.control = control
        except Exception:
            self.bridge.stop()
            self.lock_file.close()
            raise
        threading.Thread(target=self.status_loop, daemon=True).start()

    def status_loop(self):
        while not self.stopped.is_set():
            emit({"event": "status", "connected": self.bridge.main_session() is not None,
                  "running": bool(codex_pids()), "debug": debug_port_alive(), "version": version()})
            self.stopped.wait(2)

    def perform(self, method, args):
        if method == "start":
            launch_codex()
            return True
        if method == "restart":
            if codex_pids():
                close_codex()
            launch_codex()
            return True
        if method == "library":
            if not self.bridge.open_library(args[0] if args else "memo"):
                raise RuntimeError("Codex 화면에 연결되지 않았습니다. 메뉴의 메모 모드 시작을 사용하세요.")
            focus_codex()
            return True
        if method == "reload":
            if not self.bridge.main_session():
                raise RuntimeError("Codex 화면에 연결되지 않았습니다.")
            self.bridge.reload_pages()
            return True
        if method == "sheetsConnect":
            args = [self.store.load()]
        allowed = {"backupStatus", "backupCreate", "backupList", "backupRestore", "backupConfigure",
                   "sheetsStatus", "sheetsConnect", "taskPetSettings", "taskPetSettingsSet", "vocabularyModels"}
        if method not in allowed:
            raise ValueError("지원하지 않는 메뉴 요청입니다.")
        return self.bridge.labels_call(method, args, timeout=180)

    def dispatch(self, request):
        request_id = request.get("id")
        try:
            with self.commands:
                result = self.perform(request["method"], request.get("args", []))
            emit({"id": request_id, "ok": True, "value": result})
        except Exception as error:
            emit({"id": request_id, "ok": False, "error": str(error)})

    def close(self):
        if self.stopped.is_set():
            return
        self.stopped.set()
        if self.control:
            self.control.stop()
        self.bridge.stop()
        self.lock_file.close()


def main():
    helper = None
    try:
        helper = Helper()
        def stop(*_):
            helper.close()
            raise SystemExit(0)
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        for line in sys.stdin:
            if len(line) > 1024 * 1024:
                continue
            try:
                request = json.loads(line)
                if not isinstance(request, dict) or not isinstance(request.get("args", []), list):
                    raise ValueError("요청 형식이 올바르지 않습니다.")
                if request.get("method") == "quit":
                    break
                threading.Thread(target=helper.dispatch, args=(request,), daemon=True).start()
            except ValueError as error:
                emit({"event": "error", "message": str(error)})
    except Exception as error:
        emit({"event": "fatal", "message": str(error)})
        return 1
    finally:
        if helper:
            helper.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
