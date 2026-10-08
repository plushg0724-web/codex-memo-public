"""바로 실행: 자주 쓰는 프로그램(BAT·CMD·PS1·EXE·LNK)을 트레이에서 바로 켠다.

예전 '바로실행' 실행기(PowerShell)를 옮겨 왔다. 목록은 개인 데이터 폴더의 shortcuts.json,
실행 기록(표준 출력·오류)은 launch-logs 에 남긴다. 처음 실행할 때 예전 실행기의 목록이 있으면 복사해 온다.

- 같은 도우미 세션에서 아직 살아 있는 프로세스는 다시 켜지 않는다.
- 포트를 등록한 항목은 포트가 이미 응답하면 다시 켜지 않는다(대신 웹 주소를 연다).
- 도우미를 꺼도 실행한 프로그램은 그대로 둔다.
"""

import json
import os
import shutil
import socket
import subprocess
import threading
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from urllib.parse import urlparse

from paths import DATA_DIR, write_atomic

SHORTCUTS_PATH = os.path.join(DATA_DIR, "shortcuts.json")
LOG_DIR = os.path.join(DATA_DIR, "launch-logs")
EXTENSIONS = (".bat", ".cmd", ".ps1", ".exe", ".lnk")
# 예전 '바로실행' 실행기의 목록(있으면 처음 한 번 복사)
LEGACY_PATHS = (r"D:\codex_project\2026-09-17\new-chat-2\outputs\바로실행\data\shortcuts.json",)

CREATE_NEW_CONSOLE = 0x00000010
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
SW_HIDE, SW_SHOWNORMAL = 0, 1


class LaunchError(Exception):
    """사용자에게 보여 줄 오류"""


def _port(value):
    """저장된 포트 값 → 숫자 (예전 목록의 글자 값도 받는다). 없거나 틀리면 0."""
    try:
        port = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return port if 0 < port <= 65535 else 0


def port_open(port, timeout=0.15):
    port = _port(port)
    if not port:
        return False
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def open_ports(ports, timeout=0.15):
    """여러 포트를 동시에 확인해 응답한 포트 집합을 돌려준다.
    Windows 에서는 닫힌 포트 하나가 시간 제한(약 0.15초)을 다 쓰므로 차례로 확인하면 항목 수만큼 길어진다."""
    ports = sorted({p for p in map(_port, ports) if p})
    if len(ports) <= 1:
        return {p for p in ports if port_open(p, timeout)}
    with ThreadPoolExecutor(max_workers=min(len(ports), 16)) as pool:
        return {p for p, ok in zip(ports, pool.map(lambda p: port_open(p, timeout), ports)) if ok}


def validate(fields, existing_id=None):
    """입력값을 확인해 저장할 항목을 돌려준다. 틀리면 LaunchError."""
    name = str(fields.get("name") or "").strip()
    if not name:
        raise LaunchError("이름을 입력하세요.")
    path = os.path.expandvars(str(fields.get("path") or "").strip().strip('"'))
    if not os.path.isabs(path) or not os.path.isfile(path):
        raise LaunchError("존재하는 실행 파일의 전체 경로를 선택하세요.")
    if os.path.splitext(path)[1].lower() not in EXTENSIONS:
        raise LaunchError("BAT, CMD, EXE, LNK, PS1 파일을 선택하세요.")
    cwd = os.path.expandvars(str(fields.get("cwd") or "").strip().strip('"')) or os.path.dirname(path)
    if not os.path.isabs(cwd) or not os.path.isdir(cwd):
        raise LaunchError("존재하는 작업 폴더의 전체 경로를 입력하세요.")
    port_text = str(fields.get("port") or "").strip()
    try:
        port = int(port_text) if port_text else 0
    except ValueError:
        port = -1
    if not 0 <= port <= 65535:
        raise LaunchError("포트는 1~65535 또는 빈칸으로 입력하세요.")
    url = str(fields.get("url") or "").strip()
    if url and urlparse(url).scheme not in ("http", "https"):
        raise LaunchError("웹 주소는 http:// 또는 https://로 입력하세요.")
    return {"id": existing_id or uuid.uuid4().hex, "name": name, "path": path, "cwd": cwd,
            "arguments": str(fields.get("arguments") or ""), "port": port, "url": url,
            "showWindow": bool(fields.get("showWindow"))}


class QuickLaunch:
    def __init__(self, path=SHORTCUTS_PATH, log_dir=LOG_DIR, legacy=LEGACY_PATHS):
        self.path = path
        self.log_dir = log_dir
        self.lock = threading.RLock()
        self.runs = {}            # 항목 id -> 이 세션에서 켠 Popen
        self._listeners = []
        if not os.path.exists(path):
            for old in legacy:
                if os.path.isfile(old):
                    try:
                        self._write(self._read(old))
                    except (OSError, ValueError):
                        pass
                    break
        self.items = self._read(path) if os.path.exists(path) else []

    # ---------- 목록
    @staticmethod
    def _read(path):
        with open(path, encoding="utf-8-sig") as f:
            data = json.load(f)
        if isinstance(data, dict):   # PowerShell 이 항목 하나를 배열 없이 저장한 경우
            data = [data]
        if not isinstance(data, list):
            raise ValueError("shortcuts.json 형식이 올바르지 않습니다.")
        return [d for d in data if isinstance(d, dict) and d.get("id") and d.get("name")]

    def _write(self, items):
        text = json.dumps(items, ensure_ascii=False, indent=2)
        if os.path.exists(self.path):
            shutil.copyfile(self.path, self.path + ".bak")
        write_atomic(self.path, text)

    def reload(self):
        with self.lock:
            if os.path.exists(self.path):
                self.items = self._read(self.path)
        self._notify()

    def list(self):
        with self.lock:
            return [dict(i) for i in self.items]

    def get(self, item_id):
        with self.lock:
            return next((dict(i) for i in self.items if i["id"] == item_id), None)

    def _commit(self, items):
        """lock 안에서 호출한다. 저장 성공 후에만 메모리 목록을 교체한다."""
        if items != self.items:
            self._write(items)
            self.items = items

    def save(self, fields, item_id=None):
        """추가(item_id 없음) 또는 수정. 저장한 항목을 돌려준다."""
        item = validate(fields, item_id)
        with self.lock:
            if item_id:
                items = [item if i["id"] == item_id else i for i in self.items]
            else:
                items = self.items + [item]
            self._commit(items)
        self._notify()
        return dict(item)

    def remove(self, item_id):
        with self.lock:
            self._commit([i for i in self.items if i["id"] != item_id])
        self._notify()

    def move(self, item_id, offset):
        """목록에서 위(-1)·아래(+1)로 옮긴다(트레이 메뉴 순서)."""
        with self.lock:
            idx = next((n for n, i in enumerate(self.items) if i["id"] == item_id), None)
            if idx is None:
                return
            new = max(0, min(len(self.items) - 1, idx + offset))
            if new != idx:
                items = list(self.items)
                items.insert(new, items.pop(idx))
                self._commit(items)
        self._notify()

    def subscribe(self, fn):
        self._listeners.append(fn)

    def _notify(self):
        for fn in list(self._listeners):
            try:
                fn()
            except Exception:
                pass

    # ---------- 실행
    def state(self, item, responding=None):
        """목록·트레이에 보여 줄 상태: running / port / exited / idle.
        responding: open_ports() 로 미리 한꺼번에 확인한 포트 집합 (없으면 이 항목의 포트만 확인)"""
        p = self.runs.get(item["id"])
        if item.get("port"):
            alive = _port(item["port"]) in responding if responding is not None else port_open(item["port"])
            return "port" if alive else ("running" if p and p.poll() is None else "idle")
        if p is not None:
            return "running" if p.poll() is None else "exited"
        return "idle"

    def state_text(self, item, responding=None):
        s = self.state(item, responding)
        if s == "port":
            return "실행 중 (포트 응답)"
        if s == "running":
            return "실행 중" if not item.get("port") else "켜는 중 (포트 응답 없음)"
        if s == "exited":
            return f"실행 명령 끝남 ({self.runs[item['id']].returncode})"
        return "포트 응답 없음" if item.get("port") else "꺼짐"

    def open_url(self, item):
        if not item.get("url"):
            raise LaunchError("웹 주소가 등록돼 있지 않습니다. 바로 실행 관리에서 웹 주소를 넣으세요.")
        webbrowser.open(item["url"])

    def activate(self, item):
        """트레이에서 누름: 이미 켜져 있으면 웹 주소를 열고, 아니면 켠다. 결과 문구를 돌려준다."""
        s = self.state(item)
        if s in ("port", "running"):
            if item.get("url"):
                self.open_url(item)
                return f"{item['name']}: 이미 실행 중이라 웹 화면을 열었습니다."
            return f"{item['name']}: 이미 실행 중입니다."
        self.start(item)
        return f"{item['name']}: 실행했습니다." + (" 웹 화면은 한 번 더 누르면 열립니다." if item.get("url") else "")

    def start(self, item):
        p = self.runs.get(item["id"])
        if p is not None and p.poll() is None:
            raise LaunchError(f"{item['name']}: 이미 실행 요청한 프로세스가 동작 중입니다.")
        if item.get("port") and port_open(item["port"]):
            raise LaunchError(f"{item['name']}: 포트 {item['port']} 가 사용 중이라 다시 켜지 않았습니다.")
        path, cwd = item["path"], item.get("cwd") or os.path.dirname(item["path"])
        if not os.path.isfile(path):
            raise LaunchError(f"실행 파일을 찾을 수 없습니다: {path}")
        if not os.path.isdir(cwd):
            raise LaunchError(f"작업 폴더를 찾을 수 없습니다: {cwd}")
        ext = os.path.splitext(path)[1].lower()
        args = str(item.get("arguments") or "").strip()
        if ext == ".lnk":
            os.startfile(path)   # 바로가기는 Windows 가 연다(로그 없음)
            return
        if ext in (".bat", ".cmd"):
            comspec = os.environ.get("ComSpec", r"C:\Windows\System32\cmd.exe")
            command = f'"{comspec}" /d /s /c ""{path}" {args}"'
        elif ext == ".ps1":
            shell = shutil.which("pwsh.exe") or os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                                                              r"System32\WindowsPowerShell\v1.0\powershell.exe")
            command = f'"{shell}" -NoProfile -ExecutionPolicy Bypass -File "{path}" {args}'
        else:
            command = f'"{path}" {args}'
        os.makedirs(self.log_dir, exist_ok=True)
        base = os.path.join(self.log_dir, f"{item['id']}-{datetime.now():%Y%m%d-%H%M%S-%f}"[:-3])
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = SW_SHOWNORMAL if item.get("showWindow") else SW_HIDE
        with open(base + ".out.log", "wb") as out, open(base + ".err.log", "wb") as err:
            kwargs = dict(cwd=cwd, stdin=subprocess.DEVNULL, stdout=out, stderr=err, startupinfo=si)
            flags = CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP
            try:
                # 도우미가 작업 개체(job) 안에서 돌아도 도우미를 끌 때 함께 꺼지지 않게
                proc = subprocess.Popen(command, creationflags=flags | CREATE_BREAKAWAY_FROM_JOB, **kwargs)
            except OSError:
                proc = subprocess.Popen(command, creationflags=flags, **kwargs)
        self.runs[item["id"]] = proc

    def open_logs(self):
        os.makedirs(self.log_dir, exist_ok=True)
        os.startfile(self.log_dir)
