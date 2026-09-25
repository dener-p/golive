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
| flag | env fallback1 | meaning |
|---|---|---|
| `-discord-id` | `GOLIVE_DISCORD_ID` | Discord client id |
| `-discord-secret` | `GOLIVE_DISCORD_SECRET` | Discord client secret |
| `-public-url` | `GOLIVE_PUBLIC_URL` | base for callback + post-login redirect (default `https://golive.puhl.dev`) |
| `-db` | `GOLIVE_DB` | SQLite path (default `golive.db`) |

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
`sessions` (token, discord info, expiry) — via `modernc.org/sqlite` (pure Go, so the
server still cross-compiles to Linux for the notebook). The schema is plain SQLite.

Moving to **Turso** later is a driver + DSN swap: point the same queries at a libSQL
endpoint (Turso speaks the SQLite wire protocol). Expected friction points: the `file:` DSN
pragma syntax, `database/sql` compatibility of the libSQL driver, and WAL on a remote
database. Nothing in the query layer assumes a local file.

## 6. What's not done yet (on this branch)

- End-to-end validation against the real Discord authorization server (needs the app +
  creds from step 1).
- Ownership transfer / release; room unclaim.
- Avatar rendering on the host panel (identity line shows the account name only).