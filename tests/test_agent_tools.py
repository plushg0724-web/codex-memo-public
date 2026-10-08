"""모델 도구(agent_tools.py) · 제어 서버(control_server.py) · MCP 서버(labels/memo-mcp.cjs).

가짜 라벨 백엔드·가짜 Codex 화면과 임시 폴더의 메모 저장소만 쓴다. 실제 데이터는 건드리지 않는다.
실행: python tests/test_agent_tools.py
"""
import atexit
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from agent_tools import AgentTools, Journal, ToolError  # noqa: E402
from cdp_bridge import node_path  # noqa: E402
from control_server import ControlServer  # noqa: E402
from memo_store import MemoStore  # noqa: E402

UUID = lambda n: f"00000000-0000-4000-8000-{n:012d}"
KEY = lambda n: f"thread:local:local:local:{UUID(n)}"


class FakeBackend:
    def __init__(self):
        self.labels = [
            {"id": "requested", "kind": "status", "name": "요청", "enabled": True, "order": 10, "description": "", "backgroundColor": "#7DD3FC", "textColor": "#082F49"},
            {"id": "completed", "kind": "status", "name": "완료", "enabled": True, "order": 20, "description": "", "backgroundColor": "#86EFAC", "textColor": "#052E16"},
            {"id": "dev", "kind": "category", "name": "개발", "enabled": True, "order": 30, "description": "", "backgroundColor": "#FCA5A5", "textColor": "#450A0A"},
        ]
        self.assignments = {KEY(1): "requested"}
        self.categories = {KEY(1): "dev"}
        self.rev = 0
        self.vocab = []
        self.vrev = 0

    def snapshot(self):
        return {"config": {"labels": json.loads(json.dumps(self.labels)), "appearance": {}}, "configRevision": f"{self.rev:064x}",
                "assignments": dict(self.assignments), "categoryAssignments": dict(self.categories)}

    def __call__(self, method, args):
        if method == "read":
            return self.snapshot()
        if method == "assignMany":
            keys, label, kind = args
            target = self.assignments if kind == "status" else self.categories
            for k in keys:
                target.pop(k, None) if label is None else target.__setitem__(k, label)
            return self.snapshot()
        if method == "saveConfig":
            config, rev = args
            if rev != f"{self.rev:064x}":
                raise RuntimeError("다른 창에서 라벨 설정이 변경되었습니다.")
            self.labels = config["labels"]
            self.rev += 1
            return self.snapshot()
        if method == "threadCatalog":
            return [{"id": UUID(1), "name": "통합 업무 DB", "cwd": "D:\\work", "updatedAt": 1790000000},
                    {"id": UUID(2), "name": "라벨 필터 만들기", "cwd": "D:\\labels", "updatedAt": 1790000500}]
        if method == "vocabularyRead":
            return {"entries": [dict(e) for e in self.vocab], "revision": f"{self.vrev:064x}"}
        if method == "vocabularyAdd":
            e = {"id": f"{len(self.vocab) + 1:08d}-0000-4000-8000-000000000000", **args[0], "status": "new", "favorite": False}
            self.vocab.append(e); self.vrev += 1
            return e
        if method in ("vocabularyEdit", "vocabularyDelete"):
            if args[-1] != f"{self.vrev:064x}":
                raise RuntimeError("단어장 revision 불일치")
            if method == "vocabularyEdit":
                next(e for e in self.vocab if e["id"] == args[0]).update(args[1])
            else:
                self.vocab = [e for e in self.vocab if e["id"] != args[0]]
            self.vrev += 1
            return {}
        if method == "vocabularyRestore":
            self.vocab.append(dict(args[0])); self.vrev += 1
            return args[0]
        raise RuntimeError(f"unknown {method}")


class FakeFilter:
    """화면의 window.__cxmSidebarFilter 흉내(실제 코드는 test_sidebar_filter.py 가 확인)"""

    def __init__(self):
        self.filter = {"status": ["completed"], "category": []}
        self.presets = [{"id": "f1", "name": "완료 빼기", "status": ["completed"], "category": []}]

    def state(self):
        return json.loads(json.dumps({"filter": self.filter, "presets": self.presets}))

    def run(self, body):
        same = lambda p: sorted(p["status"]) == sorted(self.filter["status"]) and sorted(p["category"]) == sorted(self.filter["category"])
        if body == "f.exportState()":
            return self.state()
        if body == "f.exportState().filter":
            return self.state()["filter"]
        if body == "f.presets()":
            return [{**p, "active": same(p)} for p in self.state()["presets"]]
        if body.startswith("({...f.exportState()"):
            active = next((p["name"] for p in self.presets if same(p)), None)
            return {**self.state(), "counts": {"shown": 5, "total": 7}, "active": active}
        m = re.fullmatch(r"f\.(\w+)\((.*)\)", body, re.S)
        name, args = m.group(1), json.loads(f"[{m.group(2)}]")
        if name == "applyPreset":
            p = next(p for p in self.presets if p["id"] == args[0]); self.filter = {"status": list(p["status"]), "category": list(p["category"])}
        elif name == "setFilter":
            self.filter = {**self.filter, **args[0]}
        elif name == "savePreset":
            old = next((p for p in self.presets if p["name"] == args[0]), None)
            value = {"id": old["id"] if old else f"f{len(self.presets) + 1}", "name": args[0], **args[1]}
            self.presets = [value if p is old else p for p in self.presets] if old else self.presets + [value]
        elif name == "renamePreset":
            next(p for p in self.presets if p["id"] == args[0])["name"] = args[1]
        elif name == "deletePreset":
            self.presets = [p for p in self.presets if p["id"] != args[0]]
        elif name == "importState":
            self.filter, self.presets = args[0]["filter"], args[0]["presets"]
        else:
            raise AssertionError(body)
        return None


class FakeSession:
    def __init__(self):
        self.calls = []
        self.where = {UUID(2): {"project": None, "sections": []}}
        self.filter = FakeFilter()

    def evaluate(self, expression, timeout=30):
        self.calls.append(expression)
        if expression in ("!!window.__cxmThreadActions", "!!window.__cxmSidebarFilter"):
            return True
        m = re.fullmatch(r"\(\(\) => \{ const f = window\.__cxmSidebarFilter; return (.*); \}\)\(\)", expression, re.S)
        if m:
            return self.filter.run(m.group(1))
        if ".rows()" in expression:
            return [{"rowId": "local:" + UUID(2), "title": "라벨 필터 만들기", "host": "local", "pinned": False},
                    {"rowId": "local:" + UUID(3), "title": "클라우드 대화", "host": "durable", "pinned": True}]
        if ".destinations(" in expression:
            return [{"id": "move-thread-to-project:p1", "name": "회사내규", "group": "프로젝트"}]
        if ".move(" in expression:
            return {"moved": [UUID(2)], "skipped": [], "failed": [], "before": {UUID(2): self.where[UUID(2)]}}
        if ".restore(" in expression:
            return True
        raise AssertionError(expression)


class FakeBridge:
    def __init__(self):
        self.backend = FakeBackend()
        self.session = FakeSession()
        self.labels = True

    def labels_call(self, method, args, timeout=60):
        return self.backend(method, args)

    def main_session(self):
        return self.session


ok = True
def check(name, cond, extra=""):
    global ok
    ok &= bool(cond)
    print(("✔ " if cond else "✘ ") + name, extra)


def raises(fn, text):
    try:
        fn()
    except ToolError as e:
        return text in str(e)
    return False


tmp = tempfile.mkdtemp()
atexit.register(shutil.rmtree, tmp, ignore_errors=True)   # 임시 메모·변경 기록 정리
store = MemoStore(os.path.join(tmp, "memos"))
bridge = FakeBridge()
tools = AgentTools(bridge, store, Journal(os.path.join(tmp, "agent-history.json")))
call = tools.call

# ---- 상태·목록
check("status", call("status", {})["codexScreenConnected"] is True)
labels = call("labels_list", {})["labels"]
check("labels_list: 종류·쓰인 횟수", [(l["name"], l["kind"], l["uses"]) for l in labels] == [("요청", "status", 1), ("완료", "status", 0), ("개발", "category", 1)])
th = call("threads_list", {})
check("threads_list: 이 PC 대화 + 왼쪽 목록(클라우드) 합침", th["total"] == 3, th)
by = {t["threadId"]: t for t in th["threads"]}
check("threads_list: 라벨 이름·왼쪽 목록 여부·host", by[UUID(1)]["status"] == "요청" and by[UUID(1)]["category"] == "개발"
      and by[UUID(2)]["inSidebar"] and by[UUID(3)].get("host") == "durable")
check("threads_list: 최근 순", th["threads"][0]["threadId"] == UUID(2))
check("threads_list: 이름으로 거르기", [t["threadId"] for t in call("threads_list", {"status": "요청"})["threads"]] == [UUID(1)])
check("threads_list: 진행 상태 빼기(이름·none)", [t["threadId"] for t in call("threads_list", {"excludeStatus": ["요청"]})["threads"]] == [UUID(2), UUID(3)]
      and [t["threadId"] for t in call("threads_list", {"excludeStatus": ["none"]})["threads"]] == [UUID(1)])
check("threads_list: 카테고리 빼기", {t["threadId"] for t in call("threads_list", {"excludeCategory": "개발"})["threads"]} == {UUID(2), UUID(3)})
check("빼기에 없는 라벨은 안내", raises(lambda: call("threads_list", {"excludeStatus": ["없는상태"]}), "있는 라벨"))
check("threads_list: 라벨 없음", {t["threadId"] for t in call("threads_list", {"category": "none"})["threads"]} == {UUID(2), UUID(3)})
check("threads_list: 글자 찾기(작업 폴더)", [t["threadId"] for t in call("threads_list", {"query": "labels"})["threads"]] == [UUID(2)])
check("없는 라벨은 있는 라벨을 알려 줌", raises(lambda: call("threads_list", {"status": "보류"}), "있는 라벨: 요청, 완료"))

# ---- 라벨 지정·되돌리기
r = call("labels_assign", {"threadIds": [UUID(1), "local:" + UUID(2)], "status": "완료", "category": "none"})
b = bridge.backend
check("labels_assign: 이름·'local:' 접두어 모두 받음", b.assignments == {KEY(1): "completed", KEY(2): "completed"} and b.categories == {}, r)
check("labels_assign: 요약", r["summary"] == "대화 2개: 진행 상태 → 완료, 카테고리 → 없음")
call("labels_assign", {"threadIds": [UUID(3)], "category": "dev"})
check("넣지 않은 종류는 그대로", b.assignments.get(KEY(3)) is None and b.categories[KEY(3)] == "dev")
call("undo", {})
check("undo: 마지막 변경만 되돌림", KEY(3) not in b.categories and b.assignments[KEY(1)] == "completed")
call("undo", {"changeId": r["changeId"]})
check("undo(changeId): 이전 라벨로", b.assignments == {KEY(1): "requested"} and b.categories == {KEY(1): "dev"})
check("이미 되돌린 변경은 안내", raises(lambda: call("undo", {"changeId": r["changeId"]}), "이미 되돌린"))
check("아무것도 안 넣으면 안내", raises(lambda: call("labels_assign", {"threadIds": [UUID(1)]}), "하나는 넣으세요"))

# ---- 라벨 종류
r = call("label_define", {"name": "회신 대기", "kind": "status", "description": "상대 답을 기다림"})
new = next(l for l in b.labels if l["name"] == "회신 대기")
check("label_define: 새 라벨(id·색·순서 자동)", new["id"].startswith("label_") and new["kind"] == "status" and new["order"] == 40 and new["backgroundColor"].startswith("#"))
call("label_define", {"name": "개발", "color": "#112233"})
check("label_define: 같은 이름이면 고치기", next(l for l in b.labels if l["id"] == "dev")["backgroundColor"] == "#112233")
check("종류는 못 바꿈", raises(lambda: call("label_define", {"name": "개발", "kind": "status"}), "종류는 바꿀 수 없습니다"))
check("색 형식 확인", raises(lambda: call("label_define", {"name": "x", "kind": "category", "color": "red"}), "#RRGGBB"))
call("undo", {})
check("undo: 색 되돌림", next(l for l in b.labels if l["id"] == "dev")["backgroundColor"] == "#FCA5A5")
call("undo", {"changeId": r["changeId"]})
check("undo: 만든 라벨은 끔", next(l for l in b.labels if l["name"] == "회신 대기")["enabled"] is False)

# ---- 메모
m = call("memo_add", {"note": "배포 전에 README 확인", "threadId": "local:" + UUID(2), "category": "todo"})["memo"]
check("memo_add: 대화 연결(conv 는 uuid)", store.load()[0]["conv"] == UUID(2) and m["category"] == "todo")
call("memo_update", {"id": m["id"], "note": "배포 전에 README·VERSION 확인"})
check("memos_list: 찾기·대화별", call("memos_list", {"query": "version", "threadId": UUID(2)})["total"] == 1)
call("undo", {})
check("undo: 메모 내용 되돌림", store.load()[0]["note"] == "배포 전에 README 확인")
check("지우기는 confirm 필요", raises(lambda: call("memo_delete", {"id": m["id"]}), "confirm=true"))
call("memo_delete", {"id": m["id"], "confirm": True})
check("memo_delete", store.load() == [])
call("undo", {})
check("undo: 지운 메모를 같은 id 로 되살림", [x["id"] for x in store.load()] == [m["id"]])
check("잘못된 분류", raises(lambda: call("memo_add", {"note": "x", "category": "urgent"}), "category"))

# ---- 단어장
v = call("vocabulary_add", {"term": "idempotent", "meaning": "여러 번 해도 결과가 같은"})
vid = v["entry"]["id"]
call("vocabulary_update", {"id": vid, "status": "known", "favorite": True})
check("vocabulary_update", b.vocab[0]["status"] == "known" and b.vocab[0]["favorite"] is True)
check("바꿀 수 없는 항목", raises(lambda: call("vocabulary_update", {"id": vid, "term": "x"}), "바꿀 수 없는 항목"))
call("undo", {})
check("undo: 단어 되돌림", b.vocab[0]["status"] == "new" and b.vocab[0]["favorite"] is False)
call("vocabulary_delete", {"id": vid, "confirm": True})
call("undo", {})
check("undo: 지운 단어 되살림", [e["id"] for e in b.vocab] == [vid])
check("vocabulary_list: 뜻에서 찾기", call("vocabulary_list", {"query": "결과가"})["total"] == 1)

# ---- 옮기기
d = call("move_destinations", {"threadIds": [UUID(2)]})
check("move_destinations", d["destinations"][0]["name"] == "회사내규")
r = call("threads_move", {"threadIds": [UUID(2)], "destination": "프로젝트:회사내규"})
check("threads_move: 화면의 옮기기 실행·기록", r["moved"] == 1 and "changeId" in r and any(".move([" in c for c in bridge.session.calls))
call("undo", {})
check("undo: 원래 위치로 되돌리기 실행", any(".restore(" in c and UUID(2) in c for c in bridge.session.calls))
# ---- 왼쪽 목록 필터·저장한 필터
fl = call("filters_list", {})
check("filters_list: 지금 필터(이름)·저장한 필터·사용 중", fl["current"] == {"hideStatus": ["완료"], "hideCategory": [], "savedFilter": "완료 빼기", "shown": 5, "total": 7}
      and fl["savedFilters"] == [{"name": "완료 빼기", "hideStatus": ["완료"], "hideCategory": [], "inUse": True}], fl)
ff = bridge.session.filter
r = call("filter_set", {"hideStatus": ["완료", "none"], "hideCategory": ["개발"]})
check("filter_set: 이름·none → 라벨 id·'none'", ff.filter == {"status": ["completed", "none"], "category": ["dev"]} and r["current"]["savedFilter"] is None, ff.filter)
check("filter_set: 요약", r["summary"] == "필터: 진행 상태 완료, 라벨 없음 숨김 · 카테고리 개발 숨김", r["summary"])
call("filter_set", {"hideCategory": []})
check("filter_set: 넣은 쪽만 바뀜([] 은 모두 보기)", ff.filter == {"status": ["completed", "none"], "category": []})
r = call("filter_save", {"name": "작업 중"})
check("filter_save: 지금 필터 저장", ff.presets[-1] == {"id": "f2", "name": "작업 중", "status": ["completed", "none"], "category": []})
call("filter_save", {"name": "개발만", "hideCategory": ["none"]})
check("filter_save: 숨길 값 지정(나머지는 지금 필터)", ff.presets[-1]["category"] == ["none"] and ff.presets[-1]["status"] == ["completed", "none"])
call("filter_set", {"savedFilter": "완료 빼기"})
check("filter_set: 저장한 필터 쓰기", ff.filter == {"status": ["completed"], "category": []})
call("filter_rename", {"name": "개발만", "newName": "개발 진행"})
check("filter_rename", [p["name"] for p in ff.presets] == ["완료 빼기", "작업 중", "개발 진행"])
check("같은 이름으로 바꾸기 거절", raises(lambda: call("filter_rename", {"name": "개발 진행", "newName": "작업 중"}), "이미 있습니다"))
check("없는 저장한 필터는 목록 안내", raises(lambda: call("filter_set", {"savedFilter": "없음필터"}), "있는 필터: 완료 빼기, 작업 중, 개발 진행"))
check("필터 지우기는 confirm 필요", raises(lambda: call("filter_delete", {"name": "작업 중"}), "confirm=true"))
call("filter_delete", {"name": "작업 중", "confirm": True})
check("filter_delete", [p["name"] for p in ff.presets] == ["완료 빼기", "개발 진행"])
call("undo", {})
check("undo: 지운 저장한 필터 되살림", [p["name"] for p in ff.presets] == ["완료 빼기", "작업 중", "개발 진행"])
call("undo", {}); call("undo", {})
check("undo: 필터·이름 되돌림", ff.filter == {"status": ["completed", "none"], "category": []} and ff.presets[-1]["name"] == "개발만")
check("아무것도 안 넣으면 안내", raises(lambda: call("filter_set", {}), "하나는 넣으세요"))

hist = call("history", {"limit": 3})["changes"]
check("history: 최근 순·되돌림 표시", [h["tool"] for h in hist] == ["filter_delete", "filter_rename", "filter_set"] and all(h["undone"] for h in hist), hist)
check("알 수 없는 인자", raises(lambda: call("status", {"x": 1}), "인자가 올바르지 않습니다"))

# ---- 제어 서버 + MCP 서버
ctrl_path = os.path.join(tmp, "control.json")
server = ControlServer(tools, path=ctrl_path)
server.start()
info = json.load(open(ctrl_path, encoding="utf-8"))
def post(body, token=None, origin=None):
    req = urllib.request.Request(f"http://127.0.0.1:{info['port']}/call", data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + (token or info["token"]), "Content-Type": "application/json",
                                          **({"Origin": origin} if origin else {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)
check("제어 서버: 열쇠가 맞으면 실행", post({"tool": "status", "args": {}})[1]["ok"] is True)
check("제어 서버: 열쇠가 틀리면 거절", post({"tool": "status", "args": {}}, token="x")[0] == 401)
check("제어 서버: 브라우저 요청 거절", post({"tool": "status", "args": {}}, origin="https://evil.example")[0] == 404)
check("제어 서버: 도구 오류는 ok=false", post({"tool": "memo_delete", "args": {"id": "x"}})[1]["ok"] is False)
big = {"tool": "status", "args": {"pad": "x" * 100_000}}   # 읽지 않은 본문이 남으면 연결이 강제로 끊기던 크기
check("제어 서버: 거절 응답도 연결이 끊기지 않고 전달", all(
    post(big, origin="https://evil.example")[0] == 404 and post(big, token="x")[0] == 401 for _ in range(10)))

env = dict(os.environ, CODEX_MEMO_DATA=tmp)
lines = [
    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}},
    {"jsonrpc": "2.0", "method": "notifications/initialized"},
    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "threads_list", "arguments": {"status": "요청"}}},
    {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "memo_delete", "arguments": {"id": "nope", "confirm": True}}},
    {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "labels_assign", "arguments": {"threadIds": [UUID(1)], "bogus": 1}}},
]
p = subprocess.run([node_path(), str(ROOT / "labels" / "memo-mcp.cjs")], input="\n".join(json.dumps(l) for l in lines) + "\n",
                   capture_output=True, text=True, encoding="utf-8", env=env, timeout=60)
out = {m["id"]: m for m in map(json.loads, p.stdout.splitlines())}
check("MCP: 초기화(이름 codex_memo, 안내문)", out[1]["result"]["serverInfo"]["name"] == "codex_memo" and "undo" in out[1]["result"]["instructions"])
names = [t["name"] for t in out[2]["result"]["tools"]]
check("MCP: 도구 22개", len(names) == 22 and {"threads_move", "filters_list", "filter_set", "filter_save", "filter_rename", "filter_delete"} <= set(names), names)
check("MCP: 스키마에 type 배열 없음(Codex 호환)", "\"type\": [" not in json.dumps(out[2]["result"]["tools"]))
body = json.loads(out[3]["result"]["content"][0]["text"])
check("MCP → 제어 서버 → 도구", out[3]["result"]["isError"] is False and [t["threadId"] for t in body["threads"]] == [UUID(1)])
check("MCP: 도구 오류는 isError", out[4]["result"]["isError"] is True and "없습니다" in out[4]["result"]["content"][0]["text"])
check("MCP: 모르는 인자 거절", out[5]["result"]["isError"] is True)
server.stop()
check("제어 서버를 멈추면 control.json 정리", not os.path.exists(ctrl_path))
p = subprocess.run([node_path(), str(ROOT / "labels" / "memo-mcp.cjs")], input="\n".join(json.dumps(l) for l in (lines[0], lines[1], lines[3])) + "\n",
                   capture_output=True, text=True, encoding="utf-8", env=env, timeout=60)
off = json.loads(p.stdout.splitlines()[-1])
check("MCP: 도우미가 꺼져 있으면 안내", off["result"]["isError"] and "실행 중이 아닙니다" in off["result"]["content"][0]["text"])

print("\n결과:", "모두 통과" if ok else "실패 있음")
sys.exit(0 if ok else 1)
