// Traducciones de la interfaz. Las claves de `error.*` corresponden a los
// códigos que devuelve Rust (`CmdError` en la app y `Error::code` en el núcleo).

import en from './en.js';
import es from './es.js';
import ru from './ru.js';

export const LANGS = { en, es, ru };

function pickLang() {
  try {
    const saved = localStorage.getItem('lang');
    if (saved && LANGS[saved]) return saved;
  } catch {}
  for (const tag of navigator.languages || [navigator.language || 'en']) {
    const base = tag.toLowerCase().split('-')[0];
    if (LANGS[base]) return base;
  }
  return 'en';
}

let lang = pickLang();

export const currentLang = () => lang;

export function t(key, params = {}) {
  const text = LANGS[lang][key] ?? LANGS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '');
}

/** Texto de un error de Rust (`{ code, detail }`) o de cualquier otra cosa lanzada. */
export function errorText(err) {
  if (err && typeof err === 'object' && 'code' in err) {
    if (err.code === 'other') return err.detail;
    const key = `error.${err.code}`;
    if (!LANGS.en[key]) return err.detail || err.code;
    const text = t(key, { detail: err.detail });
    // Si el detalle ya va dentro del mensaje no se repite.
    return err.detail && !LANGS.en[key].includes('{detail}') ? `${text}: ${err.detail}` : text;
  }
  return String(err?.message || err);
}

/** Traduce el HTML fijo: `data-i18n` (texto), `data-i18n-placeholder` y `data-i18n-title`. */
export function applyStatic(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  }
}

export function setLang(next) {
  if (!LANGS[next]) return;
  lang = next;
  try {
    localStorage.setItem('lang', next);
  } catch {}
  applyStatic();
}
