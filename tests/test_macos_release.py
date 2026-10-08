"""Release gates and command ordering, without credentials or Apple uploads."""
import importlib.util
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("macos_release", ROOT / "macos/release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
IDENTITY = "A" * 40
TEAM = "A123456789"
SUBMISSION = "12345678-1234-1234-1234-123456789abc"


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="memo-release-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / "Codex 메모.app"
        self.info = {"CFBundleExecutable": "CodexMemoMenu", "CFBundleIdentifier": "io.github.example.memo",
                     "CFBundleVersion": "1120302", "CFBundleShortVersionString": "1.12.3",
                     "LSMinimumSystemVersion": "13.5"}
        self.binary("Contents/MacOS/CodexMemoMenu")
        self.node = self.binary("Contents/Resources/node/bin/node")
        self.helper = self.binary("Contents/Resources/runtime/CodexMemoHelper/CodexMemoHelper")
        self.library = self.binary("Contents/Resources/runtime/CodexMemoHelper/_internal/module.so")
        self.framework_binary = self.binary("Contents/Resources/runtime/Python.framework/Versions/A/Python")
        framework = self.app / "Contents/Resources/runtime/Python.framework"
        (framework / "Versions/Current").symlink_to("A")
        (framework / "Python").symlink_to("Versions/Current/Python")
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps(self.info))
        (self.app / "Contents/Resources/runtime-manifest.json").write_text(json.dumps(
            {"signing": "ad-hoc-development", "notarized": False, "distributionReady": False}))
        self.calls = []
        self.notary_status = "Accepted"
        self.fail_gatekeeper = False
        self.platform = patch.object(release.sys, "platform", "darwin")
        self.platform.start()
        self.addCleanup(self.platform.stop)

    def binary(self, relative):
        path = self.app / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(bytes.fromhex("cffaedfe") + b"fixture")
        path.chmod(0o755)
        return path

    def fake_run(self, command, *, check=True, timeout=300, env=None):
        args = [str(value) for value in command]
        self.calls.append(args)
        stdout = stderr = ""
        returncode = 0
        if args[0] == "/usr/bin/security":
            stdout = f'1) {IDENTITY} "Developer ID Application: Example ({TEAM})"\n1 valid identities found'
        elif args[0] == "/usr/bin/ditto":
            if "-c" in args:
                Path(args[-1]).write_bytes(b"zip-data")
            else:
                shutil.copytree(args[-2], args[-1], symlinks=True)
        elif args[0] == "/usr/bin/lipo":
            stdout = "arm64\n"
        elif args[-1] == "--smoke-test":
            self.assertEqual(timeout, 30)
            self.assertNotEqual(env["CODEX_MEMO_DATA"], str(self.root))
            self.assertTrue(Path(env["CODEX_MEMO_DATA"]).is_dir())
            self.assertNotIn("CODEX_MEMO_APP", env)
            self.assertTrue(str(env.get("CODEX_MEMO_DEBUG_PORT", "")).isdigit())
            stdout = "NATIVE_APP_SMOKE_OK\n"
        elif args[:2] == ["/usr/bin/hdiutil", "create"]:
            Path(args[-1]).write_bytes(b"dmg-data")
        elif args[:2] == ["/usr/bin/codesign", "--display"]:
            stderr = f"Authority=Developer ID Application: Example ({TEAM})\nTeamIdentifier={TEAM}\nTimestamp=Oct 8, 2026\nCodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=3\n"
        elif args[:3] == ["/usr/bin/xcrun", "notarytool", "submit"]:
            stdout = json.dumps({"id": SUBMISSION, "status": self.notary_status})
        elif args[:3] == ["/usr/bin/xcrun", "notarytool", "log"]:
            Path(args[-1]).write_text(json.dumps({"status": self.notary_status, "issues": None}))
        elif args[0] == "/usr/sbin/spctl" and self.fail_gatekeeper:
            raise release.ReleaseError("Gatekeeper rejected")
        return subprocess.CompletedProcess(args, returncode, stdout, stderr)

    def test_deepest_code_before_framework_and_app(self):
        targets = release.signing_targets(self.app)
        framework = self.app / "Contents/Resources/runtime/Python.framework"
        self.assertLess(targets.index(self.framework_binary), targets.index(framework))
        self.assertEqual(targets[-1], self.app)
        self.assertTrue(all(not path.is_symlink() for path in targets))

    def test_entitlements_are_minimal_per_executable(self):
        node = plistlib.loads(release.entitlement_for(self.node, self.app).read_bytes())
        helper = plistlib.loads(release.entitlement_for(self.helper, self.app).read_bytes())
        library = plistlib.loads(release.entitlement_for(self.library, self.app).read_bytes())
        self.assertEqual(node, {"com.apple.security.cs.allow-jit": True})
        self.assertEqual(helper, {"com.apple.security.automation.apple-events": True})
        self.assertEqual(library, {})

    def test_source_symlinks_cannot_escape_bundle(self):
        (self.app / "Contents/Resources/escape").symlink_to(self.root)
        with self.assertRaisesRegex(release.ReleaseError, "Unsafe"):
            release.validate_app(self.app)

    def test_source_symlinks_cannot_be_broken(self):
        (self.app / "Contents/Resources/broken").symlink_to("not-here")
        with self.assertRaisesRegex(release.ReleaseError, "broken"):
            release.validate_app(self.app)

    def test_refuses_to_overwrite_any_existing_output(self):
        destination = self.root / "existing"
        destination.mkdir()
        marker = destination / "do-not-delete"
        marker.write_text("keep")
        with self.assertRaisesRegex(release.ReleaseError, "already exists"):
            release.release(self.app, destination, preview=True)
        self.assertEqual(marker.read_text(), "keep")

    def test_requires_explicit_preview_or_all_release_gates(self):
        for kwargs, pattern in (({}, "requires"), ({"identity": IDENTITY}, "requires"),
                                ({"preview": True, "identity": IDENTITY}, "cannot be combined")):
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(release.ReleaseError, pattern):
                release.release(self.app, self.root / "output", **kwargs)
        self.assertFalse((self.root / "output").exists())

    def test_requires_exact_developer_id_application_identity(self):
        with patch.object(release, "run", side_effect=self.fake_run):
            self.assertEqual(release.resolve_identity(IDENTITY.lower()), (IDENTITY, TEAM))
            for invalid in ("-", "Apple Development: Example", "Developer ID Application: Example"):
                with self.subTest(invalid=invalid), self.assertRaises(release.ReleaseError):
                    release.resolve_identity(invalid)

    def test_preview_has_checksums_and_records_unnotarized_status(self):
        output = self.root / "preview"
        source_before = (self.app / "Contents/Resources/runtime-manifest.json").read_bytes()
        with patch.object(release, "run", side_effect=self.fake_run):
            manifest = release.release(self.app, output, preview=True)
        self.assertEqual(manifest["status"], "preview-unnotarized")
        self.assertFalse(manifest["distributionReady"])
        self.assertEqual(manifest["distributionReadyCriteria"], "developer-id-notarization-gatekeeper")
        self.assertEqual(manifest["minimumSystemVersion"], "13.5")
        self.assertTrue(all("preview" in artifact["file"] for artifact in manifest["artifacts"]))
        self.assertTrue((output / "SHA256SUMS.txt").is_file())
        notice = (output / "UNNOTARIZED-PREVIEW.txt").read_text(encoding="utf-8")
        self.assertIn("https://support.apple.com/ko-kr/102445", notice)
        self.assertIn("첫 실행", notice)
        self.assertFalse(any("notarytool" in call or "spctl" in call[0] for call in self.calls))
        self.assertEqual(source_before, (self.app / "Contents/Resources/runtime-manifest.json").read_bytes())
        signatures = [call for call in self.calls if "--sign" in call]
        self.assertTrue(signatures)
        self.assertTrue(all("--deep" not in call for call in signatures))
        self.assertTrue(all("--timestamp=none" in call and "runtime" not in call for call in signatures))

    def test_full_release_staples_app_before_final_archives_and_dmg(self):
        output = self.root / "release"
        with patch.object(release, "run", side_effect=self.fake_run):
            manifest = release.release(self.app, output, identity=IDENTITY, notary_profile="test-profile")
        self.assertTrue(manifest["distributionReady"])
        self.assertEqual(manifest["status"], "ready")
        self.assertEqual(manifest["gatekeeper"], "accepted-app-and-dmg")
        app_staple = next(i for i, call in enumerate(self.calls) if "staple" in call and call[-1].endswith(".app"))
        final_zip = next(i for i, call in enumerate(self.calls) if call[0] == "/usr/bin/ditto" and call[-1].endswith(".zip") and "notarization" not in call[-1])
        self.assertLess(app_staple, final_zip)
        notarizations = [call for call in self.calls if "notarytool" in call and "submit" in call]
        self.assertEqual(len(notarizations), 2)
        self.assertTrue(all("--wait" in call and "--keychain-profile" in call for call in notarizations))
        signatures = [call for call in self.calls if "--sign" in call and not call[-1].endswith(".dmg")]
        self.assertTrue(all("--timestamp" in call and "runtime" in call and "--deep" not in call for call in signatures))
        runtime = json.loads((output / self.app.name / "Contents/Resources/runtime-manifest.json").read_text())
        self.assertEqual(runtime["signing"], "developer-id")
        self.assertNotIn("notarized", runtime)
        self.assertNotIn("distributionReady", runtime)

    def test_invalid_notarization_preserves_id_and_never_staples(self):
        self.notary_status = "Invalid"
        output = self.root / "invalid"
        with patch.object(release, "run", side_effect=self.fake_run), self.assertRaisesRegex(release.ReleaseError, "Invalid"):
            release.release(self.app, output, identity=IDENTITY, notary_profile="test")
        manifest = json.loads((output / "release-manifest.json").read_text())
        report = json.loads((output / "reports/app-notary.json").read_text())
        self.assertFalse(manifest["distributionReady"])
        self.assertEqual(manifest["status"], "failed")
        self.assertEqual(report["id"], SUBMISSION)
        self.assertTrue(report["logDownloaded"])
        self.assertFalse(any("stapler" in call for call in self.calls))
        self.assertFalse((output / "SHA256SUMS.txt").exists())

    def test_in_progress_is_failure_even_with_success_exit(self):
        self.notary_status = "In Progress"
        reports = self.root / "reports"
        reports.mkdir()
        with patch.object(release, "run", side_effect=self.fake_run), self.assertRaisesRegex(release.ReleaseError, "In Progress"):
            release.notarize(self.root / "archive.zip", "test", reports, "app", 30)
        self.assertFalse(json.loads((reports / "app-notary.json").read_text())["accepted"])

    def test_notarization_process_timeout_is_recorded_without_success(self):
        reports = self.root / "reports"
        reports.mkdir()
        with patch.object(release, "run", side_effect=release.ReleaseError("timed out")), self.assertRaises(release.ReleaseError):
            release.notarize(self.root / "archive.zip", "test", reports, "app", 30)
        self.assertEqual(json.loads((reports / "app-notary.json").read_text()), {"status": "Timeout", "accepted": False})

    def test_nonzero_exit_with_accepted_payload_still_fails(self):
        reports = self.root / "reports"
        reports.mkdir()
        response = subprocess.CompletedProcess([], 1, json.dumps({"id": SUBMISSION, "status": "Accepted"}), "")
        with patch.object(release, "run", return_value=response), self.assertRaises(release.ReleaseError):
            release.notarize(self.root / "archive.zip", "test", reports, "app", 30)

    def test_gatekeeper_rejection_prevents_ready_manifest(self):
        self.fail_gatekeeper = True
        output = self.root / "gatekeeper"
        with patch.object(release, "run", side_effect=self.fake_run), self.assertRaisesRegex(release.ReleaseError, "Gatekeeper"):
            release.release(self.app, output, identity=IDENTITY, notary_profile="test")
        self.assertFalse(json.loads((output / "release-manifest.json").read_text())["distributionReady"])

    def test_signature_details_require_runtime_flag_not_runtime_in_path(self):
        details = f"Executable=/runtime/node\nAuthority=Developer ID Application: Example\nTeamIdentifier={TEAM}\nTimestamp=Oct 8\nCodeDirectory flags=0x0(none)\n"
        with patch.object(release, "run", return_value=subprocess.CompletedProcess([], 0, "", details)):
            with self.assertRaises(release.ReleaseError):
                release.verify_developer_signatures([self.node], TEAM)

    def test_missing_helper_blocks_release_before_signing(self):
        self.helper.unlink()
        with patch.object(release, "run", side_effect=self.fake_run), self.assertRaisesRegex(release.ReleaseError, "CodexMemoHelper"):
            release.release(self.app, self.root / "missing-helper", identity=IDENTITY, notary_profile="test")
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / "missing-helper").exists())

    def test_native_smoke_failure_blocks_notarization_and_ready_manifest(self):
        output = self.root / "smoke-failure"
        with patch.object(release, "run", side_effect=self.fake_run), \
             patch.object(release, "smoke_app", side_effect=release.ReleaseError("native helper failed")), \
             self.assertRaisesRegex(release.ReleaseError, "native helper failed"):
            release.release(self.app, output, identity=IDENTITY, notary_profile="test")
        manifest = json.loads((output / "release-manifest.json").read_text())
        self.assertEqual(manifest["status"], "failed")
        self.assertFalse(manifest["distributionReady"])
        self.assertFalse(any("notarytool" in call for call in self.calls))

    def test_native_smoke_requires_success_marker_not_just_zero_exit(self):
        with patch.object(release, "run", return_value=subprocess.CompletedProcess([], 0, "", "")), \
             self.assertRaisesRegex(release.ReleaseError, "IPC"):
            release.smoke_app(self.app / "Contents/MacOS/CodexMemoMenu", self.root)
        self.assertEqual(list(self.root.glob(".smoke-data-*")), [])

    def test_native_smoke_uses_reserved_debug_port_and_temporary_data(self):
        def fake_run(command, **kwargs):
            import socket
            env = kwargs["env"]
            self.assertTrue(Path(env["CODEX_MEMO_DATA"]).is_dir())
            with socket.socket() as probe:
                with self.assertRaises(OSError):
                    probe.bind(("127.0.0.1", int(env["CODEX_MEMO_DEBUG_PORT"])))
            return subprocess.CompletedProcess(command, 0, "NATIVE_APP_SMOKE_OK\n", "")
        with patch.object(release, "run", side_effect=fake_run):
            release.smoke_app(self.app / "Contents/MacOS/CodexMemoMenu", self.root)


if __name__ == "__main__":
    unittest.main()
