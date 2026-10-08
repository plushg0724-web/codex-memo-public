"""모델 도구용 로컬 제어 서버. labels/memo-mcp.cjs 가 이 서버로 도구 호출을 넘긴다.

127.0.0.1 의 빈 포트에서만 듣고, 매번 새로 만든 열쇠(token)를 아는 요청만 받는다.
포트와 열쇠는 개인 데이터 폴더의 control.json 에 적는다(이 PC 의 같은 사용자만 읽을 수 있는 곳).
"""

import json
import os
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from agent_tools import ToolError
from paths import DATA_DIR, version, write_atomic

CONTROL_PATH = os.path.join(DATA_DIR, "control.json")
MAX_BODY = 1024 * 1024


class ControlServer:
    def __init__(self, tools, path=CONTROL_PATH):
        self.tools = tools
        self.path = path
        self.token = secrets.token_urlsafe(32)
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _reply(self, status, body):
                data = json.dumps(body, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _read_body(self):
                """요청 본문. 길이가 없거나 틀리거나 너무 크면 None (너무 큰 본문은 읽지 않는다)."""
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                except ValueError:
                    return None
                return self.rfile.read(length) if 0 < length <= MAX_BODY else None

            def do_POST(self):
                # 거절할 요청도 본문을 먼저 읽는다. 읽지 않은 채 응답하고 닫으면 연결이 강제로 끊겨(RST)
                # 클라이언트가 오류 안내 대신 연결 오류를 받을 수 있다.
                body = self._read_body()
                # 브라우저에서 온 요청(Origin 있음)은 받지 않는다
                if self.path != "/call" or self.headers.get("Origin"):
                    return self._reply(404, {"ok": False, "error": "없는 주소입니다."})
                if not secrets.compare_digest(self.headers.get("Authorization", ""), "Bearer " + server.token):
                    return self._reply(401, {"ok": False, "error": "열쇠가 맞지 않습니다. Codex 메모 도우미를 다시 시작했다면 MCP 서버도 다시 연결하세요."})
                try:
                    if body is None:
                        raise ValueError
                    req = json.loads(body)
                    name, args = req["tool"], req.get("args") or {}
                except (ValueError, KeyError, TypeError):
                    return self._reply(400, {"ok": False, "error": "요청 형식이 올바르지 않습니다."})
                try:
                    return self._reply(200, {"ok": True, "result": server.tools.call(str(name), args)})
                except ToolError as e:
                    return self._reply(200, {"ok": False, "error": str(e)})
                except Exception as e:  # 예상 못 한 오류도 모델에게 알린다
                    return self._reply(200, {"ok": False, "error": f"처리 중 오류: {e}"})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True

    @property
    def port(self):
        return self.httpd.server_address[1]

    def start(self):
        write_atomic(self.path, json.dumps({"port": self.port, "token": self.token, "pid": os.getpid(), "version": version()}))
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()   # 포트를 닫아 이후 요청이 바로 실패하게
        try:
            with open(self.path, encoding="utf-8") as f:
                mine = json.load(f).get("token") == self.token
            if mine:   # 새로 시작한 도우미의 파일은 지우지 않는다
                os.remove(self.path)
        except (OSError, ValueError):
            pass
