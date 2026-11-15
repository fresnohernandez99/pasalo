//! Voice calls in Rust for pasalo: microphone → codec (Opus or Codec2) →
//! small packets → network, and back. It knows nothing about the network:
//! the app gives it a function to send packets and hands it the ones that
//! arrive.
//!
//! The modes go from more quality to less consumption; the receiver adapts
//! by itself because every packet says which mode it carries.
//!
//! - [`Sender`]: microphone → packets ([`sender`]), with the voice
//!   detection and the echo gate.
//! - [`Receiver`]: packets → audio ([`receiver`]), with the loss
//!   concealment, and its [`Playout`] queue that the speaker drains
//!   ([`playout`]).
//! - [`packet`]: the wire format.
//! - [`Call`] (feature `devices`): the above wired to the microphone and
//!   the speaker, in threads of its own. [`devices`] lists the ones there
//!   are and a [`Selection`] says which to open.

mod codec;
#[cfg(feature = "devices")]
mod device;
mod dsp;
mod packet;
mod playout;
mod receiver;
mod sender;
mod stats;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};

#[cfg(feature = "devices")]
pub use device::{Call, CallError, DeviceInfo, DeviceList, Selection, devices};
pub use packet::OVERHEAD;
pub use playout::Playout;
pub use receiver::Receiver;
pub use sender::Sender;
pub use stats::Stats;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Opus 24 kbps, wideband, 40 ms packets.
    High,
    /// Opus 12 kbps, wideband, 60 ms packets.
    Normal,
    /// Opus 6 kbps, narrowband, 2 frames of 60 ms per packet.
    Low,
    /// Codec2 1300 bps, 4 frames of 40 ms per packet.
    Minimum,
}

impl Mode {
    pub const ALL: [Mode; 4] = [Mode::High, Mode::Normal, Mode::Low, Mode::Minimum];

    /// Milliseconds of audio per packet.
    pub fn packet_ms(self) -> u32 {
        codec::Codec::for_mode(self).frame_ms() * packet::frames_per_packet(self) as u32
    }
}
