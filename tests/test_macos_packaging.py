"""Checks for accidental personal-data inclusion in the distribution runtime."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("mac_build", ROOT / "macos/build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class PackagingTests(unittest.TestCase):
    def test_private_data_and_source_maps_are_excluded(self):
        with tempfile.TemporaryDirectory() as temp:
            root, target = Path(temp) / "source", Path(temp) / "output"
            target.mkdir()
            files = {"labels/backend.cjs": "code", "labels/default-labels.json": "{}",
                     "labels/vendor/renderer.js": "code", "labels/settings.json": "PRIVATE",
                     "labels/sheets-pending.json": "PRIVATE", "labels/auth.json": "PRIVATE",
                     "dist/node/backend.cjs": "code", "dist/node/backend.cjs.map": "SOURCE_PATH",
                     "VERSION": "1.12.3", "inject.js": "code", "version-badge.js": "code"}
            for name, content in files.items():
                file = root / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_text(content)
            build.stage_runtime(target, root)
            self.assertTrue((target / "labels/vendor/renderer.js").exists())
            self.assertTrue((target / "dist/node/backend.cjs").exists())
            self.assertFalse(any("PRIVATE" in p.read_text() or "SOURCE_PATH" in p.read_text() for p in target.rglob("*") if p.is_file()))

    def test_runtime_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root, target = Path(temp) / "source", Path(temp) / "out"
            (root / "labels").mkdir(parents=True); target.mkdir()
            other = Path(temp) / "private.txt"; other.write_text("private")
            (root / "labels/leak.js").symlink_to(other)
            with self.assertRaises(ValueError): build.stage_runtime(target, root)

    def test_invalid_version_metadata_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / "macos").mkdir()
            config = build.configuration(); config["version"] = "1.0; bad"
            (root / "macos/release-config.json").write_text(json.dumps(config))
            with self.assertRaises(ValueError): build.configuration(root)


if __name__ == "__main__": unittest.main()
