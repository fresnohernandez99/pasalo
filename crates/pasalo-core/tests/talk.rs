//! Chat y señales entre dos equipos en el mismo proceso. Se conectan por su
//! dirección local de iroh, como dos equipos de la LAN, así que no hace falta
//! internet.

use std::net::SocketAddr;
use std::time::Duration;

use pasalo_core::{ChatMessage, Event, LocalInfo, Receiver, Remote, Signal, Status, Talk};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

struct Side {
    remote: Remote,
    talk: Talk,
    code: String,
    addr: SocketAddr,
    events: UnboundedReceiver<Event>,
    _dir: tempfile::TempDir,
}

async fn side(name: &str) -> Side {
    let dir = tempfile::tempdir().unwrap();
    // Solo red local: nada de internet, como la app al abrirse.
    let remote = Remote::start(None, false).await.unwrap();
    let (tx, events) = unbounded_channel();
    let talk = Talk::new(remote.clone(), name, dir.path().join("chat"), tx.clone());
    let receiver = Receiver::new(dir.path().join("in"), LocalInfo::new(name, name), tx);
    tokio::spawn({
        let (remote, talk) = (remote.clone(), talk.clone());
        async move { receiver.run_remote(remote, Some(talk)).await }
    });
    let addr = SocketAddr::from(([127, 0, 0, 1], remote.port().unwrap()));
    Side { code: remote.code(), remote, talk, addr, events, _dir: dir }
}

/// Dos equipos que se conocen por la LAN.
async fn pair() -> (Side, Side) {
    let (a, b) = (side("ana").await, side("beto").await);
    a.talk.set_lan_addr(&b.code, b.addr);
    b.talk.set_lan_addr(&a.code, a.addr);
    (a, b)
}

async fn next_chat(events: &mut UnboundedReceiver<Event>) -> (ChatMessage, Option<String>) {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(20), events.recv()).await.expect("evento").unwrap();
        if let Event::Chat { message, name } = event {
            return (message, name);
        }
    }
}

#[tokio::test]
async fn chat_text_and_image() {
    let (mut a, mut b) = pair().await;

    let sent = a.talk.send_text(&b.code, "hola".into()).await.unwrap();
    assert_eq!(sent.status, Status::Pending);
    let (got, name) = next_chat(&mut b.events).await;
    assert_eq!((got.text.as_deref(), got.status, name.as_deref()), (Some("hola"), Status::Received, Some("ana")));
    assert_eq!(got.peer, a.code);
    let (delivered, _) = next_chat(&mut a.events).await;
    assert_eq!((delivered.id, delivered.status), (sent.id.clone(), Status::Delivered));

    let image: Vec<u8> = (0..300_000u32).map(|i| (i * 7) as u8).collect();
    b.talk.send_image(&a.code, &image, "png").await.unwrap();
    let (got, _) = next_chat(&mut a.events).await;
    assert_eq!(std::fs::read(got.image.unwrap()).unwrap(), image);

    // El historial sobrevive y refleja el estado final.
    let history = a.talk.history(&b.code);
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].status, Status::Delivered);
    assert!(!history[1].outgoing);
}

#[tokio::test]
async fn pending_message_is_delivered_when_peer_comes_back() {
    let a = side("ana").await;
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("remote_key");

    // Beto existe pero está apagado: el mensaje se queda pendiente.
    let first = Remote::start(Some(&key), false).await.unwrap();
    let code = first.code();
    a.talk.set_lan_addr(&code, SocketAddr::from(([127, 0, 0, 1], first.port().unwrap())));
    first.shutdown().await;
    drop(first);
    let sent = a.talk.send_text(&code, "¿estás?".into()).await.unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(a.talk.history(&code)[0].status, Status::Pending);

    // Vuelve con la misma clave (mismo código) y otro puerto. El
    // descubrimiento avisaría de la dirección nueva; aquí se hace a mano.
    let remote = Remote::start(Some(&key), false).await.unwrap();
    assert_eq!(remote.code(), code);
    let addr = SocketAddr::from(([127, 0, 0, 1], remote.port().unwrap()));
    let (tx, mut events) = unbounded_channel();
    let talk = Talk::new(remote.clone(), "beto", dir.path().join("chat"), tx.clone());
    let receiver = Receiver::new(dir.path().join("in"), LocalInfo::new("beto", "beto"), tx);
    tokio::spawn(async move { receiver.run_remote(remote, Some(talk)).await });
    a.talk.set_lan_addr(&code, addr);

    let (got, _) = next_chat(&mut events).await;
    assert_eq!((got.id, got.text.as_deref()), (sent.id, Some("¿estás?")));
}

#[tokio::test]
async fn signals_and_voice_datagrams() {
    let (a, mut b) = pair().await;
    let signal = Signal { call: "c1".into(), kind: "invite".into(), data: serde_json::json!({"media": "voice"}) };
    a.talk.signal(&b.code, signal).await.unwrap();
    let got = loop {
        if let Some(Event::Signal { peer, name, signal }) = b.events.recv().await {
            break (peer, name, signal);
        }
    };
    assert_eq!((got.0, got.1.as_str(), got.2.kind.as_str()), (a.code.clone(), "ana", "invite"));

    let link_a = a.talk.voice(&b.code).await.unwrap();
    let mut link_b = b.talk.voice(&a.code).await.unwrap();
    assert!(link_a.sender.max_size() >= 1000);
    for i in 0..20u8 {
        link_a.sender.send(bytes::Bytes::from(vec![i; 40]));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let first = tokio::time::timeout(Duration::from_secs(5), link_b.rx.recv()).await.unwrap().unwrap();
    assert_eq!(first.len(), 40);
}

/// Las imágenes de vídeo llegan enteras, también las grandes (una imagen
/// clave), y solo al canal abierto para ese equipo.
#[tokio::test]
async fn video_frames_arrive_whole() {
    let (a, b) = pair().await;
    let link_a = a.talk.video(&b.code).await.unwrap();
    let mut link_b = b.talk.video(&a.code).await.unwrap();
    let key: Vec<u8> = (0..40_000u32).map(|i| (i * 13) as u8).collect();
    assert!(link_a.sender.send(bytes::Bytes::from(key.clone())));
    for i in 0..10u8 {
        assert!(link_a.sender.send(bytes::Bytes::from(vec![i; 900])));
    }
    let mut got = Vec::new();
    while got.len() < 11 {
        got.push(tokio::time::timeout(Duration::from_secs(5), link_b.rx.recv()).await.unwrap().unwrap());
    }
    assert!(got.iter().any(|f| f[..] == key[..]));
    assert_eq!(got.iter().filter(|f| f.len() == 900).count(), 10);

    // Sin canal abierto, lo que llegue se descarta.
    b.talk.end_video(&a.code);
    link_a.sender.send(bytes::Bytes::from(vec![1; 10]));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(link_b.rx.try_recv().is_err());
}

/// WebRTC manda de golpe la oferta SDP (varios KB) y una ráfaga de candidatos
/// ICE: tienen que llegar todos.
#[tokio::test]
async fn burst_of_signals_all_arrive() {
    let (a, mut b) = pair().await;
    let sdp = "v=0 ".repeat(1500);
    let mut sends = Vec::new();
    for i in 0..12 {
        let talk = a.talk.clone();
        let code = b.code.clone();
        let data = if i == 0 { serde_json::json!({ "sdp": sdp }) } else { serde_json::json!({ "candidate": i }) };
        sends.push(tokio::spawn(async move {
            talk.signal(&code, Signal { call: "c".into(), kind: format!("k{i}"), data }).await
        }));
    }
    for send in sends {
        tokio::time::timeout(Duration::from_secs(20), send).await.expect("la señal no terminó").unwrap().unwrap();
    }
    let mut got = 0;
    while got < 12 {
        match tokio::time::timeout(Duration::from_secs(10), b.events.recv()).await {
            Ok(Some(Event::Signal { .. })) => got += 1,
            Ok(Some(_)) => {}
            _ => panic!("solo llegaron {got} de 12 señales"),
        }
    }
}

/// Emparejado con alguien, no se acepta a nadie más.
#[tokio::test]
async fn paired_peer_only_accepts_its_partner() {
    let (a, b) = pair().await;
    let c = side("carla").await;
    c.talk.set_lan_addr(&a.code, a.addr);
    a.remote.set_only(Some(pasalo_core::parse_code(&b.code).unwrap()));

    let signal = || Signal { call: "c".into(), kind: "invite".into(), data: serde_json::Value::Null };
    assert!(c.talk.signal(&a.code, signal()).await.is_err(), "carla no debía llegar");
    b.talk.signal(&a.code, signal()).await.expect("beto sí");

    a.remote.set_only(None);
    c.talk.signal(&a.code, signal()).await.expect("sin pareja, carla sí");
}

/// Pasar a internet y volver mantiene el código y el puerto, y el chat sigue.
#[tokio::test]
async fn switching_modes_keeps_code_and_port() {
    let (a, mut b) = pair().await;
    let (code, port) = (a.remote.code(), a.remote.port());
    a.remote.set_internet(true).await.unwrap();
    a.remote.set_internet(false).await.unwrap();
    assert_eq!((a.remote.code(), a.remote.port()), (code, port));

    b.talk.send_text(&a.code, "sigo aquí".into()).await.unwrap();
    let _ = next_chat(&mut b.events).await; // entregado
    let mut a = a;
    let (got, _) = next_chat(&mut a.events).await;
    assert_eq!(got.text.as_deref(), Some("sigo aquí"));
}

/// Si el otro equipo desaparece en plena llamada, sale `TalkLost` y el canal
/// de voz se cierra: la llamada no se queda corriendo sola.
#[tokio::test]
async fn call_ends_when_peer_vanishes() {
    let (a, mut b) = pair().await;
    let _link_a = a.talk.voice(&b.code).await.unwrap();
    let mut link_b = b.talk.voice(&a.code).await.unwrap();
    a.remote.shutdown().await;
    let lost = tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            if let Some(Event::TalkLost { peer }) = b.events.recv().await {
                break peer;
            }
        }
    })
    .await
    .expect("TalkLost");
    assert_eq!(lost, a.code);
    assert!(link_b.rx.recv().await.is_none());
}

/// `hold` mantiene la conexión con la pareja: termina en `true` al soltarla y
/// en `false` si la pareja no vuelve.
#[tokio::test]
async fn hold_reports_release_and_loss() {
    let (a, b) = pair().await;
    let holding = tokio::spawn({
        let (talk, code) = (a.talk.clone(), b.code.clone());
        async move { talk.hold(&code, Duration::from_secs(10), Duration::from_secs(3)).await }
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    a.talk.release(&b.code);
    assert!(tokio::time::timeout(Duration::from_secs(10), holding).await.unwrap().unwrap());

    // Ahora la pareja se va y no vuelve.
    let holding = tokio::spawn({
        let (talk, code) = (a.talk.clone(), b.code.clone());
        async move { talk.hold(&code, Duration::from_secs(10), Duration::from_secs(3)).await }
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    b.remote.shutdown().await;
    assert!(!tokio::time::timeout(Duration::from_secs(60), holding).await.unwrap().unwrap());
}

/// Una foto con un id que no es un uuid (`../`, ruta absoluta) no se guarda:
/// el id forma el nombre del archivo.
#[tokio::test]
async fn image_id_cannot_escape_the_chat_folder() {
    use iroh::endpoint::presets;
    use iroh::{Endpoint, EndpointAddr};

    let b = side("beto").await;
    let attacker = Endpoint::builder(presets::Minimal)
        .relay_mode(iroh::RelayMode::Disabled)
        .bind()
        .await
        .unwrap();
    let id: iroh::EndpointId = b.code.parse().unwrap();
    let conn = attacker.connect(EndpointAddr::new(id).with_ip_addr(b.addr), pasalo_core::TALK_ALPN).await.unwrap();
    let escape = b._dir.path().join("escapado");
    for bad in ["../../escapado", escape.to_str().unwrap()] {
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        let frame = serde_json::json!({
            "type": "chat", "id": bad, "ts": 1, "name": "x", "text": null, "image": { "ext": "txt", "size": 4 }
        });
        let json = serde_json::to_vec(&frame).unwrap();
        send.write_all(&(json.len() as u32).to_be_bytes()).await.unwrap();
        send.write_all(&json).await.unwrap();
        send.write_all(b"evil").await.unwrap();
        send.finish().unwrap();
        // Sin acuse: el otro lado corta el stream.
        assert!(tokio::time::timeout(Duration::from_secs(5), recv.read_to_end(1024)).await.unwrap().map_or(true, |d| d.is_empty()));
    }
    assert!(!escape.with_extension("txt").exists());
    assert!(!b._dir.path().join("escapado.txt").exists());
    attacker.close().await;
}

#[tokio::test]
async fn voice_note_arrives_whole() {
    let (mut a, mut b) = pair().await;
    let note: Vec<u8> = (0..50_000u32).map(|i| (i * 3) as u8).collect();
    a.talk.send_audio(&b.code, &note, "webm", 4200).await.unwrap();
    let (got, _) = next_chat(&mut b.events).await;
    assert_eq!(got.duration_ms, Some(4200));
    assert_eq!(std::fs::read(got.audio.unwrap()).unwrap(), note);
    let (delivered, _) = next_chat(&mut a.events).await;
    assert_eq!(delivered.status, Status::Delivered);
}

/// Una foto de una vez: se ve una sola vez, no se queda en ningún lado y
/// quien la envió se entera de que se vio.
#[tokio::test]
async fn view_once_photo() {
    let (mut a, mut b) = pair().await;
    let photo: Vec<u8> = (0..30_000u32).map(|i| (i * 11) as u8).collect();
    let sent = a.talk.send_once(&b.code, &photo, "jpg").await.unwrap();
    assert!(sent.once);

    let (got, _) = next_chat(&mut b.events).await;
    assert!(got.once && !got.opened);
    let stored = got.image.clone().unwrap();
    assert!(stored.file_name().unwrap().to_str().unwrap().starts_with(pasalo_core::ONCE_PREFIX));

    // Entregada: el que la mandó ya no la tiene.
    let (delivered, _) = next_chat(&mut a.events).await;
    assert_eq!(delivered.status, Status::Delivered);
    assert!(delivered.image.is_none());
    assert!(!sent.image.unwrap().exists());

    let (bytes, ext) = b.talk.open_once(&a.code, &got.id).await.unwrap();
    assert_eq!((bytes, ext.as_str()), (photo, "jpg"));
    assert!(!stored.exists());
    assert!(b.talk.open_once(&a.code, &got.id).await.is_err());
    assert!(b.talk.history(&a.code).iter().all(|m| m.image.is_none()));

    // Al que la mandó le llega que se vio.
    let (opened, _) = next_chat(&mut a.events).await;
    assert!(opened.opened && opened.outgoing);
}
