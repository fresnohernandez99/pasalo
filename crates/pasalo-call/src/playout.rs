//! What is decoded and waiting to be played, between the thread that
//! decodes packets and the audio callback.
//!
//! The callback never waits for the decoder: the lock only guards the queue
//! and both sides hold it for a few microseconds (a copy of one packet's
//! worth of samples at most). The callback allocates nothing either.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use crate::Mode;
use crate::dsp::rms;
use crate::stats::Stats;

/// What is accumulated before starting to play, to absorb jitter. Never
/// less than two packets: if one is lost, the next carries its copy (low
/// modes) and has to arrive before the buffer runs dry.
fn start_ms(mode: Mode) -> usize {
    (2 * mode.packet_ms() as usize + 40).max(120)
}
/// Before any packet says the mode.
const DEFAULT_START_MS: usize = 120;
/// If more than this accumulates on top of the start, the oldest is
/// discarded so as not to fall further and further behind.
const SLACK_MS: usize = 400;

/// Playback queue shared with the audio callback. Cheap to clone the `Arc`
/// it lives in; see [`crate::Receiver::playout`].
pub struct Playout {
    queue: Mutex<Queue>,
    output_rate: u32,
    stats: Arc<Stats>,
}

struct Queue {
    out: VecDeque<f32>,
    playing: bool,
    /// Samples played since the last packet, to tell that the other person
    /// stopped talking.
    idle: usize,
    /// Samples to accumulate before playing.
    start: usize,
    /// Above this the oldest samples are dropped.
    max: usize,
    /// Idle samples after which a sentence is over and the queue plays what
    /// it has instead of waiting for `start`.
    quiet_after: usize,
}

impl Playout {
    pub(crate) fn new(output_rate: u32, stats: Arc<Stats>) -> Self {
        let rate = output_rate as usize;
        let queue = Queue {
            out: VecDeque::new(),
            playing: false,
            idle: 0,
            start: rate * DEFAULT_START_MS / 1000,
            max: rate * (DEFAULT_START_MS + SLACK_MS) / 1000,
            quiet_after: usize::MAX,
        };
        Self { queue: Mutex::new(queue), output_rate, stats }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Queue> {
        // A panic on the other side must not take the audio with it.
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The thresholds depend on how much audio each packet carries.
    pub(crate) fn set_mode(&self, mode: Mode) {
        let rate = self.output_rate as usize;
        let mut q = self.lock();
        q.start = rate * start_ms(mode) / 1000;
        q.max = rate * (start_ms(mode) + SLACK_MS) / 1000;
        q.quiet_after = rate * mode.packet_ms() as usize * 3 / 2000;
    }

    /// A packet arrived (with audio or not): the other person is talking.
    pub(crate) fn note_packet(&self) {
        self.lock().idle = 0;
    }

    /// Decoded audio at the output rate, ready to play.
    pub(crate) fn push(&self, samples: &[f32]) {
        let mut q = self.lock();
        q.out.extend(samples);
        if q.out.len() > q.max {
            let extra = q.out.len() - q.max;
            q.out.drain(..extra);
        }
    }

    /// Fills `buf` with what should play next (silence if nothing).
    pub fn pull(&self, buf: &mut [f32]) {
        {
            let mut q = self.lock();
            // End of a sentence: nothing more will come to complete the
            // start, so play what there is instead of waiting for the next.
            let quiet = q.idle > q.quiet_after;
            if !q.playing && (q.out.len() >= q.start || (quiet && !q.out.is_empty())) {
                q.playing = true;
            }
            q.idle += buf.len();
            if q.playing {
                for sample in buf.iter_mut() {
                    *sample = q.out.pop_front().unwrap_or(0.0);
                }
            } else {
                buf.fill(0.0);
            }
            if q.out.is_empty() {
                q.playing = false;
            }
        }
        // Level of what plays, decaying slowly to cover the tail of the echo.
        let level = rms(buf).max(self.stats.far_level() * 0.9);
        self.stats.set_far_level(level);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn playout(mode: Mode) -> Playout {
        let p = Playout::new(1000, Arc::new(Stats::default()));
        p.set_mode(mode);
        p
    }

    #[test]
    fn waits_for_the_start_then_plays_and_stops_when_empty() {
        let p = playout(Mode::Normal);
        let start = start_ms(Mode::Normal);
        let mut buf = [0.0; 10];
        p.note_packet();
        p.push(&vec![0.5; start - 1]);
        p.pull(&mut buf);
        assert!(buf.iter().all(|&s| s == 0.0), "not enough yet");
        p.push(&[0.5]);
        p.pull(&mut buf);
        assert!(buf.iter().all(|&s| s == 0.5), "plays once the start is reached");
        for _ in 0..start / 10 {
            p.pull(&mut buf);
        }
        assert!(buf.iter().all(|&s| s == 0.0), "silence when the queue runs dry");
        p.note_packet();
        p.push(&[0.5; 5]);
        p.pull(&mut buf);
        assert!(buf.iter().all(|&s| s == 0.0), "waits for the start again");
    }

    #[test]
    fn a_short_tail_plays_once_the_sentence_is_over() {
        let p = playout(Mode::Normal);
        let mut buf = [0.0; 10];
        p.note_packet();
        p.push(&[0.5; 20]);
        let quiet = Mode::Normal.packet_ms() as usize * 3 / 2;
        for _ in 0..quiet / 10 {
            p.pull(&mut buf);
        }
        assert!(buf.iter().all(|&s| s == 0.0), "still waiting");
        p.pull(&mut buf);
        p.pull(&mut buf);
        assert!(buf.iter().all(|&s| s == 0.5), "plays the tail without filling the start");
    }

    #[test]
    fn old_audio_is_dropped_when_too_much_accumulates() {
        let p = playout(Mode::High);
        let max = start_ms(Mode::High) + SLACK_MS;
        p.push(&vec![0.1; max]);
        p.push(&[0.9; 100]);
        let mut buf = vec![0.0; max];
        p.pull(&mut buf);
        assert_eq!(buf.iter().filter(|&&s| s == 0.9).count(), 100, "the newest audio is kept");
    }
}
