"""Real Tk settings window with isolated asynchronous backend results."""
import queue
import sys
import tkinter as tk
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pet_settings_ui import PetSettingsWindow

root = tk.Tk()
root.withdraw()
calls = []
class Backend:
    def request(self, method, args, callback):
        calls.append((method, args, callback))

app = SimpleNamespace(root=root, bridge=SimpleNamespace(labels=Backend()), events=queue.Queue())
window = PetSettingsWindow(app)
settings = dict(enabled=True, model='gpt-6-luna', effort='high', threshold=.8, count=3, guide='실제 근거만 사용하세요.')
def finish(value, ok=True):
    calls[-1][2](ok, value)
    event = app.events.get_nowait()
    window.result(*event[1:])
    root.update()

try:
    window.open()
    assert calls[-1][0] == 'taskPetSettings'
    finish(settings)
    assert calls[-1][0] == 'vocabularyModels'
    finish([dict(id='gpt-6-luna', efforts=['low', 'high'])])
    assert window.model.get() == 'gpt-6-luna' and window.effort.get() == 'high'
    window.count.set('5')
    window.threshold.set('90')
    window.save()
    assert calls[-1][0] == 'taskPetSettingsSet'
    assert calls[-1][1][0]['count'] == 5 and calls[-1][1][0]['threshold'] == .9
    assert str(window.guide['state']) == 'disabled'
    finish('disk write failed', False)
    assert window.count.get() == '5' and window.status.get() == 'disk write failed'
    window.save()
    finish({**settings, 'count': 5, 'threshold': .9})
    assert '저장했습니다' in window.status.get()
    window.guide.insert('end', '\n추가 지침')
    with patch('pet_settings_ui.messagebox.askyesno', return_value=False):
        window.close()
    assert window.window.state() != 'withdrawn'
    with patch('pet_settings_ui.messagebox.askyesno', return_value=True):
        window.close()
    assert window.window.state() == 'withdrawn'
    window.open()
    finish(settings)
    finish([dict(id='gpt-6-luna', efforts=['low', 'high'])])
    window.enabled.set(False)
    window.save()
    assert calls[-1][1][0]['enabled'] is False
    finish({**settings, 'enabled': False})
    print('PASS: native settings load/save, validation payload, pending lock, failed-save input preservation, unsaved close and reopen')
finally:
    root.destroy()
