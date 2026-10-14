import { h, setText, syncList, toggleClass } from '../lib/dom.js';
import { hostOf, size as fmtSize } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { call, contextMenu, Selection, setThumb, thumbSlot, toast } from '../lib/ui.js';

const STATUS_TEXT = {
  online: 'Online',
  offline: 'Offline',
  checking: 'Checking…',
  unchecked: 'Not checked',
};

/** The Link Grabber tab: found links waiting to be reviewed and confirmed. */
export class GrabberView {
  #list = document.getElementById('list-grabber');
  #empty = document.getElementById('empty-grabber');
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
    this.#list.addEventListener('keydown', (e) => {
      if (e.key === 'Delete') this.remove();
      else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.#selection.selectAll();
      } else if (e.key === 'Enter') this.confirm(true);
    });
    this.#list.addEventListener('mousedown', (e) => {
      if (e.target === this.#list) this.#selection.clear();
    });
  }

  render(state) {
    this.#packages = state.grabber;
    this.#rows = [];
    for (const pkg of state.grabber) {
      this.#rows.push({ key: `p:${pkg.id}`, kind: 'pkg', pkg });
      if (!this.#collapsed.has(pkg.id)) {
        for (const link of pkg.links) this.#rows.push({ key: `l:${link.id}`, kind: 'link', link });
      }
    }
    this.#selection.prune(new Set(this.#rows.map((r) => r.key)));
    toggleClass(this.#empty, 'show', state.grabber.length === 0);
    this.#list.hidden = state.grabber.length === 0;

    syncList(this.#list, this.#rows, {
      key: (r) => r.key,
      create: (r) => this.#createRow(r),
      update: (el, r) => (r.kind === 'pkg' ? this.#updatePackage(el, r.pkg) : this.#updateLink(el, r.link)),
    });
    this.#paintSelection();
  }

  /**
   * Confirm the selection (or everything when nothing is selected) into the
   * download list. `start` also starts downloading.
   */
  async confirm(start) {
    const sel = this.#selectionIds();
    const which = sel.packageIds.length || sel.linkIds.length ? sel : {};
    const n = await call('grabber:confirm', { ...which, start });
    if (n) toast(start ? 'Downloads started' : 'Added to the download list');
    else toast('Nothing to add: the links are offline or still being checked', 'error');
    return n;
  }

  async remove() {
    const { linkIds } = this.#selectionIds(true);
    if (linkIds.length) await call('grabber:remove', { linkIds });
    this.#selection.clear();
  }

  get allSelected() {
    return this.#selection.allSelected;
  }

  toggleSelectAll() {
    this.#selection.toggleAll();
    this.#list.focus();
  }

  // ---------------------------------------------------------------- rows

  #createRow(r) {
    const isPkg = r.kind === 'pkg';
    const row = h(`div.row.${isPkg ? 'pkg' : 'link'}`, {
      onmousedown: (e) => {
        if (e.button === 0) this.#selection.click(row.dataset.key, e);
        if (e.button === 2) this.#selection.ensure(row.dataset.key);
      },
      oncontextmenu: (e) => this.#menu(e),
      ondblclick: () => {
        const [kind, id] = row.dataset.key.split(':');
        if (kind === 'p') this.#toggle(id);
      },
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
    const last = isPkg
      ? h('button.btn.ghost.dirbtn', { title: 'Change folder', html: `${icon('folder')}<span class="cell"></span>` })
      : h('div.cell.dir');
    if (isPkg) {
      last.addEventListener('mousedown', (e) => e.stopPropagation());
      last.addEventListener('click', () => this.#chooseFolder([row.dataset.key.slice(2)]));
    }
    row.append(name, h('div.cell.num.size'), h('div.status', {}, h('span.dot'), h('span.cell.text')), last);
    return row;
  }

  #updatePackage(el, pkg) {
    const links = pkg.links;
    const size = links.some((l) => l.size != null) ? links.reduce((s, l) => s + (l.size ?? 0), 0) : null;
    const online = links.filter((l) => l.status === 'online').length;
    const offline = links.filter((l) => l.status === 'offline').length;
    const checking = links.filter((l) => l.status === 'checking').length;
    const parts = [];
    if (online) parts.push(`${online} online`);
    if (offline) parts.push(`${offline} offline`);
    if (checking) parts.push(`${checking} checking`);
    const status = checking ? 'checking' : offline === links.length ? 'offline' : online ? 'online' : 'unchecked';

    toggleClass(el, 'collapsed', this.#collapsed.has(pkg.id));
    setText(el.querySelector('.label'), pkg.name);
    setText(el.querySelector('.count'), `${links.length} file${links.length === 1 ? '' : 's'}`);
    setText(el.querySelector('.size'), fmtSize(size, links.some((l) => l.sizeApprox)));
    this.#paintStatus(el, status, parts.join(' · ') || 'Not checked');
    setText(el.querySelector('.dirbtn .cell'), pkg.directory);
    el.querySelector('.dirbtn').title = `Save to: ${pkg.directory}\nClick to change`;
  }

  #updateLink(el, l) {
    setThumb(el.querySelector('.thumb'), l.thumb);
    setText(el.querySelector('.label'), l.name ?? l.url);
    el.title = l.url;
    setText(el.querySelector('.size'), fmtSize(l.size, l.sizeApprox));
    this.#paintStatus(el, l.status, l.status === 'offline' && l.error ? l.error : STATUS_TEXT[l.status]);
    setText(el.querySelector('.dir'), l.pluginId === 'directhttp' ? hostOf(l.url) : `${hostOf(l.url)} · plugin`);
  }

  #paintStatus(el, status, text) {
    const st = el.querySelector('.status');
    st.className = `status ${status}`;
    st.title = text;
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

  // ---------------------------------------------------------------- actions

  /** Selected package ids and link ids; with `expand`, packages become their link ids. */
  #selectionIds(expand = false) {
    const packageIds = [];
    const linkIds = [];
    for (const key of this.#selection.keys) {
      const [kind, id] = key.split(':');
      if (kind === 'l') linkIds.push(id);
      else if (expand) this.#packages.find((p) => p.id === id)?.links.forEach((l) => linkIds.push(l.id));
      else packageIds.push(id);
    }
    // A package and its own links may both be selected: count each link once.
    return { packageIds, linkIds: [...new Set(linkIds)] };
  }

  #findLink(id) {
    for (const p of this.#packages) for (const l of p.links) if (l.id === id) return l;
    return null;
  }

  async #chooseFolder(packageIds) {
    const current = this.#packages.find((p) => p.id === packageIds[0])?.directory;
    const dir = await call('dialog:chooseFolder', { current });
    if (!dir) return;
    for (const id of packageIds) await call('grabber:updatePackage', { id, directory: dir });
  }

  #menu(e) {
    const { linkIds } = this.#selectionIds(true);
    if (!linkIds.length) return;
    const links = linkIds.map((id) => this.#findLink(id)).filter(Boolean);
    const pkgIds = [...new Set(this.#selection.keys.map((k) => (k.startsWith('p:') ? k.slice(2) : this.#packageOf(k.slice(2)))))];
    contextMenu(e, [
      { label: 'Start downloads', icon: 'download', action: () => this.confirm(true) },
      { label: 'Add to download list', icon: 'list', action: () => this.confirm(false) },
      '-',
      { label: 'Change folder…', icon: 'folder', action: () => this.#chooseFolder(pkgIds) },
      {
        label: 'Open in browser',
        icon: 'external',
        disabled: links.length !== 1,
        action: () => window.open(links[0].url),
      },
      { label: 'Copy links', icon: 'copy', action: () => navigator.clipboard.writeText(links.map((l) => l.url).join('\n')) },
      '-',
      { label: 'Remove', icon: 'trash', danger: true, action: () => this.remove() },
    ]);
  }

  #packageOf(linkId) {
    return this.#packages.find((p) => p.links.some((l) => l.id === linkId))?.id;
  }
}
