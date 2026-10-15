'use strict';
// What you are playing, as games tell Discord.
//
// Many games (and music players and other tools with a "Discord presence" plugin) tell the Discord app what you
// are doing over a local channel: a named pipe on Windows (\\?\pipe\discord-ipc-0) and a socket file on a Mac
// ($TMPDIR/discord-ipc-0). The app opens the same channel, so they tell Umbryx too: the game, lines such as
// "Ranked · 7–4", pictures, and how long you have been at it. The game's name and pictures come from Discord's
// public list of these apps, looked up by the id the game gives.
//
// Discord takes the first free channel of discord-ipc-0 to -9, and games talk to the first one that answers, so
// whichever of the two apps starts first has channel 0:
//  - Discord: the games talk to it and Umbryx hears nothing. Umbryx tries again every half minute, so quitting
//    Discord hands the channel over.
//  - Umbryx: the games talk to Umbryx. If Discord is running as well (it then took a later channel), Umbryx passes
//    each game's conversation through to it, so Discord still shows what you are playing too.
const net = require('net');
const os = require('os');
const path = require('path');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const MAX_FRAME = 64 * 1024;
const RETRY_EVERY = 30 * 1000;              // while something else (Discord) has the channel
const LOOKUP_KEEP = 6 * 60 * 60 * 1000;     // a game's name and pictures, looked up once in a while
const LOOKUP_RETRY = 10 * 60 * 1000;        // ...or again sooner when Discord could not be reached
const ID = /^\d{5,25}$/;
const KINDS = new Set([0, 2, 3, 5]);        // Discord's: playing, listening to, watching, competing in
// The channel's name. Only tests change it, so that they never talk to a real Discord.
const NAME = /^[\w-]{1,40}$/.test(process.env.UMBRYX_IPC_NAME || '') ? process.env.UMBRYX_IPC_NAME : 'discord-ipc';

function channelPath(n) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\${NAME}-${n}`;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || os.tmpdir();
  return path.join(dir, `${NAME}-${n}`);
}

function encode(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

// Splits what arrives on a connection into its frames: an 8-byte header (what kind, how long) and JSON.
function frames(onFrame, onBad) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    while (buffered.length >= 8) {
      const op = buffered.readUInt32LE(0);
      const length = buffered.readUInt32LE(4);
      if (length > MAX_FRAME) { onBad(); return; }
      if (buffered.length < 8 + length) return;
      const raw = buffered.subarray(0, 8 + length);
      buffered = buffered.subarray(8 + length);
      let data = null;
      try { data = JSON.parse(raw.subarray(8).toString('utf8')); } catch { /* passed on as it is */ }
      onFrame({ op, data, raw });
    }
  };
}

let enabled = false;
let server = null;          // listening on channel 0
let retryTimer = 0;
let onChange = () => {};
let shown = null;           // what the app was last told
let turn = 0;               // the newest change; an older one still being looked up is dropped
const games = new Set();    // { socket, app, activity, at, upstream, queue }

function claim() {
  retryTimer = 0;
  if (!enabled || server) return;
  const where = channelPath(0);
  if (process.platform === 'win32') { open(where); return; }
  // A socket file is left behind when the app that made it quits without closing it: one nobody answers on
  // is stale and goes. One that answers belongs to Discord.
  const probe = net.connect(where);
  probe.once('connect', () => { probe.destroy(); later(); });
  probe.once('error', (err) => {
    if (err.code === 'ECONNREFUSED') { try { require('fs').unlinkSync(where); } catch { /* gone already */ } }
    open(where);
  });
}

function open(where) {
  const s = net.createServer(accept);
  s.once('error', () => { s.close(); later(); });
  s.listen(where, () => {
    if (!enabled) { s.close(); return; }
    server = s;
    s.on('error', () => {});
  });
}

function later() {
  if (enabled && !retryTimer) retryTimer = setTimeout(claim, RETRY_EVERY);
}

// Discord, on a later channel, if it is running.
function findDiscord(done, n = 1) {
  if (n > 9) { done(null); return; }
  const sock = net.connect(channelPath(n));
  let settled = false;
  const next = () => { if (settled) return; settled = true; clearTimeout(timer); sock.destroy(); findDiscord(done, n + 1); };
  const timer = setTimeout(next, 500);
  sock.once('error', next);
  sock.once('connect', () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done(sock);
  });
}

function accept(socket) {
  const game = { socket, app: '', activity: null, at: 0, upstream: null, queue: [] };
  games.add(game);
  socket.on('error', () => {});
  socket.on('close', () => {
    if (game.upstream) game.upstream.destroy();
    games.delete(game);
    if (game.activity) changed();
  });
  socket.on('data', frames((f) => fromGame(game, f), () => socket.destroy()));
}

function fromGame(game, f) {
  if (!game.app) {
    const id = f.op === OP.HANDSHAKE && f.data ? String(f.data.client_id || '') : '';
    if (!ID.test(id)) { game.socket.end(encode(OP.CLOSE, { code: 4000, message: 'Invalid Client ID' })); return; }
    game.app = id;
    findDiscord((upstream) => {
      if (game.socket.destroyed) { if (upstream) upstream.destroy(); return; }
      const waiting = game.queue;
      game.queue = null;
      if (upstream) {
        game.upstream = upstream;
        upstream.on('error', () => {});
        upstream.on('data', (chunk) => game.socket.write(chunk));
        upstream.on('close', () => game.socket.destroy());
        upstream.write(f.raw);
      } else {
        game.socket.write(encode(OP.FRAME, { cmd: 'DISPATCH', evt: 'READY', nonce: null, data: {
          v: 1,
          config: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' },
          user: { id: '0', username: 'umbryx', discriminator: '0', global_name: 'Umbryx', avatar: null, bot: false, flags: 0, premium_type: 0 },
        } }));
      }
      for (const queued of waiting) fromGame(game, queued);
    });
    return;
  }
  if (game.queue) { game.queue.push(f); return; }   // still finding out whether Discord is there
  if (f.op === OP.FRAME && f.data && f.data.cmd === 'SET_ACTIVITY') {
    const args = f.data.args && typeof f.data.args === 'object' ? f.data.args : {};
    game.activity = args.activity && typeof args.activity === 'object' ? args.activity : null;
    game.at = Date.now();
    changed();
  }
  if (game.upstream) { game.upstream.write(f.raw); return; }
  answer(game, f);
}

// Umbryx on its own, without Discord behind it: the few answers games wait for.
function answer(game, f) {
  const m = f.data && typeof f.data === 'object' ? f.data : {};
  if (f.op === OP.PING) { game.socket.write(encode(OP.PONG, m)); return; }
  if (f.op === OP.CLOSE) { game.socket.end(); return; }
  if (f.op !== OP.FRAME) return;
  const reply = { cmd: m.cmd, evt: null, nonce: m.nonce === undefined ? null : m.nonce, data: null };
  if (m.cmd === 'SET_ACTIVITY') reply.data = game.activity ? { ...game.activity, application_id: game.app } : null;
  else if (m.cmd === 'SUBSCRIBE' || m.cmd === 'UNSUBSCRIBE') reply.data = { evt: m.evt };
  else Object.assign(reply, { evt: 'ERROR', data: { code: 1000, message: 'Umbryx only shows what you are playing.' } });
  game.socket.write(encode(OP.FRAME, reply));
}

/* ---------- what it is ---------- */

const lookups = new Map();   // game id -> { at, info: Promise<{ name, icon, assets }> }

function lookUp(appId) {
  const known = lookups.get(appId);
  if (known && Date.now() - known.at < LOOKUP_KEEP) return known.info;
  const base = `https://discord.com/api/v10/oauth2/applications/${appId}`;
  const get = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const info = Promise.all([get(base + '/rpc').catch(() => null), get(base + '/assets').catch(() => null)]).then(([about, assets]) => {
    const found = {
      name: about && typeof about.name === 'string' ? about.name.slice(0, 64) : '',
      icon: about && typeof about.icon === 'string' && /^[a-f0-9_]{1,64}$/i.test(about.icon) ? about.icon : '',
      assets: new Map((Array.isArray(assets) ? assets : [])
        .filter((a) => a && ID.test(String(a.id)) && typeof a.name === 'string')
        .map((a) => [a.name.toLowerCase(), String(a.id)])),
    };
    if (!about) lookups.set(appId, { at: Date.now() - LOOKUP_KEEP + LOOKUP_RETRY, info });
    return found;
  });
  lookups.set(appId, { at: Date.now(), info });
  return info;
}

const text = (value, limit) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '');
// Games give times in milliseconds, or (older ones) in seconds.
const epochMs = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? (value < 1e12 ? value * 1000 : value) : 0);

async function describe(game) {
  const a = game.activity;
  const info = await lookUp(game.app);
  const assets = a.assets && typeof a.assets === 'object' ? a.assets : {};
  // Pictures are the game's own, uploaded to Discord, named by key (or given by number). Addresses elsewhere on
  // the web are left out: everyone looking at your profile would load them from wherever they are.
  const picture = (key) => {
    if (typeof key !== 'string' || !key) return '';
    const id = ID.test(key) ? key : info.assets.get(key.toLowerCase());
    return id ? `https://cdn.discordapp.com/app-assets/${game.app}/${id}.png` : '';
  };
  const stamps = a.timestamps && typeof a.timestamps === 'object' ? a.timestamps : {};
  const size = a.party && Array.isArray(a.party.size) ? a.party.size : null;
  return {
    source: 'game',
    name: info.name || text(a.name, 64) || 'a game',
    kind: KINDS.has(a.type) ? a.type : 0,
    details: text(a.details, 128),
    state: text(a.state, 128),
    icon: info.icon ? `https://cdn.discordapp.com/app-icons/${game.app}/${info.icon}.png?size=128` : '',
    image: picture(assets.large_image),
    imageText: text(assets.large_text, 128),
    small: picture(assets.small_image),
    smallText: text(assets.small_text, 128),
    start: epochMs(stamps.start),
    end: epochMs(stamps.end),
    party: size && size.length === 2 && size.every((n) => Number.isInteger(n) && n >= 0 && n <= 100000) && size[0] <= size[1] ? [size[0], size[1]] : null,
  };
}

// The newest game still connected that says what you are doing.
async function changed() {
  const mine = ++turn;
  let newest = null;
  for (const game of games) if (game.activity && (!newest || game.at > newest.at)) newest = game;
  const next = newest ? await describe(newest) : null;
  if (mine !== turn || JSON.stringify(next) === JSON.stringify(shown)) return;
  shown = next;
  onChange(shown);
}

module.exports = {
  // listener(activity or null) hears each change.
  start(listener) {
    onChange = typeof listener === 'function' ? listener : () => {};
    enabled = true;
    claim();
  },
  stop() {
    enabled = false;
    clearTimeout(retryTimer);
    retryTimer = 0;
    if (server) server.close();
    server = null;
    for (const game of games) game.socket.destroy();
    games.clear();
    turn++;
    if (shown) { shown = null; onChange(null); }
  },
  current: () => shown,
  // True while sharing is on but another app (Discord, started first) has the channel the games use.
  waiting: () => enabled && !server,
};
