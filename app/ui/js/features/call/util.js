// Small helpers shared by the call modules.

// `Object.hasOwn` (Chrome 93) and `crypto.randomUUID` (Chrome 92) do not
// exist in the old WebViews of some Android phones.
export const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export const newId = () =>
  crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Releases a camera or microphone stream (a no-op for `null`). */
export function stopTracks(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}
