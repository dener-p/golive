# Golive

**Live at [golive.puhl.dev](https://golive.puhl.dev)**

Browser screen sharing for a few friends. WebRTC carries the media straight
between peers (AV1 preferred, IPv6-friendly), while a Cloudflare Worker with one
Durable Object per room relays signaling. No accounts, no database, and no media
ever passes through Cloudflare.

## What it does

- The **streamer** opens `/`, optionally picks a **Room ID**, and shares a
  screen, window or tab. The ID is remembered, so the same link works next time.
- **Viewers** open `/watch/<id>`. If the streamer is not live yet they wait and
  connect automatically when it starts. Up to `MAX_VIEWERS` (default 8) devices
  can watch at once.
- Optional tab/system **audio**, best effort, lifted to 128 kbps stereo Opus.
- **Quality** presets: 4K/60, 4K/30, 1440p/60, 1080p/60, 1080p/30, 720p/30,
  Data saver, or Auto — changeable live mid-share.

## Quick start (local)

Prerequisites: Node 18+ and a Cloudflare account that owns the domain you deploy
to.

```bash
cd src
npm install
npx wrangler login
npm run dev       # http://localhost:3000  (wrangler dev: local Worker + DO)
```

`localhost` counts as a secure context, so screen capture works locally.

## Deploy

```bash
cd src
npm run deploy    # publishes the Worker, its Durable Object and the static assets
```

`wrangler.jsonc` declares `golive.puhl.dev` as a `custom_domain`, so a single
deploy uploads both the Worker and the frontend from `public/`. Remove any other
DNS/tunnel record for the hostname first; Wrangler creates the DNS record and
certificate for the custom domain.

## Documentation

- [`src/README.md`](src/README.md) — run/deploy details, design notes and files.
- [`project.md`](project.md) — goals, scope, user flow and acceptance checklist.

## Layout

- `src/worker.js` — Worker routing + the `Room` Durable Object (signaling)
- `src/wrangler.jsonc` — Worker, assets, Durable Object and domain config
- `src/public/` — plain HTML/CSS/JS frontend (no build step)
- `project.md` — project spec and notes
