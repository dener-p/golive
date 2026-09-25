# NAT test matrix — results

Each row is one probe: `webrtc-check` (or `matrix/run.ps1`) on one network, the golive
helper on another. **Media never traverses the server/tunnel — this measures the direct
WebRTC (STUN-only) path between the two sides.** Signaling goes through the server.

Columns:
- **side** — free-text label of which network this run came from (`A=` helper side, `B=` probe side)
- **direct** — `YES` = ICE connected AND RTP packets flowed; `NO` = failed before media
- **path** — selected candidate pair: `<local type> <local addr> <-> <remote type> <remote addr>`
- **cands** — how many local ICE candidates were gathered, and whether STUN produced a
  server-reflexive address. `NO srflx` usually means STUN/UDP is blocked from that network.
- **connect ms / pk / kf / ice** — connection time, RTP packets, keyframes (≈ media frames),
  final ICE state.

Reading a `NO` row: check `cands` first. `NO srflx` → that side's NAT/UDP is the problem.
Otherwise the two routers can't mutual-hole-punch (symmetric NAT is the usual suspect).

| date | side | direct | path | cands | connect ms | pk | kf | ice |
|------|------|--------|------|-------|-----------|----|----|-----|
| 2026-09-25 | A=this-box loopback | YES | host fdfd::1aba:db37:65100 <-> host fdfd::1aba:db37:56306 | 13 cands / srflx OK | 1069 ms | 3569 pk | 5 kf | connected |
| 2026-09-25 | A=this-box via puhl.dev tunnel | YES | host fdfd::1aba:db37:58882 <-> host fdfd::1aba:db37:58857 | 13 cands / srflx OK | 1368 ms | 1411 pk | 5 kf | connected |
| 2026-09-25 | B=phone on home WiFi (same /64 as PC) | YES | srflx 2804:2984:9529:2100:… <-> srflx 2804:2984:9529:2100:… | browser (no probe) | ~1 s | n/a | streamed | connected |
| 2026-09-25 | **B=notebook via USB tether (IPv4-only, phone-NAT → carrier CGNAT)** | **NO** | — (ICE failed after ~30 s; helper v3/v7/v12: 3 attempts) | unknown (browser) | — | 0 | no media | **failed** |
<!-- results appended here by matrix/run.ps1 -->