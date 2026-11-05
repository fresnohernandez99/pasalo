# Pasalo

**English** · [Español](README.es.md) · [Русский](README.ru.md)

Send files, folders and text between your devices on the same network, or to anyone on another network using a short code. Interrupted transfers pick up where they left off.

Pasalo runs on **macOS, Windows, Linux and Android**. Its core is written in Rust and the app is built with [Tauri 2](https://tauri.app).

## Features

- **Finds devices on your network automatically.** There are no accounts, no servers and no setup. It works without internet access.
- **Sends to other networks by code.** Every device has a code, its public key. Paste someone's code and you can send to them across the internet without opening ports, thanks to [iroh](https://iroh.computer).
- **Resumes interrupted transfers.** If the connection drops, the app is closed or the sender is restarted, the next attempt continues from the last byte received. Every file is verified with BLAKE3.
- **Handles large files and large folders.** Data is streamed in 256 KB blocks, so file size is not limited by memory. Thousands of small files go through quickly.
- **Sends text** for links, passwords and notes.
- **Speaks your language:** the interface is in English, Spanish and Russian, picked from the system and changeable from the app.

## Download

Grab the latest build from [Releases](https://github.com/fresnohernandez99/pasalo/releases):

| Platform | File |
|---|---|
| macOS (Intel and Apple Silicon) | `Pasalo_<version>_universal.dmg` |
| Windows | `Pasalo_<version>_x64-setup.exe` or `.msi` |
| Linux | `.AppImage`, `.deb` or `.rpm` |
| Android | `Pasalo-<version>-android.apk` |

The builds are not signed with Apple or Microsoft certificates yet:

- **macOS:** the first time, right-click Pasalo → **Open** → **Open**.
- **Windows:** if SmartScreen warns you, click **More info** → **Run anyway**.
- **Android:** allow installing apps from this source when asked.

## Using it

### On the same network

Open Pasalo on both devices. They show up in each other's **Devices** list within a few seconds. Then:

- drag files or folders onto a device (desktop), or
- tap **Files**, **Folder** or **Text** on a device.

If a device doesn't show up, type its IP in **Add by IP or remote code**. That usually happens on networks that block broadcast, such as guest Wi-Fi and some corporate networks.

### Across networks

1. The receiver clicks **Copy** next to **Remote code** and sends the code to the sender in a chat or email.
2. The sender pastes it in **Add by IP or remote code**. Pasalo connects, learns the device's name and keeps it in the list.
3. From then on you send exactly as on the local network.

iroh connects the two devices directly when the networks allow it, and otherwise relays the traffic through a relay server. Remote connections need internet on both sides; the local network does not.

### On Android

- On **Android 17+**, allow the **local network** permission when Pasalo asks for it. Without it, Android silently blocks all traffic with your local network.
- **Keep Pasalo open while receiving.** Android freezes apps in the background, which pauses transfers. They resume when you return.
- Received files go to `Download/Pasalo`.
- You can send files but not whole folders. Picked files are copied to the app's cache before sending, so sending a 10 GB file needs another 10 GB free.

## Command line

The `pasalo` CLI uses the same protocol as the app, so they can talk to each other.

```sh
pasalo listen                          # receive into Downloads/Pasalo and print your remote code
pasalo listen --dir ~/Inbox            # receive into another folder
pasalo peers                           # list devices on the network
pasalo send 192.168.1.20 photo.jpg     # send to an IP (or IP:port)
pasalo send "Office PC" Photos/        # send to a device by its name
pasalo send <code> big.iso             # send to a remote device by its code
pasalo text <target> "hello"           # send text
```

`--name` changes the name others see. `PASALO_CONFIG_DIR` lets you run several instances on one machine for testing. The CLI's own messages are in Spanish for now.

## How it works

| | |
|---|---|
| Discovery | UDP broadcast on port **4645**, sent to `255.255.255.255` and to each interface's broadcast address. |
| Transfer on the network | TCP on port **4646**. |
| Remote transfer | QUIC over [iroh](https://iroh.computer) (ALPN `pasalo/1`), with hole punching and the public n0 relays as a fallback. |
| Protocol | Length-prefixed JSON control messages, with the file contents sent raw between them. |
| Integrity | BLAKE3 hash of each complete file, checked before it is renamed into place. |
| Resuming | The receiver keeps `.pasalo-part` files and a small log in `<destination>/.pasalo/`. When the sender offers the same files again, the receiver answers with the offset to continue from. |

### Security and privacy

- **On the local network, traffic is not encrypted.** Anyone on the same network can see what you send. Use a remote code if you need encryption: iroh connections are always encrypted and authenticated with the device's key.
- **Pasalo accepts everything it receives**, like [Dukto](https://sourceforge.net/projects/dukto/). Anyone on your network, or anyone who has your code, can send you files.
- Your remote code lives in `remote_key` in the app's config folder. Whoever has that file can pretend to be your device.

## Building from source

You need [Rust](https://rustup.rs) (stable) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system.

```sh
cargo test -p pasalo-core              # tests (add -- --ignored for the internet test)
cargo run -p pasalo-cli -- listen      # CLI
cargo install tauri-cli --version "^2" --locked
cd app/src-tauri && cargo tauri dev    # desktop app
cargo tauri build                      # installer for the current system
```

Android also needs the Android SDK and NDK, Java 17, and the Rust targets:

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
cd app/src-tauri && cargo tauri android build --apk
```

### Releases

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds every platform and publishes a GitHub pre-release when you push a tag such as `v0.1.0-rc1`:

```sh
git tag v0.1.0-rc1 && git push origin v0.1.0-rc1
```

To sign the Android build, add these repository secrets. Without them, the workflow publishes an unsigned APK.

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -i pasalo-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore password (key alias `pasalo`) |

## Project layout

```
crates/pasalo-core   discovery, protocol, sending, receiving, iroh
crates/pasalo-cli    the pasalo command
app/src-tauri        Tauri app (Rust) and the Android project in gen/android
app/ui               interface (HTML, CSS and JS, no build step), translations in i18n.js
```

## License

[MIT](LICENSE)
