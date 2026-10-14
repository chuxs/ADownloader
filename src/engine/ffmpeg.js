import { stat } from 'node:fs/promises';

import { start, killTree } from '../tools/process.js';
import { DownloadError } from './errors.js';

/**
 * Save one frame of a video (or a scaled copy of an image) as a small JPEG.
 * Takes the frame a few seconds in to skip black intros; falls back to the
 * first frame for very short videos.
 */
export async function makeThumbnail(ffmpeg, input, output, { width = 320 } = {}) {
  const grab = (seek) =>
    new Promise((resolve, reject) => {
      const args = ['-y', '-hide_banner', '-loglevel', 'error'];
      if (seek) args.push('-ss', String(seek));
      args.push('-i', input, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', '4', '-f', 'image2', output);
      const child = start(ffmpeg, args);
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `ffmpeg exit ${code}`))));
    });
  for (const seek of [5, 0]) {
    try {
      await grab(seek);
      if ((await stat(output)).size > 0) return;
    } catch {
      // try the next position
    }
  }
  throw new Error('Could not make a thumbnail');
}

/**
 * Copy video (and optionally a separate audio track) into an .mp4 without
 * re-encoding. Fast: only the container changes.
 * @param {string} ffmpeg path to the ffmpeg executable
 * @param {{video: string, audio?: string, output: string, signal?: AbortSignal}} opts
 */
export function remuxToMp4(ffmpeg, { video, audio, output, signal }) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', video];
  if (audio) args.push('-i', audio, '-map', '0:v:0', '-map', '1:a:0');
  else args.push('-map', '0:v?', '-map', '0:a?'); // skip data streams mp4 can't hold
  args.push('-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output);

  return new Promise((resolve, reject) => {
    const child = start(ffmpeg, args);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => reject(new DownloadError('FFMPEG', `Could not run ffmpeg: ${err.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new DownloadError('ABORTED', 'Aborted'));
      else if (code === 0) resolve();
      else reject(new DownloadError('FFMPEG', `ffmpeg failed: ${stderr.trim().split('\n').at(-1) || `exit ${code}`}`));
    });
  });
}
