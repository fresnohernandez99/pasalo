// Fondo desenfocado en las videollamadas. Antes de comprimir cada imagen, un
// modelo (Selfie Segmenter de MediaPipe) separa a la persona del fondo; el
// fondo se dibuja desenfocado y la persona nítida encima. Un fondo sin
// detalle apenas gasta bits, así que también ahorra ancho de banda.
//
// El modelo y su motor (WebAssembly) van dentro de la app y solo se cargan la
// primera vez que alguien activa el desenfoque.

const BASE = '/vendor/mediapipe';
// Cuánto de la máscara anterior se mezcla con la nueva: menos parpadeo en el
// borde del pelo y los hombros.
const SMOOTH = 0.5;

let loading = null;

/** Carga el modelo (una sola vez). Primero en la GPU; si no se puede, en la CPU. */
export function loadSegmenter() {
  if (!loading) {
    loading = (async () => {
      const { ImageSegmenter } = await import('../../vendor/mediapipe/vision_bundle.mjs');
      const fileset = {
        wasmLoaderPath: `${BASE}/vision_wasm_internal.js`,
        wasmBinaryPath: `${BASE}/vision_wasm_internal.wasm`,
      };
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: `${BASE}/selfie_segmenter.tflite`, delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      try {
        return await ImageSegmenter.createFromOptions(fileset, options('GPU'));
      } catch (err) {
        console.warn('segmentación en GPU', err);
        return await ImageSegmenter.createFromOptions(fileset, options('CPU'));
      }
    })().catch((err) => {
      loading = null; // que se pueda volver a intentar
      throw err;
    });
  }
  return loading;
}

/** Aplica el desenfoque a las imágenes que el emisor ya dibujó en su canvas. */
export class BackgroundBlur {
  constructor(segmenter) {
    this.segmenter = segmenter;
    this.mask = null; // confianza suavizada, de 0 a 1, del tamaño de la máscara
    this.maskSize = null;
    this.maskCanvas = document.createElement('canvas');
    this.maskCtx = this.maskCanvas.getContext('2d');
    this.person = document.createElement('canvas');
    this.personCtx = this.person.getContext('2d');
    this.lastTs = 0;
  }

  /**
   * `ctx` ya tiene la imagen nítida a `width`×`height`; `source` es la cámara.
   * Al volver, `ctx` tiene el fondo desenfocado y la persona nítida.
   */
  apply(ctx, source, width, height) {
    // El modelo pide marcas de tiempo siempre crecientes.
    const ts = Math.max(performance.now(), this.lastTs + 1);
    this.lastTs = ts;
    this.segmenter.segmentForVideo(ctx.canvas, ts, (result) => {
      const mask = result.confidenceMasks?.[0];
      if (mask) this.blend(mask.getAsFloat32Array(), mask.width, mask.height);
    });
    if (!this.mask) return;

    if (this.person.width !== width || this.person.height !== height) {
      this.person.width = width;
      this.person.height = height;
    }
    // La persona: la imagen nítida recortada con la máscara, de borde suave.
    const p = this.personCtx;
    p.globalCompositeOperation = 'copy';
    p.drawImage(ctx.canvas, 0, 0);
    p.globalCompositeOperation = 'destination-in';
    p.filter = `blur(${Math.max(1, width / 200)}px)`;
    p.drawImage(this.maskCanvas, 0, 0, width, height);
    p.filter = 'none';
    p.globalCompositeOperation = 'source-over';

    // El fondo: la cámara desenfocada, un poco más grande para que el borde
    // del desenfoque no se oscurezca.
    const r = Math.max(4, Math.round(width / 40));
    ctx.filter = `blur(${r}px)`;
    ctx.drawImage(source, -r, -r, width + 2 * r, height + 2 * r);
    ctx.filter = 'none';
    ctx.drawImage(this.person, 0, 0);
  }

  blend(confidence, w, h) {
    if (!this.maskSize || this.maskSize.w !== w || this.maskSize.h !== h) {
      this.maskSize = { w, h };
      this.mask = Float32Array.from(confidence);
      this.maskCanvas.width = w;
      this.maskCanvas.height = h;
      this.pixels = this.maskCtx.createImageData(w, h);
    } else {
      for (let i = 0; i < confidence.length; i++) this.mask[i] = this.mask[i] * SMOOTH + confidence[i] * (1 - SMOOTH);
    }
    // Alfa con una rampa entre 0.3 y 0.7: lo dudoso, a medias.
    const data = this.pixels.data;
    for (let i = 0; i < this.mask.length; i++) {
      const a = Math.min(1, Math.max(0, (this.mask[i] - 0.3) / 0.4));
      data[i * 4 + 3] = a * 255;
    }
    this.maskCtx.putImageData(this.pixels, 0, 0);
  }
}
