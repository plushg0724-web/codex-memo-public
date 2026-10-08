"""바로 실행 관리 창(tkinter): 목록 보기·추가·수정·삭제·순서 바꾸기·실행·웹 열기."""

import os
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from quick_launch import LaunchError, open_ports

FONT = ("맑은 고딕", 10)
FIELDS = (("name", "이름"), ("path", "실행 파일"), ("cwd", "작업 폴더"), ("arguments", "실행 인수"),
          ("port", "포트 (선택)"), ("url", "웹 주소 (선택)"))


class LaunchManager:
    def __init__(self, root, launcher):
        self.root = root
        self.ql = launcher
        self.win = None
        self._window_generation = 0
        self._items = {}
        self._checked_ports = frozenset()
        self._responding = set()
        self._probe_failed = False
        self._probe_results = queue.SimpleQueue()
        self._active_probe = None
        self._wanted_probe = None
        self._probe_after = None
        self._refresh_after = None

    # ---------- 창
    def open(self):
        if self.win is not None and self.win.winfo_exists():
            self.win.deiconify(); self.win.lift(); self.win.focus_force()
            self.refresh()
            return
        w = self.win = tk.Toplevel(self.root)
        self._window_generation += 1
        w.title("바로 실행 · Codex 메모")
        w.geometry("900x460")
        w.minsize(720, 360)
        w.option_add("*Font", FONT)
        style = ttk.Style(w)
        style.configure("Treeview", rowheight=26, font=FONT)
        style.configure("Treeview.Heading", font=FONT)

        bar = ttk.Frame(w, padding=(10, 10, 10, 4))
        bar.pack(fill="x")
        for text, fn in (("추가", self.add), ("수정", self.edit), ("삭제", self.delete), ("▲ 위로", lambda: self.move(-1)),
                         ("▼ 아래로", lambda: self.move(1)), ("실행", self.run), ("웹 열기", self.web),
                         ("로그 폴더", self.ql.open_logs), ("새로고침", self.reload)):
            ttk.Button(bar, text=text, command=fn).pack(side="left", padx=(0, 6))

        cols = ("state", "port", "path")
        self.tree = ttk.Treeview(w, columns=cols, show="tree headings", selectmode="browse")
        self.tree.heading("#0", text="프로그램"); self.tree.column("#0", width=200, stretch=False)
        self.tree.heading("state", text="상태"); self.tree.column("state", width=170, stretch=False)
        self.tree.heading("port", text="포트"); self.tree.column("port", width=60, stretch=False, anchor="center")
        self.tree.heading("path", text="실행 파일"); self.tree.column("path", width=420)
        self.tree.pack(fill="both", expand=True, padx=10)
        self.tree.bind("<Double-1>", lambda e: self.run())
        self.tree.bind("<Return>", lambda e: self.run())
        self.tree.bind("<Delete>", lambda e: self.delete())

        self.status = ttk.Label(w, padding=(12, 8), foreground="#555",
                                text="트레이 메뉴의 '바로 실행'에 이 순서대로 나옵니다. 누르면 켜고, 이미 켜져 있으면 웹 화면을 엽니다.")
        self.status.pack(fill="x")
        w.protocol("WM_DELETE_WINDOW", w.destroy)
        w.bind("<Destroy>", self._window_destroyed, add="+")
        self.refresh()
        w.lift(); w.focus_force()

    def refresh(self, select=None):
        if self.win is None or not self.win.winfo_exists():
            return
        keep = select or self.selected()
        items = self.ql.list()
        self._items = {item["id"]: item for item in items}
        xview, yview = self.tree.xview(), self.tree.yview()
        focus = self.tree.focus()
        children = self.tree.get_children()
        removed = [item_id for item_id in children if item_id not in self._items]
        if removed:
            self.tree.delete(*removed)
        reordered = tuple(item["id"] for item in items) != children
        for index, item in enumerate(items):
            values = (self._state_text(item), item.get("port") or "—", item["path"])
            if self.tree.exists(item["id"]):
                self.tree.item(item["id"], text=item["name"], values=values)
                if reordered:
                    self.tree.move(item["id"], "", index)
            else:
                self.tree.insert("", index, iid=item["id"], text=item["name"], values=values)
        if keep and self.tree.exists(keep):
            self.tree.selection_set(keep)
        if focus and self.tree.exists(focus):
            self.tree.focus(focus)
        if xview:
            self.tree.xview_moveto(xview[0])
        if yview:
            self.tree.yview_moveto(yview[0])
        if select and self.tree.exists(select):
            self.tree.see(select)
        self._request_probe(items)

    def _state_text(self, item):
        port = str(item.get("port") or "")
        if port and port not in self._checked_ports:
            return "포트 확인 중…"
        if port and self._probe_failed:
            return "포트 확인 실패"
        # 빈 집합도 전달해 목록을 그리는 동안 개별 포트 확인이 실행되지 않게 한다.
        return self.ql.state_text(item, self._responding)

    def _request_probe(self, items):
        ports = frozenset(str(item["port"]) for item in items if item.get("port"))
        self._wanted_probe = (self._window_generation, ports) if ports else None
        if self._active_probe is None and self._wanted_probe is not None:
            self._start_probe()
        self._schedule_probe_poll()

    def _start_probe(self):
        request = self._active_probe = self._wanted_probe
        # 한 번에 작업 하나만 실행한다. 그동안 받은 요청은 _wanted_probe 하나로 합친다.
        threading.Thread(target=self._probe_ports, args=(request,), daemon=True,
                         name="quick-launch-ports").start()

    def _probe_ports(self, request):
        try:
            responding, failed = open_ports(request[1]), False
        except Exception:
            responding, failed = set(), True
        # 작업 스레드는 Tk 객체나 창 상태에 접근하지 않는다.
        self._probe_results.put((request, responding, failed))

    def _schedule_probe_poll(self):
        if self._active_probe is not None and self._probe_after is None and self.win is not None:
            self._probe_after = self.root.after(50, self._poll_probe)

    def _poll_probe(self):
        self._probe_after = None
        try:
            request, responding, failed = self._probe_results.get_nowait()
        except queue.Empty:
            self._schedule_probe_poll()
            return
        self._active_probe = None
        if self.win is not None and request == self._wanted_probe:
            self._checked_ports, self._responding = request[1], responding
            self._probe_failed = failed
            self._wanted_probe = None
            # 행 자체를 재생성하지 않아 확인 중 바뀐 선택과 스크롤을 유지한다.
            for item in self._items.values():
                self.tree.set(item["id"], "state", self._state_text(item))
        if self.win is not None and self._wanted_probe is not None:
            self._start_probe()
        self._schedule_probe_poll()

    def _cancel_timer(self, attribute):
        timer = getattr(self, attribute)
        setattr(self, attribute, None)
        if timer is not None:
            try:
                self.root.after_cancel(timer)
            except tk.TclError:
                pass

    def _window_destroyed(self, event):
        if event.widget is not self.win:
            return
        self.win = None
        self._wanted_probe = None
        self._items = {}
        self._checked_ports = frozenset()
        self._responding = set()
        self._probe_failed = False
        self._cancel_timer("_probe_after")
        self._cancel_timer("_refresh_after")

    def _refresh_after_run(self):
        self._refresh_after = None
        self.refresh()

    def selected(self):
        sel = self.tree.selection() if self.win is not None and self.win.winfo_exists() else ()
        return sel[0] if sel else None

    def say(self, text):
        self.status.configure(text=text)

    def _item(self):
        item_id = self.selected()
        if not item_id:
            self.say("목록에서 프로그램을 고르세요.")
            return None
        return self.ql.get(item_id)

    # ---------- 동작
    def add(self):
        self.edit_dialog(None)

    def edit(self):
        item = self._item()
        if item:
            self.edit_dialog(item)

    def delete(self):
        item = self._item()
        if item and messagebox.askyesno("바로 실행", f"'{item['name']}' 을(를) 목록에서 지울까요?\n(실행 중인 프로그램은 그대로 둡니다)", parent=self.win):
            self.ql.remove(item["id"])
            self.refresh()
            self.say("목록에서 지웠습니다. 실행한 프로그램은 그대로입니다.")

    def move(self, offset):
        item = self._item()
        if item:
            self.ql.move(item["id"], offset)
            self.refresh(item["id"])

    def run(self):
        item = self._item()
        if not item:
            return
        try:
            self.ql.start(item)
            self.say(f"{item['name']}: 실행했습니다." + (" 웹 화면은 '웹 열기'로 엽니다." if item.get("url") else ""))
        except LaunchError as e:
            self.say(str(e))
        except OSError as e:
            messagebox.showerror("바로 실행", f"실행하지 못했습니다.\n{e}", parent=self.win)
        self._cancel_timer("_refresh_after")
        self._refresh_after = self.root.after(1500, self._refresh_after_run)

    def web(self):
        item = self._item()
        if item:
            try:
                self.ql.open_url(item)
            except LaunchError as e:
                self.say(str(e))

    def reload(self):
        try:
            self.ql.reload()
        except (OSError, ValueError) as e:
            messagebox.showerror("바로 실행", f"목록을 읽지 못했습니다.\n{e}", parent=self.win)
        self.refresh()

    # ---------- 추가·수정 창
    def edit_dialog(self, existing):
        d = tk.Toplevel(self.win)
        d.title("바로가기 수정" if existing else "바로가기 추가")
        d.transient(self.win); d.resizable(False, False)
        frame = ttk.Frame(d, padding=16)
        frame.pack(fill="both", expand=True)
        vars_ = {}
        for row, (key, label) in enumerate(FIELDS):
            ttk.Label(frame, text=label).grid(row=row, column=0, sticky="w", pady=4, padx=(0, 10))
            v = tk.StringVar(value=str(existing.get(key) or "") if existing else "")
            if key == "port" and existing and not existing.get("port"):
                v.set("")
            ttk.Entry(frame, textvariable=v, width=52).grid(row=row, column=1, sticky="we", pady=4)
            vars_[key] = v

        def browse():
            path = filedialog.askopenfilename(parent=d, filetypes=[("실행 파일", "*.bat *.cmd *.exe *.lnk *.ps1"), ("모든 파일", "*.*")])
            if path:
                path = os.path.normpath(path)
                vars_["path"].set(path)
                if not vars_["cwd"].get():
                    vars_["cwd"].set(os.path.dirname(path))
                if not vars_["name"].get():
                    vars_["name"].set(os.path.splitext(os.path.basename(path))[0])
        ttk.Button(frame, text="찾아보기", command=browse).grid(row=1, column=2, padx=(6, 0))
        show = tk.BooleanVar(value=bool(existing and existing.get("showWindow")))
        ttk.Checkbutton(frame, text="실행 창 표시 (콘솔 입력이나 GUI 가 필요한 경우)", variable=show).grid(row=len(FIELDS), column=1, sticky="w", pady=(8, 2))
        ttk.Label(frame, foreground="#666", wraplength=460,
                  text="포트는 이미 켜져 있는지 확인하는 데만 씁니다. 서버의 실제 포트는 BAT 나 실행 인수에서 정하세요.").grid(
            row=len(FIELDS) + 1, column=0, columnspan=3, sticky="w", pady=(4, 10))
        buttons = ttk.Frame(frame)
        buttons.grid(row=len(FIELDS) + 2, column=0, columnspan=3, sticky="e")

        def save():
            try:
                item = self.ql.save({**{k: v.get() for k, v in vars_.items()}, "showWindow": show.get()},
                                    existing["id"] if existing else None)
            except LaunchError as e:
                messagebox.showerror("바로 실행", str(e), parent=d)
                return
            d.destroy()
            self.refresh(item["id"])
            self.say(f"'{item['name']}' 을(를) 저장했습니다.")
        ttk.Button(buttons, text="저장", command=save).pack(side="left", padx=(0, 6))
        ttk.Button(buttons, text="취소", command=d.destroy).pack(side="left")
        d.bind("<Escape>", lambda e: d.destroy())
        d.bind("<Return>", lambda e: save())
        d.grab_set()
        d.focus_force()
