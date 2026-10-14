import { DownloadError } from '../engine/errors.js';

/**
 * Errors thrown by plugins. Codes the app understands:
 * - OFFLINE        file was deleted / does not exist (not retried)
 * - UNSUPPORTED    the page has nothing we can download (not retried)
 * - ACCOUNT_REQUIRED  only downloadable with a (premium) account (not retried)
 * - WAIT           host asks to wait before the next download (retried; pass retryAfterMs)
 * - TEMPORARY      host or network problem (retried)
 * - PLUGIN_DEFECT  the site changed and the plugin needs updating (not retried)
 */
export class PluginError extends DownloadError {
  constructor(code, message, opts = {}) {
    const retryable = opts.retryable ?? (code === 'WAIT' || code === 'TEMPORARY');
    super(code, message, { ...opts, retryable });
    this.name = 'PluginError';
  }
}
