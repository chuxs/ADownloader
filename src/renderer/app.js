import { speed } from './lib/format.js';
import { hydrateIcons } from './lib/icons.js';
import { ask, call, toast } from './lib/ui.js';
import { DownloadsView } from './views/downloads.js';
import { GrabberView } from './views/grabber.js';
import { SettingsView } from './views/settings.js';

hydrateIcons();

const $ = (sel) => document.querySelector(sel);
const views = {
  downloads: new DownloadsView(),
  grabber: new GrabberView(),
  settings: new SettingsView(),
};
let state = null;
let tab = 'downloads';

// ------------------------------------------------------------------ tabs

function showTab(name) {
  tab = name;
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const tb of document.querySelectorAll('.toolbar')) tb.hidden = tb.dataset.for !== name;
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${name}`);
  $(`#list-${name}`)?.focus();
  render();
}

for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));

// ------------------------------------------------------------------ state

window.adl.onState((s) => {
  state = s;
  render();
});
window.addEventListener('adl:rerender', render);
// Countdowns ("retry in 40s") change without new state; refresh them.
setInterval(render, 1000);

function render() {
  if (!state) return;
  views[tab].render(state);

  const links = state.downloads.flatMap((p) => p.links);
  const count = (st) => links.filter((l) => l.state === st).length;
  const running = count('downloading');
  const queued = count('queued') + count('waiting');
  const done = count('completed');
  const grabbed = state.grabber.reduce((n, p) => n + p.links.length, 0);

  $('#badge-downloads').textContent = links.length || '';
  $('#badge-grabber').textContent = grabbed || '';
  $('#sb-speed').textContent = speed(state.speed) || '0 B/s';
  $('#sb-counts').textContent = [
    running && `${running} downloading`,
    queued && `${queued} queued`,
    done && `${done} finished`,
  ]
    .filter(Boolean)
    .join(' · ');
  $('#sb-dir span:last-child').textContent = state.settings.splitFolders
    ? `${state.downloadDir} · ${state.settings.splitFolderLimit} videos per folder`
    : state.downloadDir;

  $('#btn-start').disabled = state.running;
  $('#btn-stop').disabled = !state.running && running === 0;
  $('#btn-remove-finished').disabled = done === 0;
  $('#btn-confirm').disabled = grabbed === 0;
  $('#btn-confirm-start').disabled = grabbed === 0;
  $('#btn-clear-grabber').disabled = grabbed === 0;
  $('#chip-busy').hidden = !state.grabberBusy;
  const limit = state.settings.speedLimit;
  $('#chip-limit span:last-child').textContent = limit ? `Limit ${speed(limit)}` : 'No speed limit';
  updateSelectionButtons();
}

/** "Select all" / "Remove (n)" follow the current selection. */
function updateSelectionButtons() {
  if (!state) return;
  const set = (selectBtn, removeBtn, view, total) => {
    const n = view === views.downloads ? view.selectedLinkIds().length : view.selectedCount;
    selectBtn.disabled = total === 0;
    selectBtn.lastChild.textContent = view.allSelected ? 'Deselect all' : 'Select all';
    removeBtn.disabled = n === 0;
    removeBtn.lastChild.textContent = n ? `Remove (${n})` : 'Remove';
  };
  set($('#btn-dl-select'), $('#btn-dl-remove'), views.downloads, state.downloads.length);
  $('#btn-grab-select').disabled = state.grabber.length === 0;
  $('#btn-grab-select').lastChild.textContent = views.grabber.allSelected ? 'Deselect all' : 'Select all';
}

window.addEventListener('adl:selection', updateSelectionButtons);

// ------------------------------------------------------------------ toolbar

$('#btn-start').addEventListener('click', () => call('downloads:start'));
$('#btn-stop').addEventListener('click', () => call('downloads:stop'));
$('#btn-remove-finished').addEventListener('click', () => call('downloads:removeFinished'));
$('#btn-dl-select').addEventListener('click', () => views.downloads.toggleSelectAll());
$('#btn-dl-remove').addEventListener('click', (e) => views.downloads.removeMenu(e.currentTarget));
$('#btn-grab-select').addEventListener('click', () => views.grabber.toggleSelectAll());
$('#btn-confirm-start').addEventListener('click', () => views.grabber.confirm(true));
$('#btn-confirm').addEventListener('click', () => views.grabber.confirm(false));
$('#btn-clear-grabber').addEventListener('click', async () => {
  const ok = await ask({
    title: 'Clear the Link Grabber?',
    message: 'All links waiting here will be removed. Nothing is downloaded or deleted from disk.',
    confirm: 'Clear all',
    danger: true,
  });
  if (ok) call('grabber:clear');
});
$('#btn-paste').addEventListener('click', async () => addText(await call('app:readClipboard')));
$('#chip-limit').addEventListener('click', () => showTab('settings'));
for (const b of document.querySelectorAll('[data-action="add-links"]')) b.addEventListener('click', openAddDialog);

// ------------------------------------------------------------------ adding links

/** Send text to the Link Grabber and show the result there. */
async function addText(text, opts = {}) {
  if (!text?.trim()) return;
  showTab('grabber');
  const n = await call('grabber:add', { text, ...opts });
  if (!n) toast('No links found in that text', 'error');
}

const dlg = $('#dlg-add');
const form = dlg.querySelector('form');
const fields = form.elements;

async function openAddDialog() {
  form.reset();
  dlg.returnValue = ''; // otherwise Escape would repeat the last "ok"
  fields.directory.value = state?.downloadDir ?? '';
  dlg.showModal();
  // Prefill with links already on the clipboard.
  const clip = await call('app:readClipboard');
  if (/https?:\/\//i.test(clip) && !fields.text.value) fields.text.value = clip.trim();
  fields.text.select();
}

$('#dlg-browse').addEventListener('click', async () => {
  const dir = await call('dialog:chooseFolder', { current: fields.directory.value });
  if (dir) fields.directory.value = dir;
});

dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'ok') return;
  addText(fields.text.value, {
    directory: fields.directory.value.trim() || undefined,
    packageName: fields.packageName.value.trim() || undefined,
  });
});

// Questions from the main process (e.g. "folder is full, create the next one?").
const promptDlg = $('#dlg-prompt');
const seenPrompts = new Set(); // a question may be sent again after the UI loads
window.adl.onPrompt(async (q) => {
  if (seenPrompts.has(q.id)) return;
  seenPrompts.add(q.id);
  const ok = await ask(q);
  call('app:promptAnswer', { id: q.id, ok });
});
window.adl.onNotice((message) => toast(message, 'info', 6000));

// Ctrl+V anywhere outside a text field adds the pasted links.
document.addEventListener('paste', (e) => {
  if (e.target.closest('input, textarea') || dlg.open || promptDlg.open) return;
  addText(e.clipboardData.getData('text'));
});

// Drag and drop links or text onto the window.
let dragDepth = 0;
const app = $('#app');
window.addEventListener('dragenter', (e) => {
  if (!hasText(e)) return;
  dragDepth++;
  app.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    app.classList.remove('dragging');
  }
});
window.addEventListener('dragover', (e) => {
  if (hasText(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  app.classList.remove('dragging');
  addText(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'));
});

function hasText(e) {
  return [...e.dataTransfer.types].some((t) => t === 'text/uri-list' || t === 'text/plain');
}

// Keyboard shortcuts for tabs.
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.target.closest('input, textarea')) return;
  if (e.key === '1') showTab('downloads');
  else if (e.key === '2') showTab('grabber');
  else if (e.key === ',') showTab('settings');
  else if (e.key.toLowerCase() === 'n') {
    e.preventDefault();
    openAddDialog();
  }
});

showTab('downloads');
