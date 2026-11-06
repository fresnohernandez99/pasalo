//! Chat y llamadas desde el CLI, pensado sobre todo para probar contra la
//! app: la voz sale de un archivo y lo que llega se graba en otro (PCM mono
//! de 16 bits a 48 kHz), así no hacen falta micrófono ni altavoz.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use pasalo_call::{Mode, Receiver as VoiceReceiver, Sender as VoiceSender, Stats};
use pasalo_core::{Event, Signal, Talk};
use tokio::sync::{Mutex, mpsc};

const RATE: u32 = 48_000;
const STEP: usize = 480; // 10 ms

/// Audio de entrada y salida de una llamada del CLI.
#[derive(Clone, Default)]
pub struct VoiceFiles {
    pub input: Option<PathBuf>,
    pub output: Option<PathBuf>,
}

pub fn parse_mode(mode: &str) -> Result<Mode> {
    serde_json::from_value(serde_json::Value::String(mode.into()))
        .with_context(|| format!("modo no válido: {mode} (high, normal, low, minimum)"))
}

fn signal(call: &str, kind: &str, data: serde_json::Value) -> Signal {
    Signal { call: call.into(), kind: kind.into(), data }
}

/// Llama a `peer`, espera a que conteste y habla durante `seconds`.
pub async fn call(
    talk: &Talk,
    events: &mut mpsc::UnboundedReceiver<Event>,
    peer: &str,
    mode: Mode,
    files: VoiceFiles,
    seconds: u64,
) -> Result<()> {
    let id = uuid_like();
    let mode_name = serde_json::to_value(mode)?;
    talk.signal(peer, signal(&id, "invite", serde_json::json!({ "media": "voice", "mode": mode_name })))
        .await
        .context("no se pudo avisar al otro equipo")?;
    println!("Llamando…");
    let deadline = tokio::time::sleep(Duration::from_secs(45));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Some(Event::Signal { signal, .. }) if signal.call == id => match signal.kind.as_str() {
                    "accept" => break,
                    other => bail!("la llamada terminó: {other}"),
                },
                Some(_) => {}
                None => bail!("sin eventos"),
            },
            _ = &mut deadline => bail!("no contestó"),
        }
    }
    println!("Contestó. Hablando {seconds} s en modo {mode:?}.");
    let result = talk_for(talk, events, peer, &id, mode, files, seconds).await;
    let _ = talk.signal(peer, signal(&id, "hangup", serde_json::Value::Null)).await;
    result
}

/// Contesta una llamada entrante (desde `listen --answer`).
pub async fn answer(
    talk: &Talk,
    events: &mut mpsc::UnboundedReceiver<Event>,
    peer: &str,
    id: &str,
    mode: Mode,
    files: VoiceFiles,
) -> Result<()> {
    talk.signal(peer, signal(id, "accept", serde_json::Value::Null)).await?;
    println!("Llamada contestada en modo {mode:?}.");
    talk_for(talk, events, peer, id, mode, files, 3600).await
}

/// La llamada en sí: 10 ms de audio cada 10 ms en los dos sentidos, como
/// haría la tarjeta de sonido, hasta que cuelguen o pase `seconds`.
async fn talk_for(
    talk: &Talk,
    events: &mut mpsc::UnboundedReceiver<Event>,
    peer: &str,
    id: &str,
    mode: Mode,
    files: VoiceFiles,
    seconds: u64,
) -> Result<()> {
    let input = match &files.input {
        Some(path) => read_pcm(path)?,
        None => vec![0.0; RATE as usize],
    };
    let mut link = talk.voice(peer).await?;
    let stats = Arc::new(Stats::default());
    let mut voice = VoiceSender::new(mode, RATE, stats.clone(), Arc::new(AtomicBool::new(false)));
    // Audio de archivos: no hay eco que quitar.
    voice.set_echo_gate(false);
    let sender = Arc::new(Mutex::new(voice));
    let receiver = Arc::new(Mutex::new(VoiceReceiver::new(RATE, stats.clone())));

    let incoming = {
        let receiver = receiver.clone();
        tokio::spawn(async move {
            while let Some(packet) = link.rx.recv().await {
                receiver.lock().await.push(&packet);
            }
        })
    };

    let start = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(10));
    let mut pos = 0;
    let mut recorded: Vec<i16> = Vec::new();
    let mut buf = vec![0.0f32; STEP];
    let mut last_report = Instant::now();
    let mut window = Window::new(&stats, &link.sender);
    let mut ended = None;
    while start.elapsed() < Duration::from_secs(seconds) {
        tokio::select! {
            _ = tick.tick() => {
                let chunk: Vec<f32> = (0..STEP).map(|i| input[(pos + i) % input.len()]).collect();
                pos += STEP;
                for packet in sender.lock().await.push(&chunk) {
                    link.sender.send(packet.into());
                }
                receiver.lock().await.pull(&mut buf);
                recorded.extend(buf.iter().map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16));
                if last_report.elapsed() >= Duration::from_secs(2) {
                    last_report = Instant::now();
                    window.report(&stats, &link.sender, start.elapsed());
                }
            }
            event = events.recv() => match event {
                Some(Event::Signal { signal, .. }) if signal.call == id => match signal.kind.as_str() {
                    "hangup" => { ended = Some("colgó el otro lado"); break; }
                    "mode" => if let Some(m) = signal.data.get("mode").and_then(|m| parse_mode(m.as_str()?).ok()) {
                        println!("El otro lado cambió al modo {m:?}");
                        sender.lock().await.set_mode(m);
                    },
                    _ => {}
                },
                Some(Event::TalkLost { peer: lost }) if pasalo_core::parse_code(&lost) == pasalo_core::parse_code(peer) => {
                    ended = Some("se perdió la conexión");
                    break;
                }
                Some(_) => {}
                None => break,
            },
        }
    }
    incoming.abort();
    talk.end_voice(peer);
    window.report(&stats, &link.sender, start.elapsed());
    if let Some(reason) = ended {
        println!("Fin: {reason}.");
    }
    if let Some(path) = &files.output {
        let bytes: Vec<u8> = recorded.iter().flat_map(|s| s.to_le_bytes()).collect();
        std::fs::write(path, bytes).with_context(|| format!("no se pudo escribir {}", path.display()))?;
        println!("Audio recibido en {}", path.display());
    }
    Ok(())
}

/// Ritmo de la llamada en el último intervalo. Lo "medido" sale de los
/// contadores UDP de la conexión (todo lo que pasa por ella); lo "estimado",
/// del tamaño de los paquetes de voz más una cabecera fija. Se mide por
/// intervalos porque abrir la conexión cuesta unos 30 KB de una vez (saludo
/// TLS y sondeo de rutas de iroh) y en una media desde el principio pesaría.
struct Window {
    at: Instant,
    wire: (u64, u64),
    estimate: (u64, u64),
}

impl Window {
    fn new(stats: &Stats, link: &pasalo_core::VoiceSender) -> Self {
        Self { at: Instant::now(), wire: link.wire_bytes(), estimate: (stats.wire_bytes_sent(), stats.wire_bytes_received()) }
    }

    fn report(&mut self, stats: &Stats, link: &pasalo_core::VoiceSender, elapsed: Duration) {
        let now = Self::new(stats, link);
        let secs = now.at.duration_since(self.at).as_secs_f64().max(0.001);
        let kbps = |a: u64, b: u64| a.saturating_sub(b) as f64 * 8.0 / secs / 1000.0;
        println!(
            "  {:>5.1} s · medido ↑ {:.1} ↓ {:.1} kbps · estimado ↑ {:.1} ↓ {:.1} kbps · perdidos {} (recuperados {})",
            elapsed.as_secs_f64(),
            kbps(now.wire.0, self.wire.0),
            kbps(now.wire.1, self.wire.1),
            kbps(now.estimate.0, self.estimate.0),
            kbps(now.estimate.1, self.estimate.1),
            stats.lost_packets.load(Ordering::Relaxed),
            stats.recovered_packets.load(Ordering::Relaxed),
        );
        *self = now;
    }
}

fn read_pcm(path: &Path) -> Result<Vec<f32>> {
    let bytes = std::fs::read(path).with_context(|| format!("no se pudo leer {}", path.display()))?;
    let samples: Vec<f32> = bytes.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b) as f32 / 32768.0).collect();
    if samples.is_empty() {
        bail!("{} está vacío", path.display());
    }
    Ok(samples)
}

fn uuid_like() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    format!("cli-{nanos:x}")
}
