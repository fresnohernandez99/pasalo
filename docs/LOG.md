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
