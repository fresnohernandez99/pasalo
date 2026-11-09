// Lo que llega por «Compartir» desde otra app de Android (ver
// PasaloPlugin.kt) y lo que se reenvía desde un chat o desde las
// transferencias: se elige un equipo de la lista y se le envía.

import { t } from '../i18n/index.js';
import { $ } from '../lib/dom.js';
import { basename, label } from '../lib/format.js';
import { invoke, tryCall } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { activePeer, closeChat, openChat } from './chat.js';
import { onBack, showTab } from './nav.js';
import { peerCode } from './peers.js';
import { openTextDialog, sendPaths } from './transfers.js';

/**
 * `{ paths, text, media, forward }` mientras se elige a quién enviarlo.
 * `media` es una foto o nota de voz del chat (`{ kind, path, durationMs }`),
 * que llega al otro chat como tal y no como archivo.
 */
let pending = null;

export const sharing = () => !!pending;

function show() {
  const { paths, text, media } = pending;
  $('#share-what').textContent = media
    ? t(media.kind === 'audio' ? 'chat.voice_note' : 'chat.photo')
    : paths.length ? label(paths.map(basename)) : text;
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

/** Reenviar un mensaje del chat o algo de las transferencias: como compartir. */
export function forward({ paths = [], text = '', media = null }) {
  pending = { paths, text, media, forward: true };
  if (activePeer()) closeChat();
  showTab('peers');
  show();
}

/** Base64 de lo que devuelve `chat_image`: una data URL o (en la web) la de un blob. */
async function mediaBase64(path) {
  const url = await invoke('chat_image', { path });
  if (url.startsWith('data:')) return url.slice(url.indexOf(',') + 1);
  const blob = await (await fetch(url)).blob();
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return data.slice(data.indexOf(',') + 1);
}

/** Una foto o nota de voz reenviada, al chat de `peer`. */
async function sendMedia(peer, { kind, path, durationMs }) {
  let data;
  try {
    data = await mediaBase64(path);
  } catch {
    toast(t('forward.gone'), true);
    return;
  }
  const ext = basename(path).split('.').pop() || (kind === 'audio' ? 'webm' : 'jpg');
  const args = { peer: peerCode(peer), data, ext };
  const sent = kind === 'audio'
    ? await tryCall('chat_send_audio', { ...args, durationMs: durationMs || 0 })
    : await tryCall('chat_send_image', args);
  if (sent) openChat(peer);
}

/**
 * Lo envía a `peer`: los archivos, a sus transferencias; el texto (sin
 * archivos) queda escrito en su chat, o en el diálogo de texto si no tiene
 * código, para mirarlo antes de enviarlo. Lo reenviado desde un chat va
 * directo a su chat.
 */
export async function shareTo(peer, hasCode) {
  const { paths, text, media, forward } = pending;
  cancel();
  if (media && hasCode) {
    await sendMedia(peer, media);
  } else if (media) {
    // Un equipo sin chat: la foto o la nota le llega como archivo.
    await sendPaths(peer, [media.path]);
    showTab('transfers');
  } else if (paths.length) {
    await sendPaths(peer, paths);
    showTab('transfers');
  } else if (hasCode && forward) {
    if (await tryCall('chat_send', { peer: peerCode(peer), text })) openChat(peer);
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
