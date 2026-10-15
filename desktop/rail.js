'use strict';
// The column of saved servers down the left of the window. Click one to show it, right-click for more,
// + to add another. Each shows the first letters of its name, a pill on the left for the one on screen
// or for unread messages, a red count of unread messages, and a green ring while a call rings there.
// At the bottom, a green arrow when a new version of the app is downloaded and ready: click it to restart.
const list = document.getElementById('rail');
const foot = document.getElementById('railFoot');

// The name of what is under the pointer, in a bubble beside it (as in Discord). The column's view is only as wide as
// the column, so it asks the app to widen it, see-through, while a bubble shows (from 1.4.19).
const tip = document.createElement('div');
tip.className = 'rail-tip';
tip.hidden = true;
document.body.append(tip);
// A partnered server's bubble has the partner check before its name, as the server's header does.
function tipFor(el, text, partner) {
  el.setAttribute('aria-label', partner ? `${text} (Umbryx Partner)` : text);
  el.addEventListener('mouseenter', () => {
    const box = el.getBoundingClientRect();
    const name = document.createElement('span');
    name.className = 'rail-tip-name';
    name.textContent = text;
    tip.replaceChildren(...(partner ? [partnerCheck()] : []), name);
    tip.style.top = Math.round(box.top + box.height / 2) + 'px';
    tip.hidden = false;
    window.umbryx.railTip(true);
  });
  el.addEventListener('mouseleave', hideTip);
}
function hideTip() {
  if (tip.hidden) return;
  tip.hidden = true;
  window.umbryx.railTip(false);
}
window.addEventListener('blur', hideTip);
const SVG = 'http://www.w3.org/2000/svg';

// The Umbryx Partner check: the same shape as beside the server's name in the page.
function partnerCheck() {
  const check = document.createElementNS(SVG, 'svg');
  check.setAttribute('viewBox', '0 0 24 24');
  check.setAttribute('class', 'rail-tip-check');
  check.setAttribute('aria-hidden', 'true');
  const seal = document.createElementNS(SVG, 'path');
  seal.setAttribute('class', 'solid');
  seal.setAttribute('d', 'M23.4 12.0L23.2 12.7L22.5 13.4L21.8 14.0L21.4 14.5L21.5 15.2L21.8 16.1L22.0 17.0L21.9 17.7L21.3 18.2L20.4 18.5L19.5 18.6L18.9 18.9L18.6 19.5L18.5 20.4L18.2 21.3L17.7 21.9L17.0 22.0L16.1 21.8L15.2 21.5L14.5 21.4L14.0 21.8L13.4 22.5L12.7 23.2L12.0 23.4L11.3 23.2L10.6 22.5L10.0 21.8L9.5 21.4L8.8 21.5L7.9 21.8L7.0 22.0L6.3 21.9L5.8 21.3L5.5 20.4L5.4 19.5L5.1 18.9L4.5 18.6L3.6 18.5L2.7 18.2L2.1 17.7L2.0 17.0L2.2 16.1L2.5 15.2L2.6 14.5L2.2 14.0L1.5 13.4L0.8 12.7L0.6 12.0L0.8 11.3L1.5 10.6L2.2 10.0L2.6 9.5L2.5 8.8L2.2 7.9L2.0 7.0L2.1 6.3L2.7 5.8L3.6 5.5L4.5 5.4L5.1 5.1L5.4 4.5L5.5 3.6L5.8 2.7L6.3 2.1L7.0 2.0L7.9 2.2L8.8 2.5L9.5 2.6L10.0 2.2L10.6 1.5L11.3 0.8L12.0 0.6L12.7 0.8L13.4 1.5L14.0 2.2L14.5 2.6L15.2 2.5L16.1 2.2L17.0 2.0L17.7 2.1L18.2 2.7L18.5 3.6L18.6 4.5L18.9 5.1L19.5 5.4L20.4 5.5L21.3 5.8L21.9 6.3L22.0 7.0L21.8 7.9L21.5 8.8L21.4 9.5L21.8 10.0L22.5 10.6L23.2 11.3Z');
  const tick = document.createElementNS(SVG, 'path');
  tick.setAttribute('class', 'mark');
  tick.setAttribute('d', 'M7.6 12.3l3 3 5.8-6.4');
  check.append(seal, tick);
  return check;
}

function updateButton(update) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'rail-update';
  tipFor(button, `Restart to update to version ${update.version}`);
  const icon = document.createElementNS(SVG, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const arrow = document.createElementNS(SVG, 'path');
  arrow.setAttribute('d', 'M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14');
  icon.append(arrow);
  button.append(icon);
  button.addEventListener('click', () => window.umbryx.restartToUpdate());
  return button;
}

function initials(name) {
  const words = String(name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

// Home (Friends and direct messages) at the top, with whoever has written unread messages under it, then a
// line, then the servers.
function homeButtons(home) {
  if (!home) return [];
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'rail-server rail-home' + (home.active ? ' active' : '');
  tipFor(button, 'Home');
  const logo = document.createElement('img');
  logo.src = 'icon.svg';
  logo.alt = '';
  button.append(logo);
  button.addEventListener('click', () => window.umbryx.goHome());
  const people = (home.unread || []).map((person) => {
    const dm = document.createElement('button');
    dm.type = 'button';
    dm.className = 'rail-server rail-dm unread';
    tipFor(dm, person.name);
    if (person.icon) {
      const picture = document.createElement('img');
      picture.className = 'rail-icon';
      picture.src = person.icon;
      picture.alt = '';
      picture.addEventListener('error', () => { picture.replaceWith(initials(person.name)); dm.style.background = person.color; });
      dm.prepend(picture);
    } else {
      dm.textContent = initials(person.name);
      dm.style.background = person.color;
    }
    const badge = document.createElement('span');
    badge.className = 'rail-badge';
    badge.textContent = person.count > 99 ? '99+' : String(person.count);
    dm.append(badge);
    dm.addEventListener('click', () => window.umbryx.openDm(person.id));
    return dm;
  });
  const line = document.createElement('div');
  line.className = 'rail-line';
  return [button, ...people, line];
}

function draw(state) {
  const buttons = state.servers.map((server) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rail-server' + (server.active ? ' active' : '') + (server.unread ? ' unread' : '') + (server.ringing ? ' ringing' : '');
    tipFor(button, server.name, server.partner);
    if (server.icon) {
      const picture = document.createElement('img');
      picture.className = 'rail-icon';
      picture.src = server.icon;
      picture.alt = '';
      picture.addEventListener('error', () => { picture.replaceWith(initials(server.name)); });   // the server is off: its letters
      button.append(picture);
    } else button.textContent = initials(server.name);
    if (server.unread) {
      const badge = document.createElement('span');
      badge.className = 'rail-badge';
      badge.textContent = server.unread > 99 ? '99+' : String(server.unread);
      button.append(badge);
    }
    button.addEventListener('click', () => window.umbryx.openServer(server.index));
    button.addEventListener('contextmenu', (event) => { event.preventDefault(); window.umbryx.serverMenu(server.index); });
    return button;
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'rail-add' + (state.adding ? ' active' : '');
  tipFor(add, 'Add a server');
  add.textContent = '+';
  add.addEventListener('click', () => window.umbryx.addServer());
  hideTip();   // what it was over may be gone
  list.replaceChildren(...homeButtons(state.home), ...buttons, add);
  foot.replaceChildren(...(state.update ? [updateButton(state.update)] : []));
}

// Over a page from a newer server, the column has no strip of its own: the page's title strip runs above it.
window.umbryx.onRailMode((mode) => document.body.classList.toggle('no-strip', !mode.strip));

// Its colours follow the theme of the page on screen.
window.umbryx.onRailTheme((colors) => {
  const names = { bg: '--bg', raised: '--raised', hover: '--hover', line: '--line', text: '--text', dim: '--dim', accent: '--accent', accentInk: '--accent-ink' };
  for (const [key, name] of Object.entries(names)) {
    if (/^#[0-9a-f]{6}$/i.test(String(colors[key]))) document.documentElement.style.setProperty(name, colors[key]);
  }
});

window.umbryx.onServers(draw);
window.umbryx.railReady();
