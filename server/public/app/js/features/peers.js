// Lista de equipos: los de la LAN (los anuncia el núcleo), los añadidos por
// IP, la pareja del server y quien escribió por el chat sin estar en la lista.
// Tocar uno abre su chat; el botón de al lado envía archivos.

import { t } from '../i18n/index.js';
import { emit, on } from '../lib/bus.js';
import { $, $$, esc, setHtml } from '../lib/dom.js';
import { initials } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { call, invoke, listen } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { app, isMobile } from '../state.js';
import { activePeerCode, openChat, unreadCount } from './chat.js';
import { openLink } from './lobby.js';
import { openTextDialog, pauseFor, resumeFor, sendPaths } from './transfers.js';

/** device_id → { device_id, name, platform, os?, addr, code? } */
export const peers = new Map();

const PLATFORMS = { macos: 'Mac', windows: 'Windows', linux: 'Linux', android: 'Android', ios: 'iPhone' };
const KINDS = { android: 'devPhone', ios: 'devPhone', macos: 'devLaptop', windows: 'devDesktop', linux: 'devDesktop' };

export function platformName(platform) {
  if (['manual', 'remote', 'partner'].includes(platform)) return t(`platform.${platform}`);
  return PLATFORMS[platform] || platform || '';
}

/** Avatar con las iniciales y, en la esquina, el tipo de equipo. */
export function avatar(name, os, cls = '') {
  const kind = KINDS[os];
  const badge = kind ? `<span class="device" title="${esc(platformName(os))}">${icon(kind)}</span>` : '';
  return `<div class="avatar ${cls}" style="--hue:${hue(name)}">${esc(initials(name))}${badge}</div>`;
}

/** Un color estable por nombre, para distinguir de un vistazo. */
function hue(name) {
  let h = 0;
  for (const c of name || '') h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** El código de iroh del equipo, si lo tiene (sin él no hay chat ni llamadas). */
export function peerCode(p) {
  return p.platform === 'remote' || p.platform === 'partner' ? p.addr : p.code || null;
}

export function isCode(value) {
  return /^[0-9a-z]{52,64}$/i.test(value.replace(/\s/g, ''));
}

/** Dónde está: tipo de equipo y su IP en la LAN, o que está en otra red. */
export function peerWhere(p) {
  if (p.platform === 'partner') return t('platform.partner');
  if (p.platform === 'remote') return t('peers.remote');
  const host = (p.addr || '').replace(/:\d+$/, '');
  if (p.platform === 'manual') return `${t('platform.manual')} · ${host}`;
  return [platformName(p.platform), host].filter(Boolean).join(' · ');
}

// ---------- añadidos a mano y remotos ----------

function loadManualPeers() {
  try {
    for (const addr of JSON.parse(localStorage.getItem('manualPeers') || '[]')) addManualPeer(addr, false);
  } catch {}
}

function saveManualPeers() {
  const addrs = [...peers.values()].filter((p) => p.platform === 'manual').map((p) => p.addr);
  try {
    localStorage.setItem('manualPeers', JSON.stringify(addrs));
  } catch {}
}

function addManualPeer(input, save = true) {
  const value = input.trim();
  if (!value) return;
  const addr = value.includes(':') && !value.includes('::') ? value : `${value}:4646`;
  peers.set(`manual:${addr}`, { device_id: `manual:${addr}`, name: value.split(':')[0], platform: 'manual', addr });
  if (save) saveManualPeers();
  renderPeers();
}

// Equipo de otra red: la pareja del server, o alguien que escribió por el
// chat sin estar en la lista. No se guardan: al abrir la app se empieza
// desconectado.
export function addRemotePeer({ code, name, os, partner = false }) {
  const key = partner ? 'partner' : `remote:${code}`;
  peers.set(key, { device_id: key, name, platform: partner ? 'partner' : 'remote', os, addr: code });
  renderPeers();
}

/** Un mensaje o una llamada de alguien que no está en la lista lo añade. */
export function ensureRemotePeer(code, name) {
  if (![...peers.values()].some((p) => peerCode(p) === code)) addRemotePeer({ code, name, os: '' });
}

export function removePeer(key) {
  peers.delete(key);
  renderPeers();
}

export function findPeerByCode(code) {
  return [...peers.values()].find((p) => peerCode(p) === code) || null;
}

// ---------- lista ----------

export function renderPeers() {
  // La pareja, si además está en la LAN, sale una sola vez (como pareja).
  const partner = peers.get('partner')?.addr;
  const list = [...peers.values()]
    .filter((p) => p.platform === 'partner' || !partner || p.code !== partner)
    .sort((a, b) => (b.platform === 'partner') - (a.platform === 'partner') || a.name.localeCompare(b.name));
  const html = list.length
    ? list.map(peerRow).join('')
    : `<div class="empty">
        <div class="empty-icon">${icon('wifi')}</div>
        <div class="empty-title">${esc(t('peers.empty'))}</div>
        <div>${esc(t('peers.empty_hint'))}</div>
      </div>`;
  setHtml($('#peers'), html);
  $('#peers-hint').hidden = !list.length;
  emit('peers:changed');
}

function peerRow(p) {
  const code = peerCode(p);
  const unread = code ? unreadCount(code) : 0;
  const open = code && code === activePeerCode();
  const removable = ['manual', 'remote'].includes(p.platform);
  return `
    <div class="peer ${open ? 'open' : ''}" data-id="${esc(p.device_id)}" role="button" tabindex="0">
      ${avatar(p.name, p.os || p.platform)}
      <div class="info">
        <div class="pname">${esc(p.name)}</div>
        <div class="sub">${esc(peerWhere(p))}</div>
      </div>
      ${unread ? `<span class="badge">${unread}</span>` : ''}
      <button class="icon-btn" data-act="files" title="${esc(t('peers.send_files'))}" aria-label="${esc(t('peers.send_files'))}">${icon('upload')}</button>
      ${removable ? `<button class="icon-btn subtle" data-act="remove" title="${esc(t('btn.remove'))}" aria-label="${esc(t('btn.remove'))}">${icon('close')}</button>` : ''}
    </div>`;
}

/** Con código se chatea (cifrado, con historial y llamadas); sin él (equipos
 * añadidos por IP o versiones viejas) queda el texto suelto de siempre. */
function openPeer(peer) {
  if (peerCode(peer)) openChat(peer);
  else openTextDialog(peer);
}

$('#peers').addEventListener('click', async (ev) => {
  const row = ev.target.closest('.peer');
  const peer = row && peers.get(row.dataset.id);
  if (!peer) return;
  const act = ev.target.closest('button')?.dataset.act;
  if (act === 'files') {
    sendPaths(peer, await call('pick_files'));
  } else if (act === 'remove') {
    peers.delete(peer.device_id);
    saveManualPeers();
    renderPeers();
  } else {
    openPeer(peer);
  }
});

$('#peers').addEventListener('keydown', (ev) => {
  if ((ev.key !== 'Enter' && ev.key !== ' ') || !ev.target.classList.contains('peer')) return;
  ev.preventDefault();
  const peer = peers.get(ev.target.dataset.id);
  if (peer) openPeer(peer);
});

// ---------- añadir por IP ----------

function openAddDialog() {
  $('#manual-ip').value = '';
  $('#add-dialog').showModal();
  if (!isMobile()) $('#manual-ip').focus();
}

$('#add-fab').addEventListener('click', openAddDialog);
$('#add-cancel').addEventListener('click', () => $('#add-dialog').close());
$('#manual').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const value = $('#manual-ip').value.trim();
  if (!value) return;
  // Un código o un enlace de Pasalo: se llega por internet, sin server.
  const link = isCode(value) ? { code: value.replace(/\s/g, ''), name: '' } : await invoke('link_parse', { text: value });
  if (link) {
    $('#add-dialog').close();
    openLink(link);
    return;
  }
  if (/^[a-z]+:\/\//i.test(value)) {
    toast(t('toast.link_invalid'), true);
    return;
  }
  // En el navegador no hay red local: una IP no lleva a ninguna parte.
  if (app.settings?.web) {
    toast(t('toast.web_code_only'), true);
    return;
  }
  addManualPeer(value);
  $('#add-dialog').close();
});

$('#refresh').addEventListener('click', () => {
  call('refresh');
  toast(t('toast.searching'));
});

// ---------- arrastrar y soltar (escritorio) ----------

// Tauri da la posición en píxeles físicos.
function peerAt(position) {
  const ratio = window.devicePixelRatio || 1;
  return document.elementFromPoint(position.x / ratio, position.y / ratio)?.closest('.peer') || null;
}

function highlight(row) {
  for (const el of $$('.peer.drop')) if (el !== row) el.classList.remove('drop');
  row?.classList.add('drop');
}

listen('tauri://drag-enter', () => document.body.classList.add('dragging'));
listen('tauri://drag-over', (ev) => highlight(peerAt(ev.payload.position)));
listen('tauri://drag-leave', () => {
  document.body.classList.remove('dragging');
  highlight(null);
});
listen('tauri://drag-drop', (ev) => {
  document.body.classList.remove('dragging');
  const row = peerAt(ev.payload.position);
  highlight(null);
  // Soltado fuera de la lista: al equipo del chat abierto, o al único que haya.
  const fallback = findPeerByCode(activePeerCode()) || (peers.size === 1 ? [...peers.values()][0] : null);
  const peer = (row && peers.get(row.dataset.id)) || fallback;
  if (!peer) {
    toast(t('toast.drop_on_peer'), true);
    return;
  }
  sendPaths(peer, ev.payload.paths);
});

// ---------- eventos ----------

export function initPeers(snapshot) {
  for (const p of snapshot.peers) peers.set(p.device_id, p);
  loadManualPeers();
  renderPeers();
}

export function onPeerEvent(e) {
  if (e.kind === 'peer_found') {
    peers.set(e.device_id, { device_id: e.device_id, name: e.name, platform: e.platform, addr: e.addr, code: e.code });
    resumeFor(e.addr);
  } else {
    // Lo que se le enviaba queda en pausa hasta que vuelva; su chat se cierra
    // (ver chat.js). La llamada no: esa la corta la propia conexión si se cae.
    pauseFor(peers.get(e.device_id)?.addr);
    peers.delete(e.device_id);
  }
  renderPeers();
}

on('chat:unread', renderPeers);
on('chat:open', renderPeers);
on('lang', renderPeers);
