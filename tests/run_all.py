"""Run each existing Python/Node test entry point in its own process.

Usage: python tests/run_all.py [--suite all|core|ui|node] [--output PATH]
All fixtures use temporary data or mocked app pages. The UI suite requires
installed Chrome and includes the existing native quick-launch window test.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
UI = {
    "test_common.py", "test_header_labels.py", "test_highlights.py", "test_hover_card.py",
    "test_label_separation.py", "test_label_suggest.py", "test_memo_draft.py", "test_memo_jump.py", "test_model_picker.py",
    "test_quick_launch.py", "test_shim_read.py", "test_sidebar_filter.py",
    "test_task_pet_ui.py", "test_task_progress_ui.py", "test_thread_status.py", "test_ui.py",
    "test_vocab_highlight.py", "test_preview_status.py", "test_subscription_usage.py",
}
WINDOWS_ONLY = {
    "test_updater": "Windows ZIP updater uses Windows process flags",
    "test_watch": "Windows tray app uses WinDLL and the Windows-only launcher",
}


def commands(suite):
    if suite in ("all", "node"):
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js 실행 파일을 찾을 수 없습니다.")
        files = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "tests").glob("test_*.cjs"))
        yield "node", [node, "--test", "--test-concurrency=1", *files]
    for file in sorted((ROOT / "tests").glob("test_*.py")):
        group = "ui" if file.name in UI else "core"
        if suite in ("all", group):
            yield file.stem, [sys.executable, str(file)]


def main():
    # Output encoding must not change child filesystem/native CMD encodings.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=("all", "core", "ui", "node"), default="all")
    parser.add_argument("--output", type=Path, default=ROOT / "output" / "tests")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    results = []
    no_playwright = []
    for name, command in commands(args.suite):
        if sys.platform != "win32" and name in WINDOWS_ONLY:
            reason = WINDOWS_ONLY[name]
            log = args.output / f"{name}.log"
            log.write_text(f"SKIP: {reason}\n", encoding="utf-8")
            results.append({"name": name, "exit_code": 0, "seconds": 0, "log": str(log),
                            "skipped": True, "reason": reason})
            print(f"SKIP {name}: {reason}", flush=True)
            continue
        print(f"RUN {name}", flush=True)
        started = time.monotonic()
        try:
            process = subprocess.run(command, cwd=ROOT, env=env, capture_output=True,
                                     text=True, encoding="utf-8", errors="replace")
            code, output = process.returncode, process.stdout + process.stderr
        except OSError as error:
            code, output = 1, str(error)
        seconds = round(time.monotonic() - started, 2)
        log = args.output / f"{name}.log"
        log.write_text(output, encoding="utf-8")
        results.append({"name": name, "exit_code": code, "seconds": seconds, "log": str(log)})
        print(f"{'PASS' if code == 0 else 'FAIL'} {name} ({seconds}s)", flush=True)
        if code:
            print(output[-6000:], flush=True)
            if "No module named 'playwright'" in output:
                no_playwright.append(name)
    report = args.output / "results.json"
    report.write_text(json.dumps({"suite": args.suite, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    failures = sum(result["exit_code"] != 0 for result in results)
    skipped = sum(result.get("skipped", False) for result in results)
    print(f"{len(results) - skipped - failures}/{len(results) - skipped} entry points passed; "
          f"{skipped} platform skips; {report}")
    if no_playwright:
        # 화면 검사 실패가 코드 문제가 아니라 개발용 패키지가 없어서인 경우를 바로 알 수 있게 한다
        print(f"화면 검사 {len(no_playwright)}개는 개발용 Python 패키지 playwright 가 없어 실행하지 못했습니다: "
              f"{sys.executable} -m pip install playwright (브라우저는 설치된 Chrome 사용)")
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())
