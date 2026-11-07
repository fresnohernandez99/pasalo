import { currentLang, t } from '../i18n/index.js';

export function bytes(n) {
  const units = t('units.bytes').split(' ');
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export function duration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return t('dur.s', { n: Math.ceil(seconds) });
  if (seconds < 3600) return t('dur.min', { m: Math.floor(seconds / 60), s: Math.ceil(seconds % 60) });
  return t('dur.h', { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) });
}

export function initials(name) {
  return (name || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

export function shortCode(code) {
  return `${code.slice(0, 6)}…${code.slice(-4)}`;
}

export function basename(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** «informe.pdf» o «informe.pdf y 3 más». */
export function label(names) {
  return names.length > 1 ? t('label.more', { first: names[0], n: names.length - 1 }) : names[0] || '';
}

export function clock(ts) {
  return new Date(ts).toLocaleTimeString(currentLang(), { hour: '2-digit', minute: '2-digit' });
}

/** «Hoy», «Ayer» o la fecha, para separar los días en el chat. */
export function dayLabel(ts) {
  const day = new Date(ts);
  const today = new Date();
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(today) - start(day)) / 86_400_000);
  if (diff === 0) return t('chat.today');
  if (diff === 1) return t('chat.yesterday');
  const sameYear = day.getFullYear() === today.getFullYear();
  return day.toLocaleDateString(currentLang(), { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
}

export const dayKey = (ts) => new Date(ts).toDateString();
