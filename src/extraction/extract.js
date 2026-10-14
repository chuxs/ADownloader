import { mkdir } from 'node:fs/promises';

import { killTree, start } from '../tools/process.js';

export class ExtractError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // WRONG_PASSWORD | NO_TOOL | FAILED | ABORTED
  }
}

/**
 * Extract one archive with 7-Zip (all formats, passwords, multi-part) or,
 * without 7-Zip, the system's tar (zip/7z/rar single files, no passwords).
 * Tries each password in turn ('' = none).
 *
 * @param {{sevenZip?: string|null, tar?: string|null}} tools
 * @param {{archive: string, destination: string, passwords?: string[],
 *          onProgress?: (percent: number) => void, signal?: AbortSignal}} opts
 * @returns {Promise<{password: string}>} the password that worked
 */
export async function extractArchive(tools, { archive, destination, passwords = [], onProgress, signal }) {
  await mkdir(destination, { recursive: true });
  if (tools.sevenZip) {
    const tries = ['', ...passwords.filter(Boolean)];
    for (const password of tries) {
      try {
        await run7z(tools.sevenZip, archive, destination, password, onProgress, signal);
        return { password };
      } catch (err) {
        if (err.code !== 'WRONG_PASSWORD') throw err;
      }
    }
    throw new ExtractError(
      'WRONG_PASSWORD',
      passwords.length ? 'None of the saved passwords worked' : 'Password protected: add the password in Settings',
    );
  }
  if (tools.tar) {
    await runTar(tools.tar, archive, destination, signal);
    onProgress?.(100);
    return { password: '' };
  }
  throw new ExtractError('NO_TOOL', 'Install 7-Zip to extract archives');
}

function run7z(sevenZip, archive, destination, password, onProgress, signal) {
  // -p always given so 7-Zip never waits for a password on the console.
  // -bsp1: progress to stdout, -bso0: no file listing, -bse2: errors to stderr
  const args = ['x', '-y', '-bsp1', '-bso0', '-bse2', `-o${destination}`, `-p${password}`, archive];
  return new Promise((resolve, reject) => {
    const child = start(sevenZip, args);
    let errors = '';
    child.stdout.on('data', (d) => {
      // Progress is redrawn with backspaces: take the last percentage.
      const all = [...String(d).matchAll(/(\d{1,3})%/g)];
      if (all.length) onProgress?.(Number(all.at(-1)[1]));
    });
    child.stderr.on('data', (d) => (errors += d));
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => reject(new ExtractError('NO_TOOL', `Could not run 7-Zip: ${err.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new ExtractError('ABORTED', 'Stopped'));
      if (code === 0 || code === 1) return resolve(); // 1 = warnings only
      if (/wrong password|encrypted/i.test(errors)) return reject(new ExtractError('WRONG_PASSWORD', 'Wrong password'));
      const reason =
        errors
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => /^(ERROR|Can ?not|Unexpected end|Data Error|Missing volume)/i.test(l)) ?? `7-Zip exit code ${code}`;
      reject(new ExtractError('FAILED', reason.replace(/^ERROR:\s*/i, '')));
    });
  });
}

function runTar(tar, archive, destination, signal) {
  return new Promise((resolve, reject) => {
    const child = start(tar, ['-xf', archive, '-C', destination]);
    let errors = '';
    child.stderr.on('data', (d) => (errors += d));
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => reject(new ExtractError('NO_TOOL', `Could not run tar: ${err.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new ExtractError('ABORTED', 'Stopped'));
      else if (code === 0) resolve();
      else if (/passphrase|encrypt/i.test(errors)) reject(new ExtractError('WRONG_PASSWORD', 'Password protected: install 7-Zip'));
      else reject(new ExtractError('FAILED', errors.trim().split('\n').at(-1) || `tar exit code ${code}`));
    });
  });
}
