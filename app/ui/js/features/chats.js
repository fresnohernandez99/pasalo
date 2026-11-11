// Saved chats with peers that are no longer here (they left the LAN, the
// partner disconnected, the app was restarted). They show up under the peer
// list as "Previous chats": opening one shows its history read-only, with no
// composer and no calls, until that peer is back. "Delete chat" removes it.
//
// The history lives in the backend (`chat_list`); the names are kept here,
// since messages only carry the peer's code.

import { t } from '../i18n/index.js';
import { on } from '../lib/bus.js';
import { $, esc, setHtml } from '../lib/dom.js';
import { dayLabel, shortCode } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { call, invoke } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { activePeerCode, closeChat, openChat, unreadCount } from './chat.js';
import { friendOf } from './friends.js';
import { avatar, findPeerByCode } from './peers.js';

/** code → { name, os } of everyone we have chatted with. */
const names = new Map();
/** [{ peer, ts }] from the backend, newest first. */
let saved = [];
/** Codes being deleted on purpose: their `chat_wiped` is not the private-chat one. */
export const deleting = new Set();

function loadNames() {
  try {
    for (const [code, entry] of Object.entries(JSON.parse(localStorage.getItem('chatNames') || '{}'))) names.set(code, entry);
  } catch {}
}

function saveNames() {
  try {
    localStorage.setItem('chatNames', JSON.stringify(Object.fromEntries(names)));
  } catch {}
}

/** Keeps the name of a peer we chat with, for when it is gone. */
export function rememberPeer(code, name, os) {
  if (!code || !name) return;
  const known = names.get(code);
  if (known?.name === name && (!os || known.os === os)) return;
  names.set(code, { name, os: os || known?.os || '' });
  saveNames();
}

/** What we know about a peer that is not here: its saved name, or its friend name. */
export function pastPeer(code) {
  const known = names.get(code);
  const friend = friendOf(code);
  return { code, name: friend?.name || known?.name || shortCode(code), os: known?.os || friend?.os || '', platform: 'past', addr: code };
}

/** A message with `code` was saved: its chat is in the list from now on. */
export function noteChat(code, ts) {
  const known = saved.find((c) => c.peer === code);
  if (known) {
    known.ts = Math.max(known.ts, ts);
    return;
  }
  saved.unshift({ peer: code, ts });
  render();
}

/** Reloads the saved chats (at start, and when a chat gets its first message or is deleted). */
export async function loadChats() {
  saved = await invoke('chat_list').catch(() => []);
  render();
}

function render() {
  const past = saved.filter((c) => !findPeerByCode(c.peer));
  $('#past-section').hidden = !past.length;
  setHtml($('#past'), past.map(row).join(''));
}

function row({ peer, ts }) {
  const p = pastPeer(peer);
  const unread = unreadCount(peer);
  const open = peer === activePeerCode();
  const sub = [friendOf(peer) ? t('past.friend') : t('past.gone'), dayLabel(ts)].join(' · ');
  return `
    <div class="peer past ${open ? 'open' : ''}" data-code="${esc(peer)}" role="button" tabindex="0">
      ${avatar(p.name, p.os)}
      <div class="info">
        <div class="pname">${esc(p.name)}</div>
        <div class="sub">${esc(sub)}</div>
      </div>
      ${unread ? `<span class="badge">${unread}</span>` : ''}
      <button class="icon-btn subtle" data-act="delete" title="${esc(t('past.delete'))}" aria-label="${esc(t('past.delete'))}">${icon('trash')}</button>
    </div>`;
}

$('#past').addEventListener('click', (ev) => {
  const el = ev.target.closest('.peer');
  if (!el) return;
  if (ev.target.closest('button')?.dataset.act === 'delete') askDelete(pastPeer(el.dataset.code));
  else openChat(pastPeer(el.dataset.code));
});

$('#past').addEventListener('keydown', (ev) => {
  if ((ev.key !== 'Enter' && ev.key !== ' ') || !ev.target.classList.contains('peer')) return;
  ev.preventDefault();
  openChat(pastPeer(ev.target.dataset.code));
});

// ---------- delete ----------

let toDelete = null;

/** Asks before deleting the chat with `peer` (it cannot be undone). */
export function askDelete(peer) {
  toDelete = peer;
  $('#delete-title').textContent = t('past.delete_title', { name: peer.name });
  $('#delete-dialog').showModal();
}

$('#delete-cancel').addEventListener('click', () => $('#delete-dialog').close());
$('#delete-go').addEventListener('click', async () => {
  const peer = toDelete;
  $('#delete-dialog').close();
  if (!peer) return;
  // The backend's `chat_wiped` comes as an event, maybe after the call returns.
  deleting.add(peer.code);
  setTimeout(() => deleting.delete(peer.code), 5000);
  try {
    await call('chat_delete', { peer: peer.code });
    if (activePeerCode() === peer.code && !findPeerByCode(peer.code)) closeChat();
    toast(t('past.deleted', { name: peer.name }));
  } catch {
    // call() already showed the error.
  }
  loadChats();
});

on('peers:changed', render);
on('chat:open', render);
on('chat:unread', render);
on('friends:changed', render);
on('lang', render);

loadNames();
