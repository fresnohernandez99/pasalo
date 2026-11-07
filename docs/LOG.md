# Bitácora: chat, llamadas y videollamadas

Rama `chat-llamadas`. Cada entrada: qué se hizo, cómo se probó y qué queda.

## Objetivo

1. Chat de texto e imágenes entre dos equipos, cifrado de punto a punto, usando
   el código de iroh que ya tiene cada equipo. Sin servidor propio; también en
   la LAN sin internet.
2. Llamadas de voz hechas en Rust (sin WebRTC), sobre datagramas de iroh, con
   modos de muy bajo consumo para mala señal.
3. Videollamadas con WebRTC en la interfaz: señalización por iroh, STUN de
   Google por defecto y TURN opcional configurable.

## Diseño

- **Un canal "talk" por pareja de equipos**: conexión iroh con ALPN
  `pasalo/talk/1`. Los mensajes (chat y señalización de llamadas) van cada uno
  en un stream bidireccional con acuse de recibo; la voz va en datagramas
  QUIC (no fiables: un paquete perdido no se reenvía, no añade retraso).
- **Cifrado**: iroh usa QUIC/TLS 1.3 con la clave de cada equipo; el código
  que se comparten es la clave pública, así que la conexión queda autenticada
  de punto a punto. Los relays solo ven tráfico cifrado.
- **LAN sin internet**: el anuncio de descubrimiento incluye el código y el
  puerto UDP de iroh, y el canal talk se abre directo a esa IP:puerto.
- **Voz** (crate `pasalo-call`): micrófono → remuestreo a 8/16 kHz → Opus
  (`unsafe-libopus`, sin C) o Codec2 → paquetes con varios frames por
  datagrama para ahorrar cabeceras → buffer de reproducción → altavoz.
- **Vídeo**: `RTCPeerConnection` en el WebView; la oferta/respuesta SDP y los
  candidatos ICE viajan por el canal talk.

## Entradas

### 2026-11-04 — Arranque
- `main` subido a GitHub (repo vacío, público). Sin etiqueta de release.
- Creada la rama `chat-llamadas`.
- Comprobado: iroh 1.4 tiene `send_datagram`/`read_datagram` y
  `Connection::alpn()` para repartir conexiones por protocolo.
- Codec2 en Rust puro (`codec2` 0.3.1): según su documentación solo están
  implementados de verdad 3200 y 2400 bps. Por comprobar los modos más bajos.

### Núcleo del chat (`pasalo-core/src/talk.rs`)
- Canal `pasalo/talk/1` sobre iroh. Una conexión por pareja, reutilizada en
  los dos sentidos; cada mensaje en su stream con acuse (`Ack`).
- Mensajes de texto e imagen (hasta 25 MB), historial en `<dir>/<código>.jsonl`
  (añadir líneas; gana la última por id) e imágenes en `<dir>/media/`.
- Estados: `pending` → `delivered` (el otro confirmó) / `received`.
  Los pendientes se reintentan cada 20 s y cuando cambia la dirección del
  equipo; el receptor descarta repetidos por id.
- Señales de llamada (`Signal { call, kind, data }`): el núcleo solo las
  transporta; la interfaz decide qué significan.
- Voz: `Talk::voice(peer)` da un `VoiceLink` con datagramas de esa conexión.
- El descubrimiento LAN anuncia `code` y `remote_port` (campos opcionales, los
  equipos viejos los ignoran) para conectar por iroh directo sin internet.
- **Pruebas** (`tests/talk.rs`, sin internet, dos equipos por 127.0.0.1):
  texto + imagen de 300 KB con acuse, mensaje pendiente que llega cuando el
  otro equipo vuelve con la misma clave en otro puerto, señales y datagramas.
- **Fallo encontrado por las pruebas y corregido**: un reintento se ignoraba
  si el intento anterior seguía colgado contra la dirección vieja (hasta 30 s).
  Ahora el intento viejo se cancela y empieza uno nuevo (1 s en vez de >20 s).

### Voz en Rust (`crates/pasalo-call`)
- Códecs: Opus vía `unsafe-libopus` (libopus traducida a Rust, sin C: compila
  igual para Android) y Codec2 1300 bps en Rust puro.
- Paquete: `[modo][seq][n][frames]`; durante el silencio no se envía nada
  (detector de voz con umbral adaptativo y 400 ms de cola).
- Modos baja y mínima: cada paquete lleva también los frames del anterior,
  así una pérdida suelta se recupera entera.
- Búfer de reproducción: al menos 2 paquetes antes de sonar; si la otra
  persona deja de hablar, suena lo que quede sin esperar a la frase siguiente.
- Supresión de eco sencilla: mientras suena la otra persona, solo cuenta como
  voz lo que sea claramente más fuerte que su eco.
- **Mediciones** con 13,8 s de voz en español (`say`, voz Eddy MX), ejemplo
  `cargo run --release -p pasalo-call --example muestras`. "Red" incluye ~60
  bytes de IP/UDP/QUIC por paquete:

  | Modo | Paquete | Voz | Red | Pérdidas 10 % | Pérdidas 20 % |
  |---|---|---|---|---|---|
  | alta (Opus 24k) | 20 ms | 22,0 kbps | 45,5 kbps | relleno | relleno |
  | normal (Opus 12k) | 40 ms | 11,4 kbps | 23,2 kbps | relleno | relleno |
  | baja (Opus 6k NB + copia) | 120 ms | 10,8 kbps | 14,7 kbps | 10/10 recuperados | 15/22 |
  | mínima (Codec2 1300 + copia) | 160 ms | 3,0 kbps | **6,0 kbps** | 8/8 recuperados | 13/15 |

- Retraso añadido por el búfer: ~60-80 ms (alta, normal), ~360 ms (baja),
  ~440 ms (mínima). Es el precio de meter mucho audio por paquete.
- **Fallo encontrado**: el PLC de `unsafe-libopus` satura (picos de 32767) y
  deja mal los frames siguientes. Reproducido en una prueba unitaria con un
  tono; con voz, 10 % de pérdidas daba 3,2× la energía de entrada. Se usa un
  relleno propio (repetir el último frame a media voz) y la prueba queda.
- Muestras para escuchar (fuera de git): `dist/muestras/<modo>-perdida<N>.wav`
  y `original.wav`.

### Integración en la app y el CLI
- App: comandos `chat_*`, `call_signal`, `voice_*`; el estado guarda el chat
  y la llamada; las direcciones LAN del descubrimiento se pasan al chat.
  Interfaz en `app/ui/talk.js`: chat con imágenes (se reducen a 1600 px JPEG
  antes de enviarse), llamadas entrantes/salientes con timbre, selector de
  modo (se aplica en los dos sentidos), silencio, altavoz (Android) y
  estadísticas; videollamadas con WebRTC (STUN de Google, TURN opcional en
  Ajustes, calidad baja/normal/alta limitando bitrate, resolución y fps).
- Android: permisos `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `CAMERA`; el
  plugin pide el micrófono y pone el modo de llamada (auricular y procesado
  de voz del sistema). macOS: `Info.plist` con los textos de micrófono y cámara.
- CLI: `pasalo chat`, `pasalo call` y `pasalo listen --answer` para probar
  con archivos de audio (sin micrófono).
- **Prueba CLI ⇄ CLI por iroh directo en la LAN**: mensaje + imagen de 120 KB
  entregados e idénticos; llamada contestada sola, 0 pérdidas.
- **Consumo medido** con los contadores UDP de la conexión (incluye ACKs de
  QUIC), los dos lados hablando sin parar a la vez (peor caso):

  | Modo | Medido | Estimado |
  |---|---|---|
  | alta | ~57 kbps | ~45 |
  | normal | ~35 kbps | ~23 |
  | baja | ~19 kbps | ~15 |
  | mínima | ~9 kbps | ~6 |

  Abrir la conexión cuesta ~30 KB una vez (TLS y sondeo de rutas); en
  silencio, la conexión gasta ~0,2 kbps.
- **Aprendido midiendo**: la supresión de eco recortaba la voz cuando los dos
  hablan a la vez (es su función con altavoz). Ahora se puede desactivar; el
  CLI la desactiva porque trabaja con archivos.

### Pruebas en Android (emulador) contra el CLI de la Mac
- El Pixel 6 se desconectó, así que se usó un emulador **nuevo** (`PasaloTest`,
  Android 16, x86_64) para no tocar los AVD del usuario (uno estaba lleno).
  Con el micrófono del host el emulador se colgaba al abrir el audio (corre
  como root y sin ventana); se configuró `hw.audioInput = no` (micro mudo).
- El emulador está detrás de su NAT y no ve la LAN de la Mac: todo fue por
  iroh **entre redes** (código remoto, relay/hole punching).
- **Funciona**: añadir contacto por código; chat emulador → Mac (✓ entregado)
  y Mac → emulador; historial persistente; llamada de voz saliente (la Mac
  contesta sola): ~23 kbps medidos en normal, cambio a mínima en caliente →
  la Mac lo adopta y baja a ~6 kbps; colgar desde el móvil; llamada entrante
  (timbre, contestar, ~15 kbps medidos en baja) y colgar desde la Mac.
- **Fallos encontrados y corregidos**:
  1. `let call` en `talk.js` chocaba con la función global `call()` de
     `main.js` → `talk.js` no cargaba (chat, contactos y "Añadir" rotos sin
     aviso). Renombrado a `live`.
  2. `main.js` pintaba la lista antes de cargar `talk.js` → arranque en
     `DOMContentLoaded`.
  3. La pantalla de llamada salía al abrir la app: el CSS `display:flex`
     ganaba al atributo `hidden` → regla global `[hidden]{display:none!important}`.
  4. Teclado: con Android 15+ la página se dibuja bajo el teclado y la barra
     de navegación; el plugin pasa `--kb`/`--nav` a CSS (escuchando los insets
     en el contenedor, no en el WebView, para no pisar el margen de Tauri).
  5. AAudio exige Android 8 (API 26): `minSdk` 24 → 26.
  6. Las estadísticas de la llamada anterior se quedaban; ahora la app muestra
     el consumo medido (UDP) y no el estimado.
- Errores de JavaScript ahora salen como aviso en pantalla (`JS: …`).

### Videollamadas (WebRTC) entre dos emuladores
- Segundo emulador de prueba (`PasaloTest2`). Para depurar se activó a
  ratos la depuración remota del WebView y se manejó la app por el
  protocolo de DevTools desde la Mac (no queda en el código).
- **Fallo encontrado**: la cola de candidatos ICE se vaciaba al encender la
  cámara y se perdían los que llegaban antes. Corregido.
- **Problema del entorno, no de Pasalo**: la wifi virtual que comparten los
  emuladores ("netsim") pierde los paquetes UDP grandes; una señal de 6 KB
  (la oferta SDP) se quedaba atascada y bloqueaba la conexión. Descartado que
  fuese la MTU (con QUIC fijo en 1200 bytes seguía igual). La misma señal
  emulador → Mac por la red real llega bien. Con el segundo emulador aislado
  (`-feature -WiFiPacketStream`), los dos hablan como redes distintas.
- **Funciona** entre redes: llamada, contestar, WebRTC `connected` en los dos
  lados, vídeo remoto de 480 px, colgar se propaga. La calidad se aplica en
  caliente (límite 1500 kbps en alta y 150 kbps en baja, más 24 kbps de
  audio). Consumo medido ~100-145 kbps: la cámara emulada es casi una imagen
  fija y el codificador por software no llega a los límites.
- **Imagen por el chat**: una foto de 3000×2000 (365 KB) se reduce a
  1600×1067 JPEG (51 KB), se entrega (✓), el otro lado la abre y le cuenta
  como no leído.
- Prueba nueva del núcleo: una ráfaga de 12 señales (una de 6 KB) llega entera.

### Qué no se ha probado
- Teléfono real con micrófono de verdad (el Pixel se desconectó) y el
  modo de llamada/eco de Android en la práctica.
- La app de escritorio con micrófono y cámara (no se puede manejar ni dar
  permisos sin el usuario). Compila para macOS y Windows.
- TURN (solo STUN de Google).

### Estado al terminar esta sesión
- Builds de prueba (fuera de git): `dist/chat-llamadas/Pasalo-chat-llamadas-android.apk`
  (firmado con la misma clave, ARM 64/32 y x86_64) y `Pasalo-chat-llamadas-macos.dmg`
  (universal, con los textos de permiso de micrófono y cámara).
- Muestras de audio de cada modo: `dist/muestras/`.
- Emuladores de prueba creados: `PasaloTest` y `PasaloTest2` (~2,8 GB cada uno
  en `~/.android/avd`); se pueden borrar.
- Pendiente de probar con personas: voz real en el Pixel (eco, auricular /
  altavoz), la app de escritorio con micrófono y cámara, y TURN.

## Sesión 2026-11-05 — Solicitudes, compresión, offline primero y server de conexión

Lo pedido: aceptar o rechazar los envíos en el receptor; sin cifrado propio y
con el menor consumo posible (compresión cuando sirva); llamadas y mediciones
lo más optimizadas posible; un server para Vercel con MongoDB Atlas que
muestre a los conectados y lleve las solicitudes de conexión, con la conexión
voluntaria, exclusiva entre los dos que se emparejan y la app arrancando
siempre desconectada.

Decidido con el usuario: iroh se queda para todo lo que va entre redes (QUIC
cifra siempre y no se puede quitar; es lo único cifrado y no se añade nada
más) y WebRTC se queda para el vídeo. El server es solo señalización.

### Solicitudes de envío
- El receptor no contesta a la `Offer` hasta que el usuario decide
  (`Event::TransferRequest`, `Receiver::decide`). Rechazo: `Reject { reason:
  "declined" }`; sin respuesta en 2 min, `"timeout"`. El emisor avisa de que
  espera (`TransferWaiting`). Lo que ya tiene registro en disco (una
  reanudación de algo aceptado) no vuelve a preguntar. Si el emisor se va
  mientras se pregunta, la petición se cierra (`RequestClosed`).
- Compatible con versiones viejas: el emisor solo espera más la respuesta.
- CLI: `listen` pregunta por la terminal (s/n); `--yes` acepta todo.

### Compresión
- El `Hello` lleva `features` (opcional). Si los dos dicen `zstd`, los datos
  van en bloques `[u32: bit alto = comprimido | longitud]`. Nivel 1 en la LAN y
  3 entre redes. Fotos, vídeos y comprimidos ni se intentan; con el resto, si
  un bloque no baja un 3 %, los 16 siguientes van en crudo.
- Medido en el Pixel 6 por la LAN: registro de texto de 9,9 MB → 2,2 MB por la
  red, MD5 idéntico. Datos aleatorios: 286,1 MB → 286,1 MB (sin crecer).
- `TransferFinished` lleva `wire_bytes` y la app muestra lo que pasó por la red.

### Offline primero
- iroh arranca sin relays (lista vacía), sin DNS y sin sondear el router.
  «Conectarse» añade en marcha los relays y el DNS de n0 en el mismo endpoint
  (mismo código y puerto); «Desconectar» los quita. Primero se probó cerrar y
  reabrir el endpoint, pero no recupera el puerto (el socket viejo sigue vivo
  mientras quedan clones), y el puerto se anuncia en la LAN.
- **Medido con tcpdump** durante 60 s: en solo red local, 0 paquetes UDP a
  internet y ninguna conexión TCP; conectado, 66 paquetes a los relays y una
  conexión TCP al relay.

### Server de conexión (`server/`)
- Una función de Vercel (`api/[action].js`) con MongoDB: `join`, `sync`
  (espera hasta 20 s a que cambie algo; sin cambios solo devuelve la versión),
  `request`, `cancel`, `answer`, `leave`. Al aceptar, cada lado recibe el
  código de iroh del otro, el server los olvida a los dos y cancela lo demás.
  Índices TTL para lo abandonado. 11 pruebas contra un MongoDB real en memoria
  (`mongodb-memory-server`), con reloj de mentira.
- Cliente en Rust (`pasalo-core/src/lobby.rs`) con el reqwest y los
  certificados que ya trae iroh: no añade dependencias.
- Emparejados, `Remote::set_only` hace que iroh rechace a cualquier otro. Al
  desconectar se avisa a la pareja con la señal `unpair`.
- **Probado**: dos CLI se encuentran, se emparejan y el server deja de
  listarlos; un tercer equipo no llega a la pareja aunque tenga su código, y
  la pareja sí (entre redes, por los relays).
- El server por defecto (`DEFAULT_SERVER` en la app) queda vacío: no se debe
  apuntar a un dominio que no sea nuestro. Hay que poner la URL del despliegue.

### Consumo de las llamadas
- **Fallo encontrado**: Opus llevaba la FEC activada pero el receptor no la
  usaba (gastaba bitrate en una copia inútil). Al intentar usarla, la FEC de
  `unsafe-libopus` satura igual que su PLC (picos de 32767). Se quita la FEC.
- Paquetes más largos: alta de 20 a 40 ms, normal de 40 a 60 ms (menos
  cabeceras y menos ACKs por segundo).
- ACK frequency de QUIC: se pide al otro lado que confirme cada 10 paquetes o
  cada 250 ms. noq lo limita a max(RTT, 25 ms), así que en la LAN apenas se nota
  y en datos móviles (RTT de 100-300 ms) sí.
- Medido con los dos CLI hablando a la vez (contadores UDP):

  | Modo | Antes | Ahora |
  |---|---|---|
  | alta | ~57 kbps | ~42 kbps |
  | normal | ~35 kbps | ~26 kbps |
  | baja | ~19 kbps | ~19 kbps |
  | mínima | ~9 kbps | ~9 kbps |

- Pixel 6 ⇄ CLI por la wifi, emparejados por el server: la voz que llega al
  móvil, ~19 kbps medidos frente a ~18,6 estimados; quien solo escucha manda
  ~6-7 kbps de ACKs. El micrófono real del Pixel funciona (~18 kbps de voz).
- La cabecera QUIC lleva un connection ID de 8 bytes que iroh no deja acortar.
- Transferencias por iroh sin pérdida: 300 MB en 13-14 s (21-22 MB/s) frente a
  16-17 s (17-18 MB/s) con la versión anterior.
- Conexiones del chat sin uso: se cierran a los 90 s (iroh manda un
  keep-alive cada 5 s por ruta). Los pendientes se reintentan al momento cuando
  el otro conecta o aparece en la LAN, y si no, con espera creciente (20 s →
  10 min) en vez de cada 20 s para siempre.
- Vídeo: 100/300/900 kbps (240p10, 360p15, 540p24) y audio a 16 kbps con DTX
  (se pide en el `fmtp` de Opus). No probado con cámara en esta sesión.

### App
- Quitado «añadir por código»: a otras redes se llega con «Conectarse».
- Probado en el Pixel 6 (Android 17): arranca desconectado; solicitud de envío
  con Aceptar/Rechazar; conectarse, ver al otro, pedir y aceptar en los dos
  sentidos; chat y llamada con la pareja; Desconectar avisa al otro.
- Arreglado al probar: la pareja salía dos veces (LAN y pareja) y decía
  «Remoto»; botones de la actividad que tapaban el nombre en el móvil; el ⚙
  cortado en pantallas estrechas.
- Para compilar Android aquí hace falta el Rust de rustup delante en el PATH
  (el de Homebrew no tiene los targets) y `JAVA_HOME` al OpenJDK 17.

### Qué no se ha probado
- El server desplegado en Vercel con Atlas (probado con el mismo código en
  local con MongoDB en memoria).
- Videollamadas con los presets nuevos; la app de escritorio con la interfaz
  nueva (compila).
- Consumo de voz con RTT de datos móviles.

## Sesión 2026-11-06 — Desconexiones

### Fallos encontrados
- **Llamada sin nadie al otro lado**: si el otro desaparecía sin colgar, nada
  lo notaba. El canal de voz seguía abierto y la app seguía grabando.
- **Llamada que arranca después de colgar**: si colgaban mientras
  `voice_start` o `video_start` estaban en marcha (en Android, con el
  permiso del micrófono pidiéndose), la voz o el vídeo arrancaban igual y
  se quedaban encendidos.
- **Pareja fantasma**: si la pareja cerraba la app o se quedaba sin red, este
  lado seguía «conectado» con ella para siempre (y con `set_only`, sin aceptar
  a nadie más). Como ninguno de los dos estaba en el server, no podían volver
  a encontrarse.
- Al desconectarse, la conexión de iroh con la pareja seguía abierta y se
  reutilizaba al volver a emparejarse, ya muerta. Los mensajes pendientes
  seguían reintentándose contra ella.
- En Android, si `voice_start` fallaba, el audio se quedaba en modo llamada.

### Cambios
- `Talk::hold` mantiene abierta la conexión con la pareja y la reabre si se
  cae; `Talk::release` la cierra, corta las entregas en curso y deja lo
  pendiente para cuando vuelva (no se pierde nada).
- `Event::TalkLost` cuando se cae la conexión en plena llamada: la app
  corta la voz y el vídeo en Rust, y la interfaz cuelga.
- `Event::PartnerLost`: si la pareja no vuelve en 20 s (60 s la primera
  vez), se deja la pareja y se vuelve al server para poder reconectar.
- En la interfaz, la llamada se corta si en 15 s no llega nada por la
  conexión (iroh manda un keep-alive cada 5 s).
- Al desconectarse (Desconectar, el otro se despide, se pierde la pareja o
  la LAN deja de ver al equipo) se cuelga la llamada, se sale de su chat y
  lo que se le envía queda en pausa. Sigue solo cuando el equipo vuelve; lo
  que pausó el usuario no. En la LAN no se pausa una transferencia que sigue
  avanzando: el descubrimiento puede perder anuncios.
- Release: el alias de la clave sale de `ANDROID_KEY_ALIAS` (por defecto
  `key0`) y se comprueba la clave antes de firmar.

### Después, en la misma sesión
- **Mensajes colgados tras reiniciar una app**: el otro lado seguía usando la
  conexión con la instancia vieja hasta que iroh la daba por muerta. Ahora, si
  el equipo de la LAN cambia de puerto, se descarta; si un envío falla, la
  conexión se olvida y se abre otra; una conexión entrante sustituye a la
  guardada; y el acuse se espera 30 s (antes, hasta 10 min).
- Al arrancar, la interfaz reintenta `snapshot` (Android a veces abre la app
  mientras se instala, antes de que el backend esté listo).
- Ventana de escritorio baja: la cuadrícula tenía una fila `auto` que crecía
  con el chat y dejaba fuera lo de abajo. La llamada se compacta en alturas
  bajas.
- Ajustes → Acerca de: versión y «Buscar actualización» (última release de
  GitHub, solo al pulsar; descarga el archivo para ese equipo).
- Con `RUST_LOG` la app escribe el registro del núcleo por la salida de errores.
- Versión 1.0.0.
