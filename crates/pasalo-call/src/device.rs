//! Micrófono y altavoz: con cpal en escritorio y con AAudio en Android (ver
//! [`platform`]). Los streams no se pueden mover entre hilos en todas las
//! plataformas, así que viven en un hilo propio y [`Call`] solo guarda
//! canales para hablar con él.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

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

type Opened = (platform::Streams, Arc<Mutex<Receiver>>, thread::JoinHandle<()>);

fn open(
    mode: Mode,
    stats: Arc<Stats>,
    muted: Arc<AtomicBool>,
    send: impl Fn(Vec<u8>) + Send + 'static,
    commands: mpsc::Receiver<Control>,
) -> Result<Opened, CallError> {
    let devices = platform::Devices::new()?;
    let receiver = Arc::new(Mutex::new(Receiver::new(devices.output_rate(), stats.clone())));
    let mut sender = Sender::new(mode, devices.input_rate(), stats, muted);
    sender.set_echo_gate(!devices.cancels_echo());

    // El callback del micrófono solo copia; codificar va en otro hilo.
    let (samples_tx, samples_rx) = mpsc::channel::<Vec<f32>>();
    let streams = devices.start(samples_tx, receiver.clone())?;

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
    Ok((streams, receiver, worker))
}

/// Escritorio: cpal con los dispositivos por defecto. No cancelan el eco, así
/// que con altavoces hace falta la puerta de eco del [`Sender`].
#[cfg(not(target_os = "android"))]
mod platform {
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{SampleFormat, Stream, StreamConfig, SupportedStreamConfig};

    use super::CallError;
    use crate::Receiver;

    pub type Streams = (Stream, Stream);

    pub struct Devices {
        input: cpal::Device,
        output: cpal::Device,
        in_config: SupportedStreamConfig,
        out_config: SupportedStreamConfig,
    }

    impl Devices {
        pub fn new() -> Result<Self, CallError> {
            let host = cpal::default_host();
            let input = host.default_input_device().ok_or(CallError::NoInput)?;
            let output = host.default_output_device().ok_or(CallError::NoOutput)?;
            let in_config = input.default_input_config().map_err(|e| CallError::Device(e.to_string()))?;
            let out_config = output.default_output_config().map_err(|e| CallError::Device(e.to_string()))?;
            Ok(Self { input, output, in_config, out_config })
        }

        pub fn input_rate(&self) -> u32 {
            self.in_config.sample_rate()
        }

        pub fn output_rate(&self) -> u32 {
            self.out_config.sample_rate()
        }

        pub fn cancels_echo(&self) -> bool {
            false
        }

        pub fn start(self, samples: mpsc::Sender<Vec<f32>>, receiver: Arc<Mutex<Receiver>>) -> Result<Streams, CallError> {
            let in_stream = build_input(&self.input, self.in_config.sample_format(), self.in_config.into(), samples)?;
            let out_stream = build_output(&self.output, self.out_config.sample_format(), self.out_config.into(), receiver)?;
            in_stream.play().map_err(|e| CallError::Device(e.to_string()))?;
            out_stream.play().map_err(|e| CallError::Device(e.to_string()))?;
            Ok((in_stream, out_stream))
        }
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
}

/// Android: AAudio en modo llamada (micrófono `VOICE_COMMUNICATION` y salida
/// de uso `VOICE_COMMUNICATION`), que activa la cancelación de eco, la
/// supresión de ruido y el control de ganancia del propio teléfono. cpal no
/// deja elegirlo y abre el micrófono como para reconocer voz, sin nada de eso.
///
/// Esas tres funciones son de Android 9 (API 28) y la app llega hasta la 26,
/// así que se buscan al abrir: en Android 8 se queda sin ellas y se usa la
/// puerta de eco, como en escritorio.
#[cfg(target_os = "android")]
mod platform {
    use std::ffi::{CStr, c_void};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex, OnceLock};
    use std::thread;
    use std::time::Duration;

    use super::CallError;
    use crate::Receiver;

    /// Se pide siempre esta; si el hardware va a otra, AAudio convierte.
    const RATE: u32 = 48_000;

    #[repr(C)]
    struct Builder(c_void);
    #[repr(C)]
    struct RawStream(c_void);

    type DataCallback = extern "C" fn(*mut RawStream, *mut c_void, *mut c_void, i32) -> i32;
    type ErrorCallback = extern "C" fn(*mut RawStream, *mut c_void, i32);
    type SetI32 = unsafe extern "C" fn(*mut Builder, i32);

    const DIRECTION_OUTPUT: i32 = 0;
    const DIRECTION_INPUT: i32 = 1;
    const FORMAT_PCM_FLOAT: i32 = 2;
    const PERFORMANCE_MODE_LOW_LATENCY: i32 = 12;
    const CALLBACK_CONTINUE: i32 = 0;
    const USAGE_VOICE_COMMUNICATION: i32 = 2;
    const CONTENT_TYPE_SPEECH: i32 = 1;
    const INPUT_PRESET_VOICE_COMMUNICATION: i32 = 7;

    #[link(name = "aaudio")]
    unsafe extern "C" {
        fn AAudio_createStreamBuilder(builder: *mut *mut Builder) -> i32;
        fn AAudioStreamBuilder_setDirection(builder: *mut Builder, direction: i32);
        fn AAudioStreamBuilder_setFormat(builder: *mut Builder, format: i32);
        fn AAudioStreamBuilder_setChannelCount(builder: *mut Builder, count: i32);
        fn AAudioStreamBuilder_setSampleRate(builder: *mut Builder, rate: i32);
        fn AAudioStreamBuilder_setPerformanceMode(builder: *mut Builder, mode: i32);
        fn AAudioStreamBuilder_setDataCallback(builder: *mut Builder, callback: DataCallback, user: *mut c_void);
        fn AAudioStreamBuilder_setErrorCallback(builder: *mut Builder, callback: ErrorCallback, user: *mut c_void);
        fn AAudioStreamBuilder_openStream(builder: *mut Builder, stream: *mut *mut RawStream) -> i32;
        fn AAudioStreamBuilder_delete(builder: *mut Builder) -> i32;
        fn AAudioStream_requestStart(stream: *mut RawStream) -> i32;
        fn AAudioStream_close(stream: *mut RawStream) -> i32;
    }

    unsafe extern "C" {
        fn dlopen(name: *const std::ffi::c_char, flags: i32) -> *mut c_void;
        fn dlsym(handle: *mut c_void, name: *const std::ffi::c_char) -> *mut c_void;
    }

    /// Las funciones de Android 9, si las hay.
    struct CallMode {
        input_preset: SetI32,
        usage: SetI32,
        content_type: SetI32,
    }

    fn call_mode() -> Option<&'static CallMode> {
        static FOUND: OnceLock<Option<CallMode>> = OnceLock::new();
        FOUND
            .get_or_init(|| {
                const RTLD_NOW: i32 = 2;
                // SAFETY: dlopen/dlsym con nombres terminados en nul; los punteros
                // que devuelven son funciones con la firma de la NDK.
                unsafe {
                    let lib = dlopen(c"libaaudio.so".as_ptr(), RTLD_NOW);
                    if lib.is_null() {
                        return None;
                    }
                    let find = |name: &CStr| {
                        let f = dlsym(lib, name.as_ptr());
                        (!f.is_null()).then(|| std::mem::transmute::<*mut c_void, SetI32>(f))
                    };
                    Some(CallMode {
                        input_preset: find(c"AAudioStreamBuilder_setInputPreset")?,
                        usage: find(c"AAudioStreamBuilder_setUsage")?,
                        content_type: find(c"AAudioStreamBuilder_setContentType")?,
                    })
                }
            })
            .as_ref()
    }

    /// Lo que hace cada callback con las muestras (mono, f32).
    type Handler = Box<dyn FnMut(&mut [f32]) + Send>;

    /// Lo que le llega al hilo que cuida los streams.
    enum Event {
        /// El stream de esa dirección se cayó (p. ej. cambió la salida de audio).
        Lost(i32),
        Stop,
    }

    /// A quién avisa el callback de error de un stream.
    struct Notify {
        direction: i32,
        events: mpsc::Sender<Event>,
    }

    /// Un stream abierto. Al soltarlo se cierra y después se liberan sus callbacks.
    struct Stream {
        raw: *mut RawStream,
        handler: *mut Handler,
        notify: *mut Notify,
    }

    // SAFETY: AAudio permite cerrar el stream desde cualquier hilo y el
    // handler solo lo toca el callback hasta entonces.
    unsafe impl Send for Stream {}

    impl Drop for Stream {
        fn drop(&mut self) {
            // SAFETY: `close` espera a que acaben los callbacks en curso;
            // después nadie más usa el handler ni el aviso.
            unsafe {
                AAudioStream_close(self.raw);
                drop(Box::from_raw(self.handler));
                drop(Box::from_raw(self.notify));
            }
        }
    }

    extern "C" fn on_data(_: *mut RawStream, user: *mut c_void, data: *mut c_void, frames: i32) -> i32 {
        // SAFETY: `user` es el Handler del stream, vivo hasta cerrarlo, y
        // `data` trae `frames` muestras mono en f32, el formato pedido.
        unsafe {
            let handler = &mut *(user as *mut Handler);
            handler(std::slice::from_raw_parts_mut(data as *mut f32, frames.max(0) as usize));
        }
        CALLBACK_CONTINUE
    }

    /// AAudio no deja cerrar ni reabrir desde aquí: se avisa al hilo que cuida
    /// los streams. Pasa sobre todo al entrar en modo llamada o cambiar entre
    /// altavoz, auricular y Bluetooth: la salida en MMAP se desconecta.
    extern "C" fn on_error(_: *mut RawStream, user: *mut c_void, error: i32) {
        tracing::warn!("error de audio: {error}");
        // SAFETY: `user` es el Notify del stream, vivo hasta cerrarlo.
        let notify = unsafe { &*(user as *const Notify) };
        let _ = notify.events.send(Event::Lost(notify.direction));
    }

    fn open(direction: i32, handler: Handler, events: mpsc::Sender<Event>) -> Result<Stream, i32> {
        let handler = Box::into_raw(Box::new(handler));
        let notify = Box::into_raw(Box::new(Notify { direction, events }));
        // SAFETY: llamadas a la NDK con un builder recién creado que se borra
        // al final; si el stream no se abre, los callbacks se liberan aquí.
        unsafe {
            let free = || {
                drop(Box::from_raw(handler));
                drop(Box::from_raw(notify));
            };
            let mut builder = std::ptr::null_mut();
            let status = AAudio_createStreamBuilder(&mut builder);
            if status < 0 {
                free();
                return Err(status);
            }
            AAudioStreamBuilder_setDirection(builder, direction);
            AAudioStreamBuilder_setFormat(builder, FORMAT_PCM_FLOAT);
            AAudioStreamBuilder_setChannelCount(builder, 1);
            AAudioStreamBuilder_setSampleRate(builder, RATE as i32);
            AAudioStreamBuilder_setPerformanceMode(builder, PERFORMANCE_MODE_LOW_LATENCY);
            if let Some(mode) = call_mode() {
                if direction == DIRECTION_INPUT {
                    (mode.input_preset)(builder, INPUT_PRESET_VOICE_COMMUNICATION);
                } else {
                    (mode.usage)(builder, USAGE_VOICE_COMMUNICATION);
                    (mode.content_type)(builder, CONTENT_TYPE_SPEECH);
                }
            }
            AAudioStreamBuilder_setDataCallback(builder, on_data, handler as *mut c_void);
            AAudioStreamBuilder_setErrorCallback(builder, on_error, notify as *mut c_void);
            let mut raw = std::ptr::null_mut();
            let status = AAudioStreamBuilder_openStream(builder, &mut raw);
            AAudioStreamBuilder_delete(builder);
            if status < 0 {
                free();
                return Err(status);
            }
            let stream = Stream { raw, handler, notify };
            let status = AAudioStream_requestStart(stream.raw);
            if status < 0 {
                return Err(status);
            }
            Ok(stream)
        }
    }

    /// El micrófono y el altavoz, con un hilo que los vuelve a abrir si se
    /// caen. Al soltarlo se cierran los dos.
    pub struct Streams {
        events: mpsc::Sender<Event>,
        keeper: Option<thread::JoinHandle<()>>,
    }

    impl Drop for Streams {
        fn drop(&mut self) {
            let _ = self.events.send(Event::Stop);
            if let Some(keeper) = self.keeper.take() {
                let _ = keeper.join();
            }
        }
    }

    /// Intentos de reabrir un stream caído antes de rendirse.
    const REOPEN_TRIES: u32 = 10;
    const REOPEN_WAIT: Duration = Duration::from_millis(200);

    pub struct Devices;

    impl Devices {
        pub fn new() -> Result<Self, CallError> {
            Ok(Self)
        }

        pub fn input_rate(&self) -> u32 {
            RATE
        }

        pub fn output_rate(&self) -> u32 {
            RATE
        }

        /// Con el modo llamada, el teléfono ya quita el eco.
        pub fn cancels_echo(&self) -> bool {
            call_mode().is_some()
        }

        pub fn start(self, samples: mpsc::Sender<Vec<f32>>, receiver: Arc<Mutex<Receiver>>) -> Result<Streams, CallError> {
            let mic = move || -> Handler {
                let samples = samples.clone();
                Box::new(move |pcm| {
                    let _ = samples.send(pcm.to_vec());
                })
            };
            let speaker = move || -> Handler {
                let receiver = receiver.clone();
                Box::new(move |out| receiver.lock().unwrap().pull(out))
            };
            let (events, lost) = mpsc::channel();
            let input = open(DIRECTION_INPUT, mic(), events.clone()).map_err(|_| CallError::NoInput)?;
            let output = open(DIRECTION_OUTPUT, speaker(), events.clone()).map_err(|_| CallError::NoOutput)?;
            let notify = events.clone();
            let keeper = thread::Builder::new()
                .name("pasalo-call-audio".into())
                .spawn(move || {
                    // Por dirección: DIRECTION_OUTPUT es 0 y DIRECTION_INPUT 1.
                    let mut streams = [Some(output), Some(input)];
                    while let Ok(Event::Lost(direction)) = lost.recv() {
                        // Un cambio de ruta suele tirar los dos a la vez.
                        let mut dead = vec![direction];
                        while let Ok(event) = lost.recv_timeout(Duration::from_millis(50)) {
                            match event {
                                Event::Lost(d) => dead.push(d),
                                Event::Stop => return,
                            }
                        }
                        for direction in [DIRECTION_OUTPUT, DIRECTION_INPUT] {
                            if !dead.contains(&direction) {
                                continue;
                            }
                            // El viejo se cierra antes de abrir el nuevo.
                            let slot = &mut streams[direction as usize];
                            *slot = None;
                            for attempt in 1..=REOPEN_TRIES {
                                let handler = if direction == DIRECTION_INPUT { mic() } else { speaker() };
                                match open(direction, handler, notify.clone()) {
                                    Ok(stream) => {
                                        *slot = Some(stream);
                                        tracing::info!("audio reabierto (dirección {direction})");
                                        break;
                                    }
                                    Err(e) if attempt == REOPEN_TRIES => {
                                        tracing::warn!("no se pudo reabrir el audio (dirección {direction}): {e}");
                                    }
                                    Err(_) => thread::sleep(REOPEN_WAIT),
                                }
                            }
                        }
                    }
                })
                .map_err(|e| CallError::Device(e.to_string()))?;
            Ok(Streams { events, keeper: Some(keeper) })
        }
    }
}
