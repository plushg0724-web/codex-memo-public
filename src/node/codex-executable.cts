import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';

function isFile(file: string | undefined | null): file is string {
  if (!file) return false;
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** Store updates replace the package directory while the helper can remain open. */
function installedPackageRoots(env: NodeJS.ProcessEnv): string[] {
  if (env.CODEX_MEMO_NO_STORE_CODEX === '1') return [];
  if (process.platform === 'darwin') {
    if (env.CODEX_MEMO_APP) return [env.CODEX_MEMO_APP];
    // A synthetic env must never discover the developer's real installation.
    if (env !== process.env) return [];
    return ['/Applications/Codex.app', '/Applications/ChatGPT.app',
      path.join(os.homedir(), 'Applications/Codex.app'), path.join(os.homedir(), 'Applications/ChatGPT.app')];
  }
  // Hermetic tests set this so a real Store install never leaks into them.
  if (process.platform !== 'win32') return [];
  try {
    const powershell = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      'Get-AppxPackage OpenAI.Codex | Select-Object -ExpandProperty InstallLocation | ConvertTo-Json -Compress'],
    {env, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 16384}).trim();
    const roots: unknown = output ? JSON.parse(output) : [];
    return (Array.isArray(roots) ? roots : [roots]).filter((root): root is string => typeof root === 'string' && path.isAbsolute(root));
  } catch { return []; }
}

/** A package lookup that found nothing is not repeated for this long (it blocks for up to 5 s). */
const MISS_RETRY_MS = 30_000;

/** Revalidate the cached executable on every use; discover again if an update removed it. */
export function createCodexFinder({env = process.env, packageRoots = () => installedPackageRoots(env), now = Date.now}: {
  env?: NodeJS.ProcessEnv; packageRoots?: () => string[]; now?: () => number;
} = {}): () => string | null {
  let cached: string | null = null;
  let missedAt = -Infinity;
  return () => {
    if (isFile(env.CODEX_EXE)) return env.CODEX_EXE;
    if (isFile(cached)) return cached;
    // A cached executable that disappeared (Store update) is looked up again right away.
    if (cached !== null || now() - missedAt >= MISS_RETRY_MS) {
      cached = null;
      for (const root of packageRoots()) {
        for (const relative of ['app/resources/codex.exe', 'Contents/Resources/codex',
          'Contents/Resources/codex-cli/bin/codex', 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex']) {
          const exe = path.join(root, relative);
          if (isFile(exe)) return cached = exe;
        }
      }
      missedAt = now();
    }
    if (!env.LOCALAPPDATA || !path.isAbsolute(env.LOCALAPPDATA)) return null;
    const bin = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    // Recent apps unpack CLI releases into hash folders. Ignore backups and incomplete releases.
    const candidates: {exe: string; modified: number}[] = [];
    try {
      for (const entry of fs.readdirSync(bin, {withFileTypes: true})) {
        if (!entry.isDirectory() || !/^[a-f0-9]{16}$/i.test(entry.name)) continue;
        const exe = path.join(bin, entry.name, 'codex.exe');
        try {
          const stat = fs.statSync(exe);
          if (stat.isFile()) candidates.push({exe, modified: stat.mtimeMs});
        } catch { /* Update cleanup can remove a candidate while we inspect it. */ }
      }
    } catch { /* The local CLI cache is optional. */ }
    candidates.sort((a, b) => b.modified - a.modified || a.exe.localeCompare(b.exe));
    const exe = candidates[0]?.exe || path.join(bin, 'codex.exe');
    return isFile(exe) ? cached = exe : null;
  };
}
