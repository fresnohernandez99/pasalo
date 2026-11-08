# Pasalo

[English](technical.md) · **Español** · [Русский](technical.ru.md)

Envía archivos, carpetas y textos entre tus equipos de la misma red, o a alguien de otra red que acepte conectarse contigo. Si una transferencia se corta, sigue desde donde se quedó.

Pasalo funciona en **macOS, Windows, Linux y Android**. El núcleo está escrito en Rust y la app usa [Tauri 2](https://tauri.app).

## Qué hace

- **Encuentra solo los equipos de tu red.** No hay cuentas ni configuración. Funciona sin internet.
- **Sin conexión hasta que tú quieras.** Al abrirse, Pasalo solo habla con tu red local y no manda nada a internet. Con **Descubrir** ves quién más está en línea (con buscador y por páginas) y le puedes pedir conectarse; si acepta, quedáis conectados solo entre vosotros dos, por [iroh](https://iroh.computer) y sin abrir puertos.
- **Tú decides qué recibes.** Cada envío de archivos llega como una solicitud que aceptas o rechazas.
- **Gasta lo mínimo.** Lo que se puede comprimir se comprime (un registro de texto de 9,9 MB pasó como 2,2 MB); lo que ya va comprimido (fotos, vídeos, zip) se envía tal cual, sin gastar batería en intentarlo.
- **Reanuda las transferencias.** Si se corta la conexión, se cierra la app o se reinicia el emisor, el siguiente intento sigue desde el último byte recibido. Cada archivo se verifica con BLAKE3.
- **Aguanta archivos y carpetas grandes.** Los datos se envían en bloques de 256 KB, así que el tamaño de un archivo no depende de la memoria. Miles de archivos pequeños pasan rápido.
- **Envía textos**: enlaces, contraseñas, notas.
- **Habla tu idioma:** la interfaz está en inglés, español y ruso. Se elige según el sistema y se puede cambiar desde la app.

## Descarga

Baja la última versión de [Releases](https://github.com/fresnohernandez99/pasalo/releases):

| Plataforma | Archivo |
|---|---|
| macOS (Intel y Apple Silicon) | `Pasalo_<versión>_universal.dmg` |
| Windows | `Pasalo_<versión>_x64-setup.exe` o `.msi` |
| Linux | `.AppImage`, `.deb` o `.rpm` |
| Android | `Pasalo-<versión>-android.apk` |

**iPhone y cualquier navegador:** abre [pasalo-server.vercel.app/app](https://pasalo-server.vercel.app/app/) y, en el iPhone, añádela a la pantalla de inicio (Compartir → Añadir a pantalla de inicio). Tiene chat, llamadas y envío de archivos con los demás por el server o por enlace, pero no ve la red local y solo funciona con la página abierta. Ver [`web/`](../web/README.md).

Todavía no van firmadas con certificados de Apple ni de Microsoft:

- **macOS:** la primera vez, clic derecho en Pasalo → **Abrir** → **Abrir**.
- **Windows:** si SmartScreen avisa, pulsa **Más información** → **Ejecutar de todas formas**.
- **Android:** permite instalar apps de este origen cuando te lo pregunte.

## Uso

### En la misma red

Abre Pasalo en los dos equipos. A los pocos segundos cada uno aparece en la lista **Equipos** del otro. Después puedes:

- arrastrar archivos o carpetas encima de un equipo (en escritorio), o
- pulsar **Archivos**, **Carpeta** o **Texto** en un equipo.

Al otro equipo le aparece en **Actividad** quién le quiere enviar qué y cuánto ocupa, con **Aceptar** y **Rechazar**. Si nadie contesta en 2 minutos, el envío se cancela. Si una transferencia aceptada se corta, al reanudarla no se vuelve a preguntar.

Si un equipo no aparece, escribe su IP en **Añadir por IP**. Suele pasar en redes que bloquean el broadcast, como las wifi de invitados y algunas redes de empresa.

### Entre redes distintas

1. Los dos pulsan **Descubrir**. Hasta entonces Pasalo no intenta nada fuera de la red local.
2. En **Descubrir** aparecen los demás conectados, con buscador y por páginas. Uno pulsa **Conectar** junto al otro.
3. Al otro le llega la solicitud y pulsa **Aceptar** (o **Rechazar**).
4. Ya estáis conectados: los dos dejáis el server, nadie más os ve ni os puede escribir, y os aparecéis en **Equipos** para enviaros archivos, chatear y llamaros como en la red local.
5. **Desconectar** termina la conexión en los dos lados y vuelve a solo red local. Al cerrar la app también se empieza desconectado la próxima vez.

El server ([`server/`](../server/README.md), para Vercel con MongoDB) solo os presenta: por él no pasan archivos, mensajes ni llamadas. iroh conecta los dos equipos directamente cuando las redes lo permiten; si no, el tráfico pasa por un relay de n0. La dirección del server se pone en ⚙ Ajustes.

### En Android

- En **Android 17 o superior**, acepta el permiso de **red local** cuando Pasalo lo pida. Sin él, Android bloquea en silencio todo el tráfico con tu red local.
- **Mantén Pasalo abierto mientras recibes.** Android congela las apps en segundo plano y la transferencia se para. Sigue cuando vuelves a la app.
- Lo recibido se guarda en `Download/Pasalo`.
- Necesita Android 8.0 o superior.
- Se pueden enviar archivos, pero no carpetas enteras. Los archivos elegidos se copian a la caché de la app antes de enviarse, así que para enviar 10 GB hacen falta otros 10 GB libres.

## Chat y llamadas

Los equipos de tu red con Pasalo y la pareja con la que te conectaste muestran un botón **Chat**:

- **Mensajes e imágenes**, directos entre los dos equipos por iroh. Las imágenes se reducen a 1600 px antes de enviarse. Los mensajes que no se pueden entregar quedan pendientes y salen en cuanto se llega al otro equipo. Una conexión sin uso se cierra a los 90 s para no gastar en mantenerla abierta.
- **Notas de voz** (AAC u Opus, hasta 5 min), **fotos de «ver una vez»** (se borran en los dos lados al verlas; las capturas se bloquean en Android, macOS y Windows) y **chats privados** (un candado junto a las llamadas: el historial se borra en los dos equipos al desconectarse). Cada llamada queda en el chat con su duración y lo que gastó.
- **Llamadas de voz** hechas en Rust, sin WebRTC ni servidores: Opus o Codec2 sobre datagramas QUIC no fiables. La calidad se puede cambiar durante la llamada y el otro lado cambia también. Medido en la red con los dos lados hablando a la vez (el peor caso), con todo lo que pasa por ella:

  | Calidad | Consumo de red | Antes | Retraso añadido |
  |---|---|---|---|
  | Alta (Opus 24 kbps, paquetes de 40 ms) | ~42 kbps | ~57 | ~80 ms |
  | Normal (Opus 12 kbps, 60 ms) | ~26 kbps | ~35 | ~110 ms |
  | Baja (Opus 6 kbps, 120 ms) | ~19 kbps | ~19 | ~360 ms |
  | Mínima (Codec2 1300 bps, 160 ms) | ~9 kbps | ~9 | ~440 ms |

  Durante los silencios no se envía nada, así que quien solo escucha gasta mucho menos (unos 6-7 kbps en normal, casi todo confirmaciones de QUIC). En Baja y Mínima cada paquete lleva también el anterior, así que las pérdidas sueltas se recuperan. Las confirmaciones se agrupan hasta un RTT: en datos móviles, con más latencia que en la wifi de casa, se gasta algo menos que en la tabla.
- **Videollamadas** por la misma conexión de iroh que la voz, sin WebRTC, STUN ni TURN: la cámara se comprime en la app con WebCodecs (VP9, H.264 o VP8) y cada imagen viaja en su propio stream QUIC. Las calidades van de unos 40 a 300 kbps (160 a 480 px, 6 a 20 imágenes por segundo); si la red descarta imágenes, la calidad baja sola en los dos lados. El fondo desenfocado (opcional) envía un 30 % menos de vídeo.

En Android, permite el micrófono (y la cámara para el vídeo). En escritorio las llamadas solo tienen una supresión de eco básica: usa auriculares. 

## Línea de comandos

El CLI `pasalo` usa el mismo protocolo que la app, así que se entienden entre sí.

```sh
pasalo listen                          # recibe en Descargas/Pasalo; pregunta antes de aceptar (s/n)
pasalo listen --yes --dir ~/Entrada    # acepta todo, en otra carpeta
pasalo listen --offline                # solo red local, sin internet
pasalo listen --server https://….vercel.app --connect "Pixel"   # entra en el server y pide conexión
pasalo peers                           # lista los equipos de la red
pasalo send 192.168.1.20 foto.jpg      # envía a una IP (o IP:puerto)
pasalo send "PC Oficina" Fotos/        # envía a un equipo por su nombre
pasalo send <código> grande.iso        # envía a un equipo remoto por su código
pasalo text <destino> "hola"           # envía un texto
pasalo chat <destino> "hola" --image a.jpg  # mensaje de chat (código o nombre en la red)
pasalo call <destino> --mode minimum --voice-in voz.raw    # llamada de prueba con un archivo de audio
```

`--name` cambia el nombre con el que te ven los demás. `PASALO_CONFIG_DIR` permite simular varios equipos en la misma máquina para hacer pruebas.

## Cómo funciona

| | |
|---|---|
| Descubrimiento | Broadcast UDP en el puerto **4645**, a `255.255.255.255` y a la dirección de broadcast de cada interfaz. |
| Transferencia en la red | TCP en el puerto **4646**. |
| Transferencia remota | QUIC sobre [iroh](https://iroh.computer) (ALPN `pasalo/1`), atravesando el NAT y con los relays públicos de n0 como respaldo. |
| Protocolo | Mensajes de control en JSON precedidos de su longitud, con el contenido de los archivos entre ellos: en bloques comprimidos con zstd si los dos equipos lo entienden (nivel 1 en la LAN, 3 entre redes), en crudo con versiones antiguas. |
| Solicitudes | El receptor no contesta a la oferta hasta que el usuario acepta o rechaza (`Reject { reason: "declined" }`). |
| Conexión | iroh arranca sin relays ni DNS. **Descubrir** añade los relays y el DNS de n0 en marcha, con el mismo código y el mismo puerto; al emparejarse solo se aceptan conexiones de la pareja. |
| Integridad | Hash BLAKE3 de cada archivo completo, comprobado antes de dejarlo en su sitio. |
| Reanudación | El receptor guarda archivos `.pasalo-part` y un registro pequeño en `<destino>/.pasalo/`. Cuando el emisor vuelve a ofrecer lo mismo, el receptor le contesta desde qué byte seguir. |

### Seguridad y privacidad

- Pasalo no añade cifrado propio. **Los archivos enviados por la red local van sin cifrar**: cualquiera en la misma red puede ver lo que envías. Lo que va por iroh (chat, llamadas y todo lo de la pareja) va cifrado porque QUIC lo hace siempre.
- **Nada se recibe sin aceptarlo.** Cualquiera de tu red puede pedirte enviar archivos, pero solo llegan si aceptas. Los textos sueltos llegan sin preguntar.
- **El server ve tu nombre y tu tipo de equipo** mientras estás conectado, y tu código de iroh solo se le da a quien aceptas. No tiene cuentas: identifica cada sesión con un token aleatorio.
- Tu código vive en el archivo `remote_key`, en la carpeta de configuración de la app. Quien tenga ese archivo puede hacerse pasar por tu equipo.

## Compilar desde el código

Necesitas [Rust](https://rustup.rs) (estable) y los [requisitos de Tauri](https://tauri.app/start/prerequisites/) de tu sistema.

```sh
cargo test -p pasalo-core              # pruebas (añade -- --ignored para la que usa internet)
cargo run -p pasalo-cli -- listen      # CLI
cd server && npm install && npm test  # pruebas del server (Node 20+)
cargo install tauri-cli --version "^2" --locked
cd app/src-tauri && cargo tauri dev    # app de escritorio
cargo tauri build                      # instalador para el sistema actual
```

Para Android también hacen falta el SDK y el NDK de Android, Java 17 y los targets de Rust:

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
cd app/src-tauri && cargo tauri android build --apk
```

### Versiones

[`.github/workflows/release.yml`](../.github/workflows/release.yml) compila todas las plataformas y publica una pre-release en GitHub cuando subes una etiqueta como `v0.1.0-rc1`:

```sh
git tag v0.1.0-rc1 && git push origin v0.1.0-rc1
```

Para firmar el APK de Android, añade estos secretos al repositorio. Sin ellos, el workflow publica un APK sin firmar.

| Secreto | Valor |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -i pasalo-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | La contraseña del keystore (alias `pasalo`) |

## Estructura

```
crates/pasalo-core   descubrimiento, protocolo, envío, recepción, compresión, iroh, cliente del server
crates/pasalo-cli    el comando pasalo
crates/pasalo-call   llamadas de voz (códecs y paquetes)
server               server de conexión para Vercel con MongoDB (ver server/README.md)
app/src-tauri        app de Tauri (Rust) y el proyecto de Android en gen/android
app/ui               interfaz (HTML, CSS y JS, sin paso de compilación), traducciones en i18n.js
web                  Pasalo web (iroh y la voz en WASM, para el iPhone); se publica en server/public/app
```

## Licencia

[MIT](../LICENSE)
