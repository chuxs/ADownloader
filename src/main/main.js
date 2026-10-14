import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DownloadList, LinkState } from '../core/DownloadList.js';
import { FolderSplitter } from '../core/FolderSplitter.js';
import { Scheduler } from '../core/Scheduler.js';
import { Thumbnails } from '../core/Thumbnails.js';
import { ExtractionManager } from '../extraction/ExtractionManager.js';
import { LinkGrabber } from '../grabber/LinkGrabber.js';
import { extractUrlsFromText } from '../plugins/html.js';
import { PluginRegistry } from '../plugins/PluginRegistry.js';
import { QUALITY_OPTIONS } from '../plugins/quality.js';
import { Tools } from '../tools/Tools.js';
import { Settings } from './Settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const THEME = { background: '#0b1220', symbols: '#c9d6f2' };
const SCHEDULER_KEYS = ['maxConcurrent', 'maxPerHost', 'connections', 'speedLimit', 'autoRetries'];
const EXTRACTION_KEYS = ['autoExtract', 'extractToSubfolder', 'deleteArchivesAfterExtract', 'archivePasswords'];
const DAY = 24 * 60 * 60 * 1000;

// Developer option: keep data in another folder (used by scripts/screenshot.js).
if (process.env.ADL_USER_DATA) app.setPath('userData', process.env.ADL_USER_DATA);

// Thumbnails reach the window as adl-thumb://t/<file>, served from the cache
// folder only, so the UI never gets general file access.
protocol.registerSchemesAsPrivileged([{ scheme: 'adl-thumb', privileges: { standard: true, secure: true } }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  /** @type {Awaited<ReturnType<typeof createCore>>} */
  let core = null;
  let quitting = false;

  app.on('second-instance', (_e, argv) => {
    // Links passed to a second launch (e.g. from a browser) go to the grabber.
    const urls = extractUrlsFromText(argv.join(' '));
    if (core && urls.length) core.grabber.add(urls.join('\n'));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    core = await createCore();
    protocol.handle('adl-thumb', (req) => {
      const file = core.thumbnails.fileFor(decodeURIComponent(new URL(req.url).pathname.slice(1)));
      return file ? net.fetch(pathToFileURL(file).href) : new Response(null, { status: 404 });
    });
    registerIpc(core);
    win = createWindow();
    startStatePush(core, () => win);
    if (core.settings.get('startOnLaunch')) core.scheduler.start();
    if (process.env.ADL_SCREENSHOT_DIR) {
      captureTabs(win, process.env.ADL_SCREENSHOT_DIR)
        .catch((err) => console.error('screenshot run failed:', err.message))
        .finally(() => app.quit()); // never leave the app running after a failed step
    }
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (e) => {
    if (quitting || !core) return;
    // Pause downloads and save everything before exiting.
    e.preventDefault();
    quitting = true;
    core.extraction.stop();
    answerAllPrompts(); // downloads waiting on a question must not block quitting
    Promise.allSettled([core.scheduler.close(), core.grabber.save(), core.settings.save()]).finally(() => app.quit());
  });
}

async function createCore() {
  const dataDir = app.getPath('userData');
  const settings = new Settings(path.join(dataDir, 'settings.json'), {
    downloadDir: app.getPath('downloads'),
    maxConcurrent: 3,
    maxPerHost: 0,
    connections: 8,
    speedLimit: 0,
    autoRetries: 3,
    startOnLaunch: false,
    startAfterAdding: true,
    clipboardMonitor: false,
    autoExtract: true,
    extractToSubfolder: true,
    deleteArchivesAfterExtract: false,
    archivePasswords: '',
    useYtDlp: true,
    ytdlpCheckedAt: 0,
    splitFolders: false,
    splitFolderBase: '',
    splitFolderLimit: 15,
    multiQuality: false,
    videoQualities: ['1080', '720'],
  });
  await settings.load();
  const folders = new FolderSplitter(({ full, next, limit }) =>
    askUser({
      title: 'Folder is full',
      message: `"${path.basename(full)}" has ${limit} videos.\nCreate "${path.basename(next)}" in the same location and continue downloading there?`,
      detail: path.dirname(next),
      confirm: `Create "${path.basename(next)}"`,
      cancel: 'Not now',
    }),
  );
  const configureFolders = () =>
    folders.configure({
      enabled: settings.get('splitFolders'),
      base: settings.get('splitFolderBase'),
      limit: settings.get('splitFolderLimit'),
    });
  configureFolders();

  const tools = new Tools(path.join(dataDir, 'tools'));
  await tools.refresh();
  // Read on every link check, so changing the setting applies to the next links added.
  const qualityPrefs = () => {
    const list = settings.get('videoQualities');
    return {
      multiple: settings.get('multiQuality'),
      list: Array.isArray(list) ? list.filter((q) => QUALITY_OPTIONS.includes(q)) : [],
    };
  };
  const registry = PluginRegistry.withBuiltins(tools, qualityPrefs);
  const list = new DownloadList({ file: path.join(dataDir, 'downloadlist.json') });
  await list.load();
  const extraction = new ExtractionManager(list, tools, pick(settings.values, EXTRACTION_KEYS));
  keepYtDlpCurrent(tools, settings);
  const grabber = new LinkGrabber({
    registry,
    list,
    defaultDirectory: effectiveDownloadDir(settings),
    file: path.join(dataDir, 'linkgrabber.json'),
  });
  await grabber.load();
  const scheduler = new Scheduler(list, pick(settings.values, SCHEDULER_KEYS), { plugins: registry, folders });
  scheduler.on('notice', (message) => sendToWindow('notice', message));
  const thumbnails = new Thumbnails(path.join(dataDir, 'thumbnails'), tools, [list, grabber]);
  await thumbnails.cleanup();
  thumbnails.scan();

  const clipboardWatcher = new ClipboardWatcher((text) => grabber.add(text));
  clipboardWatcher.enabled = settings.get('clipboardMonitor');

  settings.on('changed', (changed) => {
    const forScheduler = pick(changed, SCHEDULER_KEYS);
    if (Object.keys(forScheduler).length) scheduler.setSettings(forScheduler);
    extraction.setSettings(pick(changed, EXTRACTION_KEYS));
    if (['downloadDir', 'splitFolders', 'splitFolderBase', 'splitFolderLimit'].some((k) => k in changed)) {
      configureFolders();
      grabber.defaultDirectory = effectiveDownloadDir(settings);
    }
    if ('clipboardMonitor' in changed) clipboardWatcher.enabled = changed.clipboardMonitor;
    if (changed.useYtDlp) keepYtDlpCurrent(tools, settings);
  });

  return { settings, tools, registry, list, grabber, scheduler, extraction, thumbnails };
}

/** New downloads go to the numbered-folder series when it is on, else the normal folder. */
function effectiveDownloadDir(settings) {
  return settings.get('splitFolders') && settings.get('splitFolderBase')
    ? settings.get('splitFolderBase')
    : settings.get('downloadDir');
}

function sendToWindow(channel, payload) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  return win;
}

/** Open questions to the user: id -> {question, resolve} */
const prompts = new Map();
let promptId = 0;

/**
 * Ask the user a yes/no question in the app's own dialog (falls back to a
 * system dialog when the window isn't open). Resolves true for confirm.
 */
function askUser({ title, message, detail, confirm, cancel }) {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) {
    return dialog
      .showMessageBox({ type: 'question', title, message, detail, buttons: [confirm, cancel], defaultId: 0, cancelId: 1 })
      .then((r) => r.response === 0);
  }
  if (win.isMinimized()) win.restore();
  win.flashFrame(true);
  const question = { id: ++promptId, title, message, detail, confirm, cancel };
  // If the window is still loading this is lost; resendPrompts() repeats it once the UI is ready.
  win.webContents.send('prompt', question);
  return new Promise((resolve) => prompts.set(question.id, { question, resolve }));
}

/** The UI (re)loaded: show it every question still waiting for an answer. */
function resendPrompts(webContents) {
  for (const { question } of prompts.values()) webContents.send('prompt', question);
}

/** Nobody can answer any more (window closed, app quitting): treat as "no". */
function answerAllPrompts() {
  for (const { resolve } of prompts.values()) resolve(false);
  prompts.clear();
}

/** Install yt-dlp if it is missing, and update it once a day (sites change often). */
function keepYtDlpCurrent(tools, settings) {
  if (!settings.get('useYtDlp') || tools.status.installing) return;
  const stale = Date.now() - settings.get('ytdlpCheckedAt') > DAY;
  if (tools.ytdlp && !stale) return;
  (tools.ytdlp ? tools.updateYtDlp() : tools.installYtDlp())
    .then(() => settings.set({ ytdlpCheckedAt: Date.now() }))
    .catch((err) => console.error('yt-dlp install/update failed:', err.message));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 860,
    minHeight: 520,
    show: false,
    title: 'ADownloader',
    backgroundColor: THEME.background,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: THEME.background, symbolColor: THEME.symbols, height: 44 },
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  // The UI never navigates or opens windows; links open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // A closed window can't answer: treat open questions as "no" so nothing waits forever.
  win.on('closed', answerAllPrompts);
  win.loadFile(path.join(here, '../renderer/index.html'));
  if (process.env.ADL_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

/** Everything the UI can ask the main process to do. */
function registerIpc({ settings, tools, list, grabber, scheduler, extraction }) {
  const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const linkOf = (id) => list.getLink(id);

  const handlers = {
    // link grabber
    'grabber:add': ({ text, directory, packageName }) =>
      grabber.add(String(text ?? ''), { directory: directory || undefined, packageName: packageName || undefined }),
    'grabber:confirm': ({ packageIds, linkIds, start }) => {
      const created = grabber.confirm({
        packageIds: packageIds && ids(packageIds),
        linkIds: linkIds && ids(linkIds),
      });
      if (start ?? settings.get('startAfterAdding')) scheduler.start();
      return created.length;
    },
    'grabber:remove': ({ linkIds }) => grabber.remove(ids(linkIds)),
    'grabber:removePackages': ({ packageIds }) => grabber.removePackages(ids(packageIds)),
    'grabber:clear': () => grabber.clear(),
    'grabber:updatePackage': ({ id, name, directory }) => grabber.updatePackage(String(id), { name, directory }),
    'grabber:abort': () => grabber.abort(),

    // downloads
    'downloads:start': () => scheduler.start(),
    'downloads:stop': () => scheduler.stop(),
    'downloads:forceStart': ({ linkIds }) => scheduler.forceStart(ids(linkIds)),
    'downloads:pause': ({ linkIds }) => scheduler.pause(ids(linkIds)),
    'downloads:resume': ({ linkIds }) => scheduler.resume(ids(linkIds)),
    'downloads:reset': ({ linkIds }) => scheduler.reset(ids(linkIds)),
    'downloads:setEnabled': ({ linkIds, enabled }) => scheduler.setEnabled(ids(linkIds), Boolean(enabled)),
    'downloads:remove': ({ linkIds, deleteFiles }) => scheduler.remove(ids(linkIds), { deleteFiles: Boolean(deleteFiles) }),
    'downloads:removeFinished': () =>
      scheduler.remove([...list.links()].filter((l) => l.state === LinkState.COMPLETED).map((l) => l.id)),
    'downloads:setPriority': ({ linkIds, priority }) => {
      const p = Math.max(-1, Math.min(2, Number(priority) || 0));
      for (const id of ids(linkIds)) list.updateLink(id, { priority: p });
    },
    'downloads:renamePackage': ({ id, name }) => name && list.updatePackage(String(id), { name: String(name) }),
    'downloads:movePackage': ({ id, index }) => list.movePackage(String(id), Number(index)),
    'downloads:openFile': ({ linkId }) => {
      const link = linkOf(linkId);
      if (link?.state === LinkState.COMPLETED && link.filePath) return shell.openPath(link.filePath);
    },
    'downloads:openFolder': ({ linkId, packageId }) => {
      const link = linkId && linkOf(linkId);
      if (link?.filePath) {
        shell.showItemInFolder(link.state === LinkState.COMPLETED ? link.filePath : `${link.filePath}.part`);
      } else {
        const pkg = list.getPackage(packageId ?? link?.packageId);
        if (pkg) shell.openPath(pkg.directory);
      }
    },
    'downloads:copyUrls': ({ linkIds }) => {
      clipboard.writeText(ids(linkIds).map((id) => linkOf(id)?.url).filter(Boolean).join('\n'));
    },
    'downloads:extract': ({ linkIds }) => extraction.extractNow(ids(linkIds)),
    'downloads:openExtracted': ({ linkId }) => {
      const dest = linkOf(linkId)?.extraction?.destination;
      if (dest) return shell.openPath(dest);
    },

    // outside tools
    'tools:refresh': () => tools.refresh(),
    'tools:installYtDlp': async () => {
      await tools.installYtDlp();
      settings.set({ ytdlpCheckedAt: Date.now() });
    },
    'tools:updateYtDlp': async () => {
      await tools.updateYtDlp();
      settings.set({ ytdlpCheckedAt: Date.now() });
    },

    // settings and dialogs
    'settings:set': (patch) => settings.set(patch ?? {}),
    'dialog:chooseFolder': async ({ current }) => {
      const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
        defaultPath: current || settings.get('downloadDir'),
        properties: ['openDirectory', 'createDirectory'],
      });
      return r.canceled ? null : r.filePaths[0];
    },
    'app:readClipboard': () => clipboard.readText(),
    'app:promptAnswer': ({ id, ok }) => {
      BrowserWindow.getAllWindows()[0]?.flashFrame(false);
      prompts.get(id)?.resolve(Boolean(ok));
      prompts.delete(id);
    },
  };

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_e, arg) => fn(arg ?? {}));
  }
}

/**
 * Sends a snapshot of the whole state to the window whenever something changed,
 * at most 4 times per second.
 */
function startStatePush({ settings, tools, list, grabber, scheduler }, getWindow) {
  let dirty = true;
  const mark = () => (dirty = true);
  tools.on('changed', mark);
  for (const ev of ['added', 'removed', 'changed', 'reordered']) list.on(ev, mark);
  grabber.on('changed', mark);
  grabber.on('busy', mark);
  scheduler.on('running', mark);
  scheduler.on('progress', mark);
  settings.on('changed', mark);
  ipcMain.on('state:request', (e) => {
    mark();
    resendPrompts(e.sender); // the UI just loaded: repeat questions it may have missed
  });

  setInterval(() => {
    const win = getWindow();
    if (!dirty || !win || win.isDestroyed()) return;
    dirty = false;
    win.webContents.send('state', snapshot({ settings, tools, list, grabber, scheduler }));
  }, 250);
}

function snapshot({ settings, tools, list, grabber, scheduler }) {
  return {
    running: scheduler.running,
    speed: scheduler.speed,
    settings: settings.values,
    downloadDir: effectiveDownloadDir(settings),
    tools: tools.status,
    grabberBusy: grabber.busy,
    downloads: list.packages.map((p) => ({
      id: p.id,
      name: p.name,
      directory: p.directory,
      links: p.links.map((l) => ({
        id: l.id,
        url: l.url,
        name: l.name,
        pluginId: l.pluginId,
        state: l.state,
        enabled: l.enabled,
        priority: l.priority,
        size: l.size,
        sizeApprox: l.sizeApprox,
        downloaded: l.downloaded,
        error: l.error,
        retryAt: l.retryAt,
        filePath: l.filePath,
        extraction: l.extraction ?? null,
        thumb: thumbUrl(l),
        live: scheduler.liveInfo(l.id),
      })),
    })),
    grabber: grabber.packages.map((p) => ({
      id: p.id,
      name: p.name,
      directory: p.directory,
      links: p.links.map((l) => ({
        id: l.id,
        url: l.url,
        name: l.name,
        size: l.size,
        sizeApprox: l.sizeApprox,
        thumb: thumbUrl(l),
        status: l.status,
        error: l.error,
        pluginId: l.pluginId,
      })),
    })),
  };
}

/** Adds links copied to the clipboard, like JDownloader's clipboard monitoring. */
class ClipboardWatcher {
  #timer = null;
  #last = '';

  constructor(onLinks) {
    this.onLinks = onLinks;
  }

  set enabled(on) {
    clearInterval(this.#timer);
    this.#timer = null;
    if (!on) return;
    this.#last = clipboard.readText(); // ignore what was copied before turning it on
    this.#timer = setInterval(() => {
      const text = clipboard.readText();
      if (text === this.#last) return;
      this.#last = text;
      if (extractUrlsFromText(text).length) this.onLinks(text);
    }, 1000);
  }
}

/** Developer option: save a screenshot of each tab, then quit. */
async function captureTabs(win, dir) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await mkdir(dir, { recursive: true });
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  const shot = async (name) => writeFile(path.join(dir, name), (await win.webContents.capturePage()).toPNG());

  if (process.env.ADL_SCREENSHOT_MODE === 'split') {
    // The "folder is full" question, then answer it and let the videos finish.
    await wait(2500);
    await shot('split-prompt.png');
    await win.webContents.executeJavaScript(`document.querySelector('#prompt-ok').click()`);
    await wait(6000);
    await shot('split-after.png');
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab=settings]').click()`);
    await wait(600);
    await shot('split-settings.png');
    app.quit();
    return;
  }

  await wait(Number(process.env.ADL_SCREENSHOT_DELAY ?? 3000));
  for (const tab of ['downloads', 'grabber', 'settings']) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab=${tab}]').click()`);
    await wait(600);
    const image = await win.webContents.capturePage();
    await writeFile(path.join(dir, `${tab}.png`), image.toPNG());
  }
  // Video quality settings: turn on several qualities and show the choices.
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-tab=settings]').click();
    const box = document.querySelector('input[aria-label="Download several qualities of each video"]');
    box.click();
    box.closest('.card').scrollIntoView();
  })()`);
  await wait(700);
  await shot('settings-quality.png');
  // Hover preview of the first thumbnail.
  const hasThumb = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-tab=downloads]').click();
    const t = document.querySelector('#list-downloads .thumb.has-img');
    t?.dispatchEvent(new MouseEvent('mouseenter'));
    return Boolean(t);
  })()`);
  if (hasThumb) {
    await wait(400);
    await writeFile(path.join(dir, 'preview.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('#list-downloads .thumb.has-img').dispatchEvent(new MouseEvent('mouseleave'))`);
  }
  // Select all + Remove on Downloads (menu only), then remove everything in the Link Grabber.
  await win.webContents.executeJavaScript(`document.querySelector('#btn-dl-select').click();
    document.querySelector('#btn-dl-remove').click();`);
  await wait(400);
  await writeFile(path.join(dir, 'remove-downloads.png'), (await win.webContents.capturePage()).toPNG());
  // "Remove and delete files" asks first (themed dialog); answer Cancel.
  await win.webContents.executeJavaScript(`document.querySelectorAll('.menu button')[1].click()`);
  await wait(400);
  await shot('confirm-delete.png');
  await win.webContents.executeJavaScript(`document.querySelector('#prompt-cancel').click();
    document.querySelector('#btn-dl-select').click();
    document.querySelector('[data-tab=grabber]').click();
    document.querySelector('#btn-grab-select').click();`);
  await wait(400);
  await shot('grabber-selected.png');
  // Clear asks first; confirm, then the empty Link Grabber shows the paste hint.
  await win.webContents.executeJavaScript(`document.querySelector('#btn-clear-grabber').click()`);
  await wait(400);
  await shot('confirm-clear.png');
  await win.webContents.executeJavaScript(`document.querySelector('#prompt-ok').click()`);
  await wait(800);
  await shot('grabber-removed.png');
  // Right-click menu on the first download, then the "Add links" dialog.
  await win.webContents.executeJavaScript(`
    document.querySelector('[data-tab=downloads]').click();
    const row = document.querySelector('#list-downloads .row.link');
    const r = row.getBoundingClientRect();
    const opts = { bubbles: true, button: 2, clientX: r.left + 200, clientY: r.top + 10 };
    row.dispatchEvent(new MouseEvent('mousedown', opts));
    row.dispatchEvent(new MouseEvent('contextmenu', opts));`);
  await wait(400);
  await writeFile(path.join(dir, 'menu.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    document.querySelector('#btn-stop').closest('.toolbar').querySelector('[data-action=add-links]').click();`);
  await wait(600);
  await writeFile(path.join(dir, 'add-dialog.png'), (await win.webContents.capturePage()).toPNG());
  app.quit();
}

function thumbUrl(link) {
  return link.thumbKey ? `adl-thumb://t/${encodeURIComponent(link.thumbKey)}` : null;
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
}
