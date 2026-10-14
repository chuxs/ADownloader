import { execFile, spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

/** Run a program and collect its output. Rejects on a non-zero exit code. */
export function run(file, args, { timeoutMs = 60_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, signal, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else resolve({ stdout, stderr });
      },
    );
  });
}

/** Start a long-running program; the caller reads its output streams. */
export function start(file, args, opts = {}) {
  return spawn(file, args, { windowsHide: true, ...opts });
}

/**
 * Stop a process and everything it started. On Windows a plain kill() leaves
 * children (e.g. ffmpeg started by yt-dlp) running, so use taskkill /T.
 */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (IS_WIN) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    child.kill('SIGTERM');
  }
}

/** Full path of an executable on PATH, or null. */
export async function which(name) {
  const exts = IS_WIN ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, IS_WIN && !name.toLowerCase().endsWith(ext.toLowerCase()) ? name + ext : name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export async function isExecutable(file) {
  try {
    await access(file, IS_WIN ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
