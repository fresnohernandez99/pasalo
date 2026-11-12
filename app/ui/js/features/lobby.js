// Conexión con otras redes por el server. La app arranca sin conexión y no
// intenta nada fuera de la LAN hasta que el usuario pulsa «Descubrir», que
// abre una pantalla con quién más está en línea (con búsqueda y por páginas).
// Ahí se le pide conectarse a alguien; si acepta, los dos dejan el server y
// quedan conectados solo entre ellos. Las solicitudes que llegan se ven en la
// pantalla principal, para no perderlas.
//
// Arriba en Descubrir salen los amigos (ver friends.js), con un punto verde si
// están en línea y amarillo si están ocupados con su pareja. Su estado se
// pide solo al entrar en Descubrir; a un amigo libre se le pide conectarse
// con el id de su sesión de ahora y le llega «quiere chatear contigo otra vez».
//
// With "chat with several people" (Settings) accepting doesn't leave the
// server: every accepted person is a partner (`net.partners`) and the app
// stays online for more requests.
//
// "Disconnect" only leaves the server: the chats already connected over iroh
// go on (state `direct`, with "Discover" to come back), and each one is ended
// on its own, from its row in the list or from the chat (`leavePartner`).
// Only when nothing is connected any more does the app go back to local only.
//
// Con el enlace de un equipo no hace falta el server: los dos salen a
// internet (estado `direct`) y se hablan por su código, por los relays de iroh.
//
// También pinta la cabecera con este equipo: sin conexión enseña su IP y su
// código; conectado, solo el nombre, con quién está y «Desconectar».

import { t } from '../i18n/index.js';
import { on } from '../lib/bus.js';
import { $, esc, setHtml } from '../lib/dom.js';
import { initials, shortCode } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { call, invoke, listen } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { app } from '../state.js';
import { endCallWith } from './call.js';
import { openChat, wipeIfPrivate } from './chat.js';
import { friendOf, friends, removeFriend, renameFriend } from './friends.js';
import { keepOnline } from './keepalive.js';
import { onBack, updateLayers } from './nav.js';
import { addRemotePeer, avatar, ensureRemotePeer, findPeerByCode, peers, removePeer } from './peers.js';
import { pauseFor, resumeFor } from './transfers.js';

const net = {
  state: 'offline', // offline | connecting | online | paired | direct
  users: [], // [{ id, name, platform }] en el server
  incoming: new Map(), // id de solicitud → { id, name, platform }
  outgoing: new Map(), // id de usuario → id de solicitud
  partner: null, // { id, name, platform, code }
  partners: new Map(), // code → partner, in multi mode
  multi: false, // whether the current server session is multi (the setting when it joined)
  presence: new Map(), // código de un amigo → { id, name, platform, busy }, si está en el server
  presenceLoaded: false,
  error: '',
  steps: [], // pasos de la conexión en curso (ver `net_step` en net.rs)
  step: '',
};

// Con el server se entra después de tener relay; por enlace basta el relay.
const STEPS_SERVER = ['internet', 'relay', 'server'];
const STEPS_DIRECT = ['internet', 'relay'];

export function initNet(snapshot) {
  if (snapshot.partner) return setPartner(snapshot.partner);
  net.multi = snapshot.online && snapshot.multi_chat;
  for (const partner of snapshot.partners || []) addPartner(partner);
  setNetState(snapshot.online ? 'online' : snapshot.direct ? 'direct' : 'offline');
}

function setNetState(state) {
  net.state = state;
  keepOnline(state !== 'offline');
  if (state !== 'online') {
    net.users = [];
    net.incoming.clear();
    net.outgoing.clear();
    net.presence.clear();
    net.presenceLoaded = false;
    net.error = '';
  }
  if (state !== 'connecting') net.steps = [];
  if (state === 'offline') for (const code of [...net.partners.keys()]) partnerGone('hangup', code);
  renderHeader();
  renderLobby();
  renderSteps();
  renderDiscover();
}

/** Empieza a conectar: se enseñan los pasos hasta tener el ID de iroh en la red. */
function startConnecting(steps) {
  net.steps = steps;
  net.step = steps[0];
  setNetState('connecting');
}

function renderSteps() {
  const show = net.state === 'connecting' && net.steps.length > 0;
  $('#net-progress').hidden = !show;
  $('#discover-steps').hidden = !show;
  if (show) {
    stepList($('#net-steps'), net.steps, net.step);
    stepList($('#discover-steps'), net.steps, net.step);
  }
  if (opening) stepList($('#link-steps'), opening.steps, opening.step, { name: opening.name });
}

/** Pinta una lista de pasos: los de antes de `current`, hechos. */
function stepList(el, steps, current, vars = {}) {
  const at = steps.indexOf(current);
  setHtml(
    el,
    steps
      .map((step, i) => {
        const cls = i < at ? 'done' : i === at ? 'current' : '';
        return `<li class="${cls}"><span class="mark">${i < at ? icon('check') : ''}</span>${esc(t(`net.step_${step}`, vars))}</li>`;
      })
      .join(''),
  );
}

listen('net_step', ({ payload }) => {
  if (net.state !== 'connecting' || !net.steps.includes(payload)) return;
  net.step = payload;
  if (opening?.steps.includes(payload)) opening.step = payload;
  renderSteps();
});

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
  const chatting = net.partners.size;
  $('#net-state').textContent =
    state === 'paired'
      ? t('net.paired', { name: partner.name })
      : state === 'online' && chatting
        ? t('net.online_multi', { n: chatting })
        : state === 'direct' && chatting
          ? t('net.chatting', { n: chatting })
          : t(state === 'offline' ? 'net.local' : `net.${state}`);
  // Verde en línea, amarillo en un chat con la pareja (ocupado para los amigos).
  $('#net-dot').className = `dot ${state === 'direct' ? 'online' : state === 'paired' ? 'busy' : state}`;
  // «Descubrir» abre la pantalla de quién está en línea (y entra en el
  // server si hace falta); el otro botón cancela o deja el server.
  $('#net-discover').hidden = !['offline', 'online', 'direct'].includes(state) || !s.code;
  const toggle = $('#net-toggle');
  toggle.textContent = t(state === 'connecting' ? 'btn.cancel' : 'net.disconnect');
  toggle.className = 'ghost small';
  toggle.disabled = false;
  // Paired (or by link with people still chatting) there is no server to
  // leave: each chat is ended on its own.
  toggle.hidden = state === 'offline' || state === 'paired' || (state === 'direct' && chatting > 0);
}

// ---------- solicitudes (pantalla principal) ----------

function renderLobby() {
  // Aquí solo lo que espera respuesta; la lista de gente está en Descubrir.
  $('#lobby').hidden = net.state !== 'online' || !net.incoming.size;
  if ($('#lobby').hidden) return;
  $('#lobby-status').textContent = net.error ? t('lobby.unreachable') : '';
  const rows = [];
  for (const [request, from] of net.incoming) {
    const friend = from.code && friendOf(from.code);
    const name = friend?.name || from.name;
    rows.push(`
      <div class="lobby-row request" data-request="${esc(request)}">
        <div class="lobby-who">
          ${avatar(name, from.platform, 'small')}
          <div class="info"><div class="pname">${esc(name)}</div><div class="sub">${esc(t(friend ? 'lobby.friend_wants' : 'lobby.wants'))}</div></div>
        </div>
        <div class="lobby-actions">
          <button class="ghost small" data-act="decline">${esc(t('btn.decline'))}</button>
          <button class="primary small" data-act="accept">${esc(t('btn.accept'))}</button>
        </div>
      </div>`);
  }
  setHtml($('#lobby-list'), rows.join(''));
}

// ---------- Descubrir ----------

/** Equipos por página. */
const PAGE = 20;
const discover = { q: '', offset: 0, total: 0, users: [], loading: 0, error: '' };

function userRow(user) {
  const pending = net.outgoing.has(user.id);
  return `
    <div class="lobby-row" data-user="${esc(user.id)}">
      <div class="lobby-who">
        ${avatar(user.name, user.platform, 'small')}
        <div class="info"><div class="pname">${esc(user.name)}</div>${pending ? `<div class="sub">${esc(t('lobby.waiting'))}</div>` : ''}</div>
      </div>
      ${pending
        ? `<button class="ghost small" data-act="cancel">${esc(t('btn.cancel'))}</button>`
        : `<button class="primary small" data-act="request">${esc(t('lobby.connect'))}</button>`}
    </div>`;
}

/** Un amigo en Descubrir: su punto (gris, verde u ocupado) y, si está libre, «Chatear». */
function friendRow(friend) {
  const here = net.presence.get(friend.code);
  const state = !here ? 'offline' : here.busy ? 'busy' : 'online';
  const pending = here && net.outgoing.has(here.id);
  const chatting = net.partners.has(friend.code);
  const status = chatting
    ? t('friends.chatting')
    : net.state !== 'online' || !net.presenceLoaded ? '' : pending ? t('lobby.waiting') : t(`friends.${state}`);
  const action = chatting
    ? ''
    : pending
    ? `<button class="ghost small" data-act="cancel">${esc(t('btn.cancel'))}</button>`
    : state === 'online'
      ? `<button class="primary small" data-act="request">${esc(t('friends.chat'))}</button>`
      : '';
  return `
    <div class="lobby-row friend" data-friend="${esc(friend.code)}" ${here ? `data-user="${esc(here.id)}"` : ''}>
      <div class="lobby-who">
        ${avatar(friend.name, friend.os || here?.platform, 'small')}
        <div class="info">
          <div class="pname"><span class="dot ${state}"></span>${esc(friend.name)}</div>
          ${status ? `<div class="sub">${esc(status)}</div>` : ''}
        </div>
      </div>
      <div class="lobby-actions">
        ${action}
        <button class="icon-btn subtle" data-act="unfriend" title="${esc(t('friends.remove'))}" aria-label="${esc(t('friends.remove'))}">${icon('close')}</button>
      </div>
    </div>`;
}

function renderFriends() {
  const list = [...friends.values()].sort((a, b) => {
    // Primero los libres, luego los ocupados y al final los que no están.
    const rank = (f) => {
      const here = net.presence.get(f.code);
      return !here ? 2 : here.busy ? 1 : 0;
    };
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  setHtml(
    $('#friends-list'),
    list.length ? list.map(friendRow).join('') : `<div class="empty small">${esc(t('friends.empty'))}</div>`,
  );
}

/** Pregunta al server cuáles de los amigos están: solo al entrar en Descubrir. */
async function loadFriends() {
  if (net.state !== 'online' || !friends.size) return;
  try {
    const list = await invoke('lobby_friends', { codes: [...friends.keys()] });
    net.presence = new Map(list.map((f) => [f.code.toLowerCase(), f]));
    net.presenceLoaded = true;
    for (const f of list) renameFriend(f.code, f.name, f.platform);
  } catch {
    // Sin respuesta: se quedan sin estado (gris).
  }
  renderDiscover();
}

function renderDiscover() {
  if ($('#discover').hidden) return;
  renderFriends();
  const online = net.state === 'online';
  $('#discover-search').hidden = !online;
  $('#discover-online-title').hidden = !online;
  const status = $('#discover-status');
  status.hidden = net.state !== 'offline' && !(online && net.error);
  status.textContent = online ? t('lobby.unreachable') : t('discover.offline');
  if (!online) {
    setHtml($('#discover-list'), '');
    $('#discover-pager').hidden = true;
    return;
  }
  // Los amigos ya salen arriba.
  const asking = new Set([...net.incoming.values(), ...net.presence.values()].map((u) => u.id));
  const rows = discover.users.filter((u) => !asking.has(u.id)).map(userRow);
  const empty = discover.q ? t('discover.no_match') : `${t('lobby.empty')} ${t('discover.hint')}`;
  setHtml($('#discover-list'), rows.length ? rows.join('') : `<div class="empty small">${esc(empty)}</div>`);
  const { offset, total } = discover;
  $('#discover-pager').hidden = total <= PAGE;
  $('#discover-range').textContent = t('discover.range', { from: total ? offset + 1 : 0, to: Math.min(offset + PAGE, total), total });
  $('#discover-prev').disabled = offset === 0;
  $('#discover-next').disabled = offset + PAGE >= total;
}

/** Pide al server la página actual con la búsqueda actual. */
async function loadPage() {
  if (net.state !== 'online' || $('#discover').hidden) return;
  const mine = ++discover.loading;
  try {
    const page = await invoke('lobby_users', { q: discover.q, offset: discover.offset, limit: PAGE });
    if (mine !== discover.loading) return;
    // Si la página se quedó vacía (se fueron), a la anterior.
    if (!page.users.length && page.total && discover.offset >= page.total) {
      discover.offset = Math.max(0, Math.floor((page.total - 1) / PAGE) * PAGE);
      return loadPage();
    }
    Object.assign(discover, { users: page.users, total: page.total });
  } catch {
    // Sin respuesta del server: se queda lo que había; el aviso sale con `lobby_error`.
  }
  renderDiscover();
}

/** Abre Descubrir: si no estaba en el server, entra. */
export async function openDiscover() {
  $('#discover').hidden = false;
  updateLayers($('#discover-search'));
  renderSteps();
  renderDiscover();
  if (net.state === 'offline' || net.state === 'direct') await connectServer();
  loadPage();
  loadFriends();
}

function closeDiscover() {
  if ($('#discover').hidden) return false;
  $('#discover').hidden = true;
  updateLayers($('#net-discover'));
  return true;
}

let searchTimer;
$('#discover-search').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    discover.q = ev.target.value.trim();
    discover.offset = 0;
    loadPage();
  }, 300);
});
$('#discover-prev').addEventListener('click', () => {
  discover.offset = Math.max(0, discover.offset - PAGE);
  loadPage();
});
$('#discover-next').addEventListener('click', () => {
  discover.offset += PAGE;
  loadPage();
});
$('#discover-close').addEventListener('click', closeDiscover);
$('#net-discover').addEventListener('click', openDiscover);
onBack(closeDiscover);

// Cada intento de conectar tiene su número: si se cancela, lo que conteste
// después ya no cambia nada.
let attempt = 0;

/** Without the server: by link while someone is still chatting, or local only. */
function stateOffServer() {
  return net.partners.size ? 'direct' : 'offline';
}

/** Entra en el server (los pasos se ven en la cabecera y en Descubrir). */
async function connectServer() {
  const mine = ++attempt;
  // The backend reads the setting when it joins: so does this session.
  net.multi = !!app.settings?.multi_chat;
  startConnecting(STEPS_SERVER);
  try {
    await call('net_connect');
    if (mine === attempt) setNetState('online');
  } catch {
    if (mine === attempt) setNetState(stateOffServer());
  }
}

$('#net-toggle').addEventListener('click', async () => {
  if (net.state === 'offline') return;
  if (net.state === 'connecting') {
    // Cancelar mientras conecta: se deja el server (los chats siguen).
    attempt++;
    setNetState(stateOffServer());
    invoke('net_disconnect').catch(() => {});
    return;
  }
  // Leaving the server keeps the chats already connected. Only with none
  // left does the app go local only: then the private chats by link go too.
  $('#net-toggle').disabled = true;
  const next = stateOffServer();
  if (next === 'offline') await wipeRemotePrivate();
  await call('net_disconnect').catch(() => {});
  setNetState(next);
});

/**
 * Ends the chat with `code` (the partner, or one of several): they are told,
 * the call with them ends and their chat closes. The app stays on the server
 * if it was there; with nobody left (and no server), back to local only.
 */
export async function leavePartner(code) {
  const multi = net.partners.has(code);
  if (!multi && net.partner?.code !== code) return false;
  const name = (multi ? net.partners.get(code) : net.partner).name;
  if (multi) partnerGone('hangup', code);
  else partnerGone('hangup');
  await call('partner_leave', { code }).catch(() => {});
  if (net.state === 'paired' || (net.state === 'direct' && !net.partners.size)) setNetState('offline');
  else {
    renderHeader();
    renderDiscover();
  }
  toast(t('toast.chat_ended', { name }));
  return true;
}

/** El server admite una solicitud por segundo; aquí se avisa antes de pedir. */
const REQUEST_GAP_MS = 1000;
let lastRequest = 0;

async function onLobbyClick(ev) {
  const button = ev.target.closest('button');
  if (!button) return;
  const row = button.closest('.lobby-row');
  const act = button.dataset.act;
  if (act === 'unfriend') {
    const friend = friendOf(row.dataset.friend);
    removeFriend(row.dataset.friend);
    if (friend) toast(t('toast.friend_removed', { name: friend.name }));
    return;
  }
  if (act === 'request' && Date.now() - lastRequest < REQUEST_GAP_MS) {
    toast(t('discover.slow'));
    return;
  }
  button.disabled = true;
  try {
    if (act === 'request' && row.dataset.friend) {
      // A un amigo: con el id de su sesión de ahora y diciéndole quién es.
      const friend = friendOf(row.dataset.friend);
      const here = net.presence.get(row.dataset.friend);
      if (!friend || !here) return;
      lastRequest = Date.now();
      const to = { id: here.id, name: friend.name, platform: here.platform };
      try {
        net.outgoing.set(here.id, await call('lobby_request', { to, friend: true }));
      } catch (err) {
        // Ya no está (o se ocupó): su estado, al día.
        loadFriends();
        throw err;
      }
      toast(t('toast.request_sent', { name: friend.name }));
    } else if (act === 'request') {
      const user = discover.users.find((u) => u.id === row.dataset.user) || net.users.find((u) => u.id === row.dataset.user);
      if (!user) return;
      lastRequest = Date.now();
      net.outgoing.set(user.id, await call('lobby_request', { to: user }));
      toast(t('toast.request_sent', { name: user.name }));
    } else if (act === 'cancel') {
      const request = net.outgoing.get(row.dataset.user);
      net.outgoing.delete(row.dataset.user);
      if (request) await call('lobby_cancel', { request });
    } else if (act === 'accept' || act === 'decline') {
      const request = row.dataset.request;
      const from = net.incoming.get(request);
      net.incoming.delete(request);
      // Al aceptar, el resto llega con el evento `lobby_paired`.
      try {
        await call('lobby_answer', { request, accept: act === 'accept' });
      } catch (err) {
        // Que se pueda volver a intentar.
        if (from) net.incoming.set(request, from);
        throw err;
      }
    }
  } catch {
    // call() ya mostró el error.
  } finally {
    // Si la lista no cambia no se repinta: el botón tiene que volver solo.
    button.disabled = false;
    renderLobby();
    renderDiscover();
  }
}

$('#lobby-list').addEventListener('click', onLobbyClick);
$('#discover-list').addEventListener('click', onLobbyClick);
$('#friends-list').addEventListener('click', onLobbyClick);

export function onLobbyEvent(e) {
  switch (e.kind) {
    case 'lobby_users':
      net.users = e.users;
      // Lo pedido a alguien que se fue ya no espera.
      for (const id of [...net.outgoing.keys()]) if (!e.users.some((u) => u.id === id)) net.outgoing.delete(id);
      // Cambió quién está: la página de Descubrir, al día.
      loadPage();
      break;
    case 'lobby_request': {
      net.incoming.set(e.request, e.from);
      const friend = e.from.code && friendOf(e.from.code);
      if (friend) toast(t('toast.friend_chat', { name: friend.name }));
      else toast(t('toast.wants_connect', { name: e.from.name }));
      break;
    }
    case 'lobby_request_gone':
      net.incoming.delete(e.request);
      break;
    case 'lobby_answer': {
      const entry = [...net.outgoing].find(([, request]) => request === e.request);
      if (!entry) break;
      net.outgoing.delete(entry[0]);
      const friend = [...net.presence].find(([, f]) => f.id === entry[0]);
      const name = (friend && friendOf(friend[0])?.name) || net.users.find((u) => u.id === entry[0])?.name || '';
      if (e.reason === 'declined') toast(t('toast.connect_declined', { name }));
      break;
    }
    case 'lobby_paired':
      closeDiscover();
      if (net.multi) {
        addPartner(e.partner);
        renderHeader();
        openChat(findPeerByCode(e.partner.code));
      } else {
        setPartner(e.partner);
      }
      toast(t('toast.paired', { name: e.partner.name }));
      return;
    case 'partner_lost':
      if (net.partners.has(e.code)) {
        partnerGone('lost', e.code);
        toast(t(e.online || net.partners.size ? 'toast.partner_lost_online' : 'toast.partner_lost', { name: e.name }), true);
        // By link and nobody left: the backend went back to local only.
        if (net.state === 'direct' && !net.partners.size) setNetState('offline');
        else renderHeader();
        return;
      }
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
  renderDiscover();
}

/** One more person to chat with, in multi mode: the app stays online. */
function addPartner(partner) {
  net.partners.set(partner.code, partner);
  addRemotePeer({ code: partner.code, name: partner.name, os: partner.platform, partner: 'multi' });
  resumeFor(partner.code);
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
function partnerGone(reason, code = null) {
  if (code) {
    if (!net.partners.delete(code)) return;
    endCallWith(code, reason);
    pauseFor(code, true);
    removePeer(`partner:${code}`);
    return;
  }
  const partner = net.partner;
  if (!partner) return;
  endCallWith(partner.code, reason);
  pauseFor(partner.code, true);
  net.partner = null;
  removePeer('partner');
}

/**
 * Al volver a solo red local: los chats privados con equipos de otra red
 * (añadidos por enlace) se borran aquí y se le pide al otro que borre el
 * suyo. El de la pareja lo borra el backend al dejarla.
 */
async function wipeRemotePrivate() {
  const remote = [...peers.values()].filter((p) => p.platform === 'remote').map((p) => p.addr);
  await Promise.all(
    remote.map(async (code) => {
      if (!(await invoke('chat_private', { peer: code }).catch(() => false))) return;
      await Promise.race([
        invoke('call_signal', { peer: code, call: '', kind: 'wipe', data: null }).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      wipeIfPrivate(code);
    }),
  );
}

/** They ended the chat. With nobody left (and no server) the backend went back to local only. */
export function onUnpair(peer, name) {
  if (net.partners.has(peer)) {
    partnerGone('hangup', peer);
    if (net.state === 'direct' && !net.partners.size) setNetState('offline');
    else renderHeader();
    toast(t('toast.partner_left', { name }));
    return;
  }
  if (net.partner?.code !== peer) return;
  partnerGone('hangup');
  setNetState('offline');
  toast(t('toast.partner_left', { name }));
}

// ---------- enlaces ----------

/** Sale a internet sin server, si no estaba ya: así se llega y llegan por código. */
async function goDirect() {
  if (net.state !== 'offline') return net.state !== 'connecting';
  startConnecting(STEPS_DIRECT);
  try {
    await call('net_direct');
    setNetState('direct');
    return true;
  } catch {
    setNetState('offline');
    return false;
  }
}

/**
 * Copia el enlace de este equipo. Quien lo tenga tiene que poder llegar, así
 * que este equipo sale a internet (sin entrar en el server).
 */
export async function copyMyLink() {
  const link = await call('link_mine');
  await navigator.clipboard.writeText(link);
  const was = net.state;
  await goDirect();
  toast(t(was === 'offline' ? 'toast.link_copied_online' : 'toast.link_copied'));
}

// Lo que se espera a que conteste el otro equipo al abrir su enlace.
const HELLO_WAIT_MS = 20_000;

// Se avisa al otro equipo de que se le añadió; si todavía no se llega (el
// otro tarda en tener relay), se insiste hasta HELLO_WAIT_MS en total.
async function sayHello(code, still) {
  const deadline = Date.now() + HELLO_WAIT_MS;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  while (still() && Date.now() < deadline) {
    const hello = invoke('call_signal', { peer: code, call: '', kind: 'hello', data: null }).then(
      () => true,
      () => false,
    );
    const left = Math.max(0, deadline - Date.now());
    if (await Promise.race([hello, sleep(left).then(() => false)])) return true;
    await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
  }
  return false;
}

/** El enlace que se está abriendo (con su pantalla de carga), si hay uno. */
let opening = null;

/**
 * Abre el enlace de otro equipo. Con la app recién abierta no hay conexión:
 * una pantalla de carga enseña cómo se conecta, y solo con iroh listo se
 * añade al otro, se le avisa y se abre su chat.
 */
export async function openLink({ code, name }, { ask = false } = {}) {
  if (code === app.settings?.code) {
    toast(t('toast.link_self'), true);
    return;
  }
  const label = name || shortCode(code);
  // Un enlace que llega de fuera (una web, un mensaje) no conecta solo: el
  // usuario tiene que querer. Si no, cualquier página podría sacar este
  // equipo a internet y presentarlo a quien quiera.
  if (ask && !(await confirmLink(label))) return;
  const ready = net.state !== 'offline' && net.state !== 'connecting';
  const job = { name: label, steps: [...(ready ? [] : STEPS_DIRECT), 'peer'], step: ready ? 'peer' : 'internet' };
  opening = job;
  const still = () => opening === job;
  $('#link-title').textContent = t('link.opening', { name: label });
  $('#link-hint').hidden = true;
  $('#link-go').hidden = true;
  renderSteps();
  if (!$('#link-dialog').open) $('#link-dialog').showModal();

  const close = () => {
    if (!still()) return;
    opening = null;
    $('#link-dialog').close();
  };
  if (!ready && !(await goDirect())) {
    close();
    return;
  }
  if (!still()) return;
  job.step = 'peer';
  renderSteps();
  ensureRemotePeer(code, label);
  const reached = await sayHello(code, still);
  if (!still()) return;
  close();
  const peer = findPeerByCode(code);
  if (peer) openChat(peer);
  toast(t(reached ? 'toast.link_added' : 'toast.link_unreachable', { name: peer?.name || label }), !reached);
}

/** Pregunta antes de abrir un enlace que llegó de fuera. */
function confirmLink(label) {
  return new Promise((resolve) => {
    const dialog = $('#link-dialog');
    $('#link-title').textContent = t('link.confirm', { name: label });
    $('#link-hint').hidden = false;
    $('#link-go').hidden = false;
    setHtml($('#link-steps'), '');
    const done = (ok) => {
      $('#link-go').removeEventListener('click', yes);
      dialog.removeEventListener('close', no);
      resolve(ok);
    };
    const yes = () => done(true);
    const no = () => done(false);
    $('#link-go').addEventListener('click', yes, { once: true });
    dialog.addEventListener('close', no, { once: true });
    if (!dialog.open) dialog.showModal();
  });
}

// Cancelar deja de esperar; el equipo queda en la lista por si contesta luego.
$('#link-cancel').addEventListener('click', () => {
  opening = null;
  $('#link-dialog').close();
});
$('#link-dialog').addEventListener('cancel', () => {
  opening = null;
});

/** Alguien abrió el enlace de este equipo. */
export function onHello(peer, name) {
  const known = findPeerByCode(peer);
  ensureRemotePeer(peer, name);
  if (!known) toast(t('toast.link_hello', { name }));
}

/** El enlace con que se abrió la app (o que llegó con ella abierta). */
export async function takeLink() {
  const link = await invoke('link_take').catch(() => null);
  if (link) await openLink(link, { ask: true });
}

$('#copy-code').addEventListener('click', copyMyLink);

// Las IP cambian al pasar de una red a otra (Wi-Fi, datos): la cabecera las
// pone al día al volver a la app y cada poco.
async function refreshAddresses() {
  if (!app.settings) return;
  const ips = await invoke('local_addresses').catch(() => null);
  if (!ips || ips.join() === app.settings.ips.join()) return;
  app.settings.ips = ips;
  renderHeader();
}
setInterval(refreshAddresses, 10_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshAddresses();
});

on('settings', renderHeader);
on('partner:leave', leavePartner);
on('friends:changed', renderDiscover);
on('lang', () => {
  renderHeader();
  renderLobby();
});
