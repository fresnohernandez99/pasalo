// Compresión de las fotos del chat antes de enviarlas: todas pasan por aquí.
// Se reducen (1600 px de lado largo, o lo que se pida), se vuelven a
// codificar (lo que además quita los metadatos: ubicación, modelo del
// teléfono…) y se queda el formato que menos ocupe de los que sepa este
// equipo: WebP si puede, si no JPEG.

const QUALITY = 0.8;
/** Lo que acepta el chat (`MAX_IMAGE` en talk.rs). */
const MAX_IMAGE = 25 * 1024 * 1024;
/** Formatos que cualquier equipo sabe enseñar: esos van tal cual. */
const AS_IS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/**
 * La foto sin comprimir, para los equipos de la misma red: el archivo tal
 * cual si es un formato que se ve en todas partes y cabe; si no (HEIC del
 * iPhone, p. ej.), recodificada casi sin pérdida y hasta 4096 px, que es lo
 * que aguanta un canvas en el iPhone.
 */
export async function originalImage(file) {
  const ext = AS_IS[file.type];
  if (!ext || file.size > MAX_IMAGE) return compressImage(file, 4096, 0.95);
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return { data: url.split(',')[1], ext, size: file.size };
}

/** `{ data (base64, sin cabecera), ext, size }` de la foto lista para enviar. */
export async function compressImage(file, long = 1600, quality = QUALITY) {
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
  const webp = canvas.toDataURL('image/webp', quality);
  const candidates = [];
  if (webp.startsWith('data:image/webp')) candidates.push({ url: webp, ext: 'webp' });
  for (const [type, ext] of options) candidates.push({ url: canvas.toDataURL(type, quality), ext });
  const best = candidates.sort((a, b) => a.url.length - b.url.length)[0];
  const data = best.url.split(',')[1];
  return { data, ext: best.ext, size: Math.floor((data.length * 3) / 4) };
}
