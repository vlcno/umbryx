'use strict';
// The "What's new" window, shown once after an update (and from the app's menu). The notes come from
// whats-new.json, which travels inside the app, so each version describes itself.
if (/Mac/.test(navigator.platform)) document.body.classList.add('mac');   // room for the window buttons

window.umbryx.onWhatsNew(({ version, notes }) => {
  document.getElementById('version').textContent = `Umbryx ${version}`;
  const list = document.getElementById('list');
  list.replaceChildren(...notes.map((note) => {
    const item = document.createElement('li');
    const title = document.createElement('b');
    title.textContent = note.title;
    const text = document.createElement('span');
    text.textContent = note.text;
    item.append(title, text);
    return item;
  }));
});

document.getElementById('done').addEventListener('click', () => window.close());
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' || event.key === 'Enter') window.close(); });
