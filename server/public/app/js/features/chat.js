// Chat con un equipo: texto, fotos y, arriba, lo que se le está enviando o
// se recibe de él. Todo va por el canal de iroh con el código de cada equipo
// (ver `pasalo_core::Talk`); el historial lo guarda Rust.

import { errorText, t } from '../i18n/index.js';
import { emit, on } from '../lib/bus.js';
import { $, esc, setHtml } from '../lib/dom.js';
import { bytes, clock, dayKey, dayLabel, shortCode } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { call, invoke, tryCall } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { isMobile } from '../state.js';
import { onBack, setPaneOpen } from './nav.js';
import { avatar, ensureRemotePeer, findPeerByCode, peerCode } from './peers.js';
import { act, items, liveWith, sendPaths } from './transfers.js';
import { openViewer } from './viewer.js';
import { compressImage } from '../lib/images.js';
import { openOnce } from './once.js';
import { isRecording, startRecording } from './recorder.js';

const chat = {
  peer: null, // { code, name, os, platform, addr }
  messages: new Map(), // código → [mensaje]
  unread: new Map(), // código → número
};
// ruta → data URL (o URL de un blob en la web). Las fotos pesan: solo las últimas.
const imageCache = new Map();
const IMAGE_CACHE_MAX = 60;
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
    toast(errorText(err), true);
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
  const call = m.call ? ` call-msg${BAD_OUTCOMES.includes(m.call.outcome) ? ' bad' : ''}` : '';
  el.className = `msg ${m.outgoing ? 'out' : 'in'}${first ? ' first' : ''}${last ? ' last' : ''}${m.image && !m.text && !m.once ? ' photo' : ''}${call}${m.once ? ' once-msg' : ''}`;
  const html = bubbleHtml(m);
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
    const img = el.querySelector('img[data-path]');
    if (img) loadImage(img);

  }
  return el;
}

// ---------- llamadas ----------

// Llamadas que no llegaron a hablarse: van en rojo, como en WhatsApp.
const BAD_OUTCOMES = ['missed', 'no_answer', 'declined', 'busy', 'cancelled', 'failed'];

/** «3:21» o «1:02:03». */
function callTime(ms) {
  const s = Math.round((ms || 0) / 1000);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

const callTotal = (c) => (c.sent || 0) + (c.received || 0);

function callTitle(c) {
  const video = c.media === 'video';
  if (c.outcome === 'completed' || c.outcome === 'lost' && c.duration_ms) return t(video ? 'log.video' : 'log.voice');
  if (c.outcome === 'missed') return t(video ? 'log.missed_video' : 'log.missed_voice');
  return t(`log.${c.outcome}`);
}

function callBubble(m) {
  const c = m.call;
  const talked = c.duration_ms > 0;
  const sub = talked ? `${callTime(c.duration_ms)} · ${bytes(callTotal(c))}` : t(c.media === 'video' ? 'log.video' : 'log.voice');
  return `<div class="bubble"><button class="call-log" type="button" data-call="${esc(m.id)}">
    <span class="call-icon">${icon(c.media === 'video' ? 'video' : 'phone')}</span>
    <span class="call-body"><span class="call-title">${esc(callTitle(c))}</span><span class="call-sub">${esc(sub)}</span></span>
    <span class="meta">${clock(m.ts)}</span></button></div>`;
}

/** Los detalles de una llamada, en un diálogo. */
function openCallDetails(m) {
  const c = m.call;
  const seconds = (c.duration_ms || 0) / 1000;
  const rows = [
    [t('details.direction'), t(c.role === 'caller' ? 'details.outgoing' : 'details.incoming')],
    [t('details.result'), t(`result.${c.outcome}`)],
    [t('details.started'), new Date(c.started || m.ts).toLocaleString()],
  ];
  if (c.duration_ms > 0) {
    rows.push(
      [t('details.duration'), callTime(c.duration_ms)],
      [t('details.total'), bytes(callTotal(c))],
      [t('details.sent'), bytes(c.sent || 0)],
      [t('details.received'), bytes(c.received || 0)],
    );
    if (c.media === 'video') {
      rows.push([t('details.video'), t('details.updown', { up: bytes(c.video_sent || 0), down: bytes(c.video_received || 0) })]);
    }
    if (seconds >= 1) rows.push([t('details.avg'), `${((callTotal(c) * 8) / 1000 / seconds).toFixed(1)} kbps`]);
    if (c.audio) rows.push([t('details.audio_q'), t(`voice.${c.audio}`, { kbps: '' }).replace(/\s*·\s*~?\s*kbps$/, '')]);
    if (c.video) rows.push([t('details.video_q'), t(`video.${c.video}`, { kbps: '' }).replace(/\s*·\s*~?\s*kbps$/, '')]);
    if (c.media === 'video' && 'blur' in c) {
      rows.push([t('details.blur'), t(c.blur ? 'details.yes' : 'details.no')], [t('details.enhance'), t(c.enhance ? 'details.yes' : 'details.no')]);
    }
    if (c.lost || c.recovered) rows.push([t('details.loss'), t('details.loss_value', { lost: c.lost || 0, recovered: c.recovered || 0 })]);
  }
  setHtml($('#call-details-list'), rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join(''));
  $('#call-details').showModal();
}

$('#call-details-close').addEventListener('click', () => $('#call-details').close());

/** Foto de una vez: no se enseña aquí; se abre (y se borra) al tocarla. */
function onceHtml(m) {
  const label = m.outgoing ? t(m.opened ? 'once.seen' : 'once.sent') : t(m.opened ? 'once.opened' : 'once.view');
  const inner = `${icon('shield')}<span>${esc(label)}</span>`;
  if (!m.outgoing && !m.opened) return `<button type="button" class="once-chip ready" data-once="${esc(m.id)}">${inner}</button>`;
  return `<span class="once-chip">${inner}</span>`;
}

/** «0:42» de una nota de voz. */
function noteTime(ms) {
  const s = Math.round((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function bubbleHtml(m) {
  if (m.call) return callBubble(m);
  const pending = m.outgoing && m.status === 'pending';
  const tick = m.outgoing
    ? `<span class="tick ${pending ? 'pending' : ''}" title="${esc(t(pending ? 'chat.pending' : 'chat.delivered'))}">${icon(pending ? 'clock' : 'check')}</span>`
    : '';
  if (m.once) return `<div class="bubble">${onceHtml(m)}<span class="meta">${clock(m.ts)}${tick}</span></div>`;
  if (m.audio) {
    // Reproductor propio: el de serie no sabe la duración de lo grabado con
    // MediaRecorder (sale «0:00 / 0:00») y ocupa media pantalla.
    return `<div class="bubble"><div class="voice-note" data-ms="${Number(m.duration_ms) || 0}">
      <button class="vn-play" type="button" aria-label="${esc(t('chat.voice_note'))}">${icon('play')}</button>
      <div class="vn-track"><div class="vn-fill"></div></div>
      <span class="vn-time">${esc(noteTime(m.duration_ms))}</span>
      <audio preload="none" data-path="${esc(m.audio)}"></audio></div>
      <span class="meta">${clock(m.ts)}${tick}</span></div>`;
  }
  const img = m.image
    ? `<button class="msg-img" type="button" aria-label="${esc(t('chat.photo'))}"><img data-path="${esc(m.image)}" alt=""></button>`
    : '';
  const text = m.text ? `<span class="msg-text">${esc(m.text)}</span>` : '';
  return `<div class="bubble">${img}${text}<span class="meta">${clock(m.ts)}${tick}</span></div>`;
}

// ---------- notas de voz ----------

let playing = null; // el <audio> que suena ahora

async function toggleNote(note) {
  const audio = note.querySelector('audio');
  if (!audio.src) {
    try {
      audio.src = await invoke('chat_image', { path: audio.dataset.path });
    } catch (err) {
      note.classList.add('broken');
      toast(errorText(err), true);
      return;
    }
    bindNote(note, audio);
  }
  if (!audio.paused) {
    audio.pause();
    return;
  }
  if (playing && playing !== audio) playing.pause();
  playing = audio;
  audio.play().catch((err) => toast(errorText(err), true));
}

function bindNote(note, audio) {
  const total = (Number(note.dataset.ms) || 0) / 1000;
  const button = note.querySelector('.vn-play');
  const show = () => {
    const length = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : total;
    const pct = length ? Math.min(100, (audio.currentTime / length) * 100) : 0;
    note.querySelector('.vn-fill').style.width = `${pct}%`;
    note.querySelector('.vn-time').textContent = noteTime((audio.currentTime || 0) * 1000 || total * 1000);
  };
  audio.addEventListener('play', () => {
    button.innerHTML = icon('pause');
    note.classList.add('playing');
  });
  audio.addEventListener('pause', () => {
    button.innerHTML = icon('play');
    note.classList.remove('playing');
  });
  audio.addEventListener('timeupdate', show);
  audio.addEventListener('ended', () => {
    audio.currentTime = 0;
    note.querySelector('.vn-fill').style.width = '0%';
    note.querySelector('.vn-time').textContent = noteTime(total * 1000);
  });
}

async function loadImage(img) {
  const path = img.dataset.path;
  if (!imageCache.has(path)) {
    try {
      imageCache.set(path, await invoke('chat_image', { path }));
      while (imageCache.size > IMAGE_CACHE_MAX) {
        const [oldest, url] = imageCache.entries().next().value;
        imageCache.delete(oldest);
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      }
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
  const note = ev.target.closest('.vn-play')?.closest('.voice-note');
  if (note) {
    toggleNote(note);
    return;
  }
  const once = ev.target.closest('[data-once]');
  if (once && chat.peer) {
    openOnce(chat.peer.code, once.dataset.once);
    return;
  }
  const call = ev.target.closest('[data-call]');
  if (call) {
    const m = (chat.messages.get(chat.peer?.code) || []).find((x) => x.id === call.dataset.call);
    if (m?.call) openCallDetails(m);
    return;
  }
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
  } else if (!input.value) {
    // No salió: lo escrito no se pierde.
    input.value = text;
    autosize();
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
  } else if (what === 'once') {
    $('#chat-once-file').click();
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

// Las fotos del móvil pesan varios MB: todas pasan por compressImage (1600 px,
// WebP o JPEG, sin metadatos) antes de enviarlas, unos 150-400 KB.
async function sendImage(file) {
  if (!chat.peer) return;
  try {
    const { data, ext } = await compressImage(file);
    const m = await tryCall('chat_send_image', { peer: chat.peer.code, data, ext });
    if (m) {
      upsertMessage(m);
      renderChat(true);
    }
  } catch (err) {
    toast(errorText(err), true);
  }
}

// Foto de una vez: igual de comprimida, y sin quedarse en este equipo.
$('#chat-once-file').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file || !chat.peer) return;
  try {
    const { data, ext } = await compressImage(file, 1440);
    const m = await tryCall('chat_send_once', { peer: chat.peer.code, data, ext });
    if (m) {
      upsertMessage(m);
      renderChat(true);
    }
  } catch (err) {
    toast(errorText(err), true);
  }
});

// Nota de voz.
$('#chat-mic').addEventListener('click', () => {
  const peer = chat.peer;
  if (!peer || isRecording()) return;
  startRecording(async ({ data, ext, durationMs }) => {
    const m = await tryCall('chat_send_audio', { peer: peer.code, data, ext, durationMs });
    if (m && chat.peer?.code === peer.code) {
      upsertMessage(m);
      renderChat(true);
    }
  });
});

// ---------- transferencias con este equipo ----------

function renderStrip() {
  const live = chat.peer ? liveWith(chat.peer) : [];
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
  } else if (message.call) {
    // De las llamadas solo avisan las perdidas (el resto ya se vio en pantalla).
    if (message.call.outcome === 'missed') {
      chat.unread.set(message.peer, unreadCount(message.peer) + 1);
      emit('chat:unread');
    }
  } else if (!message.outgoing && !message.opened) {
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
