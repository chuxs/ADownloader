/** Create an element: h('div.row.pkg', {title: 'x'}, child1, 'text'). */
export function h(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) el.append(c);
  return el;
}

/**
 * Keyed list update: reuse existing child elements by key, create missing ones,
 * remove stale ones and keep the order of `items`. Keeps scroll position and
 * avoids rebuilding rows on every update.
 */
export function syncList(container, items, { key, create, update }) {
  const existing = new Map();
  for (const el of container.children) existing.set(el.dataset.key, el);
  let prev = null;
  for (const item of items) {
    const k = key(item);
    let el = existing.get(k);
    if (el) existing.delete(k);
    else {
      el = create(item);
      el.dataset.key = k;
    }
    update(el, item);
    const expected = prev ? prev.nextElementSibling : container.firstElementChild;
    if (el !== expected) container.insertBefore(el, expected);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
}

/** Set text only when it changed (avoids needless layout work). */
export function setText(el, text) {
  const t = text ?? '';
  if (el.textContent !== t) el.textContent = t;
}

export function toggleClass(el, cls, on) {
  if (el.classList.contains(cls) !== Boolean(on)) el.classList.toggle(cls, Boolean(on));
}
