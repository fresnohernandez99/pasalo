// Avisos de abajo, uno detrás de otro. Antes cada uno pisaba al anterior y
// un error podía desaparecer al momento tapado por un aviso cualquiera.

const queue = [];
let current = null;
let timer;

/** Los que esperan su turno: más allá, los viejos sobran. */
const MAX_QUEUED = 3;
/** Lo mínimo que se ve un aviso antes de dejar paso al siguiente. */
const MIN_MS = 1500;

export function toast(message, isError = false) {
  // El mismo texto otra vez (p. ej. un error que se repite) no se encola.
  if (current?.message === message || queue.some((q) => q.message === message)) return;
  queue.push({ message, isError, at: 0 });
  // Si se acumulan, se descarta el aviso normal más viejo (los errores se quedan).
  while (queue.length > MAX_QUEUED) {
    const normal = queue.findIndex((q) => !q.isError);
    queue.splice(normal >= 0 ? normal : 0, 1);
  }
  if (!current) {
    next();
  } else if (!current.isError) {
    // Un aviso normal deja paso pronto: a los MIN_MS de haber salido.
    clearTimeout(timer);
    timer = setTimeout(next, Math.max(0, MIN_MS - (performance.now() - current.at)));
  }
}

function next() {
  const el = document.getElementById('toast');
  clearTimeout(timer);
  current = queue.shift() || null;
  if (!current) {
    el.classList.remove('show');
    return;
  }
  current.at = performance.now();
  el.textContent = current.message;
  el.className = current.isError ? 'toast error show' : 'toast show';
  el.hidden = false;
  timer = setTimeout(next, current.isError ? 6000 : 3500);
}
