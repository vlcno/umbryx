'use strict';
// Runs before every page in the app's windows. Pages from a server get only this: the height of the title
// strip, a way to open the app's menu, whether the page is the one on screen, and from version 1.4 how wide
// the column of servers over their left edge is, a way to say how tall their bottom panels are, their
// theme's colours (for the column and the window buttons), system notifications, and what you are playing.
// Everything else is only
// for the app's own pages (the column of servers, setup and the screen picker, loaded from disk).
const { contextBridge, ipcRenderer } = require('electron');

// Whether this page is the one on screen: with several servers, the others carry on in the background.
let shown = true;
const shownListeners = [];
ipcRenderer.on('app:shown', (_event, value) => {
  shown = !!value;
  for (const listener of shownListeners) listener(shown);
});

// Whether the app's window is the one in use (from 1.4.17).
let focused = true;
const focusListeners = [];
ipcRenderer.on('app:focus', (_event, value) => {
  focused = !!value;
  for (const listener of focusListeners) listener(focused);
});

// The Home button or a server's button was clicked: the page switches side ('home' or 'server').
const homeListeners = [];
ipcRenderer.on('app:home', (_event, side) => {
  for (const listener of homeListeners) listener(side === 'home' ? 'home' : 'server');
});

// What you are playing changed (a list: a game, Spotify, or nothing).
const activityListeners = [];
ipcRenderer.on('app:activity', (_event, list) => {
  for (const listener of activityListeners) listener(list);
});

// Whether the column of servers is over the page's left edge (from 1.4.18 it is not while the only server's page
// is on its sign-in screen).
let railOver = true;
const railListeners = [];
ipcRenderer.on('app:rail', (_event, value) => {
  railOver = !!value;
  for (const listener of railListeners) listener(railOver);
});

// A notification was clicked: the page opens that conversation.
const openListeners = [];
ipcRenderer.on('app:open', (_event, target) => {
  for (const listener of openListeners) listener(target);
});

const plain = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));   // nothing but data crosses over

contextBridge.exposeInMainWorld('umbryxApp', {
  titleBar: 34,
  menu: () => ipcRenderer.send('app:menu'),
  isShown: () => shown,
  onShown: (listener) => { if (typeof listener === 'function') shownListeners.push(listener); },
  rail: 72,
  platform: process.platform,
  layout: (info) => ipcRenderer.send('page:layout', plain(info)),
  theme: (colors) => ipcRenderer.send('page:theme', plain(colors)),
  notify: (note) => ipcRenderer.send('page:notify', plain(note)),
  server: (info) => ipcRenderer.send('page:server', plain(info)),
  idleSeconds: () => ipcRenderer.invoke('app:idle'),
  checkUpdates: () => ipcRenderer.send('page:check-updates'),
  onOpen: (listener) => { if (typeof listener === 'function') openListeners.push(listener); },
  home: (info) => ipcRenderer.send('page:home', plain(info)),
  onHome: (listener) => { if (typeof listener === 'function') homeListeners.push(listener); },
  // From 1.4.6: what you are playing (games, through Discord's channel, and Spotify), and its settings.
  activity: () => ipcRenderer.invoke('page:activity'),
  onActivity: (listener) => { if (typeof listener === 'function') activityListeners.push(listener); },
  activitySettings: (change) => ipcRenderer.invoke('page:activity-settings', plain(change)),
  spotifyConnect: (clientId) => ipcRenderer.invoke('page:spotify-connect', String(clientId || '')),
  spotifyDisconnect: () => ipcRenderer.invoke('page:spotify-disconnect'),
  windowFocused: () => focused,
  onWindowFocus: (listener) => { if (typeof listener === 'function') focusListeners.push(listener); },
  // From 1.4.9: Settings' App card.
  appInfo: () => ipcRenderer.invoke('page:app-info'),
  zoom: (step) => ipcRenderer.invoke('page:zoom', Math.sign(Number(step) || 0)),
  whatsNew: () => ipcRenderer.send('page:whats-new'),
  checkNow: () => ipcRenderer.send('page:check-now'),
  // From 1.4.18: the page is on its sign-in screen (false) or signed in (true); the column of servers then shows.
  signedIn: (on) => ipcRenderer.send('page:signed-in', !!on),
  // Move to the server's own address for apps, with this page's sign-in and settings (1.4.21 on).
  moveServer: (info) => ipcRenderer.send('page:move', plain(info)),
  railOver: () => railOver,
  onRail: (listener) => { if (typeof listener === 'function') railListeners.push(listener); },
  // From 1.4.22: screen share in one window. The page lists screens and windows in its own share settings, then says
  // which one just before asking to share, so no picker window opens.
  shareSources: () => ipcRenderer.invoke('page:share-sources'),
  shareChoose: (choice) => ipcRenderer.invoke('page:share-choose', plain(choice)),
});

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('umbryx', {
    // setup
    connect: (address) => ipcRenderer.invoke('setup:connect', address),
    cancelSetup: () => ipcRenderer.send('setup:cancel'),
    // screen picker
    onSources: (handler) => ipcRenderer.on('picker:sources', (_event, data) => handler(data)),
    choose: (choice) => ipcRenderer.send('picker:choose', choice),
    // the column of servers
    onServers: (handler) => ipcRenderer.on('rail:servers', (_event, data) => handler(data)),
    railReady: () => ipcRenderer.send('rail:ready'),
    openServer: (index) => ipcRenderer.send('rail:open', index),
    addServer: () => ipcRenderer.send('rail:add'),
    serverMenu: (index) => ipcRenderer.send('rail:menu', index),
    restartToUpdate: () => ipcRenderer.send('rail:update'),
    railTip: (on) => ipcRenderer.send('rail:tip', !!on),
    goHome: () => ipcRenderer.send('rail:home'),
    openDm: (id) => ipcRenderer.send('rail:dm', id),
    onRailMode: (handler) => ipcRenderer.on('rail:mode', (_event, data) => handler(data)),
    // what's new
    onWhatsNew: (handler) => ipcRenderer.on('whatsnew:notes', (_event, data) => handler(data)),
    onRailTheme: (handler) => ipcRenderer.on('rail:theme', (_event, data) => handler(data)),
  });
}
