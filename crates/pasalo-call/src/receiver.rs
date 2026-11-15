//! Packets → audio, without touching any device. The audio goes to a
//! [`Playout`] queue that the speaker drains.

use std::sync::Arc;

use crate::Mode;
use crate::codec::{Codec, Decoder};
use crate::dsp::{Resampler, to_f32};
use crate::packet;
use crate::playout::Playout;
use crate::stats::Stats;

/// Consecutive losses that are concealed; more is a real silence.
const MAX_CONCEAL: u16 = 3;

/// Packets → speaker. Decodes on whichever thread calls [`Receiver::push`]
/// and leaves the audio in its [`Playout`] for the audio callback.
pub struct Receiver {
    mode: Option<Mode>,
    decoder: Option<Box<dyn Decoder>>,
    resampler: Option<Resampler>,
    output_rate: u32,
    expected: Option<u16>,
    playout: Arc<Playout>,
    stats: Arc<Stats>,
    /// One frame at the output rate, reused.
    resampled: Vec<f32>,
    f32s: Vec<f32>,
}

impl Receiver {
    pub fn new(output_rate: u32, stats: Arc<Stats>) -> Self {
        Self {
            mode: None,
            decoder: None,
            resampler: None,
            output_rate,
            expected: None,
            playout: Arc::new(Playout::new(output_rate, stats.clone())),
            stats,
            resampled: Vec::new(),
            f32s: Vec::new(),
        }
    }

    /// The queue the speaker plays from; hand it to the audio callback.
    pub fn playout(&self) -> Arc<Playout> {
        self.playout.clone()
    }

    /// The rate the speaker plays at from now on (another speaker). Returns
    /// the queue to hand to its audio callback: the same one if the rate did
    /// not change; otherwise a new one, and what was waiting in the old one
    /// is not played.
    pub fn set_output_rate(&mut self, rate: u32) -> Arc<Playout> {
        if rate != self.output_rate {
            self.output_rate = rate;
            self.playout = Arc::new(Playout::new(rate, self.stats.clone()));
            if let Some(mode) = self.mode {
                self.resampler = Some(Resampler::new(Codec::for_mode(mode).sample_rate(), rate));
                self.playout.set_mode(mode);
            }
        }
        self.playout.clone()
    }

    /// A packet from the network.
    pub fn push(&mut self, packet: &[u8]) {
        use std::sync::atomic::Ordering::Relaxed;
        let Some(p) = packet::parse(packet) else { return };
        self.stats.received_packets.fetch_add(1, Relaxed);
        self.stats.received_bytes.fetch_add(packet.len() as u64, Relaxed);
        self.playout.note_packet();

        if self.mode != Some(p.mode) {
            let codec = Codec::for_mode(p.mode);
            self.decoder = Some(codec.decoder());
            self.resampler = Some(Resampler::new(codec.sample_rate(), self.output_rate));
            self.mode = Some(p.mode);
            self.expected = None;
            self.playout.set_mode(p.mode);
        }

        if let Some(expected) = self.expected {
            let gap = p.seq.wrapping_sub(expected);
            // An old packet that arrived late: its gap was already filled.
            if gap > u16::MAX / 2 {
                return;
            }
            if gap > 0 {
                self.stats.lost_packets.fetch_add(gap as u64, Relaxed);
                match &p.previous {
                    // The previous packet comes repeated in this one: nothing is lost.
                    Some(copy) if gap == 1 => {
                        for frame in copy {
                            self.play(Some(frame));
                        }
                        self.stats.recovered_packets.fetch_add(1, Relaxed);
                    }
                    _ if gap <= MAX_CONCEAL => {
                        for _ in 0..gap as usize * packet::frames_per_packet(p.mode) {
                            self.play(None);
                        }
                    }
                    _ => {}
                }
            }
        }
        self.expected = Some(p.seq.wrapping_add(1));

        for frame in &p.frames {
            self.play(Some(frame));
        }
    }

    /// Decodes one frame (`None`: a lost one) into the playout queue.
    fn play(&mut self, frame: Option<&[u8]>) {
        let pcm = self.decoder.as_mut().expect("set with the mode").decode(frame);
        to_f32(&pcm, &mut self.f32s);
        self.resampled.clear();
        self.resampler.as_mut().expect("set with the mode").process(&self.f32s, &mut self.resampled);
        self.playout.push(&self.resampled);
    }

    /// Fills `buf` with what should play next. Same as [`Playout::pull`],
    /// for when one thread does everything (the CLI, the browser).
    pub fn pull(&mut self, buf: &mut [f32]) {
        self.playout.pull(buf);
    }
}
