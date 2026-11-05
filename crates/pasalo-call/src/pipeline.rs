//! Lo que pasa entre el micrófono y la red, y entre la red y el altavoz, sin
//! tocar dispositivos (así se puede probar con audio de archivos).
//!
//! Paquete: `[modo u8][seq u16 BE][n u8]` y después los `n` frames: de tamaño
//! fijo seguidos (Codec2) o cada uno con su longitud `u8` delante (Opus).
//! En los modos de poco consumo el bit alto de `modo` indica que detrás va
//! `[r u8]` y los `r` frames del paquete anterior: si ese se perdió, se
//! recupera entero. Esos modos meten 120-160 ms por paquete, así que perder
//! uno sería un hueco grande, y la copia apenas suma frente a las cabeceras.
//! Durante los silencios no se envía nada: el `seq` solo avanza con lo que se
//! envía, así que un hueco en los `seq` es una pérdida de verdad.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use crate::Mode;
use crate::codec::{Codec, Decoder, Encoder};
use crate::dsp::{Resampler, Vad, rms, to_f32, to_i16};

/// Bytes que añaden IP, UDP y QUIC a cada datagrama (aprox., IPv4 directo).
pub const OVERHEAD: u64 = 60;
const HEADER: usize = 4;
const REDUNDANT: u8 = 0x80;

/// Contadores compartidos de una llamada.
#[derive(Default)]
pub struct Stats {
    pub sent_bytes: AtomicU64,
    pub sent_packets: AtomicU64,
    pub received_bytes: AtomicU64,
    pub received_packets: AtomicU64,
    pub lost_packets: AtomicU64,
    /// Perdidos que se recuperaron con la copia del paquete siguiente.
    pub recovered_packets: AtomicU64,
    /// Nivel reciente de lo que suena por el altavoz (bits de un f32), para
    /// no mandar de vuelta el eco.
    far_level: AtomicU32,
}

impl Stats {
    /// Bytes por la red, con la cabecera estimada de cada paquete.
    pub fn wire_bytes_sent(&self) -> u64 {
        self.sent_bytes.load(Ordering::Relaxed) + self.sent_packets.load(Ordering::Relaxed) * OVERHEAD
    }

    pub fn wire_bytes_received(&self) -> u64 {
        self.received_bytes.load(Ordering::Relaxed) + self.received_packets.load(Ordering::Relaxed) * OVERHEAD
    }

    fn far_level(&self) -> f32 {
        f32::from_bits(self.far_level.load(Ordering::Relaxed))
    }
}

fn redundant(mode: Mode) -> bool {
    matches!(mode, Mode::Low | Mode::Minimum)
}

pub(crate) fn frames_per_packet(mode: Mode) -> usize {
    match mode {
        Mode::High | Mode::Normal => 1,
        Mode::Low => 2,
        Mode::Minimum => 4,
    }
}

fn mode_id(mode: Mode) -> u8 {
    match mode {
        Mode::High => 0,
        Mode::Normal => 1,
        Mode::Low => 2,
        Mode::Minimum => 3,
    }
}

fn mode_from_id(id: u8) -> Option<Mode> {
    Some(match id {
        0 => Mode::High,
        1 => Mode::Normal,
        2 => Mode::Low,
        3 => Mode::Minimum,
        _ => return None,
    })
}

/// Lee `[n u8]` y `n` frames; devuelve los frames y lo que sobra detrás.
fn parse_frames(data: &[u8], codec: Codec) -> Option<(Vec<&[u8]>, &[u8])> {
    let (&count, mut rest) = data.split_first()?;
    let mut frames = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let len = match codec.fixed_frame_bytes() {
            Some(len) => len,
            None => {
                let (&len, tail) = rest.split_first()?;
                rest = tail;
                len as usize
            }
        };
        if rest.len() < len {
            return None;
        }
        let (frame, tail) = rest.split_at(len);
        frames.push(frame);
        rest = tail;
    }
    Some((frames, rest))
}

/// Micrófono → paquetes.
pub struct Sender {
    mode: Mode,
    codec: Codec,
    encoder: Box<dyn Encoder>,
    resampler: Resampler,
    input_rate: u32,
    vad: Vad,
    pcm: Vec<f32>,
    frames: Vec<Vec<u8>>,
    /// Frames del último paquete enviado, para repetirlos en el siguiente.
    previous: Vec<Vec<u8>>,
    seq: u16,
    muted: Arc<AtomicBool>,
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
            frames: Vec::new(),
            previous: Vec::new(),
            seq: 0,
            muted,
            stats,
        }
    }

    pub fn set_mode(&mut self, mode: Mode) {
        if mode != self.mode {
            let seq = self.seq;
            *self = Self::new(mode, self.input_rate, self.stats.clone(), self.muted.clone());
            self.seq = seq;
        }
    }

    /// Recibe audio mono del micrófono y devuelve los paquetes listos.
    pub fn push(&mut self, input: &[f32]) -> Vec<Vec<u8>> {
        let mut packets = Vec::new();
        self.resampler.process(input, &mut self.pcm);
        let size = self.codec.frame_samples();
        while self.pcm.len() >= size {
            let frame: Vec<f32> = self.pcm.drain(..size).collect();
            let far = self.stats.far_level();
            // Si está sonando la otra persona, solo cuenta como voz algo
            // claramente más fuerte que su eco.
            let voice = self.vad.is_voice(&frame) && (far < 0.01 || rms(&frame) > far * 1.5);
            if voice && !self.muted.load(Ordering::Relaxed) {
                self.frames.push(self.encoder.encode(&to_i16(&frame)));
                if self.frames.len() >= frames_per_packet(self.mode) {
                    packets.push(self.packet());
                }
            } else if !self.frames.is_empty() {
                // Final de una frase: no esperar a llenar el paquete.
                packets.push(self.packet());
            }
        }
        packets
    }

    fn packet(&mut self) -> Vec<u8> {
        let fixed = self.codec.fixed_frame_bytes().is_some();
        let write = |p: &mut Vec<u8>, frames: &[Vec<u8>]| {
            p.push(frames.len() as u8);
            for frame in frames {
                if !fixed {
                    p.push(frame.len() as u8);
                }
                p.extend_from_slice(frame);
            }
        };
        let copy = redundant(self.mode) && !self.previous.is_empty();
        let mut p = Vec::with_capacity(64);
        p.push(mode_id(self.mode) | if copy { REDUNDANT } else { 0 });
        p.extend_from_slice(&self.seq.to_be_bytes());
        write(&mut p, &self.frames);
        if copy {
            write(&mut p, &self.previous);
        }
        self.previous = std::mem::take(&mut self.frames);
        self.seq = self.seq.wrapping_add(1);
        self.stats.sent_packets.fetch_add(1, Ordering::Relaxed);
        self.stats.sent_bytes.fetch_add(p.len() as u64, Ordering::Relaxed);
        p
    }
}

/// Paquetes → altavoz.
pub struct Receiver {
    mode: Option<Mode>,
    codec: Option<Codec>,
    decoder: Option<Box<dyn Decoder>>,
    resampler: Option<Resampler>,
    output_rate: u32,
    expected: Option<u16>,
    out: VecDeque<f32>,
    playing: bool,
    /// Muestras reproducidas desde el último paquete, para saber si la otra
    /// persona dejó de hablar.
    idle: usize,
    stats: Arc<Stats>,
}

/// Lo que se acumula antes de empezar a sonar, para absorber el jitter.
/// Nunca menos de dos paquetes: si se pierde uno, el siguiente trae su copia
/// (modos de poco consumo) y tiene que llegar antes de que se vacíe el búfer.
fn start_ms(mode: Mode) -> usize {
    (2 * mode.packet_ms() as usize + 40).max(120)
}
/// Si se acumula más de esto por encima del arranque, se descarta lo viejo
/// para no ir cada vez con más retraso.
const SLACK_MS: usize = 400;
/// Pérdidas seguidas que se rellenan; con más es un silencio de verdad.
const MAX_CONCEAL: u16 = 3;

impl Receiver {
    pub fn new(output_rate: u32, stats: Arc<Stats>) -> Self {
        Self {
            mode: None,
            codec: None,
            decoder: None,
            resampler: None,
            output_rate,
            expected: None,
            out: VecDeque::new(),
            playing: false,
            idle: 0,
            stats,
        }
    }

    pub fn push(&mut self, packet: &[u8]) {
        if packet.len() < HEADER {
            return;
        }
        let Some(mode) = mode_from_id(packet[0] & !REDUNDANT) else { return };
        let has_copy = packet[0] & REDUNDANT != 0;
        let seq = u16::from_be_bytes([packet[1], packet[2]]);
        self.stats.received_packets.fetch_add(1, Ordering::Relaxed);
        self.stats.received_bytes.fetch_add(packet.len() as u64, Ordering::Relaxed);
        self.idle = 0;

        if self.mode != Some(mode) {
            let codec = Codec::for_mode(mode);
            self.decoder = Some(codec.decoder());
            self.resampler = Some(Resampler::new(codec.sample_rate(), self.output_rate));
            self.codec = Some(codec);
            self.mode = Some(mode);
            self.expected = None;
        }
        let codec = self.codec.expect("con modo");

        let Some((current, rest)) = parse_frames(&packet[HEADER - 1..], codec) else { return };
        let copy = if has_copy { parse_frames(rest, codec).map(|(frames, _)| frames) } else { None };

        if let Some(expected) = self.expected {
            let gap = seq.wrapping_sub(expected);
            // Un paquete viejo que llegó tarde: ya se rellenó su hueco.
            if gap > u16::MAX / 2 {
                return;
            }
            if gap > 0 {
                self.stats.lost_packets.fetch_add(gap as u64, Ordering::Relaxed);
                // El paquete anterior viene repetido en este: no se pierde nada.
                let recovered = gap == 1 && copy.is_some();
                if recovered {
                    for frame in copy.as_deref().unwrap_or_default() {
                        let pcm = self.decoder.as_mut().expect("con modo").decode(Some(frame));
                        self.play(&pcm);
                    }
                } else if gap <= MAX_CONCEAL {
                    for _ in 0..gap as usize * frames_per_packet(mode) {
                        let pcm = self.decoder.as_mut().expect("con modo").decode(None);
                        self.play(&pcm);
                    }
                }
                if recovered {
                    self.stats.recovered_packets.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        self.expected = Some(seq.wrapping_add(1));

        for frame in current {
            let pcm = self.decoder.as_mut().expect("con modo").decode(Some(frame));
            self.play(&pcm);
        }
    }

    fn play(&mut self, pcm: &[i16]) {
        let mut resampled = Vec::new();
        self.resampler.as_mut().expect("con modo").process(&to_f32(pcm), &mut resampled);
        self.out.extend(resampled);
        let max = self.output_rate as usize * (start_ms(self.mode.expect("con modo")) + SLACK_MS) / 1000;
        if self.out.len() > max {
            let extra = self.out.len() - max;
            self.out.drain(..extra);
        }
    }

    /// Rellena `buf` con lo siguiente que debe sonar (silencio si no hay).
    pub fn pull(&mut self, buf: &mut [f32]) {
        let start = self.output_rate as usize * self.mode.map_or(120, start_ms) / 1000;
        // Final de frase: no llegará nada más que complete el arranque, así
        // que suena lo que haya en vez de esperar a la frase siguiente.
        let quiet = self.mode.is_some_and(|m| self.idle > self.output_rate as usize * m.packet_ms() as usize * 3 / 2000);
        if !self.playing && (self.out.len() >= start || (quiet && !self.out.is_empty())) {
            self.playing = true;
        }
        self.idle += buf.len();
        for sample in buf.iter_mut() {
            *sample = match self.playing {
                true => self.out.pop_front().unwrap_or(0.0),
                false => 0.0,
            };
        }
        if self.out.is_empty() {
            self.playing = false;
        }
        // Nivel de lo que suena, que decae despacio para cubrir la cola del eco.
        let level = rms(buf).max(self.stats.far_level() * 0.9);
        self.stats.far_level.store(level.to_bits(), Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Voz de mentira: un tono con armónicos que se enciende y se apaga.
    fn speech(rate: u32, seconds: f32) -> Vec<f32> {
        let n = (rate as f32 * seconds) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / rate as f32;
                let on = if ((t * 2.0) as usize).is_multiple_of(2) { 1.0 } else { 0.0 };
                let w = 140.0 * std::f32::consts::TAU * t;
                on * 0.2 * (w.sin() + 0.5 * (2.0 * w).sin() + 0.3 * (3.0 * w).sin())
            })
            .collect()
    }

    fn run(mode: Mode, drop_every: Option<usize>) -> (Arc<Stats>, Arc<Stats>, Vec<f32>) {
        let (tx, rx) = (Arc::new(Stats::default()), Arc::new(Stats::default()));
        let mut sender = Sender::new(mode, 48_000, tx.clone(), Arc::new(AtomicBool::new(false)));
        let mut receiver = Receiver::new(48_000, rx.clone());
        let mut out = Vec::new();
        let mut buf = vec![0.0; 480];
        let mut count = 0;
        for chunk in speech(48_000, 3.0).chunks(480) {
            for packet in sender.push(chunk) {
                count += 1;
                if drop_every.is_some_and(|n| count % n == 0) {
                    continue;
                }
                receiver.push(&packet);
            }
            receiver.pull(&mut buf);
            out.extend_from_slice(&buf);
        }
        (tx, rx, out)
    }

    #[test]
    fn every_mode_carries_audio() {
        for mode in Mode::ALL {
            let (tx, rx, out) = run(mode, None);
            assert!(tx.sent_packets.load(Ordering::Relaxed) > 0, "{mode:?}");
            assert_eq!(rx.lost_packets.load(Ordering::Relaxed), 0, "{mode:?}");
            assert!(rms(&out) > 0.02, "{mode:?}: salida casi muda ({})", rms(&out));
        }
    }

    #[test]
    fn silence_sends_nothing() {
        let tx = Arc::new(Stats::default());
        let mut sender = Sender::new(Mode::Normal, 48_000, tx.clone(), Arc::new(AtomicBool::new(false)));
        for _ in 0..300 {
            assert!(sender.push(&[0.0; 480]).is_empty());
        }
        assert_eq!(tx.sent_packets.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn single_losses_are_recovered_in_low_modes() {
        for mode in [Mode::Low, Mode::Minimum] {
            let (_, rx, _) = run(mode, Some(5));
            let lost = rx.lost_packets.load(Ordering::Relaxed);
            assert!(lost > 0);
            assert_eq!(rx.recovered_packets.load(Ordering::Relaxed), lost, "{mode:?}");
        }
    }

    #[test]
    fn receiver_follows_mode_changes() {
        let (tx, rx) = (Arc::new(Stats::default()), Arc::new(Stats::default()));
        let mut sender = Sender::new(Mode::High, 48_000, tx, Arc::new(AtomicBool::new(false)));
        let mut receiver = Receiver::new(48_000, rx.clone());
        let audio = speech(48_000, 2.0);
        let mut buf = vec![0.0; 480];
        let mut energy = 0.0;
        for (i, chunk) in audio.chunks(480).enumerate() {
            if i == 100 {
                sender.set_mode(Mode::Minimum);
            }
            for packet in sender.push(chunk) {
                receiver.push(&packet);
            }
            receiver.pull(&mut buf);
            if i > 120 {
                energy += rms(&buf);
            }
        }
        assert!(energy > 1.0, "tras cambiar de modo no suena nada");
        assert_eq!(rx.lost_packets.load(Ordering::Relaxed), 0);
    }
}
