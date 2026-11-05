# Pasalo

[English](README.md) · **Español** · [Русский](README.ru.md)

Envía archivos, carpetas y textos entre tus equipos de la misma red, o a cualquiera en otra red con un código corto. Si una transferencia se corta, sigue desde donde se quedó.

Pasalo funciona en **macOS, Windows, Linux y Android**. El núcleo está escrito en Rust y la app usa [Tauri 2](https://tauri.app).

## Qué hace

- **Encuentra solo los equipos de tu red.** No hay cuentas, servidores ni configuración. Funciona sin internet.
- **Envía a otras redes con un código.** Cada equipo tiene un código, que es su clave pública. Si pegas el de otra persona, puedes enviarle cosas por internet sin abrir puertos, gracias a [iroh](https://iroh.computer).
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

Todavía no van firmadas con certificados de Apple ni de Microsoft:

- **macOS:** la primera vez, clic derecho en Pasalo → **Abrir** → **Abrir**.
- **Windows:** si SmartScreen avisa, pulsa **Más información** → **Ejecutar de todas formas**.
- **Android:** permite instalar apps de este origen cuando te lo pregunte.

## Uso

### En la misma red

Abre Pasalo en los dos equipos. A los pocos segundos cada uno aparece en la lista **Equipos** del otro. Después puedes:

- arrastrar archivos o carpetas encima de un equipo (en escritorio), o
- pulsar **Archivos**, **Carpeta** o **Texto** en un equipo.

Si un equipo no aparece, escribe su IP en **Añadir por IP o código remoto**. Suele pasar en redes que bloquean el broadcast, como las wifi de invitados y algunas redes de empresa.

### Entre redes distintas

1. Quien recibe pulsa **Copiar** junto a **Código remoto** y le manda el código a quien envía, por chat o por correo.
2. Quien envía lo pega en **Añadir por IP o código remoto**. Pasalo conecta, obtiene el nombre del equipo y lo guarda en la lista.
3. A partir de ahí se envía igual que en la red local.

iroh conecta los dos equipos directamente cuando las redes lo permiten; si no, el tráfico pasa por un servidor intermedio (relay). Las conexiones remotas necesitan internet en los dos lados; la red local no.

### En Android

- En **Android 17 o superior**, acepta el permiso de **red local** cuando Pasalo lo pida. Sin él, Android bloquea en silencio todo el tráfico con tu red local.
- **Mantén Pasalo abierto mientras recibes.** Android congela las apps en segundo plano y la transferencia se para. Sigue cuando vuelves a la app.
- Lo recibido se guarda en `Download/Pasalo`.
- Se pueden enviar archivos, pero no carpetas enteras. Los archivos elegidos se copian a la caché de la app antes de enviarse, así que para enviar 10 GB hacen falta otros 10 GB libres.

## Línea de comandos

El CLI `pasalo` usa el mismo protocolo que la app, así que se entienden entre sí.

```sh
pasalo listen                          # recibe en Descargas/Pasalo y muestra tu código remoto
pasalo listen --dir ~/Entrada          # recibe en otra carpeta
pasalo peers                           # lista los equipos de la red
pasalo send 192.168.1.20 foto.jpg      # envía a una IP (o IP:puerto)
pasalo send "PC Oficina" Fotos/        # envía a un equipo por su nombre
pasalo send <código> grande.iso        # envía a un equipo remoto por su código
pasalo text <destino> "hola"           # envía un texto
```

`--name` cambia el nombre con el que te ven los demás. `PASALO_CONFIG_DIR` permite simular varios equipos en la misma máquina para hacer pruebas.

## Cómo funciona

| | |
|---|---|
| Descubrimiento | Broadcast UDP en el puerto **4645**, a `255.255.255.255` y a la dirección de broadcast de cada interfaz. |
| Transferencia en la red | TCP en el puerto **4646**. |
| Transferencia remota | QUIC sobre [iroh](https://iroh.computer) (ALPN `pasalo/1`), atravesando el NAT y con los relays públicos de n0 como respaldo. |
| Protocolo | Mensajes de control en JSON precedidos de su longitud, con el contenido de los archivos en crudo entre ellos. |
| Integridad | Hash BLAKE3 de cada archivo completo, comprobado antes de dejarlo en su sitio. |
| Reanudación | El receptor guarda archivos `.pasalo-part` y un registro pequeño en `<destino>/.pasalo/`. Cuando el emisor vuelve a ofrecer lo mismo, el receptor le contesta desde qué byte seguir. |

### Seguridad y privacidad

- **En la red local el tráfico no va cifrado.** Cualquiera en la misma red puede ver lo que envías. Si necesitas cifrado, usa un código remoto: las conexiones por iroh siempre van cifradas y autenticadas con la clave del equipo.
- **Pasalo acepta todo lo que recibe**, como [Dukto](https://sourceforge.net/projects/dukto/). Cualquiera en tu red, o cualquiera que tenga tu código, puede enviarte archivos.
- Tu código remoto vive en el archivo `remote_key`, en la carpeta de configuración de la app. Quien tenga ese archivo puede hacerse pasar por tu equipo.

## Compilar desde el código

Necesitas [Rust](https://rustup.rs) (estable) y los [requisitos de Tauri](https://tauri.app/start/prerequisites/) de tu sistema.

```sh
cargo test -p pasalo-core              # pruebas (añade -- --ignored para la que usa internet)
cargo run -p pasalo-cli -- listen      # CLI
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

[`.github/workflows/release.yml`](.github/workflows/release.yml) compila todas las plataformas y publica una pre-release en GitHub cuando subes una etiqueta como `v0.1.0-rc1`:

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
crates/pasalo-core   descubrimiento, protocolo, envío, recepción, iroh
crates/pasalo-cli    el comando pasalo
app/src-tauri        app de Tauri (Rust) y el proyecto de Android en gen/android
app/ui               interfaz (HTML, CSS y JS, sin paso de compilación), traducciones en i18n.js
```

## Licencia

[MIT](LICENSE)
