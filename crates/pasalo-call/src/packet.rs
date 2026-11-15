//! Wire format of a voice packet.
//!
//! `[mode u8][seq u16 BE][n u8]` followed by the `n` frames: fixed-size and
//! back to back (Codec2), or each preceded by its `u8` length (Opus). In the
//! low-consumption modes the high bit of `mode` says that `[r u8]` and the
//! `r` frames of the previous packet follow: if that one was lost it is
//! recovered whole. Those modes carry 120-160 ms per packet, so losing one
//! would be a big gap, and the copy barely adds next to the headers.
//!
//! Nothing is sent during silence: `seq` only advances with what is sent, so
//! a gap in the sequence numbers is a real loss.
//!
//! Only the four mode ids and the high bit are defined: a receiver drops any
//! other first byte, so the format cannot grow without a new mode id.

use crate::Mode;
use crate::codec::Codec;

/// Bytes added by IP, UDP and QUIC to each datagram (approx., direct IPv4).
pub const OVERHEAD: u64 = 60;
const HEADER: usize = 4;
const REDUNDANT: u8 = 0x80;

/// Frames of audio in one packet.
pub(crate) fn frames_per_packet(mode: Mode) -> usize {
    match mode {
        Mode::High | Mode::Normal => 1,
        Mode::Low => 2,
        Mode::Minimum => 4,
    }
}

/// Whether packets of this mode also carry the previous packet.
pub(crate) fn redundant(mode: Mode) -> bool {
    matches!(mode, Mode::Low | Mode::Minimum)
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

/// Builds the packets of one mode, numbering them.
pub(crate) struct Writer {
    mode: Mode,
    fixed: bool,
    seq: u16,
}

impl Writer {
    /// `seq` is the number of the next packet (it survives mode changes).
    pub fn new(mode: Mode, seq: u16) -> Self {
        Self { mode, fixed: Codec::for_mode(mode).fixed_frame_bytes().is_some(), seq }
    }

    pub fn seq(&self) -> u16 {
        self.seq
    }

    /// A packet with `frames` and, in the redundant modes, a copy of
    /// `previous` (the frames of the packet before; empty for the first one).
    pub fn write(&mut self, frames: &[Vec<u8>], previous: &[Vec<u8>]) -> Vec<u8> {
        let copy = redundant(self.mode) && !previous.is_empty();
        let mut p = Vec::with_capacity(64);
        p.push(mode_id(self.mode) | if copy { REDUNDANT } else { 0 });
        p.extend_from_slice(&self.seq.to_be_bytes());
        self.write_frames(&mut p, frames);
        if copy {
            self.write_frames(&mut p, previous);
        }
        self.seq = self.seq.wrapping_add(1);
        p
    }

    fn write_frames(&self, p: &mut Vec<u8>, frames: &[Vec<u8>]) {
        p.push(frames.len() as u8);
        for frame in frames {
            if !self.fixed {
                p.push(frame.len() as u8);
            }
            p.extend_from_slice(frame);
        }
    }
}

/// A parsed packet; the frames borrow from the datagram.
pub(crate) struct Packet<'a> {
    pub mode: Mode,
    pub seq: u16,
    pub frames: Vec<&'a [u8]>,
    /// The frames of the previous packet, if this one carries them intact.
    pub previous: Option<Vec<&'a [u8]>>,
}

/// `None` if the packet is not one of ours or is cut short.
pub(crate) fn parse(data: &[u8]) -> Option<Packet<'_>> {
    if data.len() < HEADER {
        return None;
    }
    let mode = mode_from_id(data[0] & !REDUNDANT)?;
    let has_copy = data[0] & REDUNDANT != 0;
    let seq = u16::from_be_bytes([data[1], data[2]]);
    let codec = Codec::for_mode(mode);
    let (frames, rest) = parse_frames(&data[HEADER - 1..], codec)?;
    // A damaged copy is only a copy: the packet itself is still good.
    let previous = if has_copy { parse_frames(rest, codec).map(|(frames, _)| frames) } else { None };
    Some(Packet { mode, seq, frames, previous })
}

/// Reads `[n u8]` and `n` frames; returns them and what is left behind.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(mode: Mode, fill: u8) -> Vec<Vec<u8>> {
        let codec = Codec::for_mode(mode);
        (0..frames_per_packet(mode)).map(|i| vec![fill + i as u8; codec.fixed_frame_bytes().unwrap_or(10 + i)]).collect()
    }

    #[test]
    fn packets_round_trip_in_every_mode() {
        for mode in Mode::ALL {
            let mut writer = Writer::new(mode, 7);
            let first = writer.write(&frames(mode, 1), &[]);
            let second = writer.write(&frames(mode, 20), &frames(mode, 1));
            let p = parse(&first).expect("first packet parses");
            assert_eq!((p.mode, p.seq), (mode, 7));
            assert_eq!(p.frames, frames(mode, 1).iter().map(Vec::as_slice).collect::<Vec<_>>());
            assert!(p.previous.is_none(), "{mode:?}: nothing to repeat yet");
            let p = parse(&second).expect("second packet parses");
            assert_eq!(p.seq, 8);
            assert_eq!(p.frames, frames(mode, 20).iter().map(Vec::as_slice).collect::<Vec<_>>());
            let copy = p.previous.map(|f| f.iter().map(|s| s.to_vec()).collect::<Vec<_>>());
            assert_eq!(copy, redundant(mode).then(|| frames(mode, 1)), "{mode:?}");
        }
    }

    #[test]
    fn damaged_packets_are_dropped_but_a_damaged_copy_is_not() {
        let mut writer = Writer::new(Mode::Low, 0);
        let packet = writer.write(&frames(Mode::Low, 1), &frames(Mode::Low, 9));
        assert!(parse(&packet[..3]).is_none(), "too short");
        let mut bad_mode = packet.clone();
        bad_mode[0] = 0x45;
        assert!(parse(&bad_mode).is_none(), "unknown mode id");
        let frames_end = HEADER + frames(Mode::Low, 1).iter().map(|f| 1 + f.len()).sum::<usize>();
        let p = parse(&packet[..frames_end + 1]).expect("the packet itself is intact");
        assert_eq!(p.frames.len(), 2);
        assert!(p.previous.is_none(), "the cut copy is ignored");
        assert!(parse(&packet[..frames_end - 1]).is_none(), "a cut frame drops the packet");
    }
}
