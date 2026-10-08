"""공식 Codex 앱(Microsoft Store) 실행·종료·앞으로 가져오기와 위치 찾기.

프로세스·창은 Windows API 로 직접 찾는다 (PowerShell 을 띄우면 한 번에 0.3~1초 걸림).
"""

import ctypes
import os
import subprocess
import time
import urllib.request
from ctypes import wintypes

DEBUG_PORT = 9233
CODEX_AUMID = "OpenAI.Codex_2p2nqsd0c76g0!App"
CODEX_FAMILY = CODEX_AUMID.split("!", 1)[0]  # Store 패키지 패밀리 이름
CODEX_PATH_PATTERN = "openai.codex"          # 실행 파일 경로에 들어 있는 패키지 이름 (소문자 비교)
CODEX_EXE_NAME = "chatgpt.exe"
POWERSHELL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                          "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
NO_WINDOW = subprocess.CREATE_NO_WINDOW

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel32.OpenProcess.restype = wintypes.HANDLE
WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TH32CS_SNAPPROCESS = 0x2
ERROR_INSUFFICIENT_BUFFER = 122
WM_CLOSE = 0x0010
SW_RESTORE = 9
VK_MENU = 0x12
KEYEVENTF_KEYUP = 0x2


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260)]


class WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [("length", wintypes.UINT), ("flags", wintypes.UINT), ("showCmd", wintypes.UINT),
                ("ptMinPosition", wintypes.POINT), ("ptMaxPosition", wintypes.POINT),
                ("rcNormalPosition", wintypes.RECT)]


# ---------------------------------------------------------------- 프로세스
def _process_path(pid):
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        buf, size = ctypes.create_unicode_buffer(1024), wintypes.DWORD(1024)
        return buf.value if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)) else ""
    finally:
        kernel32.CloseHandle(handle)


def codex_processes():
    """실행 중인 Codex 프로세스 {pid: 실행 파일 경로}."""
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == wintypes.HANDLE(-1).value:
        return {}
    found = {}
    try:
        entry = PROCESSENTRY32W(dwSize=ctypes.sizeof(PROCESSENTRY32W))
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            if entry.szExeFile.lower() == CODEX_EXE_NAME:
                path = _process_path(entry.th32ProcessID)
                if CODEX_PATH_PATTERN in path.lower():
                    found[entry.th32ProcessID] = path
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return found


def codex_pids():
    return list(codex_processes())


# ---------------------------------------------------------------- 창
def _codex_windows():
    """보이는 Codex 창 [(원래 크기 넓이, hwnd)]. 최소화된 창도 '보통 상태' 크기로 잰다."""
    pids = set(codex_pids())
    windows = []

    def on_window(hwnd, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids and user32.IsWindowVisible(hwnd) and user32.GetWindowTextLengthW(hwnd):
            wp = WINDOWPLACEMENT(length=ctypes.sizeof(WINDOWPLACEMENT))
            user32.GetWindowPlacement(hwnd, ctypes.byref(wp))
            r = wp.rcNormalPosition
            windows.append(((r.right - r.left) * (r.bottom - r.top), hwnd))
        return True

    if pids:
        user32.EnumWindows(WNDENUMPROC(on_window), 0)
    return windows


def focus_codex():
    """Codex 메인 창을 앞으로 가져온다 (최소화돼 있으면 복원). 창을 찾았으면 True."""
    windows = _codex_windows()
    if not windows:
        return False
    hwnd = max(windows)[1]                   # 가장 큰 창 = 메인 창 (작은 플로팅 창 제외)
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    # 다른 프로그램이 앞에 있을 때 Windows 가 창 전환을 막지 않도록 Alt 키를 한 번 눌렀다 뗀다
    user32.keybd_event(VK_MENU, 0, 0, 0)
    user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
    user32.SetForegroundWindow(hwnd)
    return True


# ---------------------------------------------------------------- 실행·종료
def debug_port_alive():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/version", timeout=1):
            return True
    except Exception:
        return False


def close_codex():
    """창을 정상적으로 닫고(최대 8초 대기), 남은 프로세스는 강제로 끝낸다."""
    for _, hwnd in _codex_windows():
        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
    for _ in range(40):
        if not codex_pids():
            return
        time.sleep(0.2)
    for pid in codex_pids():
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, creationflags=NO_WINDOW)
    time.sleep(1)


def launch_codex():
    """Store 앱을 패키지 그대로(로그인·작업 유지) 디버그 포트 인자와 함께 실행한다."""
    import comtypes
    import comtypes.client
    from comtypes import COMMETHOD, GUID, HRESULT
    from ctypes import POINTER

    class IApplicationActivationManager(comtypes.IUnknown):
        _iid_ = GUID("{2e941141-7f97-4756-ba1d-9decde894a3d}")
        _methods_ = [COMMETHOD([], HRESULT, "ActivateApplication",
                               (["in"], wintypes.LPCWSTR, "appUserModelId"),
                               (["in"], wintypes.LPCWSTR, "arguments"),
                               (["in"], ctypes.c_int, "options"),
                               (["out"], POINTER(wintypes.DWORD), "processId"))]

    comtypes.CoInitialize()
    mgr = comtypes.client.CreateObject(GUID("{45BA127D-10A8-46EA-8AB7-56EA9078943C}"),
                                       interface=IApplicationActivationManager)
    mgr.ActivateApplication(CODEX_AUMID, f"--remote-debugging-port={DEBUG_PORT}", 0)


def _package_paths(family=CODEX_FAMILY):
    """이 사용자에게 설치된 Store 패키지 폴더들 (Windows API, 수 ms). API 를 쓸 수 없으면 None."""
    try:
        count, length = wintypes.UINT(0), wintypes.UINT(0)
        rc = kernel32.GetPackagesByPackageFamily(family, ctypes.byref(count), None, ctypes.byref(length), None)
        if rc != ERROR_INSUFFICIENT_BUFFER or not count.value:
            return []                                 # 설치되지 않음
        names = (wintypes.LPWSTR * count.value)()
        buffer = ctypes.create_unicode_buffer(length.value)
        if kernel32.GetPackagesByPackageFamily(family, ctypes.byref(count), names, ctypes.byref(length), buffer):
            return []
        paths = []
        for name in names[:count.value]:
            size = wintypes.UINT(0)
            if kernel32.GetPackagePathByFullName(name, ctypes.byref(size), None) != ERROR_INSUFFICIENT_BUFFER:
                continue
            path = ctypes.create_unicode_buffer(size.value)
            if not kernel32.GetPackagePathByFullName(name, ctypes.byref(size), path):
                paths.append(path.value)
        return paths
    except (AttributeError, OSError, ValueError):    # 패키지 API 가 없는 Windows
        return None


def codex_cli_path():
    """단어장 요약·시트 동기화에 쓸 codex.exe: 설치된 Codex 앱에 들어 있는 것(앱과 버전이 맞음)을 쓴다.
    LOCALAPPDATA 아래 OpenAI/Codex/bin 의 것은 오래된 버전일 수 있어 서버 모델 목록을 못 읽는다.
    Codex 가 실행 중이면 그 위치에서 바로 찾고, 아니면 패키지 설치 위치를 묻는다
    (Windows API, 안 되면 PowerShell — PowerShell 은 한 번에 0.5초 이상 걸림)."""
    for path in codex_processes().values():          # ...\app\ChatGPT.exe → ...\app\resources\codex.exe
        exe = os.path.join(os.path.dirname(path), "resources", "codex.exe")
        if os.path.exists(exe):
            return exe
    roots = _package_paths()
    if roots is None:
        out = subprocess.run([POWERSHELL, "-NoProfile", "-Command",
                              "(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation"],
                             capture_output=True, text=True, creationflags=NO_WINDOW).stdout.strip()
        roots = [out] if out else []
    for root in roots:
        exe = os.path.join(root, "app", "resources", "codex.exe")
        if os.path.exists(exe):
            return exe
    return None
