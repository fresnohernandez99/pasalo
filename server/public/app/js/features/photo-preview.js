// Vista previa de las fotos antes de enviarlas, como en WhatsApp: se ve la
// foto tal como saldrá (ya comprimida, con lo que ocupa) y, con el botón «1»,
// se marca para verse una sola vez. Con varias fotos, cada una lleva lo suyo.

import { errorText, t } from '../i18n/index.js';
import { $, esc, setHtml } from '../lib/dom.js';
import { bytes } from '../lib/format.js';
import { compressImage } from '../lib/images.js';
import { toast } from '../lib/toast.js';
import { onBack, updateLayers } from './nav.js';

let items = []; // { data, ext, size, url, once }
let current = 0;
let sending = null; // ({ data, ext, once }) => Promise
let job = 0;

/** Abre la vista previa de `files`. `send` se llama con cada foto al enviar. */
export async function openPhotoPreview(files, send) {
  const mine = ++job;
  sending = send;
  items = [];
  current = 0;
  $('#photo-preview').hidden = false;
  $('#photo-preview').classList.add('loading');
  $('#pp-info').textContent = t('preview.preparing');
  $('#pp-send').disabled = true;
  updateLayers($('#pp-send'));
  for (const file of files) {
    try {
      const photo = await compressImage(file);
      if (mine !== job) return;
      items.push({ ...photo, url: `data:image/${photo.ext === 'jpg' ? 'jpeg' : photo.ext};base64,${photo.data}`, once: false });
    } catch (err) {
      toast(errorText(err), true);
    }
  }
  if (mine !== job) return;
  if (!items.length) {
    closePhotoPreview();
    return;
  }
  $('#photo-preview').classList.remove('loading');
  $('#pp-send').disabled = false;
  render();
}

export function closePhotoPreview() {
  if ($('#photo-preview').hidden) return false;
  job++;
  items = [];
  $('#pp-img').removeAttribute('src');
  setHtml($('#pp-thumbs'), '');
  $('#photo-preview').hidden = true;
  updateLayers();
  return true;
}

function render() {
  const item = items[current];
  if (!item) return;
  $('#pp-img').src = item.url;
  const once = $('#pp-once');
  once.classList.toggle('on', item.once);
  once.setAttribute('aria-pressed', String(item.once));
  once.title = t(item.once ? 'preview.once_on' : 'preview.once');
  once.setAttribute('aria-label', once.title);
  const total = items.reduce((n, i) => n + i.size, 0);
  const size = items.length > 1 ? t('preview.size_many', { size: bytes(total), n: items.length }) : t('preview.size', { size: bytes(item.size) });
  $('#pp-info').textContent = item.once ? `${t('preview.once_on')} · ${size}` : size;
  $('#pp-count').textContent = items.length > 1 ? `${current + 1} / ${items.length}` : '';
  setHtml(
    $('#pp-thumbs'),
    items.length > 1
      ? items
          .map(
            (i, n) =>
              `<button type="button" class="pp-thumb${n === current ? ' on' : ''}${i.once ? ' once' : ''}" data-n="${n}"><img src="${esc(i.url)}" alt=""></button>`,
          )
          .join('')
      : '',
  );
}

async function sendAll() {
  if (!items.length || !sending) return;
  const list = items;
  const send = sending;
  closePhotoPreview();
  for (const { data, ext, once } of list) await send({ data, ext, once });
}

$('#pp-close').addEventListener('click', closePhotoPreview);
$('#pp-send').addEventListener('click', sendAll);
$('#pp-once').addEventListener('click', () => {
  const item = items[current];
  if (!item) return;
  item.once = !item.once;
  render();
});
$('#pp-thumbs').addEventListener('click', (ev) => {
  const thumb = ev.target.closest('[data-n]');
  if (!thumb) return;
  current = Number(thumb.dataset.n);
  render();
});
$('#photo-preview').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !$('#pp-send').disabled) {
    ev.preventDefault();
    sendAll();
  }
});

onBack(closePhotoPreview);
