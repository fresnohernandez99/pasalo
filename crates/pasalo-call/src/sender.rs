//! Microphone → packets, without touching any device.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::Mode;
use crate::codec::{Codec, Encoder};
use crate::dsp::{Resampler, Vad, rms, to_i16};
use crate::packet::{self, Writer};
use crate::stats::Stats;

/// Microphone → packets. Feed it the microphone with [`Sender::push`] and
/// send what it returns.
pub struct Sender {
    mode: Mode,
    codec: Codec,
    encoder: Box<dyn Encoder>,
    resampler: Resampler,
    input_rate: u32,
    vad: Vad,
    /// Resampled audio waiting to fill a frame.
    pcm: Vec<f32>,
    /// One frame, reused.
    frame: Vec<f32>,
    pcm16: Vec<i16>,
    /// Encoded frames of the packet being built.
    frames: Vec<Vec<u8>>,
    /// Frames of the last packet sent, repeated in the next one (low modes).
    previous: Vec<Vec<u8>>,
    writer: Writer,
    muted: Arc<AtomicBool>,
    gate: EchoGate,
    stats: Arc<Stats>,
}

impl Sender {
    pub fn new(mode: Mode, input_rate: u32, stats: Arc<Stats>, muted: Arc<AtomicBool>) -> Self {
        let codec = Codec::for_mode(mode);
        Self {
            mode,
            codec,
            encoder: codec.encoder(),
            resampler: Resampler::new(input_rate, codec.sample_rate()),
            input_rate,
            vad: Vad::new(codec.frame_ms()),
            pcm: Vec::new(),
            frame: Vec::with_capacity(codec.frame_samples()),
            pcm16: Vec::with_capacity(codec.frame_samples()),
            frames: Vec::new(),
            previous: Vec::new(),
            writer: Writer::new(mode, 0),
            muted,
            gate: EchoGate::new(),
            stats,
        }
    }

    /// Without echo cancellation, while the other person is heard only what
    /// is clearly louder than their echo counts as voice. How much echo comes
    /// back is learnt during the call: with headphones it is almost nothing
    /// and the gate lets both talk at once; with speakers it behaves almost
    /// like a walkie-talkie. Where the system already removes the echo
    /// (Android in call mode) or there is no acoustic path (files), it is
    /// not needed.
    pub fn set_echo_gate(&mut self, on: bool) {
        self.gate.on = on;
    }

    pub fn set_mode(&mut self, mode: Mode) {
        if mode == self.mode {
            return;
        }
        let seq = self.writer.seq();
        let gate = self.gate;
        *self = Self::new(mode, self.input_rate, self.stats.clone(), self.muted.clone());
        self.writer = Writer::new(mode, seq);
        self.gate = gate;
    }

    /// The rate of what [`Sender::push`] gets from now on (another
    /// microphone). The sentence in progress carries on.
    pub fn set_input_rate(&mut self, rate: u32) {
        if rate == self.input_rate {
            return;
        }
        self.input_rate = rate;
        self.resampler = Resampler::new(rate, self.codec.sample_rate());
    }

    /// Takes mono audio from the microphone and returns the packets that
    /// are ready (none during silence).
    pub fn push(&mut self, input: &[f32]) -> Vec<Vec<u8>> {
        let mut packets = Vec::new();
        self.resampler.process(input, &mut self.pcm);
        let size = self.codec.frame_samples();
        while self.pcm.len() >= size {
            self.frame.clear();
            self.frame.extend(self.pcm.drain(..size));
            let echo = self.gate.is_echo(&self.frame, self.stats.far_level());
            let voice = self.vad.is_voice(&self.frame) && !echo;
            if echo {
                // Echo is not voice: it does not stretch the tail of a sentence.
                self.vad.end_hangover();
            }
            if voice && !self.muted.load(Ordering::Relaxed) {
                to_i16(&self.frame, &mut self.pcm16);
                self.frames.push(self.encoder.encode(&self.pcm16));
                if self.frames.len() >= packet::frames_per_packet(self.mode) {
                    packets.push(self.packet());
                }
            } else if !self.frames.is_empty() {
                // End of a sentence: do not wait to fill the packet.
                packets.push(self.packet());
            }
        }
        packets
    }

    fn packet(&mut self) -> Vec<u8> {
        let p = self.writer.write(&self.frames, &self.previous);
        self.previous = std::mem::take(&mut self.frames);
        self.stats.sent_packets.fetch_add(1, Ordering::Relaxed);
        self.stats.sent_bytes.fetch_add(p.len() as u64, Ordering::Relaxed);
        p
    }
}

/// Below this level nothing is playing that could echo.
const FAR_ACTIVE: f32 = 0.01;
/// Echo assumed before measuring it: a speaker close to the microphone.
const ECHO_START: f32 = 0.5;
/// To count as voice the microphone has to exceed the expected echo by this
/// factor (12 dB).
const ECHO_MARGIN: f32 = 4.0;

/// Tells the echo of what is playing from voice spoken over it. See
/// [`Sender::set_echo_gate`].
#[derive(Clone, Copy)]
struct EchoGate {
    on: bool,
    /// How much of what plays comes back through the microphone (microphone
    /// level over playback level) while only the other person talks.
    echo: f32,
}

impl EchoGate {
    fn new() -> Self {
        Self { on: true, echo: ECHO_START }
    }

    /// Whether `frame` is only the echo of what is playing at level `far`.
    /// Along the way it tunes how much echo comes back: it moves towards
    /// what the frames that look like echo measure, drops slowly in the gaps
    /// (the playback level takes a while to fall) and barely rises when
    /// someone talks over.
    fn is_echo(&mut self, frame: &[f32], far: f32) -> bool {
        if !self.on || far < FAR_ACTIVE {
            return false;
        }
        let ratio = rms(frame) / far;
        let echo = ratio < self.echo * ECHO_MARGIN;
        self.echo = if ratio < self.echo {
            self.echo * 0.9 + ratio * 0.1
        } else if echo {
            self.echo * 0.8 + ratio * 0.2
        } else {
            self.echo * 1.002
        };
        self.echo = self.echo.clamp(0.005, 1.0);
        echo
    }
}
