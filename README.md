# ADownloader

**A JDownloader 2 clone, built with Electron and Node.js.**

ADownloader is a desktop download manager modeled on [JDownloader 2](https://jdownloader.org/). It follows the same design: paste links into a **Link Grabber**, review and check them, then send them to a **download list** where a scheduler downloads them over several connections at once. It was written from scratch in JavaScript and uses a dark blue interface.

> **Not affiliated with JDownloader.** ADownloader is an independent project. It is not made, endorsed or supported by AppWork GmbH or the JDownloader team. "JDownloader" is used here only to describe what this project is modeled on. ADownloader contains no JDownloader source code.

---

## What was carried over from JDownloader 2

| JDownloader 2 feature | In ADownloader |
|---|---|
| **Multi-connection downloads** (chunked downloading) | Splits each file across up to 32 connections. When a connection finishes, it takes over half of the largest remaining chunk, so every connection stays busy to the end. |
| **Pause / resume** | Progress is saved next to the file, so downloads resume after a pause, crash or restart. Restarts cleanly if the file changed on the server. |
| **Link Grabber** | Paste any text, use Ctrl+V anywhere, drop links on the window, or turn on clipboard watching. Links are checked (online/offline, name, size) and grouped into packages before you confirm them. |
| **Download list with packages** | Packages you can collapse, priorities, enable/disable, force start, reset, and remove with or without deleting files. |
| **Download scheduler** | Limits for simultaneous downloads and per website, a global speed limit, and automatic retries after temporary errors. |
| **Plugin system** (host and decrypter plugins) | Host plugins turn a page link into the real file link; crawler plugins expand folders and playlists. Web pages without a plugin are searched for downloadable files. |
| **File host plugins** | Google Drive, Dropbox and MediaFire *(experimental)*. |
| **Video sites** | Uses [yt-dlp](https://github.com/yt-dlp/yt-dlp), which supports YouTube, Vimeo and over a thousand other sites. It downloads the best quality and joins video and audio into an `.mp4`. ADownloader installs and updates yt-dlp itself. |
| **HLS streaming downloads** | Built-in `.m3u8` downloader with AES-128 decryption, parallel segments, resume, and conversion to `.mp4` with ffmpeg. |
| **Extraction extension** | Automatic extraction of zip, rar, 7z and tar, including multi-part archives (`.part1.rar`, `.7z.001`). Tries a saved password list, and can delete archives afterwards. |
| **Clipboard monitoring** | Optional: links you copy anywhere are added to the Link Grabber. |
| **Settings** | Download folder, connections, limits, retries, extraction, video options. Saved automatically. |

### Added in ADownloader (not in JDownloader 2)

- **Thumbnails** for videos: taken from the site, from the page's preview image, or grabbed from the finished file. Hover over one to see it larger.
- **Numbered video folders:** after *N* videos (15 by default), ADownloader asks before continuing in "Folder 2", "Folder 3", and so on.
- **Estimated sizes** for streams that don't report one (shown as `~470 MB`).
- **Several qualities per video (optional):** the default is one file in the best quality. Optionally, you get one file for each quality you tick (4K, 1440p, 1080p, 720p, 480p, 360p, audio-only MP3), but only for qualities the video actually offers.

## What was not added (yet)

- **Most site plugins:** JDownloader has about 1,800. ADownloader has a few file-host plugins, and yt-dlp covers video sites.
- **Accounts:** no premium or multi-host account logins.
- **Captchas:** no captcha solving.
- **Reconnect:** no router reconnect to get a new IP address.
- **Remote control:** no MyJDownloader, Click'n'Load, browser extension or remote API.
- **Container files:** no DLC, CCF or RSDF.
- **Rules:** no Packagizer rules or link filters.
- **Proxy settings, app self-update, translations, and JDownloader's other extensions.**

---

## Getting started

### Requirements

- [Node.js](https://nodejs.org/) 22 or newer
- Windows 10/11. This is where it was developed and tested; macOS and Linux should mostly work but haven't been tested.

Optional, detected automatically:

| Tool | Used for |
|---|---|
| [ffmpeg](https://ffmpeg.org/) (on your `PATH`) | Joining video and audio, converting streams to `.mp4`, thumbnails |
| [7-Zip](https://www.7-zip.org/) | Extracting rar, password-protected and multi-part archives. Without it, the `tar` built into Windows 10/11 handles simple zip, 7z and rar files. |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Video sites. Downloaded and updated by ADownloader itself; it can be turned off in Settings. |

### Install and run

```bash
git clone https://github.com/chuxs/ADownloader.git
cd ADownloader
npm install
npm start
```

### Build an installer (Windows)

```bash
npm run dist
```

This creates two files in `dist/`:

| File | What it is |
|---|---|
| `ADownloader-Setup-<version>.exe` | Installer: lets you choose the install folder, and adds Start menu and desktop shortcuts and an uninstaller |
| `ADownloader-Portable-<version>.exe` | Single file that runs without installing |

The files are not code-signed, so Windows SmartScreen may warn the first time ("More info" → "Run anyway"). The app icon comes from `build/icon.svg`; after changing it, run `npm run icon`.

### Using it

1. Copy one or more links and press **Ctrl+V** in the window, or click **Add links**.
2. The **Link Grabber** checks each link and shows its name, size and status.
3. Click **Start downloads** (or **Add to list**).
4. Follow progress in **Downloads**. Right-click a file for more options.

| Shortcut | Action |
|---|---|
| `Ctrl+V` | Paste links |
| `Ctrl+N` | Add links dialog |
| `Ctrl+1` / `Ctrl+2` | Downloads / Link Grabber tab |
| `Ctrl+A` | Select all |
| `Delete` | Remove selected |
| `Space` | Pause / resume selected |
| `Enter` | Open finished file |

### Command-line tools

These are useful for trying the engine without the app:

```bash
npm run download -- "<file url>" "C:/Users/me/Downloads"   # one file; Ctrl+C pauses, run again to resume
npm run grab -- "<url or text with links>"                 # list what the Link Grabber finds
npm run grab -- "<url>" --download "C:/Users/me/Downloads"  # ...and download it
```

### Tests

```bash
npm test
```

The tests run against local test servers, and some use ffmpeg and 7-Zip when installed. Tests that need a missing tool are skipped.

---

## How it works

```
 paste / clipboard / drop
          │
          ▼
   LinkCrawler ──► plugins (crawler: folders, playlists · host: file pages)
          │        no plugin? → is it a file? a video page (yt-dlp)? a page with files?
          ▼
   LinkGrabber ── online check, packages ── [confirm] ──► DownloadList
                                                             │
                                                             ▼
                                         Scheduler (limits, priorities, retries)
                                                             │  asks the plugin for the real file URL
                                                             ▼
                              Download (HTTP, multi-connection) · HlsDownload · yt-dlp
                                                             │
                                                             ▼
                                            Extraction · Thumbnails · numbered folders
```

| Folder | Contents |
|---|---|
| `src/engine/` | Download engine: chunked HTTP downloads, HLS, speed limits, ffmpeg helpers |
| `src/core/` | Download list, scheduler, thumbnails, numbered folders, JSON storage |
| `src/grabber/` | Link crawler and Link Grabber |
| `src/plugins/` | Plugin registry, a scripted browser for plugins, built-in plugins |
| `src/extraction/` | Archive detection and extraction |
| `src/tools/` | Finding and installing outside tools (yt-dlp, ffmpeg, 7-Zip) |
| `src/main/` | Electron main process: window, settings, IPC |
| `src/renderer/` | The interface (plain HTML/CSS/JS, no framework) |
| `test/` | Tests (`node --test`) |
| `scripts/` | Command-line tools and a screenshot helper |

### Writing a plugin

A plugin is a plain object. Here is a host plugin for a made-up site:

```js
export default {
  id: 'example-host.com',
  name: 'Example Host',
  type: 'host',
  patterns: [/^https?:\/\/(www\.)?example-host\.com\/file\/\w+/],

  // Link Grabber: is the file online, and what is it?
  async check(link, ctx) {
    const page = await ctx.http.get(link.url);
    if (page.contains('File not found')) return { available: false };
    return { available: true, name: page.match(/<h1>([^<]+)<\/h1>/), size: null };
  },

  // Just before downloading: the real file URL (these usually expire).
  async resolve(link, ctx) {
    const page = await ctx.http.get(link.url);
    return { url: page.match(/href="(https:\/\/cdn\.example-host\.com\/[^"]+)"/) };
  },
};
```

Register it in `src/plugins/PluginRegistry.js`. See `src/plugins/builtin/` for real examples, and the `Plugin` type at the top of `PluginRegistry.js` for every option.

---

## Status

ADownloader is an early version. It works and is covered by tests, but expect rough edges.

The file-host plugins (Google Drive, Dropbox, MediaFire) have only been tested against sample pages, not the live sites, so they may need small fixes.

Planned next: accounts, captcha handling, and a remote API.

## License

No license has been chosen yet. Until one is added, all rights are reserved by the author.

JDownloader 2 itself is licensed under GPLv3. ADownloader does not include or translate its code; it reimplements the same ideas independently.
# ADownloader
