"""Package a built app for macOS. Only explicit --preview skips Apple notarization.

Release: --app APP --output NEW_DIRECTORY --identity NAME_OR_SHA1
         --notary-profile KEYCHAIN_PROFILE
Preview: --app APP --output NEW_DIRECTORY --preview

The input app is never modified. A new output directory is required on every run.
Credentials must already be stored by `xcrun notarytool store-credentials`;
passwords and API keys are deliberately not accepted by this script.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import socket
import subprocess
import sys
import tempfile

MACOS = Path(__file__).resolve().parent
MACHO_MAGICS = {bytes.fromhex(value) for value in (
    "feedface", "cefaedfe", "feedfacf", "cffaedfe",
    "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
)}
UNNOTARIZED_PREVIEW_NOTICE = (
    "이 테스트용 패키지는 Apple Developer ID 서명과 Apple 공증을 받지 않았습니다.\n"
    "지인과 테스트할 때 첫 실행에서 macOS의 추가 확인이 필요할 수 있습니다.\n"
    "출처와 파일을 신뢰하는 경우 앱 실행을 시도한 뒤 시스템 설정 > 개인정보 보호 및 보안 > "
    "그래도 열기에서 확인하세요.\n"
    "Apple 공식 안내: https://support.apple.com/ko-kr/102445\n"
)


class ReleaseError(RuntimeError):
    pass


def run(command, *, check=True, timeout=300, env=None):
    """Never echo a command line or environment, including credential references."""
    try:
        result = subprocess.run([str(arg) for arg in command], capture_output=True,
                                text=True, timeout=timeout, check=False, env=env)
    except subprocess.TimeoutExpired as error:
        raise ReleaseError(f"{Path(command[0]).name} timed out; release is incomplete") from error
    if check and result.returncode:
        detail = (result.stderr or result.stdout or "").strip()[-3000:]
        raise ReleaseError(f"{Path(command[0]).name} failed ({result.returncode}): {detail}")
    return result


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def is_macho(path):
    if path.is_symlink() or not path.is_file():
        return False
    with path.open("rb") as stream:
        return stream.read(4) in MACHO_MAGICS


def validate_app(app):
    if not app.is_dir() or app.suffix != ".app":
        raise ReleaseError("--app must name an existing .app bundle")
    try:
        info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    except (OSError, ValueError) as error:
        raise ReleaseError("App has no valid Contents/Info.plist") from error
    executable = info.get("CFBundleExecutable", "")
    if not executable or Path(executable).name != executable:
        raise ReleaseError("Invalid CFBundleExecutable")
    if not is_macho(app / "Contents/MacOS" / executable):
        raise ReleaseError("Main executable is not Mach-O")
    helpers = [path for path in app.rglob("CodexMemoHelper") if is_macho(path)]
    if len(helpers) != 1:
        raise ReleaseError("Exactly one bundled CodexMemoHelper executable is required")
    for field in ("CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion"):
        if not isinstance(info.get(field), str) or not info[field]:
            raise ReleaseError(f"Missing app metadata: {field}")
    # Re-sign only copied files. Escaping symlinks could otherwise sign an input
    # file or a system library. Internal PyInstaller/framework links are valid.
    for path in app.rglob("*"):
        if path.is_symlink():
            try:
                path.resolve(strict=True).relative_to(app.resolve())
            except (OSError, ValueError, RuntimeError) as error:
                raise ReleaseError(f"Unsafe or broken bundle symlink: {path.relative_to(app)}") from error
    return info


def signing_targets(app):
    """Sign every nested Mach-O, then its containing bundle, inside out."""
    targets = []
    for path in app.rglob("*"):
        if path.is_symlink():
            continue
        if is_macho(path) or (path.is_dir() and path.suffix in (".framework", ".app", ".xpc", ".bundle")):
            targets.append(path)
    targets.sort(key=lambda path: (-len(path.relative_to(app).parts), str(path)))
    return targets + [app]


def resolve_identity(requested):
    result = run(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"])
    identities = re.findall(r'\b([0-9A-Fa-f]{40})\s+"(Developer ID Application: [^"\n]+)"', result.stdout)
    matches = [(fingerprint.upper(), name) for fingerprint, name in identities
               if requested.upper() == fingerprint.upper() or requested == name]
    if len(matches) != 1:
        raise ReleaseError("Exactly one valid Developer ID Application identity must match --identity; "
                           "install the certificate and private key in Keychain first")
    fingerprint, name = matches[0]
    team = re.search(r"\(([A-Z0-9]{10})\)$", name)
    if not team:
        raise ReleaseError("Developer ID Application identity has no valid Team ID")
    return fingerprint, team.group(1)


def entitlement_for(path, app):
    if path == app or path.name == "CodexMemoHelper":
        return MACOS / "entitlements.plist"
    if path.name == "node" and path.is_file():
        return MACOS / "entitlements-node.plist"
    return MACOS / "entitlements-library.plist"


def sign_app(app, identity, *, preview=False):
    targets = signing_targets(app)
    for target in targets:
        command = ["/usr/bin/codesign", "--force", "--sign", identity,
                   "--entitlements", entitlement_for(target, app), "--generate-entitlement-der"]
        if preview:
            command.append("--timestamp=none")
        else:
            command.extend(["--options", "runtime", "--timestamp"])
        run(command + [target])
    verify_app(app, targets)
    return targets


def verify_app(app, targets=None):
    for target in targets or signing_targets(app):
        run(["/usr/bin/codesign", "--verify", "--strict", target])
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app])


def verify_developer_signatures(targets, team):
    """Do not trust a successful signing exit alone, or a preserved ad-hoc signature."""
    for target in targets:
        result = run(["/usr/bin/codesign", "--display", "--verbose=4", target])
        details = result.stderr + result.stdout
        required = (r"(?m)^Authority=Developer ID Application:",
                    rf"(?m)^TeamIdentifier={re.escape(team)}$",
                    r"(?m)^Timestamp=(?!none\b|not set\b).+", r"flags=0x[0-9a-fA-F]+\([^)]*\bruntime\b")
        if not all(re.search(value, details) for value in required):
            raise ReleaseError(f"Developer ID / timestamp / hardened runtime verification failed: {target.name}")


def zip_app(app, destination):
    run(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, destination])


def notarize(artifact, profile, reports, label, timeout_seconds):
    """Accepted is the only successful terminal state. Preserve the submission ID."""
    command = ["/usr/bin/xcrun", "notarytool", "submit", artifact,
               "--keychain-profile", profile, "--wait", "--timeout", f"{timeout_seconds}s",
               "--output-format", "json"]
    try:
        result = run(command, check=False, timeout=timeout_seconds + 120)
    except ReleaseError:
        write_json(reports / f"{label}-notary.json", {"status": "Timeout", "accepted": False})
        raise
    try:
        response = json.loads(result.stdout)
        if not isinstance(response, dict):
            raise ValueError("Expected object")
    except (ValueError, TypeError):
        response = {}
    submission = response.get("id")
    status = response.get("status", "Unknown")
    report = {"id": submission, "status": status, "accepted": False, "exitCode": result.returncode}
    write_json(reports / f"{label}-notary.json", report)
    # UUID validation also prevents an untrusted response from becoming a flag.
    if isinstance(submission, str) and re.fullmatch(r"[0-9a-fA-F-]{36}", submission) and status in ("Accepted", "Invalid", "Rejected"):
        log = run(["/usr/bin/xcrun", "notarytool", "log", submission,
                   "--keychain-profile", profile, reports / f"{label}-notary-log.json"], check=False)
        report["logDownloaded"] = log.returncode == 0 and (reports / f"{label}-notary-log.json").is_file()
    if result.returncode != 0 or status != "Accepted" or not submission:
        write_json(reports / f"{label}-notary.json", report)
        raise ReleaseError(f"{label} notarization did not finish Accepted (status={status}, "
                           f"exit={result.returncode}); inspect reports before retrying")
    # Accepted without a downloadable log is incomplete: Apple's warnings still
    # need to be available to the release operator.
    if not report.get("logDownloaded"):
        raise ReleaseError(f"{label} notarization log could not be saved; release is incomplete")
    report["accepted"] = True
    write_json(reports / f"{label}-notary.json", report)
    return report


def staple_and_validate(path):
    run(["/usr/bin/xcrun", "stapler", "staple", path])
    run(["/usr/bin/xcrun", "stapler", "validate", path])


def package_dmg(app, destination, scratch, *, preview):
    volume = scratch / "volume"
    volume.mkdir()
    run(["/usr/bin/ditto", app, volume / app.name])
    (volume / "Applications").symlink_to("/Applications")
    instructions = "Codex 메모.app을 Applications 폴더로 드래그하세요.\n"
    if preview:
        instructions += "\n" + UNNOTARIZED_PREVIEW_NOTICE
    (volume / "설치 안내.txt").write_text(instructions, encoding="utf-8")
    run(["/usr/bin/hdiutil", "create", "-volname", "Codex Memo Preview" if preview else "Codex Memo",
         "-srcfolder", volume, "-format", "UDZO", "-fs", "HFS+", destination])
    run(["/usr/bin/hdiutil", "verify", destination])


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def smoke_app(main, output):
    """Exercise the signed native app, frozen helper and Node IPC with fresh data."""
    with tempfile.TemporaryDirectory(prefix=".smoke-data-", dir=output) as data, socket.socket() as debug_port:
        environment = os.environ.copy()
        for key in ("CODEX_MEMO_APP", "CODEX_MEMO_DEBUG_PORT", "CODEX_MEMO_NODE", "CODEX_EXE"):
            environment.pop(key, None)
        environment["CODEX_MEMO_DATA"] = data
        # Reserve an unused port without listening: never attach to a user's
        # existing debug-enabled host while validating a distribution package.
        debug_port.bind(("127.0.0.1", 0))
        environment["CODEX_MEMO_DEBUG_PORT"] = str(debug_port.getsockname()[1])
        result = run([main, "--smoke-test"], timeout=30, env=environment)
        if "NATIVE_APP_SMOKE_OK" not in result.stdout:
            raise ReleaseError("Native app smoke test did not confirm helper/Node IPC")


def release(app, output, *, preview=False, identity=None, notary_profile=None, notary_timeout=1200):
    if sys.platform != "darwin":
        raise ReleaseError("Release packaging requires macOS")
    if preview and (identity or notary_profile):
        raise ReleaseError("--preview cannot be combined with signing credentials")
    if not preview and (not identity or not notary_profile):
        raise ReleaseError("A release requires --identity and --notary-profile; use --preview for unnotarized testing")
    if not isinstance(notary_timeout, int) or not 1 <= notary_timeout <= 86400:
        raise ReleaseError("--notary-timeout must be 1–86400 seconds")
    app, output = Path(app).resolve(), Path(output).resolve()
    info = validate_app(app)
    if output == app or app in output.parents:
        raise ReleaseError("Output must be outside the source app")
    if output.exists():
        raise ReleaseError("Output already exists; choose a new directory (nothing was removed)")
    # Resolve the identity before creating any output. Never silently fall back.
    signer, team = ("-", None) if preview else resolve_identity(identity)
    output.mkdir(parents=True, exist_ok=False)
    reports = output / "reports"
    reports.mkdir()
    manifest_path = output / "release-manifest.json"
    manifest = {"schemaVersion": 1, "mode": "preview" if preview else "release",
                "status": "incomplete", "distributionReady": False,
                "distributionReadyCriteria": "developer-id-notarization-gatekeeper",
                "version": info["CFBundleShortVersionString"], "build": info["CFBundleVersion"],
                "bundleIdentifier": info["CFBundleIdentifier"], "app": app.name,
                "minimumSystemVersion": info.get("LSMinimumSystemVersion"),
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "signing": {"kind": "ad-hoc" if preview else "Developer ID Application",
                            "hardenedRuntime": not preview, "secureTimestamp": not preview},
                "notarization": {}, "gatekeeper": "not-assessed", "artifacts": []}
    write_json(manifest_path, manifest)
    try:
        staged_app = output / app.name
        run(["/usr/bin/ditto", app, staged_app])
        validate_app(staged_app)
        runtime_manifest = staged_app / "Contents/Resources/runtime-manifest.json"
        if runtime_manifest.exists():
            runtime = json.loads(runtime_manifest.read_text(encoding="utf-8"))
            runtime["signing"] = "ad-hoc-development" if preview else "developer-id"
            runtime.pop("notarized", None)
            runtime.pop("distributionReady", None)
            runtime["distributionStatusSource"] = "release-manifest.json alongside the distribution archives"
            write_json(runtime_manifest, runtime)
        main = staged_app / "Contents/MacOS" / info["CFBundleExecutable"]
        architecture = run(["/usr/bin/lipo", "-archs", main]).stdout.strip().split()
        if not architecture or any(arch not in ("arm64", "x86_64") for arch in architecture):
            raise ReleaseError("Unsupported or missing application architecture")
        arch_name = "universal2" if len(set(architecture)) == 2 else architecture[0]
        manifest["architecture"] = arch_name
        version = re.sub(r"[^A-Za-z0-9.-]", "_", info["CFBundleShortVersionString"])
        build = re.sub(r"[^A-Za-z0-9.-]", "_", info["CFBundleVersion"])
        stem = f"CodexMemo-{version}-{build}-macOS-{arch_name}" + ("-preview" if preview else "")
        targets = sign_app(staged_app, signer, preview=preview)
        manifest["signing"]["nestedTargets"] = len(targets) - 1
        if not preview:
            verify_developer_signatures(targets, team)
        nodes = [path for path in targets if path.is_file() and path.name == "node"]
        if len(nodes) != 1:
            raise ReleaseError("Exactly one bundled Node runtime is required")
        run([nodes[0], "-e", "const f = new Function('x', 'return x + 1'); let n=0; for(let i=0;i<100000;i++)n=f(n); if(n!==100000)process.exit(1)"], timeout=30)
        smoke_app(main, output)
        manifest["runtimeSmokeTest"] = "passed-native-helper-node-ipc"
        with tempfile.TemporaryDirectory(prefix=".release-work-", dir=output) as work:
            scratch = Path(work)
            if not preview:
                upload = scratch / "app-for-notarization.zip"
                zip_app(staged_app, upload)
                manifest["notarization"]["app"] = notarize(upload, notary_profile, reports, "app", notary_timeout)
                staple_and_validate(staged_app)
                verify_app(staged_app, targets)
                run(["/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=4", staged_app])
                write_json(manifest_path, manifest)
            archive = output / f"{stem}.zip"
            zip_app(staged_app, archive)  # ZIP contains the stapled app in release mode.
            dmg = output / f"{stem}.dmg"
            package_dmg(staged_app, dmg, scratch, preview=preview)
            if not preview:
                run(["/usr/bin/codesign", "--force", "--sign", signer, "--timestamp", dmg])
                run(["/usr/bin/codesign", "--verify", "--strict", dmg])
                manifest["notarization"]["dmg"] = notarize(dmg, notary_profile, reports, "dmg", notary_timeout)
                staple_and_validate(dmg)
                run(["/usr/bin/codesign", "--verify", "--strict", dmg])
                run(["/usr/sbin/spctl", "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmg])
                manifest["gatekeeper"] = "accepted-app-and-dmg"
            manifest["artifacts"] = [{"file": path.name, "sha256": sha256(path), "bytes": path.stat().st_size}
                                     for path in (archive, dmg)]
        checksums = "".join(f"{item['sha256']}  {item['file']}\n" for item in manifest["artifacts"])
        (output / "SHA256SUMS.txt").write_text(checksums, encoding="utf-8")
        manifest["status"] = "preview-unnotarized" if preview else "ready"
        manifest["distributionReady"] = not preview
        if preview:
            manifest["notarization"] = {"status": "not-submitted"}
            (output / "UNNOTARIZED-PREVIEW.txt").write_text(UNNOTARIZED_PREVIEW_NOTICE, encoding="utf-8")
        write_json(manifest_path, manifest)
    except Exception as error:
        manifest["status"] = "failed"
        manifest["distributionReady"] = False
        manifest["error"] = str(error)
        write_json(manifest_path, manifest)
        raise
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--app", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--preview", action="store_true", help="Explicit ad-hoc, unnotarized preview for testing")
    parser.add_argument("--identity", help="Exact Developer ID Application name or SHA-1 fingerprint")
    parser.add_argument("--notary-profile", help="Existing notarytool Keychain profile name")
    parser.add_argument("--notary-timeout", type=int, default=1200, help="Maximum notarization wait in seconds per submission")
    args = parser.parse_args(argv)
    try:
        result = release(args.app, args.output, preview=args.preview, identity=args.identity,
                         notary_profile=args.notary_profile, notary_timeout=args.notary_timeout)
    except (OSError, ReleaseError, ValueError) as error:
        print(f"Release incomplete: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"status": result["status"], "distributionReady": result["distributionReady"],
                      "output": str(args.output.resolve())}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
