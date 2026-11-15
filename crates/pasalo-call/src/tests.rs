//! End-to-end: a [`Sender`] feeding a [`Receiver`] with audio from memory.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::dsp::rms;
use crate::{Mode, Receiver, Sender, Stats};

/// Fake speech: a tone with harmonics that switches on and off.
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
        assert!(rms(&out) > 0.02, "{mode:?}: output almost mute ({})", rms(&out));
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

/// Lost packets beyond what the copy covers are concealed, not counted as recovered.
#[test]
fn bursts_are_concealed_without_blowing_up() {
    for mode in Mode::ALL {
        let (_, rx, out) = run(mode, Some(2));
        assert!(rx.lost_packets.load(Ordering::Relaxed) > 0, "{mode:?}");
        assert!(out.iter().all(|s| s.abs() <= 1.0), "{mode:?}: the fill clips");
        assert!(rms(&out) > 0.01, "{mode:?}: output almost mute ({})", rms(&out));
    }
}

/// The other person talks all the time (level 0.2) and the microphone picks
/// up `echo` of it; halfway, the person here talks over. Returns the packets
/// sent with only echo and with voice over it.
fn talk_over(echo: f32, near: f32) -> (usize, usize) {
    let stats = Arc::new(Stats::default());
    let mut sender = Sender::new(Mode::Normal, 48_000, stats.clone(), Arc::new(AtomicBool::new(false)));
    let far = speech(48_000, 6.0);
    let mine: Vec<f32> = speech(48_000, 6.0).iter().rev().copied().collect();
    let (mut only_echo, mut over) = (0, 0);
    let mut level = 0.0f32;
    for (i, chunk) in far.chunks(480).enumerate() {
        // Like the receiver: the playback level decays slowly.
        level = rms(chunk).max(level * 0.9);
        stats.set_far_level(level);
        let talking = i >= 300;
        let mic: Vec<f32> = chunk
            .iter()
            .zip(&mine[i * 480..])
            .map(|(f, m)| f * echo + if talking { m * near } else { 0.0 })
            .collect();
        let sent = sender.push(&mic).len();
        if talking { over += sent } else { only_echo += sent }
    }
    (only_echo, over)
}

#[test]
fn echo_gate_learns_how_much_echo_comes_back() {
    // Headphones: almost no echo. Talking over has to get through, even
    // quieter than the other person sounds.
    let (only_echo, over) = talk_over(0.02, 0.1);
    assert!(only_echo <= 3, "with headphones echo is sent back ({only_echo})");
    assert!(over > 20, "with headphones talking over is blocked ({over})");
    // Speaker: a lot of echo. It is not sent back.
    let (only_echo, _) = talk_over(0.4, 0.0);
    assert!(only_echo <= 2, "the speaker echo is sent back ({only_echo})");
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
    assert!(energy > 1.0, "nothing plays after the mode change");
    assert_eq!(rx.lost_packets.load(Ordering::Relaxed), 0);
}

/// The sender keeps numbering across a mode change, so the receiver sees no loss.
#[test]
fn mode_change_keeps_the_sequence() {
    let (tx, rx) = (Arc::new(Stats::default()), Arc::new(Stats::default()));
    let mut sender = Sender::new(Mode::Normal, 48_000, tx, Arc::new(AtomicBool::new(false)));
    let mut receiver = Receiver::new(48_000, rx.clone());
    for (i, chunk) in speech(48_000, 2.0).chunks(480).enumerate() {
        if i % 25 == 0 {
            sender.set_mode(Mode::ALL[(i / 25) % 4]);
        }
        for packet in sender.push(chunk) {
            receiver.push(&packet);
        }
    }
    assert_eq!(rx.lost_packets.load(Ordering::Relaxed), 0);
}

/// Another microphone and another speaker, each at another rate, in the
/// middle of a call: the audio carries on and the receiver sees no loss.
#[test]
fn devices_can_change_rate_mid_call() {
    let (tx, rx) = (Arc::new(Stats::default()), Arc::new(Stats::default()));
    let mut sender = Sender::new(Mode::Normal, 48_000, tx, Arc::new(AtomicBool::new(false)));
    let mut receiver = Receiver::new(48_000, rx.clone());
    let mut playout = receiver.playout();
    let mut energy = 0.0;
    for chunk in speech(48_000, 2.0).chunks(480) {
        for packet in sender.push(chunk) {
            receiver.push(&packet);
        }
    }
    assert!(Arc::ptr_eq(&playout, &receiver.set_output_rate(48_000)), "same rate, same queue");
    sender.set_input_rate(16_000);
    playout = receiver.set_output_rate(44_100);
    let mut buf = vec![0.0; 441];
    for chunk in speech(16_000, 2.0).chunks(160) {
        for packet in sender.push(chunk) {
            receiver.push(&packet);
        }
        playout.pull(&mut buf);
        energy += rms(&buf);
    }
    assert!(energy > 1.0, "nothing plays after the devices change");
    assert_eq!(rx.lost_packets.load(Ordering::Relaxed), 0);
}
