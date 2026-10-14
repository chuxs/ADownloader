import { BROWSER_USER_AGENT } from '../engine/constants.js';
import { statusError, toDownloadError } from '../engine/errors.js';

/**
 * Minimal scripted browser for plugins: keeps cookies across requests and
 * redirects, sends browser-like headers, and returns pages as text.
 */
export class Browser {
  /** @type {Map<string, Map<string, string>>} host -> cookie name -> value */
  #cookies = new Map();
  #signal;
  #headers;
  timeoutMs;

  /** @param {{signal?: AbortSignal, headers?: Record<string,string>, timeoutMs?: number}} [opts] */
  constructor(opts = {}) {
    this.#signal = opts.signal;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.#headers = {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...opts.headers,
    };
  }

  /** @returns {Promise<Page>} */
  get(url, opts = {}) {
    return this.request(url, { ...opts, method: 'GET' });
  }

  /** POST a form (object) or a raw body (string). */
  post(url, body, opts = {}) {
    const isForm = body && typeof body === 'object';
    return this.request(url, {
      ...opts,
      method: 'POST',
      body: isForm ? new URLSearchParams(body).toString() : body,
      headers: { ...(isForm ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...opts.headers },
    });
  }

  /**
   * @param {string} url
   * @param {{method?: string, body?: string, headers?: Record<string,string>,
   *          allowErrors?: boolean, maxRedirects?: number}} [opts]
   *        allowErrors: return 4xx/5xx pages instead of throwing
   * @returns {Promise<Page>}
   */
  async request(url, opts = {}) {
    let method = opts.method ?? 'GET';
    let body = opts.body;
    let current = url;
    const signal = this.#signal
      ? AbortSignal.any([this.#signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);

    try {
      for (let hop = 0; hop <= (opts.maxRedirects ?? 10); hop++) {
        const headers = { ...this.#headers, ...opts.headers };
        const cookie = this.cookieHeader(current);
        if (cookie) headers.Cookie = cookie;
        const res = await fetch(current, { method, body, headers, signal, redirect: 'manual' });
        this.#storeCookies(current, res.headers.getSetCookie?.() ?? []);

        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel().catch(() => {});
          current = new URL(location, current).href;
          if (res.status !== 307 && res.status !== 308) {
            method = 'GET';
            body = undefined;
          }
          continue;
        }

        if (!res.ok && !opts.allowErrors) {
          await res.body?.cancel().catch(() => {});
          throw statusError(res);
        }
        return new Page(current, res.status, res.headers, await res.text());
      }
      throw new Error(`Too many redirects for ${url}`);
    } catch (err) {
      throw toDownloadError(err);
    }
  }

  /** Cookie header value for a URL, or '' if none. */
  cookieHeader(url) {
    const host = new URL(url).hostname;
    const parts = [];
    for (const [domain, jar] of this.#cookies) {
      if (host === domain || host.endsWith(`.${domain}`)) {
        for (const [k, v] of jar) parts.push(`${k}=${v}`);
      }
    }
    return parts.join('; ');
  }

  setCookie(domain, name, value) {
    const d = domain.replace(/^\./, '');
    if (!this.#cookies.has(d)) this.#cookies.set(d, new Map());
    this.#cookies.get(d).set(name, value);
  }

  #storeCookies(url, setCookies) {
    const host = new URL(url).hostname;
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const domainAttr = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a));
      const domain = domainAttr ? domainAttr.slice(7) : host;
      const expired = attrs.some((a) => /^\s*max-age=\s*(0|-)/i.test(a));
      if (expired) this.#cookies.get(domain.replace(/^\./, ''))?.delete(name);
      else this.setCookie(domain, name, value);
    }
  }
}

export class Page {
  constructor(url, status, headers, text) {
    /** final URL after redirects */
    this.url = url;
    this.status = status;
    this.headers = headers;
    this.text = text;
  }

  json() {
    return JSON.parse(this.text);
  }

  /** First capture group of `re` in the page, or null. */
  match(re) {
    const m = re.exec(this.text);
    return m ? (m[1] ?? m[0]) : null;
  }

  contains(s) {
    return this.text.includes(s);
  }
}
