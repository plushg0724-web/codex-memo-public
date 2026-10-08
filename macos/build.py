"""Build the standalone macOS app; use release.py for distribution signing."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
NODE_VERSION = "v24.21.0"
NODE_SHA256 = {
    "arm64": "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
    "x64": "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
}


def configuration(root=ROOT):
    config = json.loads((root / "macos/release-config.json").read_text())
    for key in ("version", "minimumSystemVersion"):
        if not re.fullmatch(r"\d+\.\d+(?:\.\d+)?", config[key]):
            raise ValueError(f"Invalid {key}")
    if not re.fullmatch(r"\d+", config["build"]):
        raise ValueError("Build must be a positive integer string")
    if not re.fullmatch(r"[A-Za-z0-9.-]+", config["bundleIdentifier"]):
        raise ValueError("Invalid bundle identifier")
    if not re.fullmatch(r"[A-Za-z0-9.-]+", config["release"]):
        raise ValueError("Invalid release name")
    return config


def stage_runtime(destination, root=ROOT):
    """Explicit assets only: never ship local settings, memos, or source maps."""
    for file in sorted((root / "labels").rglob("*")):
        if file.is_file() and (file.suffix in {".js", ".cjs"} or file.name in {"default-labels.json", "SOURCE_COMMIT.txt"}):
            if file.is_symlink():
                raise ValueError(f"Runtime assets must not be symlinks: {file}")
            target = destination / file.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, target)
    for file in sorted((root / "dist/node").glob("*.cjs")):
        target = destination / "dist/node" / file.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, target)
    for name in ("VERSION", "inject.js", "version-badge.js"):
        shutil.copy2(root / name, destination / name)
    for name in ("labels/backend.cjs", "labels/default-labels.json", "dist/node/backend.cjs"):
        if not (destination / name).is_file():
            raise RuntimeError(f"Missing runtime asset: {name}; run npm run build")


def verify_dependencies():
    expected = {"websocket-client": "1.9.2", "pyinstaller": "6.22.3"}
    for package, version in expected.items():
        actual = importlib.metadata.version(package)
        if actual != version:
            raise RuntimeError(f"Install macos/requirements-build.txt: {package} {actual} != {version}")
    return {package: importlib.metadata.version(package) for package in expected}


def build(destination, cache):
    if sys.platform != "darwin":
        raise RuntimeError("Build on macOS")
    if destination.suffix != ".app" or destination.exists() or destination.is_symlink():
        raise FileExistsError(f"Choose a new .app output path: {destination}")
    dependencies = verify_dependencies()
    config = configuration()
    machine = platform.machine()
    if machine not in {"arm64", "x86_64"}:
        raise RuntimeError(f"Unsupported build architecture: {machine}")
    architecture = "arm64" if machine == "arm64" else "x64"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / f"node-{NODE_VERSION}-darwin-{architecture}.tar.gz"
    if not archive.exists():
        download = archive.with_suffix(".download")
        subprocess.run(["/usr/bin/curl", "--fail", "--location", "--silent", "--show-error",
                        f"https://nodejs.org/dist/{NODE_VERSION}/{archive.name}", "-o", str(download)], check=True)
        download.replace(archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != NODE_SHA256[architecture]:
        raise RuntimeError("Node runtime checksum mismatch")
    subprocess.run(["npm", "run", "check"], cwd=ROOT, check=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="memo-build-", dir=cache) as temporary:
        staging = Path(temporary)
        with tarfile.open(archive) as packed:
            packed.extractall(staging, filter="data")
        node_root = staging / f"node-{NODE_VERSION}-darwin-{architecture}"
        assets = staging / "assets"
        assets.mkdir()
        stage_runtime(assets)
        frozen = cache / f"frozen-{architecture}"
        command = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--name", "CodexMemoHelper",
                   "--onedir", "--paths", str(ROOT), "--distpath", str(frozen), "--workpath", str(cache / f"pyinstaller-{architecture}"),
                   "--specpath", str(cache), "--add-data", f"{assets}:.", str(ROOT / "macos/helper.py")]
        subprocess.run(command, cwd=ROOT, check=True)
        with tempfile.TemporaryDirectory(prefix=".codex-memo-", dir=destination.parent) as app_staging:
            app = Path(app_staging) / destination.name
            contents = app / "Contents"
            resources = contents / "Resources"
            (contents / "MacOS").mkdir(parents=True)
            resources.mkdir()
            shutil.copytree(frozen / "CodexMemoHelper", resources / "runtime/CodexMemoHelper", symlinks=True)
            (resources / "node/bin").mkdir(parents=True)
            shutil.copy2(node_root / "bin/node", resources / "node/bin/node")
            shutil.copy2(node_root / "LICENSE", resources / "node/LICENSE")
            shutil.copytree(ROOT / "macos/licenses", resources / "Licenses")
            shutil.copy2(ROOT / "macos/THIRD_PARTY_NOTICES.txt", resources / "THIRD_PARTY_NOTICES.txt")
            shutil.copy2(ROOT / "LICENSE", resources / "LICENSE")
            info = {"CFBundleIdentifier": config["bundleIdentifier"], "CFBundleName": config["displayName"],
                    "CFBundleDisplayName": config["displayName"], "CFBundleExecutable": "CodexMemoMenu",
                    "CFBundlePackageType": "APPL", "CFBundleShortVersionString": config["version"],
                    "CFBundleVersion": config["build"], "LSUIElement": True, "LSMinimumSystemVersion": config["minimumSystemVersion"],
                    "CFBundleIconFile": "CodexMemo", "NSHighResolutionCapable": True,
                    "NSAppleEventsUsageDescription": "확인하신 메모 모드 재시작을 위해 Codex 앱을 정상 종료합니다."}
            (contents / "Info.plist").write_bytes(plistlib.dumps(info))
            iconset = staging / "CodexMemo.iconset"
            icon_tool = staging / "icon-tool"
            subprocess.run(["xcrun", "swiftc", str(ROOT / "macos/Icon.swift"), "-o", str(icon_tool), "-framework", "AppKit"], check=True)
            subprocess.run([str(icon_tool), str(iconset)], check=True)
            subprocess.run(["/usr/bin/iconutil", "-c", "icns", str(iconset), "-o", str(resources / "CodexMemo.icns")], check=True)
            subprocess.run(["xcrun", "swiftc", "-O", "-target", f"{machine}-apple-macos{config['minimumSystemVersion']}",
                            str(ROOT / "macos/MenuApp.swift"), "-o", str(contents / "MacOS/CodexMemoMenu"),
                            "-framework", "AppKit"], check=True)
            manifest = {"source": "plushg0724-web/codex-memo-public", "release": config["release"], "build": config["build"],
                        "architecture": architecture, "minimumSystemVersion": config["minimumSystemVersion"],
                        "node": NODE_VERSION, "nodeSha256": NODE_SHA256[architecture], "python": platform.python_version(),
                        "pythonPackages": dependencies, "signing": "ad-hoc-development", "notarized": False,
                        "distributionReady": False}
            (resources / "runtime-manifest.json").write_text(json.dumps(manifest, indent=2))
            subprocess.run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", str(app)], check=True)
            subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)], check=True)
            app.rename(destination)
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=ROOT / "macos/build")
    args = parser.parse_args()
    print(build(args.output.resolve(), args.cache.resolve()))
