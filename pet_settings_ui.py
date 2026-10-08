"""트레이에서 여는 펫 설정. Tk 메인 스레드에서만 위젯을 수정한다."""
import tkinter as tk
from tkinter import ttk, messagebox


class PetSettingsWindow:
    def __init__(self, app):
        self.app = app
        self.window = None
        self.pending = None
        self.sequence = 0
        self.models = []
        self.loaded = False

    def open(self):
        if self.window is not None and self.window.winfo_exists() and self.window.state() != 'withdrawn':
            self.window.lift()
            self.window.focus_force()
            return
        if self.window is None or not self.window.winfo_exists():
            self._build()
        self.window.deiconify()
        self.window.lift()
        self.window.focus_force()
        if not self.pending:
            self.loaded = False
            self._request('load', 'taskPetSettings', [])

    def _build(self):
        self.window = tk.Toplevel(self.app.root)
        self.window.title('Codex 메모 · 펫 설정')
        self.window.geometry('610x640')
        self.window.minsize(480, 580)
        self.window.protocol('WM_DELETE_WINDOW', self.close)
        frame = ttk.Frame(self.window, padding=18)
        frame.pack(fill='both', expand=True)
        ttk.Label(frame, text='다음 할 일 추천 펫', font=('', 15, 'bold')).pack(anchor='w')
        ttk.Label(frame, text='현재 Codex 로그인으로 설명을 생성합니다. 추천할 때 구독 사용량을 사용합니다.', wraplength=550).pack(anchor='w', pady=(6, 14))
        self.enabled = tk.BooleanVar()
        self.enabled_box = ttk.Checkbutton(frame, text='모델로 다음 행동 설명하기', variable=self.enabled)
        self.enabled_box.pack(anchor='w')
        self.model = tk.StringVar()
        self.effort = tk.StringVar()
        self.threshold = tk.StringVar()
        self.count = tk.StringVar()
        for label, variable, name in [('모델', self.model, 'model_box'), ('추론 강도', self.effort, 'effort_box')]:
            ttk.Label(frame, text=label).pack(anchor='w', pady=(12, 4))
            widget = ttk.Combobox(frame, textvariable=variable, state='readonly')
            widget.pack(fill='x')
            setattr(self, name, widget)
        self.model_box.bind('<<ComboboxSelected>>', self._model_changed)
        row = ttk.Frame(frame)
        row.pack(fill='x', pady=12)
        ttk.Label(row, text='분류 확신도 (%)').grid(row=0, column=0, sticky='w')
        self.threshold_box = ttk.Spinbox(row, from_=30, to=99, textvariable=self.threshold, width=7)
        self.threshold_box.grid(row=0, column=1, padx=(10, 25))
        ttk.Label(row, text='추천 개수').grid(row=0, column=2)
        self.count_box = ttk.Spinbox(row, from_=1, to=6, textvariable=self.count, width=5)
        self.count_box.grid(row=0, column=3, padx=10)
        ttk.Label(frame, text='확신도는 Mica 상태 분류의 기준이며 모델 설명의 정확도 보증은 아닙니다.', wraplength=550).pack(anchor='w')
        ttk.Label(frame, text='추천 설명 작성 지침 (최대 4,000자)').pack(anchor='w', pady=(14, 5))
        self.guide = tk.Text(frame, height=8, wrap='word', undo=True)
        self.guide.pack(fill='both', expand=True)
        self.status = tk.StringVar(value='불러오는 중…')
        ttk.Label(frame, textvariable=self.status, wraplength=550).pack(anchor='w', pady=10)
        buttons = ttk.Frame(frame)
        buttons.pack(fill='x')
        self.save_button = ttk.Button(buttons, text='저장', command=self.save, state='disabled')
        self.save_button.pack(side='right')
        ttk.Button(buttons, text='닫기', command=self.close).pack(side='right', padx=8)
        self.refresh_button = ttk.Button(buttons, text='모델 목록 다시 확인', command=self.refresh_models)
        self.refresh_button.pack(side='left')

    def close(self):
        if self.pending:
            self.window.withdraw()
            return
        if self.loaded and self._values() != self.baseline and not messagebox.askyesno('펫 설정', '저장하지 않은 변경을 버리고 닫을까요?', parent=self.window):
            return
        if self.window:
            self.window.withdraw()

    def _values(self):
        return (self.enabled.get(), self.model.get(), self.effort.get(), self.threshold.get(), self.count.get(), self.guide.get('1.0', 'end-1c'))

    def _lock(self, busy):
        self.guide.configure(state='disabled' if busy else 'normal')
        for widget in (self.enabled_box, self.threshold_box, self.count_box):
            widget.configure(state='disabled' if busy else 'normal')
        for widget in (self.model_box, self.effort_box):
            widget.configure(state='disabled' if busy else 'readonly')

    def _request(self, action, method, args):
        if self.pending:
            return
        backend = self.app.bridge.labels
        if not backend:
            self.status.set('Codex 메모 백엔드에 연결되지 않았습니다.')
            return
        self.sequence += 1
        request_id = self.sequence
        self.pending = request_id
        self._lock(True)
        self.save_button.configure(state='disabled')
        self.refresh_button.configure(state='disabled')
        self.status.set('저장 중…' if action == 'save' else '설정을 확인하는 중…')
        self.timer = self.app.root.after(35000, lambda: self.result(request_id, action, False, '응답이 늦습니다. 다시 확인해 주세요.'))
        try:
            backend.request(method, args, lambda ok, value: self.app.events.put(('pet_settings_result', request_id, action, ok, value)))
        except Exception as error:
            self.result(request_id, action, False, str(error))

    def result(self, request_id, action, ok, value):
        if request_id != self.pending:
            return
        self.app.root.after_cancel(self.timer)
        self.pending = None
        self._lock(False)
        self.refresh_button.configure(state='normal')
        self.save_button.configure(state='normal' if self.loaded else 'disabled')
        if not ok:
            self.status.set(str(value))
            return
        if action in ('load', 'save'):
            self.enabled.set(value['enabled'])
            self.model.set(value['model'])
            self.effort.set(value['effort'])
            self.threshold.set(str(round(value['threshold'] * 100)))
            self.count.set(str(value['count']))
            self.guide.delete('1.0', 'end')
            self.guide.insert('1.0', value['guide'])
            self.loaded = True
            self.baseline = self._values()
            self.save_button.configure(state='normal')
            self.status.set('저장했습니다. 다음 추천부터 적용됩니다.' if action == 'save' else '설정을 불러왔습니다.')
            if action == 'load':
                self.refresh_models()
        elif action == 'models':
            self.models = value
            ids = [m['id'] for m in value]
            self.model_box.configure(values=ids if self.model.get() in ids else [self.model.get(), *ids])
            self._model_changed()
            self.status.set('모델 목록을 확인했습니다. 실제 사용 가능 여부는 추천 요청에서 확인됩니다.' if self.model.get() in ids
                            else f'{self.model.get()}은 현재 모델 목록에 없습니다. 다른 모델을 선택하거나 모델 설명을 끌 수 있습니다.')

    def refresh_models(self):
        self._request('models', 'vocabularyModels', [])

    def _model_changed(self, _event=None):
        model = next((m for m in self.models if m['id'] == self.model.get()), None)
        efforts = model['efforts'] if model else [self.effort.get()]
        self.effort_box.configure(values=efforts)
        if efforts and self.effort.get() not in efforts:
            self.effort.set('high' if 'high' in efforts else efforts[0])

    def save(self):
        if not self.loaded or self.pending:
            return
        try:
            threshold = int(self.threshold.get())
            count = int(self.count.get())
            guide = self.guide.get('1.0', 'end-1c').strip()
            if not 30 <= threshold <= 99 or not 1 <= count <= 6 or not 1 <= len(guide) <= 4000:
                raise ValueError()
        except ValueError:
            messagebox.showerror('펫 설정', '확신도 30~99%, 추천 개수 1~6, 지침 1~4000자를 입력하세요.', parent=self.window)
            return
        self._request('save', 'taskPetSettingsSet', [{'enabled': self.enabled.get(), 'model': self.model.get(), 'effort': self.effort.get(),
                                                   'threshold': threshold / 100, 'count': count, 'guide': guide}])
