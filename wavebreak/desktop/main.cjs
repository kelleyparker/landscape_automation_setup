/**
 * WAVEBREAK desktop shell (Electron).
 *
 * Why Electron and not Tauri: Tauri would produce a ~10 MB binary instead of
 * ~180 MB, but it renders in the OS webview - WKWebView on macOS. This game
 * runs on GLSL3, multiple render targets and half-float textures, and every
 * frame ever verified came out of Chromium. Electron ships that same Chromium,
 * so the desktop build renders what was actually tested. On a Steam download,
 * the size difference does not matter.
 *
 * THE ONE NON-OBVIOUS BIT: the Vite build loads its bundle with
 * `<script type="module" crossorigin src="./assets/...">`. Browsers refuse to
 * load ES modules over file://, so `win.loadFile('index.html')` gives a blank
 * window with a CORS error and no other symptom. We therefore register a
 * privileged `app://` scheme and serve the built files through it. That also
 * gives the page a real origin, so localStorage and the audio context behave
 * exactly as they do on the web build.
 */
const { app, BrowserWindow, protocol, net, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

/**
 * Packaged builds carry the game in `game/` next to this file; running from a
 * checkout uses the sibling `../dist`. Resolved once so a missing build fails
 * loudly at startup instead of as a blank window.
 */
const GAME_ROOT = (() => {
  const packaged = path.join(__dirname, 'game');
  if (fs.existsSync(path.join(packaged, 'index.html'))) return packaged;
  const dev = path.resolve(__dirname, '..', 'dist');
  if (fs.existsSync(path.join(dev, 'index.html'))) return dev;
  return null;
})();

// Must be called before app is ready. `standard` gives the scheme real origin
// semantics; without it fetch, workers and module scripts all misbehave.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/** @type {BrowserWindow | null} */
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 540,
    // Matches the page background so the window never flashes white before the
    // first frame - on a dark, saturated game that flash is very visible.
    backgroundColor: '#0d1b3a',
    title: 'WAVEBREAK',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // The game is pure browser code and never touches Node, so give it none.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // Show only once the renderer has something to paint.
  win.once('ready-to-show', () => win && win.show());

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !win) return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
    // Escape leaves fullscreen rather than quitting - quitting on Escape in a
    // racing game is a reliable way to lose someone's race.
    if (input.key === 'Escape' && win.isFullScreen()) {
      win.setFullScreen(false);
      event.preventDefault();
    }
  });

  // Anything trying to open a new window goes to the real browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });

  if (!GAME_ROOT) {
    win.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<body style="background:#0d1b3a;color:#fff4d6;font:16px system-ui;padding:3rem">' +
            '<h1>No build found</h1><p>Run <code>npm run build</code> in the project root first.</p></body>'
        )
    );
    return;
  }

  win.loadURL('app://-/index.html');

  // Smoke mode: WAVEBREAK_SMOKE=<png path> renders a few seconds of the game,
  // captures the window and exits non-zero if anything failed. This exists
  // because the failure mode this shell is most likely to hit - ES modules
  // blocked over file:// - produces a window that opens perfectly and paints
  // nothing. "The app launched" is not evidence; a frame with pixels in it is.
  const smokeOut = process.env.WAVEBREAK_SMOKE;
  if (smokeOut) runSmokeTest(win, smokeOut);
}

async function runSmokeTest(target, outPath) {
  const failures = [];
  target.webContents.on('console-message', (_e, level, message) => {
    // Errors only (level 3). Warnings are noisy in an unpackaged dev run and
    // Electron emits its own security advisories that vanish once packaged.
    if (level >= 3) failures.push('console: ' + message);
  });
  target.webContents.on('did-fail-load', (_e, code, desc, url) => {
    failures.push('did-fail-load ' + code + ' ' + desc + ' ' + url);
  });
  target.webContents.on('render-process-gone', (_e, details) => {
    failures.push('render-process-gone: ' + JSON.stringify(details));
  });

  try {
    await new Promise((resolve) => target.webContents.once('did-finish-load', resolve));
    // Let the game boot, compile shaders and run a few seconds of race.
    await new Promise((r) => setTimeout(r, 6000));

    const ready = await target.webContents.executeJavaScript(
      'Boolean(window.__wavebreak && window.__wavebreak.ready)'
    );
    if (!ready) failures.push('window.__wavebreak never became ready');

    const image = await target.webContents.capturePage();
    const png = image.toPNG();
    fs.writeFileSync(outPath, png);

    // A blank window still produces a valid PNG, so check the pixels: the
    // background is a single flat colour, and a real frame is not.
    const { width, height } = image.getSize();
    const raw = image.getBitmap();
    const seen = new Set();
    for (let i = 0; i < raw.length; i += 4 * 997) {
      seen.add((raw[i] >> 4) + ',' + (raw[i + 1] >> 4) + ',' + (raw[i + 2] >> 4));
    }
    console.log('[smoke] ' + width + 'x' + height + ', ' + seen.size + ' distinct sampled colours');
    if (seen.size < 8) failures.push('frame looks blank - only ' + seen.size + ' distinct colours');
  } catch (err) {
    failures.push(String((err && err.stack) || err));
  }

  if (failures.length) {
    console.error('[smoke] FAILED');
    for (const f of failures) console.error('  ' + f);
    app.exit(2);
  } else {
    console.log('[smoke] ok -> ' + outPath);
    app.exit(0);
  }
}

app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    const target = path.join(GAME_ROOT ?? '', rel || 'index.html');

    // Path-traversal guard: an app:// URL is attacker-influenceable in
    // principle, and serving arbitrary disk paths from a privileged scheme
    // would be a real hole.
    const root = path.resolve(GAME_ROOT ?? '');
    if (!path.resolve(target).startsWith(root)) {
      return new Response('Forbidden', { status: 403 });
    }

    const response = await net.fetch(pathToFileURL(target).toString());
    // Content-Security-Policy is set here rather than as a <meta> tag in
    // index.html on purpose: the same index.html serves the web build and the
    // Vite dev server, and a strict policy there would fight HMR. Applying it
    // at the desktop scheme keeps the lockdown where it matters - a packaged
    // app with filesystem-adjacent privileges - and leaves the web build alone.
    // 'unsafe-inline' for styles is required: index.html carries its layout CSS
    // inline, and the HUD is a canvas so there is no style injection surface.
    const headers = new Headers(response.headers);
    headers.set(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; " +
        "worker-src 'self' blob:; base-uri 'none'; form-action 'none'"
    );
    return new Response(response.body, { status: response.status, headers });
  });

  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS convention keeps the app alive with no windows; everywhere else quits.
  if (process.platform !== 'darwin') app.quit();
});
