"""macOS adapter tests with fake app bundles and mocked lifecycle commands."""
import importlib.util
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import codex_app_macos as app


class MacAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="memo-mac-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / "ChatGPT Test.app"
        macos = self.bundle / "Contents/MacOS"
        macos.mkdir(parents=True)
        self.exe = macos / "ChatGPT"
        self.exe.write_text("fixture")
        info = {"CFBundleExecutable": "ChatGPT", "CFBundleIdentifier": "example.memo.fixture"}
        (self.bundle / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
        self.cli = self.bundle / app.CLI_LOCATIONS[1]
        self.cli.parent.mkdir(parents=True)
        self.cli.write_text("fixture")
        self.cli.chmod(0o755)
        env = patch.dict(os.environ, {"CODEX_MEMO_APP": str(self.bundle)}, clear=True)
        env.start(); self.addCleanup(env.stop)

    def test_discovers_unified_app_with_spaces_and_bundled_cli(self):
        self.assertEqual(app.find_app()["exe"], str(self.exe))
        self.assertEqual(app.codex_cli_path(), str(self.cli))

    def test_rejects_unrelated_or_partial_bundles(self):
        self.cli.unlink()
        with self.assertRaises(FileNotFoundError): app.find_app()

    def test_exact_main_process_only_no_helpers_or_account_switcher(self):
        output = f"15 {self.exe}\n16 {self.exe} Helper\n17 /Applications/Codex Account Switcher.app/Contents/MacOS/Switcher\n"
        with patch.object(app.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output)):
            self.assertEqual(app.codex_pids(), [15])

    def test_launch_uses_argument_array_and_loopback_port(self):
        with patch.object(app, "codex_pids", return_value=[]), patch.object(app, "debug_port_alive", return_value=True), patch.object(app.subprocess, "run") as run:
            app.launch_codex()
        args = run.call_args.args[0]
        self.assertEqual(args[:3], ["/usr/bin/open", "-a", str(self.bundle)])
        self.assertIn("--remote-debugging-address=127.0.0.1", args)

    def test_running_plain_app_requires_explicit_restart(self):
        with patch.object(app, "codex_pids", return_value=[15]), patch.object(app, "debug_port_alive", return_value=False), patch.object(app.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "일반 모드"): app.launch_codex()
            run.assert_not_called()

    def test_close_never_force_kills_when_graceful_quit_fails(self):
        with patch.object(app, "codex_pids", return_value=[15]), patch.object(app.time, "monotonic", side_effect=[0, 9]), patch.object(app.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "종료되지"): app.close_codex()
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][0], "/usr/bin/osascript")

    def test_data_path_and_explicit_override(self):
        filename = Path(__file__).resolve().parent.parent / "paths.py"
        def read_paths():
            spec = importlib.util.spec_from_file_location("mac_test_paths", filename)
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            return module.DATA_DIR
        with patch.object(sys, "platform", "darwin"), patch.dict(os.environ, {"HOME": str(self.root)}, clear=True):
            self.assertEqual(read_paths(), str(self.root / "Library/Application Support/CodexMemo"))
            with patch.dict(os.environ, {"CODEX_MEMO_DATA": str(self.root / "custom")}):
                self.assertEqual(read_paths(), str(self.root / "custom"))


if __name__ == "__main__": unittest.main()
