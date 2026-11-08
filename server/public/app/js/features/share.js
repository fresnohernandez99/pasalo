// Lo que llega por «Compartir» desde otra app de Android (ver
// PasaloPlugin.kt): se elige un equipo de la lista y se le envía.

import { t } from '../i18n/index.js';
import { $ } from '../lib/dom.js';
import { basename, label } from '../lib/format.js';
import { invoke } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { activePeer, closeChat, openChat } from './chat.js';
import { onBack, showTab } from './nav.js';
import { openTextDialog, sendPaths } from './transfers.js';

/** `{ paths, text }` mientras se elige a quién enviarlo. */
let pending = null;

export const sharing = () => !!pending;

function show() {
  $('#share-what').textContent = pending.paths.length ? label(pending.paths.map(basename)) : pending.text;
  $('#share-banner').hidden = !pending;
  document.body.classList.toggle('sharing', !!pending);
}

function cancel() {
  if (!pending) return false;
  pending = null;
  $('#share-banner').hidden = true;
  document.body.classList.remove('sharing');
  return true;
}

/** Recoge lo compartido (si hay algo) y pide elegir el equipo. */
export async function takeShare() {
  const shared = await invoke('share_take').catch(() => null);
  if (shared?.failed) toast(t('share.failed'), true);
  if (!shared || (!shared.paths.length && !shared.text.trim())) return;
  pending = shared;
  if (activePeer()) closeChat();
  showTab('peers');
  show();
}

/**
 * Lo envía a `peer`: los archivos, a sus transferencias; el texto (sin
 * archivos) queda escrito en su chat, o en el diálogo de texto si no tiene
 * código, para mirarlo antes de enviarlo.
 */
export async function shareTo(peer, hasCode) {
  const { paths, text } = pending;
  cancel();
  if (paths.length) {
    await sendPaths(peer, paths);
    showTab('transfers');
  } else if (hasCode) {
    await openChat(peer);
    const input = $('#chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input'));
  } else {
    openTextDialog(peer);
    $('#text-body').value = text;
  }
}

$('#share-cancel').addEventListener('click', cancel);
onBack(cancel);

window.pasaloShare = takeShare;
