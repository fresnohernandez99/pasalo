// Estado que comparten varias partes de la interfaz.

export const app = {
  /** Lo que devuelve `snapshot` (nombre, carpeta, IPs, código…), al día. */
  settings: null,
};

export const isMobile = () => !!app.settings?.mobile;

/** Dos columnas (lista y chat a la vez) en pantallas anchas. */
export const isWide = () => matchMedia('(min-width: 860px)').matches;
