// Voice and video calls: the state of the current call (`live`) and the
// signals with the other side (invite, accept, hang up, change quality…),
// which go through `call_signal`. The voice is recorded, compressed and
// played by Rust (`voice_*`); the video by call/camera.js. Both go over the
// iroh connection with the other device.
//
// The audio quality and the video quality are separate. Whoever changes one
// changes it for both sides: so if one has a bad signal, both go down.
//
// The rest lives in call/: settings.js (what is saved and the quality
// lists), screen.js (what is shown), camera.js (the video), devices.js (the
// microphones, speakers and cameras to choose from), record.js (the record
// in the chat) and ringtone.js.

import { errorText, t } from '../i18n/index.js';
import { on } from '../lib/bus.js';
import { $ } from '../lib/dom.js';
import { invoke } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { isMobile } from '../state.js';
import { activePeer } from './chat.js';
import { keepCall } from './keepalive.js';
import { onHello, onUnpair } from './lobby.js';
import { onBack } from './nav.js';
import { clearNotification, notifyCall, notifyMissed, onNotification } from './notify.js';
import { pickGame, playing } from './game.js';
import { ensureRemotePeer } from './peers.js';
import { VIDEO_MODES, decodableCodecs } from './video.js';
import { flipCamera, pickCamera, setBlur, setupVideo, startVideo, stopVideo } from './call/camera.js';
import { fillDevices, listDevices } from './call/devices.js';
import { logCall } from './call/record.js';
import { startRinging, stopRinging } from './call/ringtone.js';
import { hide, openMenu, render, renderState, setMenu } from './call/screen.js';
import { callSettings, isVoiceMode, saveCallSettings, voiceDevices } from './call/settings.js';
import { hasOwn, newId } from './call/util.js';

export { fillCallSettings } from './call/settings.js';

const RING_TIMEOUT = 45_000;
// Nothing received over the connection in this time (iroh sends a keep-alive
// every 5 s even if nobody talks): the other side is gone.
const LINK_TIMEOUT = 15_000;

let live = null;
let starting = false;
const isLive = (c) => c === live;

// ---------- signals ----------

// Only these signals warn if they fail: the rest (asking for a key frame,
// changing quality, switching the camera off…) is retried or does not
// matter, and over a slow relay the warnings piled up just when the call
// was at its worst.
const LOUD_SIGNALS = ['invite', 'accept'];

function signal(kind, data = null) {
  if (!live) return Promise.resolve();
  return invoke('call_signal', { peer: live.peer.code, call: live.id, kind, data }).catch((err) => {
    if (LOUD_SIGNALS.includes(kind)) toast(errorText(err), true);
    throw err;
  });
}

/** `to` is `{ code, name }`. */
export async function startCall(to, media) {
  if (!to?.code) return;
  if (live || starting) {
    toast(t('call.busy_self'), true);
    return;
  }
  // A double tap cannot send two invitations.
  starting = true;
  let codecs;
  try {
    codecs = media === 'video' ? await decodableCodecs() : [];
  } finally {
    starting = false;
  }
  if (live) return;
  if (media === 'video' && !codecs.length) {
    toast(t('call.no_video'), true);
    return;
  }
  const s = callSettings();
  live = newCall({
    id: newId(),
    peer: { code: to.code, name: to.name },
    media,
    role: 'caller',
    state: 'ringing',
    audio: media === 'voice' ? s.voiceMode : s.videoAudioMode,
    video: s.videoQuality,
  });
  render(live);
  refreshDevices();
  try {
    await signal('invite', { media, mode: live.audio, video: live.video, codecs });
  } catch {
    endCall(null, 'failed');
    return;
  }
  live.ringTimer = setTimeout(() => hangup('no_answer'), RING_TIMEOUT);
}

function newCall(fields) {
  return { createdAt: Date.now(), muted: false, speaker: false, camOff: false, remoteCamOff: false, theirCodecs: [], facing: 'user', camera: callSettings().camera, blur: callSettings().blur, ...fields };
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
    onInvite(peer, name, s);
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
    case 'hangup': {
      let outcome = 'completed';
      if (live.state !== 'active') {
        if (live.role === 'callee') outcome = 'missed';
        else outcome = s.kind === 'decline' ? 'declined' : s.kind === 'busy' ? 'busy' : 'cancelled';
      }
      endCall(t(`call.ended_${s.kind}`), outcome);
      break;
    }
    case 'mode':
      // The other person changed the audio quality: the same is used both ways.
      if (isVoiceMode(s.data?.mode)) {
        live.audio = s.data.mode;
        $('#call-mode').value = live.audio;
        if (live.state === 'active') invoke('voice_mode', { mode: live.audio });
      }
      break;
    case 'video_mode':
      if (hasOwn(VIDEO_MODES, s.data?.video ?? '')) {
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
      live.receiver?.setExpecting(!live.remoteCamOff);
      render(live);
      break;
  }
}

function onInvite(peer, name, s) {
  const media = s.data?.media === 'video' ? 'video' : 'voice';
  // In another call, or in a game (which sits on top and would cover the call).
  if (live || playing()) {
    invoke('call_signal', { peer, call: s.call, kind: 'busy', data: null }).catch(() => {});
    // As in WhatsApp: it is logged as missed.
    ensureRemotePeer(peer, name);
    logCall({ id: s.call, peer: { code: peer, name }, media, role: 'callee', createdAt: Date.now() }, 'missed');
    return;
  }
  ensureRemotePeer(peer, name);
  // An open dialog (add device, a link…) leaves the rest of the screen
  // inert: the call could not be answered.
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  live = newCall({
    id: s.call,
    peer: { code: peer, name },
    media,
    role: 'callee',
    state: 'incoming',
    audio: isVoiceMode(s.data?.mode) ? s.data.mode : 'normal',
    video: hasOwn(VIDEO_MODES, s.data?.video ?? '') ? s.data.video : callSettings().videoQuality,
    theirCodecs: s.data?.codecs || [],
  });
  render(live);
  startRinging();
  notifyCall(live);
  // If the hang-up signal never arrives (the other side lost its
  // connection), it does not ring forever.
  live.ringTimer = setTimeout(() => endCall(t('call.missed'), 'missed'), RING_TIMEOUT + 5000);
}

async function acceptCall() {
  stopRinging();
  // A double tap does not answer twice (two voices, two clocks).
  if (!live || live.state !== 'incoming') return;
  live.state = 'answering';
  $('#call-accept').disabled = true;
  clearTimeout(live.ringTimer);
  clearNotification({ call: live.id });
  const data = live.media === 'video' ? { codecs: await decodableCodecs() } : null;
  try {
    await signal('accept', data);
  } catch {
    endCall(null, 'failed');
    return;
  }
  $('#call-accept').disabled = false;
  startMedia();
}

function declineCall() {
  stopRinging();
  signal('decline').catch(() => {});
  endCall(null, 'declined');
}

// Answer or decline from the call notification.
onNotification('answer', (id) => {
  if (live?.id === id) acceptCall();
});
onNotification('decline', (id) => {
  if (live?.id === id && live.state === 'incoming') declineCall();
});

/** Hangs up. `reason` (`no_answer`) is shown on screen. */
function hangup(reason, outcome) {
  signal('hangup').catch(() => {});
  const result = outcome || (reason === 'no_answer' ? 'no_answer' : live?.state === 'active' ? 'completed' : 'cancelled');
  endCall(reason ? t(`call.ended_${reason}`) : null, result);
}

// ---------- audio and video ----------

async function startMedia() {
  live.state = 'active';
  keepCall(live.media);
  live.started = Date.now();
  // In a video call the phone is not held to the ear.
  if (live.media === 'video' && isMobile()) live.speaker = true;
  render(live);
  live.clock = setInterval(() => live && renderState(live), 1000);
  const c = live;
  try {
    await invoke('voice_start', { peer: c.peer.code, mode: c.audio, ...voiceDevices() });
    // Hung up while it started: it must not keep recording without a call.
    if (c !== live) {
      invoke('voice_stop').catch(() => {});
      return;
    }
    c.voiceOn = true;
    if (c.speaker) invoke('voice_speaker', { speaker: true });
    // Muted while it rang: the voice starts muted.
    if (c.muted) invoke('voice_mute', { muted: true });
    // What the connection already carried at the start: the call's usage is what comes after.
    c.first = await invoke('voice_stats').catch(() => null);
    c.last = null;
    c.heardAt = Date.now();
    c.statsTimer = setInterval(updateStats, 1000);
    if (c.media === 'video') await startVideo(c);
    // On the web the devices only have a name once they were allowed.
    refreshDevices();
  } catch (err) {
    if (c !== live) return;
    toast(errorText(err), true);
    hangup(null, 'failed');
  }
}

setupVideo({
  isLive,
  signal,
  onFirstFrame: (c) => render(c),
  onCameraDenied: () => setCamera(false),
  onDegraded: (c, mode) => {
    c.video = mode;
    $('#call-vmode').value = mode;
    signal('video_mode', { video: mode }).catch(() => {});
    toast(t('call.video_lowered'));
  },
});

/**
 * Ends the call on screen. `outcome` is how it ended (`completed`,
 * `missed`, `no_answer`, `declined`, `busy`, `cancelled`, `failed`, `lost`):
 * it goes to the chat and to the statistics.
 */
function endCall(message, outcome) {
  if (!live) return;
  const c = live;
  live = null;
  const result = outcome || (c.state === 'active' ? 'completed' : 'failed');
  logCall(c, result);
  clearNotification({ call: c.id });
  if (result === 'missed' && c.role === 'callee') notifyMissed(c);
  $('#call-accept').disabled = false;
  keepCall(null);
  stopRinging();
  clearTimeout(c.ringTimer);
  clearInterval(c.statsTimer);
  clearInterval(c.clock);
  if (c.state === 'active') invoke('voice_stop').catch(() => {});
  stopVideo(c);
  hide();
  if (message) toast(message);
}

/** Hangs up the call with `code` because they left: disconnected or the connection dropped. */
export function endCallWith(code, reason = 'lost') {
  if (!live || live.peer.code !== code) return;
  signal('hangup').catch(() => {});
  const outcome = live.state !== 'active' ? 'failed' : reason === 'lost' ? 'lost' : 'completed';
  endCall(t(`call.ended_${reason}`), outcome);
}

/** The core saw the call's connection drop (it already stopped voice and video). */
export function onTalkLost({ peer }) {
  if (live?.peer.code === peer) endCall(t('call.ended_lost'), live.state === 'active' ? 'lost' : 'failed');
}

// Measured usage of the connection (voice, video and everything else) and,
// apart, the video. It also watches that something keeps arriving: if not,
// the call is over.
async function updateStats() {
  const c = live;
  const stats = await invoke('voice_stats').catch(() => null);
  if (!c || c !== live) return;
  if (!stats) {
    // The voice is no longer running (the core stopped it): there is no call.
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

/**
 * Fills the devices menu with what there is to choose from in this call
 * (the camera, only in a video call). Its button shows only if there is
 * something.
 */
async function refreshDevices() {
  const c = live;
  if (!c) return;
  const lists = await listDevices();
  if (c !== live) return;
  if (c.media !== 'video') lists.camera = [];
  $('#call-devices-btn').hidden = !fillDevices('call-dev', lists, { ...callSettings(), camera: c.camera });
}

// Something was plugged in or out.
navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);

function setCamera(on) {
  if (!live) return;
  live.camOff = !on;
  live.sender?.setPaused(live.camOff);
  signal('cam', { on }).catch(() => {});
  render(live);
}

// ---------- buttons ----------

$('#call-accept').addEventListener('click', acceptCall);
$('#call-decline').addEventListener('click', declineCall);
$('#call-hangup').addEventListener('click', () => hangup());
// Play with whoever is on the other side, without hanging up.
$('#call-game').addEventListener('click', () => {
  if (live?.state === 'active') pickGame(live.peer);
});

/** The current call, if any (`{ peer: { code, name } }`). */
export const activeCall = () => (live?.state === 'active' ? live : null);

/** Hangs up the current call (from the game, for example). */
export function hangupCall() {
  if (live) hangup();
}

function toggle(id, key, command) {
  $(id).addEventListener('click', () => {
    if (!live) return;
    live[key] = !live[key];
    $(id).classList.toggle('on', live[key]);
    $(id).setAttribute('aria-pressed', String(live[key]));
    invoke(command, { [key]: live[key] });
  });
}
toggle('#call-mute', 'muted', 'voice_mute');
toggle('#call-speaker', 'speaker', 'voice_speaker');

$('#call-cam').addEventListener('click', () => setCamera(!!live?.camOff));
$('#call-flip').addEventListener('click', () => flipCamera(live));

$('#call-quality-btn').addEventListener('click', () => setMenu(openMenu() === 'quality' ? null : 'quality'));
$('#call-devices-btn').addEventListener('click', () => {
  const open = openMenu() !== 'devices';
  setMenu(open ? 'devices' : null);
  if (open) refreshDevices();
});

// The microphone and the speakers: saved for the next calls and, if the
// voice is already running, changed in this one.
for (const kind of ['mic', 'speaker']) {
  $(`#call-dev-${kind}`).addEventListener('change', async (ev) => {
    const before = callSettings()[kind];
    saveCallSettings({ [kind]: ev.target.value });
    if (!live?.voiceOn) return;
    try {
      await invoke('voice_device', voiceDevices());
    } catch (err) {
      // The call went on with the one it had.
      saveCallSettings({ [kind]: before });
      toast(errorText(err), true);
      refreshDevices();
    }
  });
}

$('#call-dev-camera').addEventListener('change', async (ev) => {
  if (!live) return;
  const id = ev.target.value;
  if (await pickCamera(live, id)) saveCallSettings({ camera: id });
  else refreshDevices();
});
$('#call-blur').addEventListener('change', (ev) => {
  if (!live) return;
  saveCallSettings({ blur: ev.target.checked });
  setBlur(live, ev.target.checked);
});

// In a video call, tapping the thumbnail swaps the two images; tapping the
// big one hides the buttons and the data (to see it whole) and another tap
// shows them again.
$('#call').addEventListener('click', (ev) => {
  if (ev.target.closest('.call-quality')) return;
  // Outside the menus of the corner, a tap only closes the one that is open.
  if (openMenu()) {
    setMenu();
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

// In a call, Back does not hang up: Hang up has to be pressed.
// In a game, Back leaves the game (see game.js), not the call.
onBack(() => !!live && !playing());

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

on('lang', () => {
  if (live) render(live);
  refreshDevices();
});
