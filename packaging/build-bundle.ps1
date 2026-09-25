# build-bundle.ps1 - assemble the golive Windows distribution bundle.
#
# Produces:
#   dist/golive/                                  portable layout (helper + bundled GStreamer runtime)
#   dist/golive-<version>-windows-x64-portable.zip
#   server/public/helper/latest.json              metadata consumed by /api/helper/latest
#   server/public/helper/golive-setup-<version>.exe   (only if Inno Setup 6 ISCC.exe is found)
#
# The helper resolves its own sibling "gstreamer" directory first (helper/pipeline.go), so the
# bundle is fully self-contained: no PATH edits, no global GStreamer install.
#
# Usage:  powershell -ExecutionPolicy Bypass -File packaging\build-bundle.ps1

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $PSScriptRoot "version.txt")).Trim()

$gstRoot = ""
foreach ($cand in @(
    (Join-Path $env:LOCALAPPDATA "Programs\gstreamer\1.0\msvc_x86_64"),
    (Split-Path -Parent (Get-Command gst-launch-1.0.exe -ErrorAction SilentlyContinue).Source 2>$null)
)) {
    if ($cand -and (Test-Path (Join-Path $cand "bin\gst-launch-1.0.exe"))) { $gstRoot = $cand; break }
}
if (-not $gstRoot) { throw "GStreamer runtime not found. Install it or pass a path via -GstRoot." }

# --- 1. build the helper (windows/amd64) ---
# -H=windowsgui links the helper as a GUI-subsystem app: Windows creates no console window
# at all (zero flash), the tray auto-enables (no console => main() defaults to tray), and
# logs go to %APPDATA%\golive\helper.log. Dev builds without the flag stay console apps.
$env:GOOS = "windows"; $env:GOARCH = "amd64"; $env:CGO_ENABLED = "0"
try {
    go build -ldflags "-s -w -H=windowsgui" -o (Join-Path $root "dist\golive\golive-helper.exe") (Join-Path $root "helper")
} finally {
    Remove-Item Env:GOOS -ErrorAction SilentlyContinue
    Remove-Item Env:GOARCH -ErrorAction SilentlyContinue
    Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue
}

# --- 2. assemble the bundle ---
$dist = Join-Path $root "dist\golive"
$gstBundled = Join-Path $dist "gstreamer"
New-Item -ItemType Directory -Force -Path (Join-Path $gstBundled "bin") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $gstBundled "lib\gstreamer-1.0") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $gstBundled "libexec\gstreamer-1.0") | Out-Null

$binSrc = Join-Path $gstRoot "bin"
$launch = Join-Path $binSrc "gst-launch-1.0.exe"
$inspect = Join-Path $binSrc "gst-inspect-1.0.exe"
if (-not (Test-Path $launch) -or -not (Test-Path $inspect)) { throw "gst-launch/inspect missing in $binSrc" }

# runtime DLLs + the two tools the helper spawns
Copy-Item (Join-Path $binSrc "*.dll") (Join-Path $gstBundled "bin") -Force
Copy-Item $launch (Join-Path $gstBundled "bin") -Force
Copy-Item $inspect (Join-Path $gstBundled "bin") -Force

# plugin scanner (gst-launch --gst-plugin-scanner-path)
$scanner = Join-Path $gstRoot "libexec\gstreamer-1.0\gst-plugin-scanner.exe"
if (Test-Path $scanner) { Copy-Item $scanner (Join-Path $gstBundled "libexec\gstreamer-1.0") -Force }

# resolve each pipeline element to its plugin DLL and copy only those
$elements = "d3d11screencapturesrc","amfav1enc","nvav1enc","qsvav1enc","vaav1enc","svtav1enc","av1parse","videoconvert","videorate","videotestsrc","tcpclientsink","queue"
$copied = @{}
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
foreach ($el in $elements) {
    $out = (& $inspect $el 2>&1 | Out-String)
    # gst-inspect details end with a space-separated, fully-qualified
    # "Filename  C:\...\lib\gstreamer-1.0\libgstfoo.dll" line
    $m = [regex]::Match($out, "(?im)^\s*Filename\s+(.+\.dll)\s*$")
    if ($m.Success) {
        $src = $m.Groups[1].Value.Trim()
        $dll = Split-Path -Leaf $src
        if ((Test-Path $src) -and -not $copied.ContainsKey($dll)) {
            Copy-Item $src (Join-Path $gstBundled "lib\gstreamer-1.0") -Force
            $copied[$dll] = $true
        }
    } else {
        Write-Host "note: element '$el' not available in this runtime -> skipped"
    }
}
$ErrorActionPreference = $prevEAP
Write-Host "bundled plugin DLLs: $($copied.Count) ($($copied.Keys -join ', '))"

# --- 3. licenses ---
Copy-Item (Join-Path $PSScriptRoot "THIRD-PARTY-NOTICES.md") (Join-Path $dist "THIRD-PARTY-NOTICES.md") -Force

# --- 4. portable zip ---
# Artifact names embed an 8-char hash of the zip contents, so EVERY rebuild produces a
# fresh URL. Without this, Cloudflare's edge cache serves a stale copy of a previous
# same-version build for up to 4h (its default static TTL) — a real incident we hit live.
$stampName = "golive-tmp-$version.zip"
$stampPath = Join-Path $root "dist\$stampName"
if (Test-Path $stampPath) { Remove-Item $stampPath -Force }
Compress-Archive -Path (Join-Path $dist "*") -DestinationPath $stampPath -CompressionLevel Optimal
$zipHash = (Get-FileHash $stampPath -Algorithm SHA256).Hash.ToLower()
$stamp = $zipHash.Substring(0, 8)
$zipName = "golive-$version-$stamp-windows-x64-portable.zip"
$zipPath = Join-Path $root "dist\$zipName"
Move-Item $stampPath $zipPath -Force
Write-Host "portable zip: $zipPath ($zipHash)"

# --- 5. installer (if Inno Setup 6 present) + publish to server/public/helper ---
$setupName = "golive-setup-$version-$stamp.exe"
$iscc = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
$setupPath = $null
if (Test-Path $iscc) {
    & $iscc (Join-Path $PSScriptRoot "golive.iss") "/DVersion=$version" "/DStamp=$stamp" "/DOutput=$root\dist"
    if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }
    $setupPath = Join-Path $root "dist\$setupName"
} else {
    Write-Host "Inno Setup 6 not found ($iscc) - skipping installer compile. Install Inno Setup 6, then re-run."
}

$pubDir = Join-Path $root "server\public\helper"
New-Item -ItemType Directory -Force -Path $pubDir | Out-Null
# always publish the portable zip; switch to the installer when one was compiled
Copy-Item $zipPath (Join-Path $pubDir $zipName) -Force
$file = $zipName; $hashVal = $zipHash; $note = "portable zip (GStreamer bundled)"
if ($setupPath -and (Test-Path $setupPath)) {
    Copy-Item $setupPath (Join-Path $pubDir $setupName) -Force
    $file = $setupName
    $hashVal = (Get-FileHash (Join-Path $pubDir $setupName) -Algorithm SHA256).Hash.ToLower()
    $note = "full installer (GStreamer bundled)"
}
$latest = @{
    version = $version
    file    = $file
    sha256  = $hashVal
    note    = $note
}
# stale artifacts from earlier builds (same version, different hash) are no longer
# advertised — remove them so /helper/* only ever serves the current build.
Get-ChildItem $pubDir -Filter "golive-*.zip" | Where-Object { $_.Name -ne $zipName } | Remove-Item -Force
Get-ChildItem $pubDir -Filter "golive-setup-*.exe" | Where-Object { $_.Name -ne $setupName } | Remove-Item -Force
($latest | ConvertTo-Json -Compress) | Set-Content (Join-Path $root "server\public\helper\latest.json") -Encoding utf8
Write-Host "published: server/public/helper/latest.json -> $($latest | ConvertTo-Json -Compress)"
Write-Host "bundle complete. Plugins needed by helper: $elements"
