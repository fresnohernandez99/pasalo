//! Llamadas de voz hechas en Rust para pasalo: micrófono → códec (Opus o
//! Codec2) → paquetes pequeños → red, y al revés. No sabe nada de la red: la
//! app le da una función para enviar paquetes y le pasa los que llegan.
//!
//! Los modos van de más calidad a menos consumo; el receptor se adapta solo
//! porque cada paquete dice con qué modo va.

mod codec;
#[cfg(feature = "devices")]
mod device;
mod dsp;
mod pipeline;

use serde::{Deserialize, Serialize};

#[cfg(feature = "devices")]
pub use device::{Call, CallError};
pub use pipeline::{OVERHEAD, Receiver, Sender, Stats};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Opus 24 kbps, banda ancha, paquetes de 20 ms.
    High,
    /// Opus 12 kbps, banda ancha, paquetes de 40 ms.
    Normal,
    /// Opus 6 kbps, banda estrecha, 2 frames de 60 ms por paquete.
    Low,
    /// Codec2 1300 bps, 4 frames de 40 ms por paquete.
    Minimum,
}

impl Mode {
    pub const ALL: [Mode; 4] = [Mode::High, Mode::Normal, Mode::Low, Mode::Minimum];

    /// Milisegundos de audio por paquete.
    pub fn packet_ms(self) -> u32 {
        codec::Codec::for_mode(self).frame_ms() * pipeline::frames_per_packet(self) as u32
    }
}
