"""바로 실행(quick_launch.py · quick_launch_ui.py). 임시 폴더의 목록·가짜 프로그램만 쓴다.

실행: python tests/test_quick_launch.py
"""
import atexit
import json
import os
import shutil
import socket
import sys
import tempfile
import time
import tkinter as tk
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import quick_launch  # noqa: E402
from quick_launch import LaunchError, QuickLaunch, validate  # noqa: E402
from quick_launch_ui import LaunchManager  # noqa: E402

ok = True
def check(name, cond, extra=""):
    global ok
    ok &= bool(cond)
    print(("✔ " if cond else "✘ ") + name, extra)


def raises(fn, text):
    try:
        fn()
    except LaunchError as e:
        return text in str(e)
    return False


tmp = Path(tempfile.mkdtemp())
atexit.register(shutil.rmtree, tmp, ignore_errors=True)   # 임시 목록·가짜 프로그램·로그 정리
work = tmp / "한글 폴더"
work.mkdir()
cmd = work / "테스트 실행.cmd"
# ping 은 전체 경로로(테스트를 돌리는 셸의 PATH 에 System32 가 없을 수 있음)
cmd.write_text('@echo off\r\necho OK %1\r\n"%SystemRoot%\\System32\\ping.exe" -n 4 127.0.0.1 >nul\r\n', encoding="ascii")

# ---- 예전 실행기 목록 가져오기(BOM 있는 UTF-8, PowerShell 형식)
legacy = tmp / "legacy.json"
legacy.write_text(json.dumps([{"id": "old-1", "name": "예전 항목", "path": str(cmd), "cwd": str(work), "arguments": "", "port": 0,
                                "url": "", "showWindow": False}], ensure_ascii=False), encoding="utf-8-sig")
path = tmp / "data" / "shortcuts.json"
ql = QuickLaunch(str(path), str(tmp / "logs"), legacy=(str(tmp / "없음.json"), str(legacy)))
check("처음 실행 때 예전 실행기 목록 복사", [i["name"] for i in ql.list()] == ["예전 항목"] and path.exists())
check("예전 파일은 그대로", legacy.read_text(encoding="utf-8-sig").startswith("["))
ql2 = QuickLaunch(str(path), str(tmp / "logs"), legacy=(str(legacy),))
check("이미 목록이 있으면 다시 가져오지 않음", len(ql2.list()) == 1)

# ---- 입력 확인
check("이름 필요", raises(lambda: validate({"path": str(cmd)}), "이름"))
check("없는 파일", raises(lambda: validate({"name": "x", "path": str(work / "없음.cmd")}), "실행 파일"))
txt = work / "a.txt"; txt.write_text("x")
check("확장자 확인", raises(lambda: validate({"name": "x", "path": str(txt)}), "BAT, CMD"))
check("포트 범위", raises(lambda: validate({"name": "x", "path": str(cmd), "port": "70000"}), "포트"))
check("웹 주소 형식", raises(lambda: validate({"name": "x", "path": str(cmd), "url": "ftp://a"}), "웹 주소"))
v = validate({"name": " 서버 ", "path": f'"{cmd}"', "port": "", "url": "http://127.0.0.1:1"})
check("따옴표·빈 포트·작업 폴더 기본값", v["path"] == str(cmd) and v["port"] == 0 and v["cwd"] == str(work) and v["name"] == "서버")

# ---- 저장·순서·삭제
a = ql.save({"name": "가", "path": str(cmd), "arguments": "하나"})
b = ql.save({"name": "나", "path": str(cmd)})
check("추가", [i["name"] for i in ql.list()] == ["예전 항목", "가", "나"])
ql.move(b["id"], -1)
check("위로", [i["name"] for i in ql.list()] == ["예전 항목", "나", "가"])
ql.move(b["id"], -5)
check("맨 위 넘어가지 않음", [i["name"] for i in ql.list()][0] == "나")
ql.save({"name": "가(고침)", "path": str(cmd), "arguments": "하나"}, a["id"])
check("수정은 같은 자리", [i["name"] for i in ql.list()] == ["나", "예전 항목", "가(고침)"])
ql.remove("old-1")
saved = json.loads(path.read_text(encoding="utf-8"))
check("파일에 저장·백업", [i["name"] for i in saved] == ["나", "가(고침)"] and (path.parent / "shortcuts.json.bak").exists())
events = []
ql.subscribe(lambda: events.append(1))
ql.move(a["id"], -1)
check("바뀌면 알림(트레이 메뉴 갱신)", events == [1])

# ---- 실행: 한글·공백 경로 CMD, 숨김, 로그, 중복 방지
item = ql.get(a["id"])
ql.start(item)
check("실행 중 상태", ql.state(item) == "running" and ql.state_text(item) == "실행 중")
check("실행 중이면 다시 켜지 않음", raises(lambda: ql.start(item), "이미 실행"))
ql.runs[item["id"]].wait(15)
time.sleep(0.2)
logs = sorted((tmp / "logs").glob("*.out.log"))
check("표준 출력 로그(인수 전달)", logs and "OK 하나" in logs[-1].read_text(errors="replace"), logs and logs[-1].read_text(errors="replace"))
check("끝나면 상태 표시", ql.state_text(item) == "실행 명령 끝남 (0)")

# ---- 포트: 이미 응답하면 켜지 않고 웹 주소를 연다
srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen()
port = srv.getsockname()[1]
p_item = ql.save({"name": "서버", "path": str(cmd), "port": str(port), "url": f"http://127.0.0.1:{port}/"})
check("포트 응답 → 실행 중", ql.state(p_item) == "port")
check("포트 사용 중이면 켜지 않음", raises(lambda: ql.start(p_item), "사용 중"))
opened = []
quick_launch.webbrowser.open = lambda url: opened.append(url)
check("트레이에서 누르면 웹 화면", ql.activate(p_item).endswith("웹 화면을 열었습니다.") and opened == [f"http://127.0.0.1:{port}/"])
srv.close()
noport = ql.save({"name": "웹 없음", "path": str(cmd)})
msg = ql.activate(noport)
check("꺼져 있으면 켬", msg == "웹 없음: 실행했습니다." and ql.state(noport) == "running", msg)
check("웹 주소 없으면 안내", raises(lambda: ql.open_url(noport), "웹 주소"))
ql.runs[noport["id"]].wait(15)

# ---- 관리 창
root = tk.Tk(); root.withdraw()
ui = LaunchManager(root, ql)
ui.open(); root.update()
names = [ui.tree.item(i, "text") for i in ui.tree.get_children()]
check("관리 창 목록(순서대로)", names == [i["name"] for i in ql.list()], names)
ui.tree.selection_set(p_item["id"]); ui.move(-1); root.update()
check("관리 창에서 위로", [ui.tree.item(i, "text") for i in ui.tree.get_children()].index("서버") == names.index("서버") - 1
      and ui.selected() == p_item["id"])
deadline = time.monotonic() + 3
while ui._active_probe is not None and time.monotonic() < deadline:
    root.update(); time.sleep(0.01)
states = {ui.tree.item(i, "text"): ui.tree.set(i, "state") for i in ui.tree.get_children()}
check("상태 열", states["서버"] in ("포트 응답 없음", "켜는 중 (포트 응답 없음)") and states["가(고침)"].startswith("실행 명령 끝남"), states)
ui.tree.selection_set(()); ui.run(); root.update()
check("고르지 않고 실행하면 안내", "고르세요" in ui.status.cget("text"))
ui.win.destroy(); root.destroy()

print("\n결과:", "모두 통과" if ok else "실패 있음")
sys.exit(0 if ok else 1)
