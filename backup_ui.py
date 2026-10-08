"""계정 백업 창. 요청 상태는 창의 표시 여부와 독립적으로 유지한다."""
from datetime import datetime
import tkinter as tk
from tkinter import ttk, messagebox
import webbrowser


REQUEST_TIMEOUT_MS = 180_000
STATUS_TIMEOUT_MS = 15_000
BUSY_POLL_MS = 2_000
ACTION_TEXT = {
    "status": "계정 백업 상태 확인 중…",
    "list": "백업 목록 불러오는 중…",
    "create": "계정에 백업 저장 중…",
    "restore": "선택한 백업 복원 중…",
    "configure": "자동 백업 설정 저장 중…",
}


def display_time(value):
    if not value:
        return "없음"
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError, OverflowError):
        return str(value)


class BackupWindow:
    def __init__(self, app):
        self.app = app
        self.window = None
        self.items = {}
        self._visible = False
        self._pending = None
        self._request_id = 0
        self._timeout = None
        self._poll = None
        self._backend_busy = False
        self._automatic = False
        self._last = {}
        self._refresh_after_status = False
        self._force_list = False
        self._preferred_page = None
        self._completion = ""

    def open(self):
        if self.window is None:
            self._build()
        self._visible = True
        self.window.deiconify()
        self.window.lift()
        self._update_controls()
        if not self._pending:
            self.refresh(force=False)

    def _build(self):
        self.window = tk.Toplevel(self.app.root)
        self.window.title("Codex 메모 · 계정 백업")
        self.window.geometry("850x470")
        self.window.minsize(660, 360)
        self.window.protocol("WM_DELETE_WINDOW", self.close)
        ttk.Label(self.window, text="현재 ChatGPT 계정의 개인 페이지에 라벨·단어장·메모·공통 설정을 저장합니다.").pack(anchor="w", padx=14, pady=(14, 4))
        ttk.Label(self.window, text="복원하면 현재 데이터를 교체하고, 교체 전 데이터는 이 PC에 별도 보관합니다.").pack(anchor="w", padx=14)
        self.summary = tk.StringVar(value="최근 백업: 확인 중…")
        ttk.Label(self.window, textvariable=self.summary).pack(anchor="w", padx=14, pady=(8, 0))

        frame = ttk.Frame(self.window)
        frame.pack(fill="both", expand=True, padx=14, pady=(10, 4))
        self.table = ttk.Treeview(frame, columns=("time", "device", "counts"), show="headings", selectmode="browse")
        for name, text, width in (("time", "백업 시각 (이 PC 기준)", 175), ("device", "기기", 190), ("counts", "백업 내용", 390)):
            self.table.heading(name, text=text)
            self.table.column(name, width=width, minwidth=100, stretch=name != "time")
        scroll = ttk.Scrollbar(frame, orient="vertical", command=self.table.yview)
        self.table.configure(yscrollcommand=scroll.set)
        self.table.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self.table.bind("<<TreeviewSelect>>", lambda _event: self._selection_changed())
        self.table.bind("<Double-1>", self._open_row)
        self.details = tk.StringVar(value="백업을 선택하면 페이지를 열거나 복원할 수 있습니다.")
        ttk.Label(self.window, textvariable=self.details, wraplength=800).pack(anchor="w", padx=14, pady=(0, 6))

        bar = ttk.Frame(self.window)
        bar.pack(fill="x", padx=14)
        self.buttons = {}
        for action, text, command in (("create", "지금 백업", self.create), ("refresh", "목록 새로 고침", self.refresh),
                                      ("restore", "선택한 백업 복원", self.restore), ("open", "페이지 열기", self.open_page)):
            button = ttk.Button(bar, text=text, command=command)
            button.pack(side="left", padx=(0, 6))
            self.buttons[action] = button
        self.automatic = tk.BooleanVar(value=self._automatic)
        self.auto_button = ttk.Checkbutton(self.window, text="변경이 있을 때 5분 간격으로 자동 백업", variable=self.automatic, command=self.configure)
        self.auto_button.pack(anchor="w", padx=14, pady=8)
        self.progress = ttk.Progressbar(self.window, mode="indeterminate")
        self.progress.pack(fill="x", padx=14, pady=(0, 6))
        self.status = tk.StringVar(value="연결 중…")
        ttk.Label(self.window, textvariable=self.status, wraplength=800).pack(anchor="w", padx=14, pady=(0, 12))

    def close(self):
        # 백업은 계속 진행한다. 다시 열면 같은 요청의 진행 상태를 보여 준다.
        self._visible = False
        self._cancel_timer("_poll")
        self.progress.stop()
        self.window.withdraw()

    def shutdown(self):
        self._visible = False
        self._cancel_timer("_poll")
        self._cancel_timer("_timeout")
        pending, self._pending = self._pending, None
        if pending and pending.get("backend_id"):
            pending["backend"].cancel(pending["backend_id"])

    def _cancel_timer(self, name):
        timer = getattr(self, name)
        if timer is not None:
            self.app.root.after_cancel(timer)
            setattr(self, name, None)

    def _update_controls(self):
        if self.window is None:
            return
        working = bool(self._pending) or self._backend_busy
        selected = self.selected(notify=False)
        for action, button in self.buttons.items():
            enabled = not working
            if action == "refresh":
                enabled = not self._pending
            elif action == "restore":
                enabled = enabled and bool(selected)
            elif action == "open":
                enabled = bool(selected and selected.get("url"))
            button.configure(state="normal" if enabled else "disabled")
        self.auto_button.configure(state="disabled" if working else "normal")
        self.progress.stop()
        if working and self._visible:
            self.progress.start(15)

    def request(self, method, args, action):
        if self._pending:
            return
        self._cancel_timer("_poll")
        backend = self.app.bridge.labels
        if not backend:
            self.automatic.set(self._automatic)
            self.status.set("라벨 백엔드에 연결되지 않았습니다. 연결 후 목록을 새로 고침하세요.")
            self._backend_busy = False
            self._update_controls()
            return
        self._request_id += 1
        request_id = self._request_id
        self._pending = {"id": request_id, "action": action, "backend": backend}
        self.status.set((self._completion + " · " if action == "list" and self._completion else "") + ACTION_TEXT[action])
        self._update_controls()
        timeout = STATUS_TIMEOUT_MS if action in ("status", "configure") else REQUEST_TIMEOUT_MS
        self._timeout = self.app.root.after(timeout, lambda: self._request_timeout(request_id))
        try:
            self._pending["backend_id"] = backend.request(
                method, args,
                lambda ok, value: self.app.events.put(("backup_result", request_id, action, ok, value)))
        except Exception as error:
            self.app.events.put(("backup_result", request_id, action, False, str(error)))

    def _request_timeout(self, request_id):
        pending = self._pending
        if not pending or pending["id"] != request_id:
            return
        if pending.get("backend_id"):
            pending["backend"].cancel(pending["backend_id"])
        self.result(request_id, pending["action"], False,
                    "응답 대기 시간이 지났습니다. 작업이 계속 진행 중일 수 있으니 목록 새로 고침으로 결과를 확인하세요.")

    def result(self, request_id, action, ok, value):
        if not self._pending or self._pending["id"] != request_id:
            return  # 시간 초과 또는 종료한 요청의 늦은 응답
        self._cancel_timer("_timeout")
        self._pending = None
        self._backend_busy = False
        if not ok or not isinstance(value, dict):
            text = str(value) if not ok else "백업 응답을 읽지 못했습니다. 목록을 새로 고침하세요."
            self.automatic.set(self._automatic)
            self.status.set((self._completion + " · " if self._completion else "") + text)
            self._completion = ""
            self._update_controls()
            if self._visible:
                messagebox.showerror("계정 백업", text, parent=self.window)
            return

        if action in ("status", "configure"):
            self._automatic = bool(value.get("automatic"))
            self.automatic.set(self._automatic)
            self._last = value.get("last") or {}
            self._backend_busy = bool(value.get("busy"))
            self._update_summary()
            if self._backend_busy:
                self._refresh_after_status = True
                self.status.set("다른 계정 백업 작업이 진행 중입니다. 완료되면 목록을 갱신합니다.")
                self._schedule_status()
            elif action == "status" and self._refresh_after_status and self._visible:
                self._refresh_after_status = False
                self.request("backupList", [self._force_list], "list")
            else:
                self.status.set("자동 백업을 " + ("켰습니다." if self._automatic else "껐습니다.") if action == "configure" else "계정 백업 상태를 확인했습니다.")
            if value.get("error"):
                self.summary.set(self.summary.get() + " · " + str(value["error"]))
            if value.get("warning"):
                self.summary.set(self.summary.get() + " · " + str(value["warning"]))
        elif action == "list":
            self._show_items(value.get("items") or [])
            message = f"백업 {len(self.items)}건" if self.items else "저장된 계정 백업이 없습니다. 지금 백업으로 첫 백업을 만드세요."
            if value.get("partial"):
                message += " · 검색 결과가 일부만 표시될 수 있습니다."
            self.status.set((self._completion + " · " if self._completion else "") + message)
            self._completion = ""
        elif action == "create":
            self._last = value
            self._preferred_page = value.get("pageId")
            self._update_summary()
            self._completion = "백업 완료: " + display_time(value.get("createdAt"))
            if value.get("warning"):
                self._completion += " · " + str(value["warning"])
            self.status.set(self._completion)
            if self._visible:
                self.request("backupList", [True], "list")
        elif action == "restore":
            self.app.store.poll_external()
            self.app.refresh_classifier()
            local_backup = str(value.get("localBackup") or "")
            warning = "\n\n" + str(value["warning"]) if value.get("warning") else ""
            self._completion = "복원 완료 · 이전 데이터: " + local_backup + warning
            self.status.set(self._completion)
            if self._visible:
                messagebox.showinfo("계정 백업", "복원했습니다.\n\n이전 데이터 보관 위치:\n" + local_backup + warning, parent=self.window)
        self._update_controls()

    def _update_summary(self):
        text = "최근 백업: " + display_time(self._last.get("createdAt"))
        if self._last.get("deviceId"):
            text += " · " + str(self._last["deviceId"])
        self.summary.set(text)

    def _schedule_status(self):
        if self._visible:
            self._cancel_timer("_poll")
            self._poll = self.app.root.after(BUSY_POLL_MS, self._poll_status)

    def _poll_status(self):
        self._poll = None
        if self._visible:
            self.request("backupStatus", [], "status")

    def _show_items(self, items):
        selected = self.selected(notify=False)
        selected_id = self._preferred_page or (selected or {}).get("pageId")
        self._preferred_page = None
        scroll = self.table.yview()
        self.items = {str(item["pageId"]): item for item in items if isinstance(item, dict) and item.get("pageId")}
        rows = self.table.get_children()
        if rows:
            self.table.delete(*rows)
        for page_id, item in self.items.items():
            # v1 백업 제목도 기기와 생성 시각을 포함하므로 이전 목록 응답과 호환된다.
            title_parts = str(item.get("title") or "").split(" · ")
            device = item.get("deviceId") or (" · ".join(title_parts[1:-1]) if len(title_parts) > 2 else "알 수 없음")
            created = item.get("createdAt") or (title_parts[-1] if len(title_parts) > 2 else None)
            counts = item.get("counts") or {}
            summary = " · ".join(f"{label} {counts[key]}" for key, label in (("labels", "라벨"), ("vocabulary", "단어"), ("memos", "메모")) if key in counts)
            self.table.insert("", "end", iid=page_id, values=(display_time(created), device, summary or "페이지에서 내용 확인"))
        if selected_id and str(selected_id) in self.items:
            self.table.selection_set(str(selected_id))
            self.table.focus(str(selected_id))
            self.table.see(str(selected_id))
        elif scroll:
            self.table.yview_moveto(scroll[0])
        self._selection_changed()

    def _selection_changed(self):
        selected = self.selected(notify=False)
        self.details.set(str(selected.get("title") or selected["pageId"]) if selected else "백업을 선택하면 페이지를 열거나 복원할 수 있습니다.")
        self._update_controls()

    def refresh(self, force=True):
        if self._pending:
            return
        self._refresh_after_status = True
        self._force_list = force
        self.request("backupStatus", [], "status")

    def create(self):
        if self._pending or self._backend_busy:
            return
        if messagebox.askyesno("계정 백업", "라벨·대화별 지정·단어장·메모·공통 설정을 현재 ChatGPT 계정의 개인 페이지에 저장할까요?", parent=self.window):
            self._completion = ""
            self.request("backupCreate", [], "create")

    def selected(self, notify=True):
        selected = self.table.selection()
        item = self.items.get(selected[0]) if selected else None
        if item is None and notify:
            self.status.set("목록에서 백업을 선택하세요.")
        return item

    def restore(self):
        if self._pending or self._backend_busy:
            return
        item = self.selected()
        if item and messagebox.askyesno("계정 백업 복원", str(item.get("title") or item["pageId"]) + "\n\n현재 라벨·단어장·메모·공통 설정을 이 백업으로 교체할까요?\n이전 데이터는 로컬에 보관합니다. 작성 중인 메모는 먼저 저장해 주세요.", parent=self.window):
            self._completion = ""
            self.request("backupRestore", [item["pageId"]], "restore")

    def open_page(self):
        item = self.selected()
        if item and item.get("url"):
            webbrowser.open(item["url"])

    def _open_row(self, event):
        row = self.table.identify_row(event.y)
        if row:
            self.table.selection_set(row)
            self.open_page()

    def configure(self):
        enabled = self.automatic.get()
        if self._pending or self._backend_busy:
            self.automatic.set(self._automatic)
            return
        if enabled and not messagebox.askyesno("자동 계정 백업", "변경된 라벨·단어장·메모·공통 설정을 5분 간격으로 현재 계정의 개인 페이지에 자동 저장할까요?\n백업은 기기별로 누적되며 자동 복원하지 않습니다.", parent=self.window):
            self.automatic.set(self._automatic)
            return
        self._completion = ""
        self.request("backupConfigure", [enabled], "configure")
