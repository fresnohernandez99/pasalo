// Arranque de la interfaz y reparto de los eventos del núcleo.

import { applyStatic, errorText } from './i18n/index.js';
import { applyIcons } from './lib/icons.js';
import { invoke, listen } from './lib/tauri.js';
import { toast } from './lib/toast.js';
import { app } from './state.js';
import { onSignal, onTalkLost } from './features/call.js';
import { onChatEvent } from './features/chat.js';
import { initNet, onLobbyEvent, renderHeader, takeLink } from './features/lobby.js';
import { showTab } from './features/nav.js';
import { initPeers, onPeerEvent } from './features/peers.js';
import { initPermissions } from './features/permissions.js';
import './features/settings.js';
import { onTransferEvent } from './features/transfers.js';

// En el móvil no hay consola a mano: un error de JavaScript se ve como aviso.
window.addEventListener('error', (ev) => toast(`JS: ${ev.message}`, true));
window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev.reason;
  if (reason && typeof reason === 'object' && 'code' in reason) return; // ya lo mostró call()
  toast(`JS: ${errorText(reason)}`, true);
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
      onSignal(e);
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
}

init();
