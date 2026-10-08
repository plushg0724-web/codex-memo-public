"""Release archives must contain the product, never a developer's local state."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("release_packager", ROOT / "scripts/package-release.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class ReleasePackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "checkout"
        self.root.mkdir()
        self.archive = Path(self.temporary.name) / "release.zip"
        for name in packager.REQUIRED:
            self.write(name, "required runtime")
        for name in (
            "codex_memo.py", "CodexMemo-Install.cmd", "CodexMemo-Setup.cmd",
            "Codex 메모 시작.bat", "install.ps1", "requirements.txt", "VERSION",
            "inject.js", "LICENSE", "README.md", "codex_memo.ico",
            "labels/default-labels.json", "labels/vendor/renderer.js",
            "labels/vendor/SOURCE_COMMIT.txt", "docs/architecture.md",
            "macos/THIRD_PARTY_NOTICES.txt", "macos/licenses/Node-LICENSE.txt",
        ):
            self.write(name, "product")

    def write(self, name, content):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)
        return file

    def package(self, include_source=False):
        with patch.object(packager, "ROOT", self.root):
            packager.package(self.archive, include_source)
        with zipfile.ZipFile(self.archive) as archive:
            return {name.removeprefix("CodexMemo/"): archive.read(name) for name in archive.namelist()}

    def test_runtime_installation_files_and_manifest_are_preserved(self):
        self.write("src/node/backend.cts", "source only")
        self.write("macos/build.py", "source only")
        files = self.package()
        for name in (*packager.REQUIRED, "codex_memo.py", "install.ps1", "CodexMemo-Install.cmd",
                     "Codex 메모 시작.bat", "requirements.txt", "VERSION", "inject.js", "LICENSE",
                     "labels/default-labels.json", "labels/vendor/SOURCE_COMMIT.txt",
                     "macos/licenses/Node-LICENSE.txt", "docs/architecture.md"):
            self.assertIn(name, files)
        self.assertNotIn("src/node/backend.cts", files)
        self.assertNotIn("macos/build.py", files)
        manifest = json.loads(files["runtime-manifest.json"])
        self.assertEqual(manifest["requiredFiles"], list(packager.REQUIRED))

    def test_local_data_and_builds_are_excluded_in_both_modes(self):
        private = (
            "settings.json", "auth.json", "control.json", ".env", "signing.p12",
            "scratch.py", "memos/memos.json", "labels/settings.json", "labels/sheets-pending.json",
            "labels/auth.json", "labels/.env", "labels/node_modules/dependency/index.js",
            "labels/.jevrouter/token.json", "node_modules/private/index.js",
            ".venv/lib/private.py", "macos/build/extracted/Codex.app/Contents/private.py",
            "macos/build/runtime.cjs", "macos/build/auth.json", "macos/private.key",
            "macos/Codex.app/Contents/stolen.py", "tests/__pycache__/cache.py",
            "tests/auth.json", "src/node/settings.json", "docs/notes.json",
            "dist/node/backend.cjs.map", "dist/node/backend.d.cts", "dist/node/auth.json",
            "dist/node/nested/not-a-runtime.cjs", "licenses/private.p12",
        )
        for name in private:
            self.write(name, "PRIVATE_SENTINEL")
        for include_source in (False, True):
            with self.subTest(include_source=include_source):
                files = self.package(include_source)
                self.assertTrue(set(private).isdisjoint(files))
                self.assertTrue(all(b"PRIVATE_SENTINEL" not in value for value in files.values()))

    def test_source_mode_includes_only_declared_source_and_configuration(self):
        sources = (
            "src/node/backend.cts", "types/globals.d.ts", "tests/test_core.py",
            "tests/test_node.cjs", "scripts/package-release.py", "package.json",
            "package-lock.json", "tsconfig.node.json", "labels/jsconfig.json",
            "macos/MenuApp.swift", "macos/build.py", "macos/entitlements.plist",
            "macos/README.md", "macos/release-config.json", "macos/requirements.txt",
            "macos/requirements-build.txt", "docs/task-progress.example.json",
            "macos/licenses/SOURCES.json", ".gitignore",
        )
        for name in sources:
            self.write(name, "source")
        files = self.package(True)
        self.assertTrue(set(sources).issubset(files))

    def test_symlink_files_and_parent_directories_are_rejected_before_writing(self):
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        secret = outside / "private.js"
        secret.write_text("PRIVATE_SENTINEL")
        cases = (("codex_memo.py", secret), ("labels/leak.js", secret),
                 ("labels/nested", outside), ("src", outside))
        for name, target in cases:
            with self.subTest(name=name):
                link = self.root / name
                existed = link.exists()
                original = link.read_bytes() if existed else None
                if existed:
                    link.unlink()
                link.symlink_to(target, target_is_directory=target.is_dir())
                self.archive.write_bytes(b"previous release")
                try:
                    with patch.object(packager, "ROOT", self.root), self.assertRaisesRegex(ValueError, "symlink"):
                        packager.package(self.archive, include_source=True)
                    self.assertEqual(self.archive.read_bytes(), b"previous release")
                finally:
                    link.unlink()
                    if original is not None:
                        link.write_bytes(original)

    def test_missing_compiled_runtime_still_fails_before_creating_archive(self):
        (self.root / packager.REQUIRED[0]).unlink()
        with patch.object(packager, "ROOT", self.root), self.assertRaisesRegex(RuntimeError, "npm run build"):
            packager.package(self.archive)
        self.assertFalse(self.archive.exists())


if __name__ == "__main__":
    unittest.main()
