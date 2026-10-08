"""메모 저장소: memos/memos.json (+ 읽기용 memos.md).

추가·수정·삭제는 모두 여기를 거치고, 바뀌면 구독자(화면 전송, 목록 창)에게 한 번만 알린다.
다른 프로그램이 파일을 직접 고친 경우는 poll_external() 로 따로 감지한다.
"""

import json
import os
import threading
import uuid
from copy import deepcopy
from datetime import datetime

# 화면(inject.js)이 보내는 새 메모 항목 중 저장할 것
MEMO_FIELDS = ("title", "conv", "quote", "note", "exact", "prefix", "suffix", "category")
MEMO_CATEGORIES = ("todo", "idea", "question", "reference", "")   # "" 은 미분류
AUTO_CATEGORIES = MEMO_CATEGORIES[:-1]                            # 자동 분류가 고를 수 있는 값
_UNCHECKED_STAMP = object()


def memo_title(m):
    return m.get("title") or m.get("window") or ""   # window: 예전 형식


def render_markdown(memos):
    """읽기용 memos.md: 최근 메모부터 날짜·대화 제목, 인용(> ), 메모. 밖에서 고친 항목에 빠진 칸이 있어도 쓴다."""
    lines = ["# Codex 메모\n"]
    for m in reversed(memos):
        lines.append(f"## {m.get('created', '')}  ·  {memo_title(m)}\n")
        quote = str(m.get("quote") or "")
        if quote:
            lines.extend("> " + q for q in quote.splitlines())
            lines.append("")
        lines.append(str(m.get("note") or "") + "\n")
        lines.append("---\n")
    return "\n".join(lines)


class MemoStore:
    def __init__(self, directory):
        self.directory = directory
        self.path = os.path.join(directory, "memos.json")
        self.md_path = os.path.join(directory, "memos.md")
        self.lock = threading.RLock()
        self._listeners = []
        self._revisions = {}  # 자동 분류 대기 중 수동 변경(미분류 선택 포함)을 구분한다
        self._cached_memos = None
        self._flat_cache = False
        self._cache_renderable = False
        self._cache_stamp = None
        self._seen_stamp = self._stamp()
        if self._seen_stamp is not None:
            md_stamp = self._stamp(self.md_path)
            if md_stamp is None or md_stamp[0] < self._seen_stamp[0]:
                with self.lock:
                    self._sync_markdown(self._seen_stamp)

    # ---------- 읽기·쓰기
    def _stamp(self, path=None):
        try:
            stat = os.stat(path or self.path)
            return (stat.st_mtime_ns, stat.st_size, stat.st_ino)
        except OSError:
            return None

    def load(self):
        """파일이 바뀌었을 때만 읽는다. 호출자는 캐시와 독립된 목록을 받는다."""
        with self.lock:
            return self._copy(self._load_cached())

    def _load_cached(self, stamp=_UNCHECKED_STAMP):
        """lock 안에서만 사용한다. 변경 작업도 원본 전체를 두 번 복사하지 않는다."""
        if stamp is _UNCHECKED_STAMP:
            stamp = self._stamp()
        if self._cached_memos is None or stamp != self._cache_stamp:
            try:
                with open(self.path, encoding="utf-8") as f:
                    self._cached_memos = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError):
                self._cached_memos = []
                self._cache_renderable = False
            else:
                self._cache_renderable = isinstance(self._cached_memos, list) and all(
                    isinstance(m, dict) for m in self._cached_memos)
            self._flat_cache = self._is_flat(self._cached_memos)
            self._cache_stamp = stamp
        return self._cached_memos

    def _sync_markdown(self, stamp):
        """lock 안에서 외부 JSON을 읽고 파생 파일을 맞춘다. 불완전한 JSON은 기존 md를 보존한다."""
        try:
            memos = self._load_cached(stamp)
        except (OSError, UnicodeError):
            # 외부 프로그램이 JSON을 잠근 동안에도 변경 알림은 계속 보낸다.
            return
        if self._cache_renderable:
            self._write_markdown(memos)

    def get(self, memo_id):
        """메모 하나를 읽을 때는 전체 목록을 복사하지 않는다."""
        with self.lock:
            memo = next((m for m in self._load_cached() if m["id"] == memo_id), None)
            if memo is None:
                return None
            return memo.copy() if self._flat_cache else deepcopy(memo)

    @staticmethod
    def _is_flat(memos):
        return isinstance(memos, list) and all(
            isinstance(m, dict) and all(isinstance(v, (str, int, float, bool, type(None)))
                                       for v in m.values()) for m in memos)

    def _copy(self, memos):
        # 일반 메모는 문자열만 담은 사전이다. 중첩된 외부 데이터는 깊은 복사로 보존한다.
        return [m.copy() for m in memos] if self._flat_cache else deepcopy(memos)

    def _save(self, memos):
        os.makedirs(self.directory, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            # 한 번에 만들어 쓰는 편이 파일로 조각조각 쓰는 json.dump 보다 약 3배 빠르다(같은 내용)
            f.write(json.dumps(memos, ensure_ascii=False, indent=2))
        stamp = self._stamp(tmp)
        os.replace(tmp, self.path)
        self._flat_cache = self._is_flat(memos)
        self._cached_memos = self._copy(memos)
        self._cache_renderable = True
        self._cache_stamp = self._seen_stamp = stamp  # 내가 쓴 변경은 외부 변경으로 보지 않는다
        self._write_markdown(memos)

    def _write_markdown(self, memos):
        """memos.md 는 memos.json 에서 만드는 읽기용 사본이다. 다른 프로그램이 열어 잠가 쓰지 못해도
        이미 끝난 저장을 실패로 만들지 않는다(다음 저장·외부 변경 때 전체를 다시 쓴다)."""
        tmp = self.md_path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(render_markdown(memos))
            os.replace(tmp, self.md_path)
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass

    # ---------- 변경
    def change(self, fn):
        """메모 목록을 fn 으로 고쳐 저장하고 구독자에게 알린다."""
        with self.lock:
            original = self._load_cached()
            memos = fn(self._copy(original))
            if memos != original:
                self._save(memos)
        # 같은 내용으로 저장해도 화면이 편집 상태를 끝낼 수 있게 완료를 알린다.
        self._notify()
        return memos

    def add(self, fields):
        memo = {"id": uuid.uuid4().hex[:12], "created": datetime.now().strftime("%Y-%m-%d %H:%M")}
        memo.update({k: str(fields.get(k) or "") for k in MEMO_FIELDS})
        if memo["category"] not in MEMO_CATEGORIES:
            memo["category"] = ""
        self.change(lambda ms: ms + [memo])
        return memo

    def revision(self, memo_id):
        with self.lock:
            return self._revisions.get(memo_id, 0)

    def update(self, memo_id, note=None, category=None, expected=None, revision=None):
        """내용·분류만 갱신한다. 자동 분류는 요청 당시 내용과 수정 번호가 같을 때만 저장한다."""
        changed = False
        def fn(ms):
            nonlocal changed
            for m in ms:
                if m["id"] == memo_id:
                    if revision is not None and revision != self.revision(memo_id):
                        break
                    if expected is not None and (m.get("category") or any(
                            m.get(k, "") != expected.get(k, "") for k in ("quote", "note", "title", "category"))):
                        break
                    self._revisions[memo_id] = self.revision(memo_id) + 1
                    if note is not None:
                        m["note"] = note
                    if category in MEMO_CATEGORIES:
                        m["category"] = category
                    changed = True
            return ms
        self.change(fn)
        return changed

    def remove(self, memo_id):
        self.change(lambda ms: [m for m in ms if m["id"] != memo_id])

    def restore(self, memo):
        """지운 메모를 같은 ID 로 되살린다(되돌리기). 이미 있으면 그대로 둔다."""
        memo = dict(memo)
        def fn(ms):
            if any(m["id"] == memo["id"] for m in ms):
                return ms
            return sorted(ms + [memo], key=lambda m: m.get("created", ""))
        self.change(fn)

    # ---------- 알림
    def subscribe(self, fn):
        with self.lock:
            self._listeners.append(fn)

    def unsubscribe(self, fn):
        with self.lock:
            self._listeners = [listener for listener in self._listeners if listener != fn]

    def _notify(self):
        with self.lock:
            listeners = list(self._listeners)
        for fn in listeners:
            try:
                fn()
            except Exception:
                pass

    def poll_external(self):
        """외부 변경·계정 복원 내용을 캐시와 memos.md에 반영한 뒤 구독자에게 알린다."""
        with self.lock:
            stamp = self._stamp()
            changed = stamp != self._seen_stamp
            if changed:
                self._seen_stamp = stamp
                self._sync_markdown(stamp)
        if changed:
            self._notify()
