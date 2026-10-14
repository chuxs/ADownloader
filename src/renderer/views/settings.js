import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { call } from '../lib/ui.js';

const KB = 1024;

/**
 * Settings tab. Each field: key, title, hint, and kind.
 * Number fields can convert between the stored value and what is shown.
 */
const SECTIONS = [
  {
    title: 'Downloads',
    fields: [
      { key: 'downloadDir', kind: 'folder', title: 'Download folder', hint: 'Where new downloads are saved' },
      {
        key: 'splitFolders',
        kind: 'toggle',
        title: 'Split videos into numbered folders',
        hint: 'When a folder is full, ask to continue in "Folder 2", "Folder 3", … next to it. Turning this on asks for the first folder.',
        chooseFolder: 'splitFolderBase',
      },
      { key: 'splitFolderBase', kind: 'folder', title: 'Video folder', hint: 'Used instead of the download folder while splitting is on', dependsOn: 'splitFolders' },
      { key: 'splitFolderLimit', kind: 'number', title: 'Videos per folder', hint: 'Other files don\'t count', min: 1, max: 1000, dependsOn: 'splitFolders' },
      { key: 'maxConcurrent', kind: 'number', title: 'Simultaneous downloads', hint: 'Files downloading at the same time', min: 1, max: 20 },
      { key: 'connections', kind: 'number', title: 'Connections per file', hint: 'More connections can be faster; some sites limit them', min: 1, max: 32 },
      { key: 'maxPerHost', kind: 'number', title: 'Downloads per website', hint: '0 = no limit', min: 0, max: 20 },
      {
        key: 'speedLimit',
        kind: 'number',
        title: 'Speed limit',
        hint: 'For all downloads together. 0 = unlimited',
        unit: 'KB/s',
        min: 0,
        max: 10_000_000,
        toView: (v) => Math.round(v / KB),
        fromView: (v) => v * KB,
      },
      { key: 'autoRetries', kind: 'number', title: 'Automatic retries', hint: 'After a temporary error (server down, connection lost)', min: 0, max: 20 },
    ],
  },
  {
    title: 'Video sites',
    fields: [
      {
        key: 'useYtDlp',
        kind: 'toggle',
        title: 'Use yt-dlp for video sites',
        hint: 'Free, open-source tool that supports YouTube, Vimeo and well over a thousand other sites. Installed and updated automatically.',
      },
      { key: 'ytdlp', kind: 'tool', title: 'yt-dlp' },
      { key: 'ffmpeg', kind: 'tool', title: 'ffmpeg', hint: 'Joins video and audio, converts streams to .mp4' },
    ],
  },
  {
    title: 'Archives',
    fields: [
      { key: 'autoExtract', kind: 'toggle', title: 'Extract archives automatically', hint: 'zip, rar, 7z and multi-part archives, once every part has finished' },
      { key: 'extractToSubfolder', kind: 'toggle', title: 'Extract into a folder named after the archive' },
      { key: 'deleteArchivesAfterExtract', kind: 'toggle', title: 'Delete archives after extracting' },
      { key: 'archivePasswords', kind: 'textarea', title: 'Archive passwords', hint: 'One per line; each is tried in turn' },
      { key: 'sevenZip', kind: 'tool', title: '7-Zip', hint: 'Needed for passwords and multi-part archives' },
    ],
  },
  {
    title: 'Behaviour',
    fields: [
      { key: 'startAfterAdding', kind: 'toggle', title: 'Start downloading after adding links', hint: '"Start downloads" in the Link Grabber also starts the queue' },
      { key: 'startOnLaunch', kind: 'toggle', title: 'Resume downloads when ADownloader opens' },
      { key: 'clipboardMonitor', kind: 'toggle', title: 'Watch the clipboard', hint: 'Links you copy anywhere are added to the Link Grabber' },
    ],
  },
];

export class SettingsView {
  #root = document.getElementById('settings-form');
  #inputs = new Map();
  #built = false;
  #state = null;

  render(state) {
    this.#state = state;
    if (!this.#built) this.#build();
    for (const [key, { input, field, row }] of this.#inputs) {
      if (field.dependsOn) row.classList.toggle('off', !state.settings[field.dependsOn]);
      if (field.kind === 'tool') {
        this.#renderTool(input, key, state.tools);
        continue;
      }
      if (document.activeElement === input) continue; // don't overwrite while typing
      const v = state.settings[key];
      if (field.kind === 'toggle') input.checked = v;
      else input.value = field.toView ? field.toView(v) : v;
    }
  }

  /** Found / not found line for an outside tool, with install/update for yt-dlp. */
  #renderTool(el, key, tools) {
    const path = tools[key];
    const status = el.querySelector('.tool-status');
    const btn = el.querySelector('button');
    let text;
    if (key === 'ytdlp' && tools.installing) text = 'Installing / updating…';
    else if (path) text = key === 'ytdlp' && tools.ytdlpVersion ? `Version ${tools.ytdlpVersion}` : path;
    else text = 'Not found';
    if (status.textContent !== text) status.textContent = text;
    status.className = `tool-status ${path ? 'ok' : 'missing'}`;
    status.title = path ?? '';
    if (btn) {
      btn.disabled = tools.installing;
      btn.lastChild.textContent = path ? 'Update' : 'Install';
    }
  }

  #build() {
    this.#built = true;
    for (const section of SECTIONS) {
      const card = h('div.card', {}, h('h3', {}, section.title));
      for (const field of section.fields) card.append(this.#field(field));
      this.#root.append(card);
    }
  }

  #field(field) {
    const text = h('div.text', {}, h('div.title', {}, field.title), field.hint ? h('div.hint', {}, field.hint) : null);
    const row = h('div.field', {}, text);
    let input;

    if (field.kind === 'toggle') {
      input = h('input', { type: 'checkbox', 'aria-label': field.title });
      input.addEventListener('change', async () => {
        if (field.chooseFolder && input.checked) {
          // This option needs a folder: ask for it, and stay off if none is picked.
          const s = this.#state?.settings ?? {};
          const dir = await call('dialog:chooseFolder', { current: s[field.chooseFolder] || s.downloadDir });
          if (!dir) {
            input.checked = false;
            return;
          }
          return call('settings:set', { [field.chooseFolder]: dir, [field.key]: true });
        }
        return call('settings:set', { [field.key]: input.checked });
      });
      row.append(h('label.switch', {}, input, h('span')));
    } else if (field.kind === 'number') {
      input = h('input.input.num', { type: 'number', min: field.min, max: field.max, 'aria-label': field.title });
      input.addEventListener('change', () => {
        let v = Math.round(Number(input.value));
        if (!Number.isFinite(v)) return;
        v = Math.max(field.min, Math.min(field.max, v));
        input.value = v;
        call('settings:set', { [field.key]: field.fromView ? field.fromView(v) : v });
      });
      row.append(input, h('span.unit', {}, field.unit ?? ''));
    } else if (field.kind === 'textarea') {
      row.classList.add('stacked');
      input = h('textarea.input.area', { rows: 3, spellcheck: 'false', 'aria-label': field.title, placeholder: 'password1\npassword2' });
      input.addEventListener('change', () => call('settings:set', { [field.key]: input.value }));
      row.append(input);
    } else if (field.kind === 'tool') {
      input = h('div.tool', {}, h('span.tool-status'));
      if (field.key === 'ytdlp') {
        const btn = h('button.btn', { type: 'button', html: `${icon('refresh')}<span>Update</span>` });
        btn.addEventListener('click', () => call(btn.lastChild.textContent === 'Install' ? 'tools:installYtDlp' : 'tools:updateYtDlp'));
        input.append(btn);
      }
      row.append(input);
    } else if (field.kind === 'folder') {
      row.classList.add('folder-field');
      input = h('input.input.path', { spellcheck: 'false', 'aria-label': field.title });
      input.addEventListener('change', () => input.value.trim() && call('settings:set', { [field.key]: input.value.trim() }));
      const browse = h('button.btn', { type: 'button', html: `${icon('folder')}Browse` });
      browse.addEventListener('click', async () => {
        const dir = await call('dialog:chooseFolder', { current: input.value });
        if (dir) call('settings:set', { [field.key]: dir });
      });
      text.classList.add('narrow');
      row.append(input, browse);
    }
    this.#inputs.set(field.key, { input, field, row });
    return row;
  }
}
