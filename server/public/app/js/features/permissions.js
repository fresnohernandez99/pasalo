// Android 17+ pide permiso para la red local: sin él no se ve ningún equipo.
// Si falta, un aviso en la lista de equipos lo explica y lo pide (o abre los
// ajustes de la app si ya se negó para siempre). Al volver a la app se mira
// otra vez.

import { $ } from '../lib/dom.js';
import { invoke } from '../lib/tauri.js';

async function check(ask = false) {
  const granted = await invoke('local_network', { ask }).catch(() => null);
  // `null`: este sistema no lo necesita.
  $('#perm-banner').hidden = granted !== false;
}

export function initPermissions() {
  check();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}

$('#perm-allow').addEventListener('click', () => check(true));
