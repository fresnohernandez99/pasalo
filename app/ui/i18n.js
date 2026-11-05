// Traducciones de la interfaz. Las claves de `error.*` corresponden a los
// códigos que devuelve Rust (`CmdError` en la app y `Error::code` en el núcleo).

const LANGS = {
  en: {
    'lang.name': 'English',
    'platform.manual': 'Added manually',
    'platform.remote': 'Remote',
    'status.connecting': 'Connecting…',
    'status.retrying': 'Reconnecting…',
    'status.paused': 'Paused',
    'status.interrupted': 'Interrupted',
    'status.done': 'Done',
    'status.error': 'Error',
    'units.bytes': 'B KB MB GB TB',
    'dur.s': '{n} s',
    'dur.min': '{m} min {s} s',
    'dur.h': '{h} h {m} min',
    'label.more': '{first} and {n} more',
    'me.sub': 'IP {ips} · port {port}',
    'me.no_network': 'no network',
    'me.name_title': 'Your name on the network (press Enter to save it)',
    'me.remote_code': 'Remote code:',
    'me.code_title': 'Give it to anyone who wants to send you something from another network',
    'dir.caption': 'Received in',
    'dir.open_title': 'Open {dir}',
    'dir.change': 'Change',
    'peers.title': 'Devices',
    'peers.search': 'Search',
    'peers.empty': 'Looking for devices on the network…',
    'peers.empty_hint': 'Open Pasalo on another device on the same network, or add one from another network with its code.',
    'peers.add_placeholder': 'Add by IP or remote code',
    'peers.add': 'Add',
    'peers.hint': 'Drag files or folders onto a device to send them.',
    'btn.files': 'Files',
    'btn.folder': 'Folder',
    'btn.text': 'Text',
    'btn.remove': 'Remove',
    'btn.copy': 'Copy',
    'btn.pause': 'Pause',
    'btn.resume': 'Resume',
    'btn.reveal': 'Show',
    'btn.cancel': 'Cancel',
    'btn.send': 'Send',
    'activity.title': 'Activity',
    'activity.clear': 'Clear finished',
    'activity.empty': 'Transfers, received files and texts will show up here.',
    'item.text_from': 'Text from {name}',
    'item.receiving': 'Receiving…',
    'item.sending': 'Sending…',
    'meta.from': 'from {peer}',
    'meta.to': 'to {peer}',
    'meta.progress': '{done} of {total}',
    'meta.left': '{eta} left',
    'meta.resumed': 'resumed from {size}',
    'meta.will_resume': '{error}. It will resume when the sender sends it again.',
    'text.title': 'Send text to',
    'text.placeholder': 'Type or paste here',
    'toast.searching': 'Looking for devices…',
    'toast.own_code': 'That is your own code',
    'toast.connecting_remote': 'Connecting to the remote device…',
    'toast.added': '{name} added',
    'toast.text_sent': 'Text sent to {name}',
    'toast.drop_on_peer': 'Drop the files on a device',
    'toast.copied': 'Copied',
    'toast.code_copied': 'Code copied: give it to whoever is going to send you something',
    'toast.received': 'Received {name} from {peer}',
    'toast.text_received': 'Text received from {name}',
    'toast.name_updated': 'Name updated',
    'error.invalid_target': '"{detail}" is not a valid IP address or device code',
    'error.remote_unavailable': 'Remote connections are not available: restart Pasalo with an internet connection',
    'error.empty_name': 'The name cannot be empty',
    'error.mobile_files_only': 'On mobile you can only pick files',
    'error.nothing_to_send': 'There is nothing to send',
    'error.connect_failed': 'Could not connect',
    'error.pick_failed': 'Could not read the file',
    'error.io': 'Connection error',
    'error.local': 'Error reading local files',
    'error.timeout': 'Timed out',
    'error.protocol': 'Protocol error',
    'error.rejected': 'The receiver rejected the transfer',
    'error.remote': 'The receiver reported an error',
    'error.superseded': 'Replaced by a newer connection',
  },

  es: {
    'lang.name': 'Español',
    'platform.manual': 'Añadido a mano',
    'platform.remote': 'Remoto',
    'status.connecting': 'Conectando…',
    'status.retrying': 'Reconectando…',
    'status.paused': 'En pausa',
    'status.interrupted': 'Interrumpida',
    'status.done': 'Completado',
    'status.error': 'Error',
    'units.bytes': 'B KB MB GB TB',
    'dur.s': '{n} s',
    'dur.min': '{m} min {s} s',
    'dur.h': '{h} h {m} min',
    'label.more': '{first} y {n} más',
    'me.sub': 'IP {ips} · puerto {port}',
    'me.no_network': 'sin red',
    'me.name_title': 'Tu nombre en la red (pulsa Intro para guardarlo)',
    'me.remote_code': 'Código remoto:',
    'me.code_title': 'Pásaselo a quien te quiera enviar desde otra red',
    'dir.caption': 'Recibidos en',
    'dir.open_title': 'Abrir {dir}',
    'dir.change': 'Cambiar',
    'peers.title': 'Equipos',
    'peers.search': 'Buscar',
    'peers.empty': 'Buscando equipos en la red…',
    'peers.empty_hint': 'Abre Pasalo en otro equipo conectado a la misma red, o añade uno de otra red con su código.',
    'peers.add_placeholder': 'Añadir por IP o código remoto',
    'peers.add': 'Añadir',
    'peers.hint': 'Arrastra archivos o carpetas sobre un equipo para enviárselos.',
    'btn.files': 'Archivos',
    'btn.folder': 'Carpeta',
    'btn.text': 'Texto',
    'btn.remove': 'Quitar',
    'btn.copy': 'Copiar',
    'btn.pause': 'Pausar',
    'btn.resume': 'Reanudar',
    'btn.reveal': 'Mostrar',
    'btn.cancel': 'Cancelar',
    'btn.send': 'Enviar',
    'activity.title': 'Actividad',
    'activity.clear': 'Limpiar terminadas',
    'activity.empty': 'Aquí aparecerán los envíos, las recepciones y los textos.',
    'item.text_from': 'Texto de {name}',
    'item.receiving': 'Recibiendo…',
    'item.sending': 'Enviando…',
    'meta.from': 'de {peer}',
    'meta.to': 'a {peer}',
    'meta.progress': '{done} de {total}',
    'meta.left': 'quedan {eta}',
    'meta.resumed': 'reanudada desde {size}',
    'meta.will_resume': '{error}. Se reanudará cuando el emisor vuelva a enviarlo.',
    'text.title': 'Enviar texto a',
    'text.placeholder': 'Escribe o pega aquí',
    'toast.searching': 'Buscando equipos…',
    'toast.own_code': 'Ese es tu propio código',
    'toast.connecting_remote': 'Conectando con el equipo remoto…',
    'toast.added': 'Añadido {name}',
    'toast.text_sent': 'Texto enviado a {name}',
    'toast.drop_on_peer': 'Suelta los archivos encima de un equipo',
    'toast.copied': 'Copiado',
    'toast.code_copied': 'Código copiado: pásaselo a quien te vaya a enviar algo',
    'toast.received': 'Recibido {name} de {peer}',
    'toast.text_received': 'Texto recibido de {name}',
    'toast.name_updated': 'Nombre actualizado',
    'error.invalid_target': '"{detail}" no es una IP ni un código de equipo válido',
    'error.remote_unavailable': 'Las conexiones remotas no están disponibles: reinicia Pasalo con conexión a internet',
    'error.empty_name': 'El nombre no puede estar vacío',
    'error.mobile_files_only': 'En el móvil solo se pueden elegir archivos',
    'error.nothing_to_send': 'No hay nada que enviar',
    'error.connect_failed': 'No se pudo conectar',
    'error.pick_failed': 'No se pudo leer el archivo',
    'error.io': 'Error de conexión',
    'error.local': 'Error leyendo archivos locales',
    'error.timeout': 'Tiempo de espera agotado',
    'error.protocol': 'Error de protocolo',
    'error.rejected': 'El receptor rechazó la transferencia',
    'error.remote': 'El receptor informó un error',
    'error.superseded': 'Sustituida por una conexión más reciente',
  },

  ru: {
    'lang.name': 'Русский',
    'platform.manual': 'Добавлено вручную',
    'platform.remote': 'Удалённое',
    'status.connecting': 'Подключение…',
    'status.retrying': 'Переподключение…',
    'status.paused': 'Пауза',
    'status.interrupted': 'Прервано',
    'status.done': 'Готово',
    'status.error': 'Ошибка',
    'units.bytes': 'Б КБ МБ ГБ ТБ',
    'dur.s': '{n} с',
    'dur.min': '{m} мин {s} с',
    'dur.h': '{h} ч {m} мин',
    'label.more': '{first} и ещё {n}',
    'me.sub': 'IP {ips} · порт {port}',
    'me.no_network': 'нет сети',
    'me.name_title': 'Ваше имя в сети (нажмите Enter, чтобы сохранить)',
    'me.remote_code': 'Удалённый код:',
    'me.code_title': 'Передайте его тому, кто хочет отправить вам что-то из другой сети',
    'dir.caption': 'Сохраняется в',
    'dir.open_title': 'Открыть {dir}',
    'dir.change': 'Изменить',
    'peers.title': 'Устройства',
    'peers.search': 'Найти',
    'peers.empty': 'Поиск устройств в сети…',
    'peers.empty_hint': 'Откройте Pasalo на другом устройстве в той же сети или добавьте устройство из другой сети по его коду.',
    'peers.add_placeholder': 'Добавить по IP или удалённому коду',
    'peers.add': 'Добавить',
    'peers.hint': 'Перетащите файлы или папки на устройство, чтобы отправить их.',
    'btn.files': 'Файлы',
    'btn.folder': 'Папка',
    'btn.text': 'Текст',
    'btn.remove': 'Удалить',
    'btn.copy': 'Копировать',
    'btn.pause': 'Пауза',
    'btn.resume': 'Продолжить',
    'btn.reveal': 'Показать',
    'btn.cancel': 'Отмена',
    'btn.send': 'Отправить',
    'activity.title': 'Активность',
    'activity.clear': 'Очистить завершённые',
    'activity.empty': 'Здесь появятся отправки, полученные файлы и тексты.',
    'item.text_from': 'Текст от {name}',
    'item.receiving': 'Получение…',
    'item.sending': 'Отправка…',
    'meta.from': 'от {peer}',
    'meta.to': 'для {peer}',
    'meta.progress': '{done} из {total}',
    'meta.left': 'осталось {eta}',
    'meta.resumed': 'продолжено с {size}',
    'meta.will_resume': '{error}. Передача продолжится, когда отправитель отправит файлы снова.',
    'text.title': 'Отправить текст на',
    'text.placeholder': 'Введите или вставьте текст',
    'toast.searching': 'Поиск устройств…',
    'toast.own_code': 'Это ваш собственный код',
    'toast.connecting_remote': 'Подключение к удалённому устройству…',
    'toast.added': 'Добавлено: {name}',
    'toast.text_sent': 'Текст отправлен на {name}',
    'toast.drop_on_peer': 'Перетащите файлы на устройство',
    'toast.copied': 'Скопировано',
    'toast.code_copied': 'Код скопирован: передайте его тому, кто будет вам что-то отправлять',
    'toast.received': 'Получено {name} от {peer}',
    'toast.text_received': 'Получен текст от {name}',
    'toast.name_updated': 'Имя обновлено',
    'error.invalid_target': '«{detail}» — это не IP-адрес и не код устройства',
    'error.remote_unavailable': 'Удалённые подключения недоступны: перезапустите Pasalo при наличии интернета',
    'error.empty_name': 'Имя не может быть пустым',
    'error.mobile_files_only': 'На телефоне можно выбирать только файлы',
    'error.nothing_to_send': 'Нечего отправлять',
    'error.connect_failed': 'Не удалось подключиться',
    'error.pick_failed': 'Не удалось прочитать файл',
    'error.io': 'Ошибка соединения',
    'error.local': 'Ошибка чтения локальных файлов',
    'error.timeout': 'Время ожидания истекло',
    'error.protocol': 'Ошибка протокола',
    'error.rejected': 'Получатель отклонил передачу',
    'error.remote': 'Получатель сообщил об ошибке',
    'error.superseded': 'Заменено более новым подключением',
  },
};

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

function t(key, params = {}) {
  const text = LANGS[lang][key] ?? LANGS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '');
}

/** Texto de un error de Rust (`{ code, detail }`) o de cualquier otra cosa lanzada. */
function errorText(err) {
  if (err && typeof err === 'object' && 'code' in err) {
    if (err.code === 'other') return err.detail;
    const key = `error.${err.code}`;
    if (!LANGS.en[key]) return err.detail || err.code;
    const text = t(key, { detail: err.detail });
    // Si el detalle ya va dentro del mensaje no se repite.
    return err.detail && !LANGS.en[key].includes('{detail}') ? `${text}: ${err.detail}` : text;
  }
  return String(err);
}

/** Traduce el HTML fijo: `data-i18n` (texto), `data-i18n-placeholder` y `data-i18n-title`. */
function applyStatic() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}

function setLang(next) {
  if (!LANGS[next]) return;
  lang = next;
  try {
    localStorage.setItem('lang', next);
  } catch {}
  applyStatic();
}
