//! Códecs de voz: Opus (libopus traducida a Rust, sin compilar C) y Codec2
//! (Rust puro), detrás de una interfaz común de frames de PCM mono `i16`.

use unsafe_libopus as unsafe_opus;

use crate::Mode;

pub(crate) trait Encoder: Send {
    fn encode(&mut self, pcm: &[i16]) -> Vec<u8>;
}

pub(crate) trait Decoder: Send {
    /// `None` es un frame perdido: el decoder rellena lo mejor que puede.
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
            Codec::Codec2 { mode } => codec2::Codec2::new(mode.lib()).samples_per_frame(),
        }
    }

    pub fn frame_ms(&self) -> u32 {
        self.frame_samples() as u32 * 1000 / self.sample_rate()
    }

    /// Bytes de cada frame si el códec los da de tamaño fijo (Codec2).
    pub fn fixed_frame_bytes(&self) -> Option<usize> {
        match self {
            Codec::Opus { .. } => None,
            Codec::Codec2 { mode } => Some(codec2::Codec2::new(mode.lib()).bits_per_frame().div_ceil(8)),
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
}

// El estado de libopus no se comparte entre hilos: cada encoder lo usa uno solo.
unsafe impl Send for OpusEncoder {}

impl OpusEncoder {
    fn new(rate: u32, bitrate: i32, narrowband: bool) -> Self {
        let mut error = 0;
        // SAFETY: parámetros válidos de libopus; se comprueba el error.
        unsafe {
            let st = unsafe_opus::opus_encoder_create(rate as i32, 1, unsafe_opus::OPUS_APPLICATION_VOIP, &mut error);
            assert!(error == unsafe_opus::OPUS_OK && !st.is_null(), "opus_encoder_create: {error}");
            unsafe_opus::opus_encoder_ctl!(st, unsafe_opus::OPUS_SET_BITRATE_REQUEST, bitrate);
            unsafe_opus::opus_encoder_ctl!(st, unsafe_opus::OPUS_SET_SIGNAL_REQUEST, unsafe_opus::OPUS_SIGNAL_VOICE);
            unsafe_opus::opus_encoder_ctl!(st, unsafe_opus::OPUS_SET_COMPLEXITY_REQUEST, 10);
            // Sin FEC: su copia reducida del frame anterior gasta parte del
            // bitrate y en esta versión de libopus no se puede usar, porque
            // reconstruir con ella satura igual que el PLC (probado). Las
            // pérdidas se cubren con el relleno propio y, en los modos de
            // poco consumo, con la copia del paquete anterior.
            if narrowband {
                unsafe_opus::opus_encoder_ctl!(st, unsafe_opus::OPUS_SET_MAX_BANDWIDTH_REQUEST, unsafe_opus::OPUS_BANDWIDTH_NARROWBAND);
            }
            Self { st }
        }
    }
}

impl Encoder for OpusEncoder {
    fn encode(&mut self, pcm: &[i16]) -> Vec<u8> {
        let mut out = vec![0u8; 400];
        // SAFETY: `pcm` tiene exactamente un frame y `out` cabe en max_data_bytes.
        let n = unsafe { unsafe_opus::opus_encode(self.st, pcm.as_ptr(), pcm.len() as i32, out.as_mut_ptr(), out.len() as i32) };
        out.truncate(n.max(0) as usize);
        out
    }
}

impl Drop for OpusEncoder {
    fn drop(&mut self) {
        // SAFETY: creado con opus_encoder_create y no se usa después.
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
        // SAFETY: parámetros válidos; se comprueba el error.
        let st = unsafe { unsafe_opus::opus_decoder_create(rate as i32, 1, &mut error) };
        assert!(error == unsafe_opus::OPUS_OK && !st.is_null(), "opus_decoder_create: {error}");
        Self { st, frame: (rate * frame_ms / 1000) as usize, last: Vec::new() }
    }
}

impl Decoder for OpusDecoder {
    fn decode(&mut self, frame: Option<&[u8]>) -> Vec<i16> {
        let Some(data) = frame else {
            // Pérdida. El PLC de esta versión de libopus (`unsafe-libopus`)
            // satura la salida y deja mal el decoder para los frames
            // siguientes (ver la prueba de abajo), así que no se usa: se
            // repite una vez el último frame a media voz y luego silencio.
            return std::mem::take(&mut self.last).into_iter().map(|s| s / 2).chain(std::iter::repeat(0)).take(self.frame).collect();
        };
        let mut pcm = vec![0i16; self.frame];
        // SAFETY: `pcm` tiene sitio para un frame completo.
        let n = unsafe { unsafe_opus::opus_decode(self.st, data.as_ptr(), data.len() as i32, pcm.as_mut_ptr(), self.frame as i32, 0) };
        pcm.truncate(n.max(0) as usize);
        pcm.resize(self.frame, 0);
        self.last = pcm.clone();
        pcm
    }
}

impl Drop for OpusDecoder {
    fn drop(&mut self) {
        // SAFETY: creado con opus_decoder_create y no se usa después.
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
        let mut bits = vec![0u8; self.c2.bits_per_frame().div_ceil(8)];
        self.c2.encode(&mut bits, pcm);
        bits
    }
}

impl Decoder for Codec2Codec {
    fn decode(&mut self, frame: Option<&[u8]>) -> Vec<i16> {
        let mut pcm = vec![0i16; self.c2.samples_per_frame()];
        match frame {
            Some(bits) => {
                self.last = bits.to_vec();
                self.c2.decode(&mut pcm, bits);
            }
            // Sin PLC propio: repetir el último frame una vez suena mejor que un hueco.
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

    /// Con pérdidas el relleno no puede dispararse. El PLC de `unsafe-libopus`
    /// daba picos de 32767 aquí, también en los frames buenos de después.
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
            assert!(peaks.iter().all(|&p| p < 16_000), "{mode:?}: el relleno se dispara: {peaks:?}");
        }
    }
}

