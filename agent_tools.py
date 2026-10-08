"""모델(Codex 대화)이 Codex 메모를 직접 관리하는 도구들. control_server.py 가 부르고 labels/memo-mcp.cjs 가 Codex 에 연결한다.

바꾸는 도구는 바꾸기 전 상태를 변경 기록(agent-history.json)에 남겨 undo 로 되돌릴 수 있다.
지우는 도구는 confirm=true 일 때만 실행한다(사용자가 분명히 지우라고 했을 때).
"""

import copy
import json
import os
import re
import threading
import time
import uuid
from datetime import datetime

from memo_store import MEMO_CATEGORIES
from paths import DATA_DIR, version, write_atomic

HISTORY_PATH = os.path.join(DATA_DIR, "agent-history.json")
HISTORY_MAX = 100
PALETTE = (("#FCA5A5", "#450A0A"), ("#FCD34D", "#422006"), ("#86EFAC", "#052E16"), ("#7DD3FC", "#082F49"),
           ("#C4B5FD", "#2E1065"), ("#F9A8D4", "#500724"), ("#FDBA74", "#431407"), ("#CBD5E1", "#0F172A"))
VOCAB_FIELDS = ("meaning", "example", "partOfSpeech", "explanation", "tags", "favorite", "status")
# kind 가 없는 예전 라벨은 이 id 들만 진행 상태로 본다 (labels/vendor/label-kind.cjs 와 같은 기준)
STATUS_IDS = frozenset(("requested", "in_progress", "in_review", "completed", "on_hold"))


class ToolError(Exception):
    """모델에게 그대로 보여 줄 오류."""


def _uuid(thread_id):
    """'local:<uuid>' · '<uuid>' → '<uuid>' (메모의 conv 와 같은 꼴)"""
    return re.sub(r"^[a-z]+:", "", str(thread_id or "").strip())


def _key(thread_id):
    """라벨 열쇠. 화면(vendor/renderer.js)과 같은 'thread:local:local:local:<uuid>' 꼴."""
    tid = str(thread_id or "").strip()
    if not tid:
        raise ToolError("threadId 가 비어 있습니다.")
    return f"thread:local:local:{tid}" if ":" in tid else f"thread:local:local:local:{tid}"


def _text(value, name, limit, required=False):
    if value is None:
        if required:
            raise ToolError(f"{name} 을(를) 입력하세요.")
        return None
    if not isinstance(value, str):
        raise ToolError(f"{name} 은(는) 글자여야 합니다.")
    value = value.strip()
    if required and not value:
        raise ToolError(f"{name} 을(를) 입력하세요.")
    if len(value) > limit:
        raise ToolError(f"{name} 은(는) {limit}자 이하로 입력하세요.")
    return value


def _ids(value, name="threadIds", limit=200):
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or not value or not all(isinstance(x, str) and x.strip() for x in value):
        raise ToolError(f"{name} 에 하나 이상의 ID 를 넣으세요.")
    if len(value) > limit:
        raise ToolError(f"{name} 는 한 번에 {limit}개까지입니다.")
    return list(dict.fromkeys(x.strip() for x in value))


def _limit(value, default=50, maximum=500):
    try:
        n = int(value) if value is not None else default
    except (TypeError, ValueError):
        raise ToolError("limit 는 숫자여야 합니다.")
    return max(1, min(maximum, n))


def _category(value):
    """메모 분류 확인. None 이면 그대로(바꾸지 않음)."""
    if value is not None and value not in MEMO_CATEGORIES:
        raise ToolError("category 는 todo, idea, question, reference, '' 중 하나입니다.")
    return value


def _iso(ms):
    try:
        return datetime.fromtimestamp(ms / 1000 if ms > 1e11 else ms).strftime("%Y-%m-%d %H:%M") if ms else ""
    except (OverflowError, OSError, ValueError):
        return ""


class Journal:
    """모델이 바꾼 내용과 되돌리는 방법. 최근 HISTORY_MAX 개만 파일에 남긴다."""

    def __init__(self, path=HISTORY_PATH):
        self.path = path
        self.lock = threading.Lock()
        try:
            with open(path, encoding="utf-8") as f:
                self.entries = json.load(f)
            if not isinstance(self.entries, list):
                self.entries = []
        except (OSError, ValueError):
            self.entries = []

    def _save(self):
        write_atomic(self.path, json.dumps(self.entries[-HISTORY_MAX:], ensure_ascii=False, indent=1))

    def add(self, tool, summary, undo):
        entry = {"id": uuid.uuid4().hex[:8], "at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                 "tool": tool, "summary": summary, "undo": undo, "undone": False}
        with self.lock:
            self.entries.append(entry)
            self.entries = self.entries[-HISTORY_MAX:]
            self._save()
        return entry["id"]

    def find(self, change_id=None):
        with self.lock:
            for e in reversed(self.entries):
                if not e.get("undone") and (change_id is None or e["id"] == change_id):
                    return e
                if change_id is not None and e["id"] == change_id:
                    raise ToolError("이미 되돌린 변경입니다.")
        raise ToolError("되돌릴 변경이 없습니다." if change_id is None else f"변경 {change_id} 을(를) 찾지 못했습니다.")

    def mark_undone(self, entry):
        with self.lock:
            entry["undone"] = True
            self._save()

    def recent(self, limit):
        with self.lock:
            return [{k: e[k] for k in ("id", "at", "tool", "summary", "undone")} for e in reversed(self.entries[-limit:])]


class AgentTools:
    def __init__(self, bridge, store, journal=None):
        self.bridge = bridge
        self.store = store
        self.journal = journal or Journal()
        self.lock = threading.Lock()   # 도구는 한 번에 하나씩(같은 파일을 동시에 고치지 않게)
        self.tools = {name[5:]: getattr(self, name) for name in dir(self) if name.startswith("tool_")}

    def call(self, name, args):
        fn = self.tools.get(name)
        if not fn:
            raise ToolError(f"알 수 없는 도구입니다: {name}")
        if not isinstance(args, dict):
            raise ToolError("인자는 객체여야 합니다.")
        with self.lock:
            try:
                return fn(**args)
            except TypeError as e:
                raise ToolError(f"인자가 올바르지 않습니다: {e}")
            except RuntimeError as e:
                raise ToolError(str(e))

    # ------------------------------------------------------------ 공통
    def _labels(self, method, *args, timeout=60):
        return self.bridge.labels_call(method, list(args), timeout)

    def _snapshot(self):
        return self._labels("read", None)

    def _page(self, expression, timeout=60, need="__cxmThreadActions"):
        s = self.bridge.main_session()
        if s is None:
            raise ToolError("Codex 화면에 연결돼 있지 않습니다. Codex 를 'Codex 메모 모드'로 켜 주세요.")
        if not s.evaluate(f"!!window.{need}", 10):
            raise ToolError("Codex 화면에 이 기능이 아직 없습니다. 트레이의 'Codex 화면 새로 고침'을 눌러 주세요.")
        return s.evaluate(expression, timeout)

    def _filter(self, expression):
        return self._page(f"(() => {{ const f = window.__cxmSidebarFilter; return {expression}; }})()", 20, "__cxmSidebarFilter")

    @staticmethod
    def _kind(label):
        k = label.get("kind")
        if k in ("status", "category"):
            return k
        return "status" if label.get("id") in STATUS_IDS else "category"

    def _resolve_label(self, labels, value, kind):
        """라벨 id 또는 이름 → id. None·'none'·'' 이면 None(지우기)."""
        if value is None or (isinstance(value, str) and value.strip().lower() in ("", "none", "없음")):
            return None
        v = str(value).strip()
        for l in labels:
            if self._kind(l) == kind and (l["id"] == v or l["name"].strip().lower() == v.lower()):
                return l["id"]
        names = ", ".join(l["name"] for l in labels if self._kind(l) == kind and l.get("enabled", True))
        raise ToolError(f"'{v}' {'진행 상태' if kind == 'status' else '카테고리'} 라벨이 없습니다. 있는 라벨: {names}")

    # ------------------------------------------------------------ 상태
    def tool_status(self):
        """도우미·Codex 화면 연결 상태"""
        return {"version": version(), "codexScreenConnected": self.bridge.main_session() is not None,
                "labelsBackend": bool(self.bridge.labels), "dataDir": DATA_DIR}

    # ------------------------------------------------------------ 라벨
    def tool_labels_list(self):
        snap = self._snapshot()
        counts = {}
        for field in ("assignments", "categoryAssignments"):
            for v in (snap.get(field) or {}).values():
                counts[v] = counts.get(v, 0) + 1
        labels = sorted(snap["config"]["labels"], key=lambda l: l.get("order", 0))
        return {"labels": [{"id": l["id"], "name": l["name"], "kind": self._kind(l), "enabled": l.get("enabled", True),
                            "description": l.get("description", ""), "color": l.get("backgroundColor"),
                            "uses": counts.get(l["id"], 0)} for l in labels]}

    def _exclude(self, labels, values, kind, name):
        """빼기 목록(라벨 id·이름·'none') → 라벨 id 집합(라벨 없음은 None)"""
        if values is None:
            return set()
        if isinstance(values, str):
            values = [values]
        if not isinstance(values, list) or len(values) > 100:
            raise ToolError(f"{name} 은(는) 라벨 이름·id 목록이어야 합니다.")
        return {self._resolve_label(labels, v, kind) for v in values}

    def tool_threads_list(self, status=None, category=None, query=None, limit=50, excludeStatus=None, excludeCategory=None):
        """대화 목록(이 PC 대화 + 왼쪽 목록에 보이는 대화)과 라벨"""
        snap = self._snapshot()
        labels = snap["config"]["labels"]
        names = {l["id"]: l["name"] for l in labels}
        want_status = self._resolve_label(labels, status, "status") if status not in (None, "all") else "all"
        want_category = self._resolve_label(labels, category, "category") if category not in (None, "all") else "all"
        skip_status = self._exclude(labels, excludeStatus, "status", "excludeStatus")
        skip_category = self._exclude(labels, excludeCategory, "category", "excludeCategory")
        query = (_text(query, "query", 200) or "").lower()
        threads = {}
        try:
            for t in self._labels("threadCatalog", 500, timeout=90) or []:
                threads[_uuid(t["id"])] = {"threadId": _uuid(t["id"]), "title": t.get("name") or "", "cwd": t.get("cwd") or "",
                                           "updatedAt": t.get("updatedAt") or 0, "inSidebar": False}
        except Exception:
            pass   # App Server 를 못 쓰면 왼쪽 목록만
        s = self.bridge.main_session()
        if s is not None:
            try:
                for r in s.evaluate("window.__cxmThreadActions ? window.__cxmThreadActions.rows() : []", 15) or []:
                    tid = _uuid(r["rowId"])
                    t = threads.setdefault(tid, {"threadId": tid, "title": r["title"], "cwd": "", "updatedAt": 0})
                    t["inSidebar"] = True
                    t["title"] = t["title"] or r["title"]
                    t["pinned"] = r.get("pinned", False)
                    if r.get("host") and r["host"] != "local":
                        t["host"] = r["host"]
            except Exception:
                pass
        out = []
        for t in threads.values():
            key = _key(t["threadId"])
            st = (snap.get("assignments") or {}).get(key)
            ca = (snap.get("categoryAssignments") or {}).get(key)
            if want_status != "all" and st != want_status:
                continue
            if want_category != "all" and ca != want_category:
                continue
            if st in skip_status or ca in skip_category:
                continue
            if query and query not in t["title"].lower() and query not in t["cwd"].lower():
                continue
            out.append({**t, "status": names.get(st) if st else None, "category": names.get(ca) if ca else None,
                        "updatedAt": _iso(t["updatedAt"])})
        out.sort(key=lambda t: t["updatedAt"], reverse=True)
        n = _limit(limit)
        return {"total": len(out), "threads": out[:n]}

    def tool_labels_assign(self, threadIds, status="__keep", category="__keep"):
        """여러 대화의 진행 상태·카테고리를 한꺼번에 지정. 라벨 id·이름, 지우려면 null"""
        ids = _ids(threadIds)
        if status == "__keep" and category == "__keep":
            raise ToolError("status 나 category 중 하나는 넣으세요(지우려면 null).")
        snap = self._snapshot()
        labels = snap["config"]["labels"]
        keys = [_key(t) for t in ids]
        before = {k: {"status": (snap.get("assignments") or {}).get(k),
                      "category": (snap.get("categoryAssignments") or {}).get(k)} for k in keys}
        done = []
        for kind, value in (("status", status), ("category", category)):
            if value == "__keep":
                continue
            label_id = self._resolve_label(labels, value, kind)
            self._labels("assignMany", keys, label_id, kind)
            name = next((l["name"] for l in labels if l["id"] == label_id), None)
            done.append(f"{'진행 상태' if kind == 'status' else '카테고리'} → {name or '없음'}")
        summary = f"대화 {len(keys)}개: " + ", ".join(done)
        change = self.journal.add("labels_assign", summary, {"type": "labels", "before": before,
                                                             "kinds": [k for k, v in (("status", status), ("category", category)) if v != "__keep"]})
        return {"changeId": change, "summary": summary}

    def tool_label_define(self, name, kind=None, id=None, description=None, color=None, textColor=None, enabled=None):
        """라벨 종류 추가 또는 수정(이름·설명·색·켜기/끄기). 라벨은 지울 수 없고 끌 수만 있다"""
        name = _text(name, "name", 30, required=True)
        snap = self._snapshot()
        config = copy.deepcopy(snap["config"])
        labels = config["labels"]
        target = next((l for l in labels if (id and l["id"] == id) or (not id and l["name"].strip().lower() == name.lower())), None)
        if id and target is None:
            raise ToolError(f"라벨 id '{id}' 가 없습니다.")
        hexcolor = re.compile(r"^#[0-9A-Fa-f]{6}$")
        for v, n in ((color, "color"), (textColor, "textColor")):
            if v is not None and not hexcolor.match(str(v)):
                raise ToolError(f"{n} 은(는) #RRGGBB 꼴이어야 합니다.")
        before = copy.deepcopy(target) if target else None
        if target is None:
            if kind not in ("status", "category"):
                raise ToolError("새 라벨은 kind 를 'status'(진행 상태) 또는 'category'(카테고리)로 정하세요.")
            bg, fg = PALETTE[len(labels) % len(PALETTE)]
            target = {"id": "label_" + uuid.uuid4().hex[:12], "kind": kind, "name": name, "backgroundColor": color or bg,
                      "textColor": textColor or fg, "order": max([l.get("order", 0) for l in labels] + [0]) + 10,
                      "enabled": True if enabled is None else bool(enabled), "description": _text(description, "description", 500) or ""}
            labels.append(target)
        else:
            if kind is not None and kind != self._kind(target):
                raise ToolError("기존 라벨의 종류는 바꿀 수 없습니다. 새 라벨을 만드세요.")
            target["name"] = name
            if description is not None:
                target["description"] = _text(description, "description", 500)
            if color is not None:
                target["backgroundColor"] = color
            if textColor is not None:
                target["textColor"] = textColor
            if enabled is not None:
                target["enabled"] = bool(enabled)
        self._labels("saveConfig", config, snap["configRevision"])
        summary = f"라벨 '{name}' {'만듦' if before is None else '수정'}"
        change = self.journal.add("label_define", summary, {"type": "label", "id": target["id"], "before": before})
        return {"changeId": change, "summary": summary, "label": {"id": target["id"], "name": target["name"], "kind": self._kind(target)}}

    # ------------------------------------------------------------ 메모
    @staticmethod
    def _memo_out(m):
        return {"id": m["id"], "created": m.get("created", ""), "threadId": m.get("conv", ""), "title": m.get("title") or m.get("window") or "",
                "quote": m.get("quote", ""), "note": m.get("note", ""), "category": m.get("category", "")}

    def tool_memos_list(self, query=None, category=None, threadId=None, limit=50):
        q = (_text(query, "query", 200) or "").lower()
        conv = _uuid(threadId) if threadId else None
        _category(category)
        out = []
        for m in reversed(self.store.load()):
            if conv and m.get("conv") != conv:
                continue
            if category is not None and m.get("category", "") != category:
                continue
            if q and not any(q in str(m.get(k, "")).lower() for k in ("note", "quote", "title")):
                continue
            out.append(self._memo_out(m))
        return {"total": len(out), "memos": out[:_limit(limit)]}

    def tool_memo_add(self, note, quote=None, threadId=None, title=None, category=None):
        note = _text(note, "note", 5000, required=True)
        _category(category)
        memo = self.store.add({"note": note, "quote": _text(quote, "quote", 5000) or "", "conv": _uuid(threadId) if threadId else "",
                               "title": _text(title, "title", 200) or "", "category": category or ""})
        summary = f"메모 추가: {note[:40]}"
        change = self.journal.add("memo_add", summary, {"type": "memo_add", "id": memo["id"]})
        return {"changeId": change, "memo": self._memo_out(memo)}

    def _memo(self, memo_id):
        m = self.store.get(memo_id)   # 메모 하나만 복사한다(전체 목록 복사 없음)
        if m is None:
            raise ToolError(f"메모 {memo_id} 이(가) 없습니다.")
        return m

    def tool_memo_update(self, id, note=None, category=None):
        before = self._memo(id)
        if note is None and category is None:
            raise ToolError("note 나 category 중 하나는 넣으세요.")
        _category(category)
        self.store.update(id, _text(note, "note", 5000, required=note is not None), category)
        summary = f"메모 수정: {(note or before.get('note', ''))[:40]}"
        change = self.journal.add("memo_update", summary, {"type": "memo_update", "id": id,
                                                           "note": before.get("note", ""), "category": before.get("category", "")})
        return {"changeId": change, "memo": self._memo_out(self._memo(id))}

    def tool_memo_delete(self, id, confirm=False):
        if confirm is not True:
            raise ToolError("지우기는 사용자가 분명히 요청했을 때만 confirm=true 로 실행하세요.")
        before = self._memo(id)
        self.store.remove(id)
        summary = f"메모 삭제: {before.get('note', '')[:40]}"
        change = self.journal.add("memo_delete", summary, {"type": "memo_delete", "memo": before})
        return {"changeId": change, "summary": summary}

    # ------------------------------------------------------------ 단어장
    def tool_vocabulary_list(self, query=None, status=None, limit=50):
        q = (_text(query, "query", 200) or "").lower()
        out = []
        for e in self._labels("vocabularyRead")["entries"]:
            if status and e.get("status") != status:
                continue
            if q and not any(q in str(e.get(k, "")).lower() for k in ("term", "meaning", "example", "explanation")):
                continue
            out.append({k: e.get(k) for k in ("id", "term", "meaning", "example", "partOfSpeech", "explanation", "tags", "favorite", "status")}
                       | {"updatedAt": _iso(e.get("updatedAt") or 0)})
        return {"total": len(out), "entries": out[:_limit(limit)]}

    def tool_vocabulary_add(self, term, meaning, example=None, partOfSpeech=None, explanation=None, tags=None, context=None):
        entry = self._labels("vocabularyAdd", {"term": term, "meaning": meaning, "example": example or "", "partOfSpeech": partOfSpeech or "",
                                               "explanation": explanation or "", "tags": tags or [], "context": context or ""})
        summary = f"단어 추가: {entry['term']}"
        change = self.journal.add("vocabulary_add", summary, {"type": "vocab_add", "id": entry["id"]})
        return {"changeId": change, "entry": {k: entry.get(k) for k in ("id", "term", "meaning")}}

    def _vocab(self, entry_id):
        snap = self._labels("vocabularyRead")
        e = next((e for e in snap["entries"] if e["id"] == entry_id), None)
        if e is None:
            raise ToolError(f"단어 {entry_id} 이(가) 없습니다.")
        return e, snap["revision"]

    def tool_vocabulary_update(self, id, **fields):
        patch = {k: v for k, v in fields.items() if k in VOCAB_FIELDS and v is not None}
        unknown = set(fields) - set(VOCAB_FIELDS)
        if unknown:
            raise ToolError(f"바꿀 수 없는 항목: {', '.join(sorted(unknown))}")
        if not patch:
            raise ToolError("바꿀 내용을 넣으세요.")
        before, rev = self._vocab(id)
        self._labels("vocabularyEdit", id, patch, rev)
        summary = f"단어 수정: {before['term']} ({', '.join(patch)})"
        change = self.journal.add("vocabulary_update", summary, {"type": "vocab_update", "id": id,
                                                                 "patch": {k: before.get(k) for k in patch}})
        return {"changeId": change, "summary": summary}

    def tool_vocabulary_delete(self, id, confirm=False):
        if confirm is not True:
            raise ToolError("지우기는 사용자가 분명히 요청했을 때만 confirm=true 로 실행하세요.")
        before, rev = self._vocab(id)
        self._labels("vocabularyDelete", id, rev)
        summary = f"단어 삭제: {before['term']}"
        change = self.journal.add("vocabulary_delete", summary, {"type": "vocab_delete", "entry": before})
        return {"changeId": change, "summary": summary}

    # ------------------------------------------------------------ 프로젝트·섹션 옮기기 (Codex 화면)
    def tool_move_destinations(self, threadIds):
        ids = _ids(threadIds, limit=50)
        return {"destinations": self._page(f"window.__cxmThreadActions.destinations({json.dumps(ids)})")}

    def tool_threads_move(self, threadIds, destination):
        ids = _ids(threadIds)
        dest = _text(destination, "destination", 300, required=True)
        r = self._page(f"window.__cxmThreadActions.move({json.dumps(ids)}, {json.dumps(dest)})", timeout=60 + 5 * len(ids))
        result = {"moved": len(r["moved"]), "skipped": r["skipped"], "failed": r["failed"]}
        if r["moved"]:
            summary = f"대화 {len(r['moved'])}개를 '{dest}'(으)로 옮김"
            result["changeId"] = self.journal.add("threads_move", summary, {"type": "move", "before": r["before"]})
            result["summary"] = summary
        elif not r["failed"]:
            result["summary"] = "옮길 대화가 없습니다(이미 그곳에 있거나 그 이름의 프로젝트·섹션이 없음). move_destinations 로 확인하세요."
        return result

    # ------------------------------------------------------------ 왼쪽 목록 필터·저장한 필터 (Codex 화면)
    def _hidden(self, labels, values, kind, name):
        """숨길 라벨 이름·id·'none' 목록 → 화면 필터 값(라벨 id, 라벨 없음은 'none')"""
        return sorted({v or "none" for v in self._exclude(labels, values, kind, name)})

    def _filter_out(self, f, labels):
        names = {l["id"]: l["name"] for l in labels}
        name = lambda v: "라벨 없음" if v == "none" else names.get(v, v)
        return {"hideStatus": [name(v) for v in f["status"]], "hideCategory": [name(v) for v in f["category"]]}

    def _filter_change(self, tool, summary, expression):
        """필터를 바꾸고(바꾸기 전 상태를 기록) 바꾼 뒤 상태를 돌려준다"""
        before = self._filter("f.exportState()")
        self._filter(expression)
        change = self.journal.add(tool, summary, {"type": "filter", "before": before})
        return {"changeId": change, "summary": summary, **self.tool_filters_list()}

    def _preset(self, name):
        presets = self._filter("f.presets()")
        p = next((p for p in presets if p["name"] == name), None) or next((p for p in presets if p["name"].lower() == str(name).strip().lower()), None)
        if p is None:
            raise ToolError(f"'{name}' 저장한 필터가 없습니다. 있는 필터: {', '.join(x['name'] for x in presets) or '없음'}")
        return p

    def tool_filters_list(self):
        """왼쪽 목록에 지금 걸린 필터와 저장한 필터"""
        labels = self._snapshot()["config"]["labels"]
        st = self._filter("({...f.exportState(), counts: f.counts(), active: (f.presets().find(p => p.active) || {}).name || null})")
        return {"current": {**self._filter_out(st["filter"], labels), "savedFilter": st["active"],
                            "shown": st["counts"]["shown"], "total": st["counts"]["total"]},
                "savedFilters": [{"name": p["name"], **self._filter_out(p, labels), "inUse": p["name"] == st["active"]} for p in st["presets"]]}

    def tool_filter_set(self, hideStatus=None, hideCategory=None, savedFilter=None):
        """왼쪽 목록 필터 바꾸기: 저장한 필터 쓰기, 또는 숨길 진행 상태·카테고리 지정([] 은 모두 보기)"""
        if savedFilter is not None:
            p = self._preset(savedFilter)
            return self._filter_change("filter_set", f"필터: 저장한 필터 '{p['name']}' 사용", f"f.applyPreset({json.dumps(p['id'])})")
        if hideStatus is None and hideCategory is None:
            raise ToolError("savedFilter 나 hideStatus·hideCategory 중 하나는 넣으세요(모두 보려면 둘 다 []).")
        labels = self._snapshot()["config"]["labels"]
        f = {}
        if hideStatus is not None:
            f["status"] = self._hidden(labels, hideStatus, "status", "hideStatus")
        if hideCategory is not None:
            f["category"] = self._hidden(labels, hideCategory, "category", "hideCategory")
        out = self._filter_out({"status": f.get("status", []), "category": f.get("category", [])}, labels)
        parts = [f"{t} {', '.join(out[k]) or '모두 보기'} 숨김" if out[k] else f"{t} 모두 보기"
                 for k, t, key in (("hideStatus", "진행 상태", "status"), ("hideCategory", "카테고리", "category")) if key in f]
        return self._filter_change("filter_set", "필터: " + " · ".join(parts), f"f.setFilter({json.dumps(f)})")

    def tool_filter_save(self, name, hideStatus=None, hideCategory=None):
        """필터 저장(같은 이름은 덮어씀). 숨길 값을 빼면 지금 필터를 저장"""
        name = _text(name, "name", 30, required=True)
        cur = self._filter("f.exportState().filter")
        labels = self._snapshot()["config"]["labels"]
        f = {"status": self._hidden(labels, hideStatus, "status", "hideStatus") if hideStatus is not None else cur["status"],
             "category": self._hidden(labels, hideCategory, "category", "hideCategory") if hideCategory is not None else cur["category"]}
        return self._filter_change("filter_save", f"저장한 필터 '{name}' 저장", f"f.savePreset({json.dumps(name)}, {json.dumps(f)})")

    def tool_filter_rename(self, name, newName):
        p = self._preset(name)
        new = _text(newName, "newName", 30, required=True)
        if any(x["name"] == new and x["id"] != p["id"] for x in self._filter("f.presets()")):
            raise ToolError(f"'{new}' 이름의 저장한 필터가 이미 있습니다.")
        return self._filter_change("filter_rename", f"저장한 필터 이름 '{p['name']}' → '{new}'", f"f.renamePreset({json.dumps(p['id'])}, {json.dumps(new)})")

    def tool_filter_delete(self, name, confirm=False):
        if confirm is not True:
            raise ToolError("지우기는 사용자가 분명히 요청했을 때만 confirm=true 로 실행하세요.")
        p = self._preset(name)
        return self._filter_change("filter_delete", f"저장한 필터 '{p['name']}' 삭제", f"f.deletePreset({json.dumps(p['id'])})")

    # ------------------------------------------------------------ 변경 기록·되돌리기
    def tool_history(self, limit=10):
        return {"changes": self.journal.recent(_limit(limit, 10, HISTORY_MAX))}

    def tool_undo(self, changeId=None):
        entry = self.journal.find(changeId)
        u = entry["undo"]
        t = u["type"]
        if t == "labels":
            for kind in u.get("kinds") or ("status", "category"):
                groups = {}
                for key, prev in u["before"].items():
                    groups.setdefault(prev[kind], []).append(key)
                for label_id, keys in groups.items():
                    self._labels("assignMany", keys, label_id, kind)
        elif t == "label":
            snap = self._snapshot()
            config = copy.deepcopy(snap["config"])
            for i, l in enumerate(config["labels"]):
                if l["id"] == u["id"]:
                    if u["before"] is None:
                        l["enabled"] = False   # 만든 라벨은 지울 수 없어 끈다
                    else:
                        config["labels"][i] = {**l, **{k: u["before"][k] for k in ("name", "backgroundColor", "textColor", "enabled", "description") if k in u["before"]}}
            self._labels("saveConfig", config, snap["configRevision"])
        elif t == "memo_add":
            self.store.remove(u["id"])
        elif t == "memo_update":
            self.store.update(u["id"], u["note"], u["category"])
        elif t == "memo_delete":
            self.store.restore(u["memo"])
        elif t == "vocab_add":
            _, rev = self._vocab(u["id"])
            self._labels("vocabularyDelete", u["id"], rev)
        elif t == "vocab_update":
            _, rev = self._vocab(u["id"])
            self._labels("vocabularyEdit", u["id"], {k: v for k, v in u["patch"].items() if v is not None}, rev)
        elif t == "vocab_delete":
            self._labels("vocabularyRestore", u["entry"])
        elif t == "filter":
            self._filter(f"f.importState({json.dumps(u['before'])})")
        elif t == "move":
            failed = []
            for tid, before in u["before"].items():
                try:
                    self._page(f"window.__cxmThreadActions.restore({json.dumps(tid)}, {json.dumps(before)})")
                except ToolError as e:
                    failed.append({"id": tid, "error": str(e)})
                time.sleep(0.2)
            if failed:
                self.journal.mark_undone(entry)
                return {"undone": entry["summary"], "failed": failed}
        else:
            raise ToolError("이 변경은 되돌릴 수 없습니다.")
        self.journal.mark_undone(entry)
        return {"undone": entry["summary"]}
