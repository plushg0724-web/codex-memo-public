"""Codex 화면과의 디버그 연결(CDP): 스크립트 주입, 화면 요청 처리, 라벨·단어장 백엔드."""

import json
import os
import shutil
import subprocess
import threading
import time
import urllib.request
from urllib.parse import urlsplit

import websocket

from codex_app import DEBUG_PORT, NO_WINDOW, codex_cli_path
from paths import DATA_DIR, labels_data_dir, version
from memo_store import AUTO_CATEGORIES

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INJECT_PATH = os.path.join(BASE_DIR, "inject.js")
VERSION_BADGE_PATH = os.path.join(BASE_DIR, "version-badge.js")
LABELS_SRC = os.path.join(BASE_DIR, "labels")
LABELS_ENABLED = True

PAGE_URL_PREFIX = "app://-/"        # Codex 화면 페이지만 대상으로 한다
MAIN_PAGE_URL = PAGE_URL_PREFIX + "index.html"   # 대화 목록이 있는 메인 화면
BINDING = "__codexMemoBridge"       # 화면 → 도우미 호출 함수 이름
RESPONDERS = ("__cxlBridge", "__cxmPicker", "__cxmUsage")   # 화면 요청별 응답 객체
POLL_SECONDS = 1.5
BACKEND_REQUEST_SECONDS = 180
PAGE_REQUEST_SECONDS = {"vocabularySummarize": 150, "vocabularyReanalyze": 150,
                        "vocabularyFollowup": 150, "vocabularyParagraph": 150, "taskPetSuggest": 180}
# DOM 준비 후 실행 순서: 단어장 → 라벨 → 모델 선택 → 메모 통합 → 마우스 올림 카드 → 단어 본문 표시
# → 라벨 추천 → 대화 상태 → 대화 옮기기 → 목록 필터 → 메모 펫 (단어장 문단 도구는 단어장보다 먼저)
LABEL_SCRIPTS = (
    "vocabulary-content.js", "vendor/vocabulary-renderer.js", "vendor/renderer.js", "model-picker.js",
    "thread-open.js", "memo-vocab.js", "hover-card.js", "vocab-highlight.js", "label-suggest.js",
    "thread-status.js", "thread-actions.js", "sidebar-filter.js", "filter-window.js",
    "task-progress-model.js", "task-progress.js", "task-pet.js", "subscription-usage.js",
)


def is_local_page_target(target):
    """Only connect to Codex pages on the same loopback debug endpoint."""
    if not isinstance(target, dict) or target.get("type") != "page" or not str(target.get("url", "")).startswith(PAGE_URL_PREFIX):
        return False
    try:
        endpoint = urlsplit(target.get("webSocketDebuggerUrl", ""))
        return (endpoint.scheme == "ws" and endpoint.hostname in {"127.0.0.1", "localhost", "::1"}
                and endpoint.port == DEBUG_PORT and endpoint.username is None and endpoint.password is None
                and endpoint.path.startswith("/devtools/page/") and not endpoint.query and not endpoint.fragment)
    except (TypeError, ValueError, AttributeError):
        return False


def node_path():
    """node.exe: PATH 에 없으면(방금 설치해 PATH 가 아직 안 바뀐 경우) 기본 설치 위치에서 찾는다."""
    explicit = os.environ.get("CODEX_MEMO_NODE")
    if explicit and os.path.isfile(explicit):
        return explicit
    found = shutil.which("node")
    if found:
        return found
    for exe in ("/opt/homebrew/bin/node", "/usr/local/bin/node"):
        if os.path.isfile(exe):
            return exe
    for base in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("LOCALAPPDATA", "")):
        exe = os.path.join(base, "nodejs", "node.exe")
        if os.path.exists(exe):
            return exe
    raise FileNotFoundError("Node.js 를 찾지 못했습니다. 설치 프로그램을 다시 실행해 주세요.")


def _read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as f:
        return f.read()


def labels_script():
    """라벨·단어장 코드: 연결 코드(shim.js) + DOM 준비 후 LABEL_SCRIPTS 순서대로."""
    body = "\n".join(_read(LABELS_SRC, *name.split("/")) for name in LABEL_SCRIPTS)
    return (_read(LABELS_SRC, "shim.js")
            + "\n(() => { const run = () => {\n" + body + "\n};\n"
            + "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, {once: true});\n"
            + "else run(); })();\n")


def resolve_expression(responder, page_id, ok, value):
    """화면 쪽 응답 객체(window[responder])에 요청 결과를 넣는 JS 식."""
    return (f"window.{responder} && window.{responder}.resolve("
            f"{json.dumps(page_id)}, {json.dumps(ok)}, {json.dumps(value, ensure_ascii=False)})")


# ---------------------------------------------------------------- 라벨·단어장 백엔드 (Node)
class LabelsBackend:
    """labels/backend.cjs 를 실행해 화면의 window.codexLabels 요청을 처리한다."""

    def __init__(self, on_event):
        self.on_event = on_event
        self.lock = threading.Lock()
        self.calls = {}          # 호출 ID -> (응답 대상, 만료 시각, 메서드)
        self.n = 0
        self.closed = False
        env = dict(os.environ, CODEX_LABELS_DIR=labels_data_dir(), CODEX_MEMO_DATA=DATA_DIR)
        exe = codex_cli_path()
        if exe:
            env["CODEX_EXE"] = exe
        self.proc = subprocess.Popen(
            [node_path(), os.path.join(LABELS_SRC, "backend.cjs")], cwd=LABELS_SRC, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            encoding="utf-8", creationflags=NO_WINDOW)
        threading.Thread(target=self._read, daemon=True).start()

    def call(self, session, page_id, method, args, responder=RESPONDERS[0]):
        entry = (session, page_id, responder) if page_id is not None else None
        return self._send(session.target["id"], method, args, entry, PAGE_REQUEST_SECONDS.get(method, 30))

    def request(self, method, args, callback=None, timeout=BACKEND_REQUEST_SECONDS):
        """도우미가 직접 부른다. callback(ok, value) 는 UI 밖의 응답·만료 처리에서 불린다."""
        return self._send("helper", method, args, callback, timeout)

    def _send(self, sender, method, args, entry, timeout):
        """화면·도우미 요청을 같은 경로로 보내고 전송 실패 시 대기 항목을 정리한다."""
        with self.lock:
            if self.closed:
                raise RuntimeError("라벨·단어장 백엔드 연결이 끊어졌습니다.")
            self.n += 1
            gid = str(self.n)
            if entry is not None:
                self.calls[gid] = (entry, time.monotonic() + timeout, method)
            try:
                self.proc.stdin.write(json.dumps({"id": gid, "sender": sender, "method": method,
                                                  "args": args}, ensure_ascii=False) + "\n")
                self.proc.stdin.flush()
            except Exception:
                self.calls.pop(gid, None)
                raise
            return gid

    def cancel(self, gid):
        """기다림을 끝낸 도우미의 콜백을 해제한다. 백엔드 작업 자체는 중단하지 않는다."""
        with self.lock:
            self.calls.pop(gid, None)

    def dispose(self, session):
        with self.lock:
            for gid, (entry, _, _) in list(self.calls.items()):
                if not callable(entry) and entry[0] is session:
                    del self.calls[gid]
        try:
            self.call(session, None, "dispose", [])
        except Exception:
            pass

    def expire_requests(self):
        """화면·도우미에서 이미 기다림을 끝낸 요청이 계속 쌓이지 않게 정리한다."""
        now = time.monotonic()
        with self.lock:
            expired = [gid for gid, (_, deadline, _) in self.calls.items() if deadline <= now]
            pending = [self.calls.pop(gid) for gid in expired]
        for entry, _, method in pending:
            self._deliver(entry, False, f"라벨·단어장 백엔드가 응답하지 않습니다({method}).")

    def _close_calls(self):
        with self.lock:
            self.closed = True
            pending = list(self.calls.values())
            self.calls.clear()
        for entry, _, _ in pending:
            self._deliver(entry, False, "라벨·단어장 백엔드 연결이 끊어졌습니다.")

    def stop(self):
        """입력 파이프를 닫아 Node 가 App Server 등 자신이 연 연결도 정리하게 한다."""
        self._close_calls()
        with self.lock:
            try:
                self.proc.stdin.close()
            except (OSError, ValueError):
                pass
        try:
            self.proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=1)

    @staticmethod
    def _deliver(entry, ok, value):
        """응답 하나의 오류가 다른 화면·도우미의 수신을 끊지 않게 한다."""
        try:
            if callable(entry):
                entry(ok, value)
                return
            session, page_id, responder = entry or (None, None, None)
            if session is None or page_id is None:
                return
            session.eval(resolve_expression(responder, page_id, ok, value))
        except Exception:
            pass

    def _read(self):
        try:
            for line in self.proc.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                if "event" in msg:
                    try:
                        self.on_event(msg["event"])
                    except Exception:
                        pass
                    continue
                gid = msg.get("id")
                if not isinstance(gid, str):
                    continue
                with self.lock:
                    pending = self.calls.pop(gid, None)
                if pending is not None:
                    self._deliver(pending[0], bool(msg.get("ok")),
                                  msg.get("value") if msg.get("ok") else msg.get("error"))
        except (OSError, ValueError):
            pass  # 파이프 종료도 아래에서 모든 대기 요청에 알린다.
        finally:
            self._close_calls()


# ---------------------------------------------------------------- 화면 하나와의 연결
class Session(threading.Thread):
    def __init__(self, bridge, target):
        super().__init__(daemon=True)
        self.bridge = bridge
        self.target = target
        self.lock = threading.Lock()
        self.ws = None
        self.n = 0
        self.waiting = {}   # 응답을 기다리는 호출 번호 -> (Event, 결과 상자)
        self._stopped = threading.Event()

    def _send(self, method, params, waiter=None):
        with self.lock:
            if self.ws is None:
                raise RuntimeError("Codex 화면과 아직 연결되지 않았습니다.")
            self.n += 1
            cid = self.n
            if waiter is not None:
                self.waiting[cid] = waiter
            try:
                self.ws.send(json.dumps({"id": cid, "method": method, "params": params or {}}))
            except Exception:
                self.waiting.pop(cid, None)
                raise
            return cid

    def call(self, method, params=None):
        self._send(method, params)

    def request(self, method, params=None, timeout=30):
        """응답을 기다리는 호출(모델 도구용). 화면 쪽 오류는 RuntimeError."""
        done, box = threading.Event(), {}
        cid = self._send(method, params, (done, box))
        if not done.wait(timeout):
            with self.lock:
                self.waiting.pop(cid, None)
            raise RuntimeError("Codex 화면이 응답하지 않습니다.")
        msg = box["msg"]
        if "error" in msg:
            raise RuntimeError(msg["error"].get("message") or "Codex 화면 요청 실패")
        return msg.get("result") or {}

    def evaluate(self, expression, timeout=30):
        """화면에서 식을 실행하고(Promise 는 기다림) 값을 돌려준다."""
        r = self.request("Runtime.evaluate", {"expression": expression, "awaitPromise": True,
                                              "returnByValue": True}, timeout)
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            raise RuntimeError((d.get("exception") or {}).get("description") or d.get("text") or "화면 실행 오류")
        return (r.get("result") or {}).get("value")

    def eval(self, expression, **params):
        try:
            self.call("Runtime.evaluate", {"expression": expression, **params})
        except Exception:
            pass

    def push(self, payload):
        self.eval(f"window.__codexMemo && window.__codexMemo.setMemos({payload})")

    def _install(self, context_id=None):
        """연결 함수와 스크립트를 넣는다. 중복 설치는 스크립트 쪽 버전 확인이 막는다."""
        self.call("Runtime.addBinding", {"name": BINDING})
        self.eval(self.bridge.js, **({"contextId": context_id} if context_id else {}))

    def _receive(self, raw):
        # 대기 요청이 없으면 관심 없는 콘솔 이벤트 등은 JSON 해석도 생략한다.
        if not isinstance(raw, str) or (not self.waiting and "bindingCalled" not in raw
                                      and "executionContextCreated" not in raw):
            return
        try:
            msg = json.loads(raw)
            if not isinstance(msg, dict):
                return
            if "id" in msg:
                if type(msg["id"]) is not int:
                    return
                with self.lock:
                    waiter = self.waiting.pop(msg["id"], None)
                    if waiter:
                        waiter[1]["msg"] = msg
                        waiter[0].set()
                return
            params = msg.get("params") or {}
            if msg.get("method") == "Runtime.bindingCalled" and params.get("name") == BINDING:
                payload = json.loads(params["payload"])
                if isinstance(payload, dict):
                    self.bridge.handle(self, payload)
            elif msg.get("method") == "Runtime.executionContextCreated":
                ctx = params["context"]
                aux = ctx.get("auxData") or {}
                if aux.get("isDefault") and aux.get("frameId") == self.target["id"]:
                    self._install(ctx["id"])
        except Exception:
            pass  # 잘못된 화면 요청 하나 때문에 CDP 수신 전체가 끝나지 않게 한다.

    def _disconnect(self):
        with self.lock:
            ws, self.ws = self.ws, None
            pending = list(self.waiting.values())
            self.waiting.clear()
            for done, box in pending:
                box["msg"] = {"error": {"message": "Codex 화면 연결이 끊어졌습니다."}}
                done.set()
        if ws is not None:
            try:
                ws.close(timeout=0)
            except Exception:
                pass

    def stop(self):
        self._stopped.set()
        self._disconnect()

    def run(self):
        try:
            ws = websocket.create_connection(self.target["webSocketDebuggerUrl"], suppress_origin=True, timeout=5)
            ws.settimeout(None)
            with self.lock:
                stopped = self._stopped.is_set()
                if not stopped:
                    self.ws = ws
            if stopped:
                ws.close(timeout=0)
                return
            # Page/Runtime 이벤트를 켜야 새로 고친 화면에도 연결 함수와 스크립트가 다시 들어간다
            self.call("Page.enable")
            self.call("Runtime.enable")
            self.call("Page.setBypassCSP", {"enabled": True})
            self.call("Page.addScriptToEvaluateOnNewDocument", {"source": self.bridge.js})
            self._install()
            self.push(self.bridge.payload())   # 이미 주입돼 있던 화면도 최신 메모로 맞춘다
            self.eval("window.__cxlBridge && window.__cxlBridge.reset && window.__cxlBridge.reset()")
            while not self._stopped.is_set():
                raw = ws.recv()
                if not raw:
                    break
                self._receive(raw)
        except Exception:
            pass
        finally:
            self._disconnect()
            self.bridge.remove_session(self)
            if self.bridge.labels:
                self.bridge.labels.dispose(self)


# ---------------------------------------------------------------- 전체 연결 관리
class Bridge(threading.Thread):
    """Codex 화면들을 찾아 스크립트를 넣고, 화면에서 온 요청을 처리한다."""

    def __init__(self, store, on_error, on_pet_settings=None):
        super().__init__(daemon=True)
        self.store = store
        self.on_pet_settings = on_pet_settings
        self.sessions = {}
        self._sessions_lock = threading.Lock()
        self._stopped = threading.Event()
        # 공통 도구(common.js)가 맨 앞이어야 다른 스크립트가 바로 쓴다. 버전 표시는 라벨 기능이 꺼져도 보이게 따로 넣는다.
        head = f"window.__cxmAppVersion = {json.dumps(version())};\n" + _read(LABELS_SRC, "common.js") + "\n"
        tail = _read(VERSION_BADGE_PATH) + "\n" + _read(INJECT_PATH)
        self.js = head + tail
        self.labels = None
        if LABELS_ENABLED:
            try:
                script = labels_script()
                self.labels = LabelsBackend(self._labels_event)
                self.js = head + script + "\n" + tail
            except Exception as e:  # Node 가 없거나 실행 실패: 메모 기능만 사용
                on_error(f"라벨·단어장 기능을 시작하지 못했습니다. 메모 기능만 사용합니다.\n{e}")
        store.subscribe(self.broadcast)

    @property
    def connected(self):
        with self._sessions_lock:
            return bool(self.sessions)

    def _session_snapshot(self):
        with self._sessions_lock:
            return list(self.sessions.values())

    def remove_session(self, session):
        with self._sessions_lock:
            if self.sessions.get(session.target["id"]) is session:
                del self.sessions[session.target["id"]]

    def stop(self):
        """새 연결을 멈추고 구독·화면 소켓·소유한 백엔드를 함께 닫는다."""
        with self._sessions_lock:
            if self._stopped.is_set():
                return
            self._stopped.set()
            sessions = list(self.sessions.values())
            self.sessions.clear()
        self.store.unsubscribe(self.broadcast)
        for session in sessions:
            session.stop()
        if self.labels:
            self.labels.stop()

    def run(self):
        while not self._stopped.is_set():
            self.store.poll_external()   # memos.json 을 밖에서 고친 경우에도 화면에 반영
            if self.labels:
                self.labels.expire_requests()
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/list", timeout=2) as r:
                    targets = json.load(r)
            except Exception:
                targets = []
            for t in targets:
                if is_local_page_target(t):
                    with self._sessions_lock:
                        if self._stopped.is_set():
                            break
                        if t["id"] in self.sessions:
                            continue
                        s = Session(self, t)
                        self.sessions[t["id"]] = s
                        s.start()
            self._stopped.wait(POLL_SECONDS)

    # ---------- 화면으로 보내기
    def payload(self):
        return json.dumps(self.store.load(), ensure_ascii=False)

    def broadcast(self):
        sessions = self._session_snapshot()
        if not sessions:
            return
        p = self.payload()
        for s in sessions:
            s.push(p)

    def eval_all(self, expression):
        for s in self._session_snapshot():
            s.eval(expression)

    def _main_sessions(self):
        """Codex 메인 화면(대화 목록이 있는 창)들과의 연결."""
        return [s for s in self._session_snapshot() if s.target.get("url") == MAIN_PAGE_URL]

    def open_library(self, kind="memo"):
        """Codex 메인 화면에서 단어장·메모 창을 연다. 메인 화면에 연결돼 있지 않으면 False."""
        main = self._main_sessions()
        for s in main:
            s.eval(f"window.__cxmOpenLibrary && window.__cxmOpenLibrary({json.dumps(kind)})")
        return bool(main)

    def main_session(self):
        """연결이 살아 있는 Codex 메인 화면 하나. 없으면 None."""
        return next((s for s in self._main_sessions() if s.ws is not None), None)

    def labels_call(self, method, args, timeout=60):
        """라벨·단어장 백엔드를 부르고 결과를 기다린다. 실패하면 RuntimeError."""
        if not self.labels:
            raise RuntimeError("라벨·단어장 기능이 꺼져 있습니다(Node.js 확인).")
        done, box = threading.Event(), {}
        def callback(ok, value):
            box["ok"], box["value"] = ok, value
            done.set()
        gid = self.labels.request(method, args, callback, timeout=timeout)
        if not done.wait(timeout):
            self.labels.cancel(gid)
            raise RuntimeError(f"라벨·단어장 백엔드가 응답하지 않습니다({method}).")
        if not box["ok"]:
            raise RuntimeError(str(box["value"] or "요청 실패"))
        return box["value"]

    def reload_pages(self):
        for s in self._session_snapshot():
            try:
                s.call("Page.reload")
            except Exception:
                pass

    def _labels_event(self, name):
        if name in ("changed", "vocabulary-changed"):
            self.eval_all(f"window.__cxlBridge && window.__cxlBridge.emit({json.dumps(name)})")

    # ---------- 화면에서 온 요청
    def _append_sheet(self, memo):
        """Google 시트에 메모 행을 보낸다(연결돼 있지 않으면 백엔드가 무시). 전송 실패는 무시한다."""
        try:
            self.labels.request("sheetsAppendMemo", [memo])
        except Exception:
            pass

    def _classify_memo(self, memo_id, done=None, append_sheet=False):
        """저장은 즉시 끝내고 분류만 비동기로 요청한다. 시트는 최대 3초 기다린다."""
        with self.store.lock:
            memo = self.store.get(memo_id)
            revision = self.store.revision(memo_id)
        if not memo or memo.get("category"):
            if done:
                done(None)
            if memo and append_sheet:
                self._append_sheet(memo)
            return

        sheet_lock = threading.Lock()
        sent = False

        def send_sheet():
            """분류 결과가 오거나 3초가 지나면 한 번만 보낸다(그사이 지운 메모는 보내지 않음)."""
            nonlocal sent
            if not append_sheet:
                return
            with sheet_lock:
                if sent:
                    return
                sent = True
            current = self.store.get(memo_id)
            if current:
                self._append_sheet(current)

        timer = threading.Timer(3, send_sheet) if append_sheet else None
        if timer:
            timer.daemon = True
            timer.start()

        def classified(ok, value):
            result = None
            if ok and isinstance(value, dict) and value.get("category") in AUTO_CATEGORIES:
                if self.store.update(memo_id, category=value["category"], expected=memo, revision=revision):
                    result = value
            if timer:
                timer.cancel()
            send_sheet()
            if done:
                done(result)

        def request():
            try:
                self.labels.request("memoClassify", [memo], classified)
            except Exception:
                classified(False, None)
        threading.Thread(target=request, daemon=True).start()

    def handle(self, session, msg):
        op = msg.get("op")
        if op == "labels":
            if self.labels and isinstance(msg.get("args"), list):
                responder = msg.get("cb") if msg.get("cb") in RESPONDERS else RESPONDERS[0]
                args = msg["args"]
                if msg.get("method") == "memoClassify" and args and isinstance(args[0], dict) and args[0].get("id"):
                    # 일괄 분류도 저장소의 최신 메모를 읽고 수동 변경을 보호하는 같은 경로를 쓴다.
                    page_id = msg.get("id")
                    self._classify_memo(args[0]["id"], lambda value: session.eval(
                        resolve_expression(responder, page_id, True, value)))
                else:
                    self.labels.call(session, msg.get("id"), str(msg.get("method")), args, responder)
        elif op == "hello":
            session.push(self.payload())
        elif op == "pet_settings":
            # 펫 패널의 ⚙ 버튼: 트레이의 '펫 설정…' 창을 연다.
            if self.on_pet_settings:
                self.on_pet_settings()
        elif op == "add":
            memo = self.store.add(msg)
            if self.labels:
                self._classify_memo(memo["id"], append_sheet=True)
        elif op == "update":
            self.store.update(msg.get("id"), msg.get("note"), msg.get("category"))
        elif op == "delete":
            self.store.remove(msg.get("id"))
