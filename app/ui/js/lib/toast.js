let timer;

export function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = isError ? 'toast error show' : 'toast show';
  el.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove('show'), isError ? 6000 : 3500);
}
