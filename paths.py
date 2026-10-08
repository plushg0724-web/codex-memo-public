"""프로그램 폴더와 개인 데이터 폴더.

프로그램 폴더(이 파일이 있는 곳)는 업데이트할 때 통째로 바뀐다.
메모·설정·라벨·단어장 같은 개인 데이터는 %LOCALAPPDATA%\\CodexMemo 에 따로 둔다.
"""

import json
import os
import shutil
import sys

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("CODEX_MEMO_DATA") or os.path.join(
    os.path.expanduser("~/Library/Application Support") if sys.platform == "darwin"
    else os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "CodexMemo")
MEMO_DIR = os.path.join(DATA_DIR, "memos")

# 예전에 Codex Labels 를 쓰던 PC 는 그 라벨·단어장 데이터를 그대로 쓴다
CODEX_LABELS_DIR = os.path.join(os.path.expanduser("~"), "Documents", "ChatGPT", "codexlabels", "app")
DEFAULT_LABELS = os.path.join(APP_DIR, "labels", "default-labels.json")


def write_atomic(path, text):
    """같은 폴더의 임시 파일에 다 쓴 뒤 바꿔 끼운다(쓰다 끊겨도 원래 파일은 온전하다)."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def version():
    try:
        with open(os.path.join(APP_DIR, "VERSION"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return "0.0.0"


def labels_data_dir():
    """라벨·단어장 데이터 폴더. Codex Labels 데이터가 있으면 그것을, 없으면 기본 라벨로 새로 만든다."""
    if os.path.exists(os.path.join(CODEX_LABELS_DIR, "labels.json")):
        return CODEX_LABELS_DIR
    own = os.path.join(DATA_DIR, "labels")
    if not os.path.exists(os.path.join(own, "labels.json")):
        os.makedirs(own, exist_ok=True)
        shutil.copyfile(DEFAULT_LABELS, os.path.join(own, "labels.json"))
        with open(os.path.join(own, "assignments.json"), "w", encoding="utf-8") as f:
            json.dump({"schemaVersion": 1, "assignments": {}}, f)
    return own


def migrate_legacy():
    """예전 버전이 프로그램 폴더 안에 두던 개인 데이터를 데이터 폴더로 옮긴다 (한 번만)."""
    os.makedirs(DATA_DIR, exist_ok=True)
    moves = [
        (os.path.join(APP_DIR, "memos"), MEMO_DIR),
        (os.path.join(APP_DIR, "labels", "settings.json"), os.path.join(DATA_DIR, "settings.json")),
        (os.path.join(APP_DIR, "labels", "sheets-pending.json"), os.path.join(DATA_DIR, "sheets-pending.json")),
    ]
    for old, new in moves:
        if os.path.exists(old) and not os.path.exists(new):
            shutil.move(old, new)
