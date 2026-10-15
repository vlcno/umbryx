'use strict';
// The "which server?" screen: on first run, when adding a server (+ in the column, or the menu), or when
// a server cannot be reached.
const query = new URLSearchParams(location.search);
const address = document.getElementById('address');
const problem = document.getElementById('problem');
const go = document.getElementById('go');

address.value = query.get('address') || '';
problem.textContent = query.get('problem') || '';
address.select();

// With servers already saved, this screen adds another one, and can be left without adding anything.
if (query.get('cancel')) {
  document.getElementById('cancel').hidden = false;
  document.getElementById('cancel').addEventListener('click', () => window.umbryx.cancelSetup());
  if (!query.get('problem')) document.getElementById('sub').textContent = 'Add another server. It keeps its own sign-in.';
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && query.get('cancel')) window.umbryx.cancelSetup();
});

document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  go.disabled = true;
  go.textContent = 'Connecting…';
  problem.textContent = '';
  const result = await window.umbryx.connect(address.value);
  // On success the window moves on to the server and this page is gone.
  if (result && result.problem) {
    problem.textContent = result.problem;
    go.disabled = false;
    go.textContent = 'Connect';
    address.focus();
  }
});
