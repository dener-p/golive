# matrix/run.ps1 - run one webrtc-check probe and append the outcome to RESULTS.md
#
# Run this from the network you are testing FROM. The helper runs on the OTHER side.
#
#   .\matrix\run.ps1 -Server https://xxxx.trycloudflare.com -Room <room> -Label "B=phone-hotspot-4g" -Key <key>
#
# -Server = public signaling URL (see matrix/README.md for the tunnel).
# -Label  = which side this run is from, free text.
# -Key    = host key, optional; adds the helper's HOST STATUS (live kbps, RTT).
# -Seconds default 20: how long to receive RTP before disconnecting.

param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Room,
  [Parameter(Mandatory = $true)][string]$Label,
  [int]$Seconds = 20,
  [string]$Key = "",
  [switch]$Details
)

$ErrorActionPreference = "Stop"
$exe = Join-Path $PSScriptRoot "..\bin\webrtc-check.exe"
if (-not (Test-Path $exe)) {
  throw "webrtc-check.exe not built yet - run: go build -o bin/webrtc-check.exe ./tools/webrtc-check"
}

$args = @("-server", $Server, "-room", $Room, "-label", $Label, "-seconds", "$Seconds", "-json")
if ($Key) { $args += @("-key", $Key) }
if ($Details) { $args += "-verbose" }

$out = & $exe @args 2>&1
$out | ForEach-Object { Write-Host $_ }

$line = $out | Where-Object { $_ -like "RESULT {*" } | Select-Object -Last 1
if (-not $line) { Write-Host "no JSON result captured - check server URL and room"; exit 1 }

$r = ($line.Substring(7) | ConvertFrom-Json)
$esc = { param($s) ([string]$s).Replace("|", "/") }

$candDesc = "$($r.localCandidates.Count) cands"
if ($r.srflxLearned) { $candDesc += " / srflx OK" } else { $candDesc += " / NO srflx" }
$directTxt = if ($r.direct) { "YES" } else { "NO" }
$kfTxt = if ($r.keyframes -gt 0) { "$($r.keyframes) kf" } else { "no media" }
$iceTxt = if ($r.iceFinal) { $r.iceFinal } else { "n/a" }

$path = Join-Path $PSScriptRoot "RESULTS.md"
$row = "| $(Get-Date -Format yyyy-MM-dd) | $(& $esc $Label) | $directTxt | $(& $esc $r.path) | $candDesc | $($r.connectedMs) ms | $($r.rtpPkts) pk | $kfTxt | $iceTxt |"
Add-Content -Encoding utf8 -Path $path -Value $row
Write-Host "`nappended to matrix/RESULTS.md:"
Write-Host $row

if (-not $r.direct) { exit 1 }