// Avisos entre partes de la interfaz que no se importan entre sí
// (p. ej. el chat avisa de mensajes sin leer y la lista de equipos repinta).

const handlers = new Map();

export function on(name, fn) {
  if (!handlers.has(name)) handlers.set(name, new Set());
  handlers.get(name).add(fn);
}

export function emit(name, data) {
  for (const fn of handlers.get(name) || []) fn(data);
}
