//! Shared counters of a call.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use crate::packet::OVERHEAD;

/// Shared counters of a call.
#[derive(Default)]
pub struct Stats {
    pub sent_bytes: AtomicU64,
    pub sent_packets: AtomicU64,
    pub received_bytes: AtomicU64,
    pub received_packets: AtomicU64,
    pub lost_packets: AtomicU64,
    /// Lost packets that were recovered from the copy in the next one.
    pub recovered_packets: AtomicU64,
    /// Recent level of what the speaker is playing (bits of an `f32`), so
    /// that its echo is not sent back.
    pub(crate) far_level: AtomicU32,
}

impl Stats {
    /// Bytes on the wire, with the estimated header of each packet.
    pub fn wire_bytes_sent(&self) -> u64 {
        self.sent_bytes.load(Ordering::Relaxed) + self.sent_packets.load(Ordering::Relaxed) * OVERHEAD
    }

    pub fn wire_bytes_received(&self) -> u64 {
        self.received_bytes.load(Ordering::Relaxed) + self.received_packets.load(Ordering::Relaxed) * OVERHEAD
    }

    pub(crate) fn far_level(&self) -> f32 {
        f32::from_bits(self.far_level.load(Ordering::Relaxed))
    }

    pub(crate) fn set_far_level(&self, level: f32) {
        self.far_level.store(level.to_bits(), Ordering::Relaxed);
    }
}
