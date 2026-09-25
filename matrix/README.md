# NAT test matrix — procedure

The one thing v1 hasn't proven is **direct P2P across two real networks**. Everything so
far was loopback/LAN. This folder makes that test repeatable so we can fill the matrix and
eventually seed the M7 regression suite.

## Mental model

```
  helper (network A)          server/tunnel (this box)         webrtc-check (network B)
      │                              │                              │
      └──── WS signaling ────────────┴──────────── WS signaling ─────┘
              │                                                      │
              └─────────────── P2P media (STUN only) ────────────────┘
```

Only the WebSocket signaling goes through the server/tunnel. The AV1 media must travel
directly between the two networks — that's what we're testing. `direct=true` means it did.

## Setup (host side, once)

The public signaling URL is **`https://golive.puhl.dev`** — a tunnel on this box that
forwards to `localhost:3000`.

1. Start the signaling server on the tunnel's port, then the helper:

   ```powershell
   .\bin\golive-server.exe -addr :3000
   .\bin\golive-helper.exe -server ws://localhost:3000 -autostart
   ```

   The helper prints the Viewer link, Host page URL, and the **host key**. The room/key
   persist across helper restarts (stored in `%APPDATA%\golive\identity`).

2. Verify the stream is actually on before anyone probes:
   `webrtc-check.exe -room <room> -key <key> -seconds 3` and check `actualKbps > 0`
   in the HOST STATUS block.

(If you ever need an ephemeral tunnel instead — e.g. to test on a phone — start
`cloudflared tunnel --url http://localhost:3000`, copy the printed `https://*.trycloudflare.com`
URL, and use that as `-Server`.)

## Run a probe (other side)

On the OTHER network (phone hotspot, friend's WiFi, office, …) run:

```powershell
..\matrix\run.ps1 -Server https://golive.puhl.dev -Room <room> -Label "B=phone-hotspot-4g" -Key <key>
```

or directly (for a one-off, non-Windows machine, or to watch `-verbose`):

```
webrtc-check -server https://golive.puhl.dev -room <room> -seconds 20
webrtc-check -server https://golive.puhl.dev -room <room> -seconds 20 -verbose   # show all local candidates
```

`run.ps1` parses the JSON result and appends a row to `RESULTS.md`. A `NO` (non-zero
exit) row is still appended — failures are data.

## What to test (work up the difficulty ladder)

| # | combo (helper side → probe side) | expect |
|---|----------------------------------|--------|
| 1 | this box loopback → same box | direct YES, host/prflx |
| 2 | this box WiFi → phone on SAME WiFi | direct YES |
| 5 | this box → office/guest WiFi | often fails (captive/symmetric) — good negative case |
| 6 | smartphone browser → viewer link | decode + stats, the real-live test |

**Marked skip (won't test):** devices on carrier mobile data (USB-tether notebook and the
phone itself) with **no IPv6**. Seen in practice: IPv4-only + carrier CGNAT cannot
mutual-hole-punch against a home router — the helper logged the notebook failing after
~30 s of ICE, all attempts (rows in RESULTS.md). Even Parsec, which runs its own relay
infrastructure, cannot connect there — so a direct/STUN-only v1 getting a clean
"Direct connection failed" is the *correct* v1 outcome, not a fixable gap. Only a relay
(v2 TURN) could help that environment.

## Reading the results

- **`NO srflx` on the probe side** → STUN/UDP blocked from that network; expect failure.
- **direct `NO` but srflx OK on both sides** → routers won't hole-punch (symmetric NAT).
  That's the case M6 ("maximize direct") targets — and the honest v1 answer is the clear
  "Direct connection failed" error until then.
- **path shows `host`/`prflx`** = same-LAN or reflexive success; `srflx` on the media path
  is the classic home-router-to-home-router success.

## Notes & gotchas

- If a failed probe's ICE takes the full `-seconds` to time out, that's ICE giving up
  (not a hang); the tool always prints a RESULT and exits non-zero on failure.
- Keep one helper + one host-tab per room. Two helpers with the same key flap the room slot.
- Don't stop/start the stream from the host tab while probing; keep it steady.