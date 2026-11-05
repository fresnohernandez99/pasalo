use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use pasalo_core::protocol::{DISCOVERY_PORT, TRANSFER_PORT};
use pasalo_core::{Direction, Discovery, Event, LocalInfo, Receiver, Remote, SendOptions, Talk, Target};
use tokio::sync::mpsc;

mod talk;

#[derive(Parser)]
#[command(name = "pasalo", version, about = "Transferencia de archivos en la LAN o entre redes, con reanudación")]
struct Cli {
    /// Nombre con el que te ven los demás (por defecto, el del equipo)
    #[arg(long, global = true)]
    name: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Recibe archivos y textos
    Listen {
        /// Carpeta de destino (por defecto, Descargas/Pasalo)
        #[arg(long)]
        dir: Option<PathBuf>,
        #[arg(long, default_value_t = TRANSFER_PORT)]
        port: u16,
        /// Contesta solo las llamadas de voz (para probar)
        #[arg(long)]
        answer: bool,
        /// Modo de voz al contestar: high, normal, low o minimum
        #[arg(long, default_value = "normal")]
        mode: String,
        /// Audio que se envía en las llamadas (PCM mono 16 bits, 48 kHz)
        #[arg(long)]
        voice_in: Option<PathBuf>,
        /// Dónde grabar el audio que llega en las llamadas
        #[arg(long)]
        voice_out: Option<PathBuf>,
    },
    /// Lista los equipos visibles en la red
    Peers {
        /// Segundos de espera
        #[arg(long, default_value_t = 3)]
        wait: u64,
    },
    /// Envía archivos o carpetas a un equipo (IP, IP:puerto, nombre o código remoto)
    Send {
        target: String,
        #[arg(required = true)]
        paths: Vec<PathBuf>,
        /// Reconexiones automáticas si se corta
        #[arg(long, default_value_t = 30)]
        retries: u32,
    },
    /// Envía un texto a un equipo (IP, IP:puerto, nombre o código remoto)
    Text { target: String, text: String },
    /// Manda un mensaje de chat (cifrado) a un equipo por su código o su nombre en la red
    Chat {
        target: String,
        text: Option<String>,
        /// Imagen que adjuntar
        #[arg(long)]
        image: Option<PathBuf>,
        /// Segundos que quedarse escuchando respuestas
        #[arg(long, default_value_t = 0)]
        wait: u64,
    },
    /// Llamada de voz de prueba: el audio sale de un archivo y lo que llega se graba
    Call {
        target: String,
        /// high, normal, low o minimum
        #[arg(long, default_value = "normal")]
        mode: String,
        /// Audio que se envía (PCM mono 16 bits, 48 kHz; se repite)
        #[arg(long)]
        voice_in: Option<PathBuf>,
        /// Dónde grabar lo que llega
        #[arg(long)]
        voice_out: Option<PathBuf>,
        #[arg(long, default_value_t = 20)]
        seconds: u64,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .init();
    let cli = Cli::parse();

    // PASALO_CONFIG_DIR permite simular varios equipos en la misma máquina.
    let config_dir = std::env::var_os("PASALO_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::config_dir().map(|d| d.join("pasalo")))
        .context("no se encontró la carpeta de configuración")?;
    let device_id = pasalo_core::load_or_create_device_id(&config_dir.join("device_id"))?;
    let name = cli.name.unwrap_or_else(pasalo_core::default_device_name);
    let mut local = LocalInfo::new(device_id, name);
    let (tx, mut rx) = mpsc::unbounded_channel();

    match cli.command {
        Command::Listen { dir, port, answer, mode, voice_in, voice_out } => {
            let mode = talk::parse_mode(&mode)?;
            let dir = match dir {
                Some(dir) => dir,
                None => dirs::download_dir()
                    .or_else(dirs::home_dir)
                    .context("no se encontró la carpeta de descargas")?
                    .join("Pasalo"),
            };
            let listener = Receiver::bind(port)
                .await
                .with_context(|| format!("no se pudo abrir el puerto {port}"))?;
            local.transfer_port = listener.local_addr()?.port();
            let remote = Remote::start(Some(&config_dir.join("remote_key")))
                .await
                .inspect_err(|e| eprintln!("Sin conexiones remotas: {e}"))
                .ok();
            if let Some(remote) = &remote {
                local.code = Some(remote.code());
                local.remote_port = remote.port();
            }
            let talk = remote.clone().map(|r| Talk::new(r, local.name.clone(), config_dir.join("chat"), tx.clone()));
            let _discovery = Discovery::start(local.clone(), DISCOVERY_PORT, tx.clone())
                .await
                .context("no se pudo iniciar el descubrimiento")?;
            println!(
                "Recibiendo en {} como \"{}\" (puerto {}). Ctrl+C para salir.",
                dir.display(),
                local.name,
                local.transfer_port
            );
            if let Some(remote) = &remote {
                println!("Código para recibir desde otras redes: {}", remote.code());
            }
            let receiver = Receiver::new(dir, local, tx);
            if let Some(remote) = remote {
                let (receiver, talk) = (receiver.clone(), talk.clone());
                tokio::spawn(async move { receiver.run_remote(remote, talk).await });
            }
            tokio::spawn(async move { receiver.run(listener).await });
            let files = talk::VoiceFiles { input: voice_in, output: voice_out };
            while let Some(event) = rx.recv().await {
                if let (Some(talk), Event::PeerFound(peer)) = (&talk, &event)
                    && let (Some(code), Some(addr)) = (&peer.code, peer.remote_addr)
                {
                    talk.set_lan_addr(code, addr);
                }
                match (&talk, event) {
                    (Some(talk), Event::Signal { peer, name, signal }) if signal.kind == "invite" => {
                        println!("Llamada de {name} ({:?})", signal.data);
                        if answer
                            && let Err(e) = talk::answer(talk, &mut rx, &peer, &signal.call, mode, files.clone()).await
                        {
                            println!("La llamada falló: {e:#}");
                        }
                    }
                    (_, event) => print_event(event),
                }
            }
        }
        Command::Peers { wait } => {
            let discovery = Discovery::start(local, DISCOVERY_PORT, tx).await?;
            tokio::time::sleep(Duration::from_secs(wait)).await;
            let peers = discovery.peers();
            if peers.is_empty() {
                println!("No se encontró ningún equipo.");
            }
            for peer in peers {
                println!("{:<28} {:<10} {}", peer.name, peer.platform, peer.addr);
            }
        }
        Command::Send { target, paths, retries } => {
            let target = resolve(&target, &local).await?;
            let printer = tokio::spawn(print_events(rx));
            let opts = SendOptions { max_retries: retries };
            let result = pasalo_core::send_paths(pasalo_core::new_transfer_id(), &target, &local, &paths, &opts, &tx).await;
            close(&target).await;
            drop(tx);
            let _ = printer.await;
            result?;
        }
        Command::Text { target, text } => {
            let target = resolve(&target, &local).await?;
            let result = pasalo_core::send_text(&target, &local, &text).await;
            close(&target).await;
            result?;
            println!("Texto enviado.");
        }
        Command::Chat { target, text, image, wait } => {
            let (remote, talk, peer) = talk_session(&config_dir, &local, &target, tx).await?;
            let mut sent = Vec::new();
            if let Some(text) = text {
                sent.push(talk.send_text(&peer, text).await?.id);
            }
            if let Some(path) = image {
                let bytes = std::fs::read(&path).with_context(|| format!("no se pudo leer {}", path.display()))?;
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("jpg");
                sent.push(talk.send_image(&peer, &bytes, ext).await?.id);
            }
            let deadline = tokio::time::sleep(Duration::from_secs(wait.max(30)));
            tokio::pin!(deadline);
            let started = std::time::Instant::now();
            loop {
                tokio::select! {
                    event = rx.recv() => match event {
                        Some(Event::Chat { message, .. }) if message.outgoing => {
                            sent.retain(|id| *id != message.id);
                            println!("✓ Entregado");
                            if sent.is_empty() && started.elapsed() >= Duration::from_secs(wait) { break }
                        }
                        Some(event) => print_event(event),
                        None => break,
                    },
                    _ = &mut deadline => {
                        if !sent.is_empty() { println!("Sin entregar todavía: se queda pendiente para la próxima vez."); }
                        break;
                    }
                }
            }
            remote.shutdown().await;
        }
        Command::Call { target, mode, voice_in, voice_out, seconds } => {
            let mode = talk::parse_mode(&mode)?;
            let (remote, talk, peer) = talk_session(&config_dir, &local, &target, tx).await?;
            let files = talk::VoiceFiles { input: voice_in, output: voice_out };
            let result = talk::call(&talk, &mut rx, &peer, mode, files, seconds).await;
            remote.shutdown().await;
            result?;
        }
    }
    Ok(())
}

/// Arranca iroh y el chat con la identidad de este equipo, y devuelve el
/// código de `target`: el propio código, o el de un equipo de la LAN por su
/// nombre (y entonces se le habla directo, sin internet).
async fn talk_session(
    config_dir: &std::path::Path,
    local: &LocalInfo,
    target: &str,
    tx: pasalo_core::EventSender,
) -> Result<(Remote, Talk, String)> {
    let remote = Remote::start(Some(&config_dir.join("remote_key"))).await?;
    let talk = Talk::new(remote.clone(), local.name.clone(), config_dir.join("chat"), tx.clone());
    tokio::spawn({
        let (remote, talk) = (remote.clone(), talk.clone());
        let receiver = Receiver::new(std::env::temp_dir(), local.clone(), tx);
        async move { receiver.run_remote(remote, Some(talk)).await }
    });
    if pasalo_core::parse_code(target).is_some() {
        return Ok((remote, talk, target.to_string()));
    }
    let (found_tx, mut found) = mpsc::unbounded_channel();
    let _discovery = Discovery::start(local.clone(), DISCOVERY_PORT, found_tx).await?;
    let deadline = tokio::time::sleep(Duration::from_secs(5));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            event = found.recv() => if let Some(Event::PeerFound(peer)) = event
                && peer.name.eq_ignore_ascii_case(target)
            {
                let (Some(code), Some(addr)) = (peer.code, peer.remote_addr) else {
                    bail!("\"{target}\" no tiene chat (versión antigua o sin conexiones remotas)");
                };
                talk.set_lan_addr(&code, addr);
                return Ok((remote, talk, code));
            },
            _ = &mut deadline => bail!("no se encontró \"{target}\" en la red"),
        }
    }
}

/// Acepta `IP:puerto`, `IP`, el código de un equipo remoto o el nombre de un
/// equipo visible en la red.
async fn resolve(target: &str, local: &LocalInfo) -> Result<Target> {
    if let Ok(addr) = target.parse::<SocketAddr>() {
        return Ok(Target::Lan(addr));
    }
    if let Ok(ip) = target.parse::<IpAddr>() {
        return Ok(Target::Lan(SocketAddr::new(ip, TRANSFER_PORT)));
    }
    if let Some(code) = pasalo_core::parse_code(target) {
        // Para enviar basta un código de usar y tirar.
        let remote = Remote::start(None).await.context("no se pudo iniciar la conexión remota")?;
        return Ok(Target::Remote(remote, code));
    }
    let (tx, mut rx) = mpsc::unbounded_channel();
    let discovery = Discovery::start(local.clone(), DISCOVERY_PORT, tx).await?;
    let deadline = tokio::time::sleep(Duration::from_secs(3));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Some(Event::PeerFound(peer)) if peer.name.eq_ignore_ascii_case(target) => return Ok(Target::Lan(peer.addr)),
                Some(_) => {}
                None => break,
            },
            _ = &mut deadline => break,
        }
    }
    let visible: Vec<String> = discovery.peers().into_iter().map(|p| p.name).collect();
    match visible.is_empty() {
        true => bail!("no se encontró \"{target}\" y no hay ningún equipo visible"),
        false => bail!("no se encontró \"{target}\"; equipos visibles: {}", visible.join(", ")),
    }
}

/// Cierra la conexión remota avisando al otro lado.
async fn close(target: &Target) {
    if let Target::Remote(remote, _) = target {
        remote.shutdown().await;
    }
}

async fn print_events(mut rx: mpsc::UnboundedReceiver<Event>) {
    while let Some(event) = rx.recv().await {
        print_event(event);
    }
}

fn print_event(event: Event) {
    {
        match event {
            Event::PeerFound(peer) => println!("+ {} ({}, {})", peer.name, peer.platform, peer.addr),
            Event::PeerLost { .. } => {}
            Event::TransferStarted { direction, peer, files, total_bytes, resumed_bytes, .. } => {
                let verb = match direction {
                    Direction::Incoming => "Recibiendo de",
                    Direction::Outgoing => "Enviando a",
                };
                print!("{verb} {peer}: {files} archivo(s), {}", human(total_bytes));
                if resumed_bytes > 0 {
                    print!(", reanudando desde {}", human(resumed_bytes));
                }
                println!();
            }
            Event::Progress { done_bytes, total_bytes, .. } => {
                let pct = match total_bytes {
                    0 => 100.0,
                    total => done_bytes as f64 * 100.0 / total as f64,
                };
                print!("\r  {pct:5.1}%  {} / {}      ", human(done_bytes), human(total_bytes));
                let _ = std::io::stdout().flush();
            }
            Event::TransferFinished { saved, .. } => {
                println!("\n✓ Completado");
                for path in saved {
                    println!("  → {}", path.display());
                }
            }
            Event::TransferFailed { error, will_retry, .. } => {
                println!("\n✗ {error}{}", if will_retry { " (reintentando…)" } else { "" });
            }
            Event::TextReceived { from, text } => println!("Texto de {from}:\n{text}"),
            Event::Chat { message, name } if !message.outgoing => {
                let from = name.unwrap_or_else(|| message.peer[..8].to_string());
                match (&message.text, &message.image) {
                    (Some(text), _) => println!("💬 {from}: {text}"),
                    (None, Some(path)) => println!("🖼  {from}: {}", path.display()),
                    _ => {}
                }
            }
            Event::Chat { .. } => {}
            Event::Signal { name, signal, .. } => println!("📞 {name}: {}", signal.kind),
        }
    }
}

fn human(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    match unit {
        0 => format!("{bytes} B"),
        _ => format!("{value:.1} {}", UNITS[unit]),
    }
}
