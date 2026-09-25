# Third-party notices — golive

golive bundles third-party software in its Windows distribution (inside `gstreamer\`).
The golive source itself is under the repository's own license; the bundled components keep
their own licenses below.

## GStreamer runtime + plugins

- GStreamer core and base plugins — **LGPL-2.1-or-later**
  (timetrack base: `gstreamer`, `gst-plugins-base`; used elements: `videoconvert`, `videorate`)
- gst-plugins-good (`tcpclientsink` in the `tcp` plugin) — **LGPL-2.1-or-later**
- gst-plugins-bad (`d3d11screencapturesrc` in `d3d11`, `amfav1enc` in `amf`,
  `svtav1enc` in `svtav1`, `av1parse`) — mostly **LGPL-2.1-or-later**, some files
  **MIT/BSD**; see the plugin-specific headers.

LGPL compliance notes:

- The helper uses GStreamer as **separate processes** (`gst-launch-1.0`/`gst-inspect-1.0`)
  spawned from the golive helper binary; the golive binaries themselves do not statically
  link GStreamer libraries.
- The source code for everything bundled is available from the upstream projects:
  https://gstreamer.freedesktop.org/ (releases + source tarballs). License texts are
  included in the upstream source tarballs and at https://spdx.org/licenses/LGPL-2.1.html.
- If you modify the bundled GStreamer components, reinstall the modified versions in
  `%LOCALAPPDATA%\Programs\golive\gstreamer\` to satisfy relinking terms.

## Encoders (bundled as GStreamer plugin DLLs)

- **SVT-AV1** (`svtav1enc` element) — **BSD-2-Clause** / Apache-2.0 dual.
  Sources: https://gitlab.com/AOMediaCodec/SVT-AV1
- **dav1d** (decoder used by test/decode checks in the repo) — **BSD-2-Clause**.
  Sources: https://code.videolan.org/videolan/dav1d
- **AMF** (AMD Advanced Media Framework, `amfav1enc`) — used only as a hardware-encode
  plugin inside GStreamer; the plugin's use of the AMF SDK conforms to AMD's terms.

## Got a question about a license?

Open an issue in the golive repository. Upstream component versions are recorded in the
build manifest produced by `packaging/build-bundle.ps1`.