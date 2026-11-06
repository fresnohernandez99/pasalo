// Conexión con otras redes por el server. La app arranca sin conexión y no
// intenta nada fuera de la LAN hasta que el usuario pulsa «Conectarse».
// Conectado, ve quién más lo está y puede pedirle conectarse; si el otro
// acepta, los dos dejan el server y quedan conectados solo entre ellos.
//
// También pinta la cabecera con este equipo: sin conexión enseña su IP y su
// código; conectado, solo el nombre, con quién está y «Desconectar».

import { t } from '../i18n/index.js';
import { on } from '../lib/bus.js';
import { $, esc, setHtml } from '../lib/dom.js';
import { initials, shortCode } from '../lib/format.js';
import { call } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { app } from '../state.js';
import { endCallWith } from './call.js';
import { addRemotePeer, avatar, removePeer } from './peers.js';
import { pauseFor, resumeFor } from './transfers.js';

const net = {
  state: 'offline', // offline | connecting | online | paired
  users: [], // [{ id, name, platform }] en el server
  incoming: new Map(), // id de solicitud → { id, name, platform }
  outgoing: new Map(), // id de usuario → id de solicitud
  partner: null, // { id, name, platform, code }
  error: '',
};

export function initNet(snapshot) {
  if (snapshot.partner) setPartner(snapshot.partner);
  else setNetState(snapshot.online ? 'online' : 'offline');
}

function setNetState(state) {
  net.state = state;
  if (state !== 'online') {
    net.users = [];
    net.incoming.clear();
    net.outgoing.clear();
    net.error = '';
  }
  renderHeader();
  renderLobby();
}

// ---------- cabecera ----------

export function renderHeader() {
  const s = app.settings;
  if (!s) return;
  const { state, partner } = net;
  const connected = state === 'online' || state === 'paired';
  $('#me-avatar').textContent = initials(s.name);
  $('#me-name').textContent = s.name;
  // Conectado no hacen falta la IP ni el código: solo con quién se está.
  $('#me-details').hidden = connected;
  $('#code-line').hidden = connected || !s.code;
  if (!connected) {
    const ips = s.ips.length ? s.ips.join(', ') : t('me.no_network');
    $('#me-sub').textContent = t('me.sub', { ips, port: s.port });
    if (s.code) $('#me-code').textContent = shortCode(s.code);
  }
  $('#net-dot').className = `dot ${state}`;
  $('#net-state').textContent =
    state === 'paired' ? t('net.paired', { name: partner.name }) : t(state === 'offline' ? 'net.local' : `net.${state}`);
  const toggle = $('#net-toggle');
  toggle.textContent = t(state === 'offline' ? 'net.connect' : 'net.disconnect');
  toggle.className = state === 'offline' ? 'primary small' : 'ghost small';
  toggle.disabled = state === 'connecting';
  // Sin server ni pareja no hay nada de qué desconectarse; sin server
  // configurado, tampoco a qué conectarse.
  toggle.hidden = state === 'offline' && !s.code;
}

// ---------- en línea ahora ----------

function renderLobby() {
  $('#lobby').hidden = net.state !== 'online';
  if (net.state !== 'online') return;
  $('#lobby-status').textContent = net.error ? t('lobby.unreachable') : '';
  const rows = [];
  for (const [request, from] of net.incoming) {
    rows.push(`
      <div class="lobby-row request" data-request="${esc(request)}">
        <div class="lobby-who">
          ${avatar(from.name, from.platform, 'small')}
          <div class="info"><div class="pname">${esc(from.name)}</div><div class="sub">${esc(t('lobby.wants'))}</div></div>
        </div>
        <div class="lobby-actions">
          <button class="ghost small" data-act="decline">${esc(t('btn.decline'))}</button>
          <button class="primary small" data-act="accept">${esc(t('btn.accept'))}</button>
        </div>
      </div>`);
  }
  const asking = new Set([...net.incoming.values()].map((u) => u.id));
  for (const user of net.users.filter((u) => !asking.has(u.id))) {
    const pending = net.outgoing.has(user.id);
    rows.push(`
      <div class="lobby-row" data-user="${esc(user.id)}">
        <div class="lobby-who">
          ${avatar(user.name, user.platform, 'small')}
          <div class="info"><div class="pname">${esc(user.name)}</div>${pending ? `<div class="sub">${esc(t('lobby.waiting'))}</div>` : ''}</div>
        </div>
        ${pending
          ? `<button class="ghost small" data-act="cancel">${esc(t('btn.cancel'))}</button>`
          : `<button class="primary small" data-act="request">${esc(t('lobby.connect'))}</button>`}
      </div>`);
  }
  setHtml(
    $('#lobby-list'),
    rows.length ? rows.join('') : `<div class="empty small">${esc(t('lobby.empty'))}<br>${esc(t('net.online_hint'))}</div>`,
  );
}

$('#net-toggle').addEventListener('click', async () => {
  if (net.state === 'offline') {
    setNetState('connecting');
    try {
      await call('net_connect');
      setNetState('online');
    } catch {
      setNetState('offline');
    }
    return;
  }
  partnerGone('hangup');
  $('#net-toggle').disabled = true;
  await call('net_disconnect').catch(() => {});
  setNetState('offline');
});

$('#lobby-list').addEventListener('click', async (ev) => {
  const button = ev.target.closest('button');
  if (!button) return;
  const row = button.closest('.lobby-row');
  const act = button.dataset.act;
  button.disabled = true;
  try {
    if (act === 'request') {
      const user = net.users.find((u) => u.id === row.dataset.user);
      if (!user) return;
      net.outgoing.set(user.id, await call('lobby_request', { to: user }));
      toast(t('toast.request_sent', { name: user.name }));
    } else if (act === 'cancel') {
      const request = net.outgoing.get(row.dataset.user);
      net.outgoing.delete(row.dataset.user);
      if (request) await call('lobby_cancel', { request });
    } else if (act === 'accept' || act === 'decline') {
      const request = row.dataset.request;
      net.incoming.delete(request);
      // Al aceptar, el resto llega con el evento `lobby_paired`.
      await call('lobby_answer', { request, accept: act === 'accept' });
    }
  } catch {
    // call() ya mostró el error.
  } finally {
    // Si la lista no cambia no se repinta: el botón tiene que volver solo.
    button.disabled = false;
    renderLobby();
  }
});

export function onLobbyEvent(e) {
  switch (e.kind) {
    case 'lobby_users':
      net.users = e.users;
      // Lo pedido a alguien que se fue ya no espera.
      for (const id of [...net.outgoing.keys()]) if (!e.users.some((u) => u.id === id)) net.outgoing.delete(id);
      break;
    case 'lobby_request':
      net.incoming.set(e.request, e.from);
      toast(t('toast.wants_connect', { name: e.from.name }));
      break;
    case 'lobby_request_gone':
      net.incoming.delete(e.request);
      break;
    case 'lobby_answer': {
      const entry = [...net.outgoing].find(([, request]) => request === e.request);
      if (!entry) break;
      net.outgoing.delete(entry[0]);
      const name = net.users.find((u) => u.id === entry[0])?.name || '';
      if (e.reason === 'declined') toast(t('toast.connect_declined', { name }));
      break;
    }
    case 'lobby_paired':
      setPartner(e.partner);
      toast(t('toast.paired', { name: e.partner.name }));
      return;
    case 'partner_lost':
      // Dejó de responder: el backend ya dejó la pareja y volvió al server si pudo.
      if (net.partner?.code === e.code) partnerGone('lost');
      setNetState(e.online ? 'online' : 'offline');
      toast(t(e.online ? 'toast.partner_lost_online' : 'toast.partner_lost', { name: e.name }), true);
      return;
    case 'lobby_error':
      net.error = e.detail;
      break;
  }
  renderLobby();
}

function setPartner(partner) {
  net.partner = partner;
  addRemotePeer({ code: partner.code, name: partner.name, os: partner.platform, partner: true });
  setNetState('paired');
  // Lo que quedó en pausa al perderla sigue solo.
  resumeFor(partner.code);
}

/**
 * Fuera la pareja: se cuelga la llamada con ella, lo que se le envía queda
 * en pausa y su chat se cierra (al quitarla de la lista).
 */
function partnerGone(reason) {
  const partner = net.partner;
  if (!partner) return;
  endCallWith(partner.code, reason);
  pauseFor(partner.code, true);
  net.partner = null;
  removePeer('partner');
}

/** La pareja se desconectó: el backend ya volvió a solo red local. */
export function onUnpair(peer, name) {
  if (net.partner?.code !== peer) return;
  partnerGone('hangup');
  setNetState('offline');
  toast(t('toast.partner_left', { name }));
}

$('#copy-code').addEventListener('click', async () => {
  await navigator.clipboard.writeText(app.settings.code);
  toast(t('toast.code_copied'));
});

on('settings', renderHeader);
on('lang', () => {
  renderHeader();
  renderLobby();
});
