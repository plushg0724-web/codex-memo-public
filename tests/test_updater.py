"""Offline updater tests; no installed app, package install or network access."""
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import updater


def archive(files):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as result:
        for name, content in files.items():
            result.writestr(name, content)
    return data.getvalue()


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.app = Path(folder.name)
        self.patch = patch.object(updater, "APP_DIR", str(self.app))
        self.patch.start()
        self.addCleanup(self.patch.stop)
        (self.app / "codex_memo.py").write_text("old app", encoding="utf-8")
        (self.app / "requirements.txt").write_text("old dependency", encoding="utf-8")
        self.files = {"release/codex_memo.py": "new app", "release/VERSION": "2.0.0",
                      "release/requirements.txt": "new dependency", "release/labels/extra.js": "new module"}

    def install(self, files=None):
        with patch.object(updater.urllib.request, "urlopen", return_value=io.BytesIO(archive(self.files if files is None else files))):
            updater.install({"zip": "https://example.invalid/release.zip"})

    def test_git_directory_and_worktree_file_block_before_download(self):
        marker = self.app / ".git"
        for is_directory in (False, True):
            if is_directory:
                marker.mkdir()
            else:
                marker.write_text("gitdir: elsewhere", encoding="utf-8")
            with patch.object(updater.urllib.request, "urlopen") as download:
                with self.assertRaisesRegex(RuntimeError, "개발용"):
                    updater.install({"zip": "https://example.invalid/release.zip"})
                download.assert_not_called()
            marker.rmdir() if is_directory else marker.unlink()

    def test_dependency_failure_preserves_app_files(self):
        with patch.object(updater.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "pip")) as install:
            with self.assertRaises(subprocess.CalledProcessError):
                self.install()
            self.assertTrue(install.call_args.kwargs["check"])
        self.assertEqual((self.app / "codex_memo.py").read_text(), "old app")
        self.assertFalse((self.app / "VERSION").exists())
        self.assertEqual((self.app / "requirements.txt").read_text(), "old dependency")

    def test_valid_archive_installs_after_dependency_success(self):
        def pip(*args, **kwargs):
            self.assertEqual((self.app / "codex_memo.py").read_text(), "old app")
            staged_requirements = Path(args[0][-1])
            self.assertEqual(staged_requirements.read_text(), "new dependency")
        with patch.object(updater.subprocess, "run", side_effect=pip) as install:
            self.install()
            install.assert_called_once()
        self.assertEqual((self.app / "codex_memo.py").read_text(), "new app")
        self.assertEqual((self.app / "labels" / "extra.js").read_text(), "new module")

    def test_unchanged_dependencies_skip_pip(self):
        self.files["release/requirements.txt"] = "old dependency"
        with patch.object(updater.subprocess, "run") as install:
            self.install()
            install.assert_not_called()

    def test_runtime_manifest_requires_listed_files(self):
        manifest = '{"formatVersion": 1, "requiredFiles": ["dist/node/backend.cjs", "labels/vocabulary-content.js"]}'
        complete = {**self.files, "release/runtime-manifest.json": manifest,
                    "release/dist/node/backend.cjs": "built", "release/labels/vocabulary-content.js": "content"}
        with patch.object(updater.subprocess, "run"):
            self.install(complete)
        self.assertEqual((self.app / "labels" / "vocabulary-content.js").read_text(), "content")

    def test_runtime_manifest_missing_or_unsafe_entries_reject_before_installing(self):
        cases = {
            "source": ('{"requiredFiles": ["dist/node/backend.cjs"]}', "소스 압축"),
            "content": ('{"requiredFiles": ["labels/vocabulary-content.js"]}', "vocabulary-content.js"),
            "outside": ('{"requiredFiles": ["../codex_memo.py"]}', "빠져"),
            "broken": ('{"requiredFiles": "dist"}', "runtime-manifest.json"),
            "invalid": ("{broken", "runtime-manifest.json"),
        }
        for name, (manifest, message) in cases.items():
            with self.subTest(name), patch.object(updater.subprocess, "run") as install:
                with self.assertRaisesRegex(RuntimeError, message):
                    self.install({**self.files, "release/runtime-manifest.json": manifest})
                install.assert_not_called()
                self.assertEqual((self.app / "codex_memo.py").read_text(), "old app")

    def test_legacy_wrapper_without_manifest_checks_built_modules(self):
        files = {**self.files, "release/labels/backend.cjs": "module.exports = require('../dist/node/backend.cjs');"}
        with patch.object(updater.subprocess, "run") as install:
            with self.assertRaisesRegex(RuntimeError, "소스 압축"):
                self.install(files)
            install.assert_not_called()

    def test_invalid_layout_or_paths_reject_before_installing(self):
        cases = [{}, {"file.txt": "not a release"},
                 {**self.files, "second/file": "extra root"},
                 {**self.files, "release/../outside": "traversal"},
                 {**self.files, "/absolute": "absolute"},
                 {**self.files, "release/C:stream": "invalid path"}]
        for files in cases:
            with self.subTest(files=list(files)), patch.object(updater.subprocess, "run") as install:
                with self.assertRaises(RuntimeError):
                    self.install(files)
                install.assert_not_called()
                self.assertEqual((self.app / "codex_memo.py").read_text(), "old app")


if __name__ == "__main__":
    unittest.main()
