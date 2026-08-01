/**
 * banked.js — UI for the Banked Tabs stash (banked.html).
 *
 * The stash is destructive by design: it is purged 24h after creation, or the
 * moment this tab closes (user spec 2026-07-30). Everything here exists to
 * make that safe to live with — a visible countdown, a confirm before the
 * closing purge, and one-click restore.
 */
import {
  PF_BANKED_KEY, readBank, writeBank, clearBank, bankMsRemaining
} from './banked_tabs.js';

const $ = (id) => document.getElementById(id);

function formatRemaining(ms) {
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function renderExpiry(bank) {
  const el = $('expiry');
  if (!el) return;
  const left = bankMsRemaining(bank);
  el.textContent = left > 0
    ? `These are deleted in ${formatRemaining(left)}, or as soon as you close this tab.`
    : 'These have expired and will be cleared.';
}

function row(item) {
  const li = document.createElement('li');
  if (item.favIconUrl) {
    const img = document.createElement('img');
    img.src = item.favIconUrl;
    img.alt = '';
    // A dead favicon must not leave a broken-image glyph in the row.
    img.addEventListener('error', () => img.remove());
    li.appendChild(img);
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = item.title || item.url;
  const u = document.createElement('span');
  u.className = 'u';
  u.textContent = item.url;
  meta.appendChild(t);
  meta.appendChild(u);
  li.appendChild(meta);

  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = 'Reopen';
  open.addEventListener('click', () => { void restoreOne(item.id); });
  li.appendChild(open);

  const drop = document.createElement('button');
  drop.type = 'button';
  drop.textContent = 'Remove';
  drop.addEventListener('click', () => { void removeOne(item.id); });
  li.appendChild(drop);
  return li;
}

async function render() {
  const bank = await readBank();
  const list = $('list');
  const empty = $('empty');
  if (!list) return;
  list.replaceChildren();
  const items = bank?.items || [];
  if (!items.length) {
    if (empty) empty.hidden = false;
    if ($('expiry')) $('expiry').style.display = 'none';
    $('restoreAll')?.setAttribute('disabled', 'true');
    $('discardAll')?.setAttribute('disabled', 'true');
    return;
  }
  if (empty) empty.hidden = true;
  renderExpiry(bank);
  items.forEach((item) => list.appendChild(row(item)));
}

async function restoreOne(id) {
  const bank = await readBank();
  if (!bank) return;
  const item = bank.items.find((i) => i.id === id);
  if (!item) return;
  await chrome.tabs.create({ url: item.url, active: false });
  bank.items = bank.items.filter((i) => i.id !== id);
  await writeBank(bank);
  await render();
}

async function removeOne(id) {
  const bank = await readBank();
  if (!bank) return;
  bank.items = bank.items.filter((i) => i.id !== id);
  await writeBank(bank);
  await render();
}

$('restoreAll')?.addEventListener('click', async () => {
  const bank = await readBank();
  if (!bank?.items?.length) return;
  // Reopen in the background so the user keeps their place here and can see
  // what came back before this tab goes away.
  for (const item of bank.items) {
    await chrome.tabs.create({ url: item.url, active: false }).catch(() => {});
  }
  await clearBank();
  await render();
});

$('discardAll')?.addEventListener('click', async () => {
  const bank = await readBank();
  const n = bank?.items?.length || 0;
  if (!n) return;
  if (!window.confirm(`Discard ${n} banked tab${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
  await clearBank();
  await render();
});

// Closing this tab purges the stash (user spec). Warn first — losing a dozen
// URLs to a stray Cmd+W with no undo would be indefensible. The browser shows
// its own generic wording; all we can do is trigger the prompt.
window.addEventListener('beforeunload', (e) => {
  const hasItems = ($('list')?.childElementCount || 0) > 0;
  if (!hasItems) return;
  e.preventDefault();
  e.returnValue = '';
});

// Keep the countdown honest if the page is left open.
setInterval(() => { void readBank().then((b) => b && renderExpiry(b)); }, 60_000);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[PF_BANKED_KEY]) void render();
});

void render();
