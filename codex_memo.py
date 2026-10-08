"""Codex 메모 — 공식 Codex 앱(Microsoft Store)에 메모·형광펜·스레드 라벨·단어장을 더하는 도우미.

Codex 를 디버그 포트를 연 상태로 실행하고(codex_app), 화면에 스크립트를 넣는다(cdp_bridge).
메모는 memos/memos.json(memo_store), 라벨·단어장은 기존 Codex Labels 폴더의 파일을 쓴다.
이 파일은 트레이 아이콘을 맡는다. 메모 목록은 Codex 안의 단어장·메모 창이 대신한다.

주의: 디버그 포트(127.0.0.1)가 열려 있는 동안에는 같은 PC의 다른 프로그램도
Codex 화면에 접근할 수 있다. Codex 를 일반 방식으로 다시 열면 포트는 닫힌다.
"""

import ctypes
import os
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
import webbrowser
from tkinter import messagebox

import pystray
from PIL import Image, ImageDraw
from pynput import keyboard

import updater
from agent_tools import AgentTools
from backup_ui import BackupWindow
from pet_settings_ui import PetSettingsWindow
from cdp_bridge import Bridge
from codex_app import close_codex, codex_pids, debug_port_alive, focus_codex, launch_codex
from control_server import ControlServer
from memo_store import MemoStore
from quick_launch import LaunchError, QuickLaunch
from quick_launch_ui import LaunchManager
from paths import DATA_DIR, MEMO_DIR, migrate_legacy, version

APP_TITLE = "Codex 메모"
LIST_HOTKEY = "<ctrl>+<alt>+m"
UPDATE_CHECK_MS = 24 * 60 * 60 * 1000   # 하루에 한 번 새 버전 확인
WATCH_MS = 5000                          # Codex 가 일반 모드로 켜졌는지 확인하는 간격
WATCH_CONFIRM = 2                        # 연속 이만큼 확인돼야 묻는다 (막 켜지는 중일 때 묻지 않게)
LAUNCH_QUIET_S = 30                      # 도우미가 Codex 를 다시 시작한 뒤 이 시간 동안은 묻지 않는다
PUMP_BATCH = 100                         # 한 번에 처리할 이벤트 수 (대량의 백엔드 이벤트가 Tk 입력·창 그리기를 밀어내지 않게)
PUMP_IDLE_MS = 100                       # 처리할 이벤트가 없을 때 다시 확인하는 간격

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass


def single_instance():
    kernel32.CreateMutexW(None, False, r"Local\CodexDragMemoHelper")
    return ctypes.get_last_error() != 183  # ERROR_ALREADY_EXISTS


# ---------------------------------------------------------------- 트레이 아이콘
def tray_image():
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((6, 4, 58, 60), radius=8, fill="#ffd43b", outline="#e0a800", width=2)
    for y in (20, 31, 42):
        d.rounded_rectangle((15, y, 49, y + 5), radius=2, fill="#3b5bdb")
    d.polygon([(42, 60), (58, 44), (58, 60)], fill="#e0a800")
    return img


# ---------------------------------------------------------------- 앱
# 트레이 메뉴의 분류기 선택지 (labels/mica.cjs MODES)
CLASSIFIERS = (("mica", "Mica (로컬, 무료)"), ("jev", "JEV (클라우드)"), ("both", "둘 다 (확률 평균)"))


class App:
    def __init__(self):
        self.root = tk.Tk()
        self.root.withdraw()
        self.events = queue.Queue()
        self._closing = False
        self.restarting = False
        self.plain_seen = 0                # Codex 가 일반 모드로 연속 확인된 횟수
        self.declined = frozenset()        # '아니요'를 누른 Codex 의 프로세스들 (그 Codex 가 켜져 있는 동안 다시 묻지 않음)
        self.quiet_until = 0.0
        self.asking = False

        migrate_legacy()
        self.store = MemoStore(MEMO_DIR)
        self.backup_ui = BackupWindow(self)
        self.pet_settings_ui = PetSettingsWindow(self)
        self.update = None         # 새 버전 정보 (updater.check)
        self.bridge = Bridge(self.store, on_error=lambda text: self.events.put(("error", text)),
                             on_pet_settings=lambda: self.events.put(("pet_settings",)))
        self.bridge.start()
        # Codex 대화의 모델이 메모·라벨·단어장을 다루는 도구(labels/memo-mcp.cjs → 이 서버)
        try:
            self.control = ControlServer(AgentTools(self.bridge, self.store))
            self.control.start()
        except Exception as e:
            self.control = None
            self.events.put(("error", f"모델 도구 서버를 시작하지 못했습니다.\n{e}"))
        # 바로 실행: 트레이에서 자주 쓰는 프로그램 켜기 (예전 '바로실행' 실행기를 옮겨 옴)
        try:
            self.launcher = QuickLaunch()
        except (OSError, ValueError) as e:
            self.launcher = None
            self.events.put(("error", f"바로 실행 목록을 읽지 못했습니다. shortcuts.json 을 확인하세요.\n{e}"))
        self.launch_ui = LaunchManager(self.root, self.launcher) if self.launcher else None
        if self.launcher:
            self.launcher.subscribe(lambda: self.events.put(("menu",)))
        self.sheets = {}           # Google 시트 연결 상태 (labels/backend.cjs sheetsStatus)
        self.refresh_sheets()
        self.classifier = {}       # 분류기 선택 상태 (labels/backend.cjs classifierGet)
        self.refresh_classifier()
        # 다른 스레드(트레이·백엔드·감시)가 self.events 로 보낸 일을 Tk 스레드에서 처리하는 곳. "quit" 은 _drain 이 맡는다.
        self._handlers = {
            "list": self.open_list,
            "codex_state": self.on_codex_state,
            "restart": self.confirm_restart,
            "reload": self.confirm_reload,
            "launch": self.launch,
            "launcher": self.open_launcher,
            "launch_logs": self.open_launch_logs,
            "menu": self.update_menu,
            "folder": self.open_folder,
            "open_url": self.open_sheet_link,
            "backup": self.backup_ui.open,
            "backup_result": self.backup_ui.result,
            "pet_settings": self.pet_settings_ui.open,
            "pet_settings_result": self.pet_settings_ui.result,
            "sheets_connect": self.connect_sheets,
            "sheets": self.on_sheets,
            "classifier": self.set_classifier,
            "mica_link": lambda: webbrowser.open("https://huggingface.co/sky7350/Mica-v0.1-4B"),
            "classifier_state": self.on_classifier,
            "update": self.on_update_clicked,
            "update_found": self.on_update_found,
            "info": self.show_info,
            "error": self.show_error,
        }
        self._start_tray()
        self.hotkeys = keyboard.GlobalHotKeys({LIST_HOTKEY: lambda: self.events.put(("list",))})
        self.hotkeys.daemon = True
        self.hotkeys.start()
        self.root.after(200, self.ensure_codex)
        if "--account-backup" in sys.argv:
            self.root.after(700, self.backup_ui.open)
        self.root.after(5000, self.check_update)
        self.root.after(WATCH_MS, self.watch_codex)
        self.root.after(50, self._pump)

    # ---------- Codex 를 메모 모드(디버그 포트)로
    def ensure_codex(self):
        """시작할 때: Codex 가 꺼져 있으면 메모 모드로 켜고, 일반 모드로 켜져 있으면 묻는다."""
        if debug_port_alive():
            return
        pids = frozenset(codex_pids())
        if pids:
            self.ask_restart(pids)
        else:
            self.restart_codex(close_first=False)

    def ask_restart(self, pids):
        """일반 모드로 켜진 Codex 를 메모 모드로 다시 시작할지 묻는다. '아니요'면 그 Codex 에는 다시 묻지 않는다."""
        if self.asking:
            return
        self.asking = True
        try:
            # 숨겨진 루트 창 대신 맨 앞에 뜨는 임시 창을 부모로 써서 Codex 창 뒤에 가려지지 않게 한다
            top = tk.Toplevel(self.root)
            top.withdraw()
            top.attributes("-topmost", True)
            yes = messagebox.askyesno(
                APP_TITLE,
                "Codex가 메모 기능 없이 실행 중입니다. (업데이트 후 다시 켜진 경우 등)\n"
                "메모·단어장·라벨을 쓰려면 Codex를 메모 모드로 다시 시작해야 합니다.\n\n"
                "지금 다시 시작할까요? (진행 중인 Codex 작업이 끊길 수 있습니다)", parent=top)
            top.destroy()
        finally:
            self.asking = False
        self.plain_seen = 0
        if yes:
            self.restart_codex(close_first=True)
        else:
            self.declined = pids

    def watch_codex(self):
        """Codex 가 디버그 포트 없이(일반 모드로) 켜져 있는지 백그라운드에서 확인한다."""
        def work():
            pids = frozenset(codex_pids())
            self.events.put(("codex_state", pids, bool(pids) and debug_port_alive()))

        threading.Thread(target=work, daemon=True).start()
        self.root.after(WATCH_MS, self.watch_codex)

    def on_codex_state(self, pids, memo_mode):
        plain = bool(pids) and not memo_mode
        if not plain or self.restarting or time.time() < self.quiet_until or (pids & self.declined):
            self.plain_seen = 0
            return
        self.plain_seen += 1
        if self.plain_seen >= WATCH_CONFIRM:
            self.ask_restart(pids)

    def restart_codex(self, close_first=True):
        if self.restarting:
            return
        self.restarting = True

        def work():
            try:
                if close_first:
                    close_codex()
                self.quiet_until = time.time() + LAUNCH_QUIET_S
                launch_codex()
            except Exception as e:
                self.events.put(("error", f"Codex 실행에 실패했습니다.\n{e}"))
            finally:
                self.restarting = False

        threading.Thread(target=work, daemon=True).start()

    # ---------- 트레이
    def _emit(self, *event):
        """트레이 메뉴 항목 동작: 누르면 이벤트를 Tk 스레드의 처리 대기열(self.events)로 넘긴다."""
        return lambda icon, item: self.events.put(event)

    def _launch_items(self):
        """'바로 실행' 하위 메뉴: 등록한 프로그램(관리 창의 순서대로) + 관리"""
        items = [pystray.MenuItem(i["name"], self._emit("launch", i["id"])) for i in (self.launcher.list() if self.launcher else [])]
        if not items:
            items = [pystray.MenuItem("등록한 프로그램 없음", None, enabled=False)]
        return (*items, pystray.Menu.SEPARATOR,
                pystray.MenuItem("바로 실행 관리…", self._emit("launcher")),
                pystray.MenuItem("실행 기록(로그) 폴더", self._emit("launch_logs")))

    def _start_tray(self):
        put = self._emit
        has = lambda key: (lambda item: bool(self.sheets.get(key)))
        menu = pystray.Menu(
            # 자주 쓰는 것
            pystray.MenuItem("메모 목록 열기  (Ctrl+Alt+M)", put("list"), default=True),
            pystray.MenuItem("바로 실행", pystray.Menu(self._launch_items), visible=lambda item: self.launcher is not None),
            pystray.MenuItem("계정 백업 · 복원…", put("backup")),
            pystray.MenuItem("펫 설정…", put("pet_settings")),
            pystray.MenuItem("열기", pystray.Menu(
                pystray.MenuItem("Google 시트", put("open_url", "url"), visible=has("url")),
                pystray.MenuItem("Space 페이지", put("open_url", "spacePageUrl"), visible=has("spacePageUrl")),
                pystray.MenuItem("메모 폴더", put("folder")),
            )),
            pystray.MenuItem(lambda item: f"업데이트 설치 (v{self.update['version']})", put("update"),
                             visible=lambda item: bool(self.update)),
            pystray.Menu.SEPARATOR,
            # Codex 연결·설정
            pystray.MenuItem(lambda item: "Codex  (연결됨)" if self.bridge.connected else "Codex  (연결 안 됨)", pystray.Menu(
                pystray.MenuItem("Codex 화면 새로 고침", put("reload")),
                pystray.MenuItem("Codex 메모 모드로 다시 시작", put("restart")),
            )),
            pystray.MenuItem("설정", pystray.Menu(
                pystray.MenuItem("분류기 (뜻 판단·라벨 추천)", pystray.Menu(*[
                    pystray.MenuItem(text, put("classifier", mode), radio=True,
                                     checked=lambda item, mode=mode: self.classifier.get("mode", "mica") == mode)
                    for mode, text in CLASSIFIERS],
                    pystray.Menu.SEPARATOR,
                    pystray.MenuItem("Mica · Hugging Face에서 보기", put("mica_link"))), visible=lambda item: bool(self.bridge.labels)),
                pystray.MenuItem("Google 시트 연결…", put("sheets_connect"),
                                 visible=lambda item: bool(self.bridge.labels) and not self.sheets.get("connected")),
                pystray.MenuItem(lambda item: f"업데이트 확인 (현재 v{version()})", put("update"),
                                 visible=lambda item: not self.update),
            )),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("종료", put("quit")),
        )
        self.tray = pystray.Icon("codex_memo", tray_image(), APP_TITLE, menu)
        self.tray.run_detached()

    def _pump(self):
        if self._closing:
            return
        try:
            if self._drain():
                self._sync_title()
        except Exception as error:
            self.root.report_callback_exception(type(error), error, error.__traceback__)
        finally:
            # 처리 중 예외가 나도 이벤트 처리를 멈추지 않는다(종료한 뒤에는 다시 예약하지 않음).
            if not self._closing:
                self.root.after(1 if not self.events.empty() else PUMP_IDLE_MS, self._pump)

    def _drain(self):
        """쌓인 이벤트를 최대 PUMP_BATCH 개 처리한다. 종료 이벤트를 처리했으면 False."""
        for _ in range(PUMP_BATCH):
            try:
                kind, *args = self.events.get_nowait()
            except queue.Empty:
                break
            if kind == "quit":
                self.shutdown()
                return False
            handler = self._handlers.get(kind)
            if handler is None:
                continue
            try:
                handler(*args)
            except Exception as error:
                # 한 콜백 실패 뒤에도 다른 트레이·백엔드 이벤트를 계속 처리한다.
                self.root.report_callback_exception(type(error), error, error.__traceback__)
        return True

    def _sync_title(self):
        title = f"{APP_TITLE} · " + ("연결됨" if self.bridge.connected else "연결 안 됨")
        if self.tray.title != title:
            self.tray.title = title
            self.tray.update_menu()

    # ---------- 이벤트 처리 (Tk 스레드)
    def update_menu(self):
        self.tray.update_menu()

    def show_info(self, text):
        messagebox.showinfo(APP_TITLE, text)

    def show_error(self, text):
        messagebox.showerror(APP_TITLE, text)

    def confirm_restart(self):
        if messagebox.askyesno(APP_TITLE, "Codex를 메모 모드로 다시 시작할까요?\n"
                                          "(진행 중인 Codex 작업이 끊길 수 있습니다)"):
            self.restart_codex(close_first=bool(codex_pids()))

    def confirm_reload(self):
        # 메모·라벨·단어장 코드를 새 버전으로 바꾸려면 Codex 화면을 한 번 새로 고친다 (F5 와 같음)
        if messagebox.askyesno(APP_TITLE, "Codex 화면을 새로 고칠까요?\n"
                                          "작성 중인 메시지가 있으면 먼저 보내 주세요."):
            self.bridge.reload_pages()

    def open_launcher(self):
        if self.launch_ui:
            self.launch_ui.open()

    def open_launch_logs(self):
        if self.launcher:
            self.launcher.open_logs()

    def open_sheet_link(self, key):
        if self.sheets.get(key):
            webbrowser.open(self.sheets[key])

    def on_sheets(self, value):
        self.sheets = value or {}
        self.tray.update_menu()

    def on_classifier(self, value):
        self.classifier = value or {}
        self.tray.update_menu()

    def on_update_clicked(self):
        if self.update:
            self.install_update()
        else:
            self.check_update(manual=True)

    def on_update_found(self, found, manual):
        self.update = found
        self.tray.update_menu()
        if manual:   # 직접 확인한 경우에만 바로 묻는다 (자동 확인은 알림만)
            self.install_update()
            return
        try:
            self.tray.notify(f"새 버전 v{found['version']} 이 있습니다. 트레이 메뉴에서 설치하세요.", APP_TITLE)
        except Exception:
            pass

    def shutdown(self):
        if self._closing:
            return
        self._closing = True
        cleanup = [self.backup_ui.shutdown, self.hotkeys.stop]
        if self.control:
            cleanup.append(self.control.stop)
        cleanup.extend((self.bridge.stop, self.tray.stop))
        for close in cleanup:
            try:
                close()
            except Exception as error:
                self.root.report_callback_exception(type(error), error, error.__traceback__)
        self.root.destroy()

    def _request_state(self, method, event):
        """백엔드 상태를 백그라운드로 읽어 event 로 넘긴다(실패하면 이전 상태 유지)."""
        if self.bridge.labels:
            self.bridge.labels.request(method, [], lambda ok, value: ok and self.events.put((event, value)))

    # ---------- Google 시트 (단어·메모 표)
    def refresh_sheets(self):
        self._request_state("sheetsStatus", "sheets")

    # ---------- 분류기 (Mica 로컬 / JEV 클라우드 / 둘 다)
    def refresh_classifier(self):
        self._request_state("classifierGet", "classifier_state")

    def set_classifier(self, mode):
        if not self.bridge.labels:
            return
        if mode in ("jev", "both"):
            if not os.environ.get("JEV_API_KEY"):
                messagebox.showerror(APP_TITLE, "JEV 를 쓰려면 환경 변수 JEV_API_KEY 가 필요합니다.\n"
                                                "설정한 뒤 Codex 메모를 다시 시작해 주세요.")
                return
            if self.classifier.get("mode", "mica") == "mica" and not messagebox.askyesno(
                    APP_TITLE, "JEV 는 클라우드 분류기입니다.\n"
                               "단어 문맥·대화 제목과 요청 일부가 TypeSafe(api.typesafe.ai)로 전송됩니다. 사용할까요?"):
                return

        def done(ok, value):
            if ok:
                self.events.put(("classifier_state", value))
            else:
                self.events.put(("error", f"분류기를 바꾸지 못했습니다.\n{value}"))

        self.bridge.labels.request("classifierSet", [mode], done)

    def connect_sheets(self):
        if not self.bridge.labels:
            return
        memos = self.store.load()
        if not messagebox.askyesno(
                APP_TITLE,
                "Google Drive 에 'Codex 단어장·메모' 시트를 만들고,\n"
                f"지금까지 저장한 단어와 메모({len(memos)}개)를 넣습니다.\n"
                "Space 에 시트 링크 페이지도 만듭니다.\n\n"
                "이후 단어·메모를 저장할 때마다 행이 자동으로 추가됩니다. 진행할까요?\n"
                "(ChatGPT 에 Google Drive 가 연결돼 있어야 합니다)"):
            return

        def done(ok, value):
            if not ok:
                self.events.put(("error", f"Google 시트를 연결하지 못했습니다.\n{value}"))
                return
            self.events.put(("sheets", value))
            text = "Google 시트를 연결했습니다."
            if value.get("spaceError"):
                text += f"\n\nSpace 링크 페이지는 만들지 못했습니다: {value['spaceError']}"
            self.events.put(("info", text))
            if value.get("url"):
                webbrowser.open(value["url"])

        self.bridge.labels.request("sheetsConnect", [memos], done)

    # ---------- 업데이트
    def check_update(self, manual=False):
        def work():
            try:
                found = updater.check()
            except Exception as e:
                if manual:
                    self.events.put(("error", f"업데이트를 확인하지 못했습니다.\n{e}"))
                return
            if found:
                self.events.put(("update_found", found, manual))
            elif manual:
                self.events.put(("info", f"최신 버전입니다 (v{version()})."))

        threading.Thread(target=work, daemon=True).start()
        if not manual:
            self.root.after(UPDATE_CHECK_MS, self.check_update)

    def install_update(self):
        u = self.update
        notes = f"\n\n{u['notes'][:600]}" if u.get("notes") else ""
        if not messagebox.askyesno(APP_TITLE, f"새 버전 v{u['version']} 을 설치하고 다시 시작할까요?\n"
                                              f"(현재 v{version()}, 메모·설정은 그대로 유지됩니다){notes}"):
            return

        def work():
            try:
                updater.install(u)
            except Exception as e:
                self.events.put(("error", f"업데이트하지 못했습니다.\n{e}"))
                return
            updater.restart()
            self.events.put(("quit",))

        threading.Thread(target=work, daemon=True).start()

    def open_folder(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        subprocess.Popen(["explorer", DATA_DIR])

    # ---------- 바로 실행
    def launch(self, item_id):
        """트레이 '바로 실행'에서 누름: 켜거나, 이미 켜져 있으면 웹 화면을 연다"""
        item = self.launcher.get(item_id) if self.launcher else None
        if not item:
            return
        try:
            text = self.launcher.activate(item)
        except LaunchError as e:
            text = str(e)
        except OSError as e:
            messagebox.showerror("바로 실행", f"{item['name']}: 실행하지 못했습니다.\n{e}")
            return
        try:
            self.tray.notify(text, "바로 실행")
        except Exception:
            pass

    # ---------- 메모 목록 = Codex 안의 단어장·메모 창 (메모 필터)
    def open_list(self):
        focus_codex()
        if not self.bridge.open_library("memo"):
            messagebox.showinfo(APP_TITLE, "Codex가 메모 모드로 연결돼 있지 않습니다.\n"
                                           "트레이의 'Codex 메모 모드로 다시 시작'을 눌러 주세요.")

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    if not single_instance():
        raise SystemExit(0)
    App().run()
