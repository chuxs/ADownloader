export class DownloadError extends Error {
  /**
   * @param {string} code machine-readable reason, e.g. HTTP_STATUS, NETWORK, TIMEOUT
   * @param {string} message
   * @param {{retryable?: boolean, status?: number, retryAfterMs?: number, cause?: unknown}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, { cause: opts.cause });
    this.name = 'DownloadError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Convert anything thrown by fetch/fs into a DownloadError. */
export function toDownloadError(err) {
  if (err instanceof DownloadError) return err;
  if (err?.name === 'AbortError') return new DownloadError('ABORTED', 'Aborted', { cause: err });
  if (err?.name === 'TimeoutError') {
    return new DownloadError('TIMEOUT', 'Connection timed out', { retryable: true, cause: err });
  }
  // fetch() reports network failures as TypeError with the socket error in `cause`.
  const code = err?.cause?.code ?? err?.code;
  if (err instanceof TypeError || /^E(CONN|NOTFOUND|AI_|PIPE|TIMEDOUT|HOSTUNREACH|NETUNREACH)/.test(code ?? '')) {
    return new DownloadError('NETWORK', `Network error: ${code ?? err.message}`, { retryable: true, cause: err });
  }
  if (code === 'ENOSPC') return new DownloadError('DISK_FULL', 'Not enough disk space', { cause: err });
  return new DownloadError('UNKNOWN', err?.message ?? String(err), { cause: err });
}

export function statusError(res) {
  const status = res.status;
  const retryable = status === 408 || status === 429 || status >= 500;
  let retryAfterMs;
  const ra = res.headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    retryAfterMs = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(ra) - Date.now()) || undefined;
  }
  return new DownloadError('HTTP_STATUS', `Server responded ${status} ${res.statusText}`.trim(), {
    retryable,
    status,
    retryAfterMs,
  });
}
