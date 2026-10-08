"""임시 메모와 가짜 대화로 이전 커밋/작업 사본의 반복 읽기·형광펜 시간을 비교한다."""

import argparse
import json
import statistics
import subprocess
import sys
import tempfile
import timeit
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from memo_store import MemoStore


def committed(ref, filename):
    return subprocess.check_output(["git", "show", f"{ref}:{filename}"], cwd=ROOT, text=True, encoding="utf-8")


def memo_benchmark(ref):
    baseline = {}
    exec(committed(ref, "memo_store.py"), baseline)
    memos = [{"id": str(i), "created": "2026-10-02 12:00", "title": "테스트 대화", "conv": "one",
              "quote": "테스트 문장 " * 10, "note": "메모 내용 " * 20, "exact": "테스트 문장",
              "prefix": "앞 문맥", "suffix": "뒤 문맥"} for i in range(1000)]
    results = {}
    with tempfile.TemporaryDirectory() as directory:
        Path(directory, "memos.json").write_text(json.dumps(memos, ensure_ascii=False), encoding="utf-8")
        for label, cls in [("before", baseline["MemoStore"]), ("after", MemoStore)]:
            store = cls(directory)
            store.load()
            results[label] = round(statistics.median(timeit.repeat(store.load, number=100, repeat=5)) * 10, 3)
    return {"memos": len(memos), "reads_per_sample": 100, "median_ms_per_read": results}


def highlight_benchmark(ref):
    paragraphs = [f'<p>문장-{i:03d}: ' + "본문의 위치를 기억하는 메모 성능 테스트입니다. " * 12 + "</p>" for i in range(200)]
    html = ('<!doctype html><html><body><div data-app-action-sidebar-thread-selected="true" '
            'data-app-action-sidebar-thread-id="local:one"></div><main data-selected-text-overlay-target>'
            + "".join(paragraphs) + "</main></body></html>")
    memos = [{"id": str(i), "created": "", "conv": "one", "quote": f"문장-{i:03d}",
              "note": "", "exact": f"문장-{i:03d}", "prefix": "", "suffix": ": "} for i in range(20)]
    results = {}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", headless=True)
        try:
            for label, source in [("before", committed(ref, "inject.js")),
                                  ("after", (ROOT / "inject.js").read_text(encoding="utf-8"))]:
                page = browser.new_page()
                try:
                    page.set_content(html)
                    page.add_script_tag(content="window.__codexMemoBridge = () => {};")
                    page.add_script_tag(content=source)
                    page.evaluate("m => { window.__codexMemo.setMemos(m); window.__codexMemo.bench(1); }", memos)
                    results[label] = round(statistics.median(
                        page.evaluate("window.__codexMemo.bench(30)") for _ in range(5)), 3)
                    assert page.evaluate("window.__codexMemo.marks") == len(memos)
                finally:
                    page.close()
        finally:
            browser.close()
    return {"paragraphs": 200, "memos": len(memos), "runs_per_sample": 30,
            "median_ms_per_recalculation": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", default="HEAD", help="비교할 이전 Git 커밋")
    args = parser.parse_args()
    print(json.dumps({"baseline": args.baseline, "memo_reads": memo_benchmark(args.baseline),
                      "highlights": highlight_benchmark(args.baseline)}, ensure_ascii=False, indent=2))
