//! Chat y señales entre dos equipos en el mismo proceso. Se conectan por su
//! dirección local de iroh, como dos equipos de la LAN, así que no hace falta
//! internet.

use std::net::SocketAddr;
use std::time::Duration;

use pasalo_core::{ChatMessage, Event, LocalInfo, Receiver, Remote, Signal, Status, Talk};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

struct Side {
    talk: Talk,
    code: String,
    addr: SocketAddr,
    events: UnboundedReceiver<Event>,
    _dir: tempfile::TempDir,
}

async fn side(name: &str) -> Side {
    let dir = tempfile::tempdir().unwrap();
    let remote = Remote::start(None).await.unwrap();
    let (tx, events) = unbounded_channel();
    let talk = Talk::new(remote.clone(), name, dir.path().join("chat"), tx.clone());
    let receiver = Receiver::new(dir.path().join("in"), LocalInfo::new(name, name), tx);
    tokio::spawn({
        let (remote, talk) = (remote.clone(), talk.clone());
        async move { receiver.run_remote(remote, Some(talk)).await }
    });
    let addr = SocketAddr::from(([127, 0, 0, 1], remote.port().unwrap()));
    Side { talk, code: remote.code(), addr, events, _dir: dir }
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
    let first = Remote::start(Some(&key)).await.unwrap();
    let code = first.code();
    a.talk.set_lan_addr(&code, SocketAddr::from(([127, 0, 0, 1], first.port().unwrap())));
    first.shutdown().await;
    drop(first);
    let sent = a.talk.send_text(&code, "¿estás?".into()).await.unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(a.talk.history(&code)[0].status, Status::Pending);

    // Vuelve con la misma clave (mismo código) y otro puerto. El
    // descubrimiento avisaría de la dirección nueva; aquí se hace a mano.
    let remote = Remote::start(Some(&key)).await.unwrap();
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
    assert!(link_a.max_size() >= 1000);
    for i in 0..20u8 {
        link_a.send(bytes::Bytes::from(vec![i; 40]));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let first = tokio::time::timeout(Duration::from_secs(5), link_b.rx.recv()).await.unwrap().unwrap();
    assert_eq!(first.len(), 40);
}
