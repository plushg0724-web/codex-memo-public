"""macOS app discovery and graceful lifecycle; never edits the host bundle."""
import os
import plistlib
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

DEBUG_PORT = int(os.environ.get("CODEX_MEMO_DEBUG_PORT", "9233"))
if not 1 <= DEBUG_PORT <= 65535:
    raise ValueError("CODEX_MEMO_DEBUG_PORT는 1~65535 범위여야 합니다.")
NO_WINDOW = 0
CLI_LOCATIONS = ("Contents/Resources/codex", "Contents/Resources/codex-cli/bin/codex",
                 "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")


def app_info(bundle):
    try:
        root = Path(bundle)
        info = plistlib.loads((root / "Contents/Info.plist").read_bytes())
        exe = root / "Contents/MacOS" / info["CFBundleExecutable"]
        if exe.is_file() and any((root / p).is_file() for p in CLI_LOCATIONS):
            return {"bundle": str(root), "id": info["CFBundleIdentifier"], "exe": str(exe)}
    except (OSError, ValueError, KeyError, plistlib.InvalidFileException):
        pass
    return None


def find_app():
    override = os.environ.get("CODEX_MEMO_APP")
    if override:
        info = app_info(override)
        if not info:
            raise FileNotFoundError("CODEX_MEMO_APP에 Codex CLI가 포함된 .app 경로를 지정하세요.")
        return info
    for directory in (Path("/Applications"), Path.home() / "Applications"):
        for name in ("Codex.app", "ChatGPT.app"):
            info = app_info(directory / name)
            if info:
                return info
    raise FileNotFoundError("Codex 앱을 찾지 못했습니다. /Applications에 설치하거나 CODEX_MEMO_APP을 지정하세요.")


def codex_processes():
    try:
        exe = find_app()["exe"]
        output = subprocess.run(["/bin/ps", "-axo", "pid=,comm="], capture_output=True,
                                text=True, check=True, timeout=3).stdout
        found = {}
        for line in output.splitlines():
            parts = line.strip().split(None, 1)
            if len(parts) == 2 and parts[0].isdigit() and parts[1] == exe:
                found[int(parts[0])] = exe
        return found
    except (FileNotFoundError, subprocess.SubprocessError):
        return {}


def codex_pids():
    return list(codex_processes())


def debug_port_alive():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/version", timeout=1):
            return True
    except OSError:
        return False


def focus_codex():
    info = find_app()
    subprocess.run(["/usr/bin/open", "-a", info["bundle"]], check=True, timeout=5)
    return True


def close_codex():
    info = find_app()
    # argv keeps bundle identifiers out of AppleScript source interpolation.
    subprocess.run(["/usr/bin/osascript", "-e", "on run argv", "-e",
                    "tell application id (item 1 of argv) to quit", "-e", "end run", info["id"]],
                   capture_output=True, text=True, check=True, timeout=10)
    deadline = time.monotonic() + 8
    while codex_pids() and time.monotonic() < deadline:
        time.sleep(0.2)
    if codex_pids():
        raise RuntimeError("앱이 종료되지 않았습니다. 진행 중인 작업을 확인하고 직접 종료한 뒤 다시 실행하세요.")


def launch_codex():
    if codex_pids() and not debug_port_alive():
        raise RuntimeError("Codex가 일반 모드로 실행 중입니다. 메뉴에서 메모 모드로 다시 시작하세요.")
    info = find_app()
    subprocess.run(["/usr/bin/open", "-a", info["bundle"], "--args",
                    f"--remote-debugging-port={DEBUG_PORT}", "--remote-debugging-address=127.0.0.1"],
                   check=True, timeout=5)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if debug_port_alive():
            return
        time.sleep(0.5)
    raise RuntimeError("앱은 실행됐지만 메모 연결 포트가 열리지 않았습니다. 이 앱 버전의 디버그 연결 지원을 확인하세요.")


def codex_cli_path():
    explicit = os.environ.get("CODEX_EXE")
    if explicit and os.path.isfile(explicit) and os.access(explicit, os.X_OK):
        return explicit
    try:
        root = Path(find_app()["bundle"])
        for relative in CLI_LOCATIONS:
            exe = root / relative
            if exe.is_file() and os.access(exe, os.X_OK):
                return str(exe)
    except FileNotFoundError:
        pass
    return shutil.which("codex")
