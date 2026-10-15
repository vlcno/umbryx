'use strict';
// Games recognised by their program, the way Discord does it. Most games (The Binding of Isaac, for one) never
// say what you are doing; Discord simply sees them running. Umbryx does the same with Discord's public list of
// games (about 25,000 of them, each with the names of its programs): every 15 seconds it looks at the programs
// running on this computer and, when one is a game on the list, shows "Playing <game>". Nothing but the game's
// name and picture leaves the computer, and only while Settings allows it.
//
// The list is about 13 MB. It is fetched once a week and kept, cut down to this system's games, in the app's
// folder (GAMES_FILE in main.js).
const { execFile } = require('child_process');
const fs = require('fs');

const LIST = 'https://discord.com/api/v10/applications/detectable';
const LOOK_EVERY = 15 * 1000;
const LIST_KEEP = 7 * 24 * 60 * 60 * 1000;
const LIST_RETRY = 60 * 60 * 1000;   // after a failed download
const ID = /^\d{5,25}$/;
const ICON = /^[a-f0-9_]{1,64}$/i;
const OS = process.platform === 'darwin' ? 'darwin' : 'win32';

let file = '';
let running = false;
let timer = 0;
let shown = null;
let onChange = () => {};
let byProgram = null;          // a program's file name -> [{ id, name, icon, exe }]
let listTriedAt = 0;
const seen = new Map();        // process id -> { path, start, window, at } of programs that might be games
const WINDOW_RECHECK = 60 * 1000;   // a possible game without a window yet is looked at again after this
let current = null;            // { pid, game }

const tidy = (exe) => exe.toLowerCase().replace(/\\/g, '/').replace(/^>/, '');
const baseName = (exe) => exe.slice(exe.lastIndexOf('/') + 1);

// The list cut down to this system's games: [[id, name, icon, [programs]]].
function index(games) {
  byProgram = new Map();
  for (const [id, name, icon, exes] of games) {
    for (const exe of exes) {
      // A Mac game is named by its app (the.game.app): any program inside it counts.
      const key = OS === 'darwin' && exe.endsWith('.app') ? exe : baseName(exe);
      if (!byProgram.has(key)) byProgram.set(key, []);
      byProgram.get(key).push({ id, name, icon, exe });
    }
  }
}

async function loadList() {
  let kept = null;
  try { kept = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  if (kept && kept.os === OS && Array.isArray(kept.games)) index(kept.games);
  if (kept && Date.now() - kept.fetched < LIST_KEEP) return;
  if (Date.now() - listTriedAt < LIST_RETRY) return;
  listTriedAt = Date.now();
  try {
    const res = await fetch(LIST, { signal: AbortSignal.timeout(120000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = await res.json();
    const games = [];
    for (const g of Array.isArray(all) ? all : []) {
      if (!g || !ID.test(String(g.id)) || typeof g.name !== 'string' || !Array.isArray(g.executables)) continue;
      // Launchers (Steam, a publisher's launcher) are not games, and programs that only count with particular
      // arguments (one engine running many games) cannot be told apart from here.
      const exes = g.executables.filter((e) => e && e.os === OS && !e.is_launcher && !e.arguments && typeof e.name === 'string' && e.name)
        .map((e) => tidy(e.name));
      if (exes.length) games.push([String(g.id), g.name.slice(0, 64), ICON.test(String(g.icon_hash || '')) ? g.icon_hash : '', exes]);
    }
    if (games.length < 100) throw new Error('the list looks wrong');
    fs.writeFileSync(file, JSON.stringify({ os: OS, fetched: Date.now(), games }));
    index(games);
  } catch (err) {
    console.error('game list:', err.message || err);
  }
}

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 8 << 20 }, (err, out) => resolve(err ? '' : String(out)));
});

// Every running program: [{ pid, name (file name, small letters), path (when known), start (when known) }].
async function programs() {
  if (OS === 'darwin') {
    const out = await run('/bin/ps', ['-axo', 'pid=,etime=,comm=']);
    const list = [];
    for (const line of out.split('\n')) {
      const hit = /^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.+)$/.exec(line);
      if (!hit) continue;
      const [, pid, days, hours, minutes, seconds, path] = hit;
      const age = (((Number(days || 0) * 24 + Number(hours || 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
      const lower = tidy(path.trim());
      list.push({ pid: Number(pid), name: baseName(lower), path: lower, start: Date.now() - age });
    }
    return list;
  }
  const out = await run('tasklist', ['/fo', 'csv', '/nh']);
  const list = [];
  for (const line of out.split(/\r?\n/)) {
    // name, process id, session name, session number: session 0 is Windows' own background services, never a game
    // (Intel's LMS.exe, on most Intel computers, shares its name with a game on Discord's list)
    const hit = /^"([^"]+)","(\d+)","[^"]*","(\d+)"/.exec(line);
    if (hit && hit[3] !== '0') list.push({ pid: Number(hit[2]), name: hit[1].toLowerCase(), path: '', start: 0, window: false });
  }
  return list;
}

// Where a Windows program lives, when it started, and whether it has a window, for the few that might be games.
// A game always has a window; a background tool that happens to share a game's file name does not. One without a
// window yet (a game still starting) is asked about again a minute later.
async function details(pids) {
  const now = Date.now();
  const want = pids.filter((pid) => { const known = seen.get(pid); return !known || (!known.window && now - known.at > WINDOW_RECHECK); });
  if (want.length) {
    const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Id ${want.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.Path)|$(try { ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch { 0 })|$($_.MainWindowHandle)" }`]);
    for (const pid of want) seen.set(pid, { path: '', start: 0, window: false, at: now });
    for (const line of out.split(/\r?\n/)) {
      const [pid, path, start, handle] = line.trim().split('|');
      if (seen.has(Number(pid))) seen.set(Number(pid), { path: tidy(path || ''), start: Number(start) || 0, window: !!handle && handle !== '0', at: now });
    }
  }
}

function gameOf(proc) {
  if (OS === 'darwin') {
    for (const part of proc.path.split('/')) {
      if (part.endsWith('.app') && byProgram.has(part)) return byProgram.get(part)[0];
    }
  }
  const candidates = byProgram.get(proc.name) || [];
  // A program named only by its file matches by that; one named with its folder (many games share "game.exe")
  // must be in that folder.
  return candidates.find((c) => (c.exe.includes('/') ? !!proc.path && proc.path.endsWith('/' + c.exe) : true)) || null;
}

async function look() {
  timer = 0;
  if (!running) return;
  try {
    await loadList();
    if (byProgram) {
      const procs = await programs();
      const alive = new Set(procs.map((p) => p.pid));
      for (const pid of seen.keys()) if (!alive.has(pid)) seen.delete(pid);
      const maybe = procs.filter((p) => byProgram.has(p.name) || (OS === 'darwin' && p.path.includes('.app/')));
      if (OS !== 'darwin') {
        await details(maybe.filter((p) => byProgram.has(p.name)).map((p) => p.pid));
        for (const p of maybe) Object.assign(p, seen.get(p.pid) || {});
      }
      // The game already showing stays while it runs; otherwise the one started last.
      let found = current && alive.has(current.pid) ? current : null;
      if (!found) {
        for (const p of maybe) {
          if (OS !== 'darwin' && !p.window) continue;   // no window: not a game being played (see details)
          const game = gameOf(p);
          if (game && (!found || p.start > found.start)) found = { pid: p.pid, start: p.start || Date.now(), game };
        }
      }
      current = found;
      setShown(found ? {
        source: 'game', name: found.game.name, kind: 0, details: '', state: '',
        icon: found.game.icon ? `https://cdn.discordapp.com/app-icons/${found.game.id}/${found.game.icon}.png?size=128` : '',
        image: '', imageText: '', small: '', smallText: '', start: found.start, end: 0, party: null,
      } : null);
    }
  } catch (err) {
    console.error('games:', err.message || err);
  }
  if (running && !timer) timer = setTimeout(look, LOOK_EVERY);
}

function setShown(next) {
  if (JSON.stringify(next) === JSON.stringify(shown)) return;
  shown = next;
  onChange(shown);
}

module.exports = {
  // listFile: where to keep the list. listener(activity or null) hears each change.
  start(listFile, listener) {
    file = listFile;
    onChange = typeof listener === 'function' ? listener : () => {};
    if (running) return;
    running = true;
    look();
  },
  stop() {
    running = false;
    clearTimeout(timer);
    timer = 0;
    current = null;
    setShown(null);
  },
  current: () => shown,
  gameOf: (proc) => (byProgram ? gameOf(proc) : null),   // for tests
  index,                                                 // for tests
};
