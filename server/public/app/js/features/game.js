// Minijuegos con el otro equipo del chat (o de la llamada). Se invita desde
// el menú del chat o desde la llamada, el otro acepta, y la partida ocupa la
// pantalla: mientras dura no se puede chatear ni hacer otra cosa, salvo
// seguir en la llamada. Al terminar se vuelve al chat (o a la llamada).
//
// Va por las señales del chat (`call_signal`), con el id de la partida en
// `call`: `game_invite` (con el juego), `game_accept`, `game_decline`,
// `game_busy`, `game_cancel` (quien invitó se arrepiente), `game_move` (una
// jugada) y `game_quit` (alguien se fue). Un equipo viejo las ignora.

import { t } from '../i18n/index.js';
import { $, esc, setHtml } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { invoke } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { activeCall, hangupCall } from './call.js';
import { activePeer, logToChat, openChat } from './chat.js';
import { GAMES, findGame } from './games/index.js';
import { onBack, updateLayers } from './nav.js';
import { notifyText } from './notify.js';
import { ensureRemotePeer, findPeerByCode } from './peers.js';

/** Sin respuesta a la invitación en este tiempo, se da por perdida. */
const INVITE_TIMEOUT = 60_000;

/** La partida: `{ id, peer: { code, name }, game, role, state, play, timer }`. */
let session = null;
/** Invitación recibida esperando respuesta: `{ id, peer, game }`. */
let invited = null;

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

function signal(peer, id, kind, data = null) {
  return invoke('call_signal', { peer, call: id, kind, data });
}

export const playing = () => !!session;

// ---------- elegir juego e invitar ----------

let pickFor = null;

/** Abre la lista de juegos para invitar a `peer` (`{ code, name }`). */
export function pickGame(peer) {
  if (session) return;
  pickFor = peer;
  setHtml(
    $('#game-list'),
    GAMES.map(
      (g) => `
        <button type="button" class="game-pick" data-game="${esc(g.id)}">
          <span class="game-icon">${icon(g.icon)}</span>
          <span class="grow"><strong>${esc(t(`game.${g.id}`))}</strong><small class="sub">${esc(t(`game.${g.id}_desc`))}</small></span>
        </button>`,
    ).join(''),
  );
  $('#game-picker').showModal();
}

$('#game-list').addEventListener('click', (ev) => {
  const game = findGame(ev.target.closest('[data-game]')?.dataset.game);
  if (!game || !pickFor) return;
  $('#game-picker').close();
  invite(pickFor, game);
});
$('#game-picker-cancel').addEventListener('click', () => $('#game-picker').close());

async function invite(peer, game) {
  session = { id: newId(), peer, game, role: 'host', state: 'inviting' };
  show();
  status(t('game.waiting', { name: peer.name }));
  try {
    await signal(peer.code, session.id, 'game_invite', { game: game.id });
  } catch {
    finish(t('game.unreachable', { name: peer.name }));
    return;
  }
  const mine = session;
  mine.timer = setTimeout(() => {
    if (session !== mine || mine.state !== 'inviting') return;
    signal(peer.code, mine.id, 'game_cancel').catch(() => {});
    finish(t('game.no_answer', { name: peer.name }));
  }, INVITE_TIMEOUT);
}

// ---------- invitación recibida ----------

function onInvite(peer, id, gameId) {
  const game = findGame(gameId);
  // Un juego que esta versión no tiene, u otra partida en marcha.
  if (!game || session || invited) {
    signal(peer.code, id, game ? 'game_busy' : 'game_decline').catch(() => {});
    return;
  }
  invited = { id, peer, game };
  const text = t('game.invited', { name: peer.name, game: t(`game.${game.id}`) });
  $('#game-invite-text').textContent = text;
  $('#game-invite').showModal();
  notifyText(peer, t('game.invite_notify', { game: t(`game.${game.id}`) }));
}

function answerInvite(accept) {
  const inv = invited;
  invited = null;
  if ($('#game-invite').open) $('#game-invite').close();
  if (!inv) return;
  if (!accept) {
    signal(inv.peer.code, inv.id, 'game_decline').catch(() => {});
    return;
  }
  signal(inv.peer.code, inv.id, 'game_accept').catch(() => {});
  session = { id: inv.id, peer: inv.peer, game: inv.game, role: 'guest', state: 'playing' };
  show();
  start();
}

$('#game-invite-accept').addEventListener('click', () => answerInvite(true));
$('#game-invite-decline').addEventListener('click', () => answerInvite(false));
// Cerrar el diálogo (Atrás, Esc) es decir que no.
$('#game-invite').addEventListener('close', () => {
  if (invited) answerInvite(false);
});

// ---------- la partida ----------

function show() {
  const { peer, game } = session;
  $('#game-name').textContent = t(`game.${game.id}`);
  $('#game-with').textContent = peer.name;
  $('#game-board').replaceChildren();
  $('#game-done').hidden = true;
  $('#game').hidden = false;
  updateCallButton();
  updateLayers($('#game-quit'));
}

function status(text) {
  $('#game-status').textContent = text;
}

function start() {
  const s = session;
  s.state = 'playing';
  clearTimeout(s.timer);
  s.play = s.game.create({
    board: $('#game-board'),
    me: s.role,
    them: s.peer.name,
    send: (data) => {
      if (session === s) signal(s.peer.code, s.id, 'game_move', data).catch(() => {});
    },
    status: (text) => session === s && status(text),
    end: (result) => {
      if (session !== s) return;
      s.state = 'over';
      status(result === 'draw' ? t('game.draw') : result === 'win' ? t('game.win') : t('game.lose', { name: s.peer.name }));
      record(s, result);
      showDone();
    },
  });
}

/** El resultado queda en el chat: `win`, `lose`, `draw`, `quit` (salí) o `left` (se fue). */
function record(s, result) {
  logToChat(s.peer.code, { type: 'game', id: s.id, game: s.game.id, result, outgoing: s.role === 'host' });
}

/** Termina con un aviso (`message`) y el botón de volver. */
function finish(message) {
  if (!session) return;
  clearTimeout(session.timer);
  session.state = 'over';
  status(message);
  showDone();
}

function showDone() {
  $('#game-done').textContent = activeCall() ? t('game.back_call') : t('game.back_chat');
  $('#game-done').hidden = false;
}

/** Cierra la partida y vuelve a lo de antes: la llamada o el chat. */
function close() {
  const s = session;
  if (!s) return;
  session = null;
  clearTimeout(s.timer);
  $('#game').hidden = true;
  $('#game-board').replaceChildren();
  updateLayers();
  if (!activeCall() && activePeer()?.code !== s.peer.code) {
    const peer = findPeerByCode(s.peer.code);
    if (peer) openChat(peer);
  }
}

/** Salir: si aún se jugaba (o se esperaba), el otro se entera. */
function quit() {
  const s = session;
  if (!s) return false;
  if (s.state === 'inviting') signal(s.peer.code, s.id, 'game_cancel').catch(() => {});
  else if (s.state === 'playing') {
    signal(s.peer.code, s.id, 'game_quit').catch(() => {});
    record(s, 'quit');
  }
  close();
  return true;
}

$('#game-quit').addEventListener('click', quit);
$('#game-done').addEventListener('click', close);
$('#game-hangup').addEventListener('click', () => {
  hangupCall();
  updateCallButton();
});

function updateCallButton() {
  $('#game-hangup').hidden = !activeCall();
}

// Atrás sale de la partida (va antes que la llamada: se registra después).
onBack(() => quit());

// ---------- señales ----------

/** Las señales `game_*` (ver main.js). */
export function onGameSignal({ peer: code, name, signal: s }) {
  const peer = { code, name: name || findPeerByCode(code)?.name || t('game.someone') };
  if (s.kind === 'game_invite') {
    ensureRemotePeer(code, name);
    onInvite(peer, s.call, s.data?.game);
    return;
  }
  if (invited?.id === s.call && s.kind === 'game_cancel') {
    invited = null;
    if ($('#game-invite').open) $('#game-invite').close();
    toast(t('game.cancelled', { name: peer.name }));
    return;
  }
  if (!session || session.id !== s.call || session.peer.code !== code) return;
  switch (s.kind) {
    case 'game_accept':
      if (session.state === 'inviting') start();
      break;
    case 'game_decline':
      finish(t('game.declined', { name: session.peer.name }));
      break;
    case 'game_busy':
      finish(t('game.busy', { name: session.peer.name }));
      break;
    case 'game_move':
      if (session.state === 'playing') session.play?.receive(s.data);
      break;
    case 'game_quit':
    case 'game_cancel':
      if (session.state === 'playing') record(session, 'left');
      if (session.state !== 'over') finish(t('game.left', { name: session.peer.name }));
      break;
  }
}

/** Se cayó la conexión con `code`: la partida con él se acaba. */
export function onGamePeerLost(code) {
  if (invited?.peer.code === code) {
    invited = null;
    if ($('#game-invite').open) $('#game-invite').close();
  }
  if (session?.peer.code === code && session.state !== 'over') {
    if (session.state === 'playing') record(session, 'left');
    finish(t('game.left', { name: session.peer.name }));
  }
}
