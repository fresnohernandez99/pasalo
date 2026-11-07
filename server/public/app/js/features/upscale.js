// Mejora de la imagen que llega en las videollamadas, al estilo de AMD FSR 1:
// se agranda con un filtro bicúbico (Catmull-Rom) hasta el tamaño en
// pantalla y después se afila con CAS (Contrast Adaptive Sharpening), todo en
// la GPU con WebGL. No inventa detalle, pero 160 px estirados a pantalla
// completa se ven mucho más limpios que con el escalado del navegador.
//
// Si no hay WebGL, se pierde el contexto o la GPU no da abasto, quien lo usa
// vuelve a dibujar como siempre (canvas 2D).

// Lado largo máximo de lo que se dibuja: más allá no se nota y gasta GPU.
const MAX_LONG = 1280;
// Afilado de CAS: 0 suave, 1 fuerte.
const SHARPNESS = 0.6;

const VERTEX = `
attribute vec2 pos;
varying vec2 uv;
void main() {
  uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

// Catmull-Rom con 9 lecturas bilineales en vez de 16 puntuales.
const UPSCALE = `
precision mediump float;
uniform sampler2D src;
uniform vec2 size;
varying vec2 uv;
void main() {
  vec2 p = uv * size;
  vec2 c = floor(p - 0.5) + 0.5;
  vec2 f = p - c;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (c - 1.0) / size;
  vec2 t3 = (c + 2.0) / size;
  vec2 t12 = (c + w2 / w12) / size;
  vec3 r = vec3(0.0);
  r += texture2D(src, vec2(t0.x, t0.y)).rgb * w0.x * w0.y;
  r += texture2D(src, vec2(t12.x, t0.y)).rgb * w12.x * w0.y;
  r += texture2D(src, vec2(t3.x, t0.y)).rgb * w3.x * w0.y;
  r += texture2D(src, vec2(t0.x, t12.y)).rgb * w0.x * w12.y;
  r += texture2D(src, vec2(t12.x, t12.y)).rgb * w12.x * w12.y;
  r += texture2D(src, vec2(t3.x, t12.y)).rgb * w3.x * w12.y;
  r += texture2D(src, vec2(t0.x, t3.y)).rgb * w0.x * w3.y;
  r += texture2D(src, vec2(t12.x, t3.y)).rgb * w12.x * w3.y;
  r += texture2D(src, vec2(t3.x, t3.y)).rgb * w3.x * w3.y;
  gl_FragColor = vec4(clamp(r, 0.0, 1.0), 1.0);
}`;

// CAS de AMD en su versión de cruz: afila más donde hay poco contraste y
// menos en los bordes fuertes, para no crear halos.
const SHARPEN = `
precision mediump float;
uniform sampler2D src;
uniform vec2 texel;
uniform float peak;
varying vec2 uv;
void main() {
  vec3 b = texture2D(src, uv + vec2(0.0, -texel.y)).rgb;
  vec3 d = texture2D(src, uv + vec2(-texel.x, 0.0)).rgb;
  vec3 e = texture2D(src, uv).rgb;
  vec3 f = texture2D(src, uv + vec2(texel.x, 0.0)).rgb;
  vec3 h = texture2D(src, uv + vec2(0.0, texel.y)).rgb;
  vec3 mn = min(min(min(b, d), min(f, h)), e);
  vec3 mx = max(max(max(b, d), max(f, h)), e);
  vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
  vec3 w = amp * peak;
  vec3 r = (b * w + d * w + f * w + h * w + e) / (1.0 + 4.0 * w);
  gl_FragColor = vec4(clamp(r, 0.0, 1.0), 1.0);
}`;

export class Upscaler {
  /** `null` si aquí no hay WebGL que sirva. */
  static create(canvas) {
    let gl = null;
    try {
      gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: false });
    } catch {}
    if (!gl) return null;
    try {
      return new Upscaler(canvas, gl);
    } catch (err) {
      console.warn('upscaler', err);
      return null;
    }
  }

  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this.lost = true;
    });
    // En WebGL la «y» va hacia arriba: la imagen se sube dada la vuelta.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.upscale = this.program(UPSCALE);
    this.sharpen = this.program(SHARPEN);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.source = this.texture();
    this.middle = this.texture();
    this.fbo = gl.createFramebuffer();
    this.middleSize = null;
  }

  program(fragment) {
    const gl = this.gl;
    const shader = (type, text) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, text);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  texture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Tamaño de salida: lo que ocupa en pantalla (sin pasarse), nunca menos que la imagen. */
  outputSize(w, h) {
    const dpr = window.devicePixelRatio || 1;
    const box = this.canvas.getBoundingClientRect();
    const fit = Math.min((box.width * dpr) / w, (box.height * dpr) / h) || 1;
    const cap = MAX_LONG / Math.max(w, h);
    const scale = Math.max(1, Math.min(fit, cap));
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
  }

  /** Dibuja la imagen agrandada y afilada. `false` si el contexto se perdió. */
  draw(frame) {
    if (this.lost || this.gl.isContextLost()) return false;
    const gl = this.gl;
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    const out = this.outputSize(w, h);
    if (this.canvas.width !== out.width || this.canvas.height !== out.height) {
      this.canvas.width = out.width;
      this.canvas.height = out.height;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.source);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);

    if (!this.middleSize || this.middleSize.width !== out.width || this.middleSize.height !== out.height) {
      gl.bindTexture(gl.TEXTURE_2D, this.middle);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, out.width, out.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.middle, 0);
      this.middleSize = out;
    }

    // 1. Agrandar a la textura intermedia.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, out.width, out.height);
    this.run(this.upscale, this.source, (p) => gl.uniform2f(gl.getUniformLocation(p, 'size'), w, h));

    // 2. Afilar al canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, out.width, out.height);
    this.run(this.sharpen, this.middle, (p) => {
      gl.uniform2f(gl.getUniformLocation(p, 'texel'), 1 / out.width, 1 / out.height);
      gl.uniform1f(gl.getUniformLocation(p, 'peak'), -1 / (8 - 3 * SHARPNESS));
    });
    return true;
  }

  run(program, texture, uniforms) {
    const gl = this.gl;
    gl.useProgram(program);
    const pos = gl.getAttribLocation(program, 'pos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(program, 'src'), 0);
    uniforms(program);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Espera a que la GPU acabe (solo para medir al principio). */
  finish() {
    this.gl.finish();
  }
}
