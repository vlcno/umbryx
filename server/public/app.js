(() => {
'use strict';

/* ---------- helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// The strip along the top carries the logo and the server's name. In the Umbryx desktop app (version 1.1 on)
// it doubles as the title bar: the window has no Windows one, it is dragged by this strip, and the app lays
// the minimise, maximise and close buttons over the right-hand end of it.
// The app's own menu (change server, zoom, reload) opens from a button in Settings.
const appShell = window.umbryxApp && window.umbryxApp.titleBar ? window.umbryxApp : null;
// Desktop apps from before 1.4.9 have no zoom or update buttons for Settings, so there their menu opens instead.
if (appShell && !appShell.appInfo) {
  $('#setAppMenu').hidden = false;
  $('#setAppMenu').addEventListener('click', () => appShell.menu());
}

// From version 1.4 the app lays its column of servers over the left edge of the page instead of beside it,
// so the title strip runs the whole width of the window (the logo at the far left on Windows, after the
// window buttons on a Mac) and the panels at the bottom of the sidebar reach under the column, the way
// Discord has them. The page leaves room for the column and tells the app how tall those panels are.
// In a browser at least 701px wide the page draws a column like the app's itself (see makeWebRail), so the site
// looks and works like the app. railShell is whichever there is: what talked to the app's column talks to it.
const webRail = !(appShell && Number(appShell.rail) > 0) && matchMedia('(min-width: 701px)').matches ? makeWebRail() : null;
const railShell = webRail || (appShell && Number(appShell.rail) > 0 ? appShell : null);
const railWidth = railShell ? Number(railShell.rail) : 0;
if (railWidth) {
  document.documentElement.classList.add('app-rail');
  document.documentElement.style.setProperty('--rail-w', railWidth + 'px');
  if (appShell && appShell.platform === 'darwin') document.documentElement.classList.add('mac-app');
}

// From version 1.4.1 the app also has a Home button at the top of that column, so the sidebar shows one side at
// a time, as in Discord: Home (Friends in the middle, direct messages down the side) or the server (its
// channels). Which side is decided by what is on screen. In a browser, or an older app, it shows both.
const homeSplit = !!(railWidth && railShell.onHome && railShell.home);
if (railWidth && railShell.onRail) railShell.onRail((over) => document.documentElement.classList.toggle('rail-off', !over));
const isHomeView = () => state.view.type === 'friends' || state.view.type === 'dm'
  || (state.view.type === 'voice' && !channelById(state.view.id));   // a one-on-one call belongs to Home

// Tells the app which side is showing, and who has written to us (for the pictures under Home).
let homeTold = '';
function tellHome() {
  if (!homeSplit || !state.me) return;
  const unread = [...state.dms.entries()].filter(([id, e]) => state.users.has(id) && (e.unread || e.ping))
    .sort((a, b) => b[1].last - a[1].last).slice(0, 5)
    .map(([id, e]) => {
      const user = state.users.get(id);
      return { id, name: nick(user), count: e.unread || 1, color: colorOf(user.name), avatar: user.avatar ? location.origin + user.avatar : '' };
    });
  const info = { on: isHomeView(), unread };
  const key = JSON.stringify(info);
  if (key === homeTold) return;
  homeTold = key;
  railShell.home(info);
}

// The site's column (see webRail): Home, whoever has written unread messages, a line, then this server. Drawn the
// way the desktop app draws its own (desktop/rail.js), from what the page tells it (tellHome, updateTitle,
// showServerLook), and hidden while signed out.
function makeWebRail() {
  const nav = h('nav', { class: 'web-rail', 'aria-label': 'Home and server', hidden: true });
  document.body.append(nav);
  document.documentElement.classList.add('rail-off');   // no room kept for it on the sign-in screen
  let side = null;
  const shown = { home: { on: false, unread: [] }, icon: '', partner: false, unread: 0, ringing: false };
  const initials = (name) => {
    const words = String(name || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
    return words.length ? (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase() : '?';
  };
  const count = (n) => h('span', { class: 'rail-badge', text: n > 99 ? '99+' : String(n) });
  const picture = (src, fallback, button) => {
    const img = h('img', { class: 'rail-icon', src, alt: '' });
    img.addEventListener('error', () => img.replaceWith(fallback));
    button.prepend(img);
  };
  // The name of what is under the pointer, in a bubble beside the column (as in the desktop app, and Discord).
  const tip = h('div', { class: 'rail-tip', role: 'tooltip', hidden: true });
  document.body.append(tip);
  // A partnered server's bubble has the partner check before its name, as its header does.
  const named = (el, text, partner) => {
    el.setAttribute('aria-label', partner ? `${text} (Umbryx Partner)` : text);
    el.addEventListener('mouseenter', () => {
      const box = el.getBoundingClientRect();
      tip.replaceChildren(...(partner ? [icon('partner')] : []), h('span', { class: 'rail-tip-name', text }));
      tip.style.top = Math.round(box.top + box.height / 2) + 'px';
      tip.hidden = false;
    });
    el.addEventListener('mouseleave', () => { tip.hidden = true; });
    return el;
  };
  const draw = () => {
    tip.hidden = true;   // what it was over may be gone
    const home = named(h('button', { class: 'rail-server rail-home' + (shown.home.on ? ' active' : ''), type: 'button',
      onclick: () => side && side('home') }, h('img', { src: '/icon.svg', alt: '' })), 'Home');
    const people = shown.home.unread.map((p) => {
      const dm = h('button', { class: 'rail-server rail-dm unread', type: 'button', dataset: { person: p.id }, onclick: () => openDM(p.id) },
        p.avatar ? null : initials(p.name), count(p.count));
      dm.style.background = p.color;
      if (p.avatar) picture(p.avatar, initials(p.name), dm);
      return named(dm, p.name);
    });
    const items = [home, ...people];
    if (state.me && !state.guest) {
      const name = state.info.serverName || 'Umbryx';
      const server = h('button', { class: 'rail-server' + (shown.home.on ? '' : ' active') + (shown.unread ? ' unread' : '') + (shown.ringing ? ' ringing' : ''),
        type: 'button', onclick: () => side && side('server') },
        shown.icon ? null : initials(name), shown.unread ? count(shown.unread) : null);
      if (shown.icon) picture(shown.icon, initials(name), server);
      items.push(h('div', { class: 'rail-line' }), named(server, name, shown.partner));
    }
    nav.replaceChildren(...items);
  };
  return {
    rail: 72,
    onHome: (listener) => { side = listener; },
    home: (info) => { shown.home = info; draw(); },
    server: (info) => { shown.icon = info.icon || ''; shown.partner = !!info.partner; draw(); },
    // The server's own unread messages (its channels) and whether a call rings, as the app reads them from the title.
    counts: (unread, ringing) => { if (unread !== shown.unread || ringing !== shown.ringing) { shown.unread = unread; shown.ringing = ringing; draw(); } },
    layout: ({ top, bottom }) => { nav.style.top = `calc(var(--titlebar) + ${top || 0}px)`; nav.style.bottom = (bottom || 0) + 'px'; },
    signedIn: (on) => { nav.hidden = !on; document.documentElement.classList.toggle('rail-off', !on); if (on) draw(); },
  };
}

function reportLayout() {
  if (!railWidth || !railShell.layout) return;
  // Over a theme's picture the window's parts are cards 10px in from the edges, the column's included (see
  // style.css), with the sidebar's bottom panels inside the sidebar's card rather than under the column: the column
  // then runs from 10px below the title strip to 10px above the bottom. (From desktop app 1.4.12; older ones keep
  // it right under the title strip.)
  if (document.documentElement.classList.contains('backdropped') && !$('#app').hidden && !matchMedia('(max-width: 700px)').matches) {
    railShell.layout({ top: 10, bottom: 10 });
    return;
  }
  const panels = [$('#voicePanel'), $('.user-panel')].filter((el) => el && !el.hidden && el.offsetHeight);
  const shown = panels.length && !$('#app').hidden && !matchMedia('(max-width: 700px)').matches;
  // Measured up from the bottom of the sidebar by the panels' heights: their own position on screen is off while
  // they slide in (the "Voice connected" panel rises into place), which left the column overlapping it.
  const top = shown ? $('.sidebar').getBoundingClientRect().bottom - panels.reduce((sum, el) => sum + el.offsetHeight, 0) : innerHeight;
  railShell.layout({ top: 0, bottom: Math.max(0, Math.round(innerHeight - top)) });
}
if (railWidth) {
  const watch = new ResizeObserver(() => reportLayout());
  for (const el of [$('#app'), $('#voicePanel'), $('.user-panel')]) {
    watch.observe(el);
    el.addEventListener('animationend', reportLayout);
  }
  window.addEventListener('resize', reportLayout);
  reportLayout();
}

const ICONS = {
  hash: '<path d="M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h16M3.5 15h16"/>',
  speaker: '<path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="6.5" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="6.5" rx="1.5"/>',
  screen: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  arrowRight: '<path d="M4 12h15M13 6l6 6-6 6"/>',
  flag: '<path d="M5.5 21V4"/><path d="M5.5 4.5h11.5l-2.5 4 2.5 4H5.5"/>',
  block: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.9 12.1 20 3M16.5 6.5l3 3M14 9l2.5 2.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5z"/>',
  mobile: '<rect x="7" y="3" width="10" height="18" rx="2.2"/><path d="M11 17.5h2"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.2"/><circle cx="9" cy="10" r="1.6"/><path d="m5.5 17 4.2-4.2 2.8 2.8 2.5-2.5 3.5 3.6"/>',
  turn: '<path d="M19.5 12a7.5 7.5 0 1 1-2.7-5.8"/><path d="M19.6 4.4v4.2h-4.2"/>',
  camera: '<rect x="2.5" y="6.5" width="13" height="11" rx="2.2"/><path d="m15.5 10.6 6-3.1v9l-6-3.1z"/>',
  hangup: '<path d="M3.2 14.6c4.9-4.8 12.7-4.8 17.6 0l-2.3 2.4-3.6-1.7-.3-2.7a9 9 0 0 0-5.2 0l-.3 2.7-3.6 1.7z"/>',
  phone: '<path d="M6.6 3.5h3l1.4 4-1.9 1.4a12 12 0 0 0 6 6l1.4-1.9 4 1.4v3a2 2 0 0 1-2.1 2A16.5 16.5 0 0 1 4.6 5.6a2 2 0 0 1 2-2.1z"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5c.6-3.3 3-5 6-5s5.4 1.7 6 5"/><path d="M16 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.8c1.9.6 3.1 2.2 3.5 4.7"/>',
  chat: '<path d="M4.5 5.5h15A1.5 1.5 0 0 1 21 7v8.5a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 3.5V17h-2A1.5 1.5 0 0 1 3 15.5V7a1.5 1.5 0 0 1 1.5-1.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5.5M14 11v5.5"/>',
  pin: '<path d="M9 4h6l-1 5.2 3.5 3.3V14h-11v-1.5L10 9.2z"/><path d="M12 14v6"/>',
  reply: '<path d="M10 7.5 5 12l5 4.5"/><path d="M5 12h8a6 6 0 0 1 6 6v.5"/>',
  pencil: '<path d="M4.5 19.5l1-4L16 5l3 3L8.5 18.5z"/><path d="M14 7l3 3"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14a4.2 4.2 0 0 0 7 0M9 9.8v.4M15 9.8v.4"/>',
  star: '<path d="m12 3.8 2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8 6.9 19.5l1-5.7-4.1-4 5.7-.8z"/>',
  // badge emblems, flat and filled like Discord's (see .f, .f2 and .f3 in style.css)
  emStaff: '<path class="f" d="M12 1.8l8.4 3.1v6.3c0 5.3-3.5 9.5-8.4 11.1-4.9-1.6-8.4-5.8-8.4-11.1V4.9z"/><path class="f2" d="M12 1.8l8.4 3.1v6.3c0 5.3-3.5 9.5-8.4 11.1z"/><path class="w" d="M10 8.9 6.9 12l3.1 3.1M14 8.9l3.1 3.1-3.1 3.1"/>',   // a solid shield with </> cut into it
  emOwner: '<path class="f" d="M5 10h14a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 19 16H5a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 5 10zM5 17h14a1.5 1.5 0 0 1 1.5 1.5v1.5A1.5 1.5 0 0 1 19 21.5H5A1.5 1.5 0 0 1 3.5 20v-1.5A1.5 1.5 0 0 1 5 17z"/><circle class="f3" cx="7" cy="13" r="1"/><circle class="f3" cx="7" cy="19.2" r="1"/><path class="f" d="M6.5 8.6l1.6-4.6 2.3 2.4L12 3l1.6 3.4 2.3-2.4 1.6 4.6z"/>',   // a stack of servers wearing a crown
  emEarly: '<path class="f" d="M4.4 16.6a7.6 7.6 0 0 1 15.2 0z"/><path class="f" d="M2.2 18.2h19.6v2.4H2.2z"/><path d="M12 3.4v3M4.6 6.6l2.1 2.1M19.4 6.6l-2.1 2.1"/><path class="f2" d="M8.4 16.6a3.6 3.6 0 0 1 3.6-3.6v3.6z"/>',
  partner: '<path class="solid" d="M23.4 12.0L23.2 12.7L22.5 13.4L21.8 14.0L21.4 14.5L21.5 15.2L21.8 16.1L22.0 17.0L21.9 17.7L21.3 18.2L20.4 18.5L19.5 18.6L18.9 18.9L18.6 19.5L18.5 20.4L18.2 21.3L17.7 21.9L17.0 22.0L16.1 21.8L15.2 21.5L14.5 21.4L14.0 21.8L13.4 22.5L12.7 23.2L12.0 23.4L11.3 23.2L10.6 22.5L10.0 21.8L9.5 21.4L8.8 21.5L7.9 21.8L7.0 22.0L6.3 21.9L5.8 21.3L5.5 20.4L5.4 19.5L5.1 18.9L4.5 18.6L3.6 18.5L2.7 18.2L2.1 17.7L2.0 17.0L2.2 16.1L2.5 15.2L2.6 14.5L2.2 14.0L1.5 13.4L0.8 12.7L0.6 12.0L0.8 11.3L1.5 10.6L2.2 10.0L2.6 9.5L2.5 8.8L2.2 7.9L2.0 7.0L2.1 6.3L2.7 5.8L3.6 5.5L4.5 5.4L5.1 5.1L5.4 4.5L5.5 3.6L5.8 2.7L6.3 2.1L7.0 2.0L7.9 2.2L8.8 2.5L9.5 2.6L10.0 2.2L10.6 1.5L11.3 0.8L12.0 0.6L12.7 0.8L13.4 1.5L14.0 2.2L14.5 2.6L15.2 2.5L16.1 2.2L17.0 2.0L17.7 2.1L18.2 2.7L18.5 3.6L18.6 4.5L18.9 5.1L19.5 5.4L20.4 5.5L21.3 5.8L21.9 6.3L22.0 7.0L21.8 7.9L21.5 8.8L21.4 9.5L21.8 10.0L22.5 10.6L23.2 11.3Z"/><path class="mark" d="M7.6 12.3l3 3 5.8-6.4"/>',
  staff: '<path d="M12 3 4.5 6v5.6c0 4.5 3.2 8.1 7.5 9.4 4.3-1.3 7.5-4.9 7.5-9.4V6z"/><path d="m10.2 9.6-2.4 2.4 2.4 2.4M13.8 9.6l2.4 2.4-2.4 2.4"/>',
  crown: '<path d="M4.5 18.5h15M5.5 18.5 4 8.5l4.5 3.5L12 5.5l3.5 6.5L20 8.5l-1.5 10z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  play: '<path d="M7.5 5v14l11-7z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5M8 10.5h5M10.5 8v5"/>',
  download: '<path d="M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 19.5h14"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M10 6H5.5v12.5H18V14"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  clip: '<path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7-7l8.2-8.2a3.3 3.3 0 0 1 4.7 4.7l-8.2 8.1a1.7 1.7 0 0 1-2.4-2.4l7.5-7.4"/>',
  send: '<path d="M4 12 20 4l-5 16-3.5-6.5z"/><path d="M11.5 13.5 20 4"/>',
  expand: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  shrink: '<path d="M4 14h6v6M20 10h-6V4M10 14l-6 6M14 10l6-6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  slash: '<path d="M4 4l16 16"/>',
};

function icon(name, off) {
  const el = document.createElement('span');
  el.className = 'icon' + (off ? ' off' : '');
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}${off ? ICONS.slash : ''}</svg>`;
  return el;
}

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('umbryx.' + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('umbryx.' + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

// The sign-in token for this device. With "sign in automatically" it is kept after the browser closes;
// without it, it lives only until this tab or the browser is closed.
const tabToken = {
  get() { try { return sessionStorage.getItem('umbryx.session') || ''; } catch { return ''; } },
  set(value) {
    try {
      if (value) sessionStorage.setItem('umbryx.session', value); else sessionStorage.removeItem('umbryx.session');
    } catch { /* private mode */ }
  },
};
const session = {
  keep: () => store.get('keep', true) !== false,
  kept: () => store.get('session', ''),
  get: () => store.get('session', '') || tabToken.get(),
  set(token, keep) {
    store.set('keep', !!keep);
    store.set('session', keep ? token : '');
    tabToken.set(keep ? '' : token);
  },
  clear() { store.set('session', ''); tabToken.set(''); },
};

// The desktop app reaches this server at its own address (welcome.appAddress, e.g. https://app.example.com) when it
// came in some other way, such as the home IP: the page asks it to move there, handing over this device's sign-in
// and settings (what this page keeps under "umbryx."), so nobody has to sign in again. The app (1.4.21 on) moves
// only once that address answers with a trusted certificate and is this same server; until then nothing changes.
let moveOffered = false;
function offerMove(m) {
  if (moveOffered || !appShell || typeof appShell.moveServer !== 'function' || !m.appAddress) return;
  let target;
  try { target = new URL(m.appAddress); } catch { return; }
  if (target.protocol !== 'https:' || target.origin === location.origin) return;
  moveOffered = true;
  const local = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('umbryx.')) local[key] = localStorage.getItem(key);
    }
  } catch { /* nothing kept */ }
  appShell.moveServer({ address: target.origin + '/', local, tab: tabToken.get() });
}

// Tells the server to stop accepting a sign-in token. Works without being connected.
function forgetToken(token) {
  if (!token) return;
  fetch('/api/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: token }) }).catch(() => {});
}

function hueOf(name) {
  let x = 0;
  for (const ch of name) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return x % 360;
}
const colorOf = (name) => `hsl(${hueOf(name)} 62% 66%)`;

// Set by applyTheme: on a light background names are darkened instead of lightened, so they stay readable.
let lightTheme = false;

// The colour a name is written in: the one its owner picked, or one worked out from the name.
// Very dark picks are lifted towards white so the name stays readable on the black background.
function nameColor(user) {
  const hex = user && /^#[0-9a-f]{6}$/i.test(user.color || '') ? user.color : '';
  if (!hex) return lightTheme ? `hsl(${hueOf((user && user.name) || '')} 60% 36%)` : colorOf((user && user.name) || '');
  const n = parseInt(hex.slice(1), 16);
  const rgb = [n >> 16, (n >> 8) & 255, n & 255];
  const light = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  if (lightTheme) {   // too light to read on a light background: darkened just enough
    if (light <= 0.5) return hex;
    const drop = (light - 0.5) / light;
    return `rgb(${rgb.map((v) => Math.round(v * (1 - drop))).join(' ')})`;
  }
  if (light >= 0.32) return hex;
  const lift = (0.32 - light) / (1 - light);
  return `rgb(${rgb.map((v) => Math.round(v + (255 - v) * lift)).join(' ')})`;
}

// Someone's custom status text, unless its time has run out.
// The name to show for someone: their display name if they chose one, otherwise their username. (The username
// stays what @mentions, from: searches and signing in use.)
// Nameplates: an animated design behind someone's name in the direct messages list, the member list and voice
// channels (drawn in style.css), or their own picture or short video. PLATES: the designs and their names.
const PLATES = { nebula: 'Nebula', ember: 'Ember', aurora: 'Aurora', synth: 'Synthwave', ocean: 'Ocean', sakura: 'Sakura', glitch: 'Glitch', gold: 'Gold' };
const plateVideo = (url) => /\.(mp4|m4v|webm)$/i.test(url);
function plateEl(plate, fit) {
  if (!plate) return null;
  // .plate is the row's size and fades out towards the name; .plate-art inside it is the design, one size everywhere
  if (PLATES[plate]) return h('span', { class: 'plate', 'aria-hidden': 'true' }, h('span', { class: 'plate-art ' + plate }));
  if (!String(plate).startsWith('/uploads/')) return null;
  return h('span', { class: 'plate', 'aria-hidden': 'true' }, h('span', { class: 'plate-art custom' }, plateVideo(plate)
    ? h('video', { src: plate, autoplay: true, muted: true, loop: true, playsInline: true })
    : placedImage(plate, fit)));
}
// An uploaded nameplate picture, placed where its owner put it in the picture editor.
function placedImage(url, fit) {
  const img = h('img', { src: url, alt: '', loading: 'lazy' });
  applyFit(img, fit);
  return img;
}
const plated = (user) => (user && user.plate ? ' plated' : '');

// The name shown for someone: the nickname you gave them (only you see it), else their display name, else their username.
const nick = (user) => (user && ((!user.deleted && state.nicknames && state.nicknames.get(user.id)) || user.display || user.name)) || '';
const noteOf = (user) => (user && user.note && (!user.noteUntil || user.noteUntil > Date.now()) ? user.note : '');

// Three bouncing dots: someone is typing.
const dots = () => h('span', { class: 'dots', title: 'Typing…' }, h('i'), h('i'), h('i'));

// A profile picture, or the first letter on a colour when there is none. GIFs animate on their own.
function avatar(user, size) {
  const letter = ([...user.name.trim()][0] || '?').toUpperCase();
  const el = h('span', { class: 'avatar' + (size ? ' ' + size : '') });
  el.style.setProperty('--c', colorOf(user.name));
  if (user.avatar) {
    const img = h('img', { src: user.avatar, alt: '', onerror: () => { el.textContent = letter; } });
    applyFit(img, user.fit);
    el.append(img);
  } else el.textContent = letter;
  return el;
}

// Draws a profile picture where its owner placed it in the picture editor: its size and centre as
// percentages of the circle, and its turn. Without a placement the picture simply fills the circle.
function applyFit(img, fit) {
  if (!fit) return;
  img.classList.add('fit');
  img.style.width = fit.w + '%';
  img.style.height = fit.h + '%';
  img.style.left = fit.x + '%';
  img.style.top = fit.y + '%';
  img.style.transform = `translate(-50%, -50%) rotate(${fit.r}deg)`;
}

// Badges, given by whoever runs the server (config.json). They show on the profile card only, not next to names.
const BADGES = {
  staff: { label: 'Umbryx Staff', icon: 'emStaff', color: '#6c8cff', about: 'Part of the team behind Umbryx.' },
  owner: { label: 'Server Owner', icon: 'emOwner', color: '#f2b24a', about: 'Runs their own Umbryx server, checked by Umbryx Staff.' },
  early: { label: 'Early Supporter', icon: 'emEarly', color: '#ff7eb6', about: 'Was here early on, helping Umbryx get off the ground.' },
  partner: { label: 'Umbryx Partner', icon: 'partner', color: 'var(--partner-text)', about: 'Officially partnered with Umbryx.' },
};
const badgeList = (user) => (user && Array.isArray(user.badges) ? user.badges.filter((b) => BADGES[b]) : []);

// A picture with a status dot: green online, a yellow moon idle, red do-not-disturb, grey offline.
const isDnd = (user) => !!user.online && user.status === 'dnd';
const isIdle = (user) => !!user.online && !!user.idle && !isDnd(user);
const presence = (user, size) => h('span', { class: 'pres' + (isDnd(user) ? ' dnd' : isIdle(user) ? ' idle' : user.online ? ' online' : '') }, avatar(user, size));

// A banner is placed in the picture editor for one shape (30 by 11, the profile card's). The strip along the top
// of a voice tile is another shape, so there it simply fills.
function bannerEl(user, cls) {
  const img = user.banner ? h('img', { src: user.banner, alt: '' }) : null;
  if (img && cls !== 'person-banner') applyFit(img, user.bannerFit);
  const el = h('div', { class: cls }, img);
  el.style.setProperty('--c', colorOf(user.name));
  return el;
}

function toast(text, ms = 4000) {
  const el = h('div', { class: 'toast', text });
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

function prettySize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const dayKey = (ts) => { const d = new Date(ts); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };

function stamp(ts) {
  const time = timeFormat.format(ts);
  if (dayKey(ts) === dayKey(Date.now())) return 'Today at ' + time;
  if (dayKey(ts) === dayKey(Date.now() - 864e5)) return 'Yesterday at ' + time;
  return new Date(ts).toLocaleDateString() + ' ' + time;
}

/* ---------- state ---------- */

const settings = Object.assign(
  { inputId: '', outputId: '', cameraId: '', noiseSuppression: true, echoCancellation: true, autoGainControl: true, sounds: true, notify: 'all' },
  store.get('settings', {}));
// Noise suppression: 'strong' (RNNoise, see denoise), 'standard' (the browser's own) or 'off'. It used to be on or
// off, and on was the browser's; everyone who had it on gets Strong.
if (!['strong', 'standard', 'off'].includes(settings.noiseMode)) settings.noiseMode = settings.noiseSuppression === false ? 'off' : 'strong';
// height: 'auto' (the screen's own size up to 4K; each viewer's copy then fits their connection, see tuneVideoSender)
// or a fixed size. There is no 4K choice any more (Automatic goes up to it): whoever had it gets Automatic.
const shareOpts = Object.assign(
  { height: 'auto', fps: 60, bitrate: 0, codec: 'auto', mode: 'motion', audio: true },
  store.get('share', {}));
if (shareOpts.height === 2160) shareOpts.height = 'auto';
const volumes = store.get('volumes', {});

const state = {
  info: { serverName: 'Umbryx', passwordRequired: false, httpsPort: null, autoLogin: '' },
  me: null,            // { id, name }
  token: null,
  connected: false,
  channels: [],
  users: new Map(),    // everyone with an account here, online or not
  friends: { friends: [], incoming: [], outgoing: [] },
  dms: new Map(),      // user id -> { last, unread, ping }
  pinged: new Set(),   // people on do-not-disturb we have already used our one ping on
  emojis: new Map(),   // custom emoji: name -> picture address
  favorites: [],       // our starred pictures, GIFs and videos: { url, name, kind }
  replyTo: null,       // message being replied to: { id, name, key }
  editing: null,       // our own message being edited: { id, key, draft }
  view: { type: 'text', id: null },   // text | dm | voice | friends
  cache: new Map(),    // channel id or "dm:<user id>" -> { list, loaded, loading, more }
  unread: new Map(),   // text channel id -> count
  typing: new Map(),   // conversation key -> Map(name -> timer)
  call: null,          // { id, with, incoming, room }
  theme: null,         // this account's colour theme, null for the standard look
  voiceStarted: new Map(),   // voice channel or call room -> when it started (this device's clock)
  mentions: new Map(),       // text channel id -> messages there mentioning us, not seen yet
  iceServers: [],
  maxUploadMB: 200,
};

const rtc = {
  channel: null,       // voice channel id, or the private room of a one-on-one call
  joinedAt: 0,         // when this device joined it (Date.now()), for the call timer
  joining: false,
  peers: new Map(),
  mic: null,           // { stream, track, source, analyser }
  muted: false,
  deafened: false,
  mutedBeforeDeafen: false,
  screen: null,        // { stream, videoTrack, audioTrack, opts, gpuCodecs, order }
  camera: null,        // { stream, track }
  cameraOpening: false,
  ctx: null,
  speaking: new Set(),
};

const self = () => state.users.get(state.me.id);
// Beside someone in voice: deafened or muted, in red when an admin did it.
function voiceMarks(u) {
  const byAdmin = (name, tip) => { const mark = icon(name, true); mark.classList.add('mod-mark'); mark.dataset.tip = tip; return mark; };
  if (u.serverDeafened) return byAdmin('headphones', 'Deafened by an admin');
  if (u.deafened) return icon('headphones', true);
  if (u.serverMuted) return byAdmin('mic', 'Muted by an admin');
  return u.muted ? icon('mic', true) : null;
}
const channelById = (id) => state.channels.find((c) => c.id === id);
const usersIn = (id) => [...state.users.values()].filter((u) => u.voice === id).sort((a, b) => a.name.localeCompare(b.name));
const firstText = () => (state.channels.find((c) => c.type === 'text') || {}).id;
const lastText = () => { const id = store.get('lastText'); return channelById(id) ? id : firstText(); };
const isConv = () => state.view.type === 'text' || state.view.type === 'dm';
const convKey = () => (state.view.type === 'dm' ? 'dm:' + state.view.id : state.view.id);
const authorOf = (m) => state.users.get(m.uid) || { name: m.name || 'Unknown' };

function cacheFor(key) {
  if (!state.cache.has(key)) state.cache.set(key, { list: [], loaded: false, loading: false, more: false });
  return state.cache.get(key);
}

// What someone is on, small and grey after their name (members, friends, direct messages): the desktop app, the
// website or the phone app, as the server tells (user.devices, desktop app first). Hover one for which.
const DEVICE_LOOK = { desktop: ['screen', 'On the desktop app'], web: ['globe', 'On the website'], mobile: ['mobile', 'On the phone app'] };
function devicesEl(user) {
  const on = user && user.online && Array.isArray(user.devices) ? user.devices.filter((d) => DEVICE_LOOK[d]) : [];
  if (!on.length) return null;
  // Coloured like their status dot: green online, yellow idle, red do not disturb.
  const status = isDnd(user) ? 'dnd' : isIdle(user) ? 'idle' : 'online';
  return h('span', { class: 'devices ' + status, 'aria-label': on.map((d) => DEVICE_LOOK[d][1]).join(', ') }, on.map((d) => {
    const mark = icon(DEVICE_LOOK[d][0]);
    mark.dataset.tip = DEVICE_LOOK[d][1];
    return mark;
  }));
}

// The same after the writer's name on messages, in a slot that refreshDevices fills again when they come or go.
const msgDevices = (user) => h('span', { class: 'msg-devices', dataset: { devicesOf: user.id } }, devicesEl(user));
function refreshDevices(id) {
  for (const slot of $$(`.msg-devices[data-devices-of="${CSS.escape(id)}"]`)) slot.replaceChildren(...[devicesEl(state.users.get(id))].filter(Boolean));
}

function statusOf(user) {
  if (!user.online) return 'Offline';
  const ch = channelById(user.voice);
  const where = !user.voice ? '' : ch ? `In voice · ${ch.name}` : 'In a call';
  if (isDnd(user)) return where ? `Do not disturb · ${where}` : 'Do not disturb';
  if (isIdle(user)) return where ? `Idle · ${where}` : 'Idle';
  return where || 'Online';
}

/* What people are doing: a game (through Discord's channel) or Spotify, from their desktop app. */

const ACTIVITY_VERBS = { 0: 'Playing', 2: 'Listening to', 3: 'Watching', 5: 'Competing in' };
const activitiesOf = (user) => (user && user.online && Array.isArray(user.activities) ? user.activities : []);

// A person as the server describes them, with the times of what they are doing put on this computer's clock.
function takeUser(u) {
  const now = Date.now();
  for (const a of Array.isArray(u.activities) ? u.activities : []) {
    a.since = a.ago == null ? 0 : now - a.ago;
    a.until = a.left == null ? 0 : now + a.left;
  }
  return u;
}

// For lists, one line, a game before music as in Discord: "Playing Minecraft", "Listening to Spotify".
function activityLine(user) {
  const list = activitiesOf(user);
  const a = list.find((x) => x.source !== 'spotify') || list[0];
  return a ? { verb: ACTIVITY_VERBS[a.kind] || 'Playing', name: a.name } : null;
}
// The small picture of the game someone is playing, for the voice channel list (the game's name on hover).
function gameMark(user) {
  const game = activitiesOf(user).find((a) => a.source !== 'spotify' && (a.icon || a.image));
  return game ? h('img', { class: 'vm-game', src: game.icon || game.image, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer',
    title: `${ACTIVITY_VERBS[game.kind] || 'Playing'} ${game.name}` }) : null;
}
const activityText = (line) => h('span', { class: 'member-note act-line', title: `${line.verb} ${line.name}` }, `${line.verb} `, h('b', { text: line.name }));

// "1:23", or "1:02:03" past an hour.
function clockOf(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${ss}` : `${Math.floor(s / 60)}:${ss}`;
}

// The profile card's part for each thing someone is doing. A song shows its cover, name, artist and album with
// how far in it is and how much is left; a game its picture, what it says, and how long it has been going.
function activityBlock(a) {
  const spotify = a.source === 'spotify';
  const head = spotify ? 'Listening to Spotify' : a.kind === 0 ? 'Playing a game' : `${ACTIVITY_VERBS[a.kind]} ${a.name}`;
  const art = a.image || a.icon;
  const picture = art ? h('span', { class: 'act-art' },
    h('img', { src: art, alt: '', title: a.imageText || a.name, referrerPolicy: 'no-referrer', loading: 'lazy' }),
    a.small ? h('img', { class: 'act-small', src: a.small, alt: '', title: a.smallText || '', referrerPolicy: 'no-referrer' }) : null) : null;
  // On a song, its name, its album and each artist open in Spotify (desktop app 1.4.8 on sends the links).
  const opens = (url, text) => (url ? h('a', { class: 'act-link', ...external(url), text, title: `${text} on Spotify` }) : text);
  const artists = Array.isArray(a.artists) && a.artists.length
    ? a.artists.flatMap((x, i) => [i ? ', ' : '', opens(x.url, x.name)]) : [a.state];
  const lines = spotify
    ? [h('b', { title: a.details }, opens(a.trackUrl, a.details || 'Something')), a.state ? h('span', { title: a.state }, 'by ', ...artists) : null,
      a.album ? h('span', { title: a.album }, 'on ', opens(a.albumUrl, a.album)) : null]
    : [h('b', { text: a.name, title: a.name }), a.details ? h('span', { text: a.details, title: a.details }) : null,
      a.state || a.party ? h('span', { text: [a.state, a.party ? `(${a.party[0]} of ${a.party[1]})` : ''].filter(Boolean).join(' ') }) : null];
  // A start and an end (a song): a bar with the time gone and the time left. Otherwise how long it has gone on.
  let time = null;
  if (a.since && a.until && a.until > a.since) {
    const fill = h('i', { class: 'act-fill' });
    time = h('div', { class: 'act-bar act-time' }, h('span'), h('span', { class: 'act-track' }, fill), h('span'));
    time.paint = () => {
      const total = a.until - a.since;
      const done = Math.min(total, Math.max(0, Date.now() - a.since));
      fill.style.width = `${(done / total) * 100}%`;
      time.firstChild.textContent = clockOf(done);
      time.lastChild.textContent = `-${clockOf(total - done)}`;
    };
  } else if (a.since || a.until) {
    time = h('span', { class: 'act-clock act-time' });
    time.paint = () => { time.textContent = a.since ? `${clockOf(Date.now() - a.since)} elapsed` : `${clockOf(a.until - Date.now())} left`; };
  }
  if (time) time.paint();
  return h('div', { class: 'act-block' + (spotify ? ' spotify' : '') }, h('div', { class: 'card-h', text: head }),
    h('div', { class: 'act' }, picture, h('div', { class: 'act-text' }, lines, time && !time.classList.contains('act-bar') ? time : null)),
    time && time.classList.contains('act-bar') ? time : null);
}
const activityBlocks = (user) => activitiesOf(user).map(activityBlock);
setInterval(() => { for (const el of $$('.act-time')) if (el.paint) el.paint(); }, 1000);

function roomLabel(id) {
  const ch = channelById(id);
  if (ch) return ch.name;
  const other = state.call && state.users.get(state.call.with);
  return other ? `Call with ${nick(other)}` : 'Call';
}

/* ---------- connection ---------- */

let ws = null;
let retries = 0;
let retryTimer = 0;
let stopped = true;
let pendingAuth = null;   // sign-in details typed into the form; never stored
let keepChoice = null;    // the "sign in automatically" box as it was when the form was sent
const AUTH_ERRORS = new Set(['passkey-login', 'bad-login', 'bad-name', 'name-taken', 'weak-password', 'bad-server-password', 'auth-wait', 'no-guests', 'guest-wait', 'bad-invite']);

function connect() {
  clearTimeout(retryTimer);
  stopped = false;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = socket;
  socket.onopen = () => {
    retries = 0;
    // client: what this is, for the dot by our name (the desktop app loads this same page).
    const client = window.umbryxApp ? 'desktop' : 'web';
    send(pendingAuth ? { type: 'auth', client, ...pendingAuth } : { type: 'auth', client, mode: 'resume', session: session.get() });
  };
  socket.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    const handler = handlers[msg.type];
    if (handler) handler(msg);
  };
  socket.onclose = () => {
    if (socket !== ws) return;
    state.connected = false;
    $('#conn').hidden = false;   // shown only while the connection is down
    reportLayout();
    if (!stopped) retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retries++, 15000));
  };
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

/* ---------- themes ---------- */

// Each account picks its own look in Settings: a background and an accent colour, from which the rest of the
// palette is worked out, optionally the colour of the writing (a light background wants dark text), optionally
// fading into a second colour, and optionally a picture behind everything
// at the strength they choose. It is saved with the account, so it follows them to their other devices, and
// only they see it. The standard look is Onyx, true black, which is what style.css has.
const THEMES = [
  { preset: 'onyx', name: 'Onyx', bg: '#000000', accent: '#f2b24a' },
  { preset: 'graphite', name: 'Graphite', bg: '#18191d', accent: '#8b9cff' },
  { preset: 'midnight', name: 'Midnight', bg: '#080d1c', accent: '#6ea8ff' },
  { preset: 'forest', name: 'Forest', bg: '#06110b', accent: '#4fd18b' },
  { preset: 'wine', name: 'Wine', bg: '#13060a', accent: '#ff6b8f' },
  { preset: 'aurora', name: 'Aurora', bg: '#041016', accent: '#5ee6c8', gradient: { to: '#1b0b2e', angle: 160 } },
  { preset: 'ember', name: 'Ember', bg: '#0f0605', accent: '#ff9b4a', gradient: { to: '#2b0d06', angle: 200 } },
  { preset: 'dusk', name: 'Dusk', bg: '#0b0716', accent: '#c792ea', gradient: { to: '#2a0f2a', angle: 135 } },
];
const THEME_VARS = ['--bg', '--raised', '--hover', '--line', '--card', '--scroll', '--accent', '--accent-ink', '--text', '--dim', '--faint', '--stamp'];
const DEFAULT_TEXT = '#ffffff';
// The writing when no text colour is chosen: white on a dark background, near-black on a light one.
const autoText = (bg) => (luminance(bg) > 0.35 ? '#1f2328' : DEFAULT_TEXT);
const isHex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mixColor = (a, b, t) => { const y = hexRgb(b); return rgbHex(hexRgb(a).map((v, i) => v + (y[i] - v) * t)); };
function luminance(hex) {
  const [r, g, b] = hexRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// A theme in the shape that is saved: null is the standard look.
function normalTheme(t) {
  if (!t || !isHex(t.bg) || !isHex(t.accent)) return null;
  const out = { preset: t.preset || '', bg: t.bg.toLowerCase(), accent: t.accent.toLowerCase() };
  if (isHex(t.text)) out.text = t.text.toLowerCase();   // chosen, even if it is the standard white: the dates and times follow it
  if (t.gradient && isHex(t.gradient.to)) out.gradient = { to: t.gradient.to.toLowerCase(), angle: Math.round(Number(t.gradient.angle) || 0) };
  if (t.image) { out.image = t.image; out.imageOpacity = Math.round(Number(t.imageOpacity ?? 45)); }
  const plain = out.bg === '#000000' && out.accent === '#f2b24a' && !out.text && !out.gradient && !out.image;
  return plain ? null : out;
}

let themeTold = 0;
function applyTheme(theme, preview) {
  const t = normalTheme(theme);
  const root = document.documentElement;
  for (const name of THEME_VARS) root.style.removeProperty(name);
  const bg = t ? t.bg : '#000000';
  if (t && !(t.bg === '#000000' && t.accent === '#f2b24a' && !t.text)) {
    // Surfaces step lighter from a dark background and darker from a light one. A chosen text colour changes
    // the writing only, never the panels.
    const light = luminance(bg) > 0.35;
    const toward = light ? '#000000' : '#ffffff';
    const colors = {
      '--bg': bg, '--raised': mixColor(bg, toward, 0.05), '--hover': mixColor(bg, toward, 0.09),
      '--line': mixColor(bg, toward, 0.12), '--card': mixColor(bg, toward, 0.025), '--scroll': mixColor(bg, toward, 0.15),
      '--accent': t.accent, '--accent-ink': luminance(t.accent) > 0.3 ? mixColor(t.accent, '#000000', 0.86) : '#ffffff',
    };
    if (light) Object.assign(colors, { '--text': '#1f2328', '--dim': '#4f5560', '--faint': '#7d838d' });
    // A chosen text colour: the writing, and the dates and message times, in exactly that colour; the other
    // quieter writing (headings, hints) in softer shades of it.
    if (t.text) Object.assign(colors, { '--text': t.text, '--dim': mixColor(t.text, bg, 0.18), '--faint': mixColor(t.text, bg, 0.3), '--stamp': t.text });
    for (const [name, value] of Object.entries(colors)) root.style.setProperty(name, value);
  }
  root.style.colorScheme = luminance(bg) > 0.35 ? 'light' : '';   // the browser's own controls and scrollbars follow
  const wasLight = lightTheme;
  lightTheme = luminance(bg) > 0.35;
  root.classList.toggle('light-theme', lightTheme);
  if (wasLight !== lightTheme && state.me) {   // names are drawn for the background: draw them again
    refreshPeople();
    if (isConv()) redrawMessages();
  }
  const gradient = t && t.gradient;
  const image = t && typeof t.image === 'string' && t.image.startsWith('/uploads/') ? t.image : '';
  $('#backdrop').style.background = gradient ? `linear-gradient(${gradient.angle}deg, ${bg}, ${gradient.to})` : '';
  $('#backdropImg').style.backgroundImage = image ? `url("${image}")` : '';
  $('#backdropImg').style.opacity = image ? String(Math.max(0, Math.min(100, t.imageOpacity)) / 100) : '0';
  root.classList.toggle('backdropped', !!(gradient || image));
  reportLayout();   // the column of servers sits inside a card over a picture
  document.querySelector('meta[name="theme-color"]').content = bg;
  if (!preview) store.set('theme', t);   // the next start opens in it straight away, before the server has answered
  // The desktop app colours its column of servers and window buttons to match (a few times a second at most
  // while a colour is being dragged).
  if (appShell && appShell.theme && !themeTold) {
    themeTold = setTimeout(() => {
      themeTold = 0;
      const css = getComputedStyle(root);
      const read = (name) => css.getPropertyValue(name).trim();
      appShell.theme({ bg: read('--bg'), raised: read('--raised'), hover: read('--hover'), line: read('--line'),
        text: read('--text'), dim: read('--dim'), accent: read('--accent'), accentInk: read('--accent-ink') });
    }, 40);
  }
}
applyTheme(store.get('theme', null));

/* ---------- idle ---------- */

// After 20 minutes away the account shows as Idle, with a yellow moon, until you are back. Away means no key
// pressed and no mouse moved anywhere on the computer, as the desktop app sees it (playing a game is not
// away); in a browser, nothing done on this page. Never while in a voice channel or call, and do-not-disturb
// stays as it is. With several devices signed in, the server counts you idle only once all of them are.
const IDLE_AFTER = 20 * 60;   // seconds
// Sooner, the server hears that nobody is at this computer (away), so notifications go to their phone instead.
const AWAY_AFTER = 3 * 60;    // seconds
let lastActive = Date.now();
let idleSent = false;
let awaySent = false;

async function checkIdle() {
  if (!state.me || !state.connected) return;
  let away = (Date.now() - lastActive) / 1000;
  if (appShell && appShell.idleSeconds) {
    try { away = Number(await appShell.idleSeconds()) || 0; } catch { /* keep this page's own count */ }
  }
  const idle = away >= IDLE_AFTER && !rtc.channel;
  if (idle !== idleSent && send({ type: 'idle', idle })) idleSent = idle;
  const gone = away >= AWAY_AFTER && !rtc.channel;
  if (gone !== awaySent && send({ type: 'away', away: gone })) awaySent = gone;
}
for (const name of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
  window.addEventListener(name, () => { lastActive = Date.now(); if (idleSent || awaySent) checkIdle(); }, { passive: true, capture: true });
}
setInterval(checkIdle, 30000);

/* ---------- what you are playing ---------- */

// The desktop app (1.4.6 on) hears what you are playing: games, through the channel they use to tell Discord,
// and Spotify, through your Spotify account. The page passes it on to the server, which shows it to everyone.
// Times go as how long ago it started and how long is left, so computers whose clocks differ still agree.
let myActivities = [];

function sendActivities() {
  const now = Date.now();
  return send({ type: 'activity', activities: myActivities.map(({ start, end, ...a }) => ({ ...a,
    elapsed: start ? Math.max(0, now - start) : null, left: end ? Math.max(0, end - now) : null })) });
}
if (appShell && appShell.onActivity) {
  appShell.onActivity((list) => {
    myActivities = Array.isArray(list) ? list : [];
    if (state.connected) sendActivities();
  });
}

/* ---------- notifications ---------- */

// A new message, or a call, while you are not looking pops up as a notification from the system: in the
// desktop app the app shows it (only while its window is in the background), in a browser the browser does,
// once allowed. Settings chooses all messages, direct messages only, or none; do-not-disturb silences them.
function attachmentWord(a) {
  const name = String(a.name || a.url || '');
  if (/\.(png|apng|jpe?g|jfif|gif|webp|avif|bmp)$/i.test(name)) return 'a picture';
  if (/\.(mp4|m4v|webm|mov|mkv|ogv)$/i.test(name)) return 'a video';
  if (/\.(mp3|ogg|opus|wav|m4a|aac|flac)$/i.test(name)) return 'a sound file';
  return 'a file';
}

function notifyText(msg) {
  let text = String(msg.text || '').replace(/\|\|[\s\S]*?\|\|/g, '(spoiler)').replace(/\s+/g, ' ').trim();
  const files = msg.attachments || [];
  if (!text && files.length) text = files.length === 1 ? `Sent ${attachmentWord(files[0])}` : `Sent ${files.length} files`;
  return text.length > 160 ? text.slice(0, 157) + '…' : text;
}

const avatarIcon = (user) => (user && user.avatar ? location.origin + user.avatar : '');

let openLater = null;   // a notification clicked while this page was still signing in (Umbryx just started)
function openTarget(target) {
  if (!target) return;
  if (!state.me || !state.connected) { openLater = target; return; }
  if (target.kind === 'dm' && state.users.has(target.id)) openDM(target.id);
  else if (target.kind === 'text' && channelById(target.id)) openText(target.id);
}
if (appShell && appShell.onOpen) appShell.onOpen(openTarget);

function notify(note) {
  if (settings.notify === 'off' || !state.me || isDnd(self())) return;
  if (appShell && appShell.notify) { appShell.notify(note); return; }
  if (!('Notification' in window) || Notification.permission !== 'granted' || (!document.hidden && document.hasFocus())) return;
  try {
    const shown = new Notification(note.title, { body: note.body, icon: note.icon || '/icon.svg', tag: note.tag, silent: true });
    shown.onclick = () => { window.focus(); openTarget(note.open); shown.close(); };
  } catch { /* this browser only allows them from a service worker */ }
}

function notifyMessage(msg, where) {
  if (!state.me || msg.uid === state.me.id || typeof msg.join === 'number' || isBlocked(msg.uid)) return;   // nor join lines
  const mention = where.kind === 'text' && mentionsMe(msg.text);
  // A channel's own choice (right-click it): all, mentions, none; else the device's setting ("direct messages" still
  // hears mentions).
  const level = where.kind === 'text' ? (state.channelNotify || {})[where.id] : null;
  if (level === 'none') return;
  if (where.kind === 'text' && !mention && (level ? level !== 'all' : settings.notify !== 'all')) return;
  const from = state.users.get(msg.uid);
  const channel = where.kind === 'text' ? channelById(where.id) : null;
  const name = from ? nick(from) : 'Someone';
  notify({ title: channel ? `${name} ${mention ? 'mentioned you' : ''} in #${channel.name}`.replace('  ', ' ') : name, body: notifyText(msg), icon: avatarIcon(from),
    tag: channel ? channel.id : 'dm:' + msg.uid, open: where });
}

const handlers = {
  welcome(m) {
    const rejoin = rtc.channel;
    teardownVoice();   // peer connections from before a reconnect are gone on the other side too
    endCallUi();
    pendingAuth = null;
    if (m.session) {
      const old = session.get();
      if (old && old !== m.session) forgetToken(old);   // a different account was remembered here before
      session.set(m.session, keepChoice == null ? session.keep() : keepChoice);
    }
    keepChoice = null;
    state.me = { id: m.id };
    state.token = m.token;
    state.channels = m.channels;
    state.users = new Map(m.users.map((u) => [u.id, takeUser(u)]));
    state.me.name = self().name;
    store.set('lastUser', state.me.name);
    state.guest = !!m.guest;
    state.hasPassword = !!m.hasPassword;
    state.canDelete = m.canDelete || '';   // other people's accounts this one may delete: 'all', 'members' or ''
    state.nicknamesOn = !!m.nicknames;   // servers from before friend nicknames send none
    state.nicknames = new Map(Object.entries(m.nicknames || {}));
    setTimeout(() => loadEmoji().catch(() => {}), 2000);   // the emoji picker's list, ready before it is first opened
    store.set('lastGuest', state.guest && !state.hasPassword);   // only that device can get back in
    renderGuestNote();
    if (railShell && railShell.signedIn) railShell.signedIn(true);
    document.documentElement.classList.toggle('guest', state.guest);
    state.friends = m.friends;
    state.dms = new Map(m.dms.map((d) => [d.with, { last: d.last, unread: d.unread }]));
    state.pinged = new Set(m.pinged || []);
    state.emojis = new Map((m.emojis || []).map((e) => [e.name, e.url]));
    state.favorites = m.favorites || [];
    state.theme = normalTheme(m.theme);
    if (!look) applyTheme(state.theme);
    state.voiceStarted = new Map(Object.entries(m.voiceStarted || {}).map(([room, ago]) => [room, Date.now() - ago]));
    state.replyTo = null;
    state.iceServers = m.iceServers || [];
    state.maxUploadMB = m.maxUploadMB;
    state.cache.clear();
    state.connected = true;
    idleSent = false;   // a new connection starts out active
    for (const [url, entry] of previews) if (!entry.done) entry.asked = send({ type: 'embed', url });   // asked while offline
    // A new connection starts out doing nothing: say what this computer hears you playing.
    if (appShell && appShell.activity) {
      appShell.activity().then((list) => {
        myActivities = Array.isArray(list) ? list : [];
        if (myActivities.length) sendActivities();
      }).catch(() => {});
    }
    $('#conn').hidden = true;
    state.canManage = !!m.canManage;
    state.appAddress = m.appAddress || '';   // where invite links point (see inviteLink)
    state.passkeys = Array.isArray(m.passkeys) ? m.passkeys : [];
    state.passkeyDomain = m.passkeyDomain || '';
    state.passkeyLink = !!m.passkeyLink;
    state.channelNotify = m.channelNotify || {};
    state.blocked = new Set(Array.isArray(m.blocked) ? m.blocked : []);
    state.reports = [];
    state.canModerate = !!m.canModerate;   // sees reports, may delete anyone's channel message (admins and Staff)
    state.searchHas = !!m.searchHas;       // search can look for pictures, videos, files or links
    awaySent = false;
    stopPasskeyWait();
    checkBuild(m.build);
    showServerLook(m);
    showApp();
    const v = state.view;
    if (v.type === 'dm' && state.users.has(v.id)) openDM(v.id);
    // Just opened (nothing on screen yet): Home, as in Discord. A reconnect comes back to what was on screen.
    else if (v.type === 'friends' || state.guest || (v.type === 'text' && v.id == null)) openFriends();
    else openText(v.type === 'text' && channelById(v.id) ? v.id : lastText());
    if (openLater) { const target = openLater; openLater = null; openTarget(target); }
    // Back after a reconnect: rejoin, unless voice has since moved to another of this account's devices. Or back after
    // the desktop app restarted to update (see beforeRestart): into the voice channel it was in, if that was lately.
    const updated = store.get('rejoin', null);
    if (updated) store.set('rejoin', null);
    const back = updated && Date.now() - updated.at < 3 * 60 * 1000 && channelById(updated.channel) ? updated : null;
    if (rejoin && channelById(rejoin) && !self().voice) joinVoice(rejoin, true);
    else if (back && !rtc.channel && !self().voice) {
      rtc.muted = !!back.muted;
      rtc.deafened = !!back.deafened;
      rtc.mutedBeforeDeafen = !!back.mutedBeforeDeafen;
      applyDeafen();
      joinVoice(back.channel, true);
    } else updateControls();
    // In the desktop app, reached another way than the server's address for apps: move there (not while
    // rejoining a call; the next start offers again).
    if (!rejoin && !back) offerMove(m);
    // Opened from an invite link while signed in: join with it (or, for a guest without an account, make one).
    if (linkInvite) {
      const code = linkInvite;
      linkInvite = '';
      if (!state.info.inviteOnly) { /* nothing to join with */ }
      else if (state.guest && state.hasPassword) { if (confirm(`Join the server with the invite code ${code}?`)) send({ type: 'redeem', code }); }
      else if (state.guest) openClaim(code);
      else toast('You are already in the server.');
    }
  },

  error(m) {
    if (m.code === 'bad-session') {
      session.clear();
      stopped = true;
      // A stale saved session on the server computer falls through to the automatic sign-in.
      if (state.info.autoLogin && !state.me && session.keep()) setTimeout(autoSignIn, 50);
      else showLogin(state.me ? m.message : '');
    } else if (m.code === 'no-auto') {
      stopped = true;
      pendingAuth = null;
      state.info.autoLogin = '';
      showLogin('');
    } else if (AUTH_ERRORS.has(m.code)) {
      stopped = true;
      showLogin(m.message);
    } else if (m.code === 'claim') {
      $('#claimError').hidden = false;
      $('#claimError').textContent = m.message;
    } else if (m.code === 'delete' && $('#deleteDlg').open) {
      $('#deleteError').hidden = false;
      $('#deleteError').textContent = m.message;
    } else if (m.code === 'replaced') {   // from servers before one account could be on several devices
      stopped = true;
      teardownVoice();
      endCallUi();
      showLogin(m.message);
    } else toast(m.message || 'Something went wrong.');
  },

  theme(m) {
    state.theme = normalTheme(m.theme);
    if (!look) applyTheme(state.theme);   // while Settings is open its preview stays: Save or Cancel settles it
  },

  // A voice channel or call got its first person (ago: how long ago, in ms) or its last one left (ago: null).
  'voice-started'(m) {
    if (m.ago == null) state.voiceStarted.delete(m.room);
    else state.voiceStarted.set(m.room, Date.now() - m.ago);
    renderSidebar();
    paintVoiceClocks();
  },

  'user-join'(m) {
    state.users.set(m.user.id, takeUser(m.user));
    refreshPeople();
    refreshDevices(m.user.id);
  },

  'user-leave'(m) {
    const user = state.users.get(m.id);
    if (!user) return;
    if (rtc.channel && user.voice === rtc.channel) blip('leave');
    Object.assign(user, { online: false, voice: null, muted: false, deafened: false, sharing: false, camera: false, idle: false, activities: [] });
    refreshCardActivities(m.id);
    destroyPeer(m.id);
    refreshPeople();
    refreshDevices(m.id);
    syncStage();
  },

  // Someone this account can no longer see (only between a guest and someone else, when a friend request ends).
  'user-hidden'(m) {
    if (!state.users.has(m.id)) return;
    state.users.delete(m.id);
    state.dms.delete(m.id);
    if (state.view.type === 'dm' && state.view.id === m.id) openFriends();
    refreshPeople();
  },

  // This guest made an account: a password, so they can sign in anywhere. They stay a guest.
  'account-made'(m) {
    state.hasPassword = true;
    store.set('lastUser', m.name);
    store.set('lastGuest', false);
    if ($('#claimDlg').open) $('#claimDlg').close();
    toast(`Your account is made. Sign in as ${m.name} with your password on any device.`);
    renderGuestNote();
  },

  // This account was deleted (by its owner, or by m.by): signed out here and everywhere.
  'account-deleted'(m) {
    stopped = true;
    teardownVoice();
    endCallUi();
    session.clear();
    store.set('lastUser', '');
    store.set('lastGuest', false);
    $('#loginName').value = '';
    showLogin(m.by ? `Your account was deleted by ${m.by}.` : 'Your account is deleted.');
  },

  // The nicknames this account gave its friends changed (here or on another of its devices).
  nicknames(m) {
    state.nicknames = new Map(Object.entries(m.nicknames || {}));
    refreshPeople();
    if (isConv()) redrawMessages();
    if ($('#nickDlg').open) $('#nickDlg').close();
  },

  // The invite codes, for admins (made: the code just made here, copied for them).
  invites(m) {
    state.invites = Array.isArray(m.invites) ? m.invites : [];
    renderInvites();
    if (m.made) copyInvite(m.made, true);
  },

  // An admin let this guest into the server. The server hangs up; the page connects again at once and comes back
  // with the whole server.
  admitted() {
    inviteInfo.clear();
    toast('You have been let into the server. Welcome!');
  },

  // An admin removed this account from the server (m.by). The server hangs up; the page comes straight back outside
  // it, in direct messages, with a box for a new invite code.
  kicked(m) {
    if (m.banned) toast(m.by ? `${m.by} banned you from the server.` : 'You were banned from the server.', 8000);
    else toast(m.by ? `${m.by} removed you from the server.` : 'You were removed from the server.');
  },

  // Someone this admin removed (or banned) from the server.
  removed(m) {
    toast(m.banned ? `${m.name} was banned from the server.` : `${m.name} was removed from the server.`);
  },

  // Options for adding a passkey (Settings, see askPasskeyMake), and this account's passkeys.
  'passkey-options'(m) {
    passkeyMake = m.error ? null : m.options || null;
  },
  'channel-notify'(m) {
    state.channelNotify = m.channelNotify || {};
  },

  'passkey-link'(m) {
    passkeyLinkToken = m.error ? null : m.token || null;
  },
  passkeys(m) {
    state.passkeys = Array.isArray(m.passkeys) ? m.passkeys : [];
    renderPasskeys();
    if (m.added) toast('Passkey added. You can sign in with it now.');
  },

  // What an invite link in a message shows (its card; see inviteCard).
  'invite-info'(m) {
    inviteInfo.set(m.code, m);
    for (const card of $$(`[data-invite-card="${CSS.escape(m.code)}"]`)) fillInviteCard(card);
  },

  // Who this account blocked (see blockPerson): here or on another of its devices.
  blocked(m) {
    const before = state.blocked || new Set();
    state.blocked = new Set(Array.isArray(m.blocked) ? m.blocked : []);
    const name = (id) => nick(state.users.get(id) || { name: 'them' });
    for (const id of state.blocked) if (!before.has(id)) toast(`You blocked ${name(id)}.`);
    for (const id of before) if (!state.blocked.has(id)) toast(`You unblocked ${name(id)}.`);
    renderSidebar();
    renderMembers();
    const box = $('#messages');
    const y = box.scrollTop;
    renderMain();   // their messages fold or open, and a direct message with them can or can't be written in
    if (isConv()) { if (chat.stuck) toBottom(box); else box.scrollTop = y; }
  },

  reported(m) {
    if ($('#reportDlg').open) $('#reportDlg').close();
    toast(m.again ? "You've already reported that. The server's admins will take a look." : "Thanks for reporting. The server's admins will take a look.", 6000);
  },

  // Open reports, for admins and Staff (the flag by the server's name). new: one that just came in.
  reports(m) {
    const first = !state.reportsHeard;
    state.reportsHeard = true;
    state.reports = Array.isArray(m.reports) ? m.reports : [];
    renderReports();
    const fresh = m.new && state.reports.find((r) => r.id === m.new);
    if (fresh) toast(`New report: ${fresh.byName} reported ${fresh.userName} (${reasonLabel(fresh.reason)}). See Reports, the flag by the server's name.`, 8000);
    else if (first && state.reports.length) toast(`${state.reports.length === 1 ? 'There is 1 open report' : `There are ${state.reports.length} open reports`}: see the flag by the server's name.`, 6000);
  },

  // Who is banned, for admins (Server settings > Bans, and Unban in their menu).
  bans(m) {
    state.bans = Array.isArray(m.bans) ? m.bans : [];
    renderBans();
  },

  unbanned(m) {
    toast(`${m.name} is unbanned. An invite code lets them back in now.`);
  },

  'user-update'(m) {
    takeUser(m.user);
    const user = state.users.get(m.user.id);
    if (user && user.guest && m.user.guest === false && state.canManage) toast(`${nick(m.user)} is in the server now.`);
    if (user && !user.deleted && m.user.deleted) toast(`${nick(user)}'s account was deleted.`);
    // Only what they are playing changed (a new song every few minutes): just the lists and an open card.
    if (user && Object.keys(m.user).every((k) => k === 'activities' || JSON.stringify(user[k]) === JSON.stringify(m.user[k]))) {
      user.activities = m.user.activities;
      if (user.voice) renderSidebar();
      renderMembers();
      if (state.view.type === 'friends') renderFriends();
      refreshCardActivities(user.id);
      return;
    }
    // Any change of status starts a new do-not-disturb spell, which hands back the one ping.
    if (user && user.status !== m.user.status) state.pinged.delete(m.user.id);
    const locks = (u) => `${!!(u && u.serverMuted)},${!!(u && u.serverDeafened)}`;
    const lockedBefore = locks(user);
    if (user) Object.assign(user, m.user); else state.users.set(m.user.id, m.user);
    if (locks(m.user) !== lockedBefore) {
      if (m.user.id === state.me.id) {
        toast(m.user.serverDeafened ? 'An admin deafened you on this server.' : m.user.serverMuted ? 'An admin muted you on this server.'
          : 'An admin let you talk and listen again.');
        applyMic();
        sendFlags();
        updateControls();
      }
      applyDeafen();
    }
    if (m.user.id === state.me.id) {
      if (state.info.autoLogin === state.me.name) state.info.autoLogin = m.user.name;
      if (state.me.name !== m.user.name) queueMicrotask(renderGuestNote);   // it shows the username to give friends
      state.me.name = m.user.name;
      store.set('lastUser', m.user.name);
      renderMe();
    }
    refreshPeople();
    refreshCardActivities(m.user.id);
    if (isConv()) { const box = $('#messages'); const y = box.scrollTop; renderMessages(); if (chat.stuck) toBottom(box); else box.scrollTop = y; }
    rebuildStage();
    refreshResults();
  },

  'voice-update'(m) {
    const user = state.users.get(m.id);
    if (!user) return;
    const before = { ...user };
    Object.assign(user, { voice: m.voice, muted: m.muted, deafened: m.deafened, sharing: m.sharing, camera: !!m.camera });
    if (m.id === state.me.id) {
      // The server moved us out: the channel was deleted or the other person hung up.
      if (rtc.channel && user.voice !== rtc.channel) {
        teardownVoice();
        if (state.view.type === 'voice') leaveStage();
      }
    } else if (rtc.channel) {
      const wasHere = before.voice === rtc.channel;
      const isHere = user.voice === rtc.channel;
      // "moving": the same person switching devices in this room, which should not sound like leaving.
      if (wasHere && !isHere) { destroyPeer(m.id); if (!m.moving) blip('leave'); }
      if (!wasHere && isHere && !m.moving) blip('join');
      if (wasHere && isHere && !before.sharing && user.sharing) blip('share-start');
      if (wasHere && isHere && before.sharing && !user.sharing) blip('share-end');
      if (isHere && before.sharing && !user.sharing) {
        const peer = rtc.peers.get(m.id);
        if (peer) { peer.watching = false; peer.screenStream = null; }
      }
      if (isHere && before.camera && !user.camera) {
        const peer = rtc.peers.get(m.id);
        if (peer) peer.cameraStream = null;
      }
    }
    refreshPeople(); syncStage(); updateControls();
  },

  // Voice was taken over by another of this account's devices (the phone, another window).
  'voice-moved'() {
    if (!rtc.channel) return;
    teardownVoice();
    if (state.view.type === 'voice') leaveStage();
    toast('You are now in voice on your other device.');
    renderSidebar(); syncStage(); updateControls();
  },

  // This device took over a call that was going on on another one: it needs to know which call it is.
  'call-joined'(m) {
    stopRing();
    state.call = { id: m.call, with: m.with, incoming: false, room: m.room };
    renderCallBar(); updateControls();
  },

  'voice-joined'(m) {
    if (m.channel !== rtc.channel) return;
    for (const id of m.peers) if (!rtc.peers.has(id)) createPeer(id, true);
    blip('join');
    syncStage();
  },

  signal(m) {
    const user = state.users.get(m.from);
    if (!rtc.channel || !user || user.voice !== rtc.channel || !m.data) return;
    const peer = rtc.peers.get(m.from) || createPeer(m.from, false);
    peer.queue = peer.queue.then(() => onSignal(peer, m.data)).catch((err) => console.warn('signal', err));
  },

  channels(m) {
    state.channels = m.channels;
    for (const id of [...state.cache.keys()]) if (!id.startsWith('dm:') && !channelById(id)) state.cache.delete(id);
    for (const id of [...state.unread.keys()]) if (!channelById(id)) state.unread.delete(id);
    for (const id of [...state.mentions.keys()]) if (!channelById(id)) state.mentions.delete(id);
    const v = state.view;
    const gone = (v.type === 'text' && !channelById(v.id))
      || (v.type === 'voice' && !channelById(v.id) && !(state.call && state.call.room === v.id));
    if (gone) openText(lastText());
    else {
      // A rename shows up everywhere the name is written: the list, the header, the message box and the voice panel.
      renderSidebar(); renderHead(); updateControls();
      if (v.type === 'text') $('#input').placeholder = `Message #${channelById(v.id).name}`;
    }
  },

  friends(m) {
    const before = state.friends;
    state.friends = { friends: m.friends, incoming: m.incoming, outgoing: m.outgoing };
    for (const id of m.incoming) {
      const user = state.users.get(id);
      if (user && !before.incoming.includes(id)) { toast(`${nick(user)} sent you a friend request.`); if (!isDnd(self())) blip('message'); }
    }
    for (const id of m.friends) {
      const user = state.users.get(id);
      if (user && before.outgoing.includes(id)) toast(`${nick(user)} accepted your friend request.`);
    }
    for (const id of m.outgoing) {
      const user = state.users.get(id);
      if (user && !before.outgoing.includes(id)) toast(`Friend request sent to ${nick(user)}.`);
    }
    renderSidebar();
    if (state.view.type === 'friends') renderFriends();
  },

  chat(m) {
    const msg = m.message;
    const viewing = receive(msg.channel, msg);
    const mention = msg.uid !== state.me.id && !isBlocked(msg.uid) && mentionsMe(msg.text);
    if (mention && (!viewing || outOfSight()) && !isDnd(self())) blip('message');
    if (typeof msg.join === 'number' || isBlocked(msg.uid)) { /* someone joined, or someone you blocked: never unread */ }
    else if (!viewing) {
      state.unread.set(msg.channel, (state.unread.get(msg.channel) || 0) + 1);
      if (mention) state.mentions.set(msg.channel, (state.mentions.get(msg.channel) || 0) + 1);
      renderSidebar();
    } else if (outOfSight()) hiddenUnread++;
    updateTitle();
    notifyMessage(msg, { kind: 'text', id: msg.channel });
  },

  dm(m) {
    const msg = m.message;
    const peer = msg.uid === state.me.id ? msg.to : msg.uid;
    const viewing = receive('dm:' + peer, msg);
    const entry = state.dms.get(peer) || { last: 0, unread: 0 };
    entry.last = msg.ts;
    state.dms.set(peer, entry);
    if (msg.uid === peer) {
      if (viewing && !outOfSight()) markDmRead(peer);
      else { entry.unread++; if (!isDnd(self())) blip('message'); }   // do-not-disturb still counts unread, silently
      notifyMessage(msg, { kind: 'dm', id: peer });
    }
    renderSidebar();
    updateTitle();
  },

  // This account closed a direct message (here or on another device), or opened a closed one again.
  'dm-closed'(m) {
    if (m.closed) {
      if (!state.dms.has(m.id)) return;
      state.dms.delete(m.id);
      if (state.view.type === 'dm' && state.view.id === m.id) openFriends(); else renderSidebar();
    } else if (!state.dms.has(m.id) && state.users.has(m.id)) {
      state.dms.set(m.id, { last: Date.now(), unread: 0 });
      renderSidebar();
    }
    updateTitle();
  },

  // Calls that rang while this account wasn't on anywhere, and nobody answered.
  'missed-calls'(m) {
    const calls = Array.isArray(m.calls) ? m.calls : [];
    const by = new Map();
    for (const c of calls) by.set(c.from, [...(by.get(c.from) || []), c.at]);
    const time = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    for (const [from, times] of by) {
      const user = state.users.get(from);
      const who = user ? nick(user) : 'Someone';
      toast(times.length > 1 ? `You missed ${times.length} calls from ${who} (last ${time(times[times.length - 1])}).`
        : `You missed a call from ${who} (${time(times[0])}).`, 10000);
    }
  },

  // Someone used their one ping to reach us while we are on do-not-disturb.
  ping(m) {
    const user = state.users.get(m.from);
    if (!user) return;
    const entry = state.dms.get(m.from) || { last: Date.now(), unread: 0 };
    const viewing = state.view.type === 'dm' && state.view.id === m.from && !outOfSight();
    entry.ping = !viewing;
    state.dms.set(m.from, entry);
    toast(`${nick(user)} pinged you. They can only do that once while you are on Do Not Disturb.`, 9000);
    tones([988, 1319, 988, 1319], 0.11, 0.08);
    renderSidebar();
    updateTitle();
  },

  'ping-sent'(m) {
    state.pinged.add(m.to);
    renderDndNote();
  },

  // The server returned our timestamp: the round trip is the ping.
  echo(m) {
    if (!rtc.channel || typeof m.t !== 'number') return;
    pingMs = Math.max(1, Math.round(performance.now() - m.t));
    renderPing();
  },

  'message-pinned'(m) {
    const key = m.dm ? 'dm:' + m.dm : m.channel;
    const cache = state.cache.get(key);
    const msg = cache && cache.list.find((x) => x.id === m.id);
    if (msg) { if (m.pinned) msg.pinned = true; else delete msg.pinned; }
    const viewing = isConv() && convKey() === key;
    if (viewing) redrawMessages();
    if (pinsOpen() && pinsKey === key) requestPins();
    const by = state.users.get(m.by);
    if (viewing && by && m.by !== state.me.id) toast(`${by.name} ${m.pinned ? 'pinned' : 'unpinned'} a message.`);
  },

  pins(m) {
    if ((m.dm ? 'dm:' + m.dm : m.channel) === pinsKey) renderPins(m.messages);
  },

  emojis(m) {
    state.emojis = new Map(m.emojis.map((e) => [e.name, e.url]));
    if (isConv()) redrawMessages();
    if (popoverKind === 'emoji') drawEmojiPicker();
  },

  favorites(m) {
    state.favorites = m.favorites;
    for (const button of $$('[data-fav]')) markFavorite(button);
    if (popoverKind === 'favorites') drawFavorites();
  },

  'message-deleted'(m) {
    const key = m.dm ? 'dm:' + m.dm : m.channel;
    const cache = state.cache.get(key);
    if (cache) cache.list = cache.list.filter((x) => x.id !== m.id);
    if (state.replyTo && state.replyTo.id === m.id) { state.replyTo = null; renderReplyBar(); }
    if (isConv() && convKey() === key) redrawMessages();
    if (pinsOpen() && pinsKey === key) requestPins();
    // A deleted direct message may have been one we had not read yet.
    const entry = m.dm ? state.dms.get(m.dm) : null;
    if (entry && typeof m.unread === 'number' && entry.unread !== m.unread) {
      entry.unread = m.unread;
      renderSidebar();
      updateTitle();
    }
  },

  history(m) { onHistory(m.channel, m); },

  // An admin changed the server's name, picture or banner.
  server(m) { showServerLook(m); },

  // A new version of the desktop app was just published: the app fetches it now (version 1.4.3 on).
  'app-update'() { if (appShell && appShell.checkUpdates) appShell.checkUpdates(); },

  'search-results'(m) { if (m.seq === search.seq) renderResults(m); },

  // A link preview the server looked up (null when the link has none).
  embed(m) {
    const entry = previews.get(m.url);
    if (!entry) return;
    if (m.retry) {   // the server is busy with this device's other links: ask again in a little while
      entry.asked = false;
      setTimeout(() => { if (!entry.done && !entry.asked) entry.asked = send({ type: 'embed', url: m.url }); }, 15000 + Math.random() * 15000);
      return;
    }
    Object.assign(entry, { done: true, data: m.embed || null });
    for (const slot of entry.slots) if (slot.isConnected) fillPreview(slot, entry.data);
    entry.slots.clear();
  },

  'dm-history'(m) {
    onHistory('dm:' + m.with, m);
    if (state.view.type === 'dm' && state.view.id === m.with && !outOfSight()) markDmRead(m.with);
  },

  typing(m) {
    if (isBlocked(m.id)) return;
    setTyping(m.dm ? 'dm:' + m.dm : m.channel, nick(userNamed(m.name) || { name: m.name }), !m.stop);
  },

  'message-edited'(m) {
    const key = m.dm ? 'dm:' + m.dm : m.channel;
    const cache = state.cache.get(key);
    for (const x of cache ? cache.list : []) {
      if (x.id === m.id) { x.text = m.text; x.edited = m.edited; }
      if (x.reply && x.reply.id === m.id) x.reply.text = m.quote;
    }
    if (isConv() && convKey() === key) redrawMessages();
    if (pinsOpen() && pinsKey === key) requestPins();
  },

  'call-ringing'(m) {
    state.call = { id: m.call, with: m.with, incoming: false, room: null };
    renderCallBar();
    if (!m.elsewhere) ring(false);   // placed from another of your devices: shown, but only that one rings
  },

  'call-incoming'(m) {
    state.call = { id: m.call, with: m.with, incoming: true, room: null };
    renderCallBar();
    if (!isDnd(self())) ring(true);   // on do-not-disturb the call still shows, without the ringing
    updateTitle();
    const caller = state.users.get(m.with);
    notify({ title: 'Incoming call', body: `${caller ? nick(caller) : 'Someone'} is calling you`, icon: avatarIcon(caller),
      tag: 'call', open: { kind: 'dm', id: m.with } });
  },

  'call-start'(m) {
    if (!state.call || state.call.id !== m.call) return;
    stopRing();
    state.call.room = m.room;
    renderCallBar();
    showVoice(m.room);
  },

  'call-ended'(m) {
    const call = state.call;
    const other = state.users.get(m.with || (call && call.with));
    const who = other ? nick(other) : 'They';
    if (call && call.id === m.call) endCallUi();
    if (m.by === state.me.id) return;
    const text = {
      offline: 'They are offline right now.',
      'not-friends': `You can only call friends. Add ${who} first.`,
      busy: `${who} is already in a call.`,
      declined: `${who} declined the call.`,
      cancelled: `You missed a call from ${who}.`,
      missed: call && call.incoming ? `You missed a call from ${who}.` : `${who} did not answer.`,
      left: `${who} went offline.`,
      ended: `The call with ${who} ended.`,
    }[m.reason];
    if (text) toast(text);
  },
};

// Adds an incoming message to its conversation. Returns true when that conversation is on screen.
function receive(key, msg) {
  const cache = state.cache.get(key);
  const viewing = isConv() && convKey() === key;
  setTyping(key, nick(authorOf(msg)), false);
  // Until history arrives nothing is drawn; the history reply will include this message.
  if (cache && cache.loaded) {
    cache.list.push(msg);
    if (viewing) {
      const box = $('#messages');
      const stick = chat.stuck || nearBottom(box) || msg.uid === state.me.id;
      appendMessage(box, msg, cache.list[cache.list.length - 2]);
      if (stick) toBottom(box);
    }
  }
  return viewing;
}

function onHistory(key, m) {
  const cache = cacheFor(key);
  cache.loading = false;
  cache.loaded = true;
  cache.more = m.more;
  cache.list = m.older ? m.messages.concat(cache.list) : m.messages;
  if (!isConv() || convKey() !== key) return;
  const box = $('#messages');
  const fromBottom = box.scrollHeight - box.scrollTop;
  renderMessages();
  if (m.older) box.scrollTop = box.scrollHeight - fromBottom; else toBottom(box);
}

function markDmRead(peer) {
  const entry = state.dms.get(peer);
  const cache = state.cache.get('dm:' + peer);
  if (!entry || !cache || !cache.loaded) return;
  let last = 0;
  for (const m of cache.list) if (m.uid === peer) last = m.id;
  if (last && last !== entry.readId) send({ type: 'dm-read', with: peer, id: last });
  entry.readId = last;
  if (entry.unread) { entry.unread = 0; renderSidebar(); updateTitle(); }
}

/* ---------- sign in ---------- */

let authMode = 'login';

/* ---------- passkeys ---------- */

function fromB64url(text) {
  const plain = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(plain + '='.repeat((4 - (plain.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0)).buffer;
}
function toB64url(buffer) {
  let bin = '';
  for (const byte of new Uint8Array(buffer)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// Where passkeys work: the server says so for this address (never an IP address), and the browser has them. Not in
// the Mac desktop app: macOS lets only apps Apple has signed use passkeys (Safari has them).
const passkeysCan = () => !!window.PublicKeyCredential && !(appShell && appShell.platform === 'darwin');
const passkeysHere = () => passkeysCan() && !!(state.info && state.info.passkeys);
// Whether this device has its own passkey maker (Windows Hello, Touch ID...). The desktop app without one (the Mac
// app, a PC without Windows Hello) adds passkeys in the web browser instead (passkeyByBrowser).
let platformPasskeys = false;
if (window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then((yes) => { platformPasskeys = !!yes; }).catch(() => {});
}
const passkeyByBrowser = () => !!appShell && !!state.passkeyLink && !(passkeysCan() && platformPasskeys && state.passkeyDomain);

// Signing in with a passkey. The challenge is fetched as the sign-in screen shows, so the passkey prompt follows a
// click at once (Safari wants that); where the browser can, the passkeys also wait in the username box's
// suggestions (conditional mediation), with the same challenge.
let passkeyAsk = null;   // the server's challenge: { challenge, rpId, timeout, userVerification }
let passkeyWait = null;  // the AbortController of the request waiting in the username box
async function fetchPasskeyAsk() {
  passkeyAsk = null;
  if (!passkeysHere()) return null;
  try {
    const res = await fetch('/api/passkey/options', { cache: 'no-store' });
    passkeyAsk = res.ok ? await res.json() : null;
  } catch { passkeyAsk = null; }
  return passkeyAsk;
}
const passkeyRequest = (ask) => ({ challenge: fromB64url(ask.challenge), rpId: ask.rpId, timeout: ask.timeout,
  userVerification: ask.userVerification || 'preferred', allowCredentials: [] });
function stopPasskeyWait() {
  if (passkeyWait) { passkeyWait.abort(); passkeyWait = null; }
}
function signInWithPasskey(cred) {
  passkeyAsk = null;   // its challenge is used now
  const r = cred.response;
  pendingAuth = { mode: 'passkey', credential: { id: cred.id, type: cred.type, response: {
    clientDataJSON: toB64url(r.clientDataJSON), authenticatorData: toB64url(r.authenticatorData), signature: toB64url(r.signature),
    userHandle: r.userHandle ? toB64url(r.userHandle) : null } } };
  keepChoice = $('#loginKeep').checked;
  $('#loginError').hidden = true;
  connect();
}
async function preparePasskeys() {
  stopPasskeyWait();
  $('#loginPasskey').hidden = !passkeysHere();
  const ask = await fetchPasskeyAsk();
  if (!ask || $('#login').hidden) return;
  let conditional = false;
  try { conditional = !!(PublicKeyCredential.isConditionalMediationAvailable && await PublicKeyCredential.isConditionalMediationAvailable()); } catch { /* no */ }
  if (!conditional || passkeyWait) return;
  const wait = passkeyWait = new AbortController();
  try {
    const cred = await navigator.credentials.get({ mediation: 'conditional', publicKey: passkeyRequest(ask), signal: wait.signal });
    if (passkeyWait === wait) passkeyWait = null;
    if (cred) signInWithPasskey(cred);
  } catch {
    if (passkeyWait === wait) passkeyWait = null;
  }
}
$('#loginPasskey').addEventListener('click', async () => {
  stopPasskeyWait();
  const ask = passkeyAsk || await fetchPasskeyAsk();
  const problem = (text) => { $('#loginError').hidden = false; $('#loginError').textContent = text; };
  if (!ask) { problem("Passkeys don't work at this address."); return; }
  try {
    const cred = await navigator.credentials.get({ publicKey: passkeyRequest(ask) });
    if (cred) { signInWithPasskey(cred); return; }
  } catch (err) {
    if (err && err.name !== 'NotAllowedError' && err.name !== 'AbortError') problem(`The passkey didn't work: ${err.message || err.name}`);
  }
  preparePasskeys();   // a fresh challenge for the next try
});

// Settings: this account's passkeys, Add a passkey (with options asked for as Settings opens, for the same reason as
// above), and remove.
let passkeyMake = null;
let passkeyLinkToken = null;   // a one-time link to add a passkey in the web browser (passkeyByBrowser)
function askPasskeyMake() {
  passkeyMake = null;
  passkeyLinkToken = null;
  if (passkeyByBrowser()) send({ type: 'passkey-link' });
  else if (passkeysCan() && state.passkeyDomain) send({ type: 'passkey-begin' });
}
function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'This device';
  const where = window.umbryxApp ? 'Umbryx app' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${os} · ${where}`;
}
function renderPasskeys() {
  const box = $('#setPasskeys');
  box.hidden = !((passkeysCan() && state.passkeyDomain) || passkeyByBrowser());
  if (box.hidden) return;
  $('#passkeyBrowserNote').hidden = !passkeyByBrowser();
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'never');
  const list = state.passkeys || [];
  $('#passkeyList').replaceChildren(...(list.length ? list.map((p) => h('div', { class: 'invite-row passkey-row' },
    icon('key'),
    h('span', { class: 'passkey-text' }, h('b', { class: 'ban-name', text: p.name }),
      h('span', { class: 'invite-meta', text: `Added ${day(p.created)} · last used ${day(p.used)}` })),
    h('button', { class: 'ctl sm', type: 'button', title: 'Remove this passkey', onclick: () => {
      if (confirm(`Remove the passkey "${p.name}"? It won't sign you in any more. Remove it from the device's passwords too.`)) send({ type: 'passkey-remove', id: p.id });
    } }, icon('x'))))
    : [h('div', { class: 'chan-empty', text: 'No passkeys yet.' })]));
}
$('#passkeyAdd').addEventListener('click', async () => {
  if (passkeyByBrowser()) {
    const token = passkeyLinkToken;
    if (!token) { toast('One moment, then try again.'); askPasskeyMake(); return; }
    window.open(`${(state.appAddress || location.origin).replace(/\/+$/, '')}/#passkey-add=${token}`);   // the desktop app opens it in the browser
    toast('Finish in your web browser. Your new passkey shows up here once it\'s made.', 8000);
    askPasskeyMake();
    return;
  }
  const options = passkeyMake;
  if (!options) { toast('One moment, then try again.'); askPasskeyMake(); return; }
  passkeyMake = null;
  const publicKey = { ...options, challenge: fromB64url(options.challenge), user: { ...options.user, id: fromB64url(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: fromB64url(c.id) })) };
  try {
    const cred = await navigator.credentials.create({ publicKey });
    if (cred) {
      send({ type: 'passkey-finish', name: deviceName(), credential: { id: cred.id, type: cred.type, response: {
        clientDataJSON: toB64url(cred.response.clientDataJSON), attestationObject: toB64url(cred.response.attestationObject) } } });
    }
  } catch (err) {
    if (err && err.name === 'InvalidStateError') toast('This device has a passkey for your account already.');
    else if (err && err.name !== 'NotAllowedError' && err.name !== 'AbortError') toast(`The passkey wasn't added: ${err.message || err.name}`);
  }
  askPasskeyMake();
});

// Invite codes: what someone typed or pasted, as the bare code, whether the code itself or a link ending in it
// (app.example.com/K7QM2XPA).
const inviteCodeOf = (text) => String(text || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop()
  .toUpperCase().replace(/[^A-Z0-9]/g, '');
// An invite link (https://app.example.com/K7QM2XPA) opened this page: its code, until it is used. The address bar goes
// back to the plain address, so a reload does not offer it again.
let linkInvite = (() => {
  const hit = location.pathname.match(/^\/([A-Za-z0-9]{8})\/?$/);
  if (!hit) return '';
  try { history.replaceState(null, '', '/' + location.search + location.hash); } catch { /* fine as it is */ }
  return hit[1].toUpperCase();
})();
let linkShown = false;
// The link to an invite: at the server's address for apps if it has one (it serves the website too), else here.
const inviteLink = (code) => `${(state.appAddress || location.origin).replace(/\/+$/, '')}/${code}`;

function setAuthMode(mode) {
  authMode = mode;
  for (const tab of $$('.tab')) tab.classList.toggle('active', tab.dataset.mode === mode);
  $('#loginGo').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('#loginGateRow').hidden = !(mode === 'register' && state.info.passwordRequired);
  $('#loginInviteRow').hidden = !(mode === 'register' && state.info.inviteOnly);
  $('#loginPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
}

function showLogin(error) {
  $('#app').hidden = true;
  $('#callBar').hidden = true;
  closeCard();
  for (const dlg of $$('dialog[open]')) dlg.close();
  $('#login').hidden = false;
  $('#loginTitle').textContent = 'Umbryx';   // the sign-in page is public: the server's name is for those signed in
  setAuthMode(authMode);
  if (!$('#loginName').value) $('#loginName').value = store.get('lastUser', '');
  $('#loginPass').value = '';
  $('#loginError').hidden = !error;
  $('#loginError').textContent = error || '';
  // One click back in: either this device still remembers an account, or this is the server
  // computer and config.json names an account to sign in without a password.
  const remembered = session.kept() ? store.get('lastUser', '') : '';
  const quick = remembered || state.info.autoLogin;
  $('#loginKeep').checked = session.keep();
  $('#loginAuto').hidden = !quick;
  $('#loginAuto').textContent = 'Continue as ' + quick;
  $('#loginForget').hidden = !remembered;
  preparePasskeys();
  // Came from an invite link without being signed in: Create account, with the code in.
  if (linkInvite && !linkShown && state.info.inviteOnly) {
    linkShown = true;
    setAuthMode('register');
    $('#loginInvite').value = linkInvite;
  }
  // Nothing of the account stays on show: the title's unread counts, and in the desktop app the column's pictures of
  // who wrote (from 1.4.18 the app also hides the column when this is its only server).
  state.unread.clear();
  state.mentions.clear();
  hiddenUnread = 0;
  document.title = 'Umbryx';
  if (homeSplit) { homeTold = ''; railShell.home({ on: false, unread: [] }); }
  if (railShell && railShell.signedIn) railShell.signedIn(false);
  ($('#loginName').value ? $('#loginPass') : $('#loginName')).focus();
}

// On the server computer itself, the server can sign its owner in without a password (autoLogin in config.json).
function autoSignIn() {
  pendingAuth = { mode: 'auto' };
  connect();
}

$('#loginAuto').addEventListener('click', () => {
  $('#loginError').hidden = true;
  if (!session.kept()) { autoSignIn(); return; }
  pendingAuth = null;
  connect();
});

$('#loginForget').addEventListener('click', () => {
  if (store.get('lastGuest', false) && !confirm('This is a guest account, and this device is the only way into it. Forget it, and its friends and messages, for good?')) return;
  forgetToken(session.get());
  session.clear();
  showLogin();
});

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  renderMe();
  updateControls();
  const banner = $('#banner');
  if (window.isSecureContext) banner.hidden = true;
  else {
    banner.hidden = false;
    const port = state.info.httpsPort;
    const url = port ? `https://${location.hostname}:${port}` : null;
    banner.replaceChildren('Voice and screen share only work on the secure address. ',
      url ? h('a', { href: url, text: 'Open ' + url }) : 'HTTPS is not available on this server.');
  }
}

for (const tab of $$('.tab')) tab.addEventListener('click', () => { setAuthMode(tab.dataset.mode); $('#loginError').hidden = true; });

$('#loginForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#loginName').value.trim();
  if (!name) return;
  pendingAuth = { mode: authMode, name, password: $('#loginPass').value, serverPassword: $('#loginGate').value,
    ...(authMode === 'register' && inviteCodeOf($('#loginInvite').value) ? { invite: inviteCodeOf($('#loginInvite').value) } : {}) };
  if (pendingAuth.invite) linkInvite = '';   // used here
  keepChoice = $('#loginKeep').checked;
  $('#loginError').hidden = true;
  connect();
});

// The middle of the top strip: how many tokens building Umbryx has taken and what they would cost, as of the last
// update (public/build-cost.json, written by tools/build_cost.py).
fetch('/build-cost.json', { cache: 'no-store' }).then((r) => r.json()).then((c) => {
  if (!Number.isFinite(c.tokens) || !Number.isFinite(c.usd)) return;
  const usd = c.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // The live status beside it: the model that did the most recent work (every model's share on hover).
  const shares = Object.entries(c.models || {}).map(([name, n]) => `${name}: ${Number(n).toLocaleString('en-US')} tokens`);
  const counted = c.updated ? new Date(c.updated).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  $('#buildCost').replaceChildren(
    h('span', { text: `${c.tokens.toLocaleString('en-US')} tokens ($${usd} USD)` }),
    c.model ? h('span', { class: 'build-model', title: ['Built with', ...shares, counted ? `Counted ${counted}` : ''].filter(Boolean).join('\n') },
      h('i', { class: 'live-dot', 'aria-hidden': 'true' }), c.model + (c.fast ? ' · Fast' : '')) : null,
    c.plan ? h('span', { class: 'build-plan', text: '| ' + c.plan }) : null);   // the Claude plan the work runs on
  $('#buildCost').hidden = false;
}).catch(() => {});

// A passkey link (#passkey-add=token, from Settings in a desktop app that can't make passkeys itself): this page only
// makes one passkey for that account, then says to go back to the app. The options are fetched first so the
// passkey prompt follows the click at once (Safari wants that).
async function passkeyLinkPage(token) {
  history.replaceState(null, '', '/');
  $('#login').hidden = true;
  $('#app').hidden = true;
  const status = h('p', { class: 'login-sub', text: 'Getting ready…' });
  const go = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Add passkey');
  const title = h('h1', { class: 'passkey-link-title', text: 'Add a passkey' });
  const card = h('div', { class: 'login-card passkey-link-card' }, h('img', { src: '/icon.svg', alt: '', width: 56, height: 56 }), title, status, go);
  document.body.append(h('div', { class: 'login passkey-link-page' }, card));
  const post = async (step, data) => {
    const res = await fetch(`/api/passkey/link-${step}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...data }) });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(answer.error || 'Something went wrong.');
    return answer;
  };
  let options = null;
  const ready = async () => {
    options = (await post('options')).options;
    status.textContent = `For your Umbryx account, ${options.user.name}. Your device will ask for your face, fingerprint or PIN.`;
    go.disabled = false;
  };
  try {
    if (!window.PublicKeyCredential) throw new Error("This browser can't make passkeys. Try Safari, Chrome or Edge.");
    await ready();
  } catch (err) { status.textContent = err.message; return; }
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const cred = await navigator.credentials.create({ publicKey: { ...options, challenge: fromB64url(options.challenge),
        user: { ...options.user, id: fromB64url(options.user.id) },
        excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: fromB64url(c.id) })) } });
      await post('finish', { name: deviceName(),
        credential: { id: cred.id, type: cred.type, response: { clientDataJSON: toB64url(cred.response.clientDataJSON), attestationObject: toB64url(cred.response.attestationObject) } } });
      title.textContent = 'Passkey added';
      status.textContent = 'You can close this tab and go back to Umbryx. Next time, sign in with your face, fingerprint or PIN.';
      go.remove();
    } catch (err) {
      const cancelled = err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
      status.textContent = cancelled ? 'Cancelled. Click Add passkey to try again.' : err.name === 'InvalidStateError' ? 'This device already has a passkey for your account.' : err.message;
      try { if (!cancelled) return; await ready(); } catch (again) { status.textContent = again.message; }
    }
  });
}

async function boot() {
  const handoff = location.hash.match(/^#passkey-add=([A-Za-z0-9_-]{16,64})$/);
  if (handoff) { passkeyLinkPage(handoff[1]); return; }
  try {
    state.info = await (await fetch('/api/info')).json();
  } catch { /* the sign-in screen still works with defaults */ }
  document.title = 'Umbryx';   // the server's own name comes with the welcome, once signed in
  if (session.get()) connect();
  else if (state.info.autoLogin && session.keep()) autoSignIn();
  else showLogin();
}

/* ---------- sidebar ---------- */

function renderMe() {
  const me = self();
  $('#meAvatar').replaceChildren(presence(me, 'sm'));
  $('#meName').textContent = me.name;
  $('#meName').style.color = nameColor(me);
  $('#meNote').textContent = noteOf(me);
  $('#meNote').hidden = !noteOf(me);
}

function refreshPeople() {
  renderSidebar();
  renderMembers();
  renderHead();
  renderDndNote();
  if (state.view.type === 'friends') renderFriends();
}

// Shown above the message box when the person being messaged is on do-not-disturb.
function renderDndNote() {
  const other = state.view.type === 'dm' ? state.users.get(state.view.id) : null;
  const show = !!other && isDnd(other);
  $('#dndNote').hidden = !show;
  if (!show) return;
  const used = state.pinged.has(other.id);
  $('#dndText').textContent = used
    ? `${nick(other)} is on Do Not Disturb. You have used your one ping; your messages will be waiting for them.`
    : `${nick(other)} is on Do Not Disturb and will not be alerted to your messages.`;
  $('#dndPing').hidden = used;
}

$('#dndPing').addEventListener('click', () => {
  if (state.view.type === 'dm') send({ type: 'dm-ping', to: state.view.id });
});

const badge = (n) => h('span', { class: 'chan-badge', text: n > 99 ? '99+' : n });

function sectionHead(label, title, onAdd) {
  return h('div', { class: 'chan-head' }, h('span', { text: label }),
    onAdd ? h('button', { class: 'ctl sm', type: 'button', title, onclick: onAdd }, icon('plus')) : null);
}

function renderSidebar() {
  const root = $('#channels');
  const scroll = root.scrollTop;
  root.replaceChildren();
  const home = isHomeView();
  document.documentElement.classList.toggle('home-view', homeSplit && home);
  document.documentElement.classList.toggle('home-now', home);   // no member list on Friends or in direct messages
  document.documentElement.classList.toggle('friends-now', state.view.type === 'friends');   // What's new instead
  if (state.view.type === 'friends') showNews();
  if (!homeSplit || home || state.guest) renderHomeSide(root);
  if (!state.guest && (!homeSplit || !home)) {
    for (const [label, kind] of [['Text channels', 'text'], ['Voice channels', 'voice']]) {
      // Making, renaming and deleting channels is for the server's admins (the server holds to this too).
      root.append(sectionHead(label, `New ${kind} channel`, state.canManage ? () => openChannelDialog(kind) : null));
      for (const ch of state.channels.filter((c) => c.type === kind)) root.append(channelRow(ch));
    }
  }
  root.scrollTop = scroll;
  updateTitle();
  paintVoiceClocks();
  tellHome();
}

// Friends, and the direct messages under it.
function renderHomeSide(root) {
  const requests = state.friends.incoming.length;
  root.append(h('div', { class: 'chan' + (state.view.type === 'friends' ? ' active' : '') + (requests ? ' unread' : '') },
    h('button', { class: 'chan-main', type: 'button', onclick: openFriends },
      icon('users'), h('span', { class: 'chan-name', text: 'Friends' }), requests ? badge(requests) : null)));

  root.append(sectionHead('Direct messages', 'New message', openPicker));
  const dms = [...state.dms.entries()].filter(([id]) => state.users.has(id)).sort((a, b) => b[1].last - a[1].last);
  if (!dms.length) root.append(h('div', { class: 'chan-empty', text: 'No conversations yet.' }));
  for (const [id, entry] of dms) {
    const user = state.users.get(id);
    const active = state.view.type === 'dm' && state.view.id === id;
    const note = user ? noteOf(user) : '';
    const doing = user ? activityLine(user) : null;
    root.append(h('div', { class: 'chan dm-row' + (active ? ' active' : '') + (entry.unread ? ' unread' : '') + plated(user), dataset: { person: id } }, plateEl(user && user.plate, user && user.plateFit),
      h('button', { class: 'chan-main', type: 'button', onclick: () => openDM(id) },
        presence(user, 'sm'),
        h('span', { class: 'dm-text' }, h('span', { class: 'member-line' }, h('span', { class: 'chan-name', text: nick(user) }), devicesEl(user)),
          note ? h('span', { class: 'member-note', text: note, title: note }) : doing ? activityText(doing) : null),
        typingIn('dm:' + id) ? dots() : null,
        entry.unread ? badge(entry.unread) : entry.ping ? badge('!') : null),
      h('button', { class: 'ctl sm chan-del dm-close', type: 'button', title: 'Close DM', 'aria-label': `Close the conversation with ${nick(user)}`,
        onclick: (event) => { event.stopPropagation(); closeDM(id); } }, icon('x'))));
  }
}

// What's new, on the right of Friends: the last three updates from public/updates.json (newest first), each with
// what was added and what was fixed. Loaded the first time Friends is shown.
let newsLoading = null;
function showNews() {
  if (newsLoading) return;
  newsLoading = fetch('/updates.json', { cache: 'no-store' }).then((r) => r.json()).then((data) => {
    const day = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' });
    const part = (label, items, cls) => (Array.isArray(items) && items.length
      ? h('div', { class: 'news-part ' + cls }, h('h4', { text: label }), h('ul', {}, items.map((text) => h('li', { text }))))
      : null);
    $('#homeNews').replaceChildren(
      h('div', { class: 'news-head' }, h('h3', { text: "What's new" }), h('span', { text: 'The last three updates' })),
      ...(Array.isArray(data.updates) ? data.updates : []).slice(0, 3).map((u) => h('section', { class: 'news-card' },
        h('div', { class: 'news-when' }, h('b', { text: u.title || 'Update' }), u.date ? h('span', { text: day.format(new Date(u.date + 'T12:00:00')) }) : null),
        part('New', u.added, 'added'), part('Fixed', u.fixed, 'fixed'))));
  }).catch(() => { newsLoading = null; });
}

// Calls are for friends only: people who added each other (the server holds to this too).
const isFriend = (user) => !!user && !!state.friends && state.friends.friends.includes(user.id);
const isBlocked = (id) => !!id && !!state.blocked && state.blocked.has(id);   // someone this account blocked

// Between a guest and anyone else, messages are for friends only (the server holds to this too).
const reachable = (user) => !!user && !user.deleted && !isBlocked(user.id) && (!(user.guest || state.guest) || state.friends.friends.includes(user.id));

// What a guest sees at the top of the sidebar: who can see them, the name to give friends, and the way in. Without a
// password that is Make an account (this device is otherwise the only way back in); with one, an invite code.
function renderGuestNote() {
  const note = $('#guestNote');
  note.hidden = !state.guest;
  if (!state.guest) { note.replaceChildren(); return; }
  const code = h('input', { placeholder: 'Invite code or link', maxlength: 100, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Invite code or link' });
  const join = () => { if (inviteCodeOf(code.value)) send({ type: 'redeem', code: inviteCodeOf(code.value) }); };
  code.addEventListener('keydown', (event) => { if (event.key === 'Enter') join(); });
  note.replaceChildren(
    h('b', { text: state.hasPassword ? 'Not in the server yet' : 'You are a guest' }),
    h('span', {}, 'Only friends you add can see you or message you. Your username is ', h('b', { text: state.me.name }), ': give it to friends so they can add you.'),
    state.hasPassword
      ? (state.info.inviteOnly ? h('div', { class: 'guest-join' }, code, h('button', { class: 'btn slim primary', type: 'button', onclick: join }, 'Join')) : null)
      : h('button', { class: 'btn slim primary', type: 'button', onclick: openClaim }, 'Make an account'));
}

function openClaim(invite) {
  $('#claimName').value = /^guest-\d+$/.test(state.me.name) ? '' : state.me.name;
  $('#claimPass').value = '';
  $('#claimInvite').value = typeof invite === 'string' ? invite : '';
  $('#claimInviteRow').hidden = !state.info.inviteOnly;
  $('#claimError').hidden = true;
  $('#claimDlg').showModal();
  $('#claimName').focus();
}

$('#claimForm').addEventListener('submit', (event) => {
  if (!event.submitter || event.submitter.value !== 'claim') return;
  event.preventDefault();   // stays open until the server says it is done (account-made) or what is wrong
  $('#claimError').hidden = true;
  send({ type: 'claim', name: $('#claimName').value.trim(), password: $('#claimPass').value,
    ...(inviteCodeOf($('#claimInvite').value) ? { invite: inviteCodeOf($('#claimInvite').value) } : {}) });
});

// The app's Home button and server buttons: 'home' goes to Friends, 'server' back to the last channel.
if (homeSplit) {
  railShell.onHome((side) => {
    if (!state.me) return;
    if (side === 'home' && !isHomeView()) openFriends();
    else if (side === 'server' && isHomeView() && !state.guest) openText(lastText());
  });
}

function channelRow(ch) {
  const isText = ch.type === 'text';
  const unread = state.unread.get(ch.id) || 0;
  const classes = ['chan'];
  if (state.view.type !== 'dm' && state.view.id === ch.id) classes.push('active');
  if (unread) classes.push('unread');
  if (rtc.channel === ch.id) classes.push('connected');
  const row = h('div', { class: classes.join(' '), dataset: isText ? { channelMenu: ch.id } : {} },
    h('button', { class: 'chan-main', type: 'button', onclick: () => (isText ? openText(ch.id) : openVoice(ch.id)),
      title: isText ? '' : rtc.channel === ch.id ? 'Open the voice window' : 'Join voice' },
      icon(isText ? 'hash' : 'speaker'),
      h('span', { class: 'chan-name', text: ch.name }),
      isText && typingIn(ch.id) ? dots() : null,
      !isText && usersIn(ch.id).length ? h('span', { class: 'room-time', dataset: { room: ch.id } }) : null,
      state.mentions.get(ch.id) ? h('span', { class: 'chan-badge mention-badge', title: 'Mentions of you', text: '@' + state.mentions.get(ch.id) })
        : unread ? badge(unread) : null),
    state.canManage ? h('button', { class: 'ctl sm chan-del', type: 'button', title: 'Rename channel', onclick: () => openChannelDialog(ch.type, ch) }, icon('pencil')) : null,
    state.canManage ? h('button', { class: 'ctl sm chan-del', type: 'button', title: 'Delete channel', onclick: () => deleteChannel(ch) }, icon('x')) : null);
  if (isText) return row;
  const people = usersIn(ch.id);
  return h('div', {}, row, people.length ? h('div', { class: 'chan-members' }, people.map((u) => {
    const el = h('button', { class: 'vm' + (rtc.speaking.has(u.id) ? ' speaking' : '') + plated(u), type: 'button', dataset: { speak: u.id, person: u.id }, onclick: () => openCard(u, el) },
      plateEl(u.plate, u.plateFit), avatar(u, 'xs'),
      h('span', { class: 'vm-name', text: nick(u) }),
      gameMark(u),
      u.sharing ? h('span', { class: 'live-badge', text: 'LIVE' }) : null,
      u.camera ? icon('camera') : null,
      voiceMarks(u));
    return el;
  })) : null);
}

function renderMembers() {
  // The server's members: not guests, whom only their friends see, in Friends and direct messages.
  const all = [...state.users.values()].filter((u) => !u.guest && !u.deleted).sort((a, b) => a.name.localeCompare(b.name));
  const row = (u) => {
    const name = h('span', { class: 'member-name', text: nick(u) });
    name.style.color = nameColor(u);
    const note = noteOf(u);
    const doing = activityLine(u);
    const el = h('button', { class: 'member' + (u.online ? '' : ' offline') + plated(u), type: 'button', dataset: { person: u.id }, onclick: () => openCard(u, el) },
      plateEl(u.plate, u.plateFit), presence(u, 'sm'),
      h('span', { class: 'member-text' }, h('span', { class: 'member-line' }, name, devicesEl(u)),
        note ? h('span', { class: 'member-note', text: note, title: note }) : doing ? activityText(doing) : null),
      u.id === state.me.id ? h('span', { class: 'you', text: 'you' }) : null,
      u.voice ? icon(channelById(u.voice) ? 'speaker' : 'phone') : null);
    return el;
  };
  const online = all.filter((u) => u.online);
  const offline = all.filter((u) => !u.online);
  $('#members').replaceChildren(
    h('div', { class: 'members-head', text: `Online · ${online.length}` }), ...online.map(row),
    ...(offline.length ? [h('div', { class: 'members-head', text: `Offline · ${offline.length}` }), ...offline.map(row)] : []));
}

// One dialog for both making a channel and renaming an existing one.
function openChannelDialog(kind, existing) {
  const dlg = $('#channelDlg');
  dlg.dataset.kind = kind;
  dlg.dataset.rename = existing ? existing.id : '';
  $('#channelTitle').textContent = existing ? `Rename ${kind} channel` : `New ${kind} channel`;
  $('#channelName').value = existing ? existing.name : '';
  $('#channelForm button[value="create"]').textContent = existing ? 'Rename' : 'Create';
  dlg.showModal();
  $('#channelName').select();
}

$('#channelForm').addEventListener('submit', (event) => {
  if (event.submitter && event.submitter.value !== 'create') return;
  const name = $('#channelName').value.trim();
  const dlg = $('#channelDlg');
  if (!name) return;
  if (dlg.dataset.rename) send({ type: 'channel-rename', id: dlg.dataset.rename, name });
  else send({ type: 'channel-create', kind: dlg.dataset.kind, name });
});

function deleteChannel(ch) {
  const note = ch.type === 'text' ? ' Its messages are removed for everyone.' : '';
  if (confirm(`Delete the channel "${ch.name}"?${note}`)) send({ type: 'channel-delete', id: ch.id });
}

function openPicker() {
  const list = $('#pickList');
  const filter = $('#pickFilter');
  const draw = () => {
    const query = filter.value.trim().toLowerCase();
    const people = [...state.users.values()]
      .filter((u) => u.id !== state.me.id && reachable(u) && u.name.toLowerCase().includes(query))
      .sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
    list.replaceChildren(...(people.length ? people.map((u) =>
      h('button', { class: 'member' + (u.online ? '' : ' offline'), type: 'button', onclick: () => { $('#pickDlg').close(); openDM(u.id); } },
        presence(u, 'sm'), h('span', { class: 'member-name', text: nick(u) })))
      : [h('div', { class: 'chan-empty', text: state.guest ? 'Add friends in Friends first: you can message them once they say yes.' : 'Nobody else has an account here yet.' })]));
  };
  filter.value = '';
  filter.oninput = draw;
  draw();
  $('#pickDlg').showModal();
}

// Out of sight: the tab is hidden, or (in the desktop app, version 1.2 on) another server is on screen.
// New messages in the open conversation then count as unread until it is back.
const outOfSight = () => document.hidden || !!(appShell && appShell.isShown && !appShell.isShown());

let hiddenUnread = 0;
function updateTitle() {
  let total = hiddenUnread;
  for (const n of state.unread.values()) total += n;
  // In the desktop app with Home, unread direct messages show under Home (each person with their count),
  // so the server's own count, which its button shows, is its channels only. The site's column shows them the same
  // way, but its tab still counts everything.
  if (webRail) webRail.counts(total, !!(state.call && state.call.incoming && !state.call.room));
  if (!homeSplit || webRail) for (const entry of state.dms.values()) total += entry.unread;
  const ringing = state.call && state.call.incoming && !state.call.room ? 'Incoming call · ' : '';
  // A browser tab says Umbryx, never the server's name. The desktop app reads the server's name for its column from
  // this title, so there it stays.
  document.title = ringing + (total ? `(${total}) ` : '') + (appShell ? state.info.serverName || 'Umbryx' : 'Umbryx');
}
function backInSight() {
  if (outOfSight() || !state.me) return;
  hiddenUnread = 0;
  if (state.view.type === 'dm') markDmRead(state.view.id);
  updateTitle();
}
document.addEventListener('visibilitychange', backInSight);
if (appShell && appShell.onShown) appShell.onShown(backInSight);

/* ---------- main view ---------- */

// A quick fade when the middle of the window changes to another conversation, the voice window or friends.
function animateView() {
  const el = isConv() ? $('#messages') : state.view.type === 'voice' ? $('#stage') : $('#friendsView');
  el.classList.remove('view-in');
  void el.offsetWidth;   // lets the same animation start again
  el.classList.add('view-in');
}

function setView(view) {
  closePins();
  stopTyping();
  state.editing = null;
  state.view = view;
  queueMicrotask(animateView);   // after the caller has drawn the new view
  $('#app').classList.remove('drawer');
  closeCard();
}

function renderHead() {
  const v = state.view;
  // A voice channel or call: its name centred, with how many are in and for how long under it (see syncStage).
  $('.main-head').classList.toggle('voice-head', v.type === 'voice');
  delete $('#headIcon').dataset.person;
  delete $('#headTitle').dataset.person;
  const actions = $('#headActions');
  actions.replaceChildren();
  renderPing();
  if (v.type !== 'voice') $('#headSub').textContent = '';
  if (v.type === 'text') {
    $('#headIcon').replaceChildren(icon('hash'));
    $('#headTitle').textContent = (channelById(v.id) || {}).name || '';
    actions.append(h('button', { class: 'ctl', type: 'button', title: 'Pinned messages', onclick: openPins }, icon('pin')));
  } else if (v.type === 'dm') {
    const user = state.users.get(v.id);
    $('#headIcon').replaceChildren(presence(user, 'xs'));
    $('#headTitle').textContent = nick(user);
    $('#headIcon').dataset.person = $('#headTitle').dataset.person = v.id;   // right-click: the user menu
    $('#headSub').textContent = [statusOf(user), noteOf(user)].filter(Boolean).join(' · ');
    actions.append(h('button', { class: 'ctl', type: 'button', title: 'Pinned messages', onclick: openPins }, icon('pin')));
    if (isBlocked(v.id)) actions.append(h('button', { class: 'btn slim', type: 'button', onclick: () => unblockPerson(user) }, 'Unblock'));
    if (!callAboveShown() && reachable(user) && isFriend(user)) {
      actions.append(h('button', { class: 'btn slim', type: 'button', title: `Call ${nick(user)}`, onclick: () => startCall(user.id) }, icon('phone'), 'Call'));
    }
  } else if (v.type === 'voice') {
    $('#headIcon').replaceChildren(icon(channelById(v.id) ? 'speaker' : 'phone'));
    $('#headTitle').textContent = roomLabel(v.id);
  } else {
    $('#headIcon').replaceChildren(icon('users'));
    $('#headTitle').textContent = 'Friends';
  }
}

function renderMain() {
  const v = state.view;
  $('#textView').hidden = !isConv();
  $('#friendsView').hidden = v.type !== 'friends';
  placeCallPanel();
  renderHead();
  if (isConv()) {
    const name = v.type === 'dm' ? nick(state.users.get(v.id)) : '#' + ((channelById(v.id) || {}).name || '');
    const gone = v.type === 'dm' && !!(state.users.get(v.id) || {}).deleted;
    const blocked = v.type === 'dm' && isBlocked(v.id);
    $('#input').disabled = gone || blocked;
    $('#input').placeholder = gone ? 'This account was deleted' : blocked ? `You blocked ${name}. Unblock them to send messages.` : `Message ${name}`;
    renderMessages();
    renderTyping();
  } else if (v.type === 'voice') syncStage();
  else renderFriends();
  renderDndNote();
  renderReplyBar();
  closePopover();
  syncPip();
}

function showConversation(request) {
  renderSidebar(); renderMembers(); renderMain();
  const cache = cacheFor(convKey());
  if (!cache.loaded && !cache.loading) {
    cache.loading = true;
    send(request);
  }
  toBottom($('#messages'));
  focusComposer();
}

// The message box is ready to type in as soon as a channel or direct message opens, as in Discord (not on touch
// screens, where that would pop the keyboard up), and typing anywhere in a conversation goes into it (see below).
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
function focusComposer() {
  const box = $('#input');
  if (!finePointer.matches || !isConv() || box.disabled || document.querySelector('dialog[open]')) return;
  queueMicrotask(() => box.focus({ preventScroll: true }));
}

function openText(id) {
  if (!id) return;
  setView({ type: 'text', id });
  state.unread.delete(id);
  state.mentions.delete(id);
  store.set('lastText', id);
  showConversation({ type: 'history', channel: id });
}

function openDM(id) {
  if (!state.users.has(id) || id === state.me.id) return;
  setView({ type: 'dm', id });
  if (!state.dms.has(id)) {
    state.dms.set(id, { last: Date.now(), unread: 0 });
    send({ type: 'dm-close', id, closed: false });   // opened again: back on the list, here and on other devices
  }
  state.dms.get(id).ping = false;
  showConversation({ type: 'dm-history', with: id });
  markDmRead(id);
}

// The ✕ on a direct message's row: off the list (read) on all this account's devices, until either of them writes
// again or it is opened again. Nothing is deleted.
function closeDM(id) {
  state.dms.delete(id);
  send({ type: 'dm-close', id });
  if (state.view.type === 'dm' && state.view.id === id) openFriends(); else renderSidebar();
  updateTitle();
}

function openFriends() {
  setView({ type: 'friends', id: null });
  renderSidebar(); renderMain();
}

/* ---------- in voice on another device ---------- */

// The account is in a voice channel or call on another of its devices (the phone, another window).
function elsewhereRoom() {
  const me = state.me && self();
  return me && me.voice && !rtc.channel && !rtc.joining ? me.voice : null;
}

function elsewhereWith(room) {
  return [...state.users.values()].find((u) => u.voice === room && u.id !== state.me.id) || null;
}

// A green strip across the top of the sidebar says so; a click moves voice here, and the other device
// lets go of it at the same moment.
function renderElsewhere() {
  const bar = $('#elsewhere');
  const room = elsewhereRoom();
  bar.hidden = !room;
  if (!room) { bar.replaceChildren(); return; }
  const ch = channelById(room);
  const other = elsewhereWith(room);
  const what = ch ? `Connected to ${ch.name}` : `In a call${other ? ' with ' + nick(other) : ''}`;
  bar.title = 'Switch to this device';
  bar.replaceChildren(h('span', { class: 'vp-dot' }),
    h('span', { class: 'elsewhere-text' }, h('b', { text: `${what} on another device` }), h('small', { text: 'Click to switch to this device' })),
    h('span', { class: 'elsewhere-go', text: 'Switch' }));
}

function takeOverVoice() {
  const room = elsewhereRoom();
  if (!room) return;
  if (!channelById(room) && !(state.call && state.call.room === room)) {
    const other = elsewhereWith(room);
    state.call = { id: null, with: other ? other.id : null, incoming: false, room };   // the server fills in the call's id
  }
  showVoice(room);
}

$('#elsewhere').addEventListener('click', takeOverVoice);

// Clicking a voice channel joins it and leaves you in the conversation you were reading.
// Clicking the channel you are already in opens its window.
function openVoice(id) {
  if (rtc.channel !== id && state.view.type !== 'voice') joinVoice(id);
  else showVoice(id);
}

function showVoice(id) {
  const other = callAboveFor(id);
  if (other) {
    if (rtc.channel !== id) joinVoice(id);
    openDM(other);
    return;
  }
  setView({ type: 'voice', id });
  renderSidebar(); renderMain();
  if (rtc.channel !== id) joinVoice(id);
}

/* ---------- desktop app: a call above its conversation ---------- */

// In the desktop app a call sits across the top of the conversation with that person, as in Discord: the
// pictures (or cameras and screen shares) and the call's buttons above, the messages below. The browser
// keeps a call in a window of its own.
function callAboveFor(room) {
  if (!DESKTOP_APP || !room || channelById(room) || !state.call || state.call.room !== room) return null;
  return state.users.has(state.call.with) ? state.call.with : null;
}

const callAboveShown = () => !!rtc.channel && state.view.type === 'dm' && state.view.id === callAboveFor(rtc.channel);

let callAbove = false;

function placeCallPanel() {
  const above = callAboveShown();
  $('#voiceView').hidden = state.view.type !== 'voice' && !above;
  renderCallTimer();
  if (above === callAbove) return;
  callAbove = above;
  $('.main').classList.toggle('call-above', above);
  if (!above) { $('.main').classList.remove('call-sized'); $('.main').style.removeProperty('--call-h'); }
  renderHead();
}

// How long the call has gone on, under the pictures. It counts from when the call started, as the server
// saw it, so both people see the same time and it carries on after switching devices.
let callTimerTick = 0;

// "02:15", or "1:02:15" past an hour, since the time given.
function clockSince(since) {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Every other timer on screen: next to the voice channels people are in, and in the voice window's header.
function paintVoiceClocks() {
  for (const el of $$('.room-time')) {
    const since = state.voiceStarted.get(el.dataset.room);
    el.textContent = since ? clockSince(since) : '';
  }
}
setInterval(paintVoiceClocks, 1000);

function renderCallTimer() {
  const el = $('#callTimer');
  const show = callAboveShown() && !!rtc.joinedAt;
  el.hidden = !show;
  if (!show) {
    clearInterval(callTimerTick);
    callTimerTick = 0;
    return;
  }
  el.textContent = clockSince(state.voiceStarted.get(rtc.channel) || rtc.joinedAt);
  if (!callTimerTick) callTimerTick = setInterval(renderCallTimer, 1000);
}

// The line under the call can be dragged to make the call taller or shorter, for as long as it lasts.
{
  const grip = $('#callGrip');
  let drag = null;
  grip.addEventListener('pointerdown', (event) => {
    drag = { y: event.clientY, height: $('#voiceView').offsetHeight };
    grip.classList.add('dragging');
    try { grip.setPointerCapture(event.pointerId); } catch { /* the drag still works while the pointer stays on it */ }
  });
  grip.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const most = $('.main').clientHeight - $('.main-head').offsetHeight - 160;   // always leave some of the conversation
    const height = Math.max(220, Math.min(most, drag.height + event.clientY - drag.y));
    $('.main').style.setProperty('--call-h', height + 'px');
    $('.main').classList.add('call-sized');
  });
  for (const name of ['pointerup', 'pointercancel']) {
    grip.addEventListener(name, () => { drag = null; grip.classList.remove('dragging'); });
  }
}

// Where to land after a voice channel or call ends.
function leaveStage() {
  if (state.call && state.users.has(state.call.with)) openDM(state.call.with);
  else openText(lastText());
}

/* ---------- messages ---------- */

// Inline formatting: `code`, **bold**, ||spoiler||, :custom_emoji: and links.
const TOKEN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\|\|[^|\n]+\|\||:[a-z0-9_]{2,32}:|https?:\/\/[^\s<>"']+)/g;
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣)+$/u;

/* @mentions: plain "@Name" in the text, for anyone with an account here. The longest name that fits wins, so
   "@Abby Lee" is Abby Lee and not Abby followed by "Lee". Kept as plain text, so a renamed person's old
   mentions stay as they were written, and other apps show them as they are. */

let mentionCache = { key: null, pattern: null };
function mentionPattern() {
  const names = [...state.users.values()].map((u) => u.name).sort((a, b) => b.length - a.length);
  const key = names.join('\n');
  if (mentionCache.key !== key) {
    const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    mentionCache = { key, pattern: names.length ? new RegExp(`(^|[^\\w@])@(${escaped.join('|')})(?!\\w)`, 'giu') : null };
  }
  return mentionCache.pattern;
}

const userNamed = (name) => [...state.users.values()].find((u) => !u.deleted && u.name.toLowerCase() === name.toLowerCase()) || null;

// Whether a message mentions us. Code in backticks does not count.
function mentionsMe(text) {
  const pattern = mentionPattern();
  if (!pattern || !text || !state.me) return false;
  const me = (self() || {}).name;
  pattern.lastIndex = 0;
  for (const hit of String(text).replace(/`[^`\n]+`/g, '').matchAll(pattern)) {
    if (me && hit[2].toLowerCase() === me.toLowerCase()) return true;
  }
  return false;
}

function mentionParts(text) {
  const pattern = mentionPattern();
  if (!pattern || !text.includes('@')) return [text];
  const out = [];
  let at = 0;
  pattern.lastIndex = 0;
  for (const hit of text.matchAll(pattern)) {
    const user = userNamed(hit[2]);
    if (!user) continue;
    const start = hit.index + hit[1].length;
    if (start > at) out.push(text.slice(at, start));
    const chip = h('span', { class: 'mention' + (state.me && user.id === state.me.id ? ' me' : ''), text: '@' + nick(user), title: '@' + user.name,
      dataset: { person: user.id }, onclick: () => openCard(user, chip) });
    out.push(chip);
    at = start + 1 + hit[2].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function formatText(text) {
  const out = [];
  for (const part of text.split(TOKEN)) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) out.push(h('code', { text: part.slice(1, -1) }));
    else if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) out.push(h('strong', { text: part.slice(2, -2) }));
    else if (part.length > 4 && part.startsWith('||') && part.endsWith('||')) {
      out.push(h('span', { class: 'spoiler-text', title: 'Spoiler: click to show',
        onclick: (event) => event.currentTarget.classList.add('shown') }, formatText(part.slice(2, -2))));
    } else if (/^:[a-z0-9_]{2,32}:$/.test(part) && state.emojis.has(part.slice(1, -1))) {
      out.push(h('img', { class: 'emoji', src: state.emojis.get(part.slice(1, -1)), alt: part, title: part }));
    } else if (/^https?:\/\//.test(part)) {
      const tail = (part.match(/[.,;:!?)\]]+$/) || [''])[0];
      const url = tail ? part.slice(0, -tail.length) : part;
      out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: url }), tail);
    } else out.push(...mentionParts(part));
  }
  return out;
}

// A message that is nothing but a few emoji is shown large.
function emojiOnly(text) {
  if (text.length > 160) return false;
  let custom = 0;
  const rest = text.replace(/:[a-z0-9_]{2,32}:/g, (token) => (state.emojis.has(token.slice(1, -1)) ? (custom++, '') : token)).replace(/\s+/g, '');
  if (!rest) return custom > 0 && custom <= 12;
  return EMOJI_ONLY.test(rest) && [...rest].length + custom <= 30;
}

function textEl(text, edited) {
  return h('div', { class: 'msg-text' + (emojiOnly(text) ? ' jumbo' : '') }, formatText(text),
    edited ? h('span', { class: 'edited', text: '(edited)', title: 'Edited ' + stamp(edited) }) : null);
}

const nearBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 140;

// Someone at the newest message stays there, whatever happens after: new messages, pictures and videos that finish
// loading (and so grow), link previews arriving, a call above the chat growing or going, the window being resized.
// Scrolling up lets go; scrolling back down to the end holds on again. (Before, a channel opened at the bottom and
// its pictures then loaded and pushed the newest messages out of sight.)
const chat = { stuck: true };
const chatGrew = new ResizeObserver(() => { if (chat.stuck) { const box = $('#messages'); box.scrollTop = box.scrollHeight; } });
function toBottom(box) {
  chat.stuck = true;
  box.scrollTop = box.scrollHeight;
}
// Only the person lets go, by scrolling up themselves (wheel, touch, the scrollbar, scrolling keys). A scroll that
// happens to the list (text wrapping again while the window is minimised or tiny, something above growing before the
// list follows it) never does; reaching the end again always holds on.
let scrolledByHand = 0;
{
  const box = $('#messages');
  const byHand = () => { scrolledByHand = performance.now(); };
  for (const kind of ['wheel', 'touchmove', 'pointerdown']) box.addEventListener(kind, byHand, { passive: true });
  document.addEventListener('keydown', (event) => {
    if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(event.key)
      && !(event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]'))) byHand();
  });
  box.addEventListener('scroll', () => {
    if (!box.clientHeight) return;   // hidden or minimised: nothing to go by
    if (nearBottom(box)) chat.stuck = true;
    else if (performance.now() - scrolledByHand < 1500) chat.stuck = false;
  }, { passive: true });
  chatGrew.observe(box);
  // Back on screen (the window shown again, or in front again): still at the newest message.
  const backToNewest = () => { if (chat.stuck && isConv()) toBottom(box); };
  document.addEventListener('visibilitychange', backToNewest);
  if (appShell && appShell.onShown) appShell.onShown(backToNewest);
  if (appShell && appShell.onWindowFocus) appShell.onWindowFocus(backToNewest);
}

function redrawMessages() {
  const box = $('#messages');
  const y = box.scrollTop;
  renderMessages();
  if (chat.stuck) toBottom(box); else box.scrollTop = y;
  renderReplyBar();
}

function fileLink(a) {
  return h('a', { class: 'att-file', href: a.url, download: a.name },
    icon('clip'), h('span', { class: 'att-name', text: a.name }), h('span', { class: 'att-size', text: prettySize(a.size) }));
}

/* favourites: the star on GIFs (and the other moving-picture formats, APNG and WebP), to send them again */

const isFavorite = (url) => state.favorites.some((f) => f.url === url);
const favoritable = (a) => /\.(gif|apng|webp)$/i.test(String(a.name || a.url || ''));

function markFavorite(button) {
  const on = isFavorite(button.dataset.fav);
  button.classList.toggle('on', on);
  button.title = on ? 'Remove from favorites' : 'Add to favorites';
}

function favoriteButton(a) {
  const button = h('button', { class: 'ctl sm fav', type: 'button', dataset: { fav: a.url }, onclick: (event) => {
    event.stopPropagation();
    send({ type: 'favorite', url: a.url, name: a.name, on: !isFavorite(a.url) });
  } }, icon('star'));
  markFavorite(button);
  return button;
}

/* image viewer: opens a picture or GIF over the app instead of leaving it */

function closeLightbox() {
  const box = $('#lightbox');
  if (box) box.remove();
}

function openLightbox(a) {
  closeLightbox();
  const img = h('img', { class: 'lb-img', src: a.url, alt: a.name });
  // Click to zoom in towards the point that was clicked; click again to zoom back out.
  const zoom = (event) => {
    const zoomed = img.classList.toggle('zoomed');
    if (zoomed && event) {
      const rect = img.getBoundingClientRect();
      const x = Math.min(100, Math.max(0, (event.clientX - rect.left) / rect.width * 100));
      const y = Math.min(100, Math.max(0, (event.clientY - rect.top) / rect.height * 100));
      img.style.transformOrigin = `${x}% ${y}%`;
    }
    img.style.transform = zoomed ? 'scale(2.5)' : '';
  };
  img.addEventListener('click', (event) => { event.stopPropagation(); zoom(event); });
  const tool = (name, title, extra) => h(extra && extra.href ? 'a' : 'button',
    Object.assign({ class: 'ctl', title }, extra && extra.href ? {} : { type: 'button' }, extra), icon(name));
  const box = h('div', { class: 'lightbox', id: 'lightbox', onclick: closeLightbox },
    h('div', { class: 'lb-tools', onclick: (event) => event.stopPropagation() },
      tool('zoom', 'Zoom', { onclick: () => zoom(null) }),
      tool('external', 'Open in browser', { href: a.url, target: '_blank', rel: 'noopener' }),
      tool('download', 'Download', { href: a.url, download: a.name }),
      tool('x', 'Close', { onclick: closeLightbox })),
    img,
    h('div', { class: 'lb-name', text: a.name }));
  document.body.append(box);
}

/* video player: our own controls instead of the browser's */

function clockTime(seconds) {
  if (!isFinite(seconds)) return '0:00';
  const s = Math.floor(seconds);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function videoPlayer(a, onReady) {
  const video = h('video', { src: a.url, preload: 'metadata', playsInline: true });
  video.volume = store.get('videoVolume', 1);
  const big = h('button', { class: 'vp-big', type: 'button', title: 'Play' }, icon('play'));
  const playButton = h('button', { class: 'ctl vp-btn', type: 'button', title: 'Play' }, icon('play'));
  const time = h('span', { class: 'vp-time', text: '0:00 / 0:00' });
  const seek = h('input', { class: 'vp-seek', type: 'range', min: '0', max: '1000', step: '1', title: 'Seek' });
  seek.value = '0';
  const muteButton = h('button', { class: 'ctl vp-btn', type: 'button', title: 'Mute' }, icon('speaker'));
  const volume = h('input', { class: 'vp-vol', type: 'range', min: '0', max: '1', step: '0.02', title: 'Volume' });
  volume.value = String(video.volume);
  const fullButton = h('button', { class: 'ctl vp-btn', type: 'button', title: 'Full screen' }, icon('expand'));
  const el = h('div', { class: 'vp paused' }, video, big,
    h('div', { class: 'vp-bar' }, playButton, time, seek, muteButton, volume, fullButton));

  let dragging = false;
  let idle = 0;
  const toggle = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
  const wake = () => {
    el.classList.add('active');
    clearTimeout(idle);
    idle = setTimeout(() => el.classList.remove('active'), 2200);
  };
  const showState = () => {
    el.classList.toggle('paused', video.paused);
    playButton.replaceChildren(icon(video.paused ? 'play' : 'pause'));
    playButton.title = video.paused ? 'Play' : 'Pause';
  };
  const showTime = () => {
    time.textContent = `${clockTime(video.currentTime)} / ${clockTime(video.duration)}`;
    if (!dragging && video.duration) seek.value = String(Math.round(video.currentTime / video.duration * 1000));
    seek.style.setProperty('--played', (video.duration ? video.currentTime / video.duration * 100 : 0) + '%');
  };
  const showVolume = () => {
    const silent = video.muted || video.volume === 0;
    muteButton.replaceChildren(icon('speaker', silent));
    muteButton.title = silent ? 'Unmute' : 'Mute';
    volume.value = String(video.muted ? 0 : video.volume);
  };

  video.addEventListener('click', toggle);
  video.addEventListener('dblclick', () => toggleFullscreen(el));
  big.addEventListener('click', toggle);
  playButton.addEventListener('click', toggle);
  fullButton.addEventListener('click', () => toggleFullscreen(el));
  muteButton.addEventListener('click', () => { video.muted = !video.muted; });
  volume.addEventListener('input', () => {
    video.muted = false;
    video.volume = +volume.value;
    store.set('videoVolume', video.volume);
  });
  seek.addEventListener('pointerdown', () => { dragging = true; });
  seek.addEventListener('input', () => { if (video.duration) video.currentTime = +seek.value / 1000 * video.duration; });
  seek.addEventListener('change', () => { dragging = false; });
  for (const name of ['play', 'pause', 'ended']) video.addEventListener(name, showState);
  for (const name of ['timeupdate', 'durationchange', 'seeked']) video.addEventListener(name, showTime);
  video.addEventListener('volumechange', showVolume);
  video.addEventListener('loadedmetadata', () => {
    // The player takes the video's own shape, up to 560 wide and 420 tall, so a phone video stands tall
    // instead of sitting in the middle of a wide black box.
    if (video.videoWidth && video.videoHeight) {
      const ratio = video.videoWidth / video.videoHeight;
      el.classList.add('shaped');
      el.style.setProperty('--ratio', String(ratio));
      (el.closest('.att') || el).style.width = `min(${Math.round(Math.min(560, 420 * ratio))}px, 100%)`;
    }
    showTime();
    if (onReady) onReady();
  });
  video.addEventListener('error', () => (el.closest('.att') || el).replaceWith(fileLink(a)));
  el.addEventListener('mousemove', wake);
  el.addEventListener('keydown', (event) => {
    if (event.target !== el) return;
    if (event.key === ' ' || event.key === 'k') { event.preventDefault(); toggle(); }
    if (event.key === 'ArrowRight') video.currentTime += 5;
    if (event.key === 'ArrowLeft') video.currentTime -= 5;
    if (event.key === 'f') toggleFullscreen(el);
    if (event.key === 'm') video.muted = !video.muted;
  });
  el.tabIndex = 0;
  showVolume();
  return el;
}

/* audio player: a card with the file name, our own controls, and a download button on hover */

function audioPlayer(a) {
  const sound = h('audio', { src: a.url, preload: 'metadata' });
  sound.volume = store.get('videoVolume', 1);
  const playButton = h('button', { class: 'ctl ap-btn', type: 'button', title: 'Play' }, icon('play'));
  const time = h('span', { class: 'vp-time', text: '0:00 / 0:00' });
  const seek = h('input', { class: 'vp-seek', type: 'range', min: '0', max: '1000', step: '1', title: 'Seek' });
  seek.value = '0';
  const muteButton = h('button', { class: 'ctl ap-btn', type: 'button', title: 'Mute' }, icon('speaker'));
  const volume = h('input', { class: 'vp-vol', type: 'range', min: '0', max: '1', step: '0.02', title: 'Volume' });
  const el = h('div', { class: 'ap' },
    h('div', { class: 'ap-head' },
      h('span', { class: 'ap-icon' }, icon('speaker')),
      h('div', { class: 'ap-meta' },
        h('a', { class: 'ap-name', href: a.url, download: a.name, title: 'Download ' + a.name, text: a.name }),
        h('span', { class: 'ap-size', text: prettySize(a.size) })),
      h('a', { class: 'ctl ap-dl', href: a.url, download: a.name, title: 'Download' }, icon('download'))),
    h('div', { class: 'ap-row' }, playButton, time, seek, muteButton, volume),
    sound);

  let dragging = false;
  const toggle = () => { if (sound.paused) sound.play().catch(() => {}); else sound.pause(); };
  const showState = () => {
    el.classList.toggle('playing', !sound.paused);
    playButton.replaceChildren(icon(sound.paused ? 'play' : 'pause'));
    playButton.title = sound.paused ? 'Play' : 'Pause';
  };
  const showTime = () => {
    time.textContent = `${clockTime(sound.currentTime)} / ${clockTime(sound.duration)}`;
    if (!dragging && sound.duration) seek.value = String(Math.round(sound.currentTime / sound.duration * 1000));
    seek.style.setProperty('--played', (sound.duration ? sound.currentTime / sound.duration * 100 : 0) + '%');
  };
  const showVolume = () => {
    const silent = sound.muted || sound.volume === 0;
    muteButton.replaceChildren(icon('speaker', silent));
    muteButton.title = silent ? 'Unmute' : 'Mute';
    volume.value = String(sound.muted ? 0 : sound.volume);
    volume.style.setProperty('--played', (sound.muted ? 0 : sound.volume * 100) + '%');
  };

  playButton.addEventListener('click', toggle);
  muteButton.addEventListener('click', () => { sound.muted = !sound.muted; });
  volume.addEventListener('input', () => {
    sound.muted = false;
    sound.volume = +volume.value;
    store.set('videoVolume', sound.volume);
  });
  seek.addEventListener('pointerdown', () => { dragging = true; });
  seek.addEventListener('input', () => { if (sound.duration) sound.currentTime = +seek.value / 1000 * sound.duration; });
  seek.addEventListener('change', () => { dragging = false; });
  // Starting one sound stops any other that is playing, so two never talk over each other.
  sound.addEventListener('play', () => {
    for (const other of $$('#messages audio, #messages video')) if (other !== sound && !other.paused) other.pause();
  });
  for (const name of ['play', 'pause', 'ended']) sound.addEventListener(name, showState);
  for (const name of ['timeupdate', 'durationchange', 'seeked', 'loadedmetadata']) sound.addEventListener(name, showTime);
  sound.addEventListener('volumechange', showVolume);
  sound.addEventListener('error', () => el.replaceWith(fileLink(a)));
  applyOutput(sound);
  showVolume();
  return el;
}

// Images (GIFs included) open in the viewer, video plays in our own player, audio plays in place, and
// anything else is a download link. Pictures and videos can be starred, and may arrive hidden as spoilers.
function attachmentEl(a) {
  if (a.kind === 'audio') return audioPlayer(a);
  if (a.kind !== 'image' && a.kind !== 'video') return fileLink(a);
  // (Growing once loaded keeps the chat at its newest message: see chatGrew.)
  const media = a.kind === 'video'
    ? videoPlayer(a)
    : h('button', { class: 'att-image', type: 'button', title: a.name, onclick: () => openLightbox(a) },
      h('img', { src: a.url, alt: a.name, onerror: () => wrap.replaceWith(fileLink(a)) }));
  const wrap = h('div', { class: 'att ' + a.kind + (a.spoiler ? ' spoiler' : '') }, media, favoritable(a) ? favoriteButton(a) : null,
    a.spoiler ? h('button', { class: 'spoiler-cover', type: 'button', title: 'Spoiler: click to show',
      onclick: () => wrap.classList.remove('spoiler') }, h('span', { text: 'Spoiler' })) : null);
  return wrap;
}

/* link previews */

// A YouTube video or a post on X in a message gets a card underneath, as in Discord. The server looks the link up
// (and keeps the answer a while for everyone); the pictures load from YouTube's and X's own servers, and a video
// plays in YouTube's player only once someone clicks it.
const PREVIEWABLE = [
  /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|(?:shorts|live|embed)\/)|youtu\.be\/)[A-Za-z0-9_-]{11}/,
  /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com\/[A-Za-z0-9_]{1,15}\/status(?:es)?\/\d{1,25}/,
];
const previews = new Map();   // link -> { asked, done, data, slots: the places waiting for it }
const external = (href) => ({ href, target: '_blank', rel: 'noopener noreferrer' });

// The links in a message that get a card (three at most), leaving out any inside a spoiler or code.
/* ---------- invite links in messages: a card to join the server, as in Discord ---------- */

const INVITE_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const inviteInfo = new Map();   // code -> null while asked, then what the server said (see 'invite-info')

// Invite links to this server in a message (at its address here or its address for apps), with or without https://.
function inviteLinksIn(text) {
  const hosts = new Set([location.host.toLowerCase()]);
  try { if (state.appAddress) hosts.add(new URL(state.appAddress).host.toLowerCase()); } catch { /* none */ }
  const plain = String(text || '').replace(/\|\|[\s\S]*?\|\||`[^`]*`/g, ' ');
  const codes = [];
  for (const word of plain.split(/\s+/)) {
    const hit = word.replace(/^[<(]+|[>).,;:!?\]]+$/g, '').match(/^(?:https?:\/\/)?([^/\s]+)\/([A-Za-z0-9]{8})\/?$/i);
    if (!hit || !hosts.has(hit[1].toLowerCase()) || !INVITE_CODE.test(hit[2].toUpperCase())) continue;
    if (!codes.includes(hit[2].toUpperCase())) codes.push(hit[2].toUpperCase());
    if (codes.length === 3) break;
  }
  return codes;
}

function inviteCard(code, mine) {
  const card = h('div', { class: 'invite-card', dataset: { inviteCard: code, mine: mine ? '1' : '' } });
  fillInviteCard(card);
  if (!inviteInfo.has(code)) { inviteInfo.set(code, null); send({ type: 'invite-info', code }); }
  return card;
}

function fillInviteCard(card) {
  const code = card.dataset.inviteCard;
  const info = inviteInfo.get(code);
  const label = h('div', { class: 'invite-card-label', text: card.dataset.mine ? 'You sent an invite to join a server' : 'You\'ve been invited to join a server' });
  if (!info || !info.valid) {
    card.classList.toggle('invalid', !!info);
    card.replaceChildren(label, h('div', { class: 'invite-card-row' },
      h('div', { class: 'invite-card-icon blank' }, icon(info ? 'x' : 'hash')),
      h('div', { class: 'invite-card-text' },
        h('b', { text: info ? 'Invalid invite' : 'Loading invite…' }),
        info ? h('span', { class: 'invite-card-sub', text: 'This invite has expired or been used up. Ask for a new one.' }) : null)));
    return;
  }
  const pic = h('div', { class: 'invite-card-icon' });
  if (info.serverIcon) pic.append(h('img', { src: info.serverIcon, alt: '' })); else pic.textContent = (info.serverName || '?').trim().slice(0, 2).toUpperCase();
  const name = h('b', { class: 'invite-card-name' }, info.serverPartner ? (() => { const check = icon('partner'); check.classList.add('invite-card-check'); check.dataset.tip = 'Umbryx Partner'; return check; })() : null,
    h('span', { text: info.serverName || 'Umbryx' }));
  const counts = h('div', { class: 'invite-card-sub' },
    h('span', { class: 'invite-dot online' }), `${info.online} Online`, h('span', { class: 'invite-dot' }), `${info.members} ${info.members === 1 ? 'Member' : 'Members'}`);
  let button;
  if (info.member && !state.guest) {
    button = h('button', { class: 'btn invite-join joined', type: 'button', onclick: () => openText(lastText()) }, 'Joined');
  } else if (info.banned) {
    button = h('button', { class: 'btn invite-join', type: 'button', disabled: true, title: 'You are banned from this server' }, 'Banned');
  } else {
    button = h('button', { class: 'btn invite-join', type: 'button', onclick: () => (state.hasPassword ? send({ type: 'redeem', code }) : openClaim(code)) }, 'Join');
  }
  card.classList.remove('invalid');
  card.replaceChildren(
    info.serverBanner ? h('div', { class: 'invite-card-banner' }, h('img', { src: info.serverBanner, alt: '' })) : null,
    label,
    h('div', { class: 'invite-card-row' }, pic, h('div', { class: 'invite-card-text' }, name, counts), button));
}

function previewLinks(text) {
  const plain = String(text || '').replace(/\|\|[\s\S]*?\|\||`[^`]*`/g, ' ');
  const found = [];
  for (const hit of plain.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const url = hit[0].replace(/[.,;:!?)\]]+$/, '');
    if (!found.includes(url) && PREVIEWABLE.some((re) => re.test(url))) found.push(url);
    if (found.length === 3) break;
  }
  return found;
}

function previewSlot(url) {
  const slot = h('div', { class: 'embed-slot' });
  let entry = previews.get(url);
  if (!entry) previews.set(url, entry = { asked: false, done: false, data: null, slots: new Set() });
  if (entry.done) fillPreview(slot, entry.data);
  else {
    entry.slots.add(slot);
    if (!entry.asked) entry.asked = send({ type: 'embed', url });
  }
  return slot;
}

function fillPreview(slot, e) {
  const card = e && (e.kind === 'youtube' ? youtubeCard(e) : e.kind === 'x' ? xCard(e) : null);
  if (card) slot.replaceChildren(card); else slot.remove();
}

function youtubeCard(e) {
  const at = e.start ? `&t=${e.start}s` : '';
  const frame = h('div', { class: 'yt-frame' + (e.vertical ? ' vertical' : '') });
  const play = () => frame.replaceChildren(h('iframe', {
    src: `https://www.youtube-nocookie.com/embed/${e.id}?autoplay=1&rel=0${e.start ? '&start=' + e.start : ''}`,
    title: e.title || 'YouTube video', allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowFullscreen: true,
    // YouTube's player refuses to play for a page that does not say where it is
    referrerPolicy: 'strict-origin-when-cross-origin' }));
  frame.append(h('img', { src: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' }),
    h('button', { class: 'yt-play', type: 'button', title: 'Play', onclick: play }, icon('play')));
  return h('div', { class: 'embed yt' },
    h('div', { class: 'embed-site', text: 'YouTube' }),
    e.author ? h('a', { class: 'embed-author', ...external(e.authorUrl || e.url), text: e.author }) : null,
    h('a', { class: 'embed-title', ...external(e.url + at), text: e.title || 'YouTube video' }),
    frame);
}

// 1234 -> "1.2K", 1895973 -> "1.9M"
const shortCount = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : String(n));

function xCard(e) {
  let media = null;
  if (e.video) {
    const gif = !!e.video.gif;
    media = h('video', { class: 'x-video', src: e.video.url, poster: e.video.poster || null, controls: !gif, autoplay: gif, loop: gif, muted: gif,
      playsInline: true, preload: gif ? 'auto' : 'none' });
    if (e.video.w && e.video.h) media.style.aspectRatio = `${e.video.w} / ${e.video.h}`;
  } else if (e.photos && e.photos.length) {
    media = h('div', { class: 'x-photos n' + e.photos.length }, e.photos.map((p, i) => {
      const img = h('img', { src: p.url, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
      if (e.photos.length === 1 && p.w && p.h) img.style.aspectRatio = `${p.w} / ${p.h}`;
      return h('button', { class: 'x-photo', type: 'button', title: 'Open picture',
        onclick: () => openLightbox({ kind: 'image', url: p.url, name: `${e.handle} picture ${i + 1}` }) }, img);
    }));
  }
  const stats = [e.replies != null ? `${shortCount(e.replies)} replies` : '', e.reposts != null ? `${shortCount(e.reposts)} reposts` : '',
    e.likes != null ? `${shortCount(e.likes)} likes` : ''].filter(Boolean).join(' · ');
  return h('div', { class: 'embed x' },
    h('a', { class: 'x-author', ...external(`https://x.com/${e.handle}`) },
      e.avatar ? h('img', { src: e.avatar, alt: '', referrerPolicy: 'no-referrer' }) : null, h('b', { text: e.name }), h('span', { text: '@' + e.handle })),
    e.text ? h('div', { class: 'x-text' }, linkText(e.text)) : null,
    media,
    h('div', { class: 'x-foot' }, h('a', { ...external(e.url), text: 'X' }), e.date ? h('span', { text: stamp(e.date) }) : null,
      stats ? h('span', { text: stats }) : null));
}

// Writing with its web addresses made into links (bios, posts on X).
function linkText(text) {
  const out = [];
  let at = 0;
  for (const hit of String(text).matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const url = hit[0].replace(/[.,;:!?)\]]+$/, '');
    if (hit.index > at) out.push(text.slice(at, hit.index));
    out.push(h('a', { ...external(url), text: url }));
    at = hit.index + url.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/* replies */

function replyRef(reply) {
  const who = (reply.uid && state.users.get(reply.uid)) || { name: reply.name || 'Unknown' };
  const name = h('b', { text: '@' + nick(who) });
  name.style.color = nameColor(who);
  return h('button', { class: 'msg-reply', type: 'button', title: 'Go to the message', dataset: reply.uid ? { person: reply.uid } : {}, onclick: () => jumpTo(reply.id) },
    avatar(who, 'xs'), name, h('span', { text: reply.text }));
}

function jumpTo(id) {
  const row = $(`#messages .msg[data-id="${id}"]`);
  if (!row) { toast('That message is further back, or it was deleted.'); return; }
  chat.stuck = false;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1600);
}

// A message found by search may be further back than what is loaded: older pages are fetched until it is.
async function jumpToMessage(where, id) {
  if (where.dm && state.users.has(where.dm)) openDM(where.dm);
  else if (where.channel && channelById(where.channel)) openText(where.channel);
  else return;
  const key = where.dm ? 'dm:' + where.dm : where.channel;
  for (let i = 0; i < 60; i++) {
    if (convKey() !== key) return;   // they went somewhere else meanwhile
    const cache = state.cache.get(key);
    if (cache && cache.loaded && !cache.loading) {
      if ($(`#messages .msg[data-id="${id}"]`)) break;
      if (!cache.more || !cache.list.length) break;
      cache.loading = true;
      const before = cache.list[0].id;
      send(where.dm ? { type: 'dm-history', with: where.dm, before } : { type: 'history', channel: where.channel, before });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  jumpTo(id);
}

function startReply(m) {
  state.replyTo = { id: m.id, name: authorOf(m).name, key: convKey() };
  renderReplyBar();
  input.focus();
}

function renderReplyBar() {
  const reply = state.replyTo && isConv() && state.replyTo.key === convKey() ? state.replyTo : null;
  $('#replyBar').hidden = !reply;
  if (reply) $('#replyText').replaceChildren('Replying to ', h('b', { text: reply.name }));
  for (const row of $$('#messages .msg.replying')) row.classList.remove('replying');
  const row = reply && $(`#messages .msg[data-id="${reply.id}"]`);
  if (row) row.classList.add('replying');
}

/* editing your own messages */

function startEdit(m) {
  if (m.uid !== state.me.id || !isConv()) return;
  const selection = window.getSelection();
  if (selection) selection.removeAllRanges();   // a double click also selects a word
  state.editing = { id: m.id, key: convKey(), draft: m.text || '' };
  redrawMessages();
}

function cancelEdit() {
  if (!state.editing) return;
  state.editing = null;
  redrawMessages();
  input.focus();
}

function saveEdit(m) {
  if (!state.editing) return;
  const text = state.editing.draft.trim();
  if (!text && !(m.attachments && m.attachments.length)) { toast('A message cannot be empty. Use Delete to remove it.'); return; }
  if (text !== (m.text || '') && !send({ type: 'message-edit', id: m.id, text, ...placeOf(m) })) {
    toast('Not connected to the server right now.');
    return;
  }
  cancelEdit();
}

function editorEl(m) {
  const area = h('textarea', { class: 'msg-edit', rows: 1, maxLength: 4000, 'aria-label': 'Edit message' });
  area.value = state.editing.draft;
  area.addEventListener('input', () => { state.editing.draft = area.value; fitEditor(area); });
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
    else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); saveEdit(m); }
  });
  const link = (text, run) => h('button', { class: 'btn link', type: 'button', onclick: run }, text);
  return h('div', { class: 'msg-editor' }, area,
    h('div', { class: 'msg-edit-hint' }, 'Escape to ', link('cancel', cancelEdit), ' · Enter to ', link('save', () => saveEdit(m))));
}

function fitEditor(area) {
  area.style.height = 'auto';
  area.style.height = Math.min(area.scrollHeight + 2, 260) + 'px';
}

// After the messages are drawn again, put the cursor back in the message being edited.
function focusEditor() {
  const area = $('#messages .msg-edit');
  if (!area) return;
  fitEditor(area);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

/* one message */

// `bare` draws just the message, without hover buttons or grouping (used in the pinned list).
// Someone joined the server (the server's join line, see its _announce_join): a green arrow and one of these, picked by
// the server (m.join), with their name as it is now. The iPhone app has the same list, in the same order.
const JOIN_TEXTS = [
  '{name} joined the party.', '{name} just showed up!', 'Welcome, {name}. Say hi!', '{name} hopped into the server.',
  'Everyone welcome {name}!', '{name} just landed.', "Glad you're here, {name}.", '{name} is here. Make some noise!',
  'A wild {name} appeared.', '{name} slid into the server.', 'Good to see you, {name}.', '{name} brought snacks, hopefully.',
];
function joinEl(m) {
  const who = authorOf(m);
  const [before, after] = (JOIN_TEXTS[m.join] || JOIN_TEXTS[0]).split('{name}');
  const name = h('button', { class: 'join-name', type: 'button', text: nick(who), dataset: who.id ? { person: who.id } : {},
    onclick: () => openCard(who, name) });
  return h('div', { class: 'msg join-msg', dataset: { id: m.id } },
    h('span', { class: 'join-arrow' }, icon('arrowRight')),
    h('div', { class: 'join-text' }, before, name, after, h('time', { text: stamp(m.ts) })));
}

// Messages someone you blocked wrote in a channel fold into a line; Show opens one (until the page reloads).
const shownBlocked = new Set();
function blockedEl(m, prev) {
  const key = convKey() + ':' + m.id;
  const el = h('div', { class: 'msg blocked-msg', dataset: { id: m.id } },
    h('span', { class: 'blocked-mark' }, icon('block')),
    h('span', { text: 'Blocked message' }),
    h('button', { class: 'linkish', type: 'button', onclick: () => { shownBlocked.add(key); el.replaceWith(messageEl(m, prev)); } }, 'Show'));
  return el;
}

function messageEl(m, prev, bare) {
  if (typeof m.join === 'number') return joinEl(m);
  if (!bare && m.channel && isBlocked(m.uid) && !shownBlocked.has(convKey() + ':' + m.id)) return blockedEl(m, prev);
  const who = authorOf(m);
  const mine = m.uid === state.me.id;
  const editing = !bare && mine && !!state.editing && state.editing.id === m.id && state.editing.key === convKey();
  const sameAuthor = prev && typeof prev.join !== 'number' && (m.uid ? prev.uid === m.uid : !prev.uid && prev.name === m.name);
  const compact = !bare && !m.reply && sameAuthor && m.ts - prev.ts < 5 * 60000 && dayKey(prev.ts) === dayKey(m.ts);
  const body = h('div', { class: 'msg-body' });
  if (m.pinned && !bare) body.append(h('div', { class: 'pin-flag' }, icon('pin'), 'Pinned'));
  if (editing) body.append(editorEl(m));
  else if (m.text) body.append(textEl(m.text, m.edited));
  for (const a of m.attachments || []) body.append(attachmentEl(a));
  if (!bare && !editing) for (const url of previewLinks(m.text)) body.append(previewSlot(url));
  if (!bare && !editing) for (const code of inviteLinksIn(m.text)) body.append(inviteCard(code, mine));
  const action = (glyph, title, run, extra) => h('button', { class: 'ctl sm' + (extra ? ' ' + extra : ''), type: 'button', title, onclick: run }, icon(glyph));
  const actions = bare ? null : h('div', { class: 'msg-actions' },
    action('reply', 'Reply', () => startReply(m)),
    action('pin', m.pinned ? 'Unpin' : 'Pin', () => pinMessage(m, !m.pinned), m.pinned ? 'on' : ''),
    mine ? action('pencil', 'Edit', () => startEdit(m)) : null,
    !mine && who.id && !who.deleted ? action('flag', 'Report', () => openReport(who, m)) : null,
    mine || (state.canModerate && m.channel) ? action('trash', 'Delete', () => deleteMessage(m), 'danger') : null);
  const mentioned = !bare && !mine && !!m.text && mentionsMe(m.text);
  const row = { class: 'msg' + (compact ? ' compact' : '') + (editing ? ' editing' : '') + (mentioned ? ' mentioned' : ''), dataset: { id: m.id } };
  let el;
  if (compact) el = h('div', row, h('time', { class: 'msg-hover-time', text: timeFormat.format(m.ts) }), body, actions);
  else {
    const pic = avatar(who);
    pic.addEventListener('click', () => openCard(who, pic));
    const author = h('button', { class: 'msg-author', type: 'button', text: nick(who), onclick: () => openCard(who, author) });
    if (who.id) pic.dataset.person = author.dataset.person = who.id;
    author.style.color = nameColor(who);
    el = h('div', row, m.reply && !bare ? replyRef(m.reply) : null, pic,
      h('div', { class: 'msg-main' }, h('div', { class: 'msg-meta' }, author, who.id ? msgDevices(who) : null, h('time', { text: stamp(m.ts) })), body), actions);
  }
  // Double-clicking someone else's message replies to it; your own, edits it. Pictures, videos, links and buttons
  // keep their own clicks.
  if (!bare && !editing) {
    el.addEventListener('dblclick', (event) => {
      if (event.target.closest('button, a, input, textarea, video, audio, iframe, .att, .embed, .spoiler-text:not(.shown)')) return;
      if (mine) { startEdit(m); return; }
      const selection = window.getSelection();
      if (selection) selection.removeAllRanges();   // a double click also selects a word
      startReply(m);
    });
  }
  return el;
}

// Where a message lives, in the form the server expects.
const placeOf = (m) => (m.channel ? { channel: m.channel } : { dm: m.uid === state.me.id ? m.to : m.uid });

function deleteMessage(m) {
  // An admin deleting someone else's message in a channel is asked first; your own go at once.
  if (m.uid !== state.me.id && !confirm(`Delete this message by ${nick(authorOf(m))}? Everyone stops seeing it.`)) return;
  send({ type: 'message-delete', id: m.id, ...placeOf(m) });
}

function pinMessage(m, pinned) {
  send({ type: 'message-pin', id: m.id, pinned, ...placeOf(m) });
}

/* pinned messages */

let pinsKey = null;   // the conversation whose pins the dialog is showing

function requestPins() {
  send({ type: 'pins', ...(pinsKey.startsWith('dm:') ? { dm: pinsKey.slice(3) } : { channel: pinsKey }) });
}

// Pinned messages drop down under the pin button that opened them; that button again, Escape, a click elsewhere or
// another conversation closes them.
const pinsOpen = () => !$('#pinsPop').hidden;
function closePins() { $('#pinsPop').hidden = true; }
function openPins(event) {
  if (!isConv()) return;
  if (pinsOpen()) { closePins(); return; }
  pinsKey = convKey();
  $('#pinsList').replaceChildren(h('div', { class: 'empty', text: 'Loading…' }));
  const pop = $('#pinsPop');
  const anchor = event && event.currentTarget && event.currentTarget.getBoundingClientRect ? event.currentTarget.getBoundingClientRect() : null;
  pop.style.top = `${Math.round(anchor ? anchor.bottom + 8 : 100)}px`;
  pop.style.right = `${Math.max(8, Math.round(anchor ? innerWidth - anchor.right : 20))}px`;
  pop.hidden = false;
  requestPins();
}
$('#pinsClose').replaceChildren(icon('x'));
$('#pinsClose').addEventListener('click', closePins);
document.addEventListener('pointerdown', (event) => {
  if (pinsOpen() && !event.target.closest('#pinsPop, [title="Pinned messages"]')) closePins();
}, true);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && pinsOpen()) closePins(); });

function renderPins(messages) {
  const list = $('#pinsList');
  if (!messages.length) {
    list.replaceChildren(h('div', { class: 'empty', text: 'Nothing is pinned here yet. Hover a message and click the pin.' }));
    return;
  }
  list.replaceChildren(...messages.slice().reverse().map((m) => h('div', { class: 'pin-row' },
    messageEl(m, null, true),
    h('div', { class: 'pin-acts' },
      h('button', { class: 'btn slim', type: 'button', onclick: () => { closePins(); jumpTo(m.id); } }, 'Go to'),
      h('button', { class: 'btn slim', type: 'button', onclick: () => pinMessage(m, false) }, 'Unpin')))));
}

function appendMessage(box, m, prev) {
  if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) box.append(h('div', { class: 'day' }, h('span', { text: dayFormat.format(m.ts) })));
  const el = messageEl(m, prev);
  box.append(el);
  chatGrew.observe(el);   // it grows when its pictures, video or link previews load
}

function renderMessages() {
  const box = $('#messages');
  const cache = cacheFor(convKey());
  chatGrew.disconnect();
  chatGrew.observe(box);
  box.replaceChildren();
  if (!cache.loaded) { box.append(h('div', { class: 'empty', text: 'Loading messages…' })); return; }
  if (!cache.more) {
    if (state.view.type === 'dm') {
      const user = state.users.get(state.view.id);
      box.append(h('div', { class: 'chan-intro', dataset: user ? { person: user.id } : {} }, avatar(user, 'lg'), h('h3', { text: nick(user) }),
        h('p', { text: `This is the start of your direct messages with ${nick(user)}.` })));
    } else {
      box.append(h('div', { class: 'chan-intro' },
        h('h3', { text: 'Welcome to #' + ((channelById(state.view.id) || {}).name || '') }),
        h('p', { text: 'This is the start of the channel.' })));
    }
  }
  let prev = null;
  for (const m of cache.list) { appendMessage(box, m, prev); prev = m; }
  focusEditor();
}

$('#messages').addEventListener('scroll', () => {
  const box = $('#messages');
  if (!isConv()) return;
  const cache = state.cache.get(convKey());
  if (!cache || !cache.loaded || !cache.more || cache.loading || !cache.list.length || box.scrollTop > 160) return;
  cache.loading = true;
  const before = cache.list[0].id;
  send(state.view.type === 'dm' ? { type: 'dm-history', with: state.view.id, before } : { type: 'history', channel: state.view.id, before });
});

/* typing status */

const typingIn = (key) => { const map = state.typing.get(key); return !!map && map.size > 0; };

// Someone started or stopped typing in a conversation. A typist who goes quiet drops off after a few seconds.
function setTyping(key, name, on) {
  if (!state.typing.has(key)) state.typing.set(key, new Map());
  const map = state.typing.get(key);
  const had = map.has(name);
  clearTimeout(map.get(name));
  if (on) map.set(name, setTimeout(() => setTyping(key, name, false), 6000));
  else map.delete(name);
  if (!had && !on) return;
  renderTyping();
  if (had !== on) renderSidebar();   // the dots next to the conversation in the list
}

function renderTyping() {
  const map = isConv() ? state.typing.get(convKey()) : null;
  const names = map ? [...map.keys()] : [];
  const who = (name) => h('b', { text: name });
  const line = $('#typing');
  if (!names.length) line.replaceChildren();
  else if (names.length === 1) line.replaceChildren(dots(), who(names[0]), ' is typing…');
  else if (names.length <= 3) {
    line.replaceChildren(dots(), ...names.flatMap((name, i) => [i ? (i === names.length - 1 ? ' and ' : ', ') : '', who(name)]), ' are typing…');
  } else line.replaceChildren(dots(), 'Several people are typing…');
}

// Tell the conversation we were typing in that we have stopped, so the note there goes away at once.
function stopTyping() {
  if (!typingPlace) return;
  send({ type: 'typing', stop: true, ...typingPlace });
  typingPlace = null;
  lastTypingSent = 0;
}

/* ---------- composer and uploads ---------- */

const pending = [];   // { file, progress } waiting to go out with the next message
const input = $('#input');

// Typing (or pasting) while nothing else takes keys goes into the message box: no click on it first.
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing || !state.me || !isConv() || input.disabled) return;
  const typed = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
  const paste = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v';
  if (!typed && !paste) return;
  const el = document.activeElement;
  if (el === input || (el && el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))) return;
  if (document.querySelector('dialog[open], .person-menu, #lightbox') || $('#app').hidden) return;
  input.focus({ preventScroll: true });   // the key itself then lands in the box
});
let lastTypingSent = 0;
let typingPlace = null;   // where we last said we were typing: { dm } or { channel }
let sending = false;

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

// What kind of preview a file waiting to be sent gets.
function pendingKind(file) {
  if (/^image\//.test(file.type) || /\.(jfif|png|apng|jpe?g|gif|webp|avif|bmp)$/i.test(file.name)) return 'image';
  if (/^video\//.test(file.type) || /\.(mp4|webm|mov|m4v|mkv|ogv)$/i.test(file.name)) return 'video';
  if (/^audio\//.test(file.type) || /\.(mp3|wav|ogg|opus|m4a|flac|aac)$/i.test(file.name)) return 'audio';
  return 'file';
}

// One card per file waiting to go out: a picture of it where the browser can draw one, its name and size,
// and buttons to hide it behind a spoiler or take it off again.
function pendingCard(item) {
  const file = item.file;
  const kind = pendingKind(file);
  const visual = kind === 'image' || kind === 'video';
  let thumb = icon(kind === 'audio' ? 'speaker' : 'clip');
  if (visual) {
    item.url = URL.createObjectURL(file);
    const fallback = thumb;
    thumb = kind === 'image' ? h('img', { src: item.url, alt: '' })
      : h('video', { src: item.url, preload: 'metadata', playsInline: true });
    if (kind === 'video') thumb.muted = true;
    thumb.addEventListener('error', () => thumb.replaceWith(fallback));   // a format this browser cannot draw
  }
  const size = h('span', { class: 'up-size' });
  const bar = h('span', { class: 'up-bar' });
  const hide = visual ? h('button', { class: 'ctl sm', type: 'button',
    onclick: () => { item.spoiler = !item.spoiler; renderPending(); } }) : null;
  const remove = h('button', { class: 'ctl sm', type: 'button', title: 'Remove', onclick: () => removePending(item) }, icon('x'));
  const card = h('div', { class: 'up-card ' + kind, title: file.name },
    h('div', { class: 'up-thumb' }, thumb, h('em', { class: 'chip-tag', text: 'Spoiler' })),
    h('span', { class: 'up-name', text: file.name }), size,
    h('div', { class: 'up-acts' }, hide, remove), bar);
  card.parts = { size, bar, hide };
  return card;
}

function removePending(item) {
  const at = pending.indexOf(item);
  if (at >= 0) pending.splice(at, 1);
  if (item.url) URL.revokeObjectURL(item.url);
  renderPending();
}

function renderPending() {
  const box = $('#pending');
  const cards = pending.map((item) => item.card || (item.card = pendingCard(item)));
  // Cards are only moved when the list itself changes, so a preview is not redrawn on every upload tick.
  if (cards.length !== box.children.length || cards.some((card, i) => box.children[i] !== card)) box.replaceChildren(...cards);
  for (const item of pending) {
    const busy = item.progress != null;
    const { size, bar, hide } = item.card.parts;
    item.card.classList.toggle('busy', busy);
    item.card.classList.toggle('spoiler', !!item.spoiler);
    size.textContent = busy ? `Sending ${Math.round(item.progress * 100)}%` : prettySize(item.file.size);
    bar.style.width = busy ? Math.round(item.progress * 100) + '%' : '0';
    if (hide) {
      hide.classList.toggle('on', !!item.spoiler);
      hide.title = item.spoiler ? 'Marked as a spoiler: click to undo' : 'Mark as a spoiler';
      hide.replaceChildren(icon('eye', item.spoiler));
    }
  }
}

function addFiles(files) {
  for (const file of files) {
    if (file.size > state.maxUploadMB * 1048576) toast(`${file.name} is larger than the ${state.maxUploadMB} MB limit.`);
    else if (pending.length >= 8) { toast('Up to 8 files per message.'); break; }
    else pending.push({ file, progress: null });
  }
  renderPending();
}

function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?name=' + encodeURIComponent(file.name || 'file'));
    xhr.setRequestHeader('x-token', state.token);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => { if (onProgress && event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 200) resolve(data); else reject(new Error(data.error || 'the upload failed'));
    };
    xhr.onerror = () => reject(new Error('the upload failed'));
    xhr.send(file);
  });
}

async function sendMessage() {
  const text = input.value.trim();
  if (sending || (!text && !pending.length)) return;
  if (!state.connected) { toast('Not connected to the server right now.'); return; }
  const view = { ...state.view };   // the upload may finish after the user has moved elsewhere
  const reply = state.replyTo && state.replyTo.key === convKey() ? state.replyTo.id : undefined;
  const attachments = [];
  input.value = '';
  autosize();
  typingPlace = null;   // the message itself clears the typing note for everyone
  lastTypingSent = 0;
  state.replyTo = null;
  renderReplyBar();
  closePopover();
  sending = true;
  try {
    for (const item of [...pending]) {
      item.progress = 0;
      renderPending();
      try {
        const sent = await upload(item.file, (p) => { item.progress = p; renderPending(); });
        attachments.push(item.spoiler ? { ...sent, spoiler: true } : sent);
      } catch (err) { toast(`${item.file.name}: ${err.message}`); }
      removePending(item);
    }
  } finally { sending = false; }
  if (!text && !attachments.length) return;
  send(view.type === 'dm' ? { type: 'dm-send', to: view.id, text, attachments, reply } : { type: 'chat', channel: view.id, text, attachments, reply });
}

$('#replyCancel').addEventListener('click', () => { state.replyTo = null; renderReplyBar(); input.focus(); });

$('#composer').addEventListener('submit', (event) => { event.preventDefault(); sendMessage(); });
/* ---------- the interface updates itself ---------- */

// The page notes which version of the interface it loaded (the server's "build"). When the server has a newer
// one, as it says when the page reconnects after a server restart, or when asked every ten minutes, the page
// reloads itself at a moment that disturbs nothing: not in a call, nothing typed, no dialog open. Until then
// a strip at the top offers to reload.
let pageBuild = null;
let reloadWanted = false;

function checkBuild(build) {
  if (!build) return;
  if (!pageBuild) { pageBuild = build; return; }
  if (build === pageBuild || reloadWanted) return;
  reloadWanted = true;
  reloadWhenQuiet();
}

const quietMoment = () => !rtc.channel && !state.call && !input.value.trim() && !state.editing && !pending.length
  && !document.querySelector('dialog[open]');

function reloadWhenQuiet() {
  if (quietMoment()) { location.reload(); return; }
  if (!$('#updateStrip')) {
    $('#banner').after(h('div', { class: 'banner update-strip', id: 'updateStrip' },
      'Umbryx has been updated. ', h('button', { class: 'btn slim', type: 'button', onclick: () => location.reload() }, 'Reload now')));
  }
  setTimeout(reloadWhenQuiet, 30000);
}

setInterval(() => {
  if (!state.connected) return;
  fetch('/api/info', { cache: 'no-store' }).then((r) => r.json()).then((info) => checkBuild(info.build)).catch(() => {});
}, 10 * 60000);

/* ---------- the server's name, picture and banner ---------- */

// Shown in the title strip (and, in the desktop app, in its column of servers), and the banner at the top of
// the channel list. Its admins get a button next to the name to change them.
function showServerLook(m) {
  // Someone not in the server (a guest) sees nothing of it: the server does not send its look to them, and older
  // servers that do are ignored here.
  if (state.guest) m = { spotifyClientId: m.spotifyClientId };
  state.info.serverName = state.guest ? 'Umbryx' : m.serverName || state.info.serverName;
  state.server = { name: state.info.serverName, icon: m.serverIcon || '', banner: m.serverBanner || '', spotifyClientId: m.spotifyClientId || '' };
  $('#serverName').textContent = state.server.name;
  // The browser tab keeps Umbryx's own logo (index.html) and name (updateTitle), never the server's.
  const banner = $('#serverBanner');
  banner.hidden = !state.server.banner;
  $('#serverHead').classList.toggle('has-banner', !!state.server.banner);
  banner.replaceChildren(...(state.server.banner ? [h('img', { src: state.server.banner, alt: '' })] : []));
  $('#serverEdit').hidden = !state.canManage;
  $('#reportsBtn').hidden = !state.canModerate;
  $('#serverPartner').hidden = !m.serverPartner;
  if (railShell && railShell.server) railShell.server({ icon: state.server.icon ? location.origin + state.server.icon : '', partner: !!m.serverPartner });
  updateTitle();
}

let serverDraft = null;
let serverOpened = null;   // the settings as they were when the dialog opened: only differences are sent

function openServerSettings() {
  if (!state.canManage || !state.server) return;
  serverDraft = { ...state.server };
  serverOpened = { ...state.server };
  $('#srvName').value = serverDraft.name;
  $('#srvSpotify').value = serverDraft.spotifyClientId;
  renderServerDraft();
  $('#srvInvites').hidden = !state.info.inviteOnly;
  if (state.info.inviteOnly) { renderInvites(); send({ type: 'invites' }); }
  renderBans();
  send({ type: 'bans' });
  $('#serverDlg').showModal();
}

// Invite codes: who they are for, how many people each can still let in and until when, and who joined with them.
function renderInvites() {
  const when = (ms) => (ms ? 'until ' + new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'no end date');
  const list = state.invites || [];
  $('#invList').replaceChildren(...(list.length ? list.map((x) => h('div', { class: 'invite-row' },
    h('code', { class: 'invite-code', text: x.code, title: inviteLink(x.code) }),
    h('span', { class: 'invite-meta', title: x.joined.length ? 'Joined with it: ' + x.joined.join(', ') : '',
      text: `${x.max ? `${x.uses} of ${x.max} used` : `${x.uses} used`} · ${when(x.expires)}${x.joined.length ? ' · ' + x.joined.join(', ') : ''}` }),
    h('button', { class: 'btn slim', type: 'button', title: 'Copy the invite link', onclick: () => copyInvite(x.code) }, 'Copy link'),
    h('button', { class: 'ctl sm', type: 'button', title: 'Delete this code', onclick: () => send({ type: 'invite-delete', code: x.code }) }, icon('x'))))
    : [h('div', { class: 'chan-empty', text: 'No invite codes yet.' })]));
}

// Who is banned: who banned them and when, and Unban.
function renderBans() {
  const list = state.bans || [];
  $('#srvBans').hidden = !state.canManage;
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
  $('#banList').replaceChildren(...(list.length ? list.map((b) => h('div', { class: 'invite-row' },
    h('b', { class: 'ban-name', text: b.name }),
    h('span', { class: 'invite-meta', text: [b.by ? `by ${b.by}` : '', day(b.at)].filter(Boolean).join(' · ') }),
    h('button', { class: 'btn slim', type: 'button', onclick: () => send({ type: 'unban', id: b.id }) }, 'Unban')))
    : [h('div', { class: 'chan-empty', text: 'Nobody is banned.' })]));
}

function copyInvite(code, made) {
  const link = inviteLink(code);
  const shown = link.replace(/^https:\/\//, '');
  const done = () => toast(`${made ? 'Invite link made and copied' : 'Invite link copied'}: ${shown}`);
  const manual = () => toast(`${made ? 'Invite link made' : 'Invite link'}: ${link}`, 8000);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, manual);
  else manual();
}

$('#invMake').addEventListener('click', () => send({ type: 'invite-create', uses: Number($('#invUses').value), days: Number($('#invDays').value) }));

function renderServerDraft() {
  const icon = $('#srvIcon');
  icon.replaceChildren(serverDraft.icon ? h('img', { src: serverDraft.icon, alt: '' }) : h('img', { src: '/icon.svg', alt: '' }));
  $('#srvBanner').replaceChildren(...(serverDraft.banner ? [h('img', { src: serverDraft.banner, alt: '' })] : []));
  $('#srvIconClear').hidden = !serverDraft.icon;
  $('#srvBannerClear').hidden = !serverDraft.banner;
}

async function pickServerImage(kind, file) {
  if (!file || !serverDraft) return;
  if (!/\.(png|apng|jpe?g|jfif|gif|webp|avif|bmp)$/i.test(file.name)) { toast('Use a PNG, JPG, JFIF, GIF, WebP or AVIF image.'); return; }
  if (file.size > 15 * 1048576) { toast('Server pictures can be up to 15 MB.'); return; }
  try {
    serverDraft[kind] = (await upload(file)).url;
    renderServerDraft();
  } catch (err) { toast(`${file.name}: ${err.message}`); }
}

$('#serverEdit').replaceChildren(icon('pencil'));
$('#reportsBtn').replaceChildren(icon('flag'));
$('#reportsBtn').addEventListener('click', () => {
  if (!state.canModerate) return;
  renderReports();
  send({ type: 'reports' });
  $('#reportsDlg').showModal();
});
$('#serverEdit').addEventListener('click', openServerSettings);
$('#srvIconBtn').addEventListener('click', () => $('#srvIconFile').click());
$('#srvBannerBtn').addEventListener('click', () => $('#srvBannerFile').click());
$('#srvIconFile').addEventListener('change', (event) => { pickServerImage('icon', event.target.files[0]); event.target.value = ''; });
$('#srvBannerFile').addEventListener('change', (event) => { pickServerImage('banner', event.target.files[0]); event.target.value = ''; });
$('#srvIconClear').addEventListener('click', () => { serverDraft.icon = ''; renderServerDraft(); });
$('#srvBannerClear').addEventListener('click', () => { serverDraft.banner = ''; renderServerDraft(); });
$('#serverForm').addEventListener('submit', (event) => {
  if (!event.submitter || event.submitter.value !== 'save' || !serverDraft) return;
  const name = $('#srvName').value.trim() || serverDraft.name;
  const update = {};
  if (name !== serverOpened.name) update.name = name;
  if (serverDraft.icon !== serverOpened.icon) update.icon = serverDraft.icon;
  if (serverDraft.banner !== serverOpened.banner) update.banner = serverDraft.banner;
  const spotifyClientId = $('#srvSpotify').value.trim().toLowerCase();
  if (spotifyClientId !== serverOpened.spotifyClientId) update.spotifyClientId = spotifyClientId;
  if (Object.keys(update).length) send({ type: 'server-update', ...update });
});

/* ---------- search ---------- */

// The box at the top right finds messages in every text channel and your own direct messages. from:name (or
// picking a person from the list that from: brings up) finds only theirs. Results open in a panel on the right,
// newest first, with how many each person wrote; clicking a person narrows the results to them, and clicking a
// message goes to it.
const search = { seq: 0, words: '', from: null, has: null, last: null };
// What a search can ask for besides words (has:image and so on, or the buttons under the box and in the results).
const SEARCH_HAS = { image: 'Images', video: 'Videos', file: 'Files', link: 'Links' };
const searchInput = $('#searchInput');
const searchList = h('div', { class: 'mention-list search-list', role: 'listbox', 'aria-label': 'People', hidden: true });
$('#searchBox').append(searchList);
let searchPick = { items: [], index: 0, start: -1 };

// "from:Abby has:image hello" -> { from: Abby's id, has: 'image', words: 'hello' }. A name with spaces is written
// from:"Abby Lee". Words match whole words; hel* finds words starting with hel.
function parseSearch(text) {
  let from = null;
  let has = null;
  const words = text.replace(/from:(?:"([^"]+)"|(\S+))/i, (_, quoted, plain) => {
    const user = userNamed(quoted || plain);
    if (user) from = user.id;
    return ' ';
  }).replace(/has:(image|video|file|link)s?\b/i, (_, kind) => { has = kind.toLowerCase(); return ' '; }).replace(/\s+/g, ' ').trim();
  return { from, has, words };
}

// from and has: undefined keeps what the box says (and, while results are open, the filter picked there).
function runSearch(from, has) {
  const parsed = parseSearch(searchInput.value);
  search.words = parsed.words;
  search.from = from === undefined ? parsed.from : from;
  search.has = has !== undefined ? has : parsed.has || ($('#results').hidden ? null : search.has);
  if (!state.searchHas) search.has = null;
  if (!search.words && !search.from && !search.has) { closeResults(); return; }
  search.seq++;
  send({ type: 'search', q: search.words, from: search.from, ...(search.has ? { has: search.has } : {}), seq: search.seq });
  $('#results').replaceChildren(h('div', { class: 'results-empty', text: 'Searching…' }));
  openResults();
}

function openResults() {
  $('#results').hidden = false;
  $('#app').classList.add('searching');
}

function closeResults() {
  $('#results').hidden = true;
  $('#app').classList.remove('searching');
  search.last = null;
}

function renderResults(m) {
  search.last = m;
  const panel = $('#results');
  const who = search.from ? state.users.get(search.from) : null;
  const what = [search.words ? `“${search.words}”` : '', who ? `from ${nick(who)}` : '',
    search.has ? `with ${SEARCH_HAS[search.has].toLowerCase()}` : ''].filter(Boolean).join(' ');
  const head = h('div', { class: 'results-head' },
    h('div', { class: 'results-title' }, h('b', { text: m.total === 1 ? '1 result' : `${m.total} results` }), h('span', { text: what })),
    h('button', { class: 'ctl', type: 'button', title: 'Close the search', onclick: () => { searchInput.value = ''; closeResults(); } }, icon('x')));
  // By person: everyone with matches, most first. One of them picked narrows the list to theirs.
  const people = Object.entries(m.authors || {}).sort((a, b) => b[1] - a[1]);
  const total = people.reduce((sum, [, n]) => sum + n, 0);
  const chip = (label, count, active, run, user) => h('button', { class: 'result-person' + (active ? ' active' : ''), type: 'button', onclick: run },
    user ? avatar(user, 'xs') : null, h('span', { class: 'result-person-name', text: label }), h('span', { class: 'result-count', text: String(count) }));
  const facets = people.length > 1 || search.from ? h('div', { class: 'result-people' },
    chip('Everyone', total, !search.from, () => runSearch(null, search.has)),
    people.map(([id, n]) => {
      const user = state.users.get(id) || { id, name: 'Someone' };
      return chip(nick(user), n, search.from === id, () => runSearch(search.from === id ? null : id, search.has), user);
    })) : null;
  // Only messages with a picture, a video, another file or a link (picking the one on again takes it off).
  const filters = state.searchHas ? h('div', { class: 'result-people result-has' },
    Object.entries(SEARCH_HAS).map(([kind, label]) => h('button', { class: 'result-person' + (search.has === kind ? ' active' : ''), type: 'button',
      onclick: () => runSearch(search.from, search.has === kind ? null : kind) }, h('span', { class: 'result-person-name', text: label })))) : null;
  const items = m.results.map((msg) => {
    const where = msg.dm ? { dm: msg.dm } : { channel: msg.channel };
    const place = msg.dm ? `@${(state.users.get(msg.dm) || { name: 'someone' }).name}` : `#${(channelById(msg.channel) || { name: 'channel' }).name}`;
    return h('button', { class: 'result', type: 'button', title: 'Go to the message', onclick: () => jumpToMessage(where, msg.id) },
      h('div', { class: 'result-place' }, h('span', { text: place }), h('time', { text: stamp(msg.ts) })),
      messageEl(msg, null, true));
  });
  const more = m.total > m.results.length ? h('div', { class: 'results-empty', text: `Showing the newest ${m.results.length}. Add words to narrow it down.` }) : null;
  panel.replaceChildren(head, filters, facets, h('div', { class: 'results-list' },
    items.length ? items : h('div', { class: 'results-empty', text: 'No messages match.' }), more));
}

function closeSearchList() {
  searchList.hidden = true;
  searchPick = { items: [], index: 0, start: -1 };
}

// The empty box, focused: buttons for messages with pictures, videos, files or links, and a word on from:.
function offerSearchFilters() {
  if (!state.me || !state.searchHas || searchInput.value.trim() || document.activeElement !== searchInput) return false;
  searchPick = { items: [], index: 0, start: -1 };
  searchList.replaceChildren(h('div', { class: 'search-list-head', text: 'Messages with' }),
    h('div', { class: 'search-has' }, Object.entries(SEARCH_HAS).map(([kind, label]) => h('button', { class: 'result-person', type: 'button',
      onmousedown: (event) => { event.preventDefault(); closeSearchList(); runSearch(undefined, kind); } }, h('span', { class: 'result-person-name', text: label })))),
    h('div', { class: 'search-tip', text: 'Type from: to pick a person. Words match whole words; end one with * to match its start.' }));
  searchList.hidden = false;
  return true;
}

function suggestSearchPeople() {
  const before = searchInput.value.slice(0, searchInput.selectionStart);
  const hit = before.match(/(^|\s)from:("?)([^"\s]*)$/i);
  if (!hit || !state.me) { if (!offerSearchFilters()) closeSearchList(); return; }
  const query = hit[3].toLowerCase();
  const items = [...state.users.values()].filter((u) => !u.deleted && u.name.toLowerCase().includes(query))
    .sort((a, b) => (b.name.toLowerCase().startsWith(query) ? 1 : 0) - (a.name.toLowerCase().startsWith(query) ? 1 : 0) || a.name.localeCompare(b.name)).slice(0, 8);
  if (!items.length) { closeSearchList(); return; }
  searchPick = { items, index: Math.min(searchPick.index, items.length - 1), start: before.length - hit[3].length - hit[2].length - 5 };
  searchList.replaceChildren(h('div', { class: 'search-list-head', text: 'From' }), ...items.map((u, i) => {
    const name = h('span', { class: 'mention-name', text: nick(u) });
    name.style.color = nameColor(u);
    return h('button', { class: 'mention-item' + (i === searchPick.index ? ' active' : ''), type: 'button',
      onmousedown: (event) => { event.preventDefault(); searchPick.index = i; pickSearchPerson(); } }, presence(u, 'xs'), name,
      u.display ? h('span', { class: 'mention-user', text: u.name }) : null);
  }));
  searchList.hidden = false;
}

function pickSearchPerson() {
  const user = searchPick.items[searchPick.index];
  if (!user) return;
  const token = /\s/.test(user.name) ? `from:"${user.name}" ` : `from:${user.name} `;
  const value = searchInput.value;
  searchInput.value = value.slice(0, searchPick.start) + token + value.slice(searchInput.selectionStart);
  const caret = searchPick.start + token.length;
  searchInput.setSelectionRange(caret, caret);
  closeSearchList();
}

searchInput.addEventListener('input', suggestSearchPeople);
searchInput.addEventListener('focus', offerSearchFilters);
searchInput.addEventListener('blur', () => setTimeout(closeSearchList, 120));
searchInput.addEventListener('keydown', (event) => {
  if (!searchList.hidden && searchPick.items.length) {
    const count = searchPick.items.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      searchPick.index = (searchPick.index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
      suggestSearchPeople();
      return;
    }
    if (event.key === 'Tab' || event.key === 'Enter') { event.preventDefault(); pickSearchPerson(); return; }
    if (event.key === 'Escape') { event.preventDefault(); closeSearchList(); return; }
  }
  if (event.key === 'Enter') { event.preventDefault(); runSearch(); }
  if (event.key === 'Escape') { searchInput.value = ''; closeResults(); searchInput.blur(); }
});
// A people list or a rename changes how results read: draw them again.
function refreshResults() { if (search.last && !$('#results').hidden) renderResults(search.last); }

/* typing @ suggests people: arrow keys or the mouse to choose, Enter or Tab to put the name in */

const mentionList = h('div', { class: 'mention-list', role: 'listbox', 'aria-label': 'People to mention', hidden: true });
$('#composer').append(mentionList);
let mentionPick = { start: -1, items: [], index: 0 };

function closeMentions() {
  mentionList.hidden = true;
  mentionPick = { start: -1, items: [], index: 0 };
}

function suggestMentions() {
  const before = input.value.slice(0, input.selectionStart);
  const hit = input.selectionStart === input.selectionEnd && before.match(/(^|\s)@([^@\n]{0,24})$/);
  if (!hit || !state.me) { closeMentions(); return; }
  const query = hit[2].toLowerCase();
  // In a direct message only its two people can be mentioned (you and them); in a channel, the server's members
  // (not people outside it, who can't see channels).
  const people = state.view.type === 'dm'
    ? [self(), state.users.get(state.view.id)].filter((u) => u && !u.deleted)
    : [...state.users.values()].filter((u) => u.id !== state.me.id && !u.deleted && !u.guest);
  const names = (u) => [u.name, u.display || ''].map((n) => n.toLowerCase());
  const starts = people.filter((u) => names(u).some((n) => n && n.startsWith(query)));
  const contains = query ? people.filter((u) => !starts.includes(u) && names(u).some((n) => n && n.includes(query))) : [];
  const rank = (a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.name.localeCompare(b.name);
  const items = [...starts.sort(rank), ...contains.sort(rank)].slice(0, 8);
  if (!items.length) { closeMentions(); return; }
  mentionPick = { start: before.length - hit[2].length - 1, items, index: Math.min(mentionPick.index, items.length - 1) };
  drawMentions();
}

function drawMentions() {
  mentionList.replaceChildren(...mentionPick.items.map((u, i) => {
    const name = h('span', { class: 'mention-name', text: nick(u) });
    name.style.color = nameColor(u);
    return h('button', { class: 'mention-item' + (i === mentionPick.index ? ' active' : ''), type: 'button', role: 'option',
      onmousedown: (event) => { event.preventDefault(); mentionPick.index = i; pickMention(); } },
      presence(u, 'xs'), name, u.display ? h('span', { class: 'mention-user', text: u.name }) : null, h('span', { class: 'mention-status', text: statusOf(u) }));
  }));
  mentionList.hidden = false;
}

function pickMention() {
  const user = mentionPick.items[mentionPick.index];
  if (!user || mentionPick.start < 0) return;
  const value = input.value;
  const text = '@' + user.name + ' ';
  input.value = value.slice(0, mentionPick.start) + text + value.slice(input.selectionStart);
  const caret = mentionPick.start + text.length;
  input.setSelectionRange(caret, caret);
  closeMentions();
  autosize();
  input.focus();
}

// The keys the list uses while it is open. True when the key was the list's, not the message box's.
function mentionKeys(event) {
  if (mentionList.hidden) return false;
  const count = mentionPick.items.length;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    mentionPick.index = (mentionPick.index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
    drawMentions();
  } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
    pickMention();
  } else if (event.key === 'Escape') {
    closeMentions();
  } else return false;
  event.preventDefault();
  return true;
}

input.addEventListener('blur', () => setTimeout(closeMentions, 120));
input.addEventListener('click', suggestMentions);
input.addEventListener('keyup', (event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') suggestMentions(); });

input.addEventListener('keydown', (event) => {
  if (mentionKeys(event)) return;
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); }
  if (event.key === 'Escape' && state.replyTo) { state.replyTo = null; renderReplyBar(); }
  // Up arrow in an empty box edits the last message you sent here.
  if (event.key === 'ArrowUp' && !input.value && isConv()) {
    const cache = state.cache.get(convKey());
    const last = cache && [...cache.list].reverse().find((x) => x.uid === state.me.id);
    if (last) { event.preventDefault(); startEdit(last); }
  }
});
input.addEventListener('input', () => {
  autosize();
  suggestMentions();
  if (!input.value.trim()) { stopTyping(); return; }
  if (Date.now() - lastTypingSent < 2500) return;
  lastTypingSent = Date.now();
  typingPlace = state.view.type === 'dm' ? { dm: state.view.id } : { channel: state.view.id };
  send({ type: 'typing', ...typingPlace });
});
input.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData ? event.clipboardData.files : [])];
  if (files.length) { event.preventDefault(); addFiles(files); }
});
$('#file').addEventListener('change', (event) => { addFiles(event.target.files); event.target.value = ''; });
$('#textView').addEventListener('dragover', (event) => event.preventDefault());
$('#textView').addEventListener('drop', (event) => { event.preventDefault(); addFiles(event.dataTransfer.files); });

/* ---------- emoji picker and favourites (the panel above the message box) ---------- */

let popoverKind = null;      // 'emoji', 'favorites' or null
let emojiGroups = null;      // Unicode emoji by category, loaded the first time the picker opens
let emojiTab = 'Smileys';
let emojiQuery = '';
const recentEmoji = store.get('recentEmoji', []);   // most recently used first; custom ones as ":name:"

function closePopover() {
  popoverKind = null;
  $('#popover').hidden = true;
  $('#popover').replaceChildren();
}

function togglePopover(kind, draw) {
  if (popoverKind === kind) { closePopover(); return; }
  popoverKind = kind;
  $('#popover').hidden = false;
  draw();
}

document.addEventListener('pointerdown', (event) => {
  if (popoverKind && !event.target.closest('#popover') && !event.target.closest('[data-act="emoji"], [data-act="favorites"]')) closePopover();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if ($('#lightbox')) closeLightbox(); else if (popoverKind) closePopover();
});

function insertAtCursor(text) {
  const start = input.selectionStart == null ? input.value.length : input.selectionStart;
  const end = input.selectionEnd == null ? start : input.selectionEnd;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.setSelectionRange(start + text.length, start + text.length);
  input.focus();
  autosize();
}

// Loads the emoji list and drops anything this device cannot draw (it would show as an empty box, or as loose pieces).
// Measuring each one's width is enough, and takes milliseconds (drawing every one took several seconds): an emoji the
// device has is one glyph about as wide as a known emoji; one it lacks is a missing-character box, and a sequence it
// cannot join comes out as several glyphs side by side. Only flags are drawn, since Windows writes them as two
// letters about as wide as an emoji, which only their lack of colour gives away. Loaded once, shortly after signing
// in (see the welcome), so the picker opens straight away.
let emojiLoading = null;
function loadEmoji() {
  emojiLoading = emojiLoading || (async () => {
    const data = await (await fetch('/emoji.json')).json();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 28;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.font = '20px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
    ctx.textBaseline = 'top';
    const one = ctx.measureText('\u{1F600}').width;   // a grinning face: every emoji font has it
    const box = ctx.measureText('\u{10FFFF}').width;  // how this device writes a character it does not have
    const drawable = (text) => {
      const width = ctx.measureText(text).width;
      return Math.abs(width - one) < one * 0.25 && Math.abs(width - box) > 0.5;
    };
    const coloured = (text) => {
      ctx.clearRect(0, 0, 28, 28);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, 1, 3);
      const pixels = ctx.getImageData(0, 0, 28, 28).data;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] > 60 && (Math.abs(pixels[i] - pixels[i + 1]) > 30 || Math.abs(pixels[i + 1] - pixels[i + 2]) > 30)) return true;
      }
      return false;
    };
    emojiGroups = data.groups.map((group) => ({
      name: group.name,
      emoji: group.emoji.filter(([char]) => drawable(char) && (group.name !== 'Flags' || coloured(char))),
    })).filter((group) => group.emoji.length);
    return emojiGroups;
  })().catch((err) => { emojiLoading = null; throw err; });
  return emojiLoading;
}

function useEmoji(token) {
  insertAtCursor(token.startsWith(':') ? token + ' ' : token);
  const at = recentEmoji.indexOf(token);
  if (at >= 0) recentEmoji.splice(at, 1);
  recentEmoji.unshift(token);
  recentEmoji.length = Math.min(recentEmoji.length, 32);
  store.set('recentEmoji', recentEmoji);
}

function emojiButton(token, name, foot) {
  const custom = token.startsWith(':');
  const button = h('button', { class: 'emoji-btn', type: 'button', title: name, onclick: () => useEmoji(token) },
    custom ? h('img', { src: state.emojis.get(token.slice(1, -1)), alt: token }) : token);
  button.addEventListener('mouseenter', () => { foot.textContent = name; });
  return button;
}

async function drawEmojiPicker() {
  const root = $('#popover');
  if (!emojiGroups) {
    root.replaceChildren(h('div', { class: 'empty', text: 'Loading emoji…' }));
    try { await loadEmoji(); } catch { root.replaceChildren(h('div', { class: 'empty', text: 'The emoji list could not be loaded.' })); return; }
    if (popoverKind !== 'emoji') return;
  }
  const names = new Map();
  for (const group of emojiGroups) for (const [char, name] of group.emoji) names.set(char, name);
  const foot = h('span', { class: 'picker-foot-name', text: 'Pick an emoji' });
  const grid = h('div', { class: 'picker-grid' });
  const custom = [...state.emojis.keys()].sort();

  const tabs = [
    { id: 'Recent', label: icon('clock') },
    { id: 'Server', label: icon('star') },
    ...emojiGroups.map((group) => ({ id: group.name, label: group.emoji[0][0] })),
  ];
  const search = h('input', { class: 'picker-search', type: 'search', placeholder: 'Search emoji', value: emojiQuery });
  const tabBar = h('div', { class: 'picker-tabs' }, tabs.map((tab) => h('button', {
    class: 'picker-tab' + (tab.id === emojiTab && !emojiQuery ? ' active' : ''), type: 'button',
    title: tab.id === 'Server' ? 'This server\'s emoji' : tab.id,
    onclick: () => { emojiTab = tab.id; emojiQuery = ''; drawEmojiPicker(); },
  }, tab.label)));

  const fill = () => {
    grid.replaceChildren();
    const section = (title, buttons, emptyText) => {
      grid.append(h('div', { class: 'picker-head', text: title }));
      if (buttons.length) grid.append(...buttons); else grid.append(h('div', { class: 'picker-empty', text: emptyText }));
    };
    const query = emojiQuery.trim().toLowerCase();
    if (query) {
      const found = custom.filter((name) => name.includes(query)).map((name) => emojiButton(`:${name}:`, `:${name}:`, foot));
      for (const group of emojiGroups) {
        for (const [char, name] of group.emoji) if (name.includes(query) && found.length < 240) found.push(emojiButton(char, name, foot));
      }
      section('Results', found, 'Nothing matches that.');
    } else if (emojiTab === 'Recent') {
      const usable = recentEmoji.filter((token) => (token.startsWith(':') ? state.emojis.has(token.slice(1, -1)) : names.has(token)));
      section('Recently used', usable.map((token) => emojiButton(token, token.startsWith(':') ? token : names.get(token), foot)),
        'Emoji you use will show up here.');
    } else if (emojiTab === 'Server') {
      section('This server\'s emoji', custom.map((name) => {
        const button = emojiButton(`:${name}:`, `:${name}:`, foot);
        button.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          if (confirm(`Remove the emoji :${name}: from this server for everyone?`)) send({ type: 'emoji-remove', name });
        });
        return button;
      }), 'No custom emoji yet. Add one with the button below.');
    } else {
      const group = emojiGroups.find((g) => g.name === emojiTab) || emojiGroups[0];
      section(group.name, group.emoji.map(([char, name]) => emojiButton(char, name, foot)), '');
    }
    grid.scrollTop = 0;
  };
  search.addEventListener('input', () => {
    emojiQuery = search.value;
    for (const tab of tabBar.children) tab.classList.toggle('active', false);
    fill();
  });
  fill();
  root.replaceChildren(h('div', { class: 'picker' }, search, tabBar, grid,
    h('div', { class: 'picker-foot' }, foot, h('span', { class: 'spacer' }),
      emojiTab === 'Server' && !emojiQuery ? h('span', { class: 'hint', text: 'Right-click one to remove it' }) : null,
      state.guest ? h('span', { class: 'hint', text: 'Custom emoji are added by members of the server.' })
        : h('button', { class: 'btn slim', type: 'button', onclick: openEmojiDialog }, 'Add emoji'))));
  if (!emojiQuery) search.focus();
}

function openEmojiDialog() {
  $('#emojiFile').value = '';
  $('#emojiName').value = '';
  $('#emojiDlg').showModal();
}

// Suggest a name from the file name, so most of the time there is nothing to type.
$('#emojiFile').addEventListener('change', () => {
  const file = $('#emojiFile').files[0];
  if (file && !$('#emojiName').value) {
    $('#emojiName').value = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  }
});

$('#emojiForm').addEventListener('submit', async (event) => {
  if (event.submitter && event.submitter.value !== 'add') return;
  const file = $('#emojiFile').files[0];
  const name = $('#emojiName').value.trim().toLowerCase();
  if (!file || !name) return;
  if (file.size > 2 * 1048576) { toast('Emoji pictures can be up to 2 MB.'); return; }
  try {
    send({ type: 'emoji-add', name, url: (await upload(file)).url });
    emojiTab = 'Server';
  } catch (err) { toast(`${file.name}: ${err.message}`); }
});

function drawFavorites() {
  const tiles = state.favorites.map((f) => {
    const preview = f.kind === 'video'
      ? h('video', { src: f.url, preload: 'metadata', muted: true, playsInline: true })
      : h('img', { src: f.url, alt: f.name, loading: 'lazy' });
    return h('div', { class: 'fav-tile' },
      h('button', { class: 'fav-send', type: 'button', title: `Send ${f.name}`, onclick: () => {
        if (!isConv()) return;
        const attachments = [{ url: f.url, name: f.name }];
        send(state.view.type === 'dm' ? { type: 'dm-send', to: state.view.id, text: '', attachments } : { type: 'chat', channel: state.view.id, text: '', attachments });
        closePopover();
      } }, preview),
      h('button', { class: 'ctl sm fav on', type: 'button', title: 'Remove from favorites',
        onclick: () => send({ type: 'favorite', url: f.url, name: f.name, on: false }) }, icon('star')));
  });
  $('#popover').replaceChildren(h('div', { class: 'picker' },
    h('div', { class: 'picker-head', text: 'Favorites' }),
    tiles.length ? h('div', { class: 'fav-grid' }, tiles)
      : h('div', { class: 'empty', text: 'Nothing here yet. Hover a picture, GIF or video in chat and click the star to keep it here.' })));
}

/* ---------- profile card ---------- */

function closeCard() {
  const card = $('#card');
  if (card) card.remove();
}

// A name in a bubble above what the pointer is on, a pointed arrow at its bottom pointing down at it (badges; anything
// with data-tip), and under the name why it was given (data-tip-about). Same look as the column's bubbles; kept inside
// the window, the arrow still on the badge; below it instead, arrow at the top, when there is no room above or it
// asks for that (data-tip-place="below": the partner check beside a server's name).
const tipAbove = h('div', { class: 'tip-above', role: 'tooltip', hidden: true });
document.body.append(tipAbove);
document.addEventListener('mouseover', (event) => {
  const el = event.target instanceof Element ? event.target.closest('[data-tip]') : null;
  if (!el || !el.dataset.tip) { tipAbove.hidden = true; return; }
  const box = el.getBoundingClientRect();
  const middle = box.left + box.width / 2;
  tipAbove.replaceChildren(h('b', { text: el.dataset.tip }));
  if (el.dataset.tipAbout) tipAbove.append(h('span', { text: el.dataset.tipAbout }));
  tipAbove.hidden = false;
  const half = tipAbove.offsetWidth / 2;
  const left = Math.max(half + 8, Math.min(innerWidth - half - 8, middle));
  const below = el.dataset.tipPlace === 'below' || box.top - 9 - tipAbove.offsetHeight < 4;
  tipAbove.classList.toggle('below', below);
  tipAbove.style.left = Math.round(left) + 'px';
  tipAbove.style.top = Math.round(below ? box.bottom + 9 : box.top - 9) + 'px';
  tipAbove.style.setProperty('--arrow', Math.round(middle - left + half) + 'px');
});
for (const kind of ['scroll', 'pointerdown']) document.addEventListener(kind, () => { tipAbove.hidden = true; }, true);
window.addEventListener('blur', () => { tipAbove.hidden = true; });

// What you can do with someone: on their profile card, and in the menu a right-click on their name opens.
function personActions(user) {
  const acts = [];
  const add = (label, run, cls) => acts.push({ label, run, cls });
  if (!user || !user.id || user.deleted) return acts;
  if (user.id === state.me.id) { add('Edit profile', openSettings); return acts; }
  if (reachable(user)) {
    add('Message', () => openDM(user.id), 'primary');
    if (isFriend(user)) add('Call', () => startCall(user.id));
  }
  if (!isBlocked(user.id)) add(...friendAction(user));
  if (state.nicknamesOn && state.friends.friends.includes(user.id)) add(state.nicknames.has(user.id) ? 'Change nickname' : 'Give a nickname', () => openNickname(user));
  if (user.guest && state.canManage) {
    add('Let into server', () => {
      if (confirm(`Let ${nick(user)} into the server? They will see its channels and members, and everyone will see them.`)) send({ type: 'admit', id: user.id });
    });
  }
  // Anyone: report them to the admins, block them (or unblock).
  add('Report', () => openReport(user), 'danger');
  if (isBlocked(user.id)) add('Unblock', () => unblockPerson(user));
  else add('Block', () => blockPerson(user), 'danger');
  // Admins: mute or deafen someone in voice, remove (kick) or ban them. The server refuses for admins and
  // canDeleteStaff accounts.
  if (state.canManage && !user.guest) {
    add(user.serverMuted ? 'Remove server mute' : 'Server mute', () => send({ type: 'server-mute', id: user.id, on: !user.serverMuted }));
    add(user.serverDeafened ? 'Remove server deafen' : 'Server deafen', () => send({ type: 'server-deafen', id: user.id, on: !user.serverDeafened }));
  }
  if (state.canManage && !user.guest) {
    add('Kick from server', () => {
      if (confirm(`Kick ${nick(user)} from the server? They keep their account and their direct messages with friends, but lose the channels until someone gives them a new invite code.`)) {
        send({ type: 'kick', id: user.id });
      }
    }, 'danger');
  }
  if (state.canManage && (state.bans || []).some((b) => b.id === user.id)) {
    add('Unban', () => send({ type: 'unban', id: user.id }));
  } else if (state.canManage) {
    add('Ban from server', () => {
      if (confirm(`Ban ${nick(user)} from the server? They lose the channels, and no invite code lets them back in until an admin unbans them. They keep their account and their direct messages with friends.`)) {
        send({ type: 'ban', id: user.id });
      }
    }, 'danger');
  }
  // Umbryx Staff can delete anyone's account but Staff's; those the server names (canDeleteStaff), anyone's.
  if (state.canDelete === 'all' || (state.canDelete === 'members' && !badgeList(user).includes('staff'))) {
    add('Delete account', () => {
      if (confirm(`Delete ${nick(user)}'s account? This can't be undone: their messages stay, shown as Deleted user, and everything else of theirs is removed.`)) {
        send({ type: 'account-delete', id: user.id });
      }
    }, 'danger');
  }
  return acts;
}

// Right-clicking someone's name or picture (anything marked data-person) opens a small menu: their profile, then what
// their card offers. Any click elsewhere, Escape, scrolling or leaving the window closes it.
let personMenu = null;
function closePersonMenu() {
  if (personMenu) { personMenu.remove(); personMenu = null; }
}
document.addEventListener('contextmenu', (event) => {
  const el = event.target instanceof Element ? event.target.closest('[data-person]') : null;
  const user = el && state.me ? state.users.get(el.dataset.person) : null;
  if (!user) return;
  event.preventDefault();
  closePersonMenu();
  closeCard();
  const item = (label, run, cls) => h('button', { class: 'pm-item' + (cls === 'danger' ? ' danger' : ''), type: 'button', role: 'menuitem',
    onclick: () => { closePersonMenu(); run(); } }, label);
  const acts = personActions(user);
  const risky = acts.filter((a) => a.cls === 'danger');   // last, under a line
  personMenu = h('div', { class: 'person-menu', role: 'menu', 'aria-label': nick(user) },
    h('div', { class: 'pm-head', text: nick(user) }),
    item('Profile', () => openCard(user, el)),
    ...acts.filter((a) => a.cls !== 'danger').map((a) => item(a.label, a.run, a.cls)),
    item('Copy username', () => {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(user.name).then(() => toast('Username copied.'), () => {});
    }),
    ...(risky.length ? [h('div', { class: 'pm-sep' }), ...risky.map((a) => item(a.label, a.run, a.cls))] : []));
  document.body.append(personMenu);
  const box = personMenu.getBoundingClientRect();
  personMenu.style.left = Math.max(8, Math.min(event.clientX, innerWidth - box.width - 8)) + 'px';
  personMenu.style.top = Math.max(8, Math.min(event.clientY, innerHeight - box.height - 8)) + 'px';
});
// Right-clicking a text channel: which of its messages notify you (kept on your account, for all your devices and
// your phone).
document.addEventListener('contextmenu', (event) => {
  const el = event.target instanceof Element ? event.target.closest('[data-channel-menu]') : null;
  const ch = el && state.me && !state.guest ? channelById(el.dataset.channelMenu) : null;
  if (!ch) return;
  event.preventDefault();
  closePersonMenu();
  const now = (state.channelNotify || {})[ch.id] || '';
  const choose = (level) => { closePersonMenu(); send({ type: 'channel-notify', channel: ch.id, level }); };
  const item = (level, label) => h('button', { class: 'pm-item' + (now === level ? ' pm-on' : ''), type: 'button', role: 'menuitemradio',
    'aria-checked': String(now === level), onclick: () => choose(level) }, label);
  personMenu = h('div', { class: 'person-menu', role: 'menu', 'aria-label': `#${ch.name} notifications` },
    h('div', { class: 'pm-head', text: `#${ch.name} · Notifications` }),
    item('all', 'All messages'), item('mentions', 'Only @mentions'), item('none', 'Nothing'),
    ...(now ? [h('div', { class: 'pm-sep' }), item('default', 'Use my default')] : []));
  document.body.append(personMenu);
  const box = personMenu.getBoundingClientRect();
  personMenu.style.left = Math.max(8, Math.min(event.clientX, innerWidth - box.width - 8)) + 'px';
  personMenu.style.top = Math.max(8, Math.min(event.clientY, innerHeight - box.height - 8)) + 'px';
});
// Umbryx has its own menus: the browser's right-click menu only where it helps, in text boxes (paste, spelling) and
// on text you selected (copy).
document.addEventListener('contextmenu', (event) => {
  if (event.defaultPrevented) return;
  const el = event.target instanceof Element ? event.target : null;
  if (el && el.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
  const selected = window.getSelection();
  if (selected && !selected.isCollapsed && String(selected).trim()) return;
  event.preventDefault();
});
document.addEventListener('pointerdown', (event) => { if (personMenu && !personMenu.contains(event.target)) closePersonMenu(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePersonMenu(); });
document.addEventListener('scroll', closePersonMenu, true);
window.addEventListener('blur', closePersonMenu);

// A friend's nickname: only you see it (see nick), on all your devices.
let nicknaming = null;
function openNickname(user) {
  nicknaming = user;
  $('#nickTitle').textContent = `Nickname for ${user.name}`;
  $('#nickInput').value = state.nicknames.get(user.id) || '';
  $('#nickInput').placeholder = user.display || user.name;
  $('#nickClear').hidden = !state.nicknames.has(user.id);
  $('#nickDlg').showModal();
  $('#nickInput').select();
}
$('#nickForm').addEventListener('submit', (event) => {
  if (!event.submitter || event.submitter.value !== 'save' || !nicknaming) return;
  event.preventDefault();   // closes once the server has it (handlers.nicknames)
  send({ type: 'nickname', id: nicknaming.id, nickname: $('#nickInput').value.trim() });
});
$('#nickClear').addEventListener('click', () => { if (nicknaming) send({ type: 'nickname', id: nicknaming.id, nickname: '' }); });

function friendAction(user) {
  const f = state.friends;
  if (f.friends.includes(user.id)) return ['Remove friend', () => { if (confirm(`Remove ${nick(user)} from your friends?`)) send({ type: 'friend-remove', id: user.id }); }];
  if (f.incoming.includes(user.id)) return ['Accept friend request', () => send({ type: 'friend-accept', id: user.id })];
  if (f.outgoing.includes(user.id)) return ['Cancel friend request', () => send({ type: 'friend-remove', id: user.id })];
  return ['Add friend', () => send({ type: 'friend-add', id: user.id })];
}

// On your own card: switch between Online and Do not disturb (no message, friend-request or call sounds).
function statusPicker(me) {
  const option = (value, label) => h('button', {
    class: 'seg-btn' + ((me.status || 'online') === value ? ' active' : ''), type: 'button',
    onclick: () => { send({ type: 'status', value }); closeCard(); },
  }, h('span', { class: 'seg-dot' + (value === 'dnd' ? ' dnd' : '') }), label);
  return [h('div', { class: 'card-h', text: 'Status' }),
    h('div', { class: 'seg' }, option('online', 'Online'), option('dnd', 'Do not disturb')),
    h('button', { class: 'btn slim', type: 'button', onclick: () => { closeCard(); openNoteDialog(); } },
      icon('chat'), noteOf(me) ? 'Change custom status' : 'Set a custom status')];
}

/* custom status: a line of text under your name that can clear itself after a while */

const NOTE_SPANS = [[1440, '24 hours'], [240, '4 hours'], [60, '1 hour'], [30, '30 minutes'], [0, "Don't clear"]];

// "4 hours (4:16 AM)", or "24 hours (tomorrow at 12:16 AM)" when that lands on another day.
function noteSpanLabel(minutes, label) {
  if (!minutes) return label;
  const end = Date.now() + minutes * 60000;
  const when = timeFormat.format(end);
  return `${label} (${dayKey(end) === dayKey(Date.now()) ? when : 'tomorrow at ' + when})`;
}

function openNoteDialog() {
  const me = self();
  const current = noteOf(me);
  const picked = store.get('noteSpan', 1440);
  $('#noteText').value = current;
  $('#noteSpan').replaceChildren(...NOTE_SPANS.map(([minutes, label]) =>
    h('option', { value: String(minutes), text: noteSpanLabel(minutes, label), selected: minutes === picked })));
  $('#noteClear').hidden = !current;
  $('#noteDlg').showModal();
  $('#noteText').select();
}

$('#noteForm').addEventListener('submit', (event) => {
  const action = event.submitter ? event.submitter.value : 'save';
  if (action === 'clear') { send({ type: 'note', text: '' }); return; }
  if (action !== 'save') return;
  const minutes = +$('#noteSpan').value;
  store.set('noteSpan', minutes);
  send({ type: 'note', text: $('#noteText').value.trim(), minutes });
});

function openCard(who, anchor) {
  closeCard();
  const user = (who.id && state.users.get(who.id)) || who;
  const known = !!user.id;
  const mine = known && user.id === state.me.id;
  const act = (label, run, cls) => h('button', { class: 'btn slim' + (cls ? ' ' + cls : ''), type: 'button', onclick: () => { closeCard(); run(); } }, label);
  const acts = known ? personActions(user).map((a) => act(a.label, a.run, a.cls)) : [];
  const name = h('div', { class: 'card-name', text: nick(user) });
  if (known) name.style.color = nameColor(user);
  const note = known ? noteOf(user) : '';
  const card = h('div', { class: 'card', id: 'card', dataset: { user: known ? user.id : '' } },
    bannerEl(user, 'card-banner'),
    h('div', { class: 'card-avatar' }, avatar(user, 'xl')),
    h('div', { class: 'card-body' },
      name,
      nick(user) !== user.name ? h('div', { class: 'card-username', text: user.name }) : null,
      user.guest ? h('span', { class: 'card-guest', title: 'Signed in without an account. Only their friends see them.', text: 'Guest' }) : null,
      badgeList(user).length ? h('div', { class: 'card-badges' }, badgeList(user).map((b) => {
        // Not clickable: hovering one shows its name and why it was given (data-tip, see tipAbove).
        const chip = h('span', { class: 'card-badge', role: 'img', 'aria-label': `${BADGES[b].label}: ${BADGES[b].about}`,
          dataset: { tip: BADGES[b].label, tipAbout: BADGES[b].about } }, icon(BADGES[b].icon));
        chip.style.setProperty('--badge', BADGES[b].color);
        return chip;
      })) : null,
      h('div', { class: 'card-status', text: known ? statusOf(user) : 'No longer on this server' }),
      note ? h('div', { class: 'card-note' }, icon('chat'), h('span', { text: note })) : null,
      known ? h('div', { class: 'card-activities' }, activityBlocks(user)) : null,
      user.about ? [h('div', { class: 'card-h', text: 'Bio' }), h('div', { class: 'card-about' }, linkText(user.about))] : null,
      mine ? statusPicker(user) : null,
      acts.length ? h('div', { class: 'card-acts' }, acts) : null));
  document.body.append(card);
  const rect = anchor.getBoundingClientRect();
  const width = card.offsetWidth;
  let left = rect.right + 10;
  if (left + width > innerWidth - 8) left = rect.left - width - 10;
  if (left < 8) left = Math.max(8, Math.min(innerWidth - width - 8, rect.left));
  card.style.left = left + 'px';
  card.style.top = Math.max(8 + $('#titlebar').offsetHeight, Math.min(innerHeight - card.offsetHeight - 8, rect.top - 24)) + 'px';
}

// A song changed or a game started while someone's card is open: its activity part follows.
function refreshCardActivities(id) {
  const card = $('#card');
  const box = card && card.dataset.user === id ? $('.card-activities', card) : null;
  if (box) box.replaceChildren(...activityBlocks(state.users.get(id)));
}

document.addEventListener('pointerdown', (event) => {
  const card = $('#card');
  if (card && !card.contains(event.target)) closeCard();
}, true);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeCard(); });

/* ---------- friends ---------- */

function personRow(user, acts) {
  const doing = activityLine(user);
  const nickname = state.nicknames && state.nicknames.get(user.id);
  const who = h('button', { class: 'who', type: 'button', dataset: { person: user.id }, onclick: () => openCard(user, who) },
    h('span', { class: 'member-line' }, nickname ? h('b', {}, nickname, h('span', { class: 'nick-username', text: ` (${user.name})` })) : h('b', { text: nick(user) }), devicesEl(user)), doing ? h('small', { class: 'act-line' }, `${doing.verb} `, h('b', { text: doing.name })) : h('small', { text: statusOf(user) }));
  return h('div', { class: 'person-row', dataset: { person: user.id } }, presence(user), who, h('div', { class: 'acts' }, acts));
}

function renderFriends() {
  const f = state.friends;
  const root = $('#friendLists');
  // The Search friends box: by username, display name or the nickname you gave them.
  const query = $('#friendSearch').value.trim().toLowerCase();
  const matches = (u) => !query || [u.name, u.display, state.nicknames && state.nicknames.get(u.id)].some((s) => s && s.toLowerCase().includes(query));
  const people = (ids) => ids.map((id) => state.users.get(id)).filter((u) => u && matches(u));
  const button = (label, run, cls) => h('button', { class: 'btn slim' + (cls ? ' ' + cls : ''), type: 'button', onclick: run }, label);
  const drop = (id) => send({ type: 'friend-remove', id });
  root.replaceChildren();
  const section = (label, list, acts) => {
    if (!list.length) return;
    root.append(h('div', { class: 'list-head', text: `${label} · ${list.length}` }), ...list.map((u) => personRow(u, acts(u))));
  };
  section('Requests for you', people(f.incoming), (u) => [
    button('Accept', () => send({ type: 'friend-accept', id: u.id }), 'primary'),
    button('Decline', () => drop(u.id)),
  ]);
  section('Requests you sent', people(f.outgoing), (u) => [button('Cancel', () => drop(u.id))]);
  const friends = people(f.friends).sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
  section('Friends', friends, (u) => [
    button([icon('chat'), 'Message'], () => openDM(u.id)),
    button([icon('phone'), 'Call'], () => startCall(u.id)),
    // Nickname and Remove friend are in the right-click menu and on the profile card (personActions).
  ]);
  if (!f.friends.length && !f.incoming.length && !f.outgoing.length) {
    root.append(h('div', { class: 'empty', text: state.guest ? `No friends yet. Add someone by their username above, or give them yours: ${state.me.name}.`
      : 'No friends yet. Add someone by username above, or click a name in the member list.' }));
  } else if (query && !root.childElementCount) root.append(h('div', { class: 'empty', text: `Nobody here matches “${$('#friendSearch').value.trim()}”.` }));
  section('Blocked', people([...(state.blocked || [])]).filter((u) => !u.deleted), (u) => [button('Unblock', () => unblockPerson(u))]);
}

/* ---------- blocking and reporting ---------- */

// Blocking: no direct messages, calls, pings or friend requests either way, no longer friends, their channel messages
// folded away and their mentions quiet. They aren't told. The server keeps the list (see its on_block).
function blockPerson(user) {
  if (!confirm(`Block ${nick(user)}? You won't be friends any more, neither of you can message, call or friend-request the other, and their messages in channels are hidden for you. They aren't told.`)) return;
  send({ type: 'block', id: user.id });
}
function unblockPerson(user) {
  send({ type: 'unblock', id: user.id });
}

// Why someone is reported; the server has the same list (REPORT_REASONS), and so does the iPhone app.
const REPORT_REASONS = {
  spam: 'Spam', harassment: 'Harassment or bullying', hate: 'Hate speech', sexual: 'Sexual content',
  violence: 'Violence or threats', 'self-harm': 'Self-harm', other: 'Something else',
};
let reporting = null;   // { user, message } the report dialog is about
function openReport(user, message) {
  reporting = { user, message: message || null };
  $('#reportTitle').textContent = message ? `Report a message by ${nick(user)}` : `Report ${nick(user)}`;
  const quote = $('#reportQuote');
  quote.hidden = !message;
  quote.replaceChildren(...(message ? [
    message.text ? h('div', { class: 'report-quote-text', text: message.text.length > 300 ? message.text.slice(0, 300) + '…' : message.text }) : null,
    ...(message.attachments || []).map((a) => h('div', { class: 'report-quote-file' }, icon('clip'), h('span', { text: a.name }))),
  ].filter(Boolean) : []));
  $('#reportReasons').replaceChildren(...Object.entries(REPORT_REASONS).map(([value, label]) => h('label', { class: 'report-reason' },
    h('input', { type: 'radio', name: 'reportReason', value, required: true }), h('span', { text: label }))));
  $('#reportText').value = '';
  $('#reportBlock').checked = false;
  $('#reportBlockRow').hidden = isBlocked(user.id);
  $('#reportDlg').showModal();
}
$('#reportForm').addEventListener('submit', (event) => {
  if (!event.submitter || event.submitter.value !== 'send' || !reporting) return;
  event.preventDefault();   // closes once the server has it (handlers.reported)
  const picked = $('#reportForm').querySelector('input[name="reportReason"]:checked');
  if (!picked) { toast('Pick why you are reporting.'); return; }
  const { user, message } = reporting;
  send({ type: 'report', id: user.id, reason: picked.value, text: $('#reportText').value.trim(),
    ...(message ? { message: message.id, ...placeOf(message) } : {}) });
  if ($('#reportBlock').checked && !isBlocked(user.id)) send({ type: 'block', id: user.id });
});

// Admins: the open reports (Server settings > Reports), newest first. A dot on the settings pencil while any are open.
const reasonLabel = (reason) => REPORT_REASONS[reason] || (reason ? reason[0].toUpperCase() + reason.slice(1) : 'Something else');
function renderReports() {
  const list = state.reports || [];
  const flag = $('#reportsBtn');
  flag.classList.toggle('alert', !!list.length);
  flag.title = list.length ? `Reports · ${list.length} open` : 'Reports';
  $('#reportsHead').textContent = list.length ? `Reports · ${list.length}` : 'Reports';
  const when = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const person = (id, name) => {
    const user = state.users.get(id);
    const el = h('button', { class: 'join-name', type: 'button', text: user && !user.deleted ? nick(user) : name, dataset: user ? { person: id } : {} });
    if (user) el.addEventListener('click', () => openCard(user, el));
    return el;
  };
  $('#reportList').replaceChildren(...(list.length ? list.map((r) => {
    const msg = r.message;
    return h('div', { class: 'report-row' },
      h('div', { class: 'report-head' }, person(r.by, r.byName), ' reported ', person(r.user, r.userName),
        h('span', { class: 'report-why', text: reasonLabel(r.reason) })),
      h('div', { class: 'invite-meta', text: [msg ? `A message in ${r.where || 'a conversation'}` : 'Their account', when(r.at)].join(' · ') }),
      msg ? h('div', { class: 'report-quote' },
        msg.text ? h('div', { class: 'report-quote-text', text: msg.text }) : null,
        ...(msg.attachments || []).map((a) => h('a', { class: 'report-quote-file', href: a.url, target: '_blank', rel: 'noopener' }, icon('clip'), h('span', { text: a.name })))) : null,
      r.text ? h('div', { class: 'report-text', text: r.text }) : null,
      h('div', { class: 'report-acts' },
        msg && msg.channel ? h('button', { class: 'btn slim danger', type: 'button', onclick: () => {
          if (confirm(`Delete ${r.userName}'s message from ${r.where}? Everyone stops seeing it. It stays in this report.`)) send({ type: 'message-delete', id: msg.id, channel: msg.channel });
        } }, 'Delete message') : null,
        h('button', { class: 'btn slim', type: 'button', title: 'Take it off the list, for every admin', onclick: () => send({ type: 'report-close', id: r.id }) }, 'Done')));
  }) : [h('div', { class: 'chan-empty', text: 'No open reports.' })]));
}

$('#friendSearch').addEventListener('input', renderFriends);

$('#friendForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#friendName').value.trim();
  if (!name) return;
  const user = userNamed(name);
  // Guests are out of sight until they are friends (and a guest sees nobody else), so a name this page does not
  // know goes to the server, which says if there is nobody by it. The friends update then says it was sent.
  if (user && user.id === state.me.id) { toast('That is you.'); return; }
  if (user && state.friends.friends.includes(user.id)) { toast(`You and ${nick(user)} are already friends.`); return; }
  send(user ? { type: 'friend-add', id: user.id } : { type: 'friend-add', name });
  $('#friendName').value = '';
});

/* ---------- one-on-one calls ---------- */

// The ringing sounds are files on the server (public/sounds), so swapping a file there changes the ring for
// everyone. If a file is missing or the browser will not play it, a plain beep is used instead.
const RING_FILES = { incoming: '/sounds/incoming.mp3', outgoing: '/sounds/outgoing.mp3' };
const RING_VOLUME = 1;
const ringPlayers = {};
let ringTimer = 0;
let ringing = null;   // the sound playing now

function ringPlayer(kind) {
  if (!ringPlayers[kind]) {
    ringPlayers[kind] = new Audio(RING_FILES[kind]);
    ringPlayers[kind].loop = true;
    ringPlayers[kind].preload = 'auto';
  }
  return ringPlayers[kind];
}

function beepRing(incoming) {
  const play = () => tones(incoming ? [784, 988, 784, 988] : [440, 440], incoming ? 0.16 : 0.45);
  play();
  ringTimer = setInterval(play, incoming ? 2000 : 3000);
}

function ring(incoming) {
  stopRing();
  if (!settings.sounds || rtc.deafened) return;
  const player = ringPlayer(incoming ? 'incoming' : 'outgoing');
  ringing = player;
  player.currentTime = 0;
  player.volume = RING_VOLUME;
  applyOutput(player);
  player.play().catch(() => {
    if (ringing !== player) return;   // the call was answered or dropped before the sound started
    ringing = null;
    beepRing(incoming);
  });
}

function stopRing() {
  clearInterval(ringTimer);
  ringTimer = 0;
  if (ringing) { ringing.pause(); ringing = null; }
}

function endCallUi() {
  stopRing();
  state.call = null;
  renderCallBar();
  placeCallPanel();
  updateTitle();
}

// A call, to a friend only. To an offline friend it rings anyway: on their phone, and on any device they open while it
// rings (40 seconds); if nobody answers, they hear about it when they're next on.
function startCall(id) {
  const user = state.users.get(id);
  if (!user) return;
  if (!isFriend(user)) { toast(`You can only call friends. Add ${nick(user)} first.`); return; }
  if (state.call) { toast('Finish your current call first.'); return; }
  audio();   // this click unlocks sound for the ringing tone and the call
  send({ type: 'call-invite', to: id });
  if (!user.online) toast(`${nick(user)} is offline. It rings on their phone, and if they open Umbryx in the next 40 seconds.`, 7000);
}

function answerCall(accept) {
  const call = state.call;
  if (!call) return;
  if (accept) audio();
  stopRing();
  send({ type: 'call-answer', call: call.id, accept });
}

function renderCallBar() {
  const bar = $('#callBar');
  const call = state.call;
  if (!call || call.room) { bar.hidden = true; bar.replaceChildren(); return; }   // a live call shows in the voice panel instead
  const user = state.users.get(call.with) || { name: 'Someone' };
  const button = (label, cls, run, glyph) => h('button', { class: 'btn slim ' + cls, type: 'button', onclick: run }, glyph ? icon(glyph) : null, label);
  bar.hidden = false;
  bar.classList.toggle('ringing', call.incoming);
  bar.replaceChildren(avatar(user),
    h('div', { class: 'callbar-text' }, h('b', { text: nick(user) }), h('small', { text: call.incoming ? 'Incoming call' : 'Calling…' })),
    ...(call.incoming
      ? [button('Accept', 'ok', () => answerCall(true), 'phone'), button('Decline', 'hang', () => answerCall(false))]
      : [button('Cancel', 'hang', () => send({ type: 'call-end', call: call.id }))]));
}

/* ---------- voice: microphone ---------- */

function audio() {
  try {
    if (!rtc.ctx) rtc.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (rtc.ctx.state === 'suspended') rtc.ctx.resume().catch(() => {});
  } catch { /* no audio output available */ }
  return rtc.ctx;
}

// The preview window built into the Claude desktop app refuses microphones outright.
const EMBEDDED_PREVIEW = /Claude\//i.test(navigator.userAgent);
// Inside the Umbryx desktop app, which supplies its own screen picker and grants the microphone itself.
const DESKTOP_APP = /Umbryx\//.test(navigator.userAgent);
let micError = '';   // why the last attempt to open the microphone failed

function micBlockedByPreview() {
  return EMBEDDED_PREVIEW && (micError === 'NotAllowedError' || micError === 'SecurityError');
}

// What stopped the microphone, and what to do about it.
function micHelp() {
  switch (micError) {
    case '':
      return 'Your microphone is off, so others cannot hear you yet.';
    case 'insecure':
      return 'Microphones only work on the secure (https) address shown at the top of this page.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Plug one in, then press Enable microphone.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is in use by another app or blocked by Windows. Close other apps using it and check Windows Settings > Privacy & security > Microphone.';
    case 'NotAllowedError':
    case 'SecurityError':
      return EMBEDDED_PREVIEW
        ? `This preview window blocks microphones. To talk, open ${location.origin} in Chrome or Edge.`
        : 'The browser is blocking the microphone for this site. Click the icon at the left of the address bar, set Microphone to Allow, then press Enable microphone.';
    default:
      return 'The microphone could not be opened in this browser.';
  }
}

async function openMic() {
  micError = '';
  if (!window.isSecureContext) { micError = 'insecure'; return null; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { micError = 'unsupported'; return null; }
  const base = {
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseMode === 'standard',   // Strong does its own, after (see ensureMic)
    autoGainControl: settings.autoGainControl,
  };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: settings.inputId ? { ...base, deviceId: { exact: settings.inputId } } : base });
  } catch (err) {
    micError = err.name || 'unknown';
    // A saved microphone that has been unplugged falls back to the default one.
    if (!settings.inputId || (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError')) return null;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: base });
    micError = '';
    return stream;
  } catch (err) {
    micError = err.name || 'unknown';
    return null;
  }
}

async function ensureMic(replace) {
  if (rtc.mic && !replace) return true;
  const captured = await openMic();
  if (!captured) return false;
  const old = rtc.mic;
  const raw = captured.getAudioTracks()[0];
  // Strong noise suppression: what is sent (and what lights up the speaking ring) is the cleaned sound. If it
  // cannot start, the microphone works as it is.
  let clean = null;
  if (settings.noiseMode === 'strong') {
    try { clean = await denoise(captured); } catch (err) { console.warn('noise suppression could not start:', err); }
  }
  const stream = clean ? clean.stream : captured;
  const track = stream.getAudioTracks()[0];
  track.enabled = !rtc.muted && !voiceLocked();
  const mic = { stream, track, raw: captured, clean, source: null, analyser: null };
  try {
    mic.source = rtc.ctx.createMediaStreamSource(stream);
    mic.analyser = rtc.ctx.createAnalyser();
    mic.analyser.fftSize = 512;
    mic.source.connect(mic.analyser);
  } catch { /* speaking indicator is optional */ }
  rtc.mic = mic;
  for (const peer of rtc.peers.values()) addMicTo(peer);
  if (old) releaseMic(old);
  raw.addEventListener('ended', () => {
    if (rtc.mic !== mic) return;
    rtc.mic = null;
    toast('The microphone was disconnected.');
    sendFlags(); updateControls();
  });
  return true;
}

function releaseMic(mic) {
  if (mic.source) mic.source.disconnect();
  if (mic.clean) mic.clean.stop();
  mic.track.stop();
  for (const track of mic.raw ? mic.raw.getTracks() : []) track.stop();
}

/* Strong noise suppression: RNNoise, a small neural network made for voices (by Xiph.Org and Mozilla), cleans the
   microphone in this page before the sound goes to anyone: fans, typing, hum and traffic go, the voice stays. It
   costs a few percent of one processor core, and only while the microphone is open. The files are in
   public/rnnoise (from @sapphi-red/web-noise-suppressor 0.4.1, around Shiguredo's WebAssembly build of RNNoise;
   licences in rnnoise/LICENSE.txt). RNNoise works at 48 kHz, so it has an audio context of its own at that rate. */

const RNNOISE_NAME = '@sapphi-red/web-noise-suppressor/rnnoise';
// A WebAssembly module using SIMD instructions: if the browser accepts it, the faster build is used.
const WASM_SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
let rnnoiseBinary = null;   // a promise of RNNoise's WebAssembly, fetched once

async function denoise(input) {
  if (!rnnoiseBinary) {
    const file = WebAssembly.validate(WASM_SIMD_PROBE) ? '/rnnoise/rnnoise_simd.wasm' : '/rnnoise/rnnoise.wasm';
    rnnoiseBinary = fetch(file).then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.arrayBuffer(); });
    rnnoiseBinary.catch(() => { rnnoiseBinary = null; });
  }
  const binary = await rnnoiseBinary;
  // The worklet cannot say when it fails to start (and would then pass on silence), so first make sure this page
  // may run WebAssembly at all: a server from before Strong noise suppression does not allow it.
  await WebAssembly.compile(binary);
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  try {
    await ctx.audioWorklet.addModule('/rnnoise/worklet.js');
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(input);
    const node = new AudioWorkletNode(ctx, RNNOISE_NAME, { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
      processorOptions: { wasmBinary: binary, maxChannels: 1 } });
    const out = ctx.createMediaStreamDestination();
    source.connect(node).connect(out);
    return { stream: out.stream, stop: () => { node.port.postMessage('destroy'); source.disconnect(); ctx.close().catch(() => {}); } };
  } catch (err) {
    ctx.close().catch(() => {});
    throw err;
  }
}

function capAudio(sender, bitrate) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) return;
    params.encodings[0].maxBitrate = bitrate;
    sender.setParameters(params).catch(() => {});
  } catch { /* not negotiated yet; retried once connected */ }
}

function addMicTo(peer) {
  if (!rtc.mic) return;
  if (peer.micSender) peer.micSender.replaceTrack(rtc.mic.track).catch(() => {});
  else peer.micSender = peer.pc.addTrack(rtc.mic.track, rtc.mic.stream);
  capAudio(peer.micSender, 64000);
}

function sendFlags() {
  if (!rtc.channel) return;
  send({ type: 'voice-flags', muted: rtc.muted || !rtc.mic || voiceLocked(), deafened: rtc.deafened || !!(self() && self().serverDeafened),
    sharing: !!rtc.screen, camera: !!rtc.camera });
}

// Muted or deafened by one of the server's admins (user.serverMuted / serverDeafened): the microphone stays off and,
// when deafened, nobody plays, until an admin takes it off. Someone an admin muted is not played here either.
const voiceLocked = () => !!(self() && (self().serverMuted || self().serverDeafened));
const silenced = (peerId) => { const user = state.users.get(peerId); return !!(user && (user.serverMuted || user.serverDeafened)); };
function applyMic() {
  if (rtc.mic) rtc.mic.track.enabled = !rtc.muted && !voiceLocked();
}

async function toggleMic() {
  if (voiceLocked()) { toast(self().serverDeafened ? 'An admin deafened you on this server.' : 'An admin muted you on this server.'); return; }
  if (rtc.channel && !rtc.mic) {
    if (!(await ensureMic())) { toast(micHelp(), 7000); updateControls(); return; }
    rtc.muted = false;
  } else rtc.muted = !rtc.muted;
  if (!rtc.muted && rtc.deafened) { rtc.deafened = false; applyDeafen(); }
  applyMic();
  sendFlags(); updateControls();
  switchSound(rtc.muted ? 'mute' : 'unmute');
}

function toggleDeafen() {
  if (self() && self().serverDeafened) { toast('An admin deafened you on this server.'); return; }
  rtc.deafened = !rtc.deafened;
  if (rtc.deafened) { rtc.mutedBeforeDeafen = rtc.muted; rtc.muted = true; }
  else rtc.muted = rtc.mutedBeforeDeafen;
  applyMic();
  applyDeafen();
  sendFlags(); updateControls();
  switchSound(rtc.deafened ? 'deafen' : 'undeafen');
}

// Muting, unmuting, deafening and undeafening yourself each have a sound (files in public/sounds), on the chosen
// speakers. Deafening still plays its own: it is you who pressed it. Off with the other sounds in Settings.
const SWITCH_SOUNDS = { mute: '/sounds/mute.mp3', unmute: '/sounds/unmute.mp3', deafen: '/sounds/deafen.mp3', undeafen: '/sounds/undeafen.mp3' };
const switchPlayers = {};
function switchSound(kind) {
  if (!settings.sounds || !SWITCH_SOUNDS[kind]) return;
  for (const other of Object.values(switchPlayers)) other.pause();   // quick presses: only the latest plays
  let player = switchPlayers[kind];
  if (!player) {
    player = switchPlayers[kind] = new Audio(SWITCH_SOUNDS[kind]);
    player.preload = 'auto';
    player.volume = 0.6;
  }
  applyOutput(player);
  player.currentTime = 0;
  player.play().catch(() => {});
}

function applyDeafen() {
  const deaf = rtc.deafened || !!(self() && self().serverDeafened);
  for (const peer of rtc.peers.values()) if (peer.audio) peer.audio.muted = deaf || silenced(peer.id);
  syncStage();
}

function applyOutput(el) {
  if (el.setSinkId) el.setSinkId(settings.outputId || '').catch(() => {});
}

/* ---------- voice: ping to the server ---------- */

let pingMs = null;   // last measured round trip to the server, while in voice
let pingTimer = 0;

function renderPing() {
  const quality = pingMs == null ? '' : pingMs < 80 ? ' good' : pingMs < 200 ? ' fair' : ' poor';
  $('#vpPing').textContent = pingMs == null ? '' : `${pingMs} ms`;
  $('#vpPing').className = 'ping' + quality;
  $('#vpPing').title = 'Ping to the server';
  $('#headPing').textContent = pingMs == null || state.view.type !== 'voice' ? '' : `${pingMs} ms`;
  $('#headPing').className = 'ping' + quality;
}

// Measured the moment you join, then every few seconds for as long as you stay in voice.
function startPing() {
  stopPing();
  const measure = () => send({ type: 'echo', t: performance.now() });
  measure();
  setTimeout(() => { if (rtc.channel) measure(); }, 900);   // the first reading is taken while the page is busy joining
  pingTimer = setInterval(measure, 4000);
}

function stopPing() {
  clearInterval(pingTimer);
  pingTimer = 0;
  pingMs = null;
  renderPing();
}

/* ---------- voice: joining and peers ---------- */

// keep: rejoining by itself (after a dropped connection, or the desktop app restarting to update), so mute and
// deafen stay as they were. Otherwise joining from outside voice always starts unmuted and hearing; moving from one
// channel to another keeps them, as in Discord.
async function joinVoice(id, keep = false) {
  if (rtc.channel === id || rtc.joining) return;
  if (!keep && !rtc.channel) {
    rtc.muted = false;
    if (rtc.deafened) { rtc.deafened = false; applyDeafen(); }
  }
  if (rtc.channel) { teardownVoice(); send({ type: 'voice-leave' }); }
  rtc.joining = true;
  try {
    audio();
    // Without a microphone you still join and can listen. The voice window explains how to enable it,
    // so say it here when that window is not the one being looked at.
    if (!(await ensureMic()) && state.view.type !== 'voice') toast(micHelp(), 7000);
    rtc.channel = id;
    rtc.joinedAt = Date.now();   // for the call timer
    if (!send({ type: 'voice-join', channel: id, muted: rtc.muted || !rtc.mic, deafened: rtc.deafened })) {
      teardownVoice();
      toast('Not connected to the server right now.');
      if (state.view.type === 'voice') leaveStage();
    } else startPing();
  } finally { rtc.joining = false; }
  renderSidebar(); syncStage(); updateControls();
}

function teardownVoice() {
  if (rtc.screen) endShare(false);
  if (rtc.camera) stopCamera(false);
  for (const id of [...rtc.peers.keys()]) destroyPeer(id);
  if (rtc.mic) { releaseMic(rtc.mic); rtc.mic = null; }
  rtc.channel = null;
  rtc.joinedAt = 0;
  rtc.speaking.clear();
  stopPing();
}

function leaveVoice() {
  if (!rtc.channel) return;
  blip('leave');
  teardownVoice();
  send({ type: 'voice-leave' });
  if (state.view.type === 'voice') leaveStage();
  renderSidebar(); syncStage(); updateControls();
}

function signal(to, data) { send({ type: 'signal', to, data }); }

// Sent with every offer and answer so the other side can tell a screen from a camera.
const localMeta = () => ({
  screen: rtc.screen ? rtc.screen.stream.id : null,
  camera: rtc.camera ? rtc.camera.stream.id : null,
});

// Ask for stereo, higher-bitrate Opus so shared game or movie sound is not squeezed to voice quality.
function tuneSdp(sdp) {
  for (const hit of sdp.matchAll(/a=rtpmap:(\d+) opus\/48000\/2/gi)) {
    sdp = sdp.replace(new RegExp(`^a=fmtp:${hit[1]} (?!.*stereo=)([^\\r\\n]*)`, 'm'),
      (line) => line + ';stereo=1;sprop-stereo=1;maxaveragebitrate=256000');
  }
  return sdp;
}

// While sharing, the description a viewer sends back says where the share's bitrate starts
// (x-google-start-bitrate, read by the sending side): near its target, not the few hundred kbps WebRTC otherwise
// starts from and climbs out of over several seconds, stuttering as it goes. On the video codecs only.
function startShareFast(sdp) {
  const screen = rtc.screen;
  if (!screen || !sdp) return sdp;
  const kbps = Math.round(Math.min(targetBitrate(screen), 10e6) / 1000);
  const video = new Set();
  for (const hit of sdp.matchAll(/^a=rtpmap:(\d+) (H264|H265|VP8|VP9|AV1)\//gim)) video.add(hit[1]);
  for (const pt of video) {
    const fmtp = new RegExp(`^a=fmtp:${pt} (?![^\\r\\n]*x-google-start-bitrate)([^\\r\\n]*)`, 'm');
    if (fmtp.test(sdp)) sdp = sdp.replace(fmtp, (line) => `${line};x-google-start-bitrate=${kbps}`);
    else sdp = sdp.replace(new RegExp(`^(a=rtpmap:${pt} [^\\r\\n]*)(\\r?\\n)`, 'm'), `$1$2a=fmtp:${pt} x-google-start-bitrate=${kbps}$2`);
  }
  return sdp;
}

async function setLocal(pc, desc) {
  try { await pc.setLocalDescription({ type: desc.type, sdp: tuneSdp(desc.sdp) }); }
  catch { await pc.setLocalDescription(desc); }
}

async function negotiate(peer) {
  const pc = peer.pc;
  try {
    peer.makingOffer = true;
    const offer = await pc.createOffer();
    if (pc.signalingState !== 'stable') return;
    await setLocal(pc, offer);
    signal(peer.id, { description: pc.localDescription, meta: localMeta() });
  } catch (err) { console.warn('offer', err); }
  finally { peer.makingOffer = false; }
}

function createPeer(id, initiator) {
  const pc = new RTCPeerConnection({ iceServers: state.iceServers, bundlePolicy: 'max-bundle' });
  const peer = {
    id, pc,
    polite: state.me.id < id,     // one side of each pair yields when both offer at once
    makingOffer: false, ignoreOffer: false,
    queue: Promise.resolve(),
    micSender: null, audio: null, source: null, analyser: null,
    remoteScreenId: null, screenStream: null, watching: false, inStat: {},        // their screen, as we see it
    wantsScreen: false, screenTx: [], outStat: {}, softTicks: 0, softCodecs: new Set(),   // our screen, as sent to them
    remoteCameraId: null, cameraStream: null, cameraTx: null,                     // their camera, and ours as sent to them
  };
  rtc.peers.set(id, peer);

  pc.onicecandidate = (event) => { if (event.candidate) signal(id, { candidate: event.candidate }); };
  pc.onnegotiationneeded = () => negotiate(peer);
  pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (stream && peer.remoteScreenId && stream.id === peer.remoteScreenId) {
      peer.screenStream = stream;
      syncStage();
    } else if (stream && peer.remoteCameraId && stream.id === peer.remoteCameraId) {
      peer.cameraStream = stream;
      syncStage();
    } else if (event.track.kind === 'audio') attachVoice(peer, stream || new MediaStream([event.track]));
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
    if (pc.connectionState === 'connected' && peer.micSender) capAudio(peer.micSender, 64000);
    syncStage();
  };

  if (rtc.mic) addMicTo(peer);
  else if (initiator) pc.addTransceiver('audio', { direction: 'recvonly' });   // gives a listener something to negotiate
  attachCamera(peer);
  return peer;
}

async function onSignal(peer, data) {
  const pc = peer.pc;
  if (pc.signalingState === 'closed') return;
  if ('watch' in data) {
    if (data.watch && !peer.wantsScreen && rtc.screen) blip('viewer');   // someone started watching your share
    peer.wantsScreen = !!data.watch;
    if (peer.wantsScreen) attachScreen(peer); else detachScreen(peer);
    return;
  }
  if (data.description) {
    const desc = data.description;
    const collision = desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    if (data.meta) {
      peer.remoteScreenId = data.meta.screen || null;
      peer.remoteCameraId = data.meta.camera || null;
    }
    if (rtc.screen && peer.wantsScreen) {
      try { await pc.setRemoteDescription({ type: desc.type, sdp: startShareFast(desc.sdp) }); }
      catch { await pc.setRemoteDescription(desc); }
    } else await pc.setRemoteDescription(desc);
    if (desc.type === 'offer') {
      await setLocal(pc, await pc.createAnswer());
      signal(peer.id, { description: pc.localDescription, meta: localMeta() });
    }
  } else if (data.candidate) {
    try { await pc.addIceCandidate(data.candidate); }
    catch (err) { if (!peer.ignoreOffer) throw err; }
  }
}

function attachVoice(peer, stream) {
  if (!peer.audio) {
    peer.audio = new Audio();
    peer.audio.autoplay = true;
    $('#sink').append(peer.audio);
  }
  const user = state.users.get(peer.id);
  peer.audio.srcObject = stream;
  peer.audio.volume = (user && volumes[user.id]) ?? 1;
  peer.audio.muted = rtc.deafened || !!(self() && self().serverDeafened) || silenced(peer.id);
  applyOutput(peer.audio);
  peer.audio.play().catch(() => {});
  try {
    if (peer.source) peer.source.disconnect();
    peer.source = rtc.ctx.createMediaStreamSource(stream);
    peer.analyser = rtc.ctx.createAnalyser();
    peer.analyser.fftSize = 512;
    peer.source.connect(peer.analyser);
  } catch { /* speaking indicator is optional */ }
}

function destroyPeer(id) {
  const peer = rtc.peers.get(id);
  if (!peer) return;
  rtc.peers.delete(id);
  rtc.speaking.delete(id);
  if (peer.source) peer.source.disconnect();
  if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); }
  peer.pc.close();
}

/* ---------- camera ---------- */

// Unlike a screen share, which each viewer asks for, a camera goes to everyone in the room straight away.
const CAMERA = { width: 1280, height: 720, fps: 30, bitrate: 2.5e6 };

function cameraHelp(error) {
  switch (error) {
    case 'insecure':
      return 'Cameras only work on the secure (https) address shown at the top of this page.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found. Plug one in and try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is in use by another app or blocked by Windows. Close other apps using it and check Windows Settings > Privacy & security > Camera.';
    case 'NotAllowedError':
    case 'SecurityError':
      return EMBEDDED_PREVIEW
        ? `This preview window blocks cameras. To use yours, open ${location.origin} in Chrome or Edge.`
        : 'The browser is blocking the camera for this site. Click the icon at the left of the address bar and set Camera to Allow.';
    default:
      return 'The camera could not be opened in this browser.';
  }
}

// Resolves to a stream, or to the name of what went wrong.
async function openCamera() {
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'unsupported';
  const base = {
    width: { ideal: CAMERA.width }, height: { ideal: CAMERA.height },
    frameRate: { ideal: CAMERA.fps, max: CAMERA.fps },
  };
  try {
    return await navigator.mediaDevices.getUserMedia({ video: settings.cameraId ? { ...base, deviceId: { exact: settings.cameraId } } : base });
  } catch (err) {
    // A saved camera that has been unplugged falls back to the default one.
    if (!settings.cameraId || (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError')) return err.name || 'unknown';
  }
  try { return await navigator.mediaDevices.getUserMedia({ video: base }); }
  catch (err) { return err.name || 'unknown'; }
}

function attachCamera(peer) {
  const camera = rtc.camera;
  if (!camera || peer.cameraTx) return;
  peer.cameraTx = peer.pc.addTransceiver(camera.track, {
    direction: 'sendonly', streams: [camera.stream],
    sendEncodings: [{ maxBitrate: CAMERA.bitrate, maxFramerate: CAMERA.fps }],
  });
}

function detachCamera(peer) {
  const transceiver = peer.cameraTx;
  if (!transceiver) return;
  peer.cameraTx = null;
  try { peer.pc.removeTrack(transceiver.sender); } catch { /* already closed */ }
  try { transceiver.stop(); } catch { /* already stopped */ }
}

async function toggleCamera(injected) {
  if (!rtc.channel) { toast('Join a voice channel or a call first.'); return; }
  if (rtc.camera) { stopCamera(); return; }
  if (rtc.cameraOpening) return;
  rtc.cameraOpening = true;
  let stream = injected instanceof MediaStream ? injected : null;
  try { if (!stream) stream = await openCamera(); } finally { rtc.cameraOpening = false; }
  if (typeof stream === 'string') {
    toast(cameraHelp(stream), 7000);
    sendFlags(); syncStage(); updateControls();
    return;
  }
  if (!rtc.channel || rtc.camera) { stream.getTracks().forEach((t) => t.stop()); return; }
  const track = stream.getVideoTracks()[0];
  track.contentHint = 'motion';
  const camera = { stream, track };
  rtc.camera = camera;
  track.addEventListener('ended', () => {
    if (rtc.camera !== camera) return;
    stopCamera();
    toast('The camera was disconnected.');
  });
  for (const peer of rtc.peers.values()) attachCamera(peer);
  sendFlags(); syncStage(); updateControls();
}

function stopCamera(announce = true) {
  const camera = rtc.camera;
  if (!camera) return;
  rtc.camera = null;
  for (const peer of rtc.peers.values()) detachCamera(peer);
  camera.stream.getTracks().forEach((t) => t.stop());
  if (announce) { sendFlags(); syncStage(); updateControls(); }
}

/* ---------- screen share: GPU encoding ---------- */

// Browsers do not let a page pick an encoder directly. What a page can do is ask for the codecs that the
// graphics card encodes (NVENC on NVIDIA, Quick Sync on Intel, AMF on AMD), then check what was really used.
const GPU_CODECS = ['video/AV1', 'video/H265', 'video/H264', 'video/VP9'];   // best picture per bit first
const CODEC_NAMES = { 'video/AV1': 'AV1', 'video/H265': 'H.265', 'video/H264': 'H.264', 'video/VP9': 'VP9', 'video/VP8': 'VP8' };
let gpuCache = null;

function gpuInfo() {
  if (gpuCache) return gpuCache;
  let renderer = '';
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (gl) renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
  } catch { /* WebGL is off */ }
  // Chrome reports e.g. "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)"
  const inner = (renderer.match(/^ANGLE \((.*)\)$/) || [null, renderer])[1];
  const parts = inner.split(', ');
  const name = (parts.length >= 2 ? parts[1] : inner).replace(/\s+(Direct3D|OpenGL|Vulkan|Metal).*$/i, '').replace(/\s*\(0x[0-9a-f]+\)/gi, '').trim();
  const vendor = /swiftshader|llvmpipe|basic render|software/i.test(renderer) ? 'software'
    : /nvidia|geforce|quadro|\brtx\b|\bgtx\b/i.test(renderer) ? 'nvidia'
    : /\bamd\b|radeon/i.test(renderer) ? 'amd'
    : /intel/i.test(renderer) ? 'intel'
    : /apple/i.test(renderer) ? 'apple' : 'other';
  const engine = { nvidia: 'NVENC', amd: 'AMF', intel: 'Quick Sync', apple: 'VideoToolbox' }[vendor] || '';
  gpuCache = { vendor, name: name || 'graphics card', engine };
  return gpuCache;
}

function gpuAdvice() {
  const gpu = gpuInfo();
  if (gpu.vendor === 'software') return 'Switch on "Use graphics acceleration when available" in the browser settings, then restart the browser.';
  if (gpu.vendor === 'nvidia') return 'Check that graphics acceleration is on in the browser settings and that the NVIDIA driver is up to date.';
  return `The browser is running on ${gpu.name}. To use an NVIDIA card instead, set the browser to "High performance" in Windows Settings > System > Display > Graphics.`;
}

// Which codecs this browser can encode on the graphics card at this size and frame rate.
async function hardwareCodecs(width, height, fps, bitrate) {
  const found = [];
  if (!navigator.mediaCapabilities || !navigator.mediaCapabilities.encodingInfo || !window.RTCRtpSender) return found;
  let sendable = [];
  try { sendable = RTCRtpSender.getCapabilities('video').codecs.map((c) => c.mimeType.toLowerCase()); } catch { return found; }
  for (const mime of GPU_CODECS) {
    if (!sendable.includes(mime.toLowerCase())) continue;
    try {
      const info = await navigator.mediaCapabilities.encodingInfo({
        type: 'webrtc', video: { contentType: mime, width, height, framerate: fps, bitrate },
      });
      if (info.supported && info.powerEfficient) found.push(mime);
    } catch { /* this browser does not know the codec */ }
  }
  return found;
}

// Put the wanted codecs first, in order, and leave the rest as fallbacks for viewers that lack them.
function preferCodecs(transceiver, mimes) {
  if (!mimes || !mimes.length || !transceiver.setCodecPreferences) return;
  const wanted = mimes.map((m) => m.toLowerCase());
  const rank = (codec) => { const i = wanted.indexOf(codec.mimeType.toLowerCase()); return i < 0 ? wanted.length : i; };
  for (const side of [RTCRtpSender, RTCRtpReceiver]) {
    try {
      const all = side.getCapabilities('video').codecs;
      if (!all.some((c) => rank(c) < wanted.length)) continue;
      const sorted = all.map((codec, i) => ({ codec, i })).sort((a, b) => rank(a.codec) - rank(b.codec) || a.i - b.i);
      transceiver.setCodecPreferences(sorted.map((x) => x.codec));
      return;
    } catch { /* try the other capability list */ }
  }
}

// Called once a second per viewer. If the browser quietly fell back to a CPU encoder, move this viewer
// to the next GPU codec; if there is none left, say so once.
function guardEncoder(peer, stats) {
  const screen = rtc.screen;
  if (!screen || !stats || stats.hardware !== false || stats.frames < 45) { peer.softTicks = 0; return; }
  if (++peer.softTicks < 3) return;
  peer.softTicks = 0;
  peer.softCodecs.add(('video/' + stats.codec).toLowerCase());
  const next = screen.opts.codec === 'auto' ? screen.order.filter((m) => !peer.softCodecs.has(m.toLowerCase())) : [];
  if (next.length && peer.screenTx[0]) {
    preferCodecs(peer.screenTx[0], next);
    negotiate(peer);
  } else if (!screen.warnedCpu) {
    screen.warnedCpu = true;
    toast('This stream is being encoded on the CPU, not the graphics card. ' + gpuAdvice(), 10000);
  }
}

async function refreshGpuLine() {
  const line = $('#shGpu');
  const gpu = gpuInfo();
  const chosen = $('#shRes').value;
  const picked = chosen === 'auto' ? Math.min(2160, Math.round(window.screen.height * devicePixelRatio)) : +chosen;
  const height = picked || Math.round(window.screen.height * devicePixelRatio);
  const width = picked ? Math.round(picked * 16 / 9) : Math.round(window.screen.width * devicePixelRatio);
  const fps = +$('#shFps').value;
  const found = await hardwareCodecs(width, height, fps, Math.min(40e6, width * height * fps * 0.06));
  if (found.length) {
    line.className = 'gpu-line good';
    line.textContent = `GPU encoding ready: ${gpu.name}${gpu.engine ? ` (${gpu.engine})` : ''} · ${found.map((m) => CODEC_NAMES[m]).join(', ')}`
      + (gpu.vendor !== 'nvidia' && gpu.vendor !== 'apple' ? '. ' + gpuAdvice() : '');
  } else {
    line.className = 'gpu-line';
    line.textContent = `Graphics card: ${gpu.name}. The browser didn't say which encoder it will use at this size; once you share, Umbryx checks and tells you if it's the CPU.`;
  }
}

/* ---------- screen share ---------- */

function videoConstraints(o) {
  const video = { frameRate: { ideal: o.fps, max: o.fps } };
  if (o.height === 'auto') {   // the screen's own size, at most 4K
    video.width = { max: 3840 };
    video.height = { max: 2160 };
  } else if (o.height) {
    const width = Math.round(o.height * 16 / 9);
    video.width = { ideal: width, max: width };
    video.height = { ideal: o.height, max: o.height };
  }
  return video;
}

function targetBitrate(screen) {
  if (screen.opts.bitrate) return screen.opts.bitrate * 1e6;
  const s = screen.videoTrack.getSettings();
  const auto = (s.width || 1920) * (s.height || 1080) * screen.opts.fps * 0.06;   // 4K60 lands near 30 Mbps
  return Math.round(Math.min(40e6, Math.max(2.5e6, auto)));
}

async function tuneVideoSender(sender, screen) {
  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) return;
  Object.assign(params.encodings[0], {
    maxBitrate: targetBitrate(screen), maxFramerate: screen.opts.fps, scaleResolutionDownBy: 1, priority: 'high', networkPriority: 'high',
  });
  // When the network or the encoder cannot keep up: for motion (games, video) keep it smooth and lower the
  // resolution; for detail (text, code) keep it sharp and drop frames.
  params.degradationPreference = screen.opts.mode === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
  try { await sender.setParameters(params); } catch (err) { console.warn('encoder settings', err); }
}

// Every viewer's encode, after the stream settings change.
function retuneViewers() {
  const screen = rtc.screen;
  if (!screen) return;
  for (const peer of rtc.peers.values()) if (peer.screenTx[0]) tuneVideoSender(peer.screenTx[0].sender, screen);
}

function attachScreen(peer) {
  const screen = rtc.screen;
  if (!screen || peer.screenTx.length) return;
  const video = peer.pc.addTransceiver(screen.videoTrack, {
    direction: 'sendonly', streams: [screen.stream],
    sendEncodings: [{ maxBitrate: targetBitrate(screen), maxFramerate: screen.opts.fps, scaleResolutionDownBy: 1 }],
  });
  peer.softTicks = 0;
  peer.softCodecs = new Set();
  peer.outStat = {};
  preferCodecs(video, screen.order);
  peer.screenTx.push(video);
  if (screen.audioTrack) {
    peer.screenTx.push(peer.pc.addTransceiver(screen.audioTrack, {
      direction: 'sendonly', streams: [screen.stream], sendEncodings: [{ maxBitrate: 256000 }],
    }));
  }
  tuneVideoSender(video.sender, screen);
}

function detachScreen(peer) {
  for (const transceiver of peer.screenTx.splice(0)) {
    try { peer.pc.removeTrack(transceiver.sender); } catch { /* already closed */ }
    try { transceiver.stop(); } catch { /* already stopped */ }
  }
}

async function startShare(opts, injected) {
  if (!rtc.channel || rtc.screen) return;
  let stream = injected;
  if (!stream) {
    const request = {
      video: videoConstraints(opts),
      audio: opts.audio ? {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: 2, sampleRate: 48000,
        restrictOwnAudio: true,   // keep the voice chat itself out of shared system sound where supported
      } : false,
      systemAudio: opts.audio ? 'include' : 'exclude',
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude',
      monitorTypeSurfaces: 'include',
    };
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(request);
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') return;   // picker cancelled
      if (DESKTOP_APP && err.name !== 'TypeError') return;                         // the app's own picker was closed
      try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: !!opts.audio }); }
      catch { toast('Screen share could not start in this browser.'); return; }
    }
  }
  if (!rtc.channel) { stream.getTracks().forEach((t) => t.stop()); return; }
  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0] || null;
  videoTrack.contentHint = opts.mode === 'detail' ? 'detail' : 'motion';
  if (audioTrack) audioTrack.contentHint = 'music';
  const size = videoTrack.getSettings();
  // Your own share starts covered: drawing it costs the computer work for nothing, and for a whole screen it
  // would be a picture of the screen it is on, a tunnel of copies of itself (on an HDR screen brighter at every
  // step until it is white). Show my preview brings it back.
  const whole = size.displaySurface ? size.displaySurface === 'monitor' : /screen/i.test(videoTrack.label);
  const screen = { stream, videoTrack, audioTrack, opts: { ...opts }, gpuCodecs: [], order: [], warnedCpu: false, statPrev: null,
    whole, preview: false };
  const width = size.width || 1920;
  const height = size.height || 1080;
  screen.gpuCodecs = await hardwareCodecs(width, height, opts.fps, targetBitrate(screen));
  if (opts.codec !== 'auto') screen.order = [opts.codec];
  else {
    // GPU codecs at the full frame rate first, then ones the card only manages at 30 fps (for viewers
    // that cannot decode the first choice), then H.264 because everything plays it.
    const slower = opts.fps > 30 ? await hardwareCodecs(width, height, 30, targetBitrate(screen)) : [];
    screen.order = [...new Set([...screen.gpuCodecs, ...slower, 'video/H264', 'video/VP9'])];
  }
  if (!rtc.channel || rtc.screen) { stream.getTracks().forEach((t) => t.stop()); return; }
  rtc.screen = screen;
  videoTrack.addEventListener('ended', () => { if (rtc.screen === screen) endShare(); });
  sendFlags(); syncStage(); updateControls();
  blip('share-start');
  if (injected) return;
  // Nothing is said about the CPU before anything is encoded: the browser's own answer is often wrong (the desktop
  // app reports H.264 as CPU-only, then encodes it on the graphics card). guardEncoder warns if the share's own
  // numbers show the CPU.
  if (screen.gpuCodecs.length && opts.codec !== 'auto' && !screen.gpuCodecs.includes(opts.codec)) {
    toast(`${CODEC_NAMES[opts.codec] || 'That codec'} is not GPU-encoded here at this size. "Automatic" would use ${screen.gpuCodecs.map((m) => CODEC_NAMES[m]).join(' or ')}.`, 8000);
  }
  if (opts.audio && !audioTrack) {
    toast('Sharing without sound. To include it, share a tab or your entire screen and switch on audio in the picker.', 7000);
  }
}

function endShare(announce = true) {
  const screen = rtc.screen;
  if (!screen) return;
  rtc.screen = null;
  for (const peer of rtc.peers.values()) { detachScreen(peer); peer.wantsScreen = false; }
  screen.stream.getTracks().forEach((t) => t.stop());
  if (announce) { sendFlags(); syncStage(); updateControls(); blip('share-end'); }
}

async function retuneShare(opts) {
  const screen = rtc.screen;
  if (!screen) return;
  screen.opts = { ...opts, codec: screen.opts.codec, audio: screen.opts.audio };
  screen.videoTrack.contentHint = opts.mode === 'detail' ? 'detail' : 'motion';
  try { await screen.videoTrack.applyConstraints(videoConstraints(opts)); } catch { /* keep the current capture size */ }
  retuneViewers();
}

function watch(id, on) {
  const peer = rtc.peers.get(id);
  if (!peer) { toast('Still connecting to them. Try again in a moment.'); return; }
  peer.watching = on;
  if (!on) peer.screenStream = null;
  signal(id, { watch: on });
  syncStage();
}

/* In the desktop app (1.4.22 on) the share settings list the screens and windows themselves, with their pictures,
   so choosing what to share and how happens in one window (the app's own picker window opened elsewhere, often on
   another monitor). The app then grants the share without asking again (see its page:share-choose). */
const SHARE_HINT = $('#shHint').textContent;
const shareInOne = () => !!(appShell && appShell.shareSources && appShell.shareChoose);
let sharePick = null;    // { id, name, hdr } chosen in the list
let shareHdrOk = true;   // whether this Windows converts a whole HDR screen properly (the app says)

function explainShareHdr() {
  const note = $('#shHdr');
  note.hidden = !(sharePick && sharePick.hdr);
  if (note.hidden) return;
  note.className = 'gpu-line' + (shareHdrOk ? '' : ' warn');
  note.textContent = shareHdrOk
    ? 'This screen is in HDR. It is converted to SDR for the stream. Highlights brighter than SDR white are flattened to white.'
    : 'This screen is in HDR, and this version of Windows shares a whole HDR screen far too bright. Share the game or app window instead, which is converted to SDR properly, or update Windows 11 to 24H2 or newer.';
}

async function loadShareSources() {
  const grid = $('#shGrid');
  grid.replaceChildren(h('div', { class: 'chan-empty', text: 'Finding your screens and windows…' }));
  let data = null;
  try { data = await appShell.shareSources(); } catch { data = null; }
  if (!data || !Array.isArray(data.sources)) { grid.replaceChildren(h('div', { class: 'chan-empty', text: 'Could not list your screens and windows.' })); return; }
  shareHdrOk = data.hdrScreensConverted !== false;
  $('#shAudioRow').hidden = !data.audio;   // a Mac app gets a screen's picture but not its sound
  const before = sharePick && data.sources.find((s) => s.id === sharePick.id);
  sharePick = before ? { id: before.id, name: before.name, hdr: !!before.hdr } : null;
  const tile = (s) => {
    const el = h('button', { class: 'share-source' + (sharePick && sharePick.id === s.id ? ' selected' : ''), type: 'button', role: 'option', title: s.name,
      onclick: () => {
        sharePick = { id: s.id, name: s.name, hdr: !!s.hdr };
        for (const other of grid.querySelectorAll('.selected')) other.classList.remove('selected');
        el.classList.add('selected');
        $('#shGo').disabled = false;
        explainShareHdr();
      },
      ondblclick: () => { sharePick = { id: s.id, name: s.name, hdr: !!s.hdr }; $('#shGo').click(); } },
    s.thumbnail ? h('img', { src: s.thumbnail, alt: '' }) : h('span', { class: 'share-blank' }),
    h('span', { class: 'share-name', text: s.name }),
    s.hdr ? h('em', { class: 'share-hdr', text: 'HDR' }) : null);
    return el;
  };
  const screens = data.sources.filter((s) => s.screen);
  const windows = data.sources.filter((s) => !s.screen);
  grid.replaceChildren(
    ...(screens.length ? [h('div', { class: 'share-group', text: 'Screens' }), ...screens.map(tile)] : []),
    ...(windows.length ? [h('div', { class: 'share-group', text: 'Windows' }), ...windows.map(tile)] : []));
  $('#shGo').disabled = !sharePick;
  explainShareHdr();
}

function openShareDialog() {
  if (!rtc.channel) { toast('Join a voice channel or a call first.'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast(window.isSecureContext ? 'This browser cannot share the screen.' : 'Screen share needs the secure (https) address.');
    return;
  }
  const live = !!rtc.screen;
  const o = live ? rtc.screen.opts : shareOpts;
  $('#shRes').value = String(o.height);
  $('#shFps').value = String(o.fps);
  $('#shMode').value = o.mode;
  $('#shRate').value = String(o.bitrate);
  $('#shCodec').value = o.codec;
  $('#shAudio').checked = !!o.audio;
  $('#shCodec').disabled = $('#shAudio').disabled = live;
  $('#shareTitle').textContent = live ? 'Stream settings' : 'Share your screen';
  const inOne = shareInOne() && !live;
  $('#shSources').hidden = !inOne;
  $('#shareDlg').classList.toggle('share-wide', inOne);
  $('#shAudioRow').hidden = false;
  $('#shHint').textContent = inOne ? 'A stream is never upscaled: 4K needs a 4K screen or window. Sound shares everything your computer plays.' : SHARE_HINT;
  $('#shGo').textContent = live ? 'Apply' : inOne ? 'Go live' : 'Choose what to share';
  $('#shGo').disabled = false;
  if (inOne) loadShareSources();
  $('#shStop').hidden = !live;
  $('#shGpu').textContent = '';
  refreshGpuLine();
  $('#shareDlg').showModal();
}

$('#shRes').addEventListener('change', refreshGpuLine);
$('#shFps').addEventListener('change', refreshGpuLine);

$('#shareForm').addEventListener('submit', (event) => {
  const action = event.submitter ? event.submitter.value : 'go';
  if (action === 'stop') { endShare(); return; }
  if (action !== 'go') return;
  const opts = {
    height: $('#shRes').value === 'auto' ? 'auto' : +$('#shRes').value, fps: +$('#shFps').value, mode: $('#shMode').value,
    bitrate: +$('#shRate').value, codec: $('#shCodec').value, audio: $('#shAudio').checked,
  };
  if (rtc.screen) { Object.assign(shareOpts, opts, { codec: shareOpts.codec, audio: shareOpts.audio }); retuneShare(opts); }
  else if (shareInOne()) {
    if (!sharePick) { event.preventDefault(); toast('Pick a screen or window to share.'); return; }
    Object.assign(shareOpts, opts);
    const pick = sharePick;
    // The app is told what to share, then the share is asked for (still inside the click, which it needs).
    appShell.shareChoose({ id: pick.id, name: pick.name, audio: opts.audio && !$('#shAudioRow').hidden }).then(() => startShare(opts), () => startShare(opts));
  } else { Object.assign(shareOpts, opts); startShare(opts); }   // called inside the click so the picker may open
  store.set('share', shareOpts);
});

/* ---------- voice: stage ---------- */

const tiles = new Map();   // "user:<id>" and "screen:<id>" -> element
let expanded = null;       // the tile filling the window, if one is (see toggleExpand)

function toggleFullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
}

function personTile(u) {
  const mine = u.id === state.me.id;
  const marks = h('span', { class: 'person-marks' });
  const status = h('div', { class: 'person-state' });
  const slider = h('input', { type: 'range', min: '0', max: '1', step: '0.01', title: 'Volume' });
  slider.value = String(volumes[u.id] ?? 1);
  slider.addEventListener('input', () => {
    volumes[u.id] = +slider.value;
    store.set('volumes', volumes);
    const peer = rtc.peers.get(u.id);
    if (peer && peer.audio) peer.audio.volume = +slider.value;
  });
  const pic = avatar(u, 'lg');
  pic.dataset.person = u.id;
  pic.addEventListener('click', () => openCard(u, pic));
  // Their camera, laid over the tile while it is on. Your own is mirrored, the way a mirror would show you.
  const cam = h('video', { class: 'person-cam', autoplay: true, playsInline: true, title: 'Click to focus, double-click for full screen' });
  cam.muted = true;
  const el = h('div', { class: 'tile person' + (mine ? ' mine' : ''), title: nick(u), dataset: { speak: u.id } },
    pic,
    cam,
    h('div', { class: 'person-name' }, h('span', { text: mine ? 'You' : nick(u) }), marks),
    status,
    h('span', { class: 'live-badge person-live', text: 'LIVE', title: mine ? 'You are sharing your screen' : 'Sharing their screen' }),
    h('span', { class: 'person-spin', title: 'Connecting…', 'aria-label': 'Connecting' }),
    h('button', { class: 'ctl tile-back', type: 'button', title: 'Back (Esc)', onclick: () => toggleExpand(el) }, icon('shrink')),
    h('button', { class: 'ctl person-full', type: 'button', title: 'Full screen', onclick: () => toggleFullscreen(el) }, icon('expand')),
    mine ? null : h('div', { class: 'person-vol' }, icon('speaker'), slider));
  // The tile takes the camera's shape once its size is known, and again if the sender turns their phone.
  for (const name of ['loadedmetadata', 'resize']) cam.addEventListener(name, () => camShape(el, cam));
  // One click focuses the camera, two go full screen: the first waits a moment to see whether a second follows.
  let clickWait = 0;
  cam.addEventListener('click', () => { clearTimeout(clickWait); clickWait = setTimeout(() => toggleCamFocus(u.id), 220); });
  // In a voice channel a double-click fills the window with it (Esc, or the button top-left, goes back); in a call,
  // full screen as before.
  cam.addEventListener('dblclick', () => { clearTimeout(clickWait); if (channelById(rtc.channel)) toggleExpand(el); else toggleFullscreen(el); });
  el.parts = { marks, status, cam };
  return el;
}

function screenTile(u) {
  const mine = u.id === state.me.id;
  // Your own whole-screen share starts without its preview (see startShare); this brings it back.
  const show = mine ? h('button', { class: 'btn', type: 'button', hidden: true,
    onclick: () => { if (rtc.screen) { rtc.screen.preview = true; syncStage(); } } }, icon('eye'), 'Show my preview') : null;
  const video = h('video', { autoplay: true, playsInline: true });
  video.muted = mine;
  const who = h('span', { class: 'tile-who' });
  // Your own share: its numbers, then "2 watching", which lists who on hover.
  const statText = h('span');
  const watchers = mine ? h('span', { class: 'watchers', hidden: true }) : null;
  const stat = h('span', { class: 'stat' }, mine ? [statText, watchers] : null);
  const note = h('div', { class: 'cta-text' });
  const slider = h('input', { type: 'range', class: 'vol', min: '0', max: '1', step: '0.01', title: 'Stream volume' });
  slider.value = String(volumes['screen:' + u.id] ?? 1);
  video.volume = +slider.value;
  slider.addEventListener('input', () => {
    video.volume = +slider.value;
    volumes['screen:' + u.id] = +slider.value;
    store.set('volumes', volumes);
  });
  const el = h('div', { class: 'tile screen' + (mine ? ' mine' : '') },
    video,
    h('div', { class: 'tile-tag' }, h('span', { class: 'live-badge', text: 'LIVE' }), who, stat),
    h('div', { class: 'tile-cta' }, note,
      mine ? show : h('button', { class: 'btn primary', type: 'button', onclick: () => watch(u.id, true) }, 'Watch stream')),
    mine ? null : h('button', { class: 'ctl tile-close', type: 'button', title: 'Stop watching', onclick: () => { if (expanded === el) toggleExpand(el); watch(u.id, false); } }, icon('x')),
    // Full screen (the whole monitor), beside the x while watching; Esc or this again leaves it.
    mine ? null : h('button', { class: 'ctl tile-full', type: 'button', title: 'Full screen', onclick: () => toggleFullscreen(el) }, icon('expand')),
    h('button', { class: 'ctl tile-back', type: 'button', title: 'Back (Esc)', onclick: () => toggleExpand(el) }, icon('shrink')),
    h('div', { class: 'tile-bar' },
      mine ? null : icon('speaker'), mine ? null : slider,
      h('span', { class: 'spacer' }),
      mine ? h('button', { class: 'ctl', type: 'button', title: 'Stream settings', onclick: openShareDialog }, icon('sliders')) : null,
      // No full screen for your own share: showing your own screen full size makes it film itself.
      mine ? null : h('button', { class: 'ctl bar-full', type: 'button', title: 'Full screen', onclick: () => toggleFullscreen(el) }, icon('expand'))));
  // Double-click: in a voice channel it fills the window (Esc, or the button top-left, goes back); in a call, full
  // screen as before.
  if (!mine) video.addEventListener('dblclick', () => { if (channelById(rtc.channel)) toggleExpand(el); else toggleFullscreen(el); });
  for (const name of ['loadedmetadata', 'resize']) video.addEventListener(name, () => queueStageLayout());
  // The pointer resting on the share for a moment hides its labels and controls (and itself), as when watching a
  // video; moving it brings them back. Not while it rests on the labels or controls themselves.
  let resting = 0;
  const wake = () => {
    el.classList.remove('still');
    clearTimeout(resting);
    resting = setTimeout(() => { if (!el.querySelector('.tile-tag .watchers:hover, .tile-bar:hover')) el.classList.add('still'); }, 2500);
  };
  el.addEventListener('pointermove', wake);
  el.addEventListener('pointerleave', () => { clearTimeout(resting); el.classList.remove('still'); });
  applyOutput(video);
  el.parts = { video, who, stat, note, show, statText: mine ? statText : null, watchers };
  return el;
}

// "2 watching" on your share, listing who on hover; drawn again only when who is watching changes.
function showWatchers(tile, viewers) {
  const el = tile.parts.watchers;
  const ids = viewers.map((p) => p.id).join();
  if (el.dataset.ids === ids) return;
  el.dataset.ids = ids;
  el.hidden = !viewers.length;
  const people = viewers.map((p) => state.users.get(p.id)).filter(Boolean);
  el.replaceChildren(` · ${viewers.length} watching`, h('span', { class: 'watch-list' },
    h('span', { class: 'watch-h', text: 'Watching' }), people.map((u) => h('span', { class: 'watch-who' }, avatar(u, 'xs'), nick(u)))));
}

function rebuildStage() {
  for (const el of tiles.values()) el.remove();
  tiles.clear();
  syncStage();
}

function syncStage() {
  const people = rtc.channel ? usersIn(rtc.channel) : [];
  // In a voice channel, a camera goes on the stage with the screen shares; everyone else gets a card. A one-on-one
  // call keeps everyone together in its own layout.
  const onStage = !!rtc.channel && !!channelById(rtc.channel);
  const wanted = new Set();
  for (const u of people) {
    wanted.add('user:' + u.id);
    if (u.sharing) wanted.add('screen:' + u.id);
  }
  for (const [key, el] of tiles) if (!wanted.has(key)) { el.remove(); tiles.delete(key); }

  let streams = 0;
  let cameras = 0;
  for (const u of people) {
    const mine = u.id === state.me.id;
    const peer = rtc.peers.get(u.id);

    let el = tiles.get('user:' + u.id);
    if (!el) { el = personTile(u); tiles.set('user:' + u.id, el); $('#people').append(el); }
    el.classList.toggle('speaking', rtc.speaking.has(u.id));
    el.parts.marks.replaceChildren(...[voiceMarks(u)].filter(Boolean));
    const linking = !mine && (!peer || peer.pc.connectionState !== 'connected');
    el.parts.status.textContent = linking ? 'Connecting…' : u.sharing ? (mine ? 'Sharing your screen' : 'Sharing their screen') : '';
    el.classList.toggle('linking', linking);
    el.classList.toggle('sharing', !!u.sharing);
    const camera = !u.camera ? null : mine ? (rtc.camera ? rtc.camera.stream : null) : (peer ? peer.cameraStream : null);
    if (el.parts.cam.srcObject !== (camera || null)) {
      el.parts.cam.srcObject = camera || null;
      camShape(el, null);   // 16:9 until the new picture's first frame says its shape
      if (camera) el.parts.cam.play().catch(() => {});
    }
    el.classList.toggle('has-cam', !!camera);
    if (camera) cameras++;
    const home = onStage && camera ? $('#streams') : $('#people');
    if (el.parentElement !== home) {
      if (!camera && expanded === el) toggleExpand(el);
      el.style.removeProperty('width');    // a card again: its size from the cards' layout, not the stage's
      el.style.removeProperty('height');
      home.append(el);
    }

    if (!u.sharing) continue;
    streams++;
    let tile = tiles.get('screen:' + u.id);
    if (!tile) { tile = screenTile(u); tiles.set('screen:' + u.id, tile); $('#streams').append(tile); }
    const ownHidden = mine && !!rtc.screen && !rtc.screen.preview;
    const stream = mine ? (rtc.screen && rtc.screen.preview ? rtc.screen.stream : null) : (peer && peer.watching ? peer.screenStream : null);
    const { video } = tile.parts;
    if (video.srcObject !== (stream || null)) {
      video.srcObject = stream || null;
      if (stream) video.play().catch(() => {});
      else (tile.parts.statText || tile.parts.stat).textContent = '';
    }
    video.muted = mine || rtc.deafened;
    const waiting = !mine && !!peer && peer.watching && !stream;
    tile.classList.toggle('playing', !!stream);
    tile.classList.toggle('pending', waiting);
    tile.parts.who.textContent = mine ? 'Your screen' : `${nick(u)}'s screen`;
    tile.parts.note.textContent = waiting ? 'Connecting to the stream…'
      : ownHidden ? (rtc.screen.whole
        ? 'You are sharing your whole screen. Your own preview stays hidden here, or the screen would show itself over and over.'
        : 'You are sharing a window. Your own preview stays hidden here to save your computer the work.')
      : `${nick(u)} is sharing their screen`;
    if (tile.parts.show) tile.parts.show.hidden = !ownHidden;
  }

  // The cards in a steady order, as on the iPhone: your own first, then everyone by name.
  const cards = $('#people');
  const order = people.filter((u) => u.id === state.me.id).concat(people.filter((u) => u.id !== state.me.id))
    .map((u) => tiles.get('user:' + u.id)).filter((el) => el && el.parentElement === cards);
  if (order.some((el, i) => cards.children[i] !== el)) for (const el of order) cards.append(el);
  $('#stage').classList.toggle('has-streams', streams > 0);
  $('#stage').classList.toggle('has-cams', cameras > 0);
  $('#stage').classList.toggle('has-video', onStage && streams + cameras > 0);
  if (expanded && (!expanded.isConnected || $('#voiceView').hidden)) toggleExpand(expanded);
  // A one-on-one call gets the compact look: round pictures in a row and a small control bar.
  $('#voiceView').classList.toggle('call', !!rtc.channel && !channelById(rtc.channel));
  $('#streams').style.setProperty('--cols', streams <= 1 ? 1 : streams <= 4 ? 2 : 3);
  if (state.view.type === 'voice') {
    $('#headSub').replaceChildren(people.length === 1 ? '1 person' : `${people.length} people`,
      h('span', { class: 'room-time', dataset: { room: rtc.channel || '' } }));
    paintVoiceClocks();
  }
  placeCallPanel();
  syncPip();
  layoutCams();
  layoutStage();
}

/* ---------- voice channel: cards, and the stage ---------- */

// Nobody has video: a grid of cards, 1 column for one person, 2 up to four, 3 up to nine, else 4; 16:10, at most
// 460px wide, as big as the space allows. Video: every camera and screen share on the stage in its own shape, the
// column count that shows them biggest; the cards go in a column beside it (a row under it when the window is narrow).
function stageRatio(el) {
  const video = el.classList.contains('screen') ? el.parts.video : el.parts.cam;
  if (el.classList.contains('screen') && !el.classList.contains('playing')) return 0;   // the offer fills its space
  return video && video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
}

function layoutStage() {
  const stage = $('#stage');
  const people = $('#people');
  const area = $('#streams');
  const channel = !!rtc.channel && !!channelById(rtc.channel);
  if (!channel || $('#voiceView').hidden) return;
  stage.classList.toggle('narrow', stage.clientWidth < 720);
  if (!stage.classList.contains('has-video')) {
    const n = people.children.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    const rows = Math.ceil(n / cols) || 1;
    const gap = 10;
    const w = Math.min(460, (people.clientWidth - gap * (cols - 1)) / cols, (people.clientHeight - gap * (rows - 1)) / rows * 1.6);
    people.style.setProperty('--card-w', Math.floor(Math.max(120, w)) + 'px');
    return;
  }
  const items = [...area.children].filter((el) => el !== expanded);
  const gap = 12;
  const width = area.clientWidth;
  const height = area.clientHeight;
  if (!items.length || !width || !height) return;
  const ratios = items.map(stageRatio);
  let best = null;
  for (let cols = 1; cols <= items.length; cols++) {
    const rows = Math.ceil(items.length / cols);
    const bw = (width - gap * (cols - 1)) / cols;
    const bh = (height - gap * (rows - 1)) / rows;
    if (bw <= 0 || bh <= 0) continue;
    const sizes = ratios.map((r) => (!r ? [bw, bh] : r > bw / bh ? [bw, bw / r] : [bh * r, bh]));
    const shown = sizes.reduce((sum, [w, h]) => sum + w * h, 0);
    if (!best || shown > best.shown) best = { shown, sizes };
  }
  if (!best) return;
  items.forEach((el, i) => {
    el.style.width = Math.floor(best.sizes[i][0]) + 'px';
    el.style.height = Math.floor(best.sizes[i][1]) + 'px';
  });
}
let stageQueued = false;
function queueStageLayout() {
  if (stageQueued) return;
  stageQueued = true;
  requestAnimationFrame(() => { stageQueued = false; layoutStage(); });
}
new ResizeObserver(() => queueStageLayout()).observe($('#stage'));

// A share or a camera filling the window (a double-click on it); the button top-left, Esc or a second double-click
// puts it back (expanded: that tile, declared with the other tiles).
function toggleExpand(el) {
  if (expanded && expanded !== el) expanded.classList.remove('expanded');
  expanded = expanded === el ? null : el;
  el.classList.toggle('expanded', expanded === el);
  if (expanded) { el.style.removeProperty('width'); el.style.removeProperty('height'); }
  queueStageLayout();
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && expanded && !document.fullscreenElement && !document.querySelector('dialog[open]')) toggleExpand(expanded);
});

/* ---------- voice: cameras as big as the space allows ---------- */

// While cameras are on and no screen is being shared, every tile takes the 16:9 shape and the grid picks the
// column count that makes them biggest. Clicking a camera puts it in focus: it fills the space, with everyone
// else in a strip underneath; clicking it again, or Escape, goes back. Double-click, or the button in its
// corner, for full screen.
let camFocus = null;   // id of the person whose camera is in focus

// A camera's shape, for the CSS: --cam-ratio ("1080 / 1920") and --cam-r (width over height). A phone held upright
// sends a tall picture, a webcam a wide one; never assumed from the device, always read from the picture. Without a
// picture yet, the tile is 16:9.
function camShape(tile, video) {
  const w = video ? video.videoWidth : 0;
  const h = video ? video.videoHeight : 0;
  if (!w || !h) {
    tile.style.removeProperty('--cam-ratio');
    tile.style.removeProperty('--cam-r');
    tile.classList.remove('tall-cam');
    return;
  }
  tile.style.setProperty('--cam-ratio', `${w} / ${h}`);
  tile.style.setProperty('--cam-r', (w / h).toFixed(4));
  tile.classList.toggle('tall-cam', h > w);
  queueStageLayout();
}

function layoutCams() {
  const people = $('#people');
  const stage = $('#stage');
  const gallery = !$('#voiceView').hidden && $('#voiceView').classList.contains('call') && stage.classList.contains('has-cams')
    && !stage.classList.contains('has-streams') && !callAboveShown();
  const tiles = [...people.children];
  const focused = gallery && camFocus ? tiles.find((el) => el.dataset.speak === camFocus && el.classList.contains('has-cam')) : null;
  if (!focused) camFocus = null;
  const focusing = !!focused && tiles.length > 1;
  people.classList.toggle('gallery', gallery);
  people.classList.toggle('focusing', focusing);
  for (const el of tiles) el.classList.toggle('focused', el === focused);
  if (!gallery) return;
  const gap = 12;
  const width = people.clientWidth;
  const height = people.clientHeight;
  if (!width || !height) return;
  if (focusing) {
    people.style.setProperty('--focus-w', Math.floor(Math.max(160, Math.min(width, (height - 90 - gap) * 16 / 9))) + 'px');
    return;
  }
  let best = 0;
  for (let cols = 1; cols <= tiles.length; cols++) {
    const rows = Math.ceil(tiles.length / cols);
    best = Math.max(best, Math.min((width - gap * (cols - 1)) / cols, (height - gap * (rows - 1)) / rows * 16 / 9));
  }
  people.style.setProperty('--tile-w', Math.floor(Math.max(120, best)) + 'px');
}
new ResizeObserver(() => layoutCams()).observe($('#people'));

function toggleCamFocus(id) {
  if (!$('#people').classList.contains('gallery')) return;
  camFocus = camFocus === id ? null : id;
  layoutCams();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && camFocus && !document.fullscreenElement && !document.querySelector('dialog[open]')) {
    camFocus = null;
    layoutCams();
  }
});

/* ---------- voice: the floating camera preview ---------- */

// While you are in voice and someone else has a camera on, but you are looking at a text channel, a message
// thread or friends, a small picture of them floats over the window (top right at first; drag it anywhere).
// Everyone in the room gets it, camera on or not. It never shows your own camera. With several cameras on,
// it fades over to another person only when their microphone picks them up.
const pip = { uid: null, stream: null, front: 0, since: 0, place: store.get('pip', { fx: 1, fy: 0 }), grab: null };

function cameraFeeds() {
  const feeds = [];
  if (!rtc.channel) return feeds;
  for (const u of usersIn(rtc.channel)) {
    if (!u.camera || u.id === state.me.id) continue;   // other people's cameras only
    const peer = rtc.peers.get(u.id);
    if (peer && peer.cameraStream) feeds.push({ user: u, stream: peer.cameraStream });
  }
  return feeds;
}

// Stay with the person on screen while they talk, and for a moment after, so it does not flicker between
// people in a lively conversation. Otherwise go to someone else who is talking.
function pickFeed(feeds) {
  const talking = (feed) => rtc.speaking.has(feed.user.id);
  const current = feeds.find((feed) => feed.user.id === pip.uid);
  if (current && (talking(current) || performance.now() - pip.since < 1500)) return current;
  return feeds.find(talking) || current || feeds[0];
}

function placePip() {
  const el = $('#pip');
  const top = $('#titlebar').offsetHeight + 8;
  const freeX = Math.max(0, innerWidth - el.offsetWidth - 16 - railWidth);
  const freeY = Math.max(0, innerHeight - el.offsetHeight - top - 8);
  el.style.left = railWidth + 8 + Math.min(1, Math.max(0, pip.place.fx)) * freeX + 'px';
  el.style.top = top + Math.min(1, Math.max(0, pip.place.fy)) * freeY + 'px';
}

// The floating preview takes the shape of the picture showing in it: 272px wide for a wide camera, 272px tall for a
// tall one.
function pipShape() {
  const el = $('#pip');
  const video = $$('#pip video')[pip.front];
  const w = video ? video.videoWidth : 0;
  const h = video ? video.videoHeight : 0;
  const before = el.style.getPropertyValue('--pip-ratio');
  if (w && h) el.style.setProperty('--pip-ratio', `${w} / ${h}`); else el.style.removeProperty('--pip-ratio');
  el.classList.toggle('tall', !!(w && h && h > w));
  if (!el.hidden && el.style.getPropertyValue('--pip-ratio') !== before) placePip();   // still inside the window
}
for (const video of $$('#pip video')) for (const name of ['loadedmetadata', 'resize']) video.addEventListener(name, pipShape);

function syncPip() {
  const el = $('#pip');
  const feeds = state.view.type === 'voice' || callAboveShown() ? [] : cameraFeeds();
  const videos = $$('#pip video');
  if (!feeds.length) {
    if (el.hidden) return;
    el.hidden = true;
    for (const video of videos) { video.srcObject = null; video.classList.remove('on'); }
    pip.uid = pip.stream = null;
    return;
  }
  const feed = pickFeed(feeds);
  if (el.hidden) { el.hidden = false; placePip(); }
  if (pip.uid !== feed.user.id || pip.stream !== feed.stream) {
    const next = videos[1 - pip.front];
    const last = videos[pip.front];
    next.srcObject = feed.stream;
    next.play().catch(() => {});
    next.classList.add('on');      // the two pictures cross-fade
    last.classList.remove('on');
    setTimeout(() => { if (!last.classList.contains('on')) last.srcObject = null; }, 600);
    Object.assign(pip, { uid: feed.user.id, stream: feed.stream, front: 1 - pip.front, since: performance.now() });
    $('#pipName').textContent = feed.user.name;
    pipShape();
  }
  el.classList.toggle('speaking', rtc.speaking.has(feed.user.id));
}

{
  const el = $('#pip');
  $('#pipOpen').replaceChildren(icon('expand'));
  $('#pipOpen').addEventListener('click', () => rtc.channel && showVoice(rtc.channel));
  el.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    pip.grab = { x: event.clientX - el.offsetLeft, y: event.clientY - el.offsetTop };
    try { el.setPointerCapture(event.pointerId); } catch { /* the drag still works while the pointer stays over it */ }
  });
  el.addEventListener('pointermove', (event) => {
    if (!pip.grab) return;
    const top = $('#titlebar').offsetHeight + 8;
    const freeX = Math.max(1, innerWidth - el.offsetWidth - 16 - railWidth);
    const freeY = Math.max(1, innerHeight - el.offsetHeight - top - 8);
    pip.place = { fx: (event.clientX - pip.grab.x - 8 - railWidth) / freeX, fy: (event.clientY - pip.grab.y - top) / freeY };
    placePip();
  });
  for (const name of ['pointerup', 'pointercancel']) {
    el.addEventListener(name, () => {
      if (!pip.grab) return;
      pip.grab = null;
      pip.place = { fx: Math.min(1, Math.max(0, pip.place.fx)), fy: Math.min(1, Math.max(0, pip.place.fy)) };
      store.set('pip', pip.place);
    });
  }
  window.addEventListener('resize', () => { if (!el.hidden) placePip(); });
}

function updateControls() {
  const inVoice = !!rtc.channel;
  const micOff = rtc.muted || (inVoice && !rtc.mic) || voiceLocked();
  const deaf = rtc.deafened || !!(self() && self().serverDeafened);
  const spec = {
    mic: () => [icon('mic', micOff), voiceLocked() ? 'Muted by an admin' : micOff ? 'Unmute' : 'Mute', micOff ? 'on' : ''],
    deafen: () => [icon('headphones', deaf), self() && self().serverDeafened ? 'Deafened by an admin' : deaf ? 'Undeafen' : 'Deafen', deaf ? 'on' : ''],
    share: () => [icon('screen'), rtc.screen ? 'Sharing' : 'Share screen', rtc.screen ? 'live' : ''],
    camera: () => [icon('camera', inVoice && !rtc.camera), rtc.camera ? 'Stop camera' : 'Camera', rtc.camera ? 'live' : ''],
    leave: () => [icon('hangup'), channelById(rtc.channel) || !inVoice ? 'Leave' : 'Hang up', ''],
    settings: () => [icon('sliders'), 'Settings', ''],
    attach: () => [icon('clip'), 'Attach a file', ''],
    emoji: () => [icon('smile'), 'Emoji', ''],
    favorites: () => [icon('star'), 'Favorites', ''],
    menu: () => [icon('menu'), 'Menu', ''],
  };
  for (const button of $$('button[data-act]')) {
    const make = spec[button.dataset.act];
    if (!make) continue;
    const [glyph, label, mode] = make();
    button.classList.toggle('on', mode === 'on');
    button.classList.toggle('live', mode === 'live');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.replaceChildren(glyph, ...(button.classList.contains('dock-btn') ? [h('span', { text: label })] : []));
  }
  $('#sendBtn').replaceChildren(icon('send'));
  $('#replyCancel').replaceChildren(icon('x'));
  $('#micNote').hidden = !inVoice || !!rtc.mic;
  $('#micNoteText').textContent = micHelp();
  $('#micEnable').textContent = micBlockedByPreview() ? 'Copy address' : 'Enable microphone';
  $('#voicePanel').hidden = !inVoice;
  $('#vpChan').textContent = inVoice ? roomLabel(rtc.channel) : '';
  renderElsewhere();
}

$('#micEnable').addEventListener('click', () => {
  if (!micBlockedByPreview()) { toggleMic(); return; }
  const done = () => toast('Address copied. Paste it into Chrome or Edge.');
  const manual = () => toast(`Type ${location.origin} into Chrome or Edge.`, 8000);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(location.origin).then(done, manual);
  else manual();
});

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]');
  if (!target) return;
  const actions = {
    mic: toggleMic, deafen: toggleDeafen, share: openShareDialog, leave: leaveVoice, settings: openSettings,
    camera: () => toggleCamera(),
    attach: () => $('#file').click(),
    emoji: () => togglePopover('emoji', drawEmojiPicker),
    favorites: () => togglePopover('favorites', drawFavorites),
    menu: () => $('#app').classList.toggle('drawer'),
    stage: () => rtc.channel && showVoice(rtc.channel),
    me: () => openCard(self(), target),
  };
  const run = actions[target.dataset.act];
  if (run) run();
});

/* ---------- voice: speaking indicator, stats, sounds ---------- */

const samples = new Float32Array(512);
const lastLoud = new Map();

function loudness(analyser) {
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function markSpeaking(id, level, now) {
  if (level > 0.015) lastLoud.set(id, now);
  const on = now - (lastLoud.get(id) || -1e9) < 350;
  if (on === rtc.speaking.has(id)) return;
  if (on) rtc.speaking.add(id); else rtc.speaking.delete(id);
  for (const el of $$(`[data-speak="${id}"]`)) el.classList.toggle('speaking', on);
}

setInterval(() => {
  if (!rtc.channel || !state.me) return;
  const now = performance.now();
  markSpeaking(state.me.id, rtc.mic && rtc.mic.analyser && !rtc.muted ? loudness(rtc.mic.analyser) : 0, now);
  for (const peer of rtc.peers.values()) markSpeaking(peer.id, peer.analyser ? loudness(peer.analyser) : 0, now);
  if (!$('#pip').hidden) syncPip();   // follow whoever is talking
}, 80);

async function videoStats(source, holder, direction) {
  const report = await source.getStats();
  const codecs = {};
  let rtp = null;
  report.forEach((s) => {
    if (s.type === 'codec') codecs[s.id] = s.mimeType;
    if (s.type === direction + '-rtp' && s.kind === 'video') rtp = s;
  });
  if (!rtp) return null;
  const inbound = direction === 'inbound';
  const bytes = inbound ? rtp.bytesReceived : rtp.bytesSent;
  const prev = holder.statPrev;
  holder.statPrev = { bytes, at: rtp.timestamp };
  return {
    width: rtp.frameWidth, height: rtp.frameHeight,
    fps: Math.round(rtp.framesPerSecond || 0),
    frames: (inbound ? rtp.framesDecoded : rtp.framesEncoded) || 0,
    mbps: prev && rtp.timestamp > prev.at ? (bytes - prev.bytes) * 8 / (rtp.timestamp - prev.at) / 1000 : 0,
    codec: (codecs[rtp.codecId] || '').replace(/^video\//i, ''),
    hardware: inbound ? rtp.powerEfficientDecoder : rtp.powerEfficientEncoder,   // true = graphics card, false = CPU
    limit: rtp.qualityLimitationReason,
  };
}

function statLine(s, sending) {
  if (!s || !s.width) return 'Starting…';
  const parts = [`${s.width}×${s.height}`, `${s.fps} fps`, `${s.mbps.toFixed(1)} Mbps`];
  let codec = s.codec;
  if (codec && s.hardware === true) codec += sending ? ` · ${gpuInfo().engine || 'GPU'}` : ' · GPU';
  if (codec && s.hardware === false) codec += ' · CPU';
  if (codec) parts.push(codec);
  if (s.limit && s.limit !== 'none') parts.push(`limited by ${s.limit}`);
  return parts.join(' · ');
}

setInterval(async () => {
  if (!rtc.channel) return;
  try {
    for (const peer of rtc.peers.values()) {
      const tile = tiles.get('screen:' + peer.id);
      const track = peer.watching && peer.screenStream ? peer.screenStream.getVideoTracks()[0] : null;
      const receiver = track && peer.pc.getReceivers().find((r) => r.track === track);
      if (tile && receiver) {
        const stats = await videoStats(receiver, peer.inStat, 'inbound');
        tile.parts.stat.textContent = stats && stats.width ? `${stats.width}×${stats.height} · ${stats.fps} fps` : 'Starting…';
        tile.parts.stat.title = statLine(stats, false);
      }
    }
    const mine = rtc.screen && tiles.get('screen:' + state.me.id);
    if (!mine) return;
    const viewers = [...rtc.peers.values()].filter((p) => p.screenTx.length);
    let first = null;
    for (const peer of viewers) {
      const stats = await videoStats(peer.screenTx[0].sender, peer.outStat, 'outbound');
      if (!first) first = stats;
      guardEncoder(peer, stats);
    }
    if (!rtc.screen) return;
    const size = rtc.screen.videoTrack.getSettings();
    mine.parts.statText.textContent = viewers.length
      ? statLine(first, true)
      : `${size.width}×${size.height} · ${Math.round(size.frameRate || 0)} fps · nobody watching yet`;
    showWatchers(mine, viewers);
  } catch { /* a connection closed mid-read */ }
}, 1000);

function tones(freqs, step, volume = 0.06) {
  if (!settings.sounds || rtc.deafened) return;
  const ctx = audio();
  if (!ctx || ctx.state !== 'running') return;
  freqs.forEach((freq, i) => {
    const at = ctx.currentTime + i * step;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(volume, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + step + 0.1);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + step + 0.12);
  });
}

// join and leave: someone comes into or goes from the voice channel; message: a new message; share-start and
// share-end: a screen share in the channel (yours or someone's) starts or ends; viewer: someone starts watching yours.
const BLIPS = {
  join: [[523, 784], 0.09], leave: [[659, 440], 0.09], message: [[880, 1175], 0.09],
  'share-start': [[587, 784, 1175], 0.07], 'share-end': [[1175, 784, 587], 0.07], viewer: [[988, 1319], 0.06],
};
function blip(kind) {
  const [freqs, step] = BLIPS[kind] || BLIPS.message;
  tones(freqs, step);
}

/* ---------- settings and profile ---------- */

let draft = null;   // picture and banner chosen in the open settings dialog, not saved yet

function renderDraft() {
  const me = self();
  const preview = { name: me.name, avatar: draft.avatar, banner: draft.banner, fit: draft.avatarFit };
  const banner = $('#peBanner');
  banner.style.setProperty('--c', colorOf(me.name));
  const bannerImg = draft.banner ? h('img', { src: draft.banner, alt: '' }) : null;
  if (bannerImg) applyFit(bannerImg, draft.bannerFit);
  banner.replaceChildren(...(bannerImg ? [bannerImg] : []));
  banner.classList.toggle('adjustable', !!draft.banner);
  banner.title = draft.banner ? 'Move or zoom your banner' : '';
  $('#peAvatar').replaceChildren(avatar(preview, 'lg'));
  $('#peAvatar').classList.toggle('adjustable', !!draft.avatar);
  $('#peAvatar').title = draft.avatar ? 'Move or zoom your picture' : '';
  $('#peClear').hidden = !draft.avatar && !draft.banner;
  renderDraftColor();
}

/* name colour: any colour from the picker, one of the swatches, or the automatic one */

const NAME_COLORS = ['#f2b24a', '#ff6b6b', '#ff8fd0', '#c792ea', '#82aaff', '#5ad1e6', '#43d08a', '#c3e88d', '#ffd166', '#ffffff'];

function renderDraftColor() {
  const shown = { name: $('#setName').value.trim() || self().name, color: draft.color };
  $('#colorPreview').textContent = $('#setDisplay').value.trim() || shown.name;
  $('#colorPreview').style.color = nameColor(shown);
  $('#setColorAuto').classList.toggle('active', !draft.color);
  for (const swatch of $$('#colorSwatches button')) swatch.classList.toggle('active', swatch.dataset.color === draft.color);
  if (draft.color) $('#setColor').value = draft.color;
}

$('#colorSwatches').replaceChildren(...NAME_COLORS.map((color) => {
  const swatch = h('button', { class: 'swatch', type: 'button', title: color, dataset: { color },
    onclick: () => { draft.color = color; renderDraftColor(); } });
  swatch.style.background = color;
  return swatch;
}));
$('#setColor').addEventListener('input', (event) => { draft.color = event.target.value.toLowerCase(); renderDraftColor(); });
$('#setColorAuto').addEventListener('click', () => { draft.color = ''; renderDraftColor(); });
$('#setName').addEventListener('input', () => { if (draft) renderDraftColor(); });

async function pickProfileImage(kind, file) {
  if (!file) return;
  if (!/\.(png|apng|jpe?g|jfif|gif|webp|avif|bmp)$/i.test(file.name)) { toast('Use a PNG, JPG, JFIF, GIF, WebP or AVIF image.'); return; }
  if (file.size > 15 * 1048576) { toast('Profile images can be up to 15 MB.'); return; }
  openCropper({ file }, kind);   // placed first, then uploaded
}

/* profile picture editor: drag to move, zoom with the slider or the mouse wheel, turn in quarter steps.
   Nothing is cut out of the file. What is saved is where the picture sits inside its circle, and every
   place that shows the picture draws it that way, which keeps animated GIFs animated. */

const crop = { source: null, kind: 'avatar', url: '', w0: 0, h0: 0, vw: 280, vh: 280, zoom: 1, x: 0, y: 0, turn: 0 };

// How big the picture is drawn, and how far it may be moved before the circle would show a gap.
// At zoom 1 the picture just covers the frame: the circle for a profile picture, the 30:11 frame for a banner.
const cropBase = () => {
  const sideways = crop.turn % 180 !== 0;
  return Math.max(crop.vw / (sideways ? crop.h0 : crop.w0), crop.vh / (sideways ? crop.w0 : crop.h0));
};
function cropBounds() {
  const scale = cropBase() * crop.zoom;
  const sideways = crop.turn % 180 !== 0;
  const wide = (sideways ? crop.h0 : crop.w0) * scale;
  const tall = (sideways ? crop.w0 : crop.h0) * scale;
  return { scale, x: Math.max(0, (wide - crop.vw) / 2), y: Math.max(0, (tall - crop.vh) / 2) };
}

function drawCrop() {
  if (!crop.w0) return;
  crop.vw = $('#cropRing').clientWidth || crop.vw;
  crop.vh = $('#cropRing').clientHeight || crop.vh;
  const bounds = cropBounds();
  crop.x = Math.max(-bounds.x, Math.min(bounds.x, crop.x));
  crop.y = Math.max(-bounds.y, Math.min(bounds.y, crop.y));
  const img = $('#cropImg');
  img.style.width = crop.w0 * bounds.scale + 'px';
  img.style.height = crop.h0 * bounds.scale + 'px';
  img.style.transform = `translate(-50%, -50%) translate(${crop.x}px, ${crop.y}px) rotate(${crop.turn}deg)`;
  $('#cropZoom').value = String(crop.zoom);
  $('#cropZoom').style.setProperty('--played', (crop.zoom - 1) / 3 * 100 + '%');
}

// The placement to save: the same numbers the editor is showing, as percentages of the frame.
function cropFit() {
  const bounds = cropBounds();
  const pct = (px, of) => Math.round(px / of * 10000) / 100;
  const centre = (px, of) => Math.round((50 + px / of * 100) * 100) / 100;
  return { w: pct(crop.w0 * bounds.scale, crop.vw), h: pct(crop.h0 * bounds.scale, crop.vh), x: centre(crop.x, crop.vw), y: centre(crop.y, crop.vh), r: crop.turn };
}

function setCropZoom(zoom) {
  const before = crop.zoom;
  crop.zoom = Math.max(1, Math.min(4, zoom));
  crop.x *= crop.zoom / before;   // keeps whatever is in the middle of the circle in the middle
  crop.y *= crop.zoom / before;
  drawCrop();
}

// source is { file } for a newly chosen picture, or { url, fit } to adjust the one already in use;
// kind is 'avatar' (a circle) or 'banner' (a 30:11 frame).
function openCropper(source, kind = 'avatar') {
  const img = $('#cropImg');
  if (crop.url) URL.revokeObjectURL(crop.url);
  Object.assign(crop, { source, kind, url: source.file ? URL.createObjectURL(source.file) : '', w0: 0, h0: 0, zoom: 1, x: 0, y: 0, turn: 0 });
  $('#cropRing').classList.toggle('banner', kind === 'banner');
  $('#cropRing').classList.toggle('plate', kind === 'plate');
  img.onload = () => {
    crop.w0 = img.naturalWidth;
    crop.h0 = img.naturalHeight;
    crop.vw = $('#cropRing').clientWidth || crop.vw;
    crop.vh = $('#cropRing').clientHeight || crop.vh;
    const fit = source.fit;
    if (fit) {   // pick up where the last edit left off
      crop.turn = fit.r;
      crop.zoom = Math.max(1, Math.min(4, fit.w / 100 * crop.vw / crop.w0 / cropBase()));
      crop.x = (fit.x - 50) / 100 * crop.vw;
      crop.y = (fit.y - 50) / 100 * crop.vh;
    }
    drawCrop();
  };
  img.onerror = () => { $('#cropDlg').close(); toast('That picture could not be opened.'); };
  img.src = crop.url || source.url;
  $('#cropApply').disabled = false;
  $('#cropDlg').showModal();
}

{
  const stage = $('#cropStage');
  let grab = null;
  stage.addEventListener('pointerdown', (event) => {
    grab = { x: event.clientX - crop.x, y: event.clientY - crop.y };
    try { stage.setPointerCapture(event.pointerId); } catch { /* the drag still works while the pointer stays over it */ }
  });
  stage.addEventListener('pointermove', (event) => {
    if (!grab) return;
    crop.x = event.clientX - grab.x;
    crop.y = event.clientY - grab.y;
    drawCrop();
  });
  for (const name of ['pointerup', 'pointercancel']) stage.addEventListener(name, () => { grab = null; });
  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    setCropZoom(crop.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08));
  }, { passive: false });
  $('#cropZoom').addEventListener('input', (event) => setCropZoom(+event.target.value));
  $('#cropRotate').addEventListener('click', () => {
    crop.turn = (crop.turn + 90) % 360;
    [crop.x, crop.y] = [-crop.y, crop.x];   // the part in view turns with the picture
    drawCrop();
  });
  $('#cropReset').addEventListener('click', () => { Object.assign(crop, { zoom: 1, x: 0, y: 0, turn: 0 }); drawCrop(); });
  $('#cropSmall').replaceChildren(icon('image'));
  $('#cropLarge').replaceChildren(icon('image'));
  $('#cropRotate').replaceChildren(icon('turn'));
}

$('#cropForm').addEventListener('submit', async (event) => {
  if (!event.submitter || event.submitter.value !== 'apply') return;   // Cancel just closes the editor
  event.preventDefault();
  const source = crop.source;
  if (!source || !crop.w0 || !draft) return;
  const fit = cropFit();
  $('#cropApply').disabled = true;
  try {
    const url = source.file ? (await upload(source.file)).url : source.url;
    if (crop.kind === 'banner') { draft.banner = url; draft.bannerFit = fit; }
    else if (crop.kind === 'plate') { draft.plate = url; draft.plateFit = fit; renderPlatePicks(); }
    else { draft.avatar = url; draft.avatarFit = fit; }
    renderDraft();
    $('#cropDlg').close();
  } catch (err) {
    toast(`${source.file ? source.file.name : 'Picture'}: ${err.message}`);
  } finally { $('#cropApply').disabled = false; }
});

$('#cropDlg').addEventListener('close', () => {
  if (crop.url) URL.revokeObjectURL(crop.url);
  crop.url = '';
  crop.source = null;
  $('#cropImg').removeAttribute('src');
});

$('#peAvatar').addEventListener('click', () => {
  if (draft && draft.avatar) openCropper({ url: draft.avatar, fit: draft.avatarFit });
});
$('#peBanner').addEventListener('click', () => {
  if (draft && draft.banner) openCropper({ url: draft.banner, fit: draft.bannerFit }, 'banner');
});

$('#peAvatarBtn').addEventListener('click', () => $('#peAvatarFile').click());
$('#peBannerBtn').addEventListener('click', () => $('#peBannerFile').click());
$('#peAvatarFile').addEventListener('change', (event) => { pickProfileImage('avatar', event.target.files[0]); event.target.value = ''; });
$('#peBannerFile').addEventListener('change', (event) => { pickProfileImage('banner', event.target.files[0]); event.target.value = ''; });
$('#peClear').addEventListener('click', () => { draft.avatar = ''; draft.banner = ''; draft.avatarFit = null; draft.bannerFit = null; renderDraft(); });

async function openSettings() {
  const me = self();
  draft = { avatar: me.avatar || '', banner: me.banner || '', color: me.color || '', avatarFit: me.fit || null, bannerFit: me.bannerFit || null, plate: me.plate || '', plateFit: me.plateFit || null };
  renderPlatePicks();
  $('#setName').value = me.name;
  $('#setDisplay').value = me.display || '';
  renderDraft();
  $('#setAbout').value = me.about || '';
  $('#setNoiseMode').value = settings.noiseMode;
  $('#setEcho').checked = settings.echoCancellation;
  $('#setGain').checked = settings.autoGainControl;
  $('#setSounds').checked = settings.sounds;
  $('#setNotify').value = settings.notify;
  $('#setKeep').checked = session.keep();
  renderActivitySettings();
  renderAppCard();
  openLook();
  $('#lookPicMore').open = !!(state.theme && state.theme.image);
  $('#setGrid').scrollTop = 0;
  showMicLevel();
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* insecure page */ }
  const fill = (select, kind, current, word) => {
    const real = devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    select.replaceChildren(h('option', { value: '', text: 'System default' }),
      ...real.map((d, i) => h('option', { value: d.deviceId, text: d.label || `${word} ${i + 1}` })));
    select.value = current;
    if (select.value !== current) select.value = '';
  };
  fill($('#setInput'), 'audioinput', settings.inputId, 'Microphone');
  fill($('#setOutput'), 'audiooutput', settings.outputId, 'Speakers');
  fill($('#setCamera'), 'videoinput', settings.cameraId, 'Camera');
  renderPasskeys();
  askPasskeyMake();
  if (!$('#settingsDlg').open) {
    $('#settingsDlg').showModal();
    $('#setGrid').focus({ preventScroll: true });   // not the ✕, which the browser would otherwise ring in orange
  }
  settingsSaved = settingsState();
  syncUnsaved();
}

// Unsaved changes: everything Settings holds (its boxes, switches and lists, the picture and nameplate draft and the
// theme being tried) compared with how it was when opened or last saved. When they differ, the bar shows.
let settingsSaved = null;
// Voice and video take effect the moment they change, with no Save (see applyVoiceSettings), so they are not changes
// to save.
const VOICE_FIELDS = ['setInput', 'setOutput', 'setCamera', 'setNoiseMode', 'setEcho', 'setGain'];
function settingsState() {
  const fields = [...$('#settingsForm').querySelectorAll('input, select, textarea')]
    .filter((el) => el.id && !['file', 'button', 'submit'].includes(el.type) && !VOICE_FIELDS.includes(el.id))
    .map((el) => [el.id, el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value]);
  return JSON.stringify({ fields, draft, look });
}
function syncUnsaved() {
  const dirty = !!settingsSaved && $('#settingsDlg').open && settingsState() !== settingsSaved;
  $('#setUnsaved').classList.toggle('show', dirty);
  $('#settingsDlg').classList.toggle('dirty', dirty);
  return dirty;
}
// Anything done in Settings (or in the picture editor it opens) may change it; uploads finish on their own time.
for (const kind of ['input', 'change', 'click']) document.addEventListener(kind, () => { if ($('#settingsDlg').open) setTimeout(syncUnsaved, 0); }, true);
setInterval(() => { if ($('#settingsDlg').open) syncUnsaved(); }, 500);
function shakeUnsaved() {
  const bar = $('#setUnsaved');
  bar.classList.remove('shake');
  void bar.offsetWidth;   // lets the same animation start again
  bar.classList.add('shake');
  setTimeout(() => bar.classList.remove('shake'), 1200);
}
// Closing: not while changes are unsaved (the bar shakes, as in Discord).
$('#setClose').replaceChildren(icon('x'));
$('#setClose').addEventListener('click', () => { if (syncUnsaved()) shakeUnsaved(); else $('#settingsDlg').close(); });
$('#setReset').addEventListener('click', () => { endLook(); stopMicTest(); openSettings(); });

// Enter in a box in any dialog does what its main button does (Save, Create, Make account...), as a click on it, so
// the form's checks and handlers run the same. Never Cancel or Sign out, which come first in some dialogs and were
// what Enter used to press. In a dialog without a main button (deleting an account) Enter does nothing.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.defaultPrevented) return;
  const box = event.target instanceof Element ? event.target : null;
  const form = box && box.closest('dialog form');
  if (!form || !box.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]):not([type=range]):not([type=color]), select')) return;
  event.preventDefault();
  const main = [...form.querySelectorAll('button.primary')].find((b) => !b.disabled && !b.hidden && b.offsetParent);
  if (main) main.click();
});

$('#setSignOut').addEventListener('click', () => {
  const warn = state.guest && !state.hasPassword
    ? 'You are a guest without an account: this device is the only way back in. Sign out anyway?'
    : `Sign out of ${state.info.serverName || 'Umbryx'}?`;
  if (!confirm(warn)) return;
  stopMicTest();
  endLook();
  $('#settingsDlg').close();
  stopped = true;
  teardownVoice();
  endCallUi();
  if (session.keep()) {
    // The device stays remembered: the sign-in screen offers "Continue as", and reopening the app signs back in.
    if (ws) ws.close();
  } else {
    send({ type: 'logout', session: session.get() });
    session.clear();
  }
  showLogin();
});

// Deleting your own account: type your username and password (a guest without an account, only the username).
$('#setDelete').addEventListener('click', () => {
  $('#deleteName').value = '';
  $('#deletePass').value = '';
  $('#deletePassRow').hidden = state.guest && !state.hasPassword;
  $('#deleteNameLabel').textContent = `Type your username, ${state.me.name}, to confirm`;
  $('#deleteError').hidden = true;
  syncDelete();
  $('#deleteDlg').showModal();
  $('#deleteName').focus();
});
function syncDelete() {
  $('#deleteGo').disabled = $('#deleteName').value.trim().toLowerCase() !== state.me.name.toLowerCase()
    || (!$('#deletePassRow').hidden && !$('#deletePass').value);
}
$('#deleteName').addEventListener('input', syncDelete);
$('#deletePass').addEventListener('input', syncDelete);
$('#deleteForm').addEventListener('submit', (event) => {
  if (!event.submitter || event.submitter.value !== 'delete') return;
  event.preventDefault();   // stays open until the server signs this account out (account-deleted) or says what is wrong
  $('#deleteError').hidden = true;
  send({ type: 'account-delete', name: $('#deleteName').value.trim(), password: $('#deletePass').value });
});

$('#settingsForm').addEventListener('submit', (event) => {
  const action = event.submitter ? event.submitter.value : 'save';
  if (action !== 'save') { stopMicTest(); endLook(); return; }
  event.preventDefault();   // Settings stays open after saving, as in Discord (close it with ✕ or Esc)
  const before = JSON.stringify([settings.inputId, settings.noiseMode, settings.echoCancellation, settings.autoGainControl]);
  const cameraBefore = settings.cameraId;
  Object.assign(settings, {
    inputId: $('#setInput').value, outputId: $('#setOutput').value, cameraId: $('#setCamera').value,
    noiseMode: $('#setNoiseMode').value, noiseSuppression: $('#setNoiseMode').value !== 'off', echoCancellation: $('#setEcho').checked,
    autoGainControl: $('#setGain').checked, sounds: $('#setSounds').checked, notify: $('#setNotify').value,
  });
  store.set('settings', settings);
  // A browser asks once whether this site may show notifications; the desktop app needs no asking.
  if (!appShell && settings.notify !== 'off' && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
  const theme = normalTheme(look);
  if (JSON.stringify(theme) !== JSON.stringify(state.theme)) {
    state.theme = theme;
    send({ type: 'theme', theme });
  }
  endLook();
  if ($('#setKeep').checked !== session.keep()) session.set(session.get(), $('#setKeep').checked);
  if (!$('#setActivityField').hidden) renderActivitySettings({ share: $('#setActivity').checked, spotify: $('#setSpotifyShare').checked });
  const after = JSON.stringify([settings.inputId, settings.noiseMode, settings.echoCancellation, settings.autoGainControl]);
  if (before !== after && rtc.channel && rtc.mic) ensureMic(true);
  if (cameraBefore !== settings.cameraId && rtc.camera) { stopCamera(false); toggleCamera(); }   // switch to the newly chosen camera
  for (const peer of rtc.peers.values()) if (peer.audio) applyOutput(peer.audio);
  for (const [key, tile] of tiles) if (key.startsWith('screen:')) applyOutput(tile.parts.video);
  const me = self();
  const name = $('#setName').value.trim() || me.name;
  const about = $('#setAbout').value.trim();
  const display = $('#setDisplay').value.trim();
  if (name !== me.name || display !== (me.display || '') || draft.plate !== (me.plate || '')
      || JSON.stringify(draft.plateFit || null) !== JSON.stringify(me.plateFit || null) || draft.avatar !== (me.avatar || '') || draft.banner !== (me.banner || '') || about !== (me.about || '')
      || draft.color !== (me.color || '') || JSON.stringify(draft.avatarFit || null) !== JSON.stringify(me.fit || null)
      || JSON.stringify(draft.bannerFit || null) !== JSON.stringify(me.bannerFit || null)) {
    send({ type: 'profile', name, display, plate: draft.plate, plateFit: draft.plateFit, avatar: draft.avatar, banner: draft.banner, about, color: draft.color, avatarFit: draft.avatarFit, bannerFit: draft.bannerFit });
  }
  openLook();   // trying themes again starts from what is now saved
  settingsSaved = settingsState();
  syncUnsaved();
});

// Settings' cards stand in columns, each stacking its own cards, so none waits below a taller card beside the one
// above it (a grid's rows left gaps): three columns in a wide window, two in a narrower one, one on a phone (the
// widths match style.css's).
const SETTINGS_COLUMNS = {
  3: [['setCardProfile'], ['setPasskeys', 'setCardLook', 'setCardApp'], ['setCardVoice', 'setActivityField']],
  2: [['setCardProfile', 'setCardApp'], ['setPasskeys', 'setCardLook', 'setCardVoice', 'setActivityField']],
  1: [['setCardProfile', 'setPasskeys', 'setCardLook', 'setCardVoice', 'setActivityField', 'setCardApp']],
};
const settingsWide = [matchMedia('(min-width: 1101px)'), matchMedia('(min-width: 761px)')];
function layoutSettingsColumns() {
  const n = settingsWide[0].matches ? 3 : settingsWide[1].matches ? 2 : 1;
  const grid = $('#setGrid');
  if (grid.dataset.cols === String(n)) return;
  grid.dataset.cols = String(n);
  grid.replaceChildren(...SETTINGS_COLUMNS[n].map((ids) => h('div', { class: 'set-col' }, ids.map((id) => $('#' + id)))));
}
layoutSettingsColumns();
for (const query of settingsWide) query.addEventListener('change', layoutSettingsColumns);

// Voice and video in Settings apply as soon as they change: the microphone, speakers and camera in use switch over,
// and a microphone test that is running starts again with the new choice.
function applyVoiceSettings() {
  const before = JSON.stringify([settings.inputId, settings.noiseMode, settings.echoCancellation, settings.autoGainControl]);
  const cameraBefore = settings.cameraId;
  Object.assign(settings, {
    inputId: $('#setInput').value, outputId: $('#setOutput').value, cameraId: $('#setCamera').value,
    noiseMode: $('#setNoiseMode').value, noiseSuppression: $('#setNoiseMode').value !== 'off', echoCancellation: $('#setEcho').checked,
    autoGainControl: $('#setGain').checked,
  });
  store.set('settings', settings);
  const after = JSON.stringify([settings.inputId, settings.noiseMode, settings.echoCancellation, settings.autoGainControl]);
  if (before !== after && rtc.channel && rtc.mic) ensureMic(true);
  if (cameraBefore !== settings.cameraId && rtc.camera) { stopCamera(false); toggleCamera(); }
  for (const peer of rtc.peers.values()) if (peer.audio) applyOutput(peer.audio);
  for (const [key, tile] of tiles) if (key.startsWith('screen:')) applyOutput(tile.parts.video);
  if (before !== after && micTest.live) startMicTest();
}
for (const id of VOICE_FIELDS) $('#' + id).addEventListener('change', applyVoiceSettings);

// The nameplate choice in Settings: none, one of the designs, or your own (picked from your files and uploaded).
function renderPlatePicks() {
  const own = draft.plate && !PLATES[draft.plate] ? draft.plate : '';
  const pick = (value, label, plate, extra) => h('button', { class: 'plate-pick' + (draft.plate === value && (value || !draft.plate) ? ' on' : ''), type: 'button',
    title: label, onclick: extra || (() => { draft.plate = value; renderPlatePicks(); }) },
    h('span', { class: 'plate-sample' + (plate ? ' plated' : '') }, plateEl(plate, plate === own ? draft.plateFit : null), h('span', { class: 'plate-dot' }), h('b', { text: 'Name' })),
    h('span', { text: label }));
  // Your own picture, chosen again: back into the picture editor to move or zoom it.
  const placeOwn = () => {
    if (draft.plate === own && !plateVideo(own)) openCropper({ url: own, fit: draft.plateFit }, 'plate');
    else { draft.plate = own; renderPlatePicks(); }
  };
  $('#platePicks').replaceChildren(
    pick('', 'None', ''),
    ...Object.entries(PLATES).map(([id, label]) => pick(id, label, id)),
    ...(own ? [pick(own, plateVideo(own) ? 'Your own' : 'Your own: click to place', own, placeOwn)] : []),
    h('button', { class: 'plate-pick upload', type: 'button', title: 'Use a picture, GIF, WebP or short video', onclick: () => $('#plateFile').click() },
      h('span', { class: 'plate-sample' }, icon('plus')), h('span', { text: own ? 'Change yours' : 'Upload your own' })));
}

$('#plateFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !draft) return;
  if (!/\.(png|apng|jpe?g|gif|webp|avif|mp4|m4v|webm)$/i.test(file.name)) { toast('Use a picture (PNG, JPG, GIF, WebP, AVIF) or a short video (MP4, WebM).'); return; }
  if (file.size > 15 * 1048576) { toast('Nameplates can be up to 15 MB.'); return; }
  // A picture is placed in the picture editor first (and uploaded from there); a video simply fills the nameplate.
  if (!plateVideo(file.name)) { openCropper({ file }, 'plate'); return; }
  try {
    draft.plate = (await upload(file)).url;
    draft.plateFit = null;
    renderPlatePicks();
  } catch (err) { toast(`${file.name}: ${err.message}`); }
});

// What you are playing, in Settings (desktop app 1.4.6 on): whether to show it, and your Spotify account.
async function renderActivitySettings(change, problem) {
  if (!appShell || !appShell.activitySettings) return;
  let s = null;
  try { s = await appShell.activitySettings(change || null); } catch { /* an older app */ }
  if (!s) return;
  const spotify = s.spotify || {};
  const ready = !!(state.server && state.server.spotifyClientId);
  $('#setActivityField').hidden = false;
  // From desktop 1.4.8 Spotify has its own switch; before, one switch covered games and songs.
  const ownSwitch = typeof s.shareSpotify === 'boolean';
  $('#setActivityLabel').textContent = ownSwitch ? 'Show the game I am playing' : 'Show the game or song I am playing';
  $('#setSpotifyShareRow').hidden = !ownSwitch;
  if (!change) {
    $('#setActivity').checked = !!s.share;
    $('#setSpotifyShare').checked = s.shareSpotify !== false;
  }
  $('#setActivityWaiting').hidden = !(s.share && s.waiting);
  $('.spotify-dot').classList.toggle('on', !!spotify.connected);
  $('#spotifyState').textContent = spotify.connected ? 'Spotify is connected.' : spotify.connecting ? 'Finish in your browser…' : 'Spotify is not connected.';
  $('#spotifyConnect').hidden = !!spotify.connected;
  $('#spotifyConnect').disabled = !ready || !!spotify.connecting;
  $('#spotifyDisconnect').hidden = !spotify.connected;
  const say = problem || spotify.problem || (!ready && !spotify.connected ? 'This server has no Spotify app yet. An admin of this server sets one up in Server settings.' : '');
  $('#spotifyProblem').hidden = !say;
  $('#spotifyProblem').textContent = say;
}

$('#spotifyConnect').addEventListener('click', async () => {
  if (!appShell || !appShell.spotifyConnect || !state.server.spotifyClientId) return;
  $('#spotifyConnect').disabled = true;
  $('#spotifyState').textContent = 'Finish in your browser…';
  $('#spotifyProblem').hidden = true;
  let result = null;
  try { result = await appShell.spotifyConnect(state.server.spotifyClientId); } catch { result = { problem: 'Spotify could not be connected.' }; }
  renderActivitySettings(null, result && result.problem);
});
$('#spotifyDisconnect').addEventListener('click', async () => {
  if (appShell && appShell.spotifyDisconnect) await appShell.spotifyDisconnect();
  renderActivitySettings();
});

/* appearance: the theme being tried in the open settings dialog. It shows straight away; Save keeps it, and
   closing the dialog any other way goes back to the saved one. */

let look = null;

const themeBackground = (t) => (t.gradient ? `linear-gradient(${t.gradient.angle}deg, ${t.bg}, ${t.gradient.to})` : t.bg);

function openLook() {
  const saved = state.theme || THEMES[0];
  look = { preset: saved.preset || '', bg: saved.bg, accent: saved.accent, text: saved.text || '', gradient: saved.gradient ? { ...saved.gradient } : null,
    image: saved.image || '', imageOpacity: saved.imageOpacity ?? 45 };
  renderLook();
}

function renderLook() {
  if (!look) return;
  for (const card of $$('#themeList .theme-card')) card.classList.toggle('active', card.dataset.preset === look.preset);
  $('#lookBg').value = look.bg;
  $('#lookAccent').value = look.accent;
  $('#lookText').value = look.text || autoText(look.bg);
  $('#lookFade').checked = !!look.gradient;
  $('#lookToField').hidden = !look.gradient;
  $('#lookAngleField').hidden = !look.gradient;
  if (look.gradient) {
    $('#lookTo').value = look.gradient.to;
    $('#lookAngle').value = String(look.gradient.angle);
  }
  // A warning when the writing would be hard to read on the background (or on the colour it fades into).
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  const writing = look.text || autoText(look.bg);
  $('#lookLight').hidden = contrast(writing, look.bg) >= 4.5 && (!look.gradient || contrast(writing, look.gradient.to) >= 4.5);
  $('#lookThumb').style.backgroundImage = look.image ? `url("${look.image}")` : '';
  $('#lookPicBtn').textContent = look.image ? 'Change picture' : 'Choose picture';
  $('#lookPicClear').hidden = !look.image;
  $('#lookOpacityField').hidden = !look.image;
  $('#lookOpacity').value = String(look.imageOpacity);
  $('#lookOpacityOut').textContent = look.imageOpacity + '%';
  applyTheme(look, true);
}

$('#themeList').replaceChildren(...THEMES.map((t) => {
  const stripe = h('i', {});
  stripe.style.background = t.accent;
  const swatch = h('span', { class: 'theme-swatch' }, stripe);
  swatch.style.background = themeBackground(t);
  return h('button', { class: 'theme-card', type: 'button', title: t.name, dataset: { preset: t.preset },
    onclick: () => {
      Object.assign(look, { preset: t.preset, bg: t.bg, accent: t.accent, text: '', gradient: t.gradient ? { ...t.gradient } : null });
      renderLook();
    } },
    swatch, h('span', { class: 'theme-name', text: t.name }));
}));

// Changing anything by hand makes it a theme of your own.
const customize = (change) => (event) => { if (!look) return; change(event.target); look.preset = ''; renderLook(); };
$('#lookBg').addEventListener('input', customize((input) => { look.bg = input.value.toLowerCase(); }));
$('#lookAccent').addEventListener('input', customize((input) => { look.accent = input.value.toLowerCase(); }));
$('#lookText').addEventListener('input', customize((input) => { look.text = input.value.toLowerCase(); }));
$('#lookTo').addEventListener('input', customize((input) => { if (look.gradient) look.gradient.to = input.value.toLowerCase(); }));
$('#lookAngle').addEventListener('input', customize((input) => { if (look.gradient) look.gradient.angle = +input.value; }));
$('#lookFade').addEventListener('change', customize((input) => {
  look.gradient = input.checked ? { to: mixColor(look.bg, look.accent, 0.3), angle: 160 } : null;
}));
$('#lookOpacity').addEventListener('input', (event) => { if (look) { look.imageOpacity = +event.target.value; renderLook(); } });
$('#lookPicBtn').addEventListener('click', () => $('#lookPicFile').click());
$('#lookPicClear').addEventListener('click', () => { if (look) { look.image = ''; renderLook(); } });
$('#lookPicFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !look) return;
  if (!/\.(png|apng|jpe?g|jfif|gif|webp|avif|bmp)$/i.test(file.name)) { toast('Use a PNG, JPG, JFIF, GIF, WebP or AVIF image.'); return; }
  if (file.size > 15 * 1048576) { toast('Background pictures can be up to 15 MB.'); return; }
  $('#lookPicBtn').disabled = true;
  try {
    const url = (await upload(file)).url;
    if (look) { look.image = url; renderLook(); }
  } catch (err) {
    toast(`${file.name}: ${err.message}`);
  } finally { $('#lookPicBtn').disabled = false; }
});

// Back to the saved theme: the new one after Save, the old one after Cancel or Escape.
function endLook() {
  if (!look) return;
  look = null;
  applyTheme(state.theme);
}
$('#settingsDlg').addEventListener('cancel', (event) => { if (syncUnsaved()) { event.preventDefault(); shakeUnsaved(); } });
$('#settingsDlg').addEventListener('close', endLook);
$('#settingsDlg').addEventListener('close', stopMicTest);

for (const el of $$('.set-icon[data-icon]')) el.replaceChildren(icon(el.dataset.icon));

/* the microphone level in Settings: while in voice, what is being sent (after noise suppression); otherwise Test
   opens the chosen microphone, with the chosen noise suppression, until Settings closes */

const micTest = { mic: null, analyser: null, frame: 0, live: false };
const levelWidth = (level) => Math.max(0, Math.min(100, (20 * Math.log10(Math.max(level, 1e-5)) + 60) / 60 * 100));

function meterLoop(analyser) {
  cancelAnimationFrame(micTest.frame);
  const meter = $('#micMeter');
  const step = () => {
    if (!$('#settingsDlg').open) { meter.style.width = '0'; return; }
    meter.style.width = `${analyser && !(micTest.live && rtc.muted) ? levelWidth(loudness(analyser)) : 0}%`;
    micTest.frame = requestAnimationFrame(step);
  };
  step();
}

function showMicLevel() {
  micTest.live = !!(rtc.channel && rtc.mic && rtc.mic.analyser);
  $('#micTestBtn').hidden = micTest.live;
  $('#micTestBtn').textContent = 'Test';
  if (micTest.live) meterLoop(rtc.mic.analyser);
  else $('#micMeter').style.width = '0';
}

async function startMicTest() {
  stopMicTest();
  const ctx = audio();
  if (!ctx) return;
  const keep = { inputId: settings.inputId, noiseMode: settings.noiseMode, echoCancellation: settings.echoCancellation, autoGainControl: settings.autoGainControl };
  // The dialog's choices, not yet saved, for the test
  Object.assign(settings, { inputId: $('#setInput').value, noiseMode: $('#setNoiseMode').value, echoCancellation: $('#setEcho').checked, autoGainControl: $('#setGain').checked });
  let captured = null;
  try { captured = await openMic(); } finally { Object.assign(settings, keep); }
  if (!captured) { toast(micHelp(), 7000); return; }
  let clean = null;
  if ($('#setNoiseMode').value === 'strong') {
    try { clean = await denoise(captured); } catch { /* the plain microphone */ }
  }
  const source = ctx.createMediaStreamSource(clean ? clean.stream : captured);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  micTest.mic = { captured, clean, source };
  $('#micTestBtn').textContent = 'Stop';
  meterLoop(analyser);
}

function stopMicTest() {
  cancelAnimationFrame(micTest.frame);
  const mic = micTest.mic;
  micTest.mic = null;
  if (mic) {
    mic.source.disconnect();
    if (mic.clean) mic.clean.stop();
    for (const track of mic.captured.getTracks()) track.stop();
  }
  $('#micMeter').style.width = '0';
  $('#micTestBtn').textContent = 'Test';
}

$('#micTestBtn').addEventListener('click', () => { if (micTest.mic) stopMicTest(); else startMicTest(); });
for (const id of ['#setInput', '#setNoiseMode', '#setEcho', '#setGain']) {
  $(id).addEventListener('change', () => { if (micTest.mic) startMicTest(); });
}

/* the desktop app (1.4.9 on): zoom, its version, What's new and Check for updates */

const zoomText = (percent) => `${Math.round(percent) || 100}%`;

async function renderAppCard() {
  if (!appShell || !appShell.appInfo) return;
  let info = null;
  try { info = await appShell.appInfo(); } catch { /* an older app */ }
  if (!info) return;
  $('#setDesktop').hidden = false;
  $('#zoomNow').textContent = zoomText(info.zoom);
  $('#appVersion').textContent = `Umbryx ${info.version}`;
  $('#appVersionNote').textContent = info.ready ? `Version ${info.ready} is ready: the green arrow in the column of servers restarts onto it` : '';
}

const zoomBy = async (step) => { if (appShell && appShell.zoom) $('#zoomNow').textContent = zoomText(await appShell.zoom(step)); };
$('#zoomIn').addEventListener('click', () => zoomBy(1));
$('#zoomOut').addEventListener('click', () => zoomBy(-1));
$('#zoomNow').addEventListener('click', () => zoomBy(0));
$('#appWhatsNew').addEventListener('click', () => { if (appShell && appShell.whatsNew) appShell.whatsNew(); });
$('#appCheck').addEventListener('click', () => { if (appShell && appShell.checkNow) appShell.checkNow(); });

window.addEventListener('beforeunload', () => { if (ws) ws.close(); });
// The desktop app (1.4.14 on) asks before restarting to update. In a voice channel, the page notes which (and how
// you were muted), and joins it again when the app is back; a one-on-one call cannot carry on that way.
const restartPlan = () => (!rtc.channel ? 'none' : channelById(rtc.channel) ? 'rejoin' : 'call');
function beforeRestart() {
  if (restartPlan() === 'rejoin') {
    store.set('rejoin', { channel: rtc.channel, muted: rtc.muted, deafened: rtc.deafened, mutedBeforeDeafen: !!rtc.mutedBeforeDeafen, at: Date.now() });
  }
  return restartPlan();
}

/* Moving pictures rest while Umbryx is not the window in use, as in Discord: each GIF (and animated WebP or APNG)
   from this server shows the frame it was on as a still, nameplates stop, and looping muted videos (GIF-like ones)
   pause; all of it moves again when the window is used again. A picture from another site cannot be copied into a
   still, so that one keeps moving. */

const MOVING = /\.(gif|webp|apng)(?:[?#]|$)/i;
let resting = false;

function stillFrame(img) {
  try {
    const scale = Math.min(1, 480 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch { return ''; }
}

function restImage(img) {
  if (img.dataset.moving || !MOVING.test(img.src)) return;
  try { if (new URL(img.src).origin !== location.origin) return; } catch { return; }
  if (!img.complete || !img.naturalWidth) {   // still loading: rest it once it has loaded
    img.addEventListener('load', () => { if (resting) restImage(img); }, { once: true });
    return;
  }
  const still = stillFrame(img);
  if (!still) return;
  img.dataset.moving = img.src;
  img.src = still;
}

function wakeImage(img) {
  if (!img.dataset.moving) return;
  img.src = img.dataset.moving;
  delete img.dataset.moving;
}

const loopingVideos = () => $$('video[loop]').filter((v) => v.muted);

function setResting(on) {
  if (on === resting) return;
  resting = on;
  document.documentElement.classList.toggle('resting', on);
  for (const img of $$('img')) if (on) restImage(img); else wakeImage(img);
  for (const video of loopingVideos()) if (on) video.pause(); else video.play().catch(() => {});
}

// Pictures added while resting (a new message, a list drawn again) rest too.
new MutationObserver((changes) => {
  if (!resting) return;
  for (const change of changes) {
    for (const node of change.addedNodes) {
      if (node.nodeType !== 1) continue;
      for (const img of node.tagName === 'IMG' ? [node] : node.querySelectorAll('img')) restImage(img);
      for (const video of node.tagName === 'VIDEO' ? [node] : node.querySelectorAll('video[loop]')) {
        if (video.muted) { video.autoplay = false; video.pause(); }
      }
    }
  }
}).observe(document.body, { childList: true, subtree: true });

// In the desktop app (1.4.17 on) the app says whether its window is the one in use, and whether this server is the
// one on screen: clicking the column of servers takes the keyboard out of the page but not out of Umbryx. Elsewhere,
// the page's own focus counts (a YouTube player in it having the focus is still this window in use).
const inUse = () => (appShell && appShell.onWindowFocus
  ? appShell.windowFocused() && (!appShell.isShown || appShell.isShown())
  : !document.hidden && document.hasFocus());
const checkResting = () => setTimeout(() => setResting(!inUse()), 0);
if (appShell && appShell.onWindowFocus) {
  appShell.onWindowFocus(checkResting);
  if (appShell.onShown) appShell.onShown(checkResting);
} else {
  window.addEventListener('blur', checkResting);
  window.addEventListener('focus', checkResting);
}
document.addEventListener('visibilitychange', checkResting);

window.__umbryx = { restartPlan, beforeRestart, state, rtc, startShare, endShare, watch, gpuInfo, hardwareCodecs, toggleCamera, ringPlayers, pip };   // handy when poking around in the console

boot();
})();
