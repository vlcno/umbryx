'use strict';
// Umbryx desktop app: a window of its own around one or more Umbryx servers.
//
// The interface itself is served by each server, so the app never needs updating when features are
// added there. What lives here is everything a browser tab cannot do or would nag about: remembering
// servers, trusting a home server's self-made certificate, granting the microphone without a prompt,
// and offering a screen picker for screen sharing. The app itself updates from those servers too (see
// "updates" below).
//
// The window is split in two. Down the left is a narrow column of saved servers (rail.html), with + to
// add one. The rest shows one server's page. Each server opened in a session keeps its own page in the
// background, so a call on one carries on while you look at another, and each keeps its own sign-in
// because each is its own web address.
const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, Notification, desktopCapturer, dialog, ipcMain, nativeImage, net: chromiumNet, powerMonitor, safeStorage, screen, session, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { pathToFileURL } = require('url');
const games = require('./games');
const presence = require('./presence');
const spotify = require('./spotify');

const ICON = path.join(__dirname, 'icon.ico');
const PRELOAD = path.join(__dirname, 'preload.js');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const GAMES_FILE = path.join(app.getPath('userData'), 'games.json');   // Discord's list of games (games.js)
// What the server's pages may ask for without a prompt. Nothing else is granted, and nothing at all to other sites.
const GRANTED = new Set(['media', 'display-capture', 'speaker-selection', 'fullscreen', 'notifications', 'clipboard-sanitized-write']);
const RAIL_WIDTH = 72;   // the column of servers
const RAIL_TIP_ROOM = 240;   // how much wider (see-through) the column's view gets while it shows a name bubble
const MAC = process.platform === 'darwin';
// On a Mac the red, yellow and green window buttons sit at the top left, inside the column of servers.
const MAC_BUTTONS = MAC ? { trafficLightPosition: { x: 14, y: 11 } } : {};

// The window has no Windows title bar. Each page leaves an empty black strip along the top to drag the
// window by (the server's page from version 1.1 of the app on, and the app's own pages always), and
// Windows lays the minimise, maximise and close buttons over the right-hand end of it in these colours.
const TITLE_BAR = { color: '#000000', symbolColor: '#b9bdc7', height: 34 };
// For a server too old to draw the strip itself: a plain one, so the window can still be moved.
const PLAIN_BAR_SCRIPT = `(() => {
  if (location.protocol === 'file:' || document.getElementById('titlebar')) return;
  const bar = document.createElement('div');
  bar.id = 'titlebar';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;height:${TITLE_BAR.height}px;'
    + 'background:#000;-webkit-app-region:drag';
  document.documentElement.setAttribute('data-plain-bar', '');
  document.documentElement.appendChild(bar);
})()`;
const PLAIN_BAR_CSS = `
  html[data-plain-bar] .app, html[data-plain-bar] .login { height: calc(100dvh - ${TITLE_BAR.height}px) !important; margin-top: ${TITLE_BAR.height}px !important; }
  html[data-plain-bar] .lightbox { top: ${TITLE_BAR.height}px !important; }`;

// servers: [{ address, pin, name, icon }]. pin is the SHA-256 of the one self-made certificate the user agreed
// to trust for that server; name is what the server calls itself and icon the address of its picture on the
// server, remembered for the column. lastVersion is the version of the app that ran last time. shareActivity:
// whether to show the game you are playing; shareSpotify: whether to show what you are listening to on Spotify;
// spotify: the Spotify account connected for it ({ clientId, refresh }, the
// refresh key sealed by sealText).
let settings = { servers: [], current: 0, lastVersion: '', shareActivity: true, shareSpotify: true, spotify: null };
let hadSettings = false;   // false on the very first start, when there is nothing new to tell
let win = null;
let rail = null;            // the column of servers
let setupView = null;       // the "which server?" screen, while it is open
const views = new Map();    // server origin -> its page, created the first time it is opened
const pages = new Map();    // server origin -> { name, unread, ringing }, read from the page's title
// Pages from servers with the 1.4 interface span the whole window: the column of servers lies over their
// left edge, between their title strip and the panels at the bottom of their sidebar (bottom: how tall).
const overlaid = new Map();   // server origin -> { bottom }
const chrome = new Map();     // server origin -> the colours of the theme its page shows
// Pages from 1.4.1 servers on: whether they show Home (Friends and direct messages) or the server's channels,
// and who has written unread direct messages (with their pictures, made small, for the column).
const homes = new Map();      // server origin -> { on, unread: [{ id, name, count, color, icon }] }

let active = null;          // origin of the server on screen, or null while the setup screen is showing
let fullView = null;        // a page showing something full screen covers the whole window
const signedOut = new Set(); // origins whose page is on its sign-in screen (pages from 1.4.18 say so)
const railTold = new Map();  // origin -> whether its page was last told the column is over it
let picking = null;         // resolver for the open screen picker, if any
let appMenu = null;

// On laptops with two graphics chips, run on the fast one so screen share can use its encoder (NVENC).
app.commandLine.appendSwitch('force_high_performance_gpu');
// Windows groups the app's windows, notifications and taskbar button by this ID, and remembers an icon for it.
// A copy run from source is electron.exe, with Electron's icon, so it has an ID of its own.
const APP_ID = app.isPackaged ? 'com.umbryx.app' : 'com.umbryx.app.dev';
app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_event, argv) => {
  // Started again by a click on a notification (Windows): that conversation. Otherwise just come forward.
  const link = argv.find((arg) => String(arg).startsWith(OPEN_LINK));
  if (link) { openFromLink(link); return; }
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

/* ---------- remembered servers ---------- */

const originOf = (address) => new URL(address).origin;
const savedServer = (origin) => settings.servers.find((s) => originOf(s.address) === origin) || null;

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (Array.isArray(saved.servers)) {
      settings.servers = saved.servers
        .filter((s) => s && typeof s.address === 'string' && /^https?:\/\//.test(s.address))
        .map((s) => ({ address: s.address, pin: String(s.pin || ''), name: String(s.name || ''), icon: cleanIcon(s.icon), partner: s.partner === true }));
      settings.current = Number(saved.current) || 0;
      settings.lastVersion = String(saved.lastVersion || '');
      settings.shareActivity = saved.shareActivity !== false;
      // 1.4.6 and 1.4.7 had one switch for both: someone who turned that off keeps Spotify off too.
      settings.shareSpotify = typeof saved.shareSpotify === 'boolean' ? saved.shareSpotify : settings.shareActivity;
      if (saved.spotify && typeof saved.spotify === 'object') settings.spotify = { clientId: String(saved.spotify.clientId || ''), refresh: String(saved.spotify.refresh || '') };
    } else if (saved.address) {
      // Version 1.1 and older remembered a single server.
      settings.servers = [{ address: String(saved.address), pin: String(saved.pin || ''), name: '' }];
    }
    hadSettings = true;
  } catch { /* first run */ }
}

// A picture the column may show: one in a server's uploads (older versions kept a small PNG instead).
function cleanIcon(value) {
  if (typeof value !== 'string') return '';
  if (value.startsWith('data:image/png;base64,') && value.length < 300000) return value;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && url.pathname.startsWith('/uploads/') && value.length < 500 ? url.href : '';
  } catch {
    return '';
  }
}
// The same, and from this server.
const pictureFrom = (origin, address) => { const icon = cleanIcon(address); return icon && icon.startsWith(origin + '/') ? icon : ''; };

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
  } catch { /* the app still works; it will just ask again next time */ }
}

// A server-address.txt next to the exe pre-fills the address, so a host can hand the folder to friends.
// (In the Mac app it is inside the app itself, in Contents/Resources.)
function bundledAddress() {
  for (const folder of [path.dirname(app.getPath('exe')), process.resourcesPath, __dirname]) {
    try {
      for (const line of fs.readFileSync(path.join(folder, 'server-address.txt'), 'utf8').split(/\r?\n/)) {
        const text = line.trim();
        if (text && !text.startsWith('#')) return text;
      }
    } catch { /* no such file */ }
  }
  return '';
}

/* ---------- address handling ---------- */

const bareHost = (url) => url.hostname.replace(/^\[|\]$/g, '');
const isThisComputer = (host) => host === 'localhost' || host === '127.0.0.1' || host === '::1';

// Accepts "192.168.1.50", "chat.example.com", "localhost" or a full address, and fills in the usual ports.
function normalize(text) {
  const typed = String(text || '').trim();
  const example = 'That does not look like a server address. Examples: 192.168.1.50 or chat.example.com';
  if (!typed) throw new Error('Type the address of an Umbryx server.');
  const hasScheme = /^https?:\/\//i.test(typed);
  let url;
  try { url = new URL(hasScheme ? typed : 'https://' + typed); } catch { throw new Error(example); }
  if (!url.hostname) throw new Error(example);
  const local = isThisComputer(bareHost(url));
  if (!hasScheme) {
    // No port typed: the server's own ports are 3000 (plain, this computer only) and 3443 (secure).
    const portTyped = /:\d+$/.test(typed.split('/')[0]);
    url = new URL(`${local ? 'http' : 'https'}://${url.hostname}${portTyped ? ':' + (url.port || 443) : ':' + (local ? 3000 : 3443)}/`);
  } else if (url.protocol === 'http:' && !local) {
    throw new Error(`Use the secure address, or the microphone will not work: https://${url.hostname}:3443`);
  }
  return new URL(url.origin + '/');
}

/* ---------- reaching and trusting a server ---------- */

// Connects once outside the window to see whether the server answers and which certificate it shows.
function probe(url) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error(`Could not reach an Umbryx server at ${url.host}. Check the address, and that the server is running.`));
    const host = bareHost(url);
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const done = (socket, result) => { socket.destroy(); resolve(result); };
    const socket = url.protocol === 'https:'
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }, () => {
        const certificate = socket.getPeerCertificate();
        const fingerprint = certificate && certificate.raw ? crypto.createHash('sha256').update(certificate.raw).digest('hex') : '';
        done(socket, { trusted: socket.authorized, fingerprint });
      })
      : net.connect({ host, port }, () => done(socket, { trusted: true, fingerprint: '' }));
    socket.setTimeout(7000, () => { socket.destroy(); fail(); });
    socket.on('error', fail);
  });
}

// A home server makes its own certificate, which nothing trusts by default. The first time, ask; after
// that accept exactly that certificate and warn if it ever changes. Returns the pin to remember.
async function decideTrust(url, found, known) {
  if (url.protocol !== 'https:' || found.trusted) return '';
  if (!found.fingerprint) throw new Error("The server's security certificate could not be read.");
  if (known === found.fingerprint) return known;
  const short = found.fingerprint.slice(0, 16).toUpperCase().match(/../g).join(':');
  const { response } = await dialog.showMessageBox(win, {
    type: known ? 'warning' : 'question',
    title: 'Umbryx',
    buttons: ['Trust and connect', 'Cancel'],
    defaultId: known ? 1 : 0,
    cancelId: 1,
    noLink: true,
    message: known ? `The security certificate of ${url.host} has changed.` : `Trust ${url.host}?`,
    detail: (known
      ? 'That is expected if the server was reinstalled or moved. If it was not, someone may be pretending to be the server.'
      : 'This server uses its own security certificate, which is normal for a home server.')
      + `\n\nCertificate: ${short}`,
  });
  if (response !== 0) throw new Error("Not connected: the server's certificate was not trusted.");
  return found.fingerprint;
}

// Adds a server by its address (or finds it again if it is saved already), and shows it.
async function connect(address) {
  const url = normalize(address);
  const saved = savedServer(url.origin);
  const pin = await decideTrust(url, await probe(url), saved ? saved.pin : '');
  if (saved) saved.pin = pin;
  else settings.servers.push({ address: url.href, pin, name: '' });
  saveSettings();
  showServer(url.origin);
}

// Opens a saved server. The first time in a session its certificate is checked again, so a changed one
// is noticed before the page loads.
async function openServer(origin) {
  const saved = savedServer(origin);
  if (!saved) return;
  if (views.has(origin)) { showServer(origin); return; }
  try {
    const url = new URL(saved.address);
    const pin = await decideTrust(url, await probe(url), saved.pin);
    if (pin !== saved.pin) { saved.pin = pin; saveSettings(); }
    showServer(origin);
  } catch (err) {
    showSetup(err.message, saved.address);
  }
}

/* ---------- what the server's pages are allowed to do ---------- */

// Only the servers on the list get the microphone, the camera, screen sharing and the rest.
function fromServer(urlString) {
  try { return !!savedServer(new URL(urlString).origin); } catch { return false; }
}

function pemToDer(pem) {
  return Buffer.from(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

function guardSession() {
  const ses = session.defaultSession;

  // Accept a pinned certificate for its own server, and leave every other decision to the normal checks.
  ses.setCertificateVerifyProc((request, callback) => {
    const seen = crypto.createHash('sha256').update(pemToDer(request.certificate.data)).digest('hex');
    const pinned = settings.servers.some((s) => {
      try { return s.pin && s.pin === seen && bareHost(new URL(s.address)) === request.hostname; } catch { return false; }
    });
    callback(pinned ? 0 : -3);
  });

  // Microphone, speakers, full screen and so on: yes for the servers, without a prompt. No for anything else.
  // YouTube's player, inside a server's page (link previews), may go full screen too, and nothing else.
  const youTubeFullScreen = (contents, permission, url) => permission === 'fullscreen' && !!contents && fromServer(contents.getURL())
    && /^https:\/\/www\.youtube-nocookie\.com(\/|$)/.test(String(url || ''));
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback((GRANTED.has(permission) && fromServer(details.requestingUrl || contents.getURL())) || youTubeFullScreen(contents, permission, details.requestingUrl));
  });
  ses.setPermissionCheckHandler((contents, permission, origin) => (GRANTED.has(permission) && fromServer(origin)) || youTubeFullScreen(contents, permission, origin));

  // Screen sharing: show our own picker, then hand the chosen screen or window to the page.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const refuse = () => { try { callback(null); } catch { try { callback({}); } catch { /* already refused */ } } };
    try {
      if (!fromServer(request.frame ? request.frame.url : request.securityOrigin)) { refuse(); return; }
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 384, height: 216 } });
      // A Mac hands an app the picture of a screen but not its sound, so the picker does not offer it there.
      const choice = await pickSource(sources, request.audioRequested && !MAC);
      const source = choice && sources.find((s) => s.id === choice.id);
      if (!source) { refuse(); return; }
      // 'loopback' is the sound of the whole computer, the only kind Windows offers an app like this.
      callback(request.audioRequested && choice.audio && !MAC ? { video: source, audio: 'loopback' } : { video: source });
    } catch {
      refuse();
    }
  });
}

/* ---------- HDR screens ---------- */

// A stream is always SDR, so an HDR screen has to be converted on the way in. Windows does that
// conversion itself when a screen is captured through Windows Graphics Capture, which the capture
// engine uses for whole screens from Windows 11 24H2 (build 26100) onwards, and for single windows on
// every version. On older Windows a whole HDR screen goes through the legacy path, which gets the
// brightness wrong, so the picker steers people to sharing the window instead.
const WINDOWS_BUILD = process.platform === 'win32' ? Number(os.release().split('.')[2]) || 0 : 0;
const HDR_SCREENS_CONVERTED = !WINDOWS_BUILD || WINDOWS_BUILD >= 26100;   // the warning is about Windows only

function isHdrDisplay(display) {
  return !!display && (display.depthPerComponent > 8 || /HDR|PQ|HLG/i.test(String(display.colorSpace)));
}

function hdrDisplayIds() {
  return new Set(screen.getAllDisplays().filter(isHdrDisplay).map((d) => String(d.id)));
}

/* ---------- screen picker ---------- */

function pickSource(sources, audioWanted) {
  return new Promise((resolve) => {
    if (picking) { resolve(null); return; }
    const picker = new BrowserWindow({
      parent: win, modal: true, width: 820, height: 620, minWidth: 520, minHeight: 420,
      title: 'Share your screen', icon: ICON, backgroundColor: '#000000', autoHideMenuBar: true,
      titleBarStyle: 'hidden', titleBarOverlay: TITLE_BAR, ...MAC_BUTTONS,
      minimizable: false, maximizable: false, show: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
    });
    picker.setMenu(null);
    picking = (choice) => {
      picking = null;
      resolve(choice);
      if (!picker.isDestroyed()) picker.close();
    };
    picker.on('closed', () => { if (picking) { picking = null; resolve(null); } });
    picker.once('ready-to-show', () => picker.show());
    picker.webContents.once('did-finish-load', () => {
      const hdr = hdrDisplayIds();
      picker.webContents.send('picker:sources', {
        audioWanted,
        hdrScreensConverted: HDR_SCREENS_CONVERTED,
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name,
          screen: s.id.startsWith('screen:'),
          hdr: s.id.startsWith('screen:') && hdr.has(String(s.display_id)),
          thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        })),
      });
    });
    picker.loadFile(path.join(__dirname, 'picker.html'));
  });
}

/* ---------- updates ---------- */

// Every few hours the app asks the servers it knows for /updates/latest.json, the description of the newest
// version of the app, signed by its publisher (tools/publish_update.py). Below is the public half of the
// publisher's key: it can check a signature but not make one, so a server can pass an update on but never
// make one up or change one. Anything not signed with the private half is ignored.
//
// A new version is downloaded in the background and checked against its description, and then a green
// button at the bottom of the column of servers offers to restart. It never restarts by itself. Usually only
// the app's own code changes (app.asar, a few hundred KB, the same for Windows and Mac); when the Electron
// underneath changes too, the whole app is downloaded instead. Either way a small helper waits for the app
// to close, puts the new files in place (keeping server-address.txt), and opens it again.
const UPDATE_KEY = crypto.createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from('hOjCJhEHyp0qFTcFaDyoitsgiT/fAMSnUJp3em6YgRA=', 'base64')]),
  format: 'der', type: 'spki',
});
const UPDATE_DIR = path.join(app.getPath('userData'), 'update');
const UPDATE_FIRST = 15 * 1000;            // after starting
const UPDATE_EVERY = 60 * 60 * 1000;
const UPDATE_ON_RETURN = 15 * 60 * 1000;   // coming back to the window after this long checks again
let updateCheckedAt = 0;
const UPDATE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const PLATFORM = `${process.platform}-${process.arch}`;
let update = null;           // the version that is downloaded, checked and ready: { version, kind, source, notes }
let updateBusy = null;       // the check or download in progress
let updateApplying = false;

const versionParts = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
function isNewer(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// Where this copy of the app is, or null if it cannot update itself (run from the source folder).
function installed() {
  if (!app.isPackaged) return null;
  const bundle = MAC ? path.resolve(process.execPath, '../../..') : path.dirname(process.execPath);
  if (MAC && !bundle.endsWith('.app')) return null;
  return { bundle, resources: process.resourcesPath, exe: process.execPath };
}

function writable(folder) {
  const probe = path.join(folder, `.umbryx-write-test-${process.pid}`);
  try { fs.writeFileSync(probe, ''); fs.unlinkSync(probe); return true; } catch { return false; }
}

// Deletes a downloaded update. One that holds a whole app has an app.asar inside, which Electron would
// otherwise treat as a folder to look into rather than a file to delete.
function removeQuietly(target) {
  const before = process.noAsar;
  process.noAsar = true;
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* tried again next start */ } finally { process.noAsar = before; }
}

// What an earlier start left behind: updates since installed, or half-finished downloads.
function tidyUpdates() {
  let names = [];
  try { names = fs.readdirSync(UPDATE_DIR); } catch { return; }
  for (const name of names) {
    const hit = name.match(/^(?:app|full)-(\d+\.\d+\.\d+)(?:\.bin|\.zip)?$/);
    if (!hit || !isNewer(hit[1], app.getVersion())) removeQuietly(path.join(UPDATE_DIR, name));
  }
}

// The newest properly signed version a server offers, or null.
async function latestFrom(origin) {
  const response = await chromiumNet.fetch(origin + '/updates/latest.json', { cache: 'no-store' });
  if (!response.ok) return null;
  const saved = await response.json();
  const text = String(saved.manifest || '');
  const signature = Buffer.from(String(saved.signature || ''), 'base64');
  if (!crypto.verify(null, Buffer.from(text, 'utf8'), UPDATE_KEY, signature)) return null;
  const manifest = JSON.parse(text);
  return manifest && manifest.product === 'umbryx-desktop' && /^\d+\.\d+\.\d+$/.test(manifest.version) ? { manifest, origin } : null;
}

// The app's own code when the Electron underneath is the same, the whole app when it is not.
function packageFor(manifest) {
  const sameEngine = manifest.electron === process.versions.electron;
  const pkg = (manifest.packages || {})[sameEngine ? 'app' : PLATFORM];
  if (!pkg || !UPDATE_FILE.test(String(pkg.file)) || !(pkg.size > 0 && pkg.size <= 600 * 1048576) || !/^[0-9a-f]{64}$/.test(String(pkg.sha256))) return null;
  return { file: pkg.file, size: pkg.size, sha256: pkg.sha256, kind: sameEngine ? 'app' : 'full' };
}

function sha256Of(file) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', () => resolve('')).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

async function download(origin, pkg, target) {
  if (await sha256Of(target) === pkg.sha256) return;   // already downloaded on an earlier run
  const partial = target + '.part';
  const response = await chromiumNet.fetch(`${origin}/updates/${encodeURIComponent(pkg.file)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`the server answered ${response.status}`);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(partial);
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > pkg.size) throw new Error('the download is larger than described');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (size !== pkg.size || hash.digest('hex') !== pkg.sha256) throw new Error('the download does not match its description');
    fs.renameSync(partial, target);
  } catch (err) {
    out.destroy();
    fs.rmSync(partial, { force: true });
    throw err;
  }
}

function unpack(zip, folder) {
  return new Promise((resolve, reject) => {
    const [command, args] = MAC
      ? ['/usr/bin/ditto', ['-x', '-k', zip, folder]]
      : [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', folder]];
    execFile(command, args, { windowsHide: true, timeout: 10 * 60 * 1000 }, (err) => (err ? reject(err) : resolve()));
  });
}

// Asks the servers, and downloads and checks a newer version if there is one. Resolves to what happened:
// { ready } with the version, { none }, or { problem } with a sentence saying why not. onDownload, if given,
// hears the version number as a download starts.
function checkForUpdate(onDownload) {
  if (!updateBusy) {
    updateCheckedAt = Date.now();
    updateBusy = findAndFetch(onDownload).finally(() => { updateBusy = null; updateRail(); });
  }
  return updateBusy;
}

async function findAndFetch(onDownload) {
  const place = installed();
  if (!place) return { problem: 'This copy of Umbryx runs from its source folder, so it does not update itself.' };
  let best = null;
  for (const saved of settings.servers) {
    try {
      const found = await latestFrom(originOf(saved.address));
      if (found && isNewer(found.manifest.version, app.getVersion()) && (!best || isNewer(found.manifest.version, best.manifest.version))) best = found;
    } catch { /* that server is off, or older than updates */ }
  }
  if (!best) return update ? { ready: update.version } : { none: true };
  const { manifest, origin } = best;
  if (update && update.version === manifest.version) return { ready: update.version };
  const pkg = packageFor(manifest);
  if (!pkg) return { problem: `Version ${manifest.version} is out, but not for this computer. Download it by hand.` };
  const folders = pkg.kind === 'app' ? [place.resources] : MAC ? [place.bundle, path.dirname(place.bundle)] : [place.bundle];
  const locked = folders.find((folder) => !writable(folder));
  if (locked) return { problem: `Version ${manifest.version} is out, but Umbryx may not change the files in ${locked}. Move the app somewhere of your own, or install the new version by hand.` };

  if (typeof onDownload === 'function') onDownload(manifest.version);
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    const file = path.join(UPDATE_DIR, `${pkg.kind}-${manifest.version}.${pkg.kind === 'app' ? 'bin' : 'zip'}`);
    await download(origin, pkg, file);
    let source = file;
    if (pkg.kind === 'full') {
      const folder = path.join(UPDATE_DIR, `full-${manifest.version}`);
      removeQuietly(folder);
      fs.mkdirSync(folder, { recursive: true });
      await unpack(file, folder);
      source = path.join(folder, MAC ? 'Umbryx.app' : 'Umbryx');
      if (!fs.existsSync(MAC ? path.join(source, 'Contents', 'MacOS', 'Umbryx') : path.join(source, 'Umbryx.exe'))) throw new Error('the download does not hold the app');
    }
    update = { version: manifest.version, kind: pkg.kind, source, notes: String(manifest.notes || '') };
    return { ready: update.version };
  } catch (err) {
    console.error('update:', err);
    return { problem: `Version ${manifest.version} could not be downloaded (${err.message}). Umbryx tries again later.` };
  }
}

const psQuote = (text) => `'${String(text).replace(/'/g, "''")}'`;
// One command-line argument, quoted the way Windows programs read them back.
const windowsArg = (arg) => (/^[^\s"]+$/.test(arg) ? arg : `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);

// Windows: PowerShell, which every Windows has, run hidden. app.asar is copied in beside the old one and then
// swapped for it in one step, so a failure leaves the old version working; the whole app is copied over with
// robocopy, which retries while the last of the closing app's files are still in use.
function windowsHelper(place, ready) {
  const lines = [
    `Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue`,
    'Start-Sleep -Milliseconds 300',   // the last of its helper processes; the copy below retries if one lingers
  ];
  if (ready.kind === 'app') {
    lines.push(
      `$asar = ${psQuote(path.join(place.resources, 'app.asar'))}`,
      'for ($i = 0; $i -lt 40; $i++) {',
      `  try { [IO.File]::Copy(${psQuote(ready.source)}, "$asar.new", $true); [IO.File]::Replace("$asar.new", $asar, [NullString]::Value); break }`,
      '  catch { Start-Sleep -Milliseconds 500 }',
      '}',
      'Remove-Item -LiteralPath "$asar.new" -Force -ErrorAction SilentlyContinue',
    );
  } else {
    lines.push(`robocopy ${psQuote(ready.source)} ${psQuote(place.bundle)} /E /XF server-address.txt /R:40 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null`);
  }
  // Opened again the way it was opened this time (normally with nothing extra).
  const args = process.argv.slice(1).map(windowsArg).join(' ');
  lines.push(`Start-Process -FilePath ${psQuote(place.exe)}` + (args ? ` -ArgumentList ${psQuote(args)}` : ''));
  // It is started in two steps. A PowerShell started fully detached never runs its command, and one started
  // the usual way is closed along with the app; so a short-lived one starts the helper with Start-Process,
  // which puts it outside the app's group of processes, and the app waits for that before it closes.
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');
  const launcher = `Start-Process -FilePath ${psQuote(powershell)} -WindowStyle Hidden -ArgumentList `
    + `'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encode(lines.join('\n'))}'`;
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(launcher)],
      { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('PowerShell did not start the update in time.')); }, 20000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`PowerShell stopped with code ${code}.`)); });
  });
}

// Mac: the shell. Changing an app's files breaks its signature, so the local signature is made again (the
// same step as when it was installed), and then the app opens. macOS may ask again for the microphone and
// camera afterwards, because to it a re-signed app is a new one.
const MAC_HELPER = `
pid="$1"; kind="$2"; source="$3"; bundle="$4"
case "$bundle" in /*.app) ;; *) exit 1 ;; esac
while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
sleep 0.3
if [ "$kind" = app ]; then
  cp "$source" "$bundle/Contents/Resources/app.asar.new" && mv -f "$bundle/Contents/Resources/app.asar.new" "$bundle/Contents/Resources/app.asar"
else
  cp "$bundle/Contents/Resources/server-address.txt" "$source/Contents/Resources/" 2>/dev/null
  if mv "$bundle" "$bundle.replaced"; then
    if mv "$source" "$bundle"; then rm -rf "$bundle.replaced"; else mv "$bundle.replaced" "$bundle"; fi
  fi
fi
xattr -cr "$bundle"
codesign --force --deep --sign - "$bundle"
open "$bundle"
`;

async function macHelper(place, ready) {
  spawn('/bin/sh', ['-c', MAC_HELPER, 'umbryx-update', String(process.pid), ready.kind, ready.source, place.bundle],
    { detached: true, stdio: 'ignore' }).unref();
}

// What each server's page would lose by a restart: 'none', 'rejoin' (a voice channel it joins again by itself when
// the app is back, pages from 1.4.14 on) or 'call' (a one-on-one call, or voice on an older page: that ends).
async function restartPlans() {
  const plans = [];
  for (const view of views.values()) {
    try {
      plans.push(await view.webContents.executeJavaScript(
        "(() => { const u = window.__umbryx; if (!u || !u.rtc || !u.rtc.channel) return 'none'; return u.restartPlan ? u.restartPlan() : 'call'; })()"));
    } catch { plans.push('none'); }   // that page is still loading
  }
  return plans;
}

async function restartToUpdate() {
  const place = installed();
  if (!update || !place || updateApplying || !win) return;
  // In a voice channel there is nothing to ask: Umbryx comes back into it. Only a call would be left.
  if ((await restartPlans()).includes('call')) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', title: 'Umbryx', buttons: ['Restart now', 'Later'], defaultId: 1, cancelId: 1, noLink: true,
      message: 'Restart now? You will leave the call.',
      detail: `Version ${update.version} is ready. The green button stays until you restart, so it can wait until the call is over.`,
    });
    if (response !== 0) return;
  }
  for (const view of views.values()) {
    try { await view.webContents.executeJavaScript('window.__umbryx && window.__umbryx.beforeRestart ? window.__umbryx.beforeRestart() : null'); } catch { /* still loading */ }
  }
  updateApplying = true;
  // The window goes the moment the button is clicked; starting the helper (a second or so on Windows) and
  // the swap happen behind it, and Umbryx reopens on the new version a few seconds later.
  win.hide();
  try {
    await (MAC ? macHelper : windowsHelper)(place, update);
  } catch (err) {
    updateApplying = false;
    win.show();
    dialog.showMessageBox(win, { type: 'error', title: 'Umbryx', message: 'The update could not be started.', detail: String(err.message || err) });
    return;
  }
  app.quit();
}

// "Check for updates" in the app's menu: the same check, with an answer either way.
async function checkFromMenu() {
  const ask = (options) => dialog.showMessageBox(win, { title: 'Umbryx', noLink: true, ...options });
  // A long download (the whole app) is announced, and then the green button says when it is done.
  let slow = null, announced = false;
  const result = await checkForUpdate((version) => {
    slow = setTimeout(() => {
      announced = true;
      ask({ type: 'info', message: `Downloading version ${version}…`, detail: 'A green button appears at the bottom of the column of servers when it is ready. Click it to restart.' });
    }, 2500);
  });
  clearTimeout(slow);
  if (result.ready && announced) return;
  if (result.ready) {
    const { response } = await ask({
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      message: `Version ${result.ready} is ready.`, detail: (update && update.notes ? update.notes + '\n\n' : '') + `You have ${app.getVersion()}. Restarting takes a few seconds.`,
    });
    if (response === 0) restartToUpdate();
  } else if (result.none) {
    ask({ type: 'info', message: 'Umbryx is up to date.', detail: `Version ${app.getVersion()}` });
  } else {
    ask({ type: 'warning', message: 'No update right now.', detail: result.problem });
  }
}

function startUpdateChecks() {
  if (!installed()) return;
  tidyUpdates();
  setTimeout(checkForUpdate, UPDATE_FIRST);
  setInterval(checkForUpdate, UPDATE_EVERY);
  // Back at the window after a while: look again.
  if (win) win.on('focus', () => { if (Date.now() - updateCheckedAt > UPDATE_ON_RETURN) checkForUpdate(); });
}

/* ---------- the window: the column of servers, and the server on screen ---------- */

const contentsOf = () => [rail, setupView, ...views.values()].filter(Boolean).map((v) => v.webContents);
const activeContents = () => (setupView ? setupView.webContents : active && views.has(active) ? views.get(active).webContents : null);

let railStrip = null;
let railTip = false;   // the column shows a name bubble beside itself (rail.js)
function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  const whole = { x: 0, y: 0, width, height };
  const beside = { x: RAIL_WIDTH, y: 0, width: Math.max(0, width - RAIL_WIDTH), height };
  // The only server, on its sign-in screen: no column, so there is nothing but the sign-in form (with other
  // servers it stays, to switch to them).
  const bare = !setupView && !!active && signedOut.has(active) && settings.servers.length <= 1;
  for (const [origin, view] of views) {
    view.setBounds(fullView === view || overlaid.has(origin) || (bare && origin === active) ? whole : beside);
    const over = !(bare && origin === active);
    if (railTold.get(origin) !== over) {
      railTold.set(origin, over);
      view.webContents.send('app:rail', over);
    }
  }
  if (setupView) setupView.setBounds(beside);
  // Beside an older server's page (and the setup screen) the column runs the full height, with its own strip to
  // drag the window by. Over a newer page it sits between the page's title strip and its bottom panels.
  const over = !setupView && active ? overlaid.get(active) : null;
  const railWide = RAIL_WIDTH + (railTip ? RAIL_TIP_ROOM : 0);
  rail.setBounds(over
    ? { x: 0, y: TITLE_BAR.height + (over.top || 0), width: railWide, height: Math.max(0, height - TITLE_BAR.height - (over.top || 0) - over.bottom) }
    : { x: 0, y: 0, width: railWide, height });
  rail.setVisible(!fullView && !bare);
  if (railStrip !== !over) {
    railStrip = !over;
    rail.webContents.send('rail:mode', { strip: railStrip });
  }
}

// The window's colours follow the theme of the page on screen: the column of servers, and on Windows the
// minimise, maximise and close buttons.
const DEFAULT_CHROME = { bg: '#000000', raised: '#0d0d10', hover: '#17171b', line: '#1e1e23', text: '#eceef2', dim: '#b9bdc7', accent: '#f2b24a', accentInk: '#1d1403' };
let chromeShown = '';
function applyChrome() {
  if (!win) return;
  const colors = (!setupView && active && chrome.get(active)) || DEFAULT_CHROME;
  const key = JSON.stringify(colors);
  if (key === chromeShown) return;
  chromeShown = key;
  rail.webContents.send('rail:theme', colors);
  win.setBackgroundColor(colors.bg);
  if (!MAC) {
    try { win.setTitleBarOverlay({ color: colors.bg, symbolColor: colors === DEFAULT_CHROME ? TITLE_BAR.symbolColor : colors.dim, height: TITLE_BAR.height }); }
    catch { /* an older Windows without the overlay */ }
  }
}

// What the column shows: each server's name, whether it is the one on screen, unread messages and calls.
function updateRail() {
  if (!rail) return;
  const home = !setupView && active && !signedOut.has(active) ? homes.get(active) : null;   // nothing of a signed-out account
  rail.webContents.send('rail:servers', {
    adding: !!setupView,
    home: home ? { active: home.on, unread: home.unread } : null,
    update: update ? { version: update.version, current: app.getVersion() } : null,
    servers: settings.servers.map((s, index) => {
      const origin = originOf(s.address);
      const page = pages.get(origin) || {};
      return { index, address: s.address, name: page.name || s.name || new URL(s.address).hostname, icon: s.icon || '', partner: s.partner === true,
        active: origin === active && !setupView && !(home && home.on), unread: page.unread || 0, ringing: !!page.ringing };
    }),
  });
}

// The page's title says what the column needs: "(3) Server name" for unread messages, and
// "Incoming call · ..." while a call rings.
function readTitle(origin, title) {
  const ringing = /^Incoming call · /.test(title);
  const rest = title.replace(/^Incoming call · /, '');
  const hit = rest.match(/^\((\d+)\) (.*)$/);
  const page = { name: (hit ? hit[2] : rest).trim(), unread: hit ? Number(hit[1]) : 0, ringing, title };
  pages.set(origin, page);
  const saved = savedServer(origin);
  if (saved && page.name && page.name !== 'Umbryx' && saved.name !== page.name) { saved.name = page.name; saveSettings(); }
  if (origin === active && !setupView) win.setTitle(title);
  if (ringing && !win.isFocused()) win.flashFrame(true);   // a call while the window is in the background
  updateRail();
}

// Ctrl+R, zoom and the rest. The window has no menu bar, so these are caught as they are pressed.
function shortcuts(event, input) {
  if (input.type !== 'keyDown') return;
  const ctrl = input.control || input.meta;
  const key = String(input.key).toLowerCase();
  const contents = activeContents();
  let run = null;
  if (ctrl && !input.shift && key === 'r') run = () => contents && contents.reload();
  else if (ctrl && input.shift && key === 's') run = () => showSetup('');
  else if (ctrl && (key === '=' || key === '+')) run = () => contents && contents.setZoomLevel(contents.getZoomLevel() + 0.5);
  else if (ctrl && key === '-') run = () => contents && contents.setZoomLevel(contents.getZoomLevel() - 0.5);
  else if (ctrl && key === '0') run = () => contents && contents.setZoomLevel(0);
  else if (key === 'f11') run = () => win.setFullScreen(!win.isFullScreen());
  else if (ctrl && input.shift && key === 'i') run = () => contents && contents.toggleDevTools();
  if (run) { event.preventDefault(); run(); }
}

function makeView() {
  const view = new WebContentsView({
    webPreferences: {
      preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false,   // keep calls running while the window is minimised or another server is shown
    },
  });
  view.setBackgroundColor('#000000');
  view.webContents.on('before-input-event', shortcuts);
  win.contentView.addChildView(view);
  if (rail) win.contentView.addChildView(rail);   // adding it again puts the column back on top
  return view;
}

function dropView(view) {
  if (!view) return;
  if (fullView === view) fullView = null;
  win.contentView.removeChildView(view);
  view.webContents.close();
}

// Links in chat open in the normal browser; a server's page only ever shows that server.
const external = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };

function serverView(origin) {
  const view = makeView();
  views.set(origin, view);
  const contents = view.webContents;
  contents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  contents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin === origin) return; } catch { /* not a web address */ }
    event.preventDefault();
    external(url);
  });
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    const saved = savedServer(origin);
    views.delete(origin);
    pages.delete(origin);
    dropView(view);
    if (origin === active) showSetup(`The server stopped answering (${description}).`, saved ? saved.address : '');
    else updateRail();
  });
  contents.on('dom-ready', () => {
    contents.insertCSS(PLAIN_BAR_CSS).catch(() => {});
    contents.executeJavaScript(PLAIN_BAR_SCRIPT).catch(() => {});
  });
  contents.on('page-title-updated', (_event, title) => readTitle(origin, title));
  // A reload starts again beside the column, until the new page says it can have the column over it.
  contents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    overlaid.delete(origin);
    chrome.delete(origin);
    homes.delete(origin);
    signedOut.delete(origin);
    railTold.delete(origin);
    layout();
    applyChrome();
    updateRail();
  });
  contents.on('did-finish-load', tellShown);
  contents.on('did-finish-load', () => tellFocus());   // a page that has just loaded hears it at once
  // A video or screen share put full screen covers the whole window, the column of servers included.
  contents.on('enter-html-full-screen', () => { fullView = view; layout(); });
  contents.on('leave-html-full-screen', () => { if (fullView === view) fullView = null; layout(); });
  contents.loadURL(origin + '/');
  return view;
}

// Tells each server's page whether it is the one on screen, so it can count unread messages while it is not.
function tellShown() {
  const showing = win && !win.isMinimized() && !setupView ? active : null;
  for (const [origin, view] of views) view.webContents.send('app:shown', origin === showing);
}

// Whether the window is the one in use (from 1.4.17): the pages let moving pictures rest while it is not.
function tellFocus(focused = !!win && win.isFocused()) {
  for (const view of views.values()) view.webContents.send('app:focus', focused);
}

function showServer(origin) {
  const view = views.get(origin) || serverView(origin);
  if (setupView) { dropView(setupView); setupView = null; }
  for (const [o, v] of views) v.setVisible(o === origin);
  active = origin;
  tellShown();
  settings.current = Math.max(0, settings.servers.findIndex((s) => originOf(s.address) === origin));
  saveSettings();
  const page = pages.get(origin);
  win.setTitle(page && page.title ? page.title : 'Umbryx');
  layout();
  applyChrome();
  updateRail();
  view.webContents.focus();
}

// The "which server?" screen: first run, adding a server, or when a server cannot be reached.
function showSetup(problem, address) {
  if (!setupView) {
    setupView = makeView();
    setupView.webContents.on('page-title-updated', (event) => event.preventDefault());
  }
  for (const v of views.values()) v.setVisible(false);
  tellShown();
  setupView.webContents.loadFile(path.join(__dirname, 'setup.html'), {
    query: { problem: problem || '', address: address || (settings.servers.length ? '' : bundledAddress()), cancel: settings.servers.length ? '1' : '' },
  });
  win.setTitle('Umbryx');
  layout();
  applyChrome();
  updateRail();
  setupView.webContents.focus();
}

function closeSetup() {
  const saved = settings.servers[settings.current] || settings.servers[0];
  if (saved) openServer(originOf(saved.address));
}

function removeServer(index) {
  const saved = settings.servers[index];
  if (!saved) return;
  const origin = originOf(saved.address);
  settings.servers.splice(index, 1);
  saveSettings();
  if (views.has(origin)) { dropView(views.get(origin)); views.delete(origin); }
  pages.delete(origin);
  overlaid.delete(origin);
  chrome.delete(origin);
  homes.delete(origin);
  signedOut.delete(origin);
  railTold.delete(origin);
  if (active === origin) {
    active = null;
    const next = settings.servers[Math.min(index, settings.servers.length - 1)];
    if (next) openServer(originOf(next.address)); else showSetup('');
  } else updateRail();
}

function createWindow() {
  win = new BaseWindow({
    width: 1390, height: 860, minWidth: 500, minHeight: 520,
    title: 'Umbryx', icon: ICON, backgroundColor: '#000000',
    titleBarStyle: 'hidden', titleBarOverlay: TITLE_BAR, ...MAC_BUTTONS,
  });
  // The taskbar button's picture, said on the window itself: it wins over any icon Windows remembered for the app
  // (one remembered from Electron's would otherwise stay).
  if (process.platform === 'win32' && app.isPackaged) {
    try {
      win.setAppDetails({ appId: APP_ID, appIconPath: iconFile(), appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'Umbryx' });
    } catch (err) { console.error('taskbar details:', err); }
  }
  rail = new WebContentsView({ webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  rail.setBackgroundColor('#00000000');   // see-through: over a newer page, its theme's gradient or picture shows behind the column
  rail.webContents.on('before-input-event', shortcuts);
  win.contentView.addChildView(rail);
  rail.webContents.loadFile(path.join(__dirname, 'rail.html'));
  win.on('resize', layout);
  win.on('focus', () => win.flashFrame(false));
  win.on('focus', () => tellFocus(true));
  win.on('blur', () => tellFocus(false));
  win.on('minimize', tellShown);
  win.on('restore', tellShown);
  win.on('closed', () => { win = null; app.quit(); });
  layout();
}

function buildMenu() {
  // On Windows never shown as a bar: it opens from a button in the interface's Settings, and its shortcuts
  // are caught as they are pressed (see shortcuts above). A Mac always has a menu bar, and needs its Edit
  // menu for copy and paste to work at all, so there it is the usual one with these items under View.
  const contents = () => activeContents();
  const items = [
    { label: 'Add a server…', accelerator: 'CmdOrCtrl+Shift+S', click: () => showSetup('') },
    { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => contents() && contents().reload() },
    { type: 'separator' },
    { label: 'Full screen', accelerator: 'F11', click: () => win.setFullScreen(!win.isFullScreen()) },
    { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => contents() && contents().setZoomLevel(contents().getZoomLevel() + 0.5) },
    { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => contents() && contents().setZoomLevel(contents().getZoomLevel() - 0.5) },
    { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => contents() && contents().setZoomLevel(0) },
    { type: 'separator' },
    { label: 'Developer tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => contents() && contents().toggleDevTools() },
    { type: 'separator' },
    { label: 'Check for updates…', click: checkFromMenu },
    { label: "What's new", click: () => showWhatsNew() },
    { label: `Version ${app.getVersion()}`, enabled: false },
  ];
  appMenu = Menu.buildFromTemplate([...items, { type: 'separator' }, { label: 'Quit', click: () => app.quit() }]);
  if (!MAC) { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: items },
    { label: 'Window', submenu: [
      { role: 'minimize' },
      { label: 'Close window', accelerator: 'Cmd+W', click: () => win && win.close() },
    ] },
  ]));
}

/* ---------- what's new ---------- */

// After an update, a small window says what changed. The notes are whats-new.json, inside the app, so each
// version brings its own. Shown once, the first time the new version starts; the app menu can show it again.
function notesFor(version) {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'whats-new.json'), 'utf8'));
    const notes = Array.isArray(all[version]) ? all[version] : null;
    return notes && notes.filter((n) => n && typeof n.title === 'string' && typeof n.text === 'string');
  } catch {
    return null;
  }
}

let whatsNewWindow = null;
function showWhatsNew(version = app.getVersion()) {
  const notes = notesFor(version);
  if (!notes || !notes.length || !win) return;
  if (whatsNewWindow && !whatsNewWindow.isDestroyed()) { whatsNewWindow.focus(); return; }
  whatsNewWindow = new BrowserWindow({
    parent: win, modal: true, width: 560, height: 640, minWidth: 420, minHeight: 360,
    title: "What's new in Umbryx", icon: ICON, backgroundColor: '#000000', autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: TITLE_BAR, ...MAC_BUTTONS,
    minimizable: false, maximizable: false, show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  whatsNewWindow.setMenu(null);
  whatsNewWindow.once('ready-to-show', () => whatsNewWindow.show());
  whatsNewWindow.on('closed', () => { whatsNewWindow = null; });
  whatsNewWindow.webContents.once('did-finish-load', () => whatsNewWindow.webContents.send('whatsnew:notes', { version, notes }));
  whatsNewWindow.loadFile(path.join(__dirname, 'whatsnew.html'));
}

// Called once at start: was this version just installed over an older one?
function afterUpdate() {
  const current = app.getVersion();
  const before = settings.lastVersion;
  // Versions before 1.4 did not note themselves, so an older user's first 1.4 start has no lastVersion.
  const updated = before ? isNewer(current, before) : hadSettings;
  if (before !== current) { settings.lastVersion = current; saveSettings(); }
  if (updated || process.env.UMBRYX_SHOW_WHATS_NEW) setTimeout(() => showWhatsNew(current), 2500);
}

/* ---------- notifications ---------- */

// The server's pages ask for these when a message or a call comes in. They show only while the window is in
// the background: someone looking at it already sees the message. Clicking one brings the window forward and
// opens that conversation. They are silent, because the page plays its own sounds.
const shownNotes = new Set();   // kept so a click on one still arrives, later from the notification centre too
const KEEP_NOTES = 50;
// On Windows a notification carries a link to its conversation, umbryx://open/?o=server&k=dm|text&i=id, which Windows
// opens when it is clicked: that reaches Umbryx from the notification centre long after, or starts Umbryx if it was
// closed (see second-instance and whenReady), where the click event alone often never arrives.
const OPEN_LINK = 'umbryx://open/';
const xmlText = (value) => String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// Bring the window up on that server; its page then opens the conversation (once signed in, if Umbryx just started).
function openFromNote(origin, open) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (!savedServer(origin)) return;
  if (active !== origin || setupView) showServer(origin);
  const view = views.get(origin);
  if (!open || !view) return;
  const send = () => { if (!view.webContents.isDestroyed()) view.webContents.send('app:open', open); };
  if (view.webContents.isLoading()) view.webContents.once('did-finish-load', send); else send();
}

function openFromLink(link) {
  let url = null;
  try { url = new URL(link); } catch { return; }
  const kind = url.searchParams.get('k');
  const id = String(url.searchParams.get('i') || '').slice(0, 80);
  openFromNote(String(url.searchParams.get('o') || ''), ['dm', 'text'].includes(kind) && id ? { kind, id } : null);
}

// The sender's picture as a file, for a Windows notification written out in full (toastXml).
function noteIconFile(icon, address) {
  try {
    const dir = path.join(app.getPath('userData'), 'note-pictures');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, crypto.createHash('sha1').update(String(address)).digest('hex').slice(0, 20) + '.png');
    if (!fs.existsSync(file)) fs.writeFileSync(file, icon.toPNG());
    return file;
  } catch {
    return '';
  }
}
const noteIcons = new Map();    // picture address -> image

async function noteIcon(origin, address) {
  try {
    const url = new URL(String(address || ''));
    if (url.origin !== origin || !url.pathname.startsWith('/uploads/')) return null;
    if (noteIcons.has(url.href)) return noteIcons.get(url.href);
    const response = await chromiumNet.fetch(url.href);
    const image = response.ok ? nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer())) : null;
    const icon = image && !image.isEmpty() ? image.resize({ width: 96 }) : null;
    if (noteIcons.size > 200) noteIcons.clear();
    noteIcons.set(url.href, icon);
    return icon;
  } catch {
    return null;
  }
}

async function showNotification(origin, note) {
  if (!win || !Notification.isSupported() || (win.isFocused() && !win.isMinimized())) return;
  const text = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const open = note.open && typeof note.open === 'object' && ['dm', 'text'].includes(note.open.kind)
    ? { kind: note.open.kind, id: String(note.open.id || '').slice(0, 80) } : null;
  const icon = await noteIcon(origin, note.icon);
  const title = text(note.title, 120) || 'Umbryx';
  const body = text(note.body, 300);
  const options = { title, body, silent: true, ...(icon ? { icon } : {}) };
  if (process.platform === 'win32' && app.isPackaged) {
    const link = OPEN_LINK + '?' + new URLSearchParams({ o: origin, ...(open ? { k: open.kind, i: open.id } : {}) });
    const picture = icon ? noteIconFile(icon, note.icon) : '';
    options.toastXml = `<toast launch="${xmlText(link)}" activationType="protocol"><visual><binding template="ToastGeneric">`
      + (picture ? `<image placement="appLogoOverride" hint-crop="circle" src="${xmlText(pathToFileURL(picture).href)}"/>` : '')
      + `<text>${xmlText(title)}</text>` + (body ? `<text>${xmlText(body)}</text>` : '')
      + '</binding></visual><audio silent="true"/></toast>';
  }
  const shown = new Notification(options);
  // Kept (the newest few) even after it leaves the screen: a click from the notification centre arrives at it.
  shownNotes.add(shown);
  for (const old of shownNotes) { if (shownNotes.size <= KEEP_NOTES) break; shownNotes.delete(old); }
  const forget = () => shownNotes.delete(shown);
  shown.on('click', () => { forget(); openFromNote(origin, open); });
  shown.on('failed', (_event, error) => { forget(); console.error('notification failed:', error); });
  shown.show();
}

// Windows shows notifications only from an app it knows by its ID, which an unpacked app tells it through a
// Start menu shortcut. The app keeps one there pointing at wherever it is, which also puts Umbryx in the Start
// menu's search.
//
// Windows also takes the taskbar's picture of the app from that shortcut (and from a pin on the taskbar, or a
// shortcut on the desktop). Those used the picture inside Umbryx.exe, but updates only ever replace the app's code,
// never the exe: someone who first installed before Umbryx had its logo still has Electron's picture in theirs. So
// the shortcuts point at the logo as a file of its own instead, kept in the app's folder.
function iconFile() {
  const file = path.join(app.getPath('userData'), 'umbryx.ico');
  try {
    const logo = fs.readFileSync(ICON);   // from inside the app's code
    let same = false;
    try { same = fs.readFileSync(file).equals(logo); } catch { /* not there yet */ }
    if (!same) fs.writeFileSync(file, logo);
    return file;
  } catch {
    return process.execPath;
  }
}

function ensureStartMenuShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const icon = iconFile();
  const exe = path.resolve(process.execPath);
  const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Umbryx.lnk');
  let current = null;
  try { current = shell.readShortcutLink(link); } catch { /* none yet */ }
  let changed = false;
  if (!current || path.resolve(current.target) !== exe || current.appUserModelId !== APP_ID || current.icon !== icon) {
    try {
      shell.writeShortcutLink(link, current ? 'replace' : 'create', {
        target: process.execPath, cwd: path.dirname(process.execPath), description: 'Umbryx',
        icon, iconIndex: 0, appUserModelId: APP_ID,
      });
      changed = true;
    } catch (err) {
      console.error('Start menu shortcut:', err);
    }
  }
  // A pin on the taskbar and a shortcut on the desktop, if the person made them, get the logo too.
  const folders = [path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'), app.getPath('desktop')];
  for (const folder of folders) {
    let names = [];
    try { names = fs.readdirSync(folder).filter((name) => name.toLowerCase().endsWith('.lnk')); } catch { /* no such folder */ }
    for (const name of names) {
      const file = path.join(folder, name);
      try {
        const other = shell.readShortcutLink(file);
        if (path.resolve(other.target) !== exe || other.icon === icon) continue;
        shell.writeShortcutLink(file, 'update', { icon, iconIndex: 0 });
        changed = true;
      } catch { /* not a shortcut we can read */ }
    }
  }
  // Ask Windows to draw the shortcuts' pictures afresh rather than from its cache.
  if (changed) execFile('ie4uinit.exe', ['-show'], { windowsHide: true }, () => {});
}

/* ---------- what you are playing ---------- */

// Games say it through Discord's channel (presence.js) or are recognised by their running program (games.js), and
// Spotify tells it through its website (spotify.js). A game that says what is going on in it is shown before one
// only recognised. Each server's page passes the list on to its server, which shows it under your name.
const activities = () => [settings.shareActivity ? presence.current() || games.current() : null,
  settings.shareSpotify ? spotify.current() : null].filter(Boolean);

function tellActivity() {
  const list = activities();
  for (const view of views.values()) if (!view.webContents.isDestroyed()) view.webContents.send('app:activity', list);
}

function shareActivity(on) {
  if (on) { presence.start(tellActivity); games.start(GAMES_FILE, tellActivity); } else { presence.stop(); games.stop(); }
  tellActivity();
}

// Spotify has a switch of its own; while it is off, Spotify is not asked anything.
function shareSpotify(on) {
  if (on) spotify.start(); else spotify.stop();
  tellActivity();
}

// Spotify's key is encrypted with the Windows account's own key. On a Mac it is kept as it is (in this user's
// settings file): the app is re-signed by every update, and the Keychain would ask for the password each time.
function sealText(value) {
  try { if (!MAC && safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(value).toString('base64'); } catch { /* kept as it is */ }
  return 'raw:' + value;
}
function unsealText(value) {
  try {
    if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    if (value.startsWith('raw:')) return value.slice(4);
  } catch { /* another Windows account's, or damaged: connect again */ }
  return '';
}

function startActivity() {
  spotify.init({
    load: () => (settings.spotify ? { clientId: settings.spotify.clientId, refresh: unsealText(settings.spotify.refresh) } : null),
    save: (account) => { settings.spotify = account ? { clientId: account.clientId, refresh: sealText(account.refresh) } : null; saveSettings(); },
    openBrowser: (url) => shell.openExternal(url),
    onChange: tellActivity,
  });
  if (settings.shareActivity) shareActivity(true);
  if (settings.shareSpotify) shareSpotify(true);
}

ipcMain.handle('page:activity', (event) => (senderOrigin(event) ? activities() : []));
ipcMain.handle('page:activity-settings', (event, change) => {
  if (!senderOrigin(event)) return null;
  if (change && typeof change.share === 'boolean' && change.share !== settings.shareActivity) {
    settings.shareActivity = change.share;
    saveSettings();
    shareActivity(change.share);
  }
  if (change && typeof change.spotify === 'boolean' && change.spotify !== settings.shareSpotify) {
    settings.shareSpotify = change.spotify;
    saveSettings();
    shareSpotify(change.spotify);
  }
  return { share: settings.shareActivity, shareSpotify: settings.shareSpotify, waiting: presence.waiting(), spotify: spotify.status(), redirect: spotify.REDIRECT };
});
ipcMain.handle('page:spotify-connect', (event, clientId) => (senderOrigin(event) ? spotify.connect(String(clientId || '')) : { problem: 'Not allowed.' }));
ipcMain.handle('page:spotify-disconnect', (event) => {
  if (senderOrigin(event)) spotify.disconnect();
  return spotify.status();
});

/* ---------- messages from the pages ---------- */

const fromAppPage = (event) => !!event.senderFrame && event.senderFrame.url.startsWith('file:');
const fromRail = (event) => !!rail && event.sender === rail.webContents;
const fromOurs = (event) => contentsOf().includes(event.sender);
// Which server's page sent a message, or null if it was not one of them.
const senderOrigin = (event) => {
  for (const [origin, view] of views) if (view.webContents === event.sender) return origin;
  return null;
};
const HEX = /^#[0-9a-f]{6}$/i;

// A page from a newer server: it leaves room for the column, and says how tall the panels at the bottom of its sidebar are.
ipcMain.on('page:layout', (event, info) => {
  const origin = senderOrigin(event);
  if (!origin || !info || typeof info !== 'object') return;
  const bottom = Math.max(0, Math.min(4000, Math.round(Number(info.bottom) || 0)));
  // From 1.4.12 a page may also leave a gap above the column (its theme's cards start 10px below the title strip).
  const top = Math.max(0, Math.min(60, Math.round(Number(info.top) || 0)));
  const before = overlaid.get(origin);
  if (before && before.bottom === bottom && before.top === top) return;
  overlaid.set(origin, { bottom, top });
  layout();
});

// A page says it is on its sign-in screen (false) or signed in (true): see layout and updateRail.
ipcMain.on('page:signed-in', (event, on) => {
  const origin = senderOrigin(event);
  if (!origin || signedOut.has(origin) === !on) return;
  if (on) signedOut.delete(origin); else signedOut.add(origin);
  layout();
  updateRail();
});

// Pictures in the column load straight from their server (through the same trusted connection as its
// page), so GIFs and WebP show, animated; the column crops them to its circles itself.
ipcMain.on('page:home', (event, info) => {
  const origin = senderOrigin(event);
  if (!origin || !info || typeof info !== 'object') return;
  const list = Array.isArray(info.unread) ? info.unread.slice(0, 5) : [];
  const unread = [];
  for (const u of list) {
    if (!u || typeof u.id !== 'string') continue;
    unread.push({ id: u.id.slice(0, 80), name: String(u.name || '').slice(0, 40), count: Math.max(1, Math.min(999, Number(u.count) || 1)),
      color: HEX.test(String(u.color)) ? String(u.color) : '#5865f2', icon: pictureFrom(origin, u.avatar) });
  }
  homes.set(origin, { on: !!info.on, unread });
  updateRail();
});

ipcMain.on('page:server', (event, info) => {
  const origin = senderOrigin(event);
  const saved = origin && savedServer(origin);
  if (!saved || !info || typeof info !== 'object') return;
  const icon = cleanIcon(pictureFrom(origin, info.icon));
  const partner = info.partner === true;   // an Umbryx Partner: the check before its name when hovered (from 1.4.20)
  if (saved.icon === icon && saved.partner === partner) return;
  saved.icon = icon;
  saved.partner = partner;
  saveSettings();
  updateRail();
});

ipcMain.on('page:theme', (event, colors) => {
  const origin = senderOrigin(event);
  if (!origin || !colors || typeof colors !== 'object') return;
  const clean = {};
  for (const key of Object.keys(DEFAULT_CHROME)) clean[key] = HEX.test(String(colors[key])) ? String(colors[key]).toLowerCase() : DEFAULT_CHROME[key];
  chrome.set(origin, clean);
  if (origin === active) applyChrome();
});

// A server says a new version of the app was just published: fetch it now (once a minute at most).
let pushedCheckAt = 0;
ipcMain.on('page:check-updates', (event) => {
  if (!senderOrigin(event) || Date.now() - pushedCheckAt < 60 * 1000) return;
  pushedCheckAt = Date.now();
  checkForUpdate();
});

// Settings' App card (1.4.9 on): the app's version and any update ready, zoom, What's new and Check for updates.
const zoomPercent = (contents) => Math.round(Math.pow(1.2, contents.getZoomLevel()) * 100);
ipcMain.handle('page:app-info', (event) => (senderOrigin(event)
  ? { version: app.getVersion(), ready: update ? update.version : '', zoom: zoomPercent(event.sender) } : null));
ipcMain.handle('page:zoom', (event, step) => {
  if (!senderOrigin(event)) return 100;
  const contents = event.sender;
  const level = step === 0 ? 0 : Math.max(-3, Math.min(4.5, contents.getZoomLevel() + (step > 0 ? 0.5 : -0.5)));
  contents.setZoomLevel(level);
  return zoomPercent(contents);
});
ipcMain.on('page:whats-new', (event) => { if (senderOrigin(event)) showWhatsNew(); });
ipcMain.on('page:check-now', (event) => { if (senderOrigin(event)) checkFromMenu(); });

// How long the whole computer has gone without a key or the mouse being touched, for the Idle status.
ipcMain.handle('app:idle', (event) => (senderOrigin(event) ? powerMonitor.getSystemIdleTime() : 0));

ipcMain.on('page:notify', (event, note) => {
  const origin = senderOrigin(event);
  if (origin && note && typeof note === 'object') showNotification(origin, note).catch((err) => console.error('notification:', err));
});

ipcMain.handle('setup:connect', async (event, address) => {
  if (!fromAppPage(event) || !setupView || event.sender !== setupView.webContents) return { problem: 'Not allowed.' };
  try {
    await connect(address);
    return {};
  } catch (err) {
    return { problem: err.message };
  }
});

ipcMain.on('setup:cancel', (event) => { if (setupView && event.sender === setupView.webContents) closeSetup(); });

// A button in the interface's Settings opens the app's menu where the mouse is.
ipcMain.on('app:menu', (event) => { if (win && appMenu && fromOurs(event)) appMenu.popup({ window: win }); });

// The column (re)loaded: it needs everything again, its colours and its layout included.
ipcMain.on('rail:ready', (event) => {
  if (!fromRail(event)) return;
  chromeShown = '';
  railStrip = null;
  applyChrome();
  layout();
  updateRail();
});
ipcMain.on('rail:open', (event, index) => {
  const saved = fromRail(event) && settings.servers[index];
  if (!saved) return;
  const origin = originOf(saved.address);
  const home = homes.get(origin);
  // The server on screen, showing Home: its button goes back to its channels.
  if (origin === active && !setupView && home && home.on && views.has(origin)) views.get(origin).webContents.send('app:home', 'server');
  else openServer(origin);
});
// Home: Friends and direct messages, of the server on screen (each server keeps its own).
ipcMain.on('rail:home', (event) => {
  if (!fromRail(event)) return;
  const origin = active || (settings.servers[settings.current] && originOf(settings.servers[settings.current].address));
  if (!origin || !views.has(origin)) return;
  if (setupView || origin !== active) showServer(origin);
  views.get(origin).webContents.send('app:home', 'home');
});
// One of the pictures under Home: that conversation.
ipcMain.on('rail:dm', (event, id) => {
  if (!fromRail(event) || !active || !views.has(active) || typeof id !== 'string') return;
  if (setupView) showServer(active);
  views.get(active).webContents.send('app:open', { kind: 'dm', id: id.slice(0, 80) });
});
ipcMain.on('rail:add', (event) => { if (fromRail(event)) showSetup(''); });
ipcMain.on('rail:tip', (event, on) => {
  if (!fromRail(event) || railTip === !!on) return;
  railTip = !!on;
  layout();
});
ipcMain.on('rail:update', (event) => { if (fromRail(event)) restartToUpdate(); });
ipcMain.on('rail:menu', (event, index) => {
  const saved = fromRail(event) && settings.servers[index];
  if (!saved || !win) return;
  const origin = originOf(saved.address);
  const name = (pages.get(origin) || {}).name || saved.name || new URL(saved.address).hostname;
  Menu.buildFromTemplate([
    { label: 'Open', click: () => openServer(origin) },
    { label: 'Reload', enabled: views.has(origin), click: () => views.has(origin) && views.get(origin).webContents.reload() },
    { type: 'separator' },
    { label: `Remove ${name} from the list`, click: () => removeServer(settings.servers.indexOf(saved)) },
  ]).popup({ window: win });
});

ipcMain.on('picker:choose', (event, choice) => {
  if (!fromAppPage(event) || !picking) return;
  picking(choice && typeof choice.id === 'string' ? { id: choice.id, audio: !!choice.audio } : null);
});

app.whenReady().then(async () => {
  // Present as an ordinary browser engine plus our own name, which the interface uses to recognise the app.
  app.userAgentFallback = app.userAgentFallback.replace(/\s(?:umbryx|Electron)\/\S+/gi, '') + ` Umbryx/${app.getVersion()}`;
  loadSettings();
  guardSession();
  buildMenu();
  createWindow();
  startActivity();

  const args = process.argv.slice(1);
  const given = args.find((arg) => !arg.startsWith('-') && arg !== '.' && !/\.js$|\.asar$/i.test(arg) && !arg.startsWith('umbryx:'));
  const link = args.find((arg) => arg.startsWith(OPEN_LINK));   // started by a click on a notification
  if (args.includes('--setup')) { showSetup('', given || ''); return; }
  if (given) {
    try { await connect(given); } catch (err) { showSetup(err.message, given); }
    return;
  }
  startUpdateChecks();
  ensureStartMenuShortcut();
  if (process.platform === 'win32' && app.isPackaged) {
    try { if (!app.isDefaultProtocolClient('umbryx')) app.setAsDefaultProtocolClient('umbryx'); } catch (err) { console.error('umbryx:// links:', err); }
  }
  afterUpdate();
  const saved = settings.servers[settings.current] || settings.servers[0];
  if (saved) openServer(originOf(saved.address));
  else showSetup('');
  if (link) openFromLink(link);
});

app.on('window-all-closed', () => app.quit());
// Let go of the games' channel, so Discord can have it.
app.on('will-quit', () => { presence.stop(); games.stop(); spotify.stop(); });
