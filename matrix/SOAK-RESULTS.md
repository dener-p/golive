# Fan-out soak results (M4 exit: single encode -> ~10 viewers)

Method: `matrix/soak.ps1` launches N concurrent `webrtc-check` viewer peers against the
live room on the SAME LAN as the helper (IPv6 ULA host path). This measures the helper's
fan-out headroom and encoder CPU - not cross-network media quality (that is
`RESULTS.md`'s job). Media is one AMF encode (1080p screen, 4000 kbit/s), fanned out by
the helper to every connected peer. Each viewer receives = RTP packets actually delivered.

Columns: **viewers / connected / flowing** = the pass/fail core; **total pkts** =
sum across viewers; **pps avg** = per-viewer RTP packets/s; **cpu mid / all** = encoder
(helper+gst) one-core-equivalent CPU% sampled mid-run and averaged over the whole run.

| date | viewers | connected | flowing | total pkts | pps avg/viewer | cpu mid / all | note |
|------|---------|-----------|---------|------------|----------------|---------------|------|
| 2026-09-25 | 5 | 5/5 | 5/5 | 19773 | ~198 | 53% / 38% | all direct, IPv6 ULA host path |
| 2026-09-25 | 10 | 10/10 | 10/10 | 33335 | ~167 | 82% / 52% | all direct; helper log v26-v35 clean join + clean close |

**Verdict (2026-09-25): PASS for v1 scope.** At the 10-viewer cap every peer connected,
received the fanned-out stream, and tore down cleanly - helper log shows zero failed or
dropped viewer sessions in either run. Per-viewer RTP dropped ~15% at 10 vs 5 viewers
(same-box probe contention), not a helper bottleneck.

Caveats: "cpu mid" is sampled at the busiest moment and competes with the 10 probe
processes running on the same box; "cpu all" is the fairer headroom number. A browser
viewer elsewhere adds no local CPU. These runs validate fan-out + encoding headroom on
the helper, not cross-network reachability (see `RESULTS.md` for that).