// Llamadas de voz y vídeo. La voz la graba, comprime y reproduce Rust
// (`voice_*`); el vídeo, video.js. Las dos van por la conexión de iroh con
// el otro equipo, y las señales (invitar, contestar, cambiar de calidad…)
// por `call_signal`.
//
// La calidad del audio y la del vídeo van por separado. Quien la cambia la
// cambia para los dos lados: así, si uno tiene mala señal, bajan los dos.

// Consumo medido con los dos lados hablando a la vez (el peor caso), con
// todo lo que pasa por la red. Si solo habla uno, el otro gasta mucho menos.
const VOICE_MODES = [
  ['high', 42],
  ['normal', 26],
  ['low', 19],
  ['minimum', 9],
];
const RING_TIMEOUT = 45_000;
// Sin recibir nada por la conexión en este tiempo (iroh manda un keep-alive
// cada 5 s aunque nadie hable), el otro lado ya no está.
const LINK_TIMEOUT = 15_000;
const DEFAULTS = { voiceMode: 'normal', videoAudioMode: 'low', videoQuality: 'normal' };

import { errorText, t } from '../i18n/index.js';
import { on } from '../lib/bus.js';
import { $, esc } from '../lib/dom.js';
import { initials } from '../lib/format.js';
import { Channel, invoke } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { isMobile } from '../state.js';
import { activePeer } from './chat.js';
import { keepCall } from './keepalive.js';
import { onHello, onUnpair } from './lobby.js';
import { onBack } from './nav.js';
import { ensureRemotePeer } from './peers.js';
import { VIDEO_MODES, VideoReceiver, VideoSender, decodableCodecs, pickCodec } from './video.js';

let live = null;

// ---------- ajustes ----------

function callSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('talk') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveCallSettings(patch) {
  try {
    localStorage.setItem('talk', JSON.stringify({ ...callSettings(), ...patch }));
  } catch {}
}

// Lo suyo en la pantalla de Ajustes (settings.js la abre y la cierra).
export function fillCallSettings() {
  const s = callSettings();
  fillAudioModes($('#set-voice-mode'), s.voiceMode);
  fillAudioModes($('#set-video-audio-mode'), s.videoAudioMode);
  fillVideoModes($('#set-video-quality'), s.videoQuality);
}

for (const [id, key] of [
  ['#set-voice-mode', 'voiceMode'],
  ['#set-video-audio-mode', 'videoAudioMode'],
  ['#set-video-quality', 'videoQuality'],
]) {
  $(id).addEventListener('change', (ev) => saveCallSettings({ [key]: ev.target.value }));
}

function fillAudioModes(select, current) {
  select.innerHTML = VOICE_MODES.map(
    ([mode, kbps]) => `<option value="${mode}" ${mode === current ? 'selected' : ''}>${esc(t(`voice.${mode}`, { kbps }))}</option>`,
  ).join('');
}

function fillVideoModes(select, current) {
  select.innerHTML = Object.entries(VIDEO_MODES)
    .map(([q, m]) => `<option value="${q}" ${q === current ? 'selected' : ''}>${esc(t(`video.${q}`, { kbps: m.kbps }))}</option>`)
    .join('');
}

function setQualityMenu(open) {
  $('#call-quality-menu').hidden = !open;
  $('#call-quality-btn').setAttribute('aria-expanded', String(open));
}

// ---------- señales ----------

function signal(kind, data = null) {
  if (!live) return Promise.resolve();
  return invoke('call_signal', { peer: live.peer.code, call: live.id, kind, data }).catch((err) => {
    if (kind !== 'hangup') toast(errorText(err), true);
    throw err;
  });
}

/** `to` es `{ code, name }`. */
export async function startCall(to, media) {
  if (!to?.code) return;
  if (live) {
    toast(t('call.busy_self'), true);
    return;
  }
  const codecs = media === 'video' ? await decodableCodecs() : [];
  if (media === 'video' && !codecs.length) {
    toast(t('call.no_video'), true);
    return;
  }
  const s = callSettings();
  live = newCall({
    id: crypto.randomUUID(),
    peer: { code: to.code, name: to.name },
    media,
    role: 'caller',
    state: 'ringing',
    audio: media === 'voice' ? s.voiceMode : s.videoAudioMode,
    video: s.videoQuality,
  });
  showCall();
  try {
    await signal('invite', { media, mode: live.audio, video: live.video, codecs });
  } catch {
    endCall();
    return;
  }
  live.ringTimer = setTimeout(() => hangup('no_answer'), RING_TIMEOUT);
}

function newCall(fields) {
  return { muted: false, speaker: false, camOff: false, remoteCamOff: false, theirCodecs: [], facing: 'user', ...fields };
}

export function onSignal({ peer, name, signal: s }) {
  if (s.kind === 'unpair') {
    onUnpair(peer, name);
    return;
  }
  if (s.kind === 'hello') {
    onHello(peer, name);
    return;
  }
  if (s.kind === 'invite') {
    if (live) {
      invoke('call_signal', { peer, call: s.call, kind: 'busy', data: null }).catch(() => {});
      return;
    }
    ensureRemotePeer(peer, name);
    const media = s.data?.media === 'video' ? 'video' : 'voice';
    live = newCall({
      id: s.call,
      peer: { code: peer, name },
      media,
      role: 'callee',
      state: 'incoming',
      audio: s.data?.mode || 'normal',
      video: VIDEO_MODES[s.data?.video] ? s.data.video : callSettings().videoQuality,
      theirCodecs: s.data?.codecs || [],
    });
    showCall();
    startRinging();
    // Si la señal de colgar no llega (el otro se quedó sin conexión), no se
    // sigue sonando para siempre.
    live.ringTimer = setTimeout(() => endCall(t('call.missed')), RING_TIMEOUT + 5000);
    return;
  }
  if (!live || s.call !== live.id || peer !== live.peer.code) return;
  switch (s.kind) {
    case 'accept':
      clearTimeout(live.ringTimer);
      live.theirCodecs = s.data?.codecs || [];
      startMedia();
      break;
    case 'decline':
    case 'busy':
    case 'hangup':
      endCall(t(`call.ended_${s.kind}`));
      break;
    case 'mode':
      // La otra persona cambió la calidad del audio: se usa la misma en los dos sentidos.
      if (VOICE_MODES.some(([m]) => m === s.data?.mode)) {
        live.audio = s.data.mode;
        $('#call-mode').value = live.audio;
        if (live.state === 'active') invoke('voice_mode', { mode: live.audio });
      }
      break;
    case 'video_mode':
      if (VIDEO_MODES[s.data?.video]) {
        live.video = s.data.video;
        $('#call-vmode').value = live.video;
        live.sender?.setMode(live.video);
      }
      break;
    case 'key':
      live.sender?.requestKey();
      break;
    case 'cam':
      live.remoteCamOff = s.data?.on === false;
      showCall();
      break;
  }
}

async function acceptCall() {
  stopRinging();
  if (!live) return;
  clearTimeout(live.ringTimer);
  const data = live.media === 'video' ? { codecs: await decodableCodecs() } : null;
  try {
    await signal('accept', data);
  } catch {
    endCall();
    return;
  }
  startMedia();
}

function declineCall() {
  stopRinging();
  signal('decline').catch(() => {});
  endCall();
}

function hangup(reason) {
  signal('hangup').catch(() => {});
  endCall(reason ? t(`call.ended_${reason}`) : null);
}

// ---------- audio y vídeo ----------

async function startMedia() {
  live.state = 'active';
  keepCall(live.media);
  live.started = Date.now();
  // En una videollamada el teléfono no va pegado a la oreja.
  if (live.media === 'video' && isMobile()) live.speaker = true;
  showCall();
  live.clock = setInterval(() => updateCallState(), 1000);
  const c = live;
  try {
    await invoke('voice_start', { peer: c.peer.code, mode: c.audio });
    // Colgaron mientras arrancaba: que no se quede grabando sin llamada.
    if (c !== live) {
      invoke('voice_stop').catch(() => {});
      return;
    }
    c.voiceOn = true;
    if (c.speaker) invoke('voice_speaker', { speaker: true });
    c.last = null;
    c.heardAt = Date.now();
    c.statsTimer = setInterval(updateStats, 1000);
    if (c.media === 'video') await startVideo(c);
  } catch (err) {
    if (c !== live) return;
    toast(errorText(err), true);
    hangup();
  }
}

async function startVideo(c) {
  c.videoUp = 0;
  c.videoDown = 0;
  c.receiver = new VideoReceiver({
    canvas: $('#call-remote'),
    needKey: () => signal('key').catch(() => {}),
    onBytes: (n) => (c.videoDown += n),
    onFrame: () => {
      if (!c.hasVideo) {
        c.hasVideo = true;
        showCall();
      }
    },
  });
  const frames = new Channel();
  frames.onmessage = (buffer) => c.receiver?.push(buffer);
  await invoke('video_start', { peer: c.peer.code, frames });
  if (c !== live) {
    invoke('video_stop').catch(() => {});
    return;
  }

  try {
    c.stream = await camera(c.facing);
  } catch {
    toast(t('call.cam_denied'), true);
    setCamera(false);
    return;
  }
  if (c !== live) {
    c.stream.getTracks().forEach((track) => track.stop());
    return;
  }
  $('#call-local').srcObject = c.stream;
  const codec = await pickCodec(c.theirCodecs);
  if (!codec) {
    toast(t('call.peer_no_video'), true);
    return;
  }
  c.sender = new VideoSender({
    stream: c.stream,
    codec,
    mode: c.video,
    send: (bytes) => invoke('video_send', bytes),
    onBytes: (n) => (c.videoUp += n),
    onCameraLost: () => recoverCamera(c),
  });
  c.sender.setPaused(c.camOff);
  await c.sender.start();
}

function camera(facing) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } },
  });
}

/** La cámara se cortó a mitad de llamada: se pide otra vez hasta que vuelva. */
async function recoverCamera(c) {
  while (c === live && c.sender) {
    try {
      const stream = await camera(c.facing);
      if (c !== live || !c.sender) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      c.stream?.getTracks().forEach((track) => track.stop());
      c.stream = stream;
      $('#call-local').srcObject = stream;
      await c.sender.setStream(stream);
      return;
    } catch {
      // Otra app la tiene todavía: se reintenta en un momento.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

/** Cambia entre la cámara de delante y la de atrás. */
async function flipCamera() {
  const c = live;
  if (!c?.stream) return;
  const facing = c.facing === 'user' ? 'environment' : 'user';
  let stream;
  try {
    stream = await camera(facing);
  } catch {
    return;
  }
  if (c !== live) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  // La vieja se suelta después: si no, el emisor la vería cortada y la pediría de nuevo.
  const old = c.stream;
  c.stream = stream;
  c.facing = facing;
  $('#call-local').srcObject = stream;
  $('#call').classList.toggle('rear', facing !== 'user');
  await c.sender?.setStream(stream);
  old.getTracks().forEach((track) => track.stop());
}

function stopVideo(c) {
  c.sender?.stop();
  c.receiver?.stop();
  c.stream?.getTracks().forEach((track) => track.stop());
  c.sender = c.receiver = c.stream = null;
  $('#call-local').srcObject = null;
  if (c.media === 'video') invoke('video_stop').catch(() => {});
}

function endCall(message) {
  if (!live) return;
  const c = live;
  live = null;
  keepCall(null);
  stopRinging();
  clearTimeout(c.ringTimer);
  clearInterval(c.statsTimer);
  clearInterval(c.clock);
  if (c.state === 'active') invoke('voice_stop').catch(() => {});
  stopVideo(c);
  $('#call').hidden = true;
  $('#call').classList.remove('controls-hidden', 'rear', 'swapped');
  setQualityMenu(false);
  if (message) toast(message);
}

/** Cuelga la llamada con `code` porque se fue: se desconectó o se cayó la conexión. */
export function endCallWith(code, reason = 'lost') {
  if (!live || live.peer.code !== code) return;
  signal('hangup').catch(() => {});
  endCall(t(`call.ended_${reason}`));
}

/** El núcleo vio caerse la conexión de la llamada (ya paró la voz y el vídeo). */
export function onTalkLost({ peer }) {
  if (live?.peer.code === peer) endCall(t('call.ended_lost'));
}

// Consumo medido de la conexión (voz, vídeo y todo lo demás) y, aparte, el vídeo.
// También vigila que siga llegando algo: si no, la llamada se acabó.
async function updateStats() {
  const c = live;
  const stats = await invoke('voice_stats').catch(() => null);
  if (!c || c !== live) return;
  if (!stats) {
    // La voz ya no está en marcha (el núcleo la paró): no hay llamada.
    if (c.voiceOn) endCallWith(c.peer.code);
    return;
  }
  if (!c.last || stats.received > c.last.received) c.heardAt = Date.now();
  else if (Date.now() - c.heardAt > LINK_TIMEOUT) {
    endCallWith(c.peer.code);
    return;
  }
  if (c.last) {
    const kbps = (now, before) => (((now - before) * 8) / 1000).toFixed(c.media === 'video' ? 0 : 1);
    const parts = [t('call.stats', { up: kbps(stats.sent, c.last.sent), down: kbps(stats.received, c.last.received) })];
    if (c.media === 'video') {
      parts.push(t('call.video_stats', { up: kbps(c.videoUp, c.last.videoUp), down: kbps(c.videoDown, c.last.videoDown) }));
    }
    if (stats.lost) parts.push(t('call.lost', { lost: stats.lost, recovered: stats.recovered }));
    $('#call-stats').textContent = parts.join(' · ');
  }
  c.last = { ...stats, videoUp: c.videoUp || 0, videoDown: c.videoDown || 0 };
}

// ---------- pantalla ----------

function showCall() {
  const c = live;
  const video = c.media === 'video';
  $('#call').hidden = false;
  const hidden = $('#call').classList.contains('controls-hidden') && c.state === 'active';
  const hasVideo = video && !!c.hasVideo && !c.remoteCamOff;
  // Cambiadas de sitio solo mientras se vean las dos.
  const swapped = $('#call').classList.contains('swapped') && hasVideo && !c.camOff;
  $('#call').className = `call ${c.media} ${c.state}${hidden ? ' controls-hidden' : ''}${c.facing !== 'user' ? ' rear' : ''}${swapped ? ' swapped' : ''}`;
  $('#call').classList.toggle('has-video', hasVideo);
  $('#call').classList.toggle('cam-off', c.camOff);
  $('#call-name').textContent = c.peer.name;
  $('#call-avatar').textContent = initials(c.peer.name);
  $('#call-remote-off').hidden = !(video && c.state === 'active' && c.remoteCamOff);
  if (c.state !== 'active') $('#call-stats').textContent = '';
  $('#call-accept').hidden = c.state !== 'incoming';
  $('#call-decline').hidden = c.state !== 'incoming';
  $('#call-hangup').hidden = c.state === 'incoming';
  $('#call-controls-live').hidden = c.state === 'incoming';
  $('#call-speaker').hidden = !isMobile();
  $('#call-cam').hidden = !video;
  $('#call-flip').hidden = !video || !isMobile() || c.camOff;
  $('#call-vmode-btn').hidden = !video;
  fillAudioModes($('#call-mode'), c.audio);
  fillVideoModes($('#call-vmode'), c.video);
  $('#call-mute').classList.toggle('on', c.muted);
  $('#call-speaker').classList.toggle('on', c.speaker);
  $('#call-cam').classList.toggle('on', c.camOff);
  $('#call-cam-label').textContent = t(c.camOff ? 'call.camera_on' : 'call.camera');
  updateCallState();
}

function updateCallState() {
  if (!live) return;
  let text;
  if (live.state === 'incoming') text = t(live.media === 'voice' ? 'call.incoming_voice' : 'call.incoming_video');
  else if (live.state === 'ringing') text = t('call.ringing');
  else {
    const s = Math.floor((Date.now() - live.started) / 1000);
    text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  $('#call-state').textContent = text;
}

function setCamera(on) {
  if (!live) return;
  live.camOff = !on;
  live.sender?.setPaused(live.camOff);
  signal('cam', { on }).catch(() => {});
  showCall();
}

$('#call-accept').addEventListener('click', acceptCall);
$('#call-decline').addEventListener('click', declineCall);
$('#call-hangup').addEventListener('click', () => hangup());

$('#call-mute').addEventListener('click', () => {
  if (!live) return;
  live.muted = !live.muted;
  $('#call-mute').classList.toggle('on', live.muted);
  invoke('voice_mute', { muted: live.muted });
});

$('#call-speaker').addEventListener('click', () => {
  if (!live) return;
  live.speaker = !live.speaker;
  $('#call-speaker').classList.toggle('on', live.speaker);
  invoke('voice_speaker', { speaker: live.speaker });
});

$('#call-cam').addEventListener('click', () => setCamera(!!live?.camOff));
$('#call-flip').addEventListener('click', flipCamera);

$('#call-quality-btn').addEventListener('click', () => setQualityMenu($('#call-quality-menu').hidden));

// En una videollamada, tocar la miniatura cambia de sitio las dos imágenes;
// tocar la grande esconde los botones y los datos (para verla entera) y otro
// toque los vuelve a enseñar.
$('#call').addEventListener('click', (ev) => {
  if (ev.target.closest('.call-quality')) return;
  // Fuera del menú de calidad, un toque solo lo cierra.
  if (!$('#call-quality-menu').hidden) {
    setQualityMenu(false);
    return;
  }
  if (!live || live.media !== 'video' || live.state !== 'active') return;
  if (ev.target.closest('button, select, .cbtn')) return;
  const call = $('#call');
  const thumb = call.classList.contains('swapped') ? $('#call-remote') : $('#call-local');
  if (ev.target === thumb && call.classList.contains('has-video')) {
    call.classList.toggle('swapped');
    return;
  }
  call.classList.toggle('controls-hidden');
});

// En una llamada, Atrás no cuelga: hay que pulsar Colgar.
onBack(() => !!live);

$('#call-mode').addEventListener('change', (ev) => {
  if (!live) return;
  live.audio = ev.target.value;
  saveCallSettings(live.media === 'voice' ? { voiceMode: live.audio } : { videoAudioMode: live.audio });
  if (live.state === 'active') invoke('voice_mode', { mode: live.audio });
  signal('mode', { mode: live.audio }).catch(() => {});
});

$('#call-vmode').addEventListener('change', (ev) => {
  if (!live) return;
  live.video = ev.target.value;
  saveCallSettings({ videoQuality: live.video });
  live.sender?.setMode(live.video);
  signal('video_mode', { video: live.video }).catch(() => {});
});

$('#chat-voice').addEventListener('click', () => startCall(activePeer(), 'voice'));
$('#chat-video').addEventListener('click', () => startCall(activePeer(), 'video'));

// Timbre con WebAudio, sin archivos de sonido.
function startRinging() {
  stopRinging();
  const beep = () => {
    try {
      const ctx = (startRinging.ctx ||= new AudioContext());
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.6);
    } catch {}
  };
  beep();
  startRinging.timer = setInterval(beep, 1500);
}

function stopRinging() {
  clearInterval(startRinging.timer);
}

on('lang', () => {
  if (live) showCall();
});
