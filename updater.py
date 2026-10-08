"""GitHub 릴리스로 업데이트: 새 버전 확인 → 받아서 프로그램 폴더를 바꿈 → 다시 시작.

개인 데이터는 프로그램 폴더 밖(paths.DATA_DIR)에 있어 업데이트해도 그대로다.
git 으로 받은 개발용 폴더는 덮어쓰지 않는다 (git pull 로 업데이트).
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile

from paths import APP_DIR, version

REPO = "plushg0724-web/codex-memo-public"
API = f"https://api.github.com/repos/{REPO}/releases/latest"
NO_WINDOW = subprocess.CREATE_NO_WINDOW
MANIFEST = "runtime-manifest.json"     # 배포 압축에 든 실행 필수 파일 목록(requiredFiles)
# 매니페스트가 없는 예전 배포에서 확인하는 빌드된 Node 모듈
NODE_MODULES = ("backend", "appserver", "backup", "backup-files", "backup-format", "backup-space",
                "settings-store", "protocol", "backup-types", "vocabulary-analysis", "vocabulary-service")
SOURCE_ARCHIVE_ERROR = "빌드된 Node 프로그램이 없는 소스 압축입니다. CodexMemo-Windows.zip 배포 파일을 사용하세요."


def _parse(v):
    return tuple(int(x) for x in v.lstrip("v").split(".") if x.isdigit())


def is_dev_checkout():
    # Linked worktrees use a .git file instead of a directory.
    return os.path.exists(os.path.join(APP_DIR, ".git"))


def check():
    """최신 릴리스 정보. 새 버전이 있으면 {"version", "zip", "notes"}, 없으면 None."""
    req = urllib.request.Request(API, headers={"Accept": "application/vnd.github+json", "User-Agent": "codex-memo"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            rel = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise RuntimeError("공개된 릴리스를 찾지 못했습니다. 배포 파일이 등록되어 있는지 확인하고 필요하면 직접 설치하세요.") from e
        raise
    latest = rel.get("tag_name", "").lstrip("v")
    if not latest or _parse(latest) <= _parse(version()):
        return None
    asset = next((item for item in rel.get("assets", []) if item.get("name") == "CodexMemo-Windows.zip"), None)
    download = asset["browser_download_url"] if asset else rel["zipball_url"]
    return {"version": latest, "zip": download, "notes": (rel.get("body") or "").strip()}


def install(release):
    """새 버전을 받아 프로그램 폴더에 덮어쓴다. 패키지 목록이 바뀌었으면 pip 로 설치한다."""
    if is_dev_checkout():
        raise RuntimeError("개발용 폴더(git)입니다. git pull 로 업데이트하세요.")
    req = urllib.request.Request(release["zip"], headers={"User-Agent": "codex-memo"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    with tempfile.TemporaryDirectory() as tmp:
        root = _stage_release(data, tmp)
        requirements = os.path.join(root, "requirements.txt")
        if _read(requirements) != _read(os.path.join(APP_DIR, "requirements.txt")):
            python = sys.executable.replace("pythonw.exe", "python.exe")
            # Resolve dependencies before replacing app files. A failed pip run
            # must reach the caller as an error instead of triggering restart.
            subprocess.run([python, "-m", "pip", "install", "--user", "-q", "--disable-pip-version-check",
                            "-r", requirements], creationflags=NO_WINDOW, check=True)
        for base, dirs, files in os.walk(root):
            rel = os.path.relpath(base, root)
            os.makedirs(os.path.join(APP_DIR, rel), exist_ok=True)
            for name in files:
                shutil.copy2(os.path.join(base, name), os.path.join(APP_DIR, rel, name))


def _stage_release(data, directory):
    """Prepare a compiled runtime archive (or compatible older release)."""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for member in archive.infolist():
            parts = member.filename.replace("\\", "/").split("/")
            if not parts[0] or any(part in (".", "..") or ":" in part for part in parts):
                raise RuntimeError("업데이트 압축의 경로가 올바르지 않습니다.")
        archive.extractall(directory)
    roots = os.listdir(directory)
    if len(roots) != 1:
        raise RuntimeError("업데이트 압축의 최상위 폴더를 확인하세요.")
    root = os.path.join(directory, roots[0])
    if not all(os.path.isfile(os.path.join(root, name)) for name in ("codex_memo.py", "VERSION", "requirements.txt")):
        raise RuntimeError("업데이트 압축에 필수 프로그램 파일이 없습니다.")
    missing = [name for name in _required_files(root) if not _file_inside(root, name)]
    if missing:
        if any(name.replace("\\", "/").startswith("dist/node/") for name in missing):
            raise RuntimeError(SOURCE_ARCHIVE_ERROR)
        raise RuntimeError("업데이트 압축에 실행 파일이 빠져 있습니다: " + ", ".join(missing[:5]))
    return root


def _required_files(root):
    """압축 안에서 꼭 있어야 하는 실행 파일. runtime-manifest.json 을 따르고, 없으면(예전 배포)
    호환 래퍼가 빌드된 Node 모듈을 부를 때만 그 모듈들을 확인한다."""
    text = _read(os.path.join(root, MANIFEST))
    if text:
        try:
            files = json.loads(text).get("requiredFiles")
        except (ValueError, AttributeError):
            files = None
        if not isinstance(files, list) or not all(isinstance(name, str) and name for name in files):
            raise RuntimeError("업데이트 압축의 실행 파일 목록(runtime-manifest.json)을 읽을 수 없습니다.")
        return files
    if "dist/node/backend" in _read(os.path.join(root, "labels", "backend.cjs")):
        return [f"dist/node/{name}.cjs" for name in NODE_MODULES]
    return []


def _file_inside(root, name):
    """root 안의 파일이면 True (목록의 '..'·절대 경로는 밖을 가리키므로 없는 것으로 본다)."""
    base = os.path.normcase(os.path.abspath(root))
    path = os.path.abspath(os.path.join(root, name))
    return os.path.normcase(path).startswith(base + os.sep) and os.path.isfile(path)


def restart():
    """2초 뒤 새로 시작한다 (지금 프로세스가 끝나 중복 실행 방지 잠금이 풀린 다음)."""
    script = os.path.join(APP_DIR, "codex_memo.py")
    subprocess.Popen(["cmd", "/c", f'timeout /t 2 /nobreak >nul & start "" "{sys.executable}" "{script}"'],
                     cwd=APP_DIR, creationflags=NO_WINDOW)


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""
