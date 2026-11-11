// An outdated WebView (old Android without updates) can't parse the app's
// modules and would show a broken page. main.js sets `pasaloStarted` as soon
// as it runs; if it hasn't after a while, this says what to update.
// Written in old syntax on purpose: it has to run where the rest doesn't.
(function () {
  var TEXT = {
    es: 'Pasalo necesita una versión más nueva de «Android System WebView» (o de Chrome). Actualízala en Google Play y vuelve a abrir la app.',
    ru: 'Pasalo нужна более новая версия «Android System WebView» (или Chrome). Обновите её в Google Play и откройте приложение снова.',
    en: 'Pasalo needs a newer "Android System WebView" (or Chrome). Update it on Google Play and open the app again.'
  };
  setTimeout(function () {
    if (window.pasaloStarted) return;
    var text = TEXT[(navigator.language || 'en').slice(0, 2)] || TEXT.en;
    var box = document.createElement('div');
    box.setAttribute('style', 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;background:#f3f5f9;color:#111;font:17px/1.45 sans-serif;text-align:center');
    box.textContent = text;
    document.body.appendChild(box);
  }, 6000);
})();
