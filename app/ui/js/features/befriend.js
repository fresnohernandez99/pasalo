// Solicitud de amistad desde el chat con alguien de otra red: la ★ de la
// cabecera le pide ser amigos (señal `friend_ask`) y al otro le sale arriba
// del chat con Aceptar y Rechazar. Si acepta (`friend_yes`), los dos se
// guardan y desde entonces se ven en Descubrir (ver friends.js).

import { t } from '../i18n/index.js';
import { on } from '../lib/bus.js';
import { $, esc, setHtml } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { call } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { activePeer } from './chat.js';
import { addFriend, friendOf, removeFriend } from './friends.js';
import { findPeerByCode } from './peers.js';

/** Códigos a los que se pidió ser amigos: solo de ellos vale un `friend_yes`. */
const asked = new Set();
/** código → { name, os } de quien pidió ser amigo y espera respuesta. */
const asks = new Map();

// Only while it's here: asking a peer that is gone can't reach it.
const isRemote = (peer) => peer && (peer.platform === 'remote' || peer.platform === 'partner') && !!findPeerByCode(peer.code);
const signal = (peer, kind) => call('call_signal', { peer, call: '', kind, data: null });

function render() {
  const peer = activePeer();
  const button = $('#chat-friend');
  button.hidden = !isRemote(peer);
  if (button.hidden) {
    $('#chat-friend-bar').hidden = true;
    return;
  }
  const friend = !!friendOf(peer.code);
  const title = t(friend ? 'friends.remove' : asked.has(peer.code) ? 'friends.asked' : 'friends.add');
  button.classList.toggle('on', friend);
  button.setAttribute('aria-pressed', String(friend));
  button.title = title;
  button.setAttribute('aria-label', title);
  const ask = asks.get(peer.code);
  $('#chat-friend-bar').hidden = !ask;
  if (ask) {
    setHtml(
      $('#chat-friend-bar'),
      `<span class="strip-icon">${icon('star')}</span>
      <span class="grow">${esc(t('friends.wants', { name: peer.name }))}</span>
      <button class="ghost small" data-act="no">${esc(t('btn.decline'))}</button>
      <button class="primary small" data-act="yes">${esc(t('btn.accept'))}</button>`,
    );
  }
}

$('#chat-friend').innerHTML = icon('star');
$('#chat-friend').addEventListener('click', async () => {
  const peer = activePeer();
  if (!isRemote(peer)) return;
  if (friendOf(peer.code)) {
    removeFriend(peer.code);
    toast(t('toast.friend_removed', { name: peer.name }));
    return;
  }
  // Si ya nos lo pidió él, pulsar la ★ es aceptar.
  if (asks.has(peer.code)) return answer(peer, true);
  try {
    await signal(peer.code, 'friend_ask');
    asked.add(peer.code);
    toast(t('toast.friend_asked', { name: peer.name }));
  } catch {
    // call() ya avisó (p. ej. el otro no está conectado).
  }
  render();
});

async function answer(peer, yes) {
  asks.delete(peer.code);
  render();
  try {
    await signal(peer.code, yes ? 'friend_yes' : 'friend_no');
  } catch {
    // Si no le llega, que pueda volver a pedirlo.
    return;
  }
  if (yes) {
    addFriend({ code: peer.code, name: peer.name, os: peer.os });
    toast(t('toast.friend_added', { name: peer.name }));
  }
}

$('#chat-friend-bar').addEventListener('click', (ev) => {
  const act = ev.target.closest('button[data-act]')?.dataset.act;
  const peer = activePeer();
  if (act && peer) answer(peer, act === 'yes');
});

/** Señales `friend_*` del otro equipo. */
export function onFriendSignal({ peer, name, signal: s }) {
  if (s.kind === 'friend_ask') {
    // Ya era amigo (quizá él lo perdió): se le confirma sin preguntar.
    if (friendOf(peer)) {
      signal(peer, 'friend_yes').catch(() => {});
      return;
    }
    asks.set(peer, { name });
    toast(t('toast.friend_wants', { name }));
  } else if (s.kind === 'friend_yes') {
    // Solo vale si se le pidió: nadie se añade solo a los amigos de otro.
    if (!asked.delete(peer)) return;
    const chatting = activePeer()?.code === peer ? activePeer() : null;
    addFriend({ code: peer, name, os: chatting?.os || '' });
    toast(t('toast.friend_accepted', { name }));
  } else if (s.kind === 'friend_no') {
    if (asked.delete(peer)) toast(t('toast.friend_declined', { name }));
  }
  render();
}

on('chat:open', render);
on('peers:changed', render);
on('friends:changed', render);
on('lang', render);
