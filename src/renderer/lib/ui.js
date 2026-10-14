import { h } from './dom.js';
import { icon } from './icons.js';

/** Call a main-process action; shows a toast if it fails. */
export async function call(channel, arg) {
  try {
    return await window.adl.invoke(channel, arg);
  } catch (err) {
    toast(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
    throw err;
  }
}

const askQueue = [];
let asking = null;

/**
 * Yes/no question in the app's own themed dialog (instead of the browser's
 * white confirm box). Questions asked while one is open wait their turn.
 * @param {{title: string, message: string, detail?: string, confirm?: string,
 *          cancel?: string, danger?: boolean}} q  danger: red confirm button
 * @returns {Promise<boolean>} true when confirmed
 */
export function ask(q) {
  return new Promise((resolve) => {
    askQueue.push({ ...q, resolve });
    nextAsk();
  });
}

function nextAsk() {
  if (asking || !askQueue.length) return;
  asking = askQueue.shift();
  const dlg = document.getElementById('dlg-prompt');
  document.getElementById('prompt-title').textContent = asking.title;
  document.getElementById('prompt-message').textContent = asking.message;
  document.getElementById('prompt-detail').textContent = asking.detail ?? '';
  const ok = document.getElementById('prompt-ok');
  ok.textContent = asking.confirm ?? 'OK';
  ok.classList.toggle('danger-fill', Boolean(asking.danger));
  document.getElementById('prompt-cancel').textContent = asking.cancel ?? 'Cancel';
  dlg.returnValue = '';
  dlg.showModal();
}

document.getElementById('dlg-prompt').addEventListener('close', (e) => {
  asking?.resolve(e.target.returnValue === 'ok');
  asking = null;
  nextAsk();
});

export function toast(message, kind = 'info', ms = 3500) {
  const el = h(`div.toast.${kind}`, {}, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

/**
 * A thumbnail slot for list rows: shows the image when there is one,
 * otherwise a file icon. Hovering shows a larger preview.
 */
export function thumbSlot() {
  const slot = h('span.thumb', { html: icon('file', 'file-icon') });
  slot.dataset.src = '';
  slot.addEventListener('mouseenter', () => slot.dataset.src && showPreview(slot));
  slot.addEventListener('mouseleave', hidePreview);
  return slot;
}

export function setThumb(slot, url) {
  const src = url ?? '';
  if (slot.dataset.src === src) return;
  slot.dataset.src = src;
  slot.classList.toggle('has-img', Boolean(src));
  if (!src) {
    slot.innerHTML = icon('file', 'file-icon');
    return;
  }
  const img = h('img', { src, alt: '', draggable: 'false' });
  img.addEventListener('error', () => setThumb(slot, null));
  slot.replaceChildren(img);
}

let preview = null;

function showPreview(slot) {
  hidePreview();
  preview = h('div.thumb-preview', {}, h('img', { src: slot.dataset.src, alt: '' }));
  document.body.append(preview);
  const r = slot.getBoundingClientRect();
  const top = r.bottom + 8 + 190 > window.innerHeight ? r.top - 8 - 190 : r.bottom + 8;
  preview.style.left = `${Math.max(8, r.left)}px`;
  preview.style.top = `${Math.max(8, top)}px`;
}

function hidePreview() {
  preview?.remove();
  preview = null;
}

let openMenu = null;

/**
 * Show a context menu at the mouse position.
 * @param {MouseEvent} e
 * @param {Array<{label: string, icon?: string, action?: () => void, disabled?: boolean, danger?: boolean} | '-'>} items
 */
export function contextMenu(e, items) {
  e.preventDefault();
  closeMenu();
  const menu = h('div.menu', { role: 'menu' });
  for (const item of items) {
    if (item === '-') {
      menu.append(h('hr'));
      continue;
    }
    const btn = h(
      `button${item.danger ? '.danger' : ''}`,
      { role: 'menuitem', disabled: item.disabled, html: `${icon(item.icon ?? 'file')}<span></span>` },
    );
    btn.lastChild.textContent = item.label;
    btn.addEventListener('click', () => {
      closeMenu();
      item.action?.();
    });
    menu.append(btn);
  }
  document.body.append(menu);
  // Keep the menu inside the window.
  const { innerWidth: w, innerHeight: ht } = window;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, w - r.width - 6)}px`;
  menu.style.top = `${Math.min(e.clientY, ht - r.height - 6)}px`;
  openMenu = menu;
}

export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

window.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});
window.addEventListener('blur', closeMenu);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

/**
 * Row selection with click, Ctrl+click and Shift+click.
 * `orderedKeys()` returns the keys of the rows in display order.
 */
export class Selection {
  #keys = new Set();
  #anchor = null;

  constructor(orderedKeys, onChange) {
    this.orderedKeys = orderedKeys;
    this.onChange = onChange;
  }

  has(key) {
    return this.#keys.has(key);
  }

  get keys() {
    return [...this.#keys];
  }

  get size() {
    return this.#keys.size;
  }

  click(key, e) {
    if (e.shiftKey && this.#anchor) {
      const order = this.orderedKeys();
      const a = order.indexOf(this.#anchor);
      const b = order.indexOf(key);
      if (a >= 0 && b >= 0) {
        if (!e.ctrlKey && !e.metaKey) this.#keys.clear();
        for (const k of order.slice(Math.min(a, b), Math.max(a, b) + 1)) this.#keys.add(k);
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (this.#keys.has(key)) this.#keys.delete(key);
      else this.#keys.add(key);
      this.#anchor = key;
    } else {
      this.#keys = new Set([key]);
      this.#anchor = key;
    }
    this.onChange();
  }

  /** Right-click: keep a multi-selection if the row is part of it. */
  ensure(key) {
    if (!this.#keys.has(key)) {
      this.#keys = new Set([key]);
      this.#anchor = key;
      this.onChange();
    }
  }

  selectAll() {
    this.#keys = new Set(this.orderedKeys());
    this.onChange();
  }

  get allSelected() {
    const order = this.orderedKeys();
    return order.length > 0 && order.every((k) => this.#keys.has(k));
  }

  /** Select everything, or nothing if everything is already selected. */
  toggleAll() {
    if (this.allSelected) this.clear();
    else this.selectAll();
  }

  clear() {
    if (!this.#keys.size) return;
    this.#keys.clear();
    this.onChange();
  }

  /** Drop keys that no longer exist. */
  prune(validKeys) {
    for (const k of this.#keys) if (!validKeys.has(k)) this.#keys.delete(k);
  }
}
