//! Voice codecs: Opus (libopus translated to Rust, no C to compile) and
//! Codec2 (pure Rust), behind a common interface of mono `i16` PCM frames.

use unsafe_libopus as unsafe_opus;

use crate::Mode;

pub(crate) trait Encoder: Send {
    fn encode(&mut self, pcm: &[i16]) -> Vec<u8>;
}

pub(crate) trait Decoder: Send {
    /// `None` is a lost frame: the decoder fills it in as best it can.
    fn decode(&mut self, frame: Option<&[u8]>) -> Vec<i16>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Codec {
    Opus { rate: u32, bitrate: i32, frame_ms: u32, narrowband: bool },
    Codec2 { mode: Codec2Mode },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Codec2Mode {
    M1300,
}

/// Codec2 1300: 40 ms frames at 8 kHz, 52 bits each. Fixed here so that
/// asking for them costs nothing: building a `codec2::Codec2` to ask it
/// allocates and computes FFT tables, and the sizes are needed on every
/// packet and in the audio callback. Checked against the library in a test.
const CODEC2_1300_SAMPLES: usize = 320;
const CODEC2_1300_BYTES: usize = 7;

impl Codec {
    pub fn for_mode(mode: Mode) -> Self {
        match mode {
            Mode::High => Codec::Opus { rate: 16_000, bitrate: 24_000, frame_ms: 40, narrowband: false },
            Mode::Normal => Codec::Opus { rate: 16_000, bitrate: 12_000, frame_ms: 60, narrowband: false },
            Mode::Low => Codec::Opus { rate: 8_000, bitrate: 6_000, frame_ms: 60, narrowband: true },
            Mode::Minimum => Codec::Codec2 { mode: Codec2Mode::M1300 },
        }
    }

    pub fn sample_rate(&self) -> u32 {
        match self {
            Codec::Opus { rate, .. } => *rate,
            Codec::Codec2 { .. } => 8_000,
        }
    }

    pub fn frame_samples(&self) -> usize {
        match self {
            Codec::Opus { rate, frame_ms, .. } => (*rate * *frame_ms / 1000) as usize,
            Codec::Codec2 { mode: Codec2Mode::M1300 } => CODEC2_1300_SAMPLES,
        }
    }

    pub fn frame_ms(&self) -> u32 {
        self.frame_samples() as u32 * 1000 / self.sample_rate()
    }

    /// Bytes of each frame if the codec makes them fixed-size (Codec2).
    pub fn fixed_frame_bytes(&self) -> Option<usize> {
        match self {
            Codec::Opus { .. } => None,
            Codec::Codec2 { mode: Codec2Mode::M1300 } => Some(CODEC2_1300_BYTES),
        }
    }

    pub fn encoder(&self) -> Box<dyn Encoder> {
        match *self {
            Codec::Opus { rate, bitrate, narrowband, .. } => Box::new(OpusEncoder::new(rate, bitrate, narrowband)),
            Codec::Codec2 { mode } => Box::new(Codec2Codec::new(mode)),
        }
    }

    pub fn decoder(&self) -> Box<dyn Decoder> {
        match *self {
            Codec::Opus { rate, frame_ms, .. } => Box::new(OpusDecoder::new(rate, frame_ms)),
            Codec::Codec2 { mode } => Box::new(Codec2Codec::new(mode)),
        }
    }
}

impl Codec2Mode {
    fn lib(self) -> codec2::Codec2Mode {
        match self {
            Codec2Mode::M1300 => codec2::Codec2Mode::MODE_1300,
        }
    }
}

struct OpusEncoder {
    st: *mut unsafe_opus::OpusEncoder,
    out: Vec<u8>,
}

// The libopus state is not shared between threads: each encoder is used by one.
unsafe impl Send for OpusEncoder {}

impl OpusEncoder {
    fn new(rate: u32, bitrate: i32, narrowband: bool) -> Self {
        let mut error = 0;
        // SAFETY: valid libopus parameters; the error is checked.
        unsafe {
            let st = unsafe_opus::opus_encoder_create(rate as i32, 1, unsafe_opus::OPUS_APPLICATION_VOIP, &mut error);
            assert!(error == unsafe_opus::OPUS_OK && !st.is_null(), "opus_encoder_create: {error}");
            unsafe_opus::opus_encoder_ctl!(st, unsafe_opus::OPUS_SET_BITRATE_REQUEST, bitrate);
            unsafe_opus::opus_encoder_ctl!(st, unsafe_opus::OPUS_SET_SIGNAL_REQUEST, unsafe_opus::OPUS_SIGNAL_VOICE);
            unsafe_opus::opus_encoder_ctl!(st, unsafe_opus::OPUS_SET_COMPLEXITY_REQUEST, 10);
            // No FEC: its reduced copy of the previous frame takes part of
            // the bitrate and in this version of libopus it cannot be used,
            // because rebuilding from it saturates just like the PLC
            // (tested). Losses are covered by our own fill and, in the
            // low-consumption modes, by the copy of the previous packet.
            if narrowband {
                unsafe_opus::opus_encoder_ctl!(st, unsafe_opus::OPUS_SET_MAX_BANDWIDTH_REQUEST, unsafe_opus::OPUS_BANDWIDTH_NARROWBAND);
            }
            Self { st, out: vec![0u8; 400] }
        }
    }
}

impl Encoder for OpusEncoder {
    fn encode(&mut self, pcm: &[i16]) -> Vec<u8> {
        // SAFETY: `pcm` holds exactly one frame and `out` fits max_data_bytes.
        let n = unsafe { unsafe_opus::opus_encode(self.st, pcm.as_ptr(), pcm.len() as i32, self.out.as_mut_ptr(), self.out.len() as i32) };
        self.out[..n.max(0) as usize].to_vec()
    }
}

impl Drop for OpusEncoder {
    fn drop(&mut self) {
        // SAFETY: created with opus_encoder_create and not used afterwards.
        unsafe { unsafe_opus::opus_encoder_destroy(self.st) }
    }
}

struct OpusDecoder {
    st: *mut unsafe_opus::OpusDecoder,
    frame: usize,
    last: Vec<i16>,
}

unsafe impl Send for OpusDecoder {}

impl OpusDecoder {
    fn new(rate: u32, frame_ms: u32) -> Self {
        let mut error = 0;
        // SAFETY: valid parameters; the error is checked.
        let st = unsafe { unsafe_opus::opus_decoder_create(rate as i32, 1, &mut error) };
        assert!(error == unsafe_opus::OPUS_OK && !st.is_null(), "opus_decoder_create: {error}");
        Self { st, frame: (rate * frame_ms / 1000) as usize, last: Vec::new() }
    }
}

impl Decoder for OpusDecoder {
    fn decode(&mut self, frame: Option<&[u8]>) -> Vec<i16> {
        let Some(data) = frame else {
            // A loss. The PLC of this version of libopus (`unsafe-libopus`)
            // saturates the output and leaves the decoder broken for the
            // following frames (see the test below), so it is not used: the
            // last frame is repeated once at half volume, then silence.
            return std::mem::take(&mut self.last).into_iter().map(|s| s / 2).chain(std::iter::repeat(0)).take(self.frame).collect();
        };
        let mut pcm = vec![0i16; self.frame];
        // SAFETY: `pcm` has room for a whole frame.
        let n = unsafe { unsafe_opus::opus_decode(self.st, data.as_ptr(), data.len() as i32, pcm.as_mut_ptr(), self.frame as i32, 0) };
        pcm.truncate(n.max(0) as usize);
        pcm.resize(self.frame, 0);
        self.last = pcm.clone();
        pcm
    }
}

impl Drop for OpusDecoder {
    fn drop(&mut self) {
        // SAFETY: created with opus_decoder_create and not used afterwards.
        unsafe { unsafe_opus::opus_decoder_destroy(self.st) }
    }
}

struct Codec2Codec {
    c2: codec2::Codec2,
    last: Vec<u8>,
}

impl Codec2Codec {
    fn new(mode: Codec2Mode) -> Self {
        Self { c2: codec2::Codec2::new(mode.lib()), last: Vec::new() }
    }
}

impl Encoder for Codec2Codec {
    fn encode(&mut self, pcm: &[i16]) -> Vec<u8> {
        let mut bits = vec![0u8; CODEC2_1300_BYTES];
        self.c2.encode(&mut bits, pcm);
        bits
    }
}

impl Decoder for Codec2Codec {
    fn decode(&mut self, frame: Option<&[u8]>) -> Vec<i16> {
        let mut pcm = vec![0i16; CODEC2_1300_SAMPLES];
        match frame {
            Some(bits) => {
                self.last = bits.to_vec();
                self.c2.decode(&mut pcm, bits);
            }
            // No PLC of its own: repeating the last frame once sounds better than a hole.
            None if !self.last.is_empty() => {
                let last = std::mem::take(&mut self.last);
                self.c2.decode(&mut pcm, &last);
                for s in &mut pcm {
                    *s /= 2;
                }
            }
            None => {}
        }
        pcm
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, n: usize) -> Vec<i16> {
        (0..n).map(|i| ((i as f32 * 2.0 * std::f32::consts::PI * 220.0 / rate as f32).sin() * 8000.0) as i16).collect()
    }

    fn peak(pcm: &[i16]) -> i32 {
        pcm.iter().map(|s| (*s as i32).abs()).max().unwrap_or(0)
    }

    #[test]
    fn codec2_sizes_match_the_library() {
        let c2 = codec2::Codec2::new(codec2::Codec2Mode::MODE_1300);
        assert_eq!(c2.samples_per_frame(), CODEC2_1300_SAMPLES);
        assert_eq!(c2.bits_per_frame().div_ceil(8), CODEC2_1300_BYTES);
    }

    /// With losses the fill must not blow up. The PLC of `unsafe-libopus`
    /// gave peaks of 32767 here, also in the good frames afterwards.
    #[test]
    fn opus_loss_concealment_stays_quiet() {
        for mode in [Mode::High, Mode::Low] {
            let codec = Codec::for_mode(mode);
            let (mut enc, mut dec) = (codec.encoder(), codec.decoder());
            let frame = codec.frame_samples();
            let input = tone(codec.sample_rate(), frame * 20);
            let mut peaks = Vec::new();
            for (i, chunk) in input.chunks(frame).enumerate() {
                let bits = enc.encode(chunk);
                let pcm = if i % 4 == 3 { dec.decode(None) } else { dec.decode(Some(&bits)) };
                peaks.push(peak(&pcm));
            }
            assert!(peaks.iter().all(|&p| p < 16_000), "{mode:?}: the fill blows up: {peaks:?}");
        }
    }
}
