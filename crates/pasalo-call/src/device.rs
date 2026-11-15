//! Microphone and speaker: with cpal on desktop and with AAudio on Android
//! (see [`platform`]). The streams cannot be moved between threads on every
//! platform, so they live in a thread of their own and [`Call`] only keeps
//! channels to talk to it.
//!
//! Which microphone and speaker are opened is a [`Selection`] of the ones
//! [`devices`] lists; it can change during the call ([`Call::set_devices`]).
//!
//! If a device in use is unplugged, the call goes on with the system default
//! one (on Android the system itself reroutes the audio).
//!
//! Threads of a call:
//! - `pasalo-call` owns the streams and reopens them when the devices change
//!   or one of them is lost.
//! - `pasalo-call-enc` encodes what the microphone callback hands over.
//! - The caller's thread (the network) decodes with [`Call::push`].
//! - The speaker callback only drains the [`Playout`] queue: it never waits
//!   for the decoder nor for the encoder.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::{Mode, Playout, Receiver, Sender, Stats};

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

/// A microphone or a speaker to choose from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceInfo {
    /// What a [`Selection`] names it by; the same across runs of the app.
    pub id: String,
    pub name: String,
}

/// What [`devices`] found.
#[derive(Debug, Clone, Default, Serialize)]
pub struct DeviceList {
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
}

/// The microphones and speakers there are now. Empty on Android: there the
/// system routes the audio of a call (earpiece, speaker, headset).
pub fn devices() -> DeviceList {
    platform::list()
}

/// Which microphone and speaker to open, by their [`DeviceInfo::id`]. `None`,
/// or one that is no longer there, is the system default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Selection {
    pub input: Option<String>,
    pub output: Option<String>,
}

enum Control {
    Mode(Mode),
    Stop,
}

/// Other devices to open, and where to say how it went.
type Switch = (Selection, mpsc::Sender<Result<(), CallError>>);

/// How often the `pasalo-call` thread looks whether a stream lost its device.
const WATCH: Duration = Duration::from_millis(500);
/// The least time between two attempts to reopen what was lost.
const RETRY: Duration = Duration::from_secs(2);
/// Lost again this soon after being reopened: the chosen device is there
/// but does not work, so the default one is opened instead.
const UNSTABLE: Duration = Duration::from_secs(10);

/// A call in progress. Dropping it closes the microphone and the speaker.
pub struct Call {
    control: mpsc::Sender<Control>,
    switches: mpsc::Sender<Switch>,
    receiver: Arc<Mutex<Receiver>>,
    muted: Arc<AtomicBool>,
    stats: Arc<Stats>,
}

impl Call {
    /// Opens the microphone and the speaker of `selection`. `send` gets
    /// every packet ready for the network (it must not block).
    pub fn start(mode: Mode, selection: Selection, send: impl Fn(Vec<u8>) + Send + 'static) -> Result<Self, CallError> {
        let stats = Arc::new(Stats::default());
        let muted = Arc::new(AtomicBool::new(false));
        let (control, commands) = mpsc::channel();
        let (switches, switch_rx) = mpsc::channel::<Switch>();
        let (ready_tx, ready_rx) = mpsc::channel();
        {
            let (stats, muted) = (stats.clone(), muted.clone());
            thread::Builder::new()
                .name("pasalo-call".into())
                .spawn(move || {
                    match Audio::open(mode, selection, stats, muted, send, commands) {
                        Ok(mut audio) => {
                            let _ = ready_tx.send(Ok(audio.receiver.clone()));
                            // The streams live until the Call is dropped;
                            // meanwhile they are reopened when asked to, or
                            // when one of them loses its device.
                            loop {
                                match switch_rx.recv_timeout(WATCH) {
                                    Ok((selection, done)) => {
                                        let _ = done.send(audio.switch(selection));
                                    }
                                    Err(mpsc::RecvTimeoutError::Timeout) => audio.recover(),
                                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                                }
                            }
                        }
                        Err(e) => {
                            let _ = ready_tx.send(Err(e));
                        }
                    }
                })
                .map_err(|e| CallError::Device(e.to_string()))?;
        }
        let receiver = ready_rx.recv().map_err(|e| CallError::Device(e.to_string()))??;
        Ok(Self { control, switches, receiver, muted, stats })
    }

    /// A packet from the network: decoded here, on the caller's thread.
    pub fn push(&self, packet: &[u8]) {
        lock(&self.receiver).push(packet);
    }

    pub fn set_mode(&self, mode: Mode) {
        let _ = self.control.send(Control::Mode(mode));
    }

    /// Changes the microphone and the speaker without cutting the call
    /// (there is a moment of silence while they are reopened). If the new
    /// ones cannot be opened, the call stays on the ones it had. Blocks
    /// until it is done.
    pub fn set_devices(&self, selection: Selection) -> Result<(), CallError> {
        let (done, result) = mpsc::channel();
        let gone = || CallError::Device("the call has ended".into());
        self.switches.send((selection, done)).map_err(|_| gone())?;
        result.recv().map_err(|_| gone())?
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

fn lock(receiver: &Mutex<Receiver>) -> std::sync::MutexGuard<'_, Receiver> {
    // A panic on the other side must not take the audio with it.
    receiver.lock().unwrap_or_else(|e| e.into_inner())
}

/// The open streams of a call and what is needed to open others in their
/// place. It stays in the thread that created it.
struct Audio {
    /// `None` only while they are being reopened (or if that failed).
    streams: Option<platform::Streams>,
    selection: Selection,
    receiver: Arc<Mutex<Receiver>>,
    /// What the microphone callback sends its samples through.
    samples: mpsc::Sender<Vec<f32>>,
    /// The rate of those samples, for the thread that encodes them.
    input_rate: Arc<AtomicU32>,
    /// Set by a stream whose device is gone (unplugged, switched off).
    lost: Arc<AtomicBool>,
    /// When what was lost was last reopened (or tried to).
    recovered: Option<Instant>,
}

impl Audio {
    fn open(
        mode: Mode,
        selection: Selection,
        stats: Arc<Stats>,
        muted: Arc<AtomicBool>,
        send: impl Fn(Vec<u8>) + Send + 'static,
        commands: mpsc::Receiver<Control>,
    ) -> Result<Self, CallError> {
        let devices = platform::Devices::new(&selection)?;
        let receiver = Receiver::new(devices.output_rate(), stats.clone());
        let mut sender = Sender::new(mode, devices.input_rate(), stats, muted);
        sender.set_echo_gate(!devices.cancels_echo());
        let input_rate = Arc::new(AtomicU32::new(devices.input_rate()));

        // The microphone callback only copies; encoding goes in another thread.
        let (samples, samples_rx) = mpsc::channel::<Vec<f32>>();
        let lost = Arc::new(AtomicBool::new(false));
        let streams = devices.start(samples.clone(), receiver.playout(), lost.clone())?;

        let rate = input_rate.clone();
        thread::Builder::new()
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
                            // Another microphone may run at another rate.
                            sender.set_input_rate(rate.load(Ordering::Relaxed));
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
        Ok(Self {
            streams: Some(streams),
            selection,
            receiver: Arc::new(Mutex::new(receiver)),
            samples,
            input_rate,
            lost,
            recovered: None,
        })
    }

    /// Opens the devices of `selection` in place of the current ones.
    fn switch(&mut self, selection: Selection) -> Result<(), CallError> {
        let result = self.reopen(&selection);
        match &result {
            Ok(()) => self.selection = selection,
            // Back to what was open: the call must not be left without audio.
            Err(_) if self.streams.is_none() => {
                let previous = self.selection.clone();
                if let Err(e) = self.reopen(&previous) {
                    tracing::warn!("could not reopen the audio: {e}");
                }
            }
            Err(_) => {}
        }
        result
    }

    fn reopen(&mut self, selection: &Selection) -> Result<(), CallError> {
        let devices = platform::Devices::new(selection)?;
        // The old ones are closed first: not every system opens a device twice.
        self.streams = None;
        self.lost.store(false, Ordering::Relaxed);
        self.input_rate.store(devices.input_rate(), Ordering::Relaxed);
        let playout: Arc<Playout> = lock(&self.receiver).set_output_rate(devices.output_rate());
        self.streams = Some(devices.start(self.samples.clone(), playout, self.lost.clone())?);
        Ok(())
    }

    /// Reopens the streams if one of them lost its device, or if there are
    /// none because nothing could be opened the last time. A chosen device
    /// that is gone gives way to the default one (see [`Selection`]); with
    /// no device left at all, it keeps trying until one is plugged in.
    fn recover(&mut self) {
        let lost = self.lost.load(Ordering::Relaxed);
        if self.streams.is_some() && !lost {
            return;
        }
        let since = self.recovered.map(|at| at.elapsed());
        if since.is_some_and(|t| t < RETRY) {
            return;
        }
        if lost && since.is_some_and(|t| t < UNSTABLE) {
            self.selection = Selection::default();
        }
        self.recovered = Some(Instant::now());
        let selection = self.selection.clone();
        match self.reopen(&selection) {
            Ok(()) => tracing::info!("audio reopened after losing a device"),
            Err(e) => tracing::warn!("could not reopen the audio: {e}"),
        }
    }
}

/// Desktop: cpal. Its devices do not cancel the echo, so with speakers the
/// echo gate of the [`Sender`] is needed.
#[cfg(not(target_os = "android"))]
mod platform {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{SampleFormat, Stream, StreamConfig, SupportedStreamConfig};

    use super::{CallError, DeviceInfo, DeviceList, Selection};
    use crate::Playout;

    pub type Streams = (Stream, Stream);

    pub fn list() -> DeviceList {
        fn info(device: cpal::Device) -> Option<DeviceInfo> {
            Some(DeviceInfo { id: device.id().ok()?.to_string(), name: device.description().ok()?.name().to_string() })
        }
        let host = cpal::default_host();
        DeviceList {
            inputs: host.input_devices().map(|all| all.filter_map(info).collect()).unwrap_or_default(),
            outputs: host.output_devices().map(|all| all.filter_map(info).collect()).unwrap_or_default(),
        }
    }

    /// The device with that id, if it is still there.
    fn find(host: &cpal::Host, id: Option<&str>) -> Option<cpal::Device> {
        host.device_by_id(&id?.parse().ok()?)
    }

    pub struct Devices {
        input: cpal::Device,
        output: cpal::Device,
        in_config: SupportedStreamConfig,
        out_config: SupportedStreamConfig,
    }

    impl Devices {
        pub fn new(selection: &Selection) -> Result<Self, CallError> {
            let host = cpal::default_host();
            let input = find(&host, selection.input.as_deref())
                .filter(DeviceTrait::supports_input)
                .or_else(|| host.default_input_device())
                .ok_or(CallError::NoInput)?;
            let output = find(&host, selection.output.as_deref())
                .filter(DeviceTrait::supports_output)
                .or_else(|| host.default_output_device())
                .ok_or(CallError::NoOutput)?;
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

        /// `lost` is set when one of the two streams loses its device.
        pub fn start(
            self,
            samples: mpsc::Sender<Vec<f32>>,
            playout: Arc<Playout>,
            lost: Arc<AtomicBool>,
        ) -> Result<Streams, CallError> {
            let in_stream =
                build_input(&self.input, self.in_config.sample_format(), self.in_config.into(), samples, lost.clone())?;
            let out_stream =
                build_output(&self.output, self.out_config.sample_format(), self.out_config.into(), playout, lost)?;
            in_stream.play().map_err(|e| CallError::Device(e.to_string()))?;
            out_stream.play().map_err(|e| CallError::Device(e.to_string()))?;
            Ok((in_stream, out_stream))
        }
    }

    /// The error callback of a stream: `what` names it in the log. A stream
    /// on the default speaker follows the system to the new default by
    /// itself; any other whose device is gone has to be opened again.
    fn on_error(what: &'static str, lost: Arc<AtomicBool>) -> impl FnMut(cpal::Error) + Send + 'static {
        move |e| {
            tracing::warn!("{what} error: {e}");
            if matches!(e.kind(), cpal::ErrorKind::DeviceNotAvailable | cpal::ErrorKind::StreamInvalidated) {
                lost.store(true, Ordering::Relaxed);
            }
        }
    }

    fn build_input(
        device: &cpal::Device,
        format: SampleFormat,
        config: StreamConfig,
        tx: mpsc::Sender<Vec<f32>>,
        lost: Arc<AtomicBool>,
    ) -> Result<Stream, CallError> {
        let channels = config.channels as usize;
        let err = on_error("microphone", lost);
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
        playout: Arc<Playout>,
        lost: Arc<AtomicBool>,
    ) -> Result<Stream, CallError> {
        let channels = config.channels as usize;
        let err = on_error("speaker", lost);
        macro_rules! output {
            ($t:ty, $conv:expr) => {{
                let mut mono = Vec::new();
                device.build_output_stream::<$t, _, _>(
                    config,
                    move |data: &mut [$t], _| {
                        mono.resize(data.len() / channels, 0.0);
                        playout.pull(&mut mono);
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

/// Android: AAudio in call mode (`VOICE_COMMUNICATION` microphone and output
/// of usage `VOICE_COMMUNICATION`), which turns on the phone's own echo
/// cancellation, noise suppression and gain control. cpal does not let us
/// choose it and opens the microphone as for speech recognition, with none
/// of that.
///
/// Those three functions are from Android 9 (API 28) and the app goes down
/// to 26, so they are looked up when opening: on Android 8 they are missing
/// and the echo gate is used, as on desktop.
#[cfg(target_os = "android")]
mod platform {
    use std::ffi::{CStr, c_void};
    use std::sync::mpsc;
    use std::sync::{Arc, OnceLock};
    use std::thread;
    use std::time::Duration;

    use super::{CallError, DeviceList, Selection};
    use crate::Playout;

    /// Nothing to choose: Android routes the audio of a call by itself.
    pub fn list() -> DeviceList {
        DeviceList::default()
    }

    /// Always asked for; if the hardware runs at another rate, AAudio converts.
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

    /// The Android 9 functions, if present.
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
                // SAFETY: dlopen/dlsym with nul-terminated names; the pointers
                // they return are functions with the NDK signature.
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

    /// What each callback does with the samples (mono, f32).
    type Handler = Box<dyn FnMut(&mut [f32]) + Send>;

    /// What reaches the thread that looks after the streams.
    enum Event {
        /// The stream in that direction died (e.g. the audio output changed).
        Lost(i32),
        Stop,
    }

    /// Whom the error callback of a stream notifies.
    struct Notify {
        direction: i32,
        events: mpsc::Sender<Event>,
    }

    /// An open stream. Dropping it closes it and then frees its callbacks.
    struct Stream {
        raw: *mut RawStream,
        handler: *mut Handler,
        notify: *mut Notify,
    }

    // SAFETY: AAudio allows closing the stream from any thread and only the
    // callback touches the handler until then.
    unsafe impl Send for Stream {}

    impl Drop for Stream {
        fn drop(&mut self) {
            // SAFETY: `close` waits for the callbacks in progress; afterwards
            // nobody else uses the handler or the notifier.
            unsafe {
                AAudioStream_close(self.raw);
                drop(Box::from_raw(self.handler));
                drop(Box::from_raw(self.notify));
            }
        }
    }

    extern "C" fn on_data(_: *mut RawStream, user: *mut c_void, data: *mut c_void, frames: i32) -> i32 {
        // SAFETY: `user` is the stream's Handler, alive until it is closed,
        // and `data` holds `frames` mono f32 samples, the format requested.
        unsafe {
            let handler = &mut *(user as *mut Handler);
            handler(std::slice::from_raw_parts_mut(data as *mut f32, frames.max(0) as usize));
        }
        CALLBACK_CONTINUE
    }

    /// AAudio does not allow closing or reopening from here: the thread that
    /// looks after the streams is told. It happens mostly when entering call
    /// mode or switching between speaker, earpiece and Bluetooth: the MMAP
    /// output gets disconnected.
    extern "C" fn on_error(_: *mut RawStream, user: *mut c_void, error: i32) {
        tracing::warn!("audio error: {error}");
        // SAFETY: `user` is the stream's Notify, alive until it is closed.
        let notify = unsafe { &*(user as *const Notify) };
        let _ = notify.events.send(Event::Lost(notify.direction));
    }

    fn open(direction: i32, handler: Handler, events: mpsc::Sender<Event>) -> Result<Stream, i32> {
        let handler = Box::into_raw(Box::new(handler));
        let notify = Box::into_raw(Box::new(Notify { direction, events }));
        // SAFETY: NDK calls with a freshly created builder that is deleted at
        // the end; if the stream does not open, the callbacks are freed here.
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

    /// The microphone and the speaker, with a thread that reopens them if
    /// they die. Dropping it closes both.
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

    /// Attempts to reopen a dead stream before giving up.
    const REOPEN_TRIES: u32 = 10;
    const REOPEN_WAIT: Duration = Duration::from_millis(200);

    pub struct Devices;

    impl Devices {
        pub fn new(_: &Selection) -> Result<Self, CallError> {
            Ok(Self)
        }

        pub fn input_rate(&self) -> u32 {
            RATE
        }

        pub fn output_rate(&self) -> u32 {
            RATE
        }

        /// With call mode the phone already removes the echo.
        pub fn cancels_echo(&self) -> bool {
            call_mode().is_some()
        }

        /// `_lost` is not used: the streams here reopen themselves.
        pub fn start(
            self,
            samples: mpsc::Sender<Vec<f32>>,
            playout: Arc<Playout>,
            _lost: Arc<std::sync::atomic::AtomicBool>,
        ) -> Result<Streams, CallError> {
            let mic = move || -> Handler {
                let samples = samples.clone();
                Box::new(move |pcm| {
                    let _ = samples.send(pcm.to_vec());
                })
            };
            let speaker = move || -> Handler {
                let playout = playout.clone();
                Box::new(move |out| playout.pull(out))
            };
            let (events, lost) = mpsc::channel();
            let input = open(DIRECTION_INPUT, mic(), events.clone()).map_err(|_| CallError::NoInput)?;
            let output = open(DIRECTION_OUTPUT, speaker(), events.clone()).map_err(|_| CallError::NoOutput)?;
            let notify = events.clone();
            let keeper = thread::Builder::new()
                .name("pasalo-call-audio".into())
                .spawn(move || {
                    // By direction: DIRECTION_OUTPUT is 0 and DIRECTION_INPUT 1.
                    let mut streams = [Some(output), Some(input)];
                    while let Ok(Event::Lost(direction)) = lost.recv() {
                        // A route change usually takes both down at once.
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
                            // The old one is closed before opening the new one.
                            let slot = &mut streams[direction as usize];
                            *slot = None;
                            for attempt in 1..=REOPEN_TRIES {
                                let handler = if direction == DIRECTION_INPUT { mic() } else { speaker() };
                                match open(direction, handler, notify.clone()) {
                                    Ok(stream) => {
                                        *slot = Some(stream);
                                        tracing::info!("audio reopened (direction {direction})");
                                        break;
                                    }
                                    Err(e) if attempt == REOPEN_TRIES => {
                                        tracing::warn!("could not reopen the audio (direction {direction}): {e}");
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
