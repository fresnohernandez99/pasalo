// Compresión de las fotos del chat antes de enviarlas: todas pasan por aquí.
// Se reducen (1600 px de lado largo, o lo que se pida), se vuelven a
// codificar (lo que además quita los metadatos: ubicación, modelo del
// teléfono…) y se queda el formato que menos ocupe de los que sepa este
// equipo: WebP si puede, si no JPEG.

const QUALITY = 0.8;

/** `{ data (base64, sin cabecera), ext, size }` de la foto lista para enviar. */
export async function compressImage(file, long = 1600) {
  // `from-image`: respeta la orientación de la cámara (EXIF) al dibujarla.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, long / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  // Sin transparencia (el JPEG la pintaría de negro).
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const options = [['image/jpeg', 'jpg']];
  // Safari viejo no codifica WebP y devuelve PNG (más grande): solo si sale WebP de verdad.
  const webp = canvas.toDataURL('image/webp', QUALITY);
  const candidates = [];
  if (webp.startsWith('data:image/webp')) candidates.push({ url: webp, ext: 'webp' });
  for (const [type, ext] of options) candidates.push({ url: canvas.toDataURL(type, QUALITY), ext });
  const best = candidates.sort((a, b) => a.url.length - b.url.length)[0];
  const data = best.url.split(',')[1];
  return { data, ext: best.ext, size: Math.floor((data.length * 3) / 4) };
}
