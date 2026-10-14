// Renders build/icon.svg to build/icon.png (512x512, transparent corners) for
// the installer and app icon. Run with: node scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'build');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false });
    await win.loadURL('data:text/html,<canvas width="512" height="512"></canvas>');
    // Draw the SVG on a canvas and export it as PNG (keeps transparency).
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.querySelector('canvas');
        c.getContext('2d').drawImage(img, 0, 0, 512, 512);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('could not load the SVG'));
      img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
    })`);
    fs.writeFileSync(path.join(dir, 'icon.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('wrote build/icon.png');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
