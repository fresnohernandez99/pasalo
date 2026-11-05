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
