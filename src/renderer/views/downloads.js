import { h, setText, syncList, toggleClass } from '../lib/dom.js';
import { bytes, duration, percent, size as fmtSize, speed } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { ask, call, contextMenu, Selection, setThumb, thumbSlot } from '../lib/ui.js';

/** The Downloads tab: packages and their files, with live progress. */
export class DownloadsView {
  #list = document.getElementById('list-downloads');
  #empty = document.getElementById('empty-downloads');
  #collapsed = new Set();
  #packages = [];
  #rows = [];
  #selection = new Selection(
    () => this.#rows.map((r) => r.key),
    () => {
      this.#paintSelection();
      window.dispatchEvent(new Event('adl:selection'));
    },
  );

  constructor() {
    this.#list.addEventListener('keydown', (e) => this.#onKey(e));
    this.#list.addEventListener('mousedown', (e) => {
      if (e.target === this.#list) this.#selection.clear();
    });
  }

  /** @param {object} state snapshot from the main process */
  render(state) {
    this.#packages = state.downloads;
    this.#rows = [];
    for (const pkg of state.downloads) {
      this.#rows.push({ key: `p:${pkg.id}`, kind: 'pkg', pkg });
      if (!this.#collapsed.has(pkg.id)) {
        for (const link of pkg.links) this.#rows.push({ key: `l:${link.id}`, kind: 'link', link, pkg });
      }
    }
    this.#selection.prune(new Set(this.#rows.map((r) => r.key)));
    toggleClass(this.#empty, 'show', state.downloads.length === 0);
    this.#list.hidden = state.downloads.length === 0;

    syncList(this.#list, this.#rows, {
      key: (r) => r.key,
      create: (r) => this.#createRow(r),
      update: (el, r) => (r.kind === 'pkg' ? this.#updatePackage(el, r.pkg) : this.#updateLink(el, r.link)),
    });
    this.#paintSelection();
  }

  /** Link ids for the selected rows (a selected package means all its links). */
  selectedLinkIds() {
    const ids = new Set();
    for (const key of this.#selection.keys) {
      const [kind, id] = key.split(':');
      if (kind === 'l') ids.add(id);
      else this.#packages.find((p) => p.id === id)?.links.forEach((l) => ids.add(l.id));
    }
    return [...ids];
  }

  get allSelected() {
    return this.#selection.allSelected;
  }

  toggleSelectAll() {
    this.#selection.toggleAll();
    this.#list.focus();
  }

  /** Remove button: ask whether to also delete the files. */
  removeMenu(button) {
    const n = this.selectedLinkIds().length;
    if (!n) return;
    const r = button.getBoundingClientRect();
    contextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {} }, [
      { label: `Remove ${n} from list`, icon: 'x', danger: true, action: () => this.remove(false) },
      { label: `Remove ${n} and delete files`, icon: 'trash', danger: true, action: () => this.remove(true) },
    ]);
  }

  // ---------------------------------------------------------------- rows

  #createRow(r) {
    const isPkg = r.kind === 'pkg';
    const row = h(`div.row.${isPkg ? 'pkg' : 'link'}`, {
      onmousedown: (e) => {
        if (e.button === 0) this.#selection.click(r.key, e);
        if (e.button === 2) this.#selection.ensure(r.key);
      },
      oncontextmenu: (e) => this.#menu(e),
      ondblclick: () => this.#activate(row.dataset.key),
    });
    const name = h('div.name');
    if (isPkg) {
      const twisty = h('button.twisty', { title: 'Expand / collapse', html: icon('chevron') });
      twisty.addEventListener('mousedown', (e) => e.stopPropagation());
      twisty.addEventListener('click', () => this.#toggle(row.dataset.key.slice(2)));
      name.append(twisty, h('span.label'), h('span.count'));
    } else {
      name.append(thumbSlot(), h('span.label'));
    }
    row.append(
      name,
      h('div.cell.num.size'),
      h('div.progress', {}, h('div.bar', {}, h('div.fill')), h('span.pct')),
      h('div.cell.num.speed'),
      h('div.cell.num.eta'),
      h('div.status', {}, h('span.dot'), h('span.cell.text')),
    );
    return row;
  }

  #updatePackage(el, pkg) {
    const links = pkg.links;
    const size = links.every((l) => l.size != null) ? links.reduce((s, l) => s + l.size, 0) : null;
    const done = links.reduce((s, l) => s + (l.state === 'completed' && l.size ? l.size : l.downloaded), 0);
    const spd = links.reduce((s, l) => s + (l.live?.speed ?? 0), 0);
    const finished = links.filter((l) => l.state === 'completed').length;
    const failed = links.filter((l) => l.state === 'failed').length;
    const active = links.filter((l) => l.state === 'downloading').length;

    let status = 'queued';
    let text = `${finished} of ${links.length} finished`;
    if (active) [status, text] = ['downloading', `Downloading ${active} of ${links.length}`];
    else if (links.some((l) => l.extraction?.state === 'running')) {
      const x = links.find((l) => l.extraction?.state === 'running').extraction;
      [status, text] = ['downloading', `Extracting ${x.progress}%`];
    } else if (finished === links.length) [status, text] = ['completed', 'Finished'];
    else if (failed) [status, text] = ['failed', `${failed} failed · ${finished} of ${links.length} finished`];

    toggleClass(el, 'collapsed', this.#collapsed.has(pkg.id));
    setText(el.querySelector('.label'), pkg.name);
    setText(el.querySelector('.count'), `${links.length} file${links.length === 1 ? '' : 's'}`);
    el.title = pkg.directory;
    const approx = links.some((l) => l.sizeApprox);
    this.#paintCommon(el, { size, approx, done, total: size, spd, eta: size && spd ? (size - done) / spd : null, status, text });
  }

  #updateLink(el, l) {
    const [status, text] = linkStatus(l);
    const done = l.state === 'completed' && l.size ? l.size : l.downloaded;
    toggleClass(el, 'disabled', !l.enabled);
    setThumb(el.querySelector('.thumb'), l.thumb);
    setText(el.querySelector('.label'), l.name);
    el.title = l.filePath ?? l.url;
    this.#paintCommon(el, {
      size: l.size,
      approx: l.sizeApprox,
      done,
      total: l.size,
      spd: l.live?.speed,
      eta: l.live?.eta,
      status,
      text,
      tooltip: l.error?.message,
    });
  }

  #paintCommon(el, { size, approx, done, total, spd, eta, status, text, tooltip }) {
    setText(el.querySelector('.size'), fmtSize(size, approx));
    const p = percent(done, total);
    const bar = el.querySelector('.bar');
    bar.firstChild.style.setProperty('--p', p == null ? 0 : p.toFixed(2));
    bar.className = `bar ${{ completed: 'done', paused: 'paused', failed: 'failed', downloading: 'active' }[status] ?? ''}`;
    setText(el.querySelector('.pct'), p == null ? (done ? bytes(done) : '') : `${Math.floor(p)}%`);
    setText(el.querySelector('.speed'), status === 'downloading' ? speed(spd) : '');
    setText(el.querySelector('.eta'), status === 'downloading' ? duration(eta) : '');
    const st = el.querySelector('.status');
    st.className = `status ${status}`;
    st.title = tooltip ?? text;
    setText(st.lastChild, text);
  }

  #paintSelection() {
    for (const row of this.#list.children) toggleClass(row, 'selected', this.#selection.has(row.dataset.key));
  }

  #toggle(pkgId) {
    if (this.#collapsed.has(pkgId)) this.#collapsed.delete(pkgId);
    else this.#collapsed.add(pkgId);
    window.dispatchEvent(new Event('adl:rerender'));
  }

  #activate(key) {
    const [kind, id] = key.split(':');
    if (kind === 'p') return this.#toggle(id);
    const link = this.#findLink(id);
    if (link?.state === 'completed') call('downloads:openFile', { linkId: id });
  }

  #findLink(id) {
    for (const p of this.#packages) for (const l of p.links) if (l.id === id) return l;
    return null;
  }

  // ---------------------------------------------------------------- actions

  #menu(e) {
    const ids = this.selectedLinkIds();
    if (!ids.length) return;
    const links = ids.map((id) => this.#findLink(id)).filter(Boolean);
    const single = links.length === 1 ? links[0] : null;
    const any = (fn) => links.some(fn);
    const notDone = (l) => l.state !== 'completed';
    contextMenu(e, [
      { label: 'Start now', icon: 'zap', disabled: !any((l) => notDone(l) && l.state !== 'downloading'), action: () => call('downloads:forceStart', { linkIds: ids }) },
      { label: 'Resume', icon: 'play', disabled: !any((l) => ['paused', 'failed', 'waiting'].includes(l.state) || !l.enabled), action: () => call('downloads:resume', { linkIds: ids }) },
      { label: 'Pause', icon: 'pause', disabled: !any((l) => notDone(l) && l.state !== 'paused'), action: () => call('downloads:pause', { linkIds: ids }) },
      '-',
      { label: 'Open file', icon: 'external', disabled: single?.state !== 'completed', action: () => call('downloads:openFile', { linkId: single.id }) },
      { label: 'Open folder', icon: 'folder', action: () => call('downloads:openFolder', { linkId: links[0].id }) },
      ...(links.some((l) => l.extraction?.state === 'done')
        ? [{ label: 'Open extracted files', icon: 'folder', action: () => call('downloads:openExtracted', { linkId: links.find((l) => l.extraction?.state === 'done').id }) }]
        : []),
      ...(links.some((l) => l.state === 'completed' && isArchive(l.name))
        ? [{ label: 'Extract now', icon: 'archive', action: () => call('downloads:extract', { linkIds: ids }) }]
        : []),
      { label: 'Copy links', icon: 'copy', action: () => call('downloads:copyUrls', { linkIds: ids }) },
      '-',
      any((l) => l.priority > 0)
        ? { label: 'Normal priority', icon: 'arrowDown', action: () => call('downloads:setPriority', { linkIds: ids, priority: 0 }) }
        : { label: 'High priority', icon: 'arrowUp', action: () => call('downloads:setPriority', { linkIds: ids, priority: 1 }) },
      any((l) => l.enabled)
        ? { label: 'Disable', icon: 'eyeOff', action: () => call('downloads:setEnabled', { linkIds: ids, enabled: false }) }
        : { label: 'Enable', icon: 'check', action: () => call('downloads:setEnabled', { linkIds: ids, enabled: true }) },
      { label: 'Download again', icon: 'refresh', action: () => this.#reset(ids) },
      '-',
      { label: 'Remove from list', icon: 'x', danger: true, action: () => this.remove(false) },
      { label: 'Remove and delete files', icon: 'trash', danger: true, action: () => this.remove(true) },
    ]);
  }

  async #reset(ids) {
    const ok = await ask({
      title: 'Download again?',
      message: `${ids.length} file${ids.length === 1 ? '' : 's'} will be downloaded again from the start. Files already downloaded will be deleted.`,
      confirm: 'Download again',
      danger: true,
    });
    if (ok) await call('downloads:reset', { linkIds: ids });
  }

  async remove(deleteFiles) {
    const ids = this.selectedLinkIds();
    if (!ids.length) return;
    if (deleteFiles) {
      const ok = await ask({
        title: 'Delete files?',
        message: `${ids.length} download${ids.length === 1 ? '' : 's'} will be removed and ${ids.length === 1 ? 'its file' : 'their files'} deleted from disk. This can't be undone.`,
        confirm: 'Remove and delete',
        danger: true,
      });
      if (!ok) return;
    }
    await call('downloads:remove', { linkIds: ids, deleteFiles });
    this.#selection.clear();
  }

  #onKey(e) {
    if (e.key === 'Delete') this.remove(e.shiftKey);
    else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.#selection.selectAll();
    } else if (e.key === 'Enter' && this.#selection.size === 1) this.#activate(this.#selection.keys[0]);
    else if (e.key === ' ' && this.#selection.size) {
      e.preventDefault();
      const ids = this.selectedLinkIds();
      const anyRunning = ids.some((id) => ['downloading', 'queued'].includes(this.#findLink(id)?.state));
      call(anyRunning ? 'downloads:pause' : 'downloads:resume', { linkIds: ids });
    }
  }
}

function isArchive(name) {
  return /\.(zip|rar|7z|tar|tgz|gz|bz2|xz|zst|r\d{2,3}|z\d{2}|\d{3})$/i.test(name ?? '');
}

function linkStatus(l) {
  if (!l.enabled) return ['queued', 'Disabled'];
  switch (l.state) {
    case 'downloading':
      if (l.live?.phase === 'merging') return ['downloading', 'Joining video and audio…'];
      return ['downloading', l.live?.connections ? `Downloading · ${l.live.connections} conn.` : 'Starting…'];
    case 'paused':
      return ['paused', 'Paused'];
    case 'waiting':
      return ['waiting', `${l.error?.message ?? 'Error'} · retry in ${duration((l.retryAt - Date.now()) / 1000)}`];
    case 'completed':
      switch (l.extraction?.state) {
        case 'queued':
          return ['waiting', 'Waiting to extract'];
        case 'running':
          return ['downloading', `Extracting ${l.extraction.progress}%`];
        case 'done':
          return ['completed', 'Finished · extracted'];
        case 'failed':
          return ['failed', `Extraction failed: ${l.extraction.error}`];
      }
      return ['completed', 'Finished'];
    case 'failed':
      return ['failed', l.error?.message ?? 'Failed'];
    default:
      return ['queued', 'Queued'];
  }
}
