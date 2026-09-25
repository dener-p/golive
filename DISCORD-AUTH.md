# Discord host auth — setup & usage

The last v1 roadmap item: hosting a room is bound to a **Discord account** instead of only
the printed key. The printed key becomes the one-time *claim* credential (physical-access
proof), and once claimed, the room's owner signs in with Discord from anywhere.

Servers update the room key in SQLite at every helper handshake, so a claimed room stays
owned across server/helper restarts.

## 1. Create the Discord application (you, once)

1. https://discord.com/developers/applications → **New Application** (name it, e.g. `golive`).
2. **OAuth2 → General**: add a redirect URI
   `https://golive.puhl.dev/auth/discord/callback` (exact string, no trailing slash
   differences). Discord requires a public URL — localhost redirects are not allowed.
3. Copy the **Client ID** and **Client Secret** from **OAuth2**.

No bot, no intents, no permissions — the app only needs the `identify` scope.

## 2. Run the server with credentials

```powershell
.\bin\golive-server.exe -addr :3000 `
  -discord-id <CLIENT_ID> -discord-secret <CLIENT_SECRET> `
  -public-url https://golive.puhl.dev -db golive.db
```

Flags/env:
| flag | env fallback | meaning |
|---|---|---|
| `-discord-id` | `GOLIVE_DISCORD_ID` | Discord client id |
| `-discord-secret` | `GOLIVE_DISCORD_SECRET` | Discord client secret |
| `-public-url` | `GOLIVE_PUBLIC_URL` | base for callback + post-login redirect (default `https://golive.puhl.dev`) |
| `-db` | `GOLIVE_DB` | local SQLite path (default `golive.db`; ignored when Turso is configured) |
| `-turso-url` | `GOLIVE_DB_URL` | Turso/libSQL URL — set with the token to use the remote store |
| `-turso-token` | `GOLIVE_TURSO_TOKEN` | Turso auth token |

The server auto-loads a `.env` file (exe dir, then `server/.env` in the working dir, then
`.env`) — plain `KEY=VALUE` lines, already-set environment variables win. The project's
`server/.env` holds `GOLIVE_DISCORD_ID`, `GOLIVE_DISCORD_SECRET`, `GOLIVE_TURSO_TOKEN`,
`GOLIVE_DB_URL` (gitignored). Turso mode activates when both `GOLIVE_DB_URL` and
`GOLIVE_TURSO_TOKEN` are present; otherwise the server falls back to the local SQLite file.

Without `-discord-id`/`-discord-secret` the `/auth/*` routes are disabled and the host
gate behaves exactly as v1 (printed key only), so the existing stack keeps working
unchanged.

## 3. The flow for a host

1. Helper prints the room key (as today). Host opens the host page — locally with the key,
   or the public page.
2. On the public host page the panel shows **"Bind this room to your Discord account
   (replaces the printed key)".** Host clicks **Sign in with Discord**; if the page render
   carried the key, the key rides through the OAuth state and is consumed at the callback.
3. Discord authorize → callback → the room is **claimed**: `rooms.owner` is set to the
   Discord user id, an HttpOnly session cookie is issued (12 h), and the host lands back on
   the public host page with full control.
4. From then on, opening the public host page and signing in (button) is enough — no key.

Failure cases the page explains:
- `?denied=1` — the room belongs to another Discord account.
- `?unclaimed=1` — claim refused because the key was missing/wrong (e.g. signed in from a
  page without the key, or the helper hadn't handed its key to the server yet — the helper
  must be running for the claim to validate).

## 4. Security model (v1 pilot)

- The key is the physical-access proof for the *one-time* claim; afterwards ownership is
  account-based. Sessions are random 256-bit tokens, HttpOnly, SameSite=Lax, Secure on
  https, 12 h expiry, stored in SQLite (so a restart doesn't log hosts out).
- The OAuth `state` nonce is single-use with a 10 min TTL and holds `{room, key}` server
  side (the key is never part of the Discord round trip beyond the browser's host-page URL,
  which is how the key already travels today).
- Rooms are claimed once; there is no ownership transfer / unclaim endpoint yet.
- The key in a login link sits in browser history/referrer headers — acceptable for the
  pilot, revisit if this becomes a shared machine concern.

## 5. Storage & Turso

`server/store.go` persists two tables — `rooms` (id, host_key, owner, claimed_at) and
`sessions` (token, discord info, expiry). Schema and queries are plain SQLite; the backend
is picked at startup:

- **Local** (default): `modernc.org/sqlite` — pure Go (no CGO), so the server still
  cross-compiles to Linux for the notebook.
- **Turso** (active on the live stack): `github.com/tursodatabase/libsql-client-go` —
  also pure Go; talks Hrana over HTTPS/WSS to `golive-dener-p.aws-us-east-1.turso.io`.
  The auth token goes through `NewConnector(url, WithAuthToken(...))` — never in the URL
  (the driver rejects `authToken` query params).

Switching back to a local file is just unsetting the Turso env vars. Verified against the
live Turso DB by `go test ./server -run TestStore` (both backends round-trip
saveHostKey/claim/owner/session; the Turso test cleans up its own rows and skips when the
env vars are absent).

## 6. Status & v2 follow-ups (as of 2026-09-25)

The **claim was completed live**: room `2ea81f3707` is bound to the user's Discord account,
persisted to Turso and verified by a direct read. Identity is surfaced to viewers and hosts:

- Watch page shows a **streaming badge** (owner display name + Discord avatar) via the public
  `GET /api/owner?room=<id>` endpoint (`rooms.owner_name/owner_avatar`, backfilled from the
  owner's newest session on migrate).
- Host page banner shows the **signed-in identity** (avatar + name).
- The host **viewers table gained a `viewer` column**: viewers who connected with a valid
  session cookie get an identity badge (server overlays session identity onto the helper's
  status rows at relay time); anonymous viewers show `–`. All verified live after a clean
  server+helper restart (durability: claim + session survive, keyless control intact).

## 6.1 Short-code pairing (tray → account binding)

Added with the tray milestone on `feature/discord-oauth`: the printed key is no longer the
only onboarding path for a host.

- The helper whips up a **6-char code** via `POST /api/pair/request {room, key}` (key = the
  same physical-access proof the helper uses to join `/ws`), refreshes it every 4 minutes, and
  shows it in the tray (and prints it in console mode).
- On the host page (`golive.puhl.dev/host/<room>`), a Discord-signed-in user types the code;
  `POST /api/pair/claim {code, room}` claims the room exactly like presenting the printed key
  would. The user never sees the key.
- Codes are single-use, expire after 5 minutes, live only in server memory, and only the
  helper holding the room's key can mint them — so the code is as strong as the printed key.

Follow-ups are v2 candidates:

- Ownership transfer / release; room unclaim.
- Branch decision: merge to main, or keep this as the v2 opener lane.