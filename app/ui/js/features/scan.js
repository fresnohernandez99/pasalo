// Scanning another device's QR to connect by its code — a PS4 shows one on its
// home screen, and a phone can show its own link as a QR too (see settings).
// The camera reads it, we pull the code out and hand it to the same connect
// flow a link uses (openLink).

import { t } from '../i18n/index.js';
import { $ } from '../lib/dom.js';
import { shortCode } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { openLink } from './lobby.js';

// jsQR is large, so it is only fetched the first time the scanner is opened.
let jsqrReady = null;
function loadJsqr() {
  if (jsqrReady) return jsqrReady;
  jsqrReady = new Promise((resolve, reject) => {
    if (window.jsQR) return resolve(window.jsQR);
    const script = document.createElement('script');
    script.src = 'vendor/jsqr.js';
    script.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('jsqr')));
    script.onerror = () => reject(new Error('jsqr'));
    document.head.appendChild(script);
  });
  return jsqrReady;
}

/**
 * The code held in a scanned QR: a raw iroh code, or a Pasalo link that carries
 * one. An iroh code is a long run of hex, so take that if it is there; failing
 * that, drop a `pasalo:` scheme and any path and use what is left.
 */
export function codeFromScan(text) {
  const value = (text || '').trim();
  const hex = value.match(/[0-9a-fA-F]{48,}/);
  if (hex) return hex[0].toLowerCase();
  const bare = value.replace(/^pasalo:\/*/i, '').replace(/^.*\//, '').trim();
  return bare || null;
}

let active = null;

function stop() {
  if (!active) return;
  cancelAnimationFrame(active.raf);
  active.stream.getTracks().forEach((track) => track.stop());
  active = null;
  $('#scan-overlay').hidden = true;
  document.body.classList.remove('scanning');
}

export async function openScanner() {
  if (active) return;
  const overlay = $('#scan-overlay');
  const video = $('#scan-video');
  const status = $('#scan-status');
  overlay.hidden = false;
  document.body.classList.add('scanning');
  status.textContent = t('scan.hint');

  let jsQR;
  let stream;
  try {
    jsQR = await loadJsqr();
    // The back camera: it is the one pointed at a TV or another phone.
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch {
    stop();
    toast(t('scan.denied'), true);
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  active = { stream, raf: 0 };

  const tick = () => {
    if (!active) return;
    if (video.readyState >= 2 && video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const found = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
      if (found && found.data) {
        const code = codeFromScan(found.data);
        if (code) {
          stop();
          toast(t('scan.found'));
          openLink({ code, name: shortCode(code) }, { ask: false });
          return;
        }
      }
    }
    active.raf = requestAnimationFrame(tick);
  };
  active.raf = requestAnimationFrame(tick);
}

$('#add-scan').addEventListener('click', () => {
  // The scan button lives in the "add a device" dialog: close it first so the
  // camera is not behind it.
  const add = document.getElementById('add-dialog');
  if (add?.open) add.close();
  openScanner();
});
$('#scan-close').addEventListener('click', stop);
