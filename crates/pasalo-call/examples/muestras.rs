//! Pasa un audio por cada modo de llamada, como si fuera en tiempo real, y
//! cuenta lo que gasta en la red. Deja cómo se oiría al otro lado.
//!
//! `cargo run --release -p pasalo-call --example muestras -- voz.raw salida/ [pérdida%]`
//! `voz.raw`: PCM mono de 16 bits a 48 kHz. La salida, en el mismo formato.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use pasalo_call::{Mode, OVERHEAD, Receiver, Sender, Stats};

const RATE: u32 = 48_000;
const STEP: usize = 480; // 10 ms

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input = std::fs::read(&args[1]).expect("audio de entrada");
    let out_dir = std::path::PathBuf::from(&args[2]);
    let loss: f64 = args.get(3).map_or(0.0, |s| s.parse().unwrap()) / 100.0;
    std::fs::create_dir_all(&out_dir).unwrap();
    let samples: Vec<f32> = input.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b) as f32 / 32768.0).collect();
    let seconds = samples.len() as f64 / RATE as f64;

    println!("{:<8} {:>8} {:>9} {:>11} {:>10} {:>9} {:>11}", "modo", "paquete", "paquetes", "voz (kbps)", "red (kbps)", "perdidos", "recuperados");
    for mode in Mode::ALL {
        let stats = Arc::new(Stats::default());
        let mut sender = Sender::new(mode, RATE, stats.clone(), Arc::new(AtomicBool::new(false)));
        let rx_stats = Arc::new(Stats::default());
        let mut receiver = Receiver::new(RATE, rx_stats.clone());
        let mut out = Vec::with_capacity(samples.len());
        let mut buf = vec![0.0f32; STEP];
        let mut rng = 0x2545_f491_4f6c_dd1du64;
        // Medio segundo de más al final para que salga lo que queda en el búfer.
        let padded = samples.iter().copied().chain(std::iter::repeat_n(0.0, RATE as usize / 2)).collect::<Vec<_>>();
        for chunk in padded.chunks(STEP) {
            for packet in sender.push(chunk) {
                rng ^= rng << 13;
                rng ^= rng >> 7;
                rng ^= rng << 17;
                if (rng % 10_000) as f64 / 10_000.0 >= loss {
                    receiver.push(&packet);
                }
            }
            receiver.pull(&mut buf);
            out.extend(buf.iter().map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16));
        }
        let name = format!("{mode:?}").to_lowercase();
        let bytes: Vec<u8> = out.iter().flat_map(|s| s.to_le_bytes()).collect();
        std::fs::write(out_dir.join(format!("{name}.raw")), bytes).unwrap();

        let packets = stats.sent_packets.load(Ordering::Relaxed);
        let payload = stats.sent_bytes.load(Ordering::Relaxed);
        println!(
            "{:<8} {:>6}ms {:>9} {:>11.2} {:>10.2} {:>9} {:>11}",
            name,
            mode.packet_ms(),
            packets,
            payload as f64 * 8.0 / seconds / 1000.0,
            (payload + packets * OVERHEAD) as f64 * 8.0 / seconds / 1000.0,
            rx_stats.lost_packets.load(Ordering::Relaxed),
            rx_stats.recovered_packets.load(Ordering::Relaxed),
        );
    }
}
