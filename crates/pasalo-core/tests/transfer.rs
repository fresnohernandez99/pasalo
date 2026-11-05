use std::net::SocketAddr;
use std::path::Path;

use pasalo_core::{
    Direction, Error, Event, LocalInfo, Receiver, SendOptions, Target, new_transfer_id, send_paths, send_text,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

const MIB: usize = 1024 * 1024;

fn data(len: usize, mut seed: u64) -> Vec<u8> {
    (0..len)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed as u8
        })
        .collect()
}

async fn start_receiver(dest: &Path) -> (SocketAddr, mpsc::UnboundedReceiver<Event>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let receiver = Receiver::new(dest, LocalInfo::new("receptor-id", "receptor"), tx);
    tokio::spawn(async move { receiver.run(listener).await });
    (addr, rx)
}

/// Proxy que corta la conexión después de reenviar `limit` bytes hacia el receptor.
async fn cutting_proxy(target: SocketAddr, limit: usize) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut client, _) = listener.accept().await.unwrap();
        let mut server = TcpStream::connect(target).await.unwrap();
        let (mut client_rd, mut client_wr) = client.split();
        let (mut server_rd, mut server_wr) = server.split();
        let upstream = async {
            let mut buf = vec![0; 64 * 1024];
            let mut sent = 0;
            while sent < limit {
                let want = (limit - sent).min(buf.len());
                let n = client_rd.read(&mut buf[..want]).await.unwrap_or(0);
                if n == 0 || server_wr.write_all(&buf[..n]).await.is_err() {
                    break;
                }
                sent += n;
            }
        };
        let downstream = async {
            let _ = tokio::io::copy(&mut server_rd, &mut client_wr).await;
        };
        tokio::select! {
            _ = upstream => {}
            _ = downstream => {}
        }
    });
    addr
}

fn incoming_starts(rx: &mut mpsc::UnboundedReceiver<Event>) -> Vec<u64> {
    let mut resumed = Vec::new();
    while let Ok(event) = rx.try_recv() {
        if let Event::TransferStarted { direction: Direction::Incoming, resumed_bytes, .. } = event {
            resumed.push(resumed_bytes);
        }
    }
    resumed
}

#[tokio::test]
async fn resumes_interrupted_transfer() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let folder = src.path().join("Fotos");
    std::fs::create_dir_all(folder.join("sub")).unwrap();
    std::fs::create_dir_all(folder.join("vacia")).unwrap();
    let big = data(8 * MIB, 1);
    let small = data(1000, 2);
    std::fs::write(folder.join("a.bin"), &small).unwrap();
    std::fs::write(folder.join("vacio.txt"), b"").unwrap();
    std::fs::write(folder.join("sub/grande.bin"), &big).unwrap();

    let (addr, mut events) = start_receiver(dst.path()).await;
    let sender = LocalInfo::new("emisor-id", "emisor");
    let (tx, _rx) = mpsc::unbounded_channel();
    let no_retry = SendOptions { max_retries: 0 };

    let proxy = cutting_proxy(addr, 3 * MIB).await;
    let cut = send_paths(new_transfer_id(), &Target::Lan(proxy), &sender, std::slice::from_ref(&folder), &no_retry, &tx).await;
    assert!(cut.is_err(), "el primer intento debía cortarse");

    send_paths(new_transfer_id(), &Target::Lan(addr), &sender, std::slice::from_ref(&folder), &no_retry, &tx).await.unwrap();

    let out = dst.path().join("Fotos");
    assert_eq!(std::fs::read(out.join("sub/grande.bin")).unwrap(), big);
    assert_eq!(std::fs::read(out.join("a.bin")).unwrap(), small);
    assert_eq!(std::fs::read(out.join("vacio.txt")).unwrap(), b"");
    assert!(out.join("vacia").is_dir());
    assert!(!out.join("sub/grande.bin.pasalo-part").exists());
    assert!(!dst.path().join(".pasalo").exists());

    let starts = incoming_starts(&mut events);
    assert_eq!(starts.len(), 2);
    assert_eq!(starts[0], 0);
    assert!(starts[1] > 2 * MIB as u64, "debía reanudar, no empezar de cero: {starts:?}");
}

#[tokio::test]
async fn retries_on_its_own() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let file = src.path().join("video.mp4");
    let content = data(4 * MIB, 3);
    std::fs::write(&file, &content).unwrap();

    let (addr, _events) = start_receiver(dst.path()).await;
    // Proxy que corta el primer intento y deja pasar el resto.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let mut first = true;
        loop {
            let (mut client, _) = listener.accept().await.unwrap();
            let limit = if first { MIB } else { usize::MAX };
            first = false;
            tokio::spawn(async move {
                let mut server = TcpStream::connect(addr).await.unwrap();
                let (mut client_rd, mut client_wr) = client.split();
                let (mut server_rd, mut server_wr) = server.split();
                let upstream = async {
                    let mut buf = vec![0; 64 * 1024];
                    let mut sent = 0;
                    while sent < limit {
                        let want = (limit - sent).min(buf.len());
                        let n = client_rd.read(&mut buf[..want]).await.unwrap_or(0);
                        if n == 0 || server_wr.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                        sent += n;
                    }
                };
                let downstream = async {
                    let _ = tokio::io::copy(&mut server_rd, &mut client_wr).await;
                };
                tokio::select! {
                    _ = upstream => {}
                    _ = downstream => {}
                }
            });
        }
    });

    let (tx, mut rx) = mpsc::unbounded_channel();
    let sender = LocalInfo::new("emisor-id", "emisor");
    send_paths(new_transfer_id(), &Target::Lan(proxy), &sender, &[file], &SendOptions { max_retries: 3 }, &tx).await.unwrap();
    assert_eq!(std::fs::read(dst.path().join("video.mp4")).unwrap(), content);

    let mut retried = false;
    while let Ok(event) = rx.try_recv() {
        if let Event::TransferFailed { will_retry: true, .. } = event {
            retried = true;
        }
    }
    assert!(retried);
}

#[tokio::test]
async fn renames_on_collision() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let file = src.path().join("nota.txt");
    std::fs::write(&file, b"hola").unwrap();

    let (addr, _events) = start_receiver(dst.path()).await;
    let (tx, _rx) = mpsc::unbounded_channel();
    let opts = SendOptions::default();
    let sender = LocalInfo::new("emisor-id", "emisor");
    send_paths(new_transfer_id(), &Target::Lan(addr), &sender, std::slice::from_ref(&file), &opts, &tx).await.unwrap();
    send_paths(new_transfer_id(), &Target::Lan(addr), &sender, &[file], &opts, &tx).await.unwrap();

    assert!(dst.path().join("nota.txt").exists());
    assert!(dst.path().join("nota (1).txt").exists());
}

#[tokio::test]
async fn receives_text() {
    let dst = tempfile::tempdir().unwrap();
    let (addr, mut events) = start_receiver(dst.path()).await;
    send_text(&Target::Lan(addr), &LocalInfo::new("emisor-id", "emisor"), "hola mundo").await.unwrap();
    let text = loop {
        if let Some(Event::TextReceived { from, text }) = events.recv().await {
            assert_eq!(from, "emisor");
            break text;
        }
    };
    assert_eq!(text, "hola mundo");
}

#[tokio::test]
async fn rejects_paths_outside_destination() {
    let dst = tempfile::tempdir().unwrap();
    let (addr, _events) = start_receiver(dst.path()).await;
    let mut stream = TcpStream::connect(addr).await.unwrap();

    async fn send(stream: &mut TcpStream, json: &str) {
        stream.write_u32(json.len() as u32).await.unwrap();
        stream.write_all(json.as_bytes()).await.unwrap();
    }
    async fn recv(stream: &mut TcpStream) -> String {
        let len = stream.read_u32().await.unwrap() as usize;
        let mut buf = vec![0; len];
        stream.read_exact(&mut buf).await.unwrap();
        String::from_utf8(buf).unwrap()
    }

    send(&mut stream, r#"{"type":"hello","version":1,"device_id":"x","name":"x","platform":"x"}"#).await;
    assert!(recv(&mut stream).await.contains("hello"));
    send(
        &mut stream,
        r#"{"type":"offer","items":[{"path":"../fuera.txt","size":1,"mtime":0,"is_dir":false}],"text":null}"#,
    )
    .await;
    assert!(recv(&mut stream).await.contains("reject"));
    assert!(!dst.path().parent().unwrap().join("fuera.txt").exists());
}

#[test]
fn rejected_is_not_retried() {
    assert!(!Error::Rejected("no".into()).is_retryable());
    assert!(Error::Timeout.is_retryable());
}

#[tokio::test]
async fn probe_returns_name_without_sending() {
    let dst = tempfile::tempdir().unwrap();
    let (addr, mut events) = start_receiver(dst.path()).await;
    let greeting = pasalo_core::probe(&Target::Lan(addr), &LocalInfo::new("emisor-id", "emisor")).await.unwrap();
    assert_eq!(greeting.name, "receptor");
    assert!(events.try_recv().is_err());
    assert_eq!(std::fs::read_dir(dst.path()).unwrap().count(), 0);
}

/// Pasa por los relays y el DNS de iroh, así que necesita internet:
/// `cargo test -p pasalo-core -- --ignored`.
#[tokio::test]
#[ignore]
async fn sends_to_remote_by_code() {
    let src = tempfile::tempdir().unwrap();
    let dst = tempfile::tempdir().unwrap();
    let file = src.path().join("remoto.bin");
    let content = data(5 * MIB, 42);
    std::fs::write(&file, &content).unwrap();

    let (tx, _rx) = mpsc::unbounded_channel();
    let listening = pasalo_core::Remote::start(None).await.unwrap();
    let receiver = Receiver::new(dst.path(), LocalInfo::new("receptor-id", "receptor"), tx.clone());
    tokio::spawn({
        let listening = listening.clone();
        async move { receiver.run_remote(listening).await }
    });
    listening.online().await;

    let code = pasalo_core::parse_code(&listening.code()).unwrap();
    let dialing = pasalo_core::Remote::start(None).await.unwrap();
    let target = Target::Remote(dialing.clone(), code);
    let sender = LocalInfo::new("emisor-id", "emisor");
    assert_eq!(pasalo_core::probe(&target, &sender).await.unwrap().name, "receptor");
    send_paths(new_transfer_id(), &target, &sender, &[file], &SendOptions::default(), &tx).await.unwrap();
    assert_eq!(std::fs::read(dst.path().join("remoto.bin")).unwrap(), content);

    dialing.shutdown().await;
    listening.shutdown().await;
}
