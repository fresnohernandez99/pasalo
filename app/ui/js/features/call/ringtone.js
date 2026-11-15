// Ringtone with WebAudio, without sound files.

let ctx = null;
let timer = null;

function beep() {
  try {
    ctx ||= new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
  } catch {}
}

export function startRinging() {
  stopRinging();
  beep();
  timer = setInterval(beep, 1500);
}

export function stopRinging() {
  clearInterval(timer);
  timer = null;
}
