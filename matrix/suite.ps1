# matrix/suite.ps1 - M7 NAT regression suite: repeatable cells with expected outcomes.
#
# Run this from the HELLPER side (same machine the helper runs on) after any networking
# change: STUN servers, ICE config, candidate handling, router/NAT changes, or encoder
# tweaks. The helper must be streaming.
#
#   .\matrix\suite.ps1 [-Server https://golive.puhl.dev] [-Room <room>] [-Seconds 6] [-Soak]
#
# Cells (every cell must pass or the suite exits 1):
#   1. loopback : probe -> localhost server     expect direct=YES ice=connected srflx=true  path hosts host
#   2. tunnel   : probe -> -Server (public URL) expect direct=YES ice=connected
#   3. no-stun  : probe -no-stun -> localhost   expect direct=YES (LAN host path) srflx=false
#   4. soak     : only with -Soak: 5 concurrent viewers must ALL receive RTP (matrix/soak.ps1)
#
# A passing run appends one row to matrix/SUITE-RESULTS.md with the git commit, so a
# regression shows up as a FAIL next to the commit that introduced it.

param(
  [string]$Server = "https://golive.puhl.dev",
  [string]$Room = "2ea81f3707",
  [int]$Seconds = 6,
  [switch]$Soak
)

$ErrorActionPreference = "Stop"
$exe = Join-Path $PSScriptRoot "..\bin\webrtc-check.exe"
$soakScript = Join-Path $PSScriptRoot "soak.ps1"
if (-not (Test-Path $exe)) {
  throw "webrtc-check.exe not built yet - run: go build -o bin/webrtc-check.exe ./tools/webrtc-check"
}
if ([string]::IsNullOrWhiteSpace($Room)) { throw "-Room is required" }

$log = @()

function Invoke-Cell {
  param(
    [string]$Name,
    [string]$URL,
    [switch]$NoStun,
    [string]$WantIce = "connected",
    [bool]$WantDirect = $true,
    [bool]$ExpectSrflx = $true
  )
  $args = @("-server", $URL, "-room", $Room, "-label", $Name, "-seconds", "$Seconds", "-json", "-anon")
  if ($NoStun) { $args += "-no-stun" }
  $out = & $exe @args 2>&1
  "`n== $Name =="
  $out | ForEach-Object { Write-Host $_ }

  $line = $out | Where-Object { $_ -like "RESULT {*" } | Select-Object -Last 1
  if (-not $line) {
    $script:log += [pscustomobject]@{ Cell = $Name; Pass = $false; Detail = "no RESULT captured" }
    return
  }
  $r = $line.Substring(7) | ConvertFrom-Json

  $fails = @()
  $gotDirect = if ($r.direct) { "YES" } else { "NO" }
  if ($r.direct -ne $WantDirect) { $fails += "direct=$gotDirect (wanted $(if ($WantDirect) { 'YES' } else { 'NO' }))" }
  if ($r.iceFinal -ne $WantIce)     { $fails += "ice=$($r.iceFinal) (wanted $WantIce)" }
  if ($r.srflxLearned -ne $ExpectSrflx) { $fails += "srflx=$($r.srflxLearned) (wanted $ExpectSrflx)" }
  if ($WantDirect -and $r.rtpPkts -le 0) { $fails += "rtpPkts=$($r.rtpPkts) (wanted > 0)" }

  $detail = "direct=$gotDirect ice=$($r.iceFinal) srflx=$($r.srflxLearned) $($r.connectedMs)ms $($r.rtpPkts)pk path=$($r.path)"
  if ($fails.Count -gt 0) { $detail += "  [FAIL: $($fails -join '; ')]" }
  $script:log += [pscustomobject]@{ Cell = $Name; Pass = ($fails.Count -eq 0); Detail = $detail }
}

Invoke-Cell -Name "loopback" -URL "http://localhost:3000" -ExpectSrflx $true
Invoke-Cell -Name "tunnel"   -URL $Server -ExpectSrflx $true
Invoke-Cell -Name "no-stun"  -URL "http://localhost:3000" -NoStun -ExpectSrflx $false
if ($Soak) {
  "`n== soak 5v =="
  & $soakScript -Server "http://localhost:3000" -Room $Room -Viewers 5 -Seconds 20
  $soakOk = ($LASTEXITCODE -eq 0)
  $script:log += [pscustomobject]@{ Cell = "soak 5v"; Pass = $soakOk; Detail = if ($soakOk) { "5/5 viewers received RTP" } else { "not all viewers connected" } }
}

"`n=== summary ==="
$allPass = $true
foreach ($row in $log) {
  $mark = if ($row.Pass) { "PASS" } else { "FAIL" }
  if (-not $row.Pass) { $allPass = $false }
  "  [$mark] $($row.Cell): $($row.Detail)"
}

# append one row to SUITE-RESULTS.md (created with a header on first run)
$commit = (git rev-parse --short HEAD 2>$null | Select-Object -First 1)
if (-not $commit) { $commit = "?" }
$file = Join-Path $PSScriptRoot "SUITE-RESULTS.md"
if (-not (Test-Path $file)) {
  @"
# NAT regression suite - runs
Each row is one suite.ps1 run; the commit column is the revision under test.
| date | commit | cells | verdict |
|------|--------|-------|---------|
"@ | Set-Content -Encoding utf8 -Path $file
}
$cells = ($log | ForEach-Object { if ($_.Pass) { $_.Cell } else { "$($_.Cell)!FAIL" } }) -join " + "
$verdict = if ($allPass) { "PASS" } else { "FAIL" }
$rowText = "| $(Get-Date -Format yyyy-MM-dd) | $commit | $cells | $verdict |"
Add-Content -Encoding utf8 -Path $file -Value $rowText
"`nappended to matrix/SUITE-RESULTS.md:"
$rowText

if (-not $allPass) { exit 1 }
"`nsuite PASS - no regressions."