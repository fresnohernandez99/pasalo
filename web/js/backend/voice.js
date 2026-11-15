// Voz de las llamadas en el navegador: el micrófono pasa por un AudioWorklet
// (voice-worklet.js) y se comprime con el mismo códec que las apps
// (`pasalo-call`, compilado a WASM). Los paquetes van en datagramas de la
// conexión de iroh con el otro equipo.
//
// iOS solo deja sonar audio que empezó con un toque del usuario: el
// AudioContext se crea (o se reanuda) en el primer toque y se reutiliza.

import { Voice } from '../pkg/pasalo_web.js';
import { PasaloError } from './util.js';

const Native = window.AudioContext || window.webkitAudioContext;
let shared = null;

/** El AudioContext de la página (el mismo para la voz y el timbre). */
export function audioContext() {
  if (!shared || shared.state === 'closed') shared = new Native({ latencyHint: 'interactive' });
  return shared;
}

/** En el primer toque: así el audio puede sonar luego sin otro toque. */
export function unlockAudio() {
  const ctx = audioContext();
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
}

let workletLoaded = null;

const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };

/** Opens the microphone with that id; with none, or if it is no longer there, the default one. */
async function microphone(id) {
  const open = (which) => navigator.mediaDevices.getUserMedia({ audio: { ...MIC, ...which }, video: false });
  try {
    if (!id) return await open({});
    return await open({ deviceId: { exact: id } }).catch((err) => {
      if (err?.name !== 'OverconstrainedError') throw err;
      return open({});
    });
  } catch (err) {
    throw new PasaloError(err?.name === 'NotAllowedError' ? 'mic_denied' : 'audio_failed', String(err?.message || err));
  }
}

// Not every browser lets the page choose where it sounds (Safari does not).
const picksOutput = () => typeof Native?.prototype.setSinkId === 'function';

/** Sends the sound of the page to the speakers with that id (none: the default ones). */
async function setOutput(id) {
  if (!picksOutput()) return;
  const ctx = audioContext();
  if (typeof ctx.sinkId === 'string' && ctx.sinkId !== (id || '')) await ctx.setSinkId(id || '');
}

/**
 * The microphones and speakers to choose from, `{ inputs, outputs }` of
 * `{ id, name }`. The browser only names them once the microphone was
 * allowed; its own "default" entries are left out (ours is the empty id).
 */
export async function voiceDevices() {
  let all = [];
  try {
    all = await navigator.mediaDevices.enumerateDevices();
  } catch {}
  const list = (kind) =>
    all
      .filter((d) => d.kind === kind && d.label && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ id: d.deviceId, name: d.label }));
  return { inputs: list('audioinput'), outputs: picksOutput() ? list('audiooutput') : [] };
}

/** Llamada de voz en marcha. */
export class VoiceCall {
  /** `devices` is `{ input, output }`: the ids chosen, if any. */
  static async start(talk, peer, mode, devices = {}) {
    const stream = await microphone(devices.input);
    // Speakers that are no longer there: it sounds through the ones it had.
    await setOutput(devices.output).catch(() => {});
    const call = new VoiceCall(peer, stream);
    call.input = devices.input || '';
    try {
      await call.open(talk, mode);
    } catch (err) {
      call.stop(talk);
      throw err instanceof PasaloError ? err : new PasaloError('audio_failed', String(err?.message || err));
    }
    return call;
  }

  constructor(peer, stream) {
    this.peer = peer;
    this.stream = stream;
    this.input = '';
    this.muted = false;
    this.recovering = false;
    this.voice = null;
    this.conn = null;
    this.packets = 0;
    this.dropped = 0;
  }

  async open(talk, mode) {
    // iOS (Safari 17+): sesión de audio de llamada, con micrófono y altavoz a
    // la vez y la cancelación de eco del sistema.
    if (navigator.audioSession) navigator.audioSession.type = 'play-and-record';
    const ctx = audioContext();
    // Sin un toque del usuario no arranca (y la promesa no termina): la
    // llamada sigue y el audio empieza en cuanto se toque la pantalla.
    if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
    workletLoaded ||= ctx.audioWorklet.addModule(new URL('./voice-worklet.js', import.meta.url));
    await workletLoaded;
    this.voice = new Voice(mode, ctx.sampleRate);
    this.conn = await talk.openVoice(this.peer, (packet) => this.voice?.receive(packet));
    this.node = new AudioWorkletNode(ctx, 'pasalo-voice', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.node.port.onmessage = ({ data }) => {
      if (!this.voice) return;
      if (data.mic) {
        for (const packet of this.voice.record(data.mic)) {
          if (this.conn.sendDatagram(packet)) this.packets++;
          else this.dropped++;
        }
      } else if (data.need) {
        const samples = this.voice.play(data.need);
        this.node.port.postMessage(samples, [samples.buffer]);
      }
    };
    this.node.connect(ctx.destination);
    this.useMic(this.stream);
    // A device in use that is unplugged: the call goes on with the default one.
    this.onDevices = () => this.recover();
    navigator.mediaDevices.addEventListener?.('devicechange', this.onDevices);
  }

  /** Feeds the call from `stream` in place of the microphone it had. */
  useMic(stream) {
    const old = this.stream;
    this.stream = stream;
    for (const track of stream.getAudioTracks()) {
      track.enabled = !this.muted;
      track.addEventListener('ended', () => this.recover());
    }
    this.source?.disconnect();
    this.source = audioContext().createMediaStreamSource(stream);
    this.source.connect(this.node);
    if (old !== stream) for (const track of old.getTracks()) track.stop();
  }

  /**
   * After a device was plugged in or out: if the microphone in use ended,
   * opens the default one (and keeps trying on every change until there is
   * one); if the speakers in use are gone, it sounds through the default ones.
   */
  async recover() {
    if (!this.voice) return;
    const ctx = audioContext();
    if (typeof ctx.sinkId === 'string' && ctx.sinkId) {
      const all = await navigator.mediaDevices.enumerateDevices().catch(() => null);
      if (all && !all.some((d) => d.kind === 'audiooutput' && d.deviceId === ctx.sinkId)) await ctx.setSinkId('').catch(() => {});
    }
    if (this.recovering || !this.voice || this.stream.getAudioTracks().some((track) => track.readyState === 'live')) return;
    this.recovering = true;
    try {
      const stream = await microphone(this.input);
      if (this.voice) this.useMic(stream);
      else for (const track of stream.getTracks()) track.stop();
    } catch {
      // No microphone left: tried again when one is plugged in.
    } finally {
      this.recovering = false;
    }
  }

  setMode(mode) {
    this.voice?.setMode(mode);
  }

  setMuted(muted) {
    this.muted = muted;
    this.voice?.setMuted(muted);
    for (const track of this.stream.getAudioTracks()) track.enabled = !muted;
  }

  /** Changes the microphone and the speakers mid-call (`{ input, output }`, ids). */
  async setDevices({ input, output }) {
    try {
      await setOutput(output);
    } catch (err) {
      throw new PasaloError('audio_failed', String(err?.message || err));
    }
    if ((input || '') === this.input) return;
    const stream = await microphone(input);
    // Hung up meanwhile.
    if (!this.voice) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.input = input || '';
    this.useMic(stream);
  }

  stats() {
    if (!this.voice || !this.conn) return null;
    const [sent, received] = this.conn.wireBytes();
    const [lost, recovered] = this.voice.losses();
    return { sent, received, lost, recovered, packets: this.packets, dropped: this.dropped };
  }

  stop(talk) {
    if (navigator.audioSession) navigator.audioSession.type = 'auto';
    talk.endVoice(this.peer);
    if (this.onDevices) navigator.mediaDevices.removeEventListener?.('devicechange', this.onDevices);
    this.node?.port.postMessage('stop');
    this.source?.disconnect();
    this.node?.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    this.voice?.free();
    this.voice = null;
  }
}
