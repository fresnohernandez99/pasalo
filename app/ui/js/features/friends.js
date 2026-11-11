// Amigos: equipos de otra red que se guardan (por su código de iroh) para no
// tener que pasarse el enlace cada vez. Salen siempre en Descubrir y, al
// entrar ahí, el server dice cuáles están en línea (con el id de su sesión de
// ahora, para pedirles conectarse) u ocupados con su pareja.

import { emit } from '../lib/bus.js';

/** código → { code, name, os } */
export const friends = new Map();

const norm = (code) => (code || '').replace(/\s/g, '').toLowerCase();

function load() {
  try {
    for (const f of JSON.parse(localStorage.getItem('friends') || '[]')) if (f?.code) friends.set(norm(f.code), f);
  } catch {}
}

function save() {
  try {
    localStorage.setItem('friends', JSON.stringify([...friends.values()]));
  } catch {}
  emit('friends:changed');
}

export function friendOf(code) {
  return friends.get(norm(code)) || null;
}

export function addFriend({ code, name, os }) {
  const key = norm(code);
  if (!key) return;
  friends.set(key, { code: key, name: name || '', os: os || '' });
  save();
}

export function removeFriend(code) {
  if (friends.delete(norm(code))) save();
}

/** El server dice cómo se llama ahora: se pone al día. */
export function renameFriend(code, name, os) {
  const f = friendOf(code);
  if (!f || !name || (f.name === name && f.os === (os || f.os))) return;
  f.name = name;
  if (os) f.os = os;
  save();
}

load();
