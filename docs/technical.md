# Pasalo

**English** · [Español](technical.es.md) · [Русский](technical.ru.md)

Send files, folders and text between your devices on the same network, or to someone on another network who agrees to connect with you. Interrupted transfers pick up where they left off.

Pasalo runs on **macOS, Windows, Linux and Android**. Its core is written in Rust and the app is built with [Tauri 2](https://tauri.app).

## Features

- **Finds devices on your network automatically.** There are no accounts and no setup. It works without internet access.
- **Offline until you say so.** When it opens, Pasalo only talks to your local network and sends nothing to the internet. With **Discover** you see who else is online (searchable and paged) and can ask them to connect; if they accept, only the two of you are connected to each other, over [iroh](https://iroh.computer) and without opening ports.
- **You decide what you receive.** Every file transfer arrives as a request you accept or decline.
- **Uses as little data as possible.** Whatever compresses gets compressed (a 9.9 MB text log went over as 2.2 MB); already-compressed files (photos, videos, zips) go as they are, without wasting battery trying.
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

**iPhone and any browser:** open [pasalo-server.vercel.app/app](https://pasalo-server.vercel.app/app/) and, on the iPhone, add it to the Home Screen (Share → Add to Home Screen). It has chat, calls and file transfers with everyone else through the server or by link, but it can't see the local network and only works while the page is open. See [`web/`](../web/README.md).

The builds are not signed with Apple or Microsoft certificates yet:

- **macOS:** the first time, right-click Pasalo → **Open** → **Open**.
- **Windows:** if SmartScreen warns you, click **More info** → **Run anyway**.
- **Android:** allow installing apps from this source when asked.

## Using it

### On the same network

Open Pasalo on both devices. They show up in each other's **Devices** list within a few seconds. Then:

- drag files or folders onto a device (desktop), or
- tap **Files**, **Folder** or **Text** on a device.

The other device shows in **Activity** who wants to send what and how big it is, with **Accept** and **Decline**. If nobody answers within 2 minutes, the transfer is cancelled. If an accepted transfer is interrupted, resuming it doesn't ask again.

If a device doesn't show up, type its IP in **Add by IP**. That usually happens on networks that block broadcast, such as guest Wi-Fi and some corporate networks.

### Across networks

1. Both of you press **Discover**. Until then Pasalo tries nothing outside the local network.
2. **Discover** lists everyone else who is connected, with a search box and pages. One of you presses **Connect** next to the other.
3. The other gets the request and presses **Accept** (or **Decline**).
4. You're connected: both of you leave the server, nobody else can see you or reach you, and each of you shows up in the other's **Devices** to send files, chat and call as on the local network.
5. **Disconnect** ends the connection on both sides and goes back to local network only. Closing the app also starts disconnected next time.

The server ([`server/`](../server/README.md), for Vercel with MongoDB) only introduces you: no files, messages or calls go through it. iroh connects the two devices directly when the networks allow it, and otherwise through an n0 relay. The server address goes in ⚙ Settings.

### On Android

- On **Android 17+**, allow the **local network** permission when Pasalo asks for it. Without it, Android silently blocks all traffic with your local network.
- **Keep Pasalo open while receiving.** Android freezes apps in the background, which pauses transfers. They resume when you return.
- Received files go to `Download/Pasalo`.
- Requires Android 8.0 or newer.
- You can send files but not whole folders. Picked files are copied to the app's cache before sending, so sending a 10 GB file needs another 10 GB free.

## Chat and calls

Devices on your network running Pasalo, and the partner you connected with, show a **Chat** button:

- **Messages and images**, straight between the two devices over iroh. Images are downscaled to 1600 px before sending. Messages that can't be delivered stay pending and go out as soon as the other device is reachable. An unused connection closes after 90 s so it costs nothing to keep open.
- **Voice notes** (AAC or Opus, up to 5 min), **view-once photos** (deleted on both sides once seen; screenshots are blocked on Android, macOS and Windows) and **private chats** (a lock next to the call buttons: the history is deleted on both devices when you disconnect). Every call is logged in the chat with its duration and data usage.
- **Voice calls** built in Rust, with no WebRTC and no servers: Opus or Codec2 over unreliable QUIC datagrams. You can change the quality during the call, and the other side switches too. Measured on the wire with both sides talking at once (worst case):

  | Quality | Network use | Before | Delay added |
  |---|---|---|---|
  | High (Opus 24 kbps, 40 ms packets) | ~42 kbps | ~57 | ~80 ms |
  | Normal (Opus 12 kbps, 60 ms) | ~26 kbps | ~35 | ~110 ms |
  | Low (Opus 6 kbps, 120 ms) | ~19 kbps | ~19 | ~360 ms |
  | Minimum (Codec2 1300 bps, 160 ms) | ~9 kbps | ~9 | ~440 ms |

  Nothing is sent during silence, so whoever is only listening uses much less (about 6-7 kbps on Normal, nearly all QUIC acknowledgements). In Low and Minimum every packet also carries the previous one, so isolated losses are recovered. Acknowledgements are batched for up to one RTT: on mobile data, with more latency than home Wi-Fi, usage is somewhat lower than in the table.
- **Video calls** go over the same iroh connection as the voice, with no WebRTC, STUN or TURN: the camera is compressed in the app with WebCodecs (VP9, H.264 or VP8) and each frame travels on its own QUIC stream. Qualities go from about 40 to 300 kbps (160 to 480 px, 6 to 20 fps); if the network drops frames, the quality steps down by itself on both sides. Optional background blur sends 30 % less video.

On Android, allow the microphone (and the camera for video). Desktop calls have only basic echo suppression: use headphones. 

## Command line

The `pasalo` CLI uses the same protocol as the app, so they can talk to each other.

```sh
pasalo listen                          # receive into Downloads/Pasalo; asks before accepting (s/n)
pasalo listen --yes --dir ~/Inbox      # accept everything, into another folder
pasalo listen --offline                # local network only, no internet
pasalo listen --server https://….vercel.app --connect "Pixel"   # join the server and ask to connect
pasalo peers                           # list devices on the network
pasalo send 192.168.1.20 photo.jpg     # send to an IP (or IP:port)
pasalo send "Office PC" Photos/        # send to a device by its name
pasalo send <code> big.iso             # send to a remote device by its code
pasalo text <target> "hello"           # send text
pasalo chat <target> "hi" --image a.jpg  # chat message (code or name on the network)
pasalo call <target> --mode minimum --voice-in voice.raw   # test call with an audio file
```

`--name` changes the name others see. `PASALO_CONFIG_DIR` lets you run several instances on one machine for testing. The CLI's own messages are in Spanish for now.

## How it works

| | |
|---|---|
| Discovery | UDP broadcast on port **4645**, sent to `255.255.255.255` and to each interface's broadcast address. |
| Transfer on the network | TCP on port **4646**. |
| Remote transfer | QUIC over [iroh](https://iroh.computer) (ALPN `pasalo/1`), with hole punching and the public n0 relays as a fallback. |
| Protocol | Length-prefixed JSON control messages, with the file contents between them: in zstd-compressed blocks when both devices support it (level 1 on the LAN, 3 across networks), raw with older versions. |
| Requests | The receiver doesn't answer the offer until the user accepts or declines (`Reject { reason: "declined" }`). |
| Connecting | iroh starts with no relays and no DNS. **Discover** adds the n0 relays and DNS on the fly, keeping the same code and port; once paired, only connections from the partner are accepted. |
| Integrity | BLAKE3 hash of each complete file, checked before it is renamed into place. |
| Resuming | The receiver keeps `.pasalo-part` files and a small log in `<destination>/.pasalo/`. When the sender offers the same files again, the receiver answers with the offset to continue from. |

### Security and privacy

- Pasalo adds no encryption of its own. **File transfers on the local network are not encrypted**: anyone on the same network can see what you send. Whatever goes over iroh (chat, calls and everything with your partner) is encrypted because QUIC always does it.
- **Nothing arrives without your consent.** Anyone on your network can ask to send you files, but they only arrive if you accept. Plain texts arrive without asking.
- **The server sees your name and device type** while you are connected, and your iroh code is only given to whoever you accept. It has no accounts: each session is identified by a random token.
- Your code lives in `remote_key` in the app's config folder. Whoever has that file can pretend to be your device.

## Building from source

You need [Rust](https://rustup.rs) (stable) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system.

```sh
cargo test -p pasalo-core              # tests (add -- --ignored for the internet test)
cargo run -p pasalo-cli -- listen      # CLI
cd server && npm install && npm test  # signaling server tests (Node 20+)
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

[`.github/workflows/release.yml`](../.github/workflows/release.yml) builds every platform and publishes a GitHub pre-release when you push a tag such as `v0.1.0-rc1`:

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
crates/pasalo-core   discovery, protocol, sending, receiving, compression, iroh, server client
crates/pasalo-cli    the pasalo command
crates/pasalo-call   voice calls (codecs and packets)
server               connection server for Vercel with MongoDB (see server/README.md)
app/src-tauri        Tauri app (Rust) and the Android project in gen/android
app/ui               interface (HTML, CSS and JS, no build step), translations in i18n.js
web                  Pasalo web (iroh and voice in WASM, for the iPhone); published in server/public/app
```

## License

[MIT](../LICENSE)
