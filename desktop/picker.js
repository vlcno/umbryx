'use strict';
// The screen picker: every screen and window, as thumbnails. Double-click shares straight away.
const grid = document.getElementById('grid');
const share = document.getElementById('share');
const audio = document.getElementById('audio');
const note = document.getElementById('note');
let selected = null;
let hdrScreensConverted = true;

if (/Mac/.test(navigator.platform)) document.body.classList.add('mac');   // room for the window buttons

const send = (id) => window.umbryx.choose(id ? { id, audio: audio.checked && !document.getElementById('audioRow').hidden } : null);

// Streams are SDR. Say what happens to an HDR screen, and warn when this Windows version gets it wrong.
function explainHdr(source) {
  note.hidden = !source.hdr;
  note.classList.toggle('warn', source.hdr && !hdrScreensConverted);
  if (!source.hdr) return;
  note.textContent = hdrScreensConverted
    ? 'This screen is in HDR. It is converted to SDR for the stream. Highlights brighter than SDR white are flattened to white.'
    : 'This screen is in HDR, and this version of Windows shares a whole HDR screen far too bright. Share the game or app window instead, which is converted to SDR properly, or update Windows 11 to 24H2 or newer.';
}

function tile(source) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'source';
  const picture = document.createElement(source.thumbnail ? 'img' : 'div');
  if (source.thumbnail) { picture.src = source.thumbnail; picture.alt = ''; } else picture.className = 'blank';
  const name = document.createElement('span');
  name.textContent = source.name;
  name.title = source.name;
  button.append(picture, name);
  if (source.hdr) {
    const badge = document.createElement('em');
    badge.className = 'badge';
    badge.textContent = 'HDR';
    button.append(badge);
  }
  button.addEventListener('click', () => {
    for (const other of grid.querySelectorAll('.selected')) other.classList.remove('selected');
    button.classList.add('selected');
    selected = source.id;
    share.disabled = false;
    explainHdr(source);
  });
  button.addEventListener('dblclick', () => send(source.id));
  return button;
}

function heading(text) {
  const el = document.createElement('div');
  el.className = 'group';
  el.textContent = text;
  return el;
}

window.umbryx.onSources((data) => {
  hdrScreensConverted = data.hdrScreensConverted !== false;
  document.getElementById('audioRow').hidden = !data.audioWanted;
  const screens = data.sources.filter((s) => s.screen);
  const windows = data.sources.filter((s) => !s.screen);
  grid.replaceChildren();
  if (screens.length) grid.append(heading('Screens'), ...screens.map(tile));
  if (windows.length) grid.append(heading('Windows'), ...windows.map(tile));
});

share.addEventListener('click', () => send(selected));
document.getElementById('cancel').addEventListener('click', () => send(null));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') send(null);
  if (event.key === 'Enter' && selected) send(selected);
});
