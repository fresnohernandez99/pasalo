// Notas de voz: se graban aquí con MediaRecorder, ya comprimidas (Opus a
// unos 24 kbps donde se puede; en Safari, AAC), y se mandan por el chat como
// un adjunto más. Mientras se graba, la caja de escribir se cambia por una
// barra con el tiempo, Cancelar y Enviar.

import { errorText, t } from '../i18n/index.js';
import { $ } from '../lib/dom.js';
import { toast } from '../lib/toast.js';

// Por orden de preferencia: AAC en MP4 primero, que lo reproducen todos
// (Safari y la app de Mac no siempre saben con WebM). Opus ocupa algo menos,
// así que queda para los equipos que no graban AAC.
const TYPES = [
  ['audio/mp4;codecs=mp4a.40.2', 'm4a', 32_000],
  ['audio/mp4', 'm4a', 32_000],
  ['audio/webm;codecs=opus', 'webm', 24_000],
  ['audio/ogg;codecs=opus', 'ogg', 24_000],
];
/** Lo más larga que puede ser una nota de voz. */
const MAX_MS = 5 * 60_000;
/** Más corta que esto, se toma por un toque sin querer. */
const MIN_MS = 700;

let rec = null;

function pickType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return TYPES.find(([type]) => MediaRecorder.isTypeSupported?.(type)) || ['', 'webm', 24_000];
}

function clock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function showBar(on) {
  $('#chat-form').classList.toggle('recording', on);
  $('#rec-bar').hidden = !on;
}

/** Empieza a grabar. `send({ data, ext, durationMs })` se llama al enviarla. */
export async function startRecording(send) {
  if (rec) return;
  const kind = pickType();
  if (!kind) {
    toast(t('rec.unsupported'), true);
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (err) {
    toast(errorText({ code: err?.name === 'NotAllowedError' ? 'mic_denied' : 'audio_failed', detail: '' }), true);
    return;
  }
  const [type, ext, bitrate] = kind;
  let recorder;
  try {
    recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: bitrate });
  } catch {
    // Algún equipo no acepta el bitrate pedido: con el suyo.
    recorder = new MediaRecorder(stream, type ? { mimeType: type } : {});
  }
  const chunks = [];
  const started = performance.now();
  rec = { recorder, stream, chunks, started, ext, send, cancelled: false };
  recorder.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
  recorder.onstop = () => finish(rec);
  recorder.start(1000);
  rec.timer = setInterval(() => {
    const ms = performance.now() - started;
    $('#rec-time').textContent = clock(ms);
    if (ms >= MAX_MS) stopRecording(true);
  }, 250);
  $('#rec-time').textContent = '0:00';
  showBar(true);
}

/** Termina: con `send`, la envía; si no, la tira. */
export function stopRecording(send) {
  if (!rec) return;
  rec.cancelled = !send;
  rec.durationMs = performance.now() - rec.started;
  clearInterval(rec.timer);
  if (rec.recorder.state !== 'inactive') rec.recorder.stop();
  else finish(rec);
}

export const isRecording = () => !!rec;

async function finish(r) {
  if (rec !== r) return;
  rec = null;
  showBar(false);
  r.stream.getTracks().forEach((track) => track.stop());
  if (r.cancelled) return;
  if (r.durationMs < MIN_MS) {
    toast(t('rec.too_short'));
    return;
  }
  const blob = new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' });
  // El micrófono no dio nada (lo tenía otra app, se cortó…): no se manda vacía.
  if (!blob.size) {
    toast(errorText({ code: 'audio_failed', detail: '' }), true);
    return;
  }
  const data = await blobToBase64(blob);
  await r.send({ data, ext: r.ext, durationMs: Math.round(r.durationMs) });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

$('#rec-cancel').addEventListener('click', () => stopRecording(false));
$('#rec-send').addEventListener('click', () => stopRecording(true));
