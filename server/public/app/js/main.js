// Arranque de la interfaz y reparto de los eventos del núcleo.

import { applyStatic, errorText, t } from './i18n/index.js';
import { applyIcons } from './lib/icons.js';
import { invoke, listen } from './lib/tauri.js';
import { toast } from './lib/toast.js';
import { app } from './state.js';
import { onSignal, onTalkLost } from './features/call.js';
import { onChatEvent, onChatWiped, onPrivateSignal } from './features/chat.js';
import { initNet, onLobbyEvent, renderHeader, takeLink } from './features/lobby.js';
import { showTab } from './features/nav.js';
import { initPeers, onPeerEvent } from './features/peers.js';
import { initPermissions } from './features/permissions.js';
import './features/settings.js';
import { takeShare } from './features/share.js';
import { onTransferEvent } from './features/transfers.js';

// En el móvil no hay consola a mano: un error de JavaScript se ve como aviso.
// Sin jerga de programador: se enseña un aviso traducido y el detalle va a la consola.
window.addEventListener('error', (ev) => {
  console.error(ev.error || ev.message);
  toast(t('error.unexpected', { detail: ev.message }), true);
});
window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev.reason;
  if (reason && typeof reason === 'object' && typeof reason.code === 'string') return; // ya lo mostró call()
  // El portapapeles sin permiso no es un fallo de la app.
  if (reason?.name === 'NotAllowedError') return;
  console.error(reason);
  toast(t('error.unexpected', { detail: errorText(reason) }), true);
});

listen('pasalo', ({ payload: e }) => {
  switch (e.kind) {
    case 'peer_found':
    case 'peer_lost':
      onPeerEvent(e);
      break;
    case 'chat':
      onChatEvent(e);
      break;
    case 'signal':
      if (e.signal?.kind === 'private') onPrivateSignal(e);
      else if (e.signal?.kind !== 'wipe') onSignal(e);
      break;
    case 'chat_wiped':
      onChatWiped(e);
      break;
    case 'talk_lost':
      onTalkLost(e);
      break;
    case 'lobby_users':
    case 'lobby_request':
    case 'lobby_request_gone':
    case 'lobby_answer':
    case 'lobby_paired':
    case 'lobby_error':
    case 'partner_lost':
      onLobbyEvent(e);
      break;
    default:
      onTransferEvent(e);
  }
});

// Si Android abre la app mientras se instala (o el backend tarda en
// arrancar), la primera petición puede fallar: se reintenta un rato antes de
// dar la interfaz por rota.
async function loadSnapshot() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await invoke('snapshot');
    } catch (err) {
      if (attempt >= 40) {
        toast(errorText(err), true);
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function init() {
  applyIcons();
  applyStatic();
  showTab('peers');
  const snapshot = await loadSnapshot();
  app.settings = snapshot;
  document.body.classList.toggle('mobile', snapshot.mobile);
  renderHeader();
  initPeers(snapshot);
  initNet(snapshot);
  if (snapshot.mobile) initPermissions();
  // Abierta con un enlace de otro equipo (o llega uno con la app abierta).
  listen('pasalo_link', takeLink);
  takeLink();
  // Abierta desde «Compartir» en otra app (lo de después avisa con `pasaloShare`).
  if (snapshot.mobile && !snapshot.web) takeShare();
}

init();
