//! Micrófono y altavoz con cpal. Los streams de cpal no se pueden mover entre
//! hilos en todas las plataformas, así que viven en un hilo propio y [`Call`]
//! solo guarda canales para hablar con él.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};

use crate::{Mode, Receiver, Sender, Stats};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallError {
    NoInput,
    NoOutput,
    Device(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::NoInput => write!(f, "no hay micrófono"),
            CallError::NoOutput => write!(f, "no hay altavoz"),
            CallError::Device(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for CallError {}

enum Control {
    Mode(Mode),
    Stop,
}

/// Una llamada en marcha. Al soltarla se cierran el micrófono y el altavoz.
pub struct Call {
    control: mpsc::Sender<Control>,
    receiver: Arc<Mutex<Receiver>>,
    muted: Arc<AtomicBool>,
    stats: Arc<Stats>,
}

impl Call {
    /// Abre el micrófono y el altavoz por defecto. `send` recibe cada paquete
    /// listo para la red (no debe bloquear).
    pub fn start(mode: Mode, send: impl Fn(Vec<u8>) + Send + 'static) -> Result<Self, CallError> {
        let stats = Arc::new(Stats::default());
        let muted = Arc::new(AtomicBool::new(false));
        let (control, commands) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (receiver_tx, receiver_rx) = mpsc::channel();
        {
            let (stats, muted) = (stats.clone(), muted.clone());
            thread::Builder::new()
                .name("pasalo-call".into())
                .spawn(move || {
                    match open(mode, stats, muted, send, commands) {
                        Ok((streams, receiver, worker)) => {
                            let _ = receiver_tx.send(receiver);
                            let _ = ready_tx.send(Ok(()));
                            // Los streams viven hasta que el trabajador termina (Stop o Call soltada).
                            let _ = worker.join();
                            drop(streams);
                        }
                        Err(e) => {
                            let _ = ready_tx.send(Err(e));
                        }
                    }
                })
                .map_err(|e| CallError::Device(e.to_string()))?;
        }
        ready_rx.recv().map_err(|e| CallError::Device(e.to_string()))??;
        let receiver = receiver_rx.recv().map_err(|e| CallError::Device(e.to_string()))?;
        Ok(Self { control, receiver, muted, stats })
    }

    /// Paquete que llegó de la red.
    pub fn push(&self, packet: &[u8]) {
        self.receiver.lock().unwrap().push(packet);
    }

    pub fn set_mode(&self, mode: Mode) {
        let _ = self.control.send(Control::Mode(mode));
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }

    pub fn stats(&self) -> &Stats {
        &self.stats
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        let _ = self.control.send(Control::Stop);
    }
}

type Opened = ((Stream, Stream), Arc<Mutex<Receiver>>, thread::JoinHandle<()>);

fn open(
    mode: Mode,
    stats: Arc<Stats>,
    muted: Arc<AtomicBool>,
    send: impl Fn(Vec<u8>) + Send + 'static,
    commands: mpsc::Receiver<Control>,
) -> Result<Opened, CallError> {
    let host = cpal::default_host();
    let input = host.default_input_device().ok_or(CallError::NoInput)?;
    let output = host.default_output_device().ok_or(CallError::NoOutput)?;
    let in_config = input.default_input_config().map_err(|e| CallError::Device(e.to_string()))?;
    let out_config = output.default_output_config().map_err(|e| CallError::Device(e.to_string()))?;

    let receiver = Arc::new(Mutex::new(Receiver::new(out_config.sample_rate(), stats.clone())));
    let mut sender = Sender::new(mode, in_config.sample_rate(), stats, muted);

    // El callback del micrófono solo copia; codificar va en otro hilo.
    let (samples_tx, samples_rx) = mpsc::channel::<Vec<f32>>();
    let in_stream = build_input(&input, in_config.sample_format(), in_config.into(), samples_tx)?;
    let out_stream = build_output(&output, out_config.sample_format(), out_config.into(), receiver.clone())?;
    in_stream.play().map_err(|e| CallError::Device(e.to_string()))?;
    out_stream.play().map_err(|e| CallError::Device(e.to_string()))?;

    let worker = thread::Builder::new()
        .name("pasalo-call-enc".into())
        .spawn(move || {
            loop {
                match commands.try_recv() {
                    Ok(Control::Mode(mode)) => sender.set_mode(mode),
                    Ok(Control::Stop) | Err(mpsc::TryRecvError::Disconnected) => return,
                    Err(mpsc::TryRecvError::Empty) => {}
                }
                match samples_rx.recv_timeout(std::time::Duration::from_millis(100)) {
                    Ok(samples) => {
                        for packet in sender.push(&samples) {
                            send(packet);
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
        })
        .map_err(|e| CallError::Device(e.to_string()))?;
    Ok(((in_stream, out_stream), receiver, worker))
}

fn build_input(
    device: &cpal::Device,
    format: SampleFormat,
    config: StreamConfig,
    tx: mpsc::Sender<Vec<f32>>,
) -> Result<Stream, CallError> {
    let channels = config.channels as usize;
    let err = |e| tracing::warn!("error del micrófono: {e}");
    macro_rules! input {
        ($t:ty, $conv:expr) => {
            device.build_input_stream::<$t, _, _>(
                config,
                move |data: &[$t], _| {
                    let mono = data.chunks(channels).map(|c| c.iter().map(|&s| $conv(s)).sum::<f32>() / channels as f32);
                    let _ = tx.send(mono.collect());
                },
                err,
                None,
            )
        };
    }
    let stream = match format {
        SampleFormat::F32 => input!(f32, |s: f32| s),
        SampleFormat::I16 => input!(i16, |s: i16| s as f32 / 32768.0),
        SampleFormat::I32 => input!(i32, |s: i32| s as f32 / 2_147_483_648.0),
        SampleFormat::U16 => input!(u16, |s: u16| (s as f32 - 32768.0) / 32768.0),
        other => return Err(CallError::Device(format!("formato de micrófono no soportado: {other}"))),
    };
    stream.map_err(|e| CallError::Device(e.to_string()))
}

fn build_output(
    device: &cpal::Device,
    format: SampleFormat,
    config: StreamConfig,
    receiver: Arc<Mutex<Receiver>>,
) -> Result<Stream, CallError> {
    let channels = config.channels as usize;
    let err = |e| tracing::warn!("error del altavoz: {e}");
    macro_rules! output {
        ($t:ty, $conv:expr) => {{
            let mut mono = Vec::new();
            device.build_output_stream::<$t, _, _>(
                config,
                move |data: &mut [$t], _| {
                    mono.resize(data.len() / channels, 0.0);
                    receiver.lock().unwrap().pull(&mut mono);
                    for (frame, &s) in data.chunks_mut(channels).zip(&mono) {
                        frame.fill($conv(s));
                    }
                },
                err,
                None,
            )
        }};
    }
    let stream = match format {
        SampleFormat::F32 => output!(f32, |s: f32| s),
        SampleFormat::I16 => output!(i16, |s: f32| (s.clamp(-1.0, 1.0) * 32767.0) as i16),
        SampleFormat::I32 => output!(i32, |s: f32| (s.clamp(-1.0, 1.0) * 2_147_483_647.0) as i32),
        SampleFormat::U16 => output!(u16, |s: f32| (s.clamp(-1.0, 1.0) * 32767.0 + 32768.0) as u16),
        other => return Err(CallError::Device(format!("formato de altavoz no soportado: {other}"))),
    };
    stream.map_err(|e| CallError::Device(e.to_string()))
}
