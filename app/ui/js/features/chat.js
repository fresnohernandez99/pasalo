// Chat con un equipo: texto, fotos y, arriba, lo que se le está enviando o
// se recibe de él. Todo va por el canal de iroh con el código de cada equipo
// (ver `pasalo_core::Talk`); el historial lo guarda Rust.

import { t } from '../i18n/index.js';
import { emit, on } from '../lib/bus.js';
import { $, esc, setHtml } from '../lib/dom.js';
import { clock, dayKey, dayLabel, shortCode } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { call, invoke, tryCall } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { isMobile } from '../state.js';
import { onBack, setPaneOpen } from './nav.js';
import { avatar, ensureRemotePeer, findPeerByCode, peerCode } from './peers.js';
import { act, items, liveWith, sendPaths } from './transfers.js';
import { openViewer } from './viewer.js';

const chat = {
  peer: null, // { code, name, os, platform, addr }
  messages: new Map(), // código → [mensaje]
  unread: new Map(), // código → número
};
const imageCache = new Map(); // ruta → data URL
// Mensajes seguidos del mismo lado con menos de esto entre ellos van juntos.
const GROUP_MS = 5 * 60_000;

export const activePeerCode = () => chat.peer?.code || null;
export const activePeer = () => chat.peer;
export const unreadCount = (code) => chat.unread.get(code) || 0;

export async function openChat(peer) {
  const code = peerCode(peer);
  if (!code) return;
  chat.peer = { code, name: peer.name, os: peer.os || peer.platform, platform: peer.platform, addr: peer.addr };
  chat.unread.delete(code);
  emit('chat:open');
  $('#chat-avatar').outerHTML = avatar(peer.name, chat.peer.os).replace('class="avatar ', 'id="chat-avatar" class="avatar ');
  $('#chat-name').textContent = peer.name;
  $('#chat-sub').textContent = peer.platform === 'remote' || peer.platform === 'partner' ? t('chat.remote') : t('chat.lan');
  $('#chat-sub').title = shortCode(code);
  $('#chat').hidden = false;
  $('#pane-empty').hidden = true;
  closeAttachMenu();
  setPaneOpen(true);
  renderStrip();
  try {
    chat.messages.set(code, await invoke('chat_history', { peer: code }));
  } catch (err) {
    toast(String(err?.detail || err), true);
  }
  renderChat(true);
  // En el móvil, el teclado solo sale al tocar el campo.
  if (!isMobile()) $('#chat-input').focus();
}

export function closeChat() {
  chat.peer = null;
  $('#chat').hidden = true;
  $('#pane-empty').hidden = false;
  setPaneOpen(false);
  emit('chat:open');
}

onBack(() => {
  if (closeAttachMenu()) return true;
  if (!chat.peer || !isMobile()) return false;
  closeChat();
  return true;
});

function upsertMessage(m) {
  const list = chat.messages.get(m.peer) || [];
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) list[i] = m;
  else list.push(m);
  chat.messages.set(m.peer, list);
}

// ---------- mensajes ----------

// Cada mensaje y cada separador de día es un nodo que se reutiliza: rehacerlo
// todo volvía a decodificar las imágenes y hacía saltar el scroll.
const nodes = new Map(); // clave → elemento

function renderChat(jump = false) {
  if (!chat.peer) return;
  const list = chat.messages.get(chat.peer.code) || [];
  const box = $('#chat-list');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (box.dataset.peer !== chat.peer.code) {
    box.replaceChildren();
    nodes.clear();
    box.dataset.peer = chat.peer.code;
  }
  if (!list.length) {
    setHtml(box, `<div class="empty">
      <div class="empty-icon">${icon('shield')}</div>
      <div class="empty-title">${esc(t('chat.empty'))}</div>
      <div>${esc(t('chat.private'))}</div></div>`);
    nodes.clear();
    return;
  }
  delete box.dataset.html;
  const wanted = [];
  list.forEach((m, i) => {
    const prev = list[i - 1];
    const next = list[i + 1];
    if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) wanted.push(dayNode(m.ts));
    const joinsPrev = prev && prev.outgoing === m.outgoing && m.ts - prev.ts < GROUP_MS && dayKey(prev.ts) === dayKey(m.ts);
    const joinsNext = next && next.outgoing === m.outgoing && next.ts - m.ts < GROUP_MS && dayKey(next.ts) === dayKey(m.ts);
    wanted.push(messageNode(m, !joinsPrev, !joinsNext));
  });
  // Poner los nodos en orden moviendo solo los que no están en su sitio.
  wanted.forEach((node, i) => {
    if (box.children[i] !== node) box.insertBefore(node, box.children[i] || null);
  });
  while (box.children.length > wanted.length) box.lastChild.remove();
  if (jump || nearBottom || list.at(-1)?.outgoing) box.scrollTop = box.scrollHeight;
}

function dayNode(ts) {
  const key = `day:${dayKey(ts)}`;
  let el = nodes.get(key);
  if (!el) {
    el = document.createElement('div');
    el.className = 'day';
    nodes.set(key, el);
  }
  el.innerHTML = `<span>${esc(dayLabel(ts))}</span>`;
  return el;
}

function messageNode(m, first, last) {
  let el = nodes.get(m.id);
  if (!el) {
    el = document.createElement('div');
    nodes.set(m.id, el);
  }
  el.className = `msg ${m.outgoing ? 'out' : 'in'}${first ? ' first' : ''}${last ? ' last' : ''}${m.image && !m.text ? ' photo' : ''}`;
  const html = bubbleHtml(m);
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
    const img = el.querySelector('img[data-path]');
    if (img) loadImage(img);
  }
  return el;
}

function bubbleHtml(m) {
  const pending = m.outgoing && m.status === 'pending';
  const tick = m.outgoing
    ? `<span class="tick ${pending ? 'pending' : ''}" title="${esc(t(pending ? 'chat.pending' : 'chat.delivered'))}">${icon(pending ? 'clock' : 'check')}</span>`
    : '';
  const img = m.image ? `<button class="msg-img" type="button"><img data-path="${esc(m.image)}" alt=""></button>` : '';
  const text = m.text ? `<span class="msg-text">${esc(m.text)}</span>` : '';
  return `<div class="bubble">${img}${text}<span class="meta">${clock(m.ts)}${tick}</span></div>`;
}

async function loadImage(img) {
  const path = img.dataset.path;
  if (!imageCache.has(path)) {
    try {
      imageCache.set(path, await invoke('chat_image', { path }));
    } catch {
      return;
    }
  }
  const box = $('#chat-list');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  img.src = imageCache.get(path);
  img.addEventListener(
    'load',
    () => {
      img.closest('.msg-img')?.style.setProperty('aspect-ratio', `${img.naturalWidth} / ${img.naturalHeight}`);
      if (atBottom) box.scrollTop = box.scrollHeight;
    },
    { once: true },
  );
}

$('#chat-list').addEventListener('click', (ev) => {
  const img = ev.target.closest('.msg-img')?.querySelector('img');
  if (img?.src) openViewer(img);
});

$('#chat-close').addEventListener('click', closeChat);

// ---------- escribir ----------

const input = $('#chat-input');

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  $('#chat-send').disabled = !input.value.trim();
}

$('#chat-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = input.value;
  if (!text.trim() || !chat.peer) return;
  input.value = '';
  autosize();
  const m = await tryCall('chat_send', { peer: chat.peer.code, text });
  if (m) {
    upsertMessage(m);
    renderChat(true);
  }
});

input.addEventListener('keydown', (ev) => {
  // Intro envía; Mayús+Intro hace salto de línea (en el móvil, el teclado decide).
  if (ev.key === 'Enter' && !ev.shiftKey && !isMobile()) {
    ev.preventDefault();
    $('#chat-form').requestSubmit();
  }
});
input.addEventListener('input', autosize);

// ---------- adjuntar ----------

function closeAttachMenu() {
  const open = !$('#attach-menu').hidden;
  $('#attach-menu').hidden = true;
  $('#chat-attach').classList.remove('on');
  return open;
}

$('#chat-attach').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const menu = $('#attach-menu');
  menu.hidden = !menu.hidden;
  $('#chat-attach').classList.toggle('on', !menu.hidden);
});
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#attach-menu')) closeAttachMenu();
});

$('#attach-menu').addEventListener('click', async (ev) => {
  const what = ev.target.closest('button')?.dataset.attach;
  if (!what || !chat.peer) return;
  closeAttachMenu();
  const peer = chat.peer;
  if (what === 'photo') {
    $('#chat-file').click();
  } else if (what === 'files') {
    sendPaths(peer, await call('pick_files'));
  } else if (what === 'folder') {
    const folder = await call('pick_folder');
    if (folder) sendPaths(peer, [folder]);
  }
});

$('#chat-file').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = '';
  for (const file of files) await sendImage(file);
});

// Las fotos del móvil pesan varios MB: se reducen a 1600 px en JPEG antes de
// enviarlas (unos 200-400 KB), que con mala señal es lo que importa.
async function sendImage(file) {
  if (!chat.peer) return;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    const m = await tryCall('chat_send_image', { peer: chat.peer.code, data, ext: 'jpg' });
    if (m) {
      upsertMessage(m);
      renderChat(true);
    }
  } catch (err) {
    toast(String(err?.message || err), true);
  }
}

// ---------- transferencias con este equipo ----------

function renderStrip() {
  const live = chat.peer ? liveWith(chat.peer.name) : [];
  const html = live
    .map((tr) => {
      const incoming = tr.direction === 'incoming';
      const pct = tr.total ? Math.min(100, (tr.done / tr.total) * 100) : 0;
      const status = tr.status === 'active' ? `${pct.toFixed(0)} %` : t(`status.${tr.status}`);
      const buttons =
        tr.status === 'request'
          ? `<button class="ghost small" data-act="decline">${esc(t('btn.decline'))}</button><button class="primary small" data-act="accept">${esc(t('btn.accept'))}</button>`
          : `<button class="ghost small danger-text" data-act="cancel">${esc(t('btn.cancel'))}</button>`;
      return `<div class="strip-row" data-key="${esc(tr.key)}">
        <span class="strip-icon">${icon(incoming ? 'download' : 'upload')}</span>
        <div class="strip-body">
          <div class="strip-line"><span class="strip-title">${esc(tr.roots.join(', ') || t(incoming ? 'item.receiving' : 'item.sending'))}</span><span class="strip-status">${esc(status)}</span></div>
          <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
        </div>
        ${buttons}
      </div>`;
    })
    .join('');
  setHtml($('#chat-strip'), html);
  $('#chat-strip').hidden = !live.length;
}

$('#chat-strip').addEventListener('click', (ev) => {
  const button = ev.target.closest('button[data-act]');
  const item = items.get(ev.target.closest('.strip-row')?.dataset.key);
  if (button && item) act(item, button.dataset.act).catch(() => {});
});

on('transfers:changed', renderStrip);

// El equipo del chat abierto se fue (dejó la LAN o la pareja se desconectó):
// se sale del chat. Lo que quedó sin entregar se envía cuando vuelva.
on('peers:changed', () => {
  if (!chat.peer || findPeerByCode(chat.peer.code)) return;
  const { name } = chat.peer;
  closeChat();
  toast(t('toast.peer_gone', { name }));
});

// ---------- eventos ----------

export function onChatEvent({ message, name }) {
  if (name) ensureRemotePeer(message.peer, name);
  upsertMessage(message);
  if (chat.peer?.code === message.peer) {
    renderChat();
  } else if (!message.outgoing) {
    chat.unread.set(message.peer, unreadCount(message.peer) + 1);
    emit('chat:unread');
    toast(t('toast.message_from', { name: name || shortCode(message.peer) }));
  }
}

on('lang', () => {
  nodes.clear();
  $('#chat-list').replaceChildren();
  delete $('#chat-list').dataset.peer;
  renderChat();
  renderStrip();
});
