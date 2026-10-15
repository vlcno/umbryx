'use strict';
// Listening to Spotify: the song (or podcast) playing on your Spotify account, wherever it plays (this computer,
// your phone, a speaker), read from Spotify every few seconds while it plays.
//
// It goes through a Spotify developer app that the server's owner makes on developer.spotify.com; its Client ID
// is set in the server's settings. Each person connects their own Spotify account once, in Settings: Spotify asks
// them in the browser whether Umbryx may see what they are playing, then sends them back to this computer at
// REDIRECT below, which must be listed in that developer app's Redirect URIs. The app keeps the key Spotify gives
// (main.js encrypts it where the system can) and only ever asks Spotify what is playing now.
//
// Spotify does not announce a pause, a resume or a skip, so the app asks every few seconds. On Windows it also
// watches the title of the Spotify app's window (the song while one plays, "Spotify" when paused), which changes
// the moment any of those happens on this computer, and asks straight away when it does.
const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');

const PORT = 43117;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = 'user-read-currently-playing';
const AUTHORIZE = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const NOW_PLAYING = 'https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode';
const CLIENT_ID = /^[0-9a-f]{32}$/;
const COVER = /^https:\/\/i\.scdn\.co\/image\/[a-f0-9]{40}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const PLAYING_EVERY = 4000;          // how often to look while something plays
const IDLE_EVERY = 5000;             // ...and while nothing does
const WATCHED_EVERY = 10000;         // ...while the Spotify app's window on this computer is watched (see watchApp)
const REFUSED_EVERY = 5 * 60 * 1000; // after Spotify said this account may not use the developer app
const CONNECT_WAIT = 5 * 60 * 1000;  // how long the browser has to come back

let hooks = { load: () => null, save: () => {}, openBrowser: () => {}, onChange: () => {} };
let account = null;     // { clientId, refresh }
let access = null;      // { token, until }
let running = false;
let timer = 0;
let shown = null;
let problem = '';
let connecting = null;  // the sign-in waiting for the browser: { close }
let busy = false;       // asking Spotify right now
let askAgain = false;   // something changed meanwhile: ask again when done
let nudgeTimer = 0;
let watcher = null;     // Windows: the PowerShell that watches the Spotify app's window title
let appTitle = '';      // that title ('' while the Spotify app has no window here)

const text = (value, limit) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '');
const form = (fields) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
  signal: AbortSignal.timeout(10000),
});

function setShown(next) {
  // The same song: a start a moment off is only the delay in asking, not a skip.
  if (next && shown && next.details === shown.details && next.state === shown.state && next.album === shown.album
      && Math.abs(next.start - shown.start) < 2500) return;
  if (!next && !shown) return;
  shown = next;
  hooks.onChange(shown);
}

async function token() {
  if (access && Date.now() < access.until - 60000) return access.token;
  const res = await fetch(TOKEN, form({ grant_type: 'refresh_token', refresh_token: account.refresh, client_id: account.clientId }));
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.access_token !== 'string') {
    if (body.error === 'invalid_grant' || body.error === 'invalid_client') {
      forget('Spotify disconnected Umbryx. Connect it again in Settings.');
    }
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  access = { token: body.access_token, until: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  if (typeof body.refresh_token === 'string' && body.refresh_token && body.refresh_token !== account.refresh) {
    account.refresh = body.refresh_token;
    hooks.save(account);
  }
  return access.token;
}

// Spotify's answer to "what is playing?", as what the others see. Nothing while paused or during an ad.
function describe(now) {
  const item = now && now.item;
  if (!now.is_playing || !item || typeof item.name !== 'string') return null;
  const episode = now.currently_playing_type === 'episode' || item.type === 'episode';
  const album = episode ? item.show : item.album;
  const covers = (album && Array.isArray(album.images) && album.images.length ? album.images : Array.isArray(item.images) ? item.images : [])
    .filter((c) => c && COVER.test(String(c.url)));
  // The picture nearest 300 pixels across: big enough for the profile card, small enough to load quickly.
  covers.sort((a, b) => Math.abs((a.width || 300) - 300) - Math.abs((b.width || 300) - 300));
  const progress = Math.max(0, Number(now.progress_ms) || 0);
  const duration = Math.max(0, Number(item.duration_ms) || 0);
  const start = Date.now() - progress;
  const artists = Array.isArray(item.artists) ? item.artists.filter((a) => a && typeof a.name === 'string' && a.name) : [];
  const link = (kind, id) => (typeof id === 'string' && SPOTIFY_ID.test(id) ? `https://open.spotify.com/${kind}/${id}` : '');
  return {
    source: 'spotify',
    name: 'Spotify',
    kind: 2,
    details: text(item.name, 128),
    state: text(episode ? item.show && item.show.name : artists.map((a) => a.name).join(', '), 128),
    album: episode ? '' : text(album && album.name, 128),
    icon: '',
    image: covers.length ? covers[0].url : '',
    imageText: text(album && album.name, 128),
    small: '',
    smallText: '',
    start,
    end: duration ? start + duration : 0,
    party: null,
    // links for the profile card: the song (or episode), its album, and each artist (or the podcast)
    trackUrl: link(episode ? 'episode' : 'track', item.id),
    albumUrl: episode ? '' : link('album', album && album.id),
    artists: episode
      ? (item.show && typeof item.show.name === 'string' ? [{ name: text(item.show.name, 64), url: link('show', item.show.id) }] : [])
      : artists.slice(0, 8).map((a) => ({ name: text(a.name, 64), url: link('artist', a.id) })),
  };
}

async function poll() {
  timer = 0;
  if (!running || !account) return;
  if (busy) { askAgain = true; return; }
  busy = true;
  watchApp();
  let wait = appTitle ? WATCHED_EVERY : IDLE_EVERY;
  try {
    const res = await fetch(NOW_PLAYING, { headers: { authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(10000) });
    if (res.status === 401) {
      access = null;
      wait = 1000;
    } else if (res.status === 429) {
      wait = Math.max(IDLE_EVERY, (Number(res.headers.get('retry-after')) || 30) * 1000);
    } else if (res.status === 403) {
      problem = 'Spotify did not let this account in. The server owner has to add your Spotify email under User Management in their Spotify developer app.';
      setShown(null);
      wait = REFUSED_EVERY;
    } else if (res.status === 204 || !res.ok) {
      setShown(null);
    } else {
      problem = '';
      const next = describe(await res.json());
      setShown(next);
      // Look again soon while something plays, and just after the song should end.
      const every = appTitle ? WATCHED_EVERY : PLAYING_EVERY;
      if (next) wait = next.end ? Math.min(every, Math.max(1000, next.end - Date.now() + 1500)) : every;
    }
  } catch { /* offline for a moment: the last song stays until the next answer */ }
  busy = false;
  if (askAgain) { askAgain = false; wait = 0; }
  if (running && account && !timer) timer = setTimeout(poll, wait);
}

// Something just changed in the Spotify app here: ask now, and once more a moment later, since Spotify's website
// can take a second to catch up with its app.
function nudge() {
  if (!running || !account || nudgeTimer) return;
  nudgeTimer = setTimeout(() => {
    nudgeTimer = 0;
    clearTimeout(timer);
    timer = 0;
    poll();
    setTimeout(() => { if (running && account && !busy) { clearTimeout(timer); timer = 0; poll(); } }, 2000);
  }, 400);
}

// Windows: one small PowerShell, started once, reads the Spotify app's window title twice a second and says when it
// changes. (A Mac would ask the person's permission to look at Spotify, so there the app just asks more often.)
function watchApp() {
  if (process.platform !== 'win32' || watcher || !running || !account) return;
  const script = "$last = '~'; while ($true) { $p = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1; "
    + "$t = if ($p) { $p.MainWindowTitle } else { '' }; if ($t -ne $last) { [Console]::Out.WriteLine('T' + $t); [Console]::Out.Flush(); $last = $t }; Start-Sleep -Milliseconds 500 }";
  let child;
  try {
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return; }
  watcher = child;
  let pending = '';
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
      const line = pending.slice(0, at).replace(/\r$/, '');
      pending = pending.slice(at + 1);
      if (!line.startsWith('T')) continue;
      const first = watcher === child && appTitle === '' && line === 'T';
      appTitle = line.slice(1);
      if (!first) nudge();
    }
  });
  child.on('error', () => {});
  child.on('exit', () => {
    if (watcher !== child) return;
    watcher = null;
    appTitle = '';
    if (running && account) setTimeout(watchApp, 30000);   // stopped by something else: start again in a while
  });
}

function unwatchApp() {
  const child = watcher;
  watcher = null;
  appTitle = '';
  if (child) { try { child.kill(); } catch { /* gone already */ } }
}

function restart() {
  clearTimeout(timer);
  timer = 0;
  if (running && account) poll();
}

function forget(why) {
  account = null;
  access = null;
  unwatchApp();
  problem = why || '';
  hooks.save(null);
  clearTimeout(timer);
  timer = 0;
  setShown(null);
}

const page = (message) => `<!doctype html><meta charset="utf-8"><title>Umbryx</title>
<style>body{font:16px system-ui,sans-serif;background:#111214;color:#f2f3f5;display:grid;place-items:center;height:100vh;margin:0}p{max-width:420px;text-align:center;line-height:1.5}</style>
<p>${message}</p>`;

// Opens Spotify's "may Umbryx see what you are playing?" page in the browser and waits for the answer.
function connect(clientId) {
  if (!CLIENT_ID.test(clientId)) return Promise.resolve({ problem: 'This server has no Spotify app set up yet. A Server Owner adds its Client ID in Server settings.' });
  if (connecting) connecting.close({ problem: 'Started again.' });
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  return new Promise((resolve) => {
    let waitTimer = 0;
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, REDIRECT);
      const reply = (status, message) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page(message));
      if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) { reply(404, 'Nothing here.'); return; }
      const code = url.searchParams.get('code');
      if (!code) {
        reply(200, 'Spotify was not connected. You can close this tab.');
        done({ problem: 'Spotify was not connected.' });
        return;
      }
      try {
        const answer = await fetch(TOKEN, form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }));
        const body = await answer.json().catch(() => ({}));
        if (!answer.ok || typeof body.refresh_token !== 'string' || typeof body.access_token !== 'string') throw new Error(body.error_description || body.error || `HTTP ${answer.status}`);
        account = { clientId, refresh: body.refresh_token };
        access = { token: body.access_token, until: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
        problem = '';
        hooks.save(account);
        reply(200, 'Spotify is connected to Umbryx. You can close this tab.');
        done({});
        restart();
      } catch (err) {
        reply(200, 'Spotify could not be connected. Go back to Umbryx and try again.');
        done({ problem: `Spotify could not be connected (${String(err.message || err).slice(0, 120)}).` });
      }
    });
    const done = (result) => {
      if (connecting !== handle) return;
      connecting = null;
      clearTimeout(waitTimer);
      srv.close();
      resolve(result);
    };
    const handle = { close: done };
    connecting = handle;
    waitTimer = setTimeout(() => done({ problem: 'Nothing came back from Spotify. Try again.' }), CONNECT_WAIT);
    srv.once('error', () => done({ problem: `Something else on this computer is using port ${PORT}, which Spotify sends you back to. Close it and try again.` }));
    srv.listen(PORT, '127.0.0.1', () => {
      const params = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPE,
        code_challenge_method: 'S256', code_challenge: challenge, state });
      hooks.openBrowser(`${AUTHORIZE}?${params}`);
    });
  });
}

module.exports = {
  REDIRECT,
  // hooks: load() and save(account or null) keep the account; openBrowser(url); onChange(activity or null).
  init(given) {
    hooks = { ...hooks, ...given };
    const saved = hooks.load();
    account = saved && CLIENT_ID.test(saved.clientId) && typeof saved.refresh === 'string' && saved.refresh ? saved : null;
  },
  connect,
  disconnect() { if (connecting) connecting.close({ problem: 'Cancelled.' }); forget(''); },
  start() { running = true; restart(); },
  stop() { running = false; clearTimeout(timer); timer = 0; unwatchApp(); setShown(null); },
  current: () => shown,
  status: () => ({ connected: !!account, connecting: !!connecting, problem }),
  describe,   // for tests
};
