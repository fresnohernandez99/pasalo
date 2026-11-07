# Pasalo web

Pasalo en el navegador, pensado sobre todo para el iPhone (no hay app de iOS). Se sirve desde el mismo despliegue de Vercel que el server de conexión, en **`/app/`** (`https://pasalo-server.vercel.app/app/`), y se puede añadir a la pantalla de inicio como una app (PWA).

Habla el mismo protocolo que las apps: se conecta con ellas (y con otros navegadores) por el server o por enlace, y tiene chat con fotos, llamadas de voz y vídeo y envío y recepción de archivos que se pueden reanudar.

## Cómo está hecho

- **`src/lib.rs`** (Rust → WASM): lo que tiene que ir en Rust. iroh (conexiones, streams y datagramas), el códec de voz de `pasalo-call` (Opus y Codec2) y BLAKE3. En el navegador iroh no tiene UDP: todo va por los relays de n0 por WebSocket, y los códigos se publican y se buscan con pkarr por HTTPS.
- **`js/backend/`**: los protocolos en JavaScript, iguales que los del núcleo en Rust: `files.js` (`protocol.rs`, `sender.rs`, `receiver.rs`), `talk.js` (`talk.rs`), `lobby.js` (`lobby.rs`) e `index.js`, con los mismos comandos y eventos que la app de Tauri (`app/src-tauri/src/`).
- **`js/tauri.js`**: sustituye a `app/ui/js/lib/tauri.js`. Así la interfaz de la app (`app/ui/`) funciona sin cambios.
- **`js/web-ui.js`** y **`static/`**: lo propio de la web: guardar lo recibido, el aviso para instalarla en el iPhone, arrastrar y soltar, el desbloqueo del audio de iOS, el service worker y el manifiesto.

Lo que se guarda (identidad, ajustes, historial del chat, fotos y lo recibido a medias) va en IndexedDB.

## Diferencias con las apps

- **Sin red local**: el navegador no puede usar UDP ni TCP, así que no ve los equipos de la LAN. Todo va por internet (por los relays de iroh), con el server o con enlaces, también entre dos equipos de la misma red.
- **Lo recibido** no va a una carpeta: aparece en «Recibido» con **Guardar**, que en el iPhone abre el menú de compartir (Guardar en Archivos, en Fotos…).
- **No se comprime** (no anuncia `zstd`); las apps le envían los datos en crudo y él a ellas también.
- **Solo funciona con la página abierta y delante.** iOS congela las páginas en segundo plano: al bloquear el teléfono o cambiar de app se paran las transferencias y las llamadas (siguen al volver, si el otro lado no colgó). Durante las llamadas se pide que la pantalla no se apague.
- **En el iPhone, instálala** (Compartir → Añadir a pantalla de inicio): si no, Safari puede borrar lo guardado tras unos días sin usarla. La app de la pantalla de inicio y Safari no comparten datos: son dos equipos distintos para Pasalo. Los enlaces se abren en Safari; para usarlos en la instalada, cópialos y pégalos con **+**.
- No se puede elegir entre altavoz y auricular; el navegador decide.

## Compilar

Hace falta, una vez:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version <la de wasm-bindgen en web/Cargo.lock> --locked
brew install llvm   # ring necesita un clang con soporte de WASM; el de Apple no lo trae
```

Y luego, desde la raíz:

```sh
web/build.sh
```

Deja todo en `server/public/app/`: copia `app/ui/`, pone encima lo de `web/` y el WASM, y escribe la lista de archivos del service worker con un hash del build (así los navegadores se actualizan solos). Si está `wasm-opt` (binaryen), también reduce el WASM.

**El resultado se sube al repositorio**: Vercel solo sirve `server/` y no compila Rust. Al hacer push a `main`, Vercel lo publica. Hay que volver a compilar cuando cambie `web/` o la interfaz (`app/ui/`).

El crate no es parte del workspace (`exclude` en el `Cargo.toml` de la raíz): tiene su propio `Cargo.lock` y su `target/`.

## Probar en local

```sh
cd server && npm run dev   # http://localhost:3000/app/ y el server en /api/
```

En ⚙ Ajustes, pon `http://localhost:3000` como server. Para tener dos equipos en el mismo navegador, abre uno en `localhost` y otro en `127.0.0.1`: son orígenes distintos y cada uno tiene su identidad. El CLI también sirve de otro lado: `pasalo listen --server http://localhost:3000 --yes --answer`.

El service worker guarda la app: si al probar no ves un cambio, recarga sin caché o quítalo desde las herramientas del navegador.
