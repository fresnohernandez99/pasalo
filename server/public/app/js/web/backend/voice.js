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

/** Llamada de voz en marcha. */
export class VoiceCall {
  static async start(talk, peer, mode) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
    } catch (err) {
      throw new PasaloError(err?.name === 'NotAllowedError' ? 'mic_denied' : 'audio_failed', String(err?.message || err));
    }
    const call = new VoiceCall(peer, stream);
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
    this.source = ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node);
    this.node.connect(ctx.destination);
  }

  setMode(mode) {
    this.voice?.setMode(mode);
  }

  setMuted(muted) {
    this.voice?.setMuted(muted);
    for (const track of this.stream.getAudioTracks()) track.enabled = !muted;
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
    this.node?.port.postMessage('stop');
    this.source?.disconnect();
    this.node?.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    this.voice?.free();
    this.voice = null;
  }
}
