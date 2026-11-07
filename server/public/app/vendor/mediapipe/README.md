# MediaPipe (desenfoque del fondo en las videollamadas)

- `vision_bundle.mjs`, `vision_wasm_internal.js` y `vision_wasm_internal.wasm`:
  `@mediapipe/tasks-vision` 1.1.1 (Apache-2.0), solo la variante con SIMD.
- `selfie_segmenter.tflite`: modelo *Selfie Segmenter* (float16) de
  https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
  (Apache-2.0).

Van dentro de la app porque las llamadas también funcionan sin internet. Se
cargan solo la primera vez que alguien activa el desenfoque (`blur.js`).
