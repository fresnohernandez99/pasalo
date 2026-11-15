// The video side of a call `c`: the camera, the compressed images going out
// (`video_send`) and coming in (`video_recv`), the background blur and the
// thumbnail of what is sent. The voice is handled by Rust (see call.js).
//
// It keeps its state on the call object (`c.stream`, `c.sender`,
// `c.receiver`, `c.blur`, `c.facing`, `c.camera`, `c.videoUp`, `c.videoDown`,
// `c.hasVideo`) so that the screen and the call record can read it. What it
// needs from the call itself comes through the hooks given to `setupVideo`.

import { t } from '../../i18n/index.js';
import { $ } from '../../lib/dom.js';
import { invoke } from '../../lib/tauri.js';
import { toast } from '../../lib/toast.js';
import { app } from '../../state.js';
import { BackgroundBlur, loadSegmenter } from '../blur.js';
import { VideoReceiver, VideoSender, pickCodec } from '../video.js';
import { callSettings } from './settings.js';
import { sleep, stopTracks } from './util.js';

// How long to wait before asking for the camera again when another app has it.
const CAMERA_RETRY_MS = 2000;
// Pause after a failed `video_recv` before polling again.
const RECV_RETRY_MS = 500;

/**
 * `isLive(c)` says whether `c` is still the current call; `signal(kind,
 * data)` sends a call signal; `onFirstFrame(c)` runs when the first image
 * from the other side is drawn; `onCameraDenied(c)` when the camera could
 * not be opened; `onDegraded(c, mode)` when the sender lowered the quality
 * because the network could not keep up.
 */
let hooks = {
  isLive: () => false,
  signal: () => Promise.resolve(),
  onFirstFrame: () => {},
  onCameraDenied: () => {},
  onDegraded: () => {},
};

export function setupVideo(given) {
  hooks = { ...hooks, ...given };
}

/** A compressed image in base64 (on Android the IPC carries no binary). */
function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** In the Android app binary crosses the IPC as JSON: better as base64. */
const sendFrame = (bytes) =>
  invoke('video_send', app.settings?.mobile && !app.settings?.web ? { b64: base64(bytes) } : bytes);

/** Collects what arrives from the video while this call lasts (see `video_recv`). */
async function pollVideo(c) {
  while (hooks.isLive(c) && c.receiver) {
    let buffer;
    try {
      buffer = await invoke('video_recv');
    } catch (err) {
      if (err?.code === 'video_stopped') return;
      await sleep(RECV_RETRY_MS);
      continue;
    }
    const bytes = new Uint8Array(buffer || []);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at + 4 <= bytes.length; ) {
      const len = view.getUint32(at);
      c.receiver?.push(bytes.subarray(at + 4, at + 4 + len));
      at += 4 + len;
    }
  }
}

/**
 * Opens the camera of the call: the one chosen (`c.camera`, a device id)
 * or, with none chosen or if it is no longer there, the one facing
 * `c.facing`.
 */
function camera(c) {
  const open = (which) =>
    navigator.mediaDevices.getUserMedia({ audio: false, video: { ...which, width: { ideal: 640 }, height: { ideal: 480 } } });
  const facing = () => open({ facingMode: c.facing });
  if (!c.camera) return facing();
  return open({ deviceId: { exact: c.camera } }).catch((err) => {
    if (err?.name !== 'OverconstrainedError') throw err;
    return facing();
  });
}

/** Starts receiving and, if the camera and a common codec are there, sending. */
export async function startVideo(c) {
  c.videoUp = 0;
  c.videoDown = 0;
  c.receiver = new VideoReceiver({
    canvas: $('#call-remote'),
    enhance: callSettings().enhance,
    needKey: () => hooks.signal('key').catch(() => {}),
    onBytes: (n) => (c.videoDown += n),
    onFrame: () => {
      if (!c.hasVideo) {
        c.hasVideo = true;
        hooks.onFirstFrame(c);
      }
    },
  });
  c.receiver.setExpecting(!c.remoteCamOff);
  await invoke('video_start', { peer: c.peer.code });
  if (!hooks.isLive(c)) {
    invoke('video_stop').catch(() => {});
    return;
  }
  pollVideo(c);

  try {
    c.stream = await camera(c);
  } catch {
    toast(t('call.cam_denied'), true);
    hooks.onCameraDenied(c);
    return;
  }
  if (!hooks.isLive(c)) {
    stopTracks(c.stream);
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
    send: sendFrame,
    onBytes: (n) => (c.videoUp += n),
    onCameraLost: () => recoverCamera(c),
    onBlurSlow: () => blurOff(c, 'call.blur_slow'),
    onBlurFailed: () => blurOff(c, 'call.blur_failed'),
    // The network cannot keep up: lower the quality, on the other side too.
    onDegrade: (mode) => {
      if (hooks.isLive(c)) hooks.onDegraded(c, mode);
    },
  });
  c.sender.setPaused(c.camOff);
  await c.sender.start();
  if (c.blur) setBlur(c, true);
}

function blurOff(c, message) {
  if (!hooks.isLive(c) || !c.blur) return;
  c.blur = false;
  showLocal(c);
  $('#call-blur').checked = false;
  toast(t(message), true);
}

/** The thumbnail: what is sent if the background is blurred, else the camera as is. */
function showLocal(c) {
  $('#call-local').srcObject = c.blur && c.sender ? c.sender.preview() : c.stream;
}

/**
 * Turns the background blur on or off. The first time the model is loaded
 * (about a second); meanwhile the video goes out as usual.
 */
export async function setBlur(c, on) {
  c.blur = on;
  $('#call-blur').checked = on;
  if (!on) {
    c.sender?.setBlur(null);
    showLocal(c);
    return;
  }
  let segmenter;
  // No video goes out while the model loads: otherwise the background that
  // was meant to be hidden would show.
  const loading = !!c.sender;
  if (loading) {
    c.sender.setPaused(true);
    toast(t('call.blur_loading'));
  }
  try {
    segmenter = await loadSegmenter();
  } catch (err) {
    if (hooks.isLive(c) && loading) c.sender?.setPaused(c.camOff);
    console.warn('blur', err);
    if (hooks.isLive(c)) {
      c.blur = false;
      $('#call-blur').checked = false;
      toast(t('call.blur_failed'), true);
    }
    return;
  }
  if (hooks.isLive(c) && loading) c.sender?.setPaused(c.camOff);
  // Switched off (or hung up) while it loaded.
  if (!hooks.isLive(c) || !c.blur || !c.sender) return;
  c.sender.setBlur(new BackgroundBlur(segmenter));
  showLocal(c);
}

/** The camera dropped mid-call: ask for it again until it is back. */
async function recoverCamera(c) {
  while (hooks.isLive(c) && c.sender) {
    try {
      const stream = await camera(c);
      if (!hooks.isLive(c) || !c.sender) {
        stopTracks(stream);
        return;
      }
      stopTracks(c.stream);
      c.stream = stream;
      await c.sender.setStream(stream);
      showLocal(c);
      return;
    } catch {
      // Another app still has it: try again in a moment.
      await sleep(CAMERA_RETRY_MS);
    }
  }
}

/**
 * Changes the camera in use to the one `which` says (`{ facing, camera }`,
 * as in the call) without cutting the video. `false` if it could not be
 * opened: the call stays on the one it had.
 */
async function changeCamera(c, which) {
  let stream;
  try {
    stream = await camera(which);
  } catch {
    return false;
  }
  if (!hooks.isLive(c)) {
    stopTracks(stream);
    return false;
  }
  // The old one is released afterwards: otherwise the sender would see it
  // cut and ask for it again.
  const old = c.stream;
  c.stream = stream;
  c.facing = which.facing;
  c.camera = which.camera;
  $('#call').classList.toggle('rear', c.facing !== 'user');
  await c.sender?.setStream(stream);
  showLocal(c);
  stopTracks(old);
  return true;
}

/** Switches between the front and the back camera. */
export async function flipCamera(c) {
  if (!c?.stream) return;
  await changeCamera(c, { facing: c.facing === 'user' ? 'environment' : 'user', camera: '' });
}

/**
 * Switches to the camera with that device id (`''`: the system default).
 * Before the camera is open (while it rings), it is only noted for when it
 * is. `false` if it could not be opened: the call stays on the one it had.
 */
export async function pickCamera(c, id) {
  if (!c.stream) {
    c.camera = id;
    return true;
  }
  if (await changeCamera(c, { facing: 'user', camera: id })) return true;
  if (hooks.isLive(c)) toast(t('call.cam_failed'), true);
  return false;
}

/** Releases the camera and the codecs; tells Rust to stop carrying video. */
export function stopVideo(c) {
  if (c.sender?.blurUsed) c.blurUsed = true;
  c.sender?.stop();
  c.receiver?.stop();
  stopTracks(c.stream);
  c.sender = c.receiver = c.stream = null;
  $('#call-local').srcObject = null;
  if (c.media === 'video') invoke('video_stop').catch(() => {});
}
