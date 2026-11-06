//! Remuestreo y detección de voz, lo justo para una llamada.

/// Cambia la frecuencia de muestreo de una señal mono que llega por trozos.
/// Primero filtra paso bajo (FIR con ventana) para no meter aliasing al bajar
/// de 48 kHz a 8 kHz, y después interpola linealmente.
pub(crate) struct Resampler {
    step: f64,
    pos: f64,
    taps: Vec<f32>,
    history: Vec<f32>,
    filtered: Vec<f32>,
}

const TAPS: usize = 31;

impl Resampler {
    pub fn new(from: u32, to: u32) -> Self {
        // Corte un poco por debajo del Nyquist de la frecuencia más baja.
        let cutoff = 0.45 * from.min(to) as f64 / from as f64;
        let mid = (TAPS / 2) as f64;
        let mut taps: Vec<f32> = (0..TAPS)
            .map(|i| {
                let x = i as f64 - mid;
                let sinc = if x == 0.0 { 2.0 * cutoff } else { (2.0 * std::f64::consts::PI * cutoff * x).sin() / (std::f64::consts::PI * x) };
                let window = 0.54 - 0.46 * (2.0 * std::f64::consts::PI * i as f64 / (TAPS - 1) as f64).cos();
                (sinc * window) as f32
            })
            .collect();
        let sum: f32 = taps.iter().sum();
        for t in &mut taps {
            *t /= sum;
        }
        Self { step: from as f64 / to as f64, pos: 0.0, taps, history: vec![0.0; TAPS], filtered: Vec::new() }
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for &x in input {
            self.history.rotate_left(1);
            *self.history.last_mut().expect("TAPS > 0") = x;
            let y = self.history.iter().zip(&self.taps).map(|(a, b)| a * b).sum();
            self.filtered.push(y);
        }
        // Interpola entre muestras filtradas; se queda con la última para el siguiente trozo.
        while self.pos + 1.0 < self.filtered.len() as f64 {
            let i = self.pos as usize;
            let frac = (self.pos - i as f64) as f32;
            out.push(self.filtered[i] * (1.0 - frac) + self.filtered[i + 1] * frac);
            self.pos += self.step;
        }
        let used = (self.pos as usize).min(self.filtered.len().saturating_sub(1));
        self.filtered.drain(..used);
        self.pos -= used as f64;
    }
}

/// Decide si un frame es voz comparando su energía con el ruido de fondo,
/// que se va aprendiendo. Después de hablar sigue diciendo "voz" un rato
/// para no cortar el final de las palabras.
pub(crate) struct Vad {
    noise: f32,
    hangover: u32,
    hold: u32,
}

impl Vad {
    pub fn new(frame_ms: u32) -> Self {
        Self { noise: 1e-4, hangover: 0, hold: 400 / frame_ms.max(1) }
    }

    /// Corta ya el "sigue siendo voz" de después de hablar.
    pub fn end_hangover(&mut self) {
        self.hangover = 0;
    }

    pub fn is_voice(&mut self, frame: &[f32]) -> bool {
        let energy = frame.iter().map(|s| s * s).sum::<f32>() / frame.len().max(1) as f32;
        let loud = energy > (self.noise * 4.0).max(2e-6);
        // El ruido de fondo sube despacio y baja rápido.
        self.noise = if energy < self.noise { energy } else { self.noise * 0.995 + energy * 0.005 };
        if loud {
            self.hangover = self.hold;
        } else {
            self.hangover = self.hangover.saturating_sub(1);
        }
        loud || self.hangover > 0
    }
}

pub(crate) fn rms(samples: &[f32]) -> f32 {
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt()
}

pub(crate) fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples.iter().map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16).collect()
}

pub(crate) fn to_f32(samples: &[i16]) -> Vec<f32> {
    samples.iter().map(|&s| s as f32 / 32768.0).collect()
}
