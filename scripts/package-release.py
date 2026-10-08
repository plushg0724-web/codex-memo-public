"""Package the compiled runtime. End-user installations do not need TypeScript."""
import argparse
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = (
    "dist/node/backend.cjs", "dist/node/codex-executable.cjs", "dist/node/appserver.cjs", "dist/node/backup.cjs",
    "dist/node/backup-files.cjs", "dist/node/backup-format.cjs",
    "dist/node/backup-space.cjs", "dist/node/settings-store.cjs",
    "dist/node/protocol.cjs", "dist/node/backup-types.cjs",
    "dist/node/vocabulary-analysis.cjs", "dist/node/vocabulary-service.cjs", "labels/vocabulary-content.js",
    "labels/task-progress-model.js", "labels/task-progress.js", "labels/turn-ending.cjs",
)
# A release is an inventory of product files, not a filtered copy of a developer's
# checkout. In particular, new root-level files must be deliberately added here.
RUNTIME_ROOT_FILES = (
    "VERSION", "requirements.txt", "codex_memo.ico", "Codex 메모 시작.bat",
    "CodexMemo-Install.cmd", "CodexMemo-Setup.cmd", "install.ps1",
    "agent_tools.py", "backup_ui.py", "cdp_bridge.py", "codex_app.py",
    "codex_app_macos.py", "codex_app_windows.py", "codex_memo.py",
    "control_server.py", "memo_store.py", "paths.py", "pet_settings_ui.py",
    "quick_launch.py", "quick_launch_ui.py", "updater.py",
    "inject.js", "version-badge.js",
)
DOCUMENT_FILES = (
    "README.md", "LICENSE", "LICENSE.txt", "LICENSE.md", "NOTICE",
    "NOTICE.txt", "THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES.md",
    "SECURITY.md", "PRIVACY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md",
    "CHANGELOG.md", "macos/THIRD_PARTY_NOTICES.txt",
)
SOURCE_FILES = (
    ".gitignore", ".gitattributes", "package.json", "package-lock.json",
    "jsconfig.json", "tsconfig.node.json", "labels/jsconfig.json",
    "macos/release-config.json", "macos/requirements.txt",
    "macos/requirements-build.txt", "docs/task-progress.example.json",
    "macos/licenses/SOURCES.json",
)
EXCLUDED_DIRS = {
    "node_modules", ".git", "__pycache__", "output", "outputs", "release",
    "releases", "memos", ".jevrouter", ".venv", "venv", "env", "build",
    "dist", "coverage", "credentials", "certificates", "private",
}


def checked_path(root, relative):
    """Reject links in every component, including links to other checkout files."""
    path = root
    for part in Path(relative).parts:
        if part in {".", ".."}:
            raise ValueError(f"Invalid release path: {relative}")
        path = path / part
        if path.is_symlink():
            raise ValueError(f"Release paths must not be symlinks: {relative}")
    return path


def tree_files(root, directory, suffixes, names=(), recursive=True):
    """Walk only a declared product tree; never enter caches or app bundles."""
    base = checked_path(root, directory)
    if not base.exists():
        return
    if not base.is_dir():
        raise ValueError(f"Release directory is not a directory: {directory}")
    for path in sorted(base.iterdir()):
        relative = path.relative_to(root)
        if path.name in EXCLUDED_DIRS or path.name.startswith(".") or path.suffix.lower() == ".app":
            continue
        checked_path(root, relative)
        if path.is_dir():
            if recursive:
                yield from tree_files(root, relative, suffixes, names)
        elif path.is_file() and (path.suffix in suffixes or path.name in names):
            yield relative


def release_files(root, include_source=False):
    files = set()
    for relative in (*RUNTIME_ROOT_FILES, *DOCUMENT_FILES, *(SOURCE_FILES if include_source else ())):
        if checked_path(root, relative).is_file():
            files.add(Path(relative))
    files.update(tree_files(root, "labels", {".js", ".cjs"}, {"default-labels.json", "SOURCE_COMMIT.txt"}))
    files.update(tree_files(root, "dist/node", {".cjs"}, recursive=False))
    files.update(tree_files(root, "docs", {".md", ".txt"}))
    files.update(tree_files(root, "licenses", {".md", ".txt"}, {"LICENSE", "NOTICE", "COPYING"}))
    files.update(tree_files(root, "macos/licenses", {".md", ".txt"}, {"LICENSE", "NOTICE", "COPYING"}))
    if include_source:
        for directory, suffixes in (
            ("src", {".cts", ".ts"}), ("types", {".ts"}),
            ("scripts", {".py", ".js", ".cjs", ".sh", ".ps1"}),
            ("tests", {".py", ".js", ".cjs", ".ts", ".cts"}),
            ("macos", {".py", ".swift", ".plist", ".md"}),
        ):
            files.update(tree_files(root, directory, suffixes))
    return sorted(files)


def package(destination, include_source=False):
    root = ROOT.resolve()
    # Validate the entire inventory before creating an archive, so a link error
    # cannot leave a partially assembled release for somebody to upload.
    files = release_files(root, include_source)
    missing = [name for name in REQUIRED if Path(name) not in files]
    if missing:
        raise RuntimeError("Run npm run build first. Missing: " + ", ".join(missing))
    destination = destination.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for relative in files:
            file = checked_path(root, relative)
            if file == destination:
                continue
            archive.write(file, Path("CodexMemo") / relative)
        archive.writestr("CodexMemo/runtime-manifest.json", json.dumps({"formatVersion": 1, "requiredFiles": REQUIRED}, indent=2))
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "release" / "CodexMemo-Windows.zip")
    parser.add_argument("--include-source", action="store_true")
    args = parser.parse_args()
    print(package(args.output, args.include_source))
