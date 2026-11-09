// Tema claro u oscuro. Script normal (no módulo) cargado en el <head> para
// poner `data-theme` antes de pintar y que no se vea un destello claro.
// Ajuste en localStorage: 'light', 'dark' o nada (el del sistema).
(() => {
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    let saved = null;
    try {
      saved = localStorage.getItem('theme');
    } catch {}
    const theme = saved === 'light' || saved === 'dark' ? saved : dark.matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
  };
  apply();
  dark.addEventListener('change', apply);
  // Lo llama Ajustes después de guardar el tema elegido.
  window.applyTheme = apply;
})();
