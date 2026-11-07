// Micrófono y altavoz de las llamadas, en el hilo de audio. No comprime nada:
// manda el micrófono en bloques de 20 ms al hilo principal (donde está el
// códec, en WASM) y pide de allí lo que tiene que sonar, manteniendo unos
// 60 ms en cola para que los retrasos del hilo principal no corten el audio.

const BLOCK_MS = 20;
const QUEUE_MS = 60;

class PasaloVoice extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = Math.round((sampleRate * BLOCK_MS) / 1000);
    this.target = Math.round((sampleRate * QUEUE_MS) / 1000);
    this.mic = new Float32Array(this.block);
    this.micAt = 0;
    this.queue = []; // Float32Array por sonar
    this.queued = 0;
    this.offset = 0; // lo ya sonado del primero de la cola
    this.asked = 0; // muestras pedidas y aún no llegadas
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'stop') {
        this.stopped = true;
        return;
      }
      this.asked = Math.max(0, this.asked - data.length);
      if (data.length) {
        this.queue.push(data);
        this.queued += data.length;
      }
    };
  }

  process(inputs, outputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.mic[this.micAt++] = input[i];
        if (this.micAt === this.block) {
          this.port.postMessage({ mic: this.mic });
          this.mic = new Float32Array(this.block);
          this.micAt = 0;
        }
      }
    }

    const out = outputs[0];
    const channel = out?.[0];
    if (channel) {
      let i = 0;
      while (i < channel.length && this.queue.length) {
        const head = this.queue[0];
        const n = Math.min(channel.length - i, head.length - this.offset);
        channel.set(head.subarray(this.offset, this.offset + n), i);
        i += n;
        this.offset += n;
        this.queued -= n;
        if (this.offset === head.length) {
          this.queue.shift();
          this.offset = 0;
        }
      }
      channel.fill(0, i);
      for (let c = 1; c < out.length; c++) out[c].set(channel);
    }

    if (this.queued + this.asked < this.target) {
      this.asked += this.block;
      this.port.postMessage({ need: this.block });
    }
    return true;
  }
}

registerProcessor('pasalo-voice', PasaloVoice);
