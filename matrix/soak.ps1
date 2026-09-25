<#
  .SYNOPSIS
    Viewer-count soak: launch N concurrent webrtc-check viewer probes against one
    room and report fan-out health (connect, RTP flow, encoder CPU).

    This is the M4 exit check: one helper/one encode -> ~10 viewers. The probes
    are curl-grade CLI WebRTC peers, so they add exactly what a browser viewer
    adds on the signaling + RTP path (minus decode).

  .EXAMPLE
    .\matrix\soak.ps1 -Server http://localhost:3000 -Room 2ea81f3707 -Viewers 10 -Seconds 20
#>
param(
    [string]$Server = "http://localhost:3000",
    [string]$Room = "2ea81f3707",
    [int]$Viewers = 10,
    [int]$Seconds = 20,
    [string]$Label = "soak"
)

$ErrorActionPreference = "Continue"
$probe = Join-Path $PSScriptRoot "..\bin\webrtc-check.exe"
if (-not (Test-Path $probe)) { Write-Error "probe not found: $probe"; exit 3 }

$tmp = Join-Path $env:TEMP ("golive-soak-" + $Label + "-" + $Viewers)
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Get-EncoderCpu {
    $p = Get-Process -Name "golive-helper","gst-launch-1.0" -ErrorAction SilentlyContinue
    $cpu = [TimeSpan]::Zero
    $count = 0
    foreach ($x in $p) {
        if ($null -ne $x.TotalProcessorTime) { $cpu = $cpu.Add($x.TotalProcessorTime); $count++ }
    }
    return @{ cpu = $cpu; count = $count }
}
function CpuPercent([TimeSpan]$t0, [DateTime]$w0, [TimeSpan]$t1, [DateTime]$w1) {
    $dc = ($t1 - $t0).TotalMilliseconds
    $dw = ($w1 - $w0).TotalSeconds
    if ($dw -le 0) { return 0.0 }
    return [math]::Round($dc / 1000.0 / $dw * 100.0, 1)
}

$cpu0 = Get-EncoderCpu
$wall0 = Get-Date
Write-Host ("soak: {0} viewers x {1}s against {2} room {3}" -f $Viewers, $Seconds, $Server, $Room)

$procs = @()
for ($i = 1; $i -le $Viewers; $i++) {
    $out = Join-Path $tmp ("v" + $i + ".json")
    $err = Join-Path $tmp ("v" + $i + ".log")
    $p = Start-Process -FilePath $probe -ArgumentList @("-server", $Server, "-room", $Room, "-seconds", "$Seconds", "-label", ($Label + "-v" + $i), "-json") -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    $procs += $p
}
Write-Host ("launched {0} probes" -f $procs.Count)

# mid-run CPU sample (after connects, before end)
Start-Sleep -Seconds ([math]::Min(10, [int]($Seconds / 2)))
$cpu1 = Get-EncoderCpu
$wall1 = Get-Date

# wait for all to exit (with safety margin)
$deadline = (Get-Date).AddSeconds($Seconds + 45)
$done = $false
while ((Get-Date) -lt $deadline) {
    foreach ($p in $procs) { $p.Refresh() }
    $alive = @($procs | Where-Object { -not $_.HasExited }).Count
    if ($alive -eq 0) { $done = $true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $done) {
    Write-Warning "timeout waiting for probes; killing stragglers"
    foreach ($p in $procs) { if (-not $p.HasExited) { $p.Kill() } }
}

$cpu2 = Get-EncoderCpu
$wall2 = Get-Date

$rows = @()
for ($i = 1; $i -le $Viewers; $i++) {
    $json = Join-Path $tmp ("v" + $i + ".json")
    $r = $null
    if (Test-Path $json) {
        $line = Get-Content $json -Raw
        $m = [regex]::Match($line, "RESULT \{.*\}")
        if ($m.Success) { $r = ($m.Value.Substring(7) | ConvertFrom-Json) }
    }
    if ($null -ne $r) {
        $rows += [pscustomobject]@{ v = $i; direct = [bool]$r.direct; ms = $r.connectedMs; pk = $r.rtpPkts; kf = $r.keyframes; ice = $r.iceFinal; path = $r.path }
    } else {
        $rows += [pscustomobject]@{ v = $i; direct = $false; ms = 0; pk = 0; kf = 0; ice = "no-json"; path = "" }
    }
}

$connected = @($rows | Where-Object { $_.ice -eq "connected" }).Count
$flowing   = @($rows | Where-Object { $_.pk -gt 0 }).Count
$totalPk   = ($rows | Measure-Object -Property pk -Sum).Sum
$cpuMid    = CpuPercent $cpu0.cpu $wall0 $cpu1.cpu $wall1
$cpuAll    = CpuPercent $cpu0.cpu $wall0 $cpu2.cpu $wall2

Write-Host ""
Write-Host ("connected {0}/{1}   rtp-flowing {2}/{1}   total pkts {3}   encoder cpu {4}% (mid) / {5}% (all)  procs={6}" -f $connected, $Viewers, $flowing, $totalPk, $cpuMid, $cpuAll, $cpu2.count)
Write-Host ("{0,-4} {1,-10} {2,-7} {3,-7} {4,-8} {5}" -f "v", "ice", "dir", "ms", "pkts", "path")
foreach ($r in $rows) {
    $p = $r.path
    if ($p.Length -gt 42) { $p = $p.Substring(0, 42) + "..." }
    Write-Host ("{0,-4} {1,-10} {2,-7} {3,-7} {4,-8} {5}" -f $r.v, $r.ice, $r.direct, $r.ms, $r.pk, $p)
}
Write-Host ("detail dir: {0}" -f $tmp)

# pass = every viewer connected AND received media
if ($connected -eq $Viewers -and $flowing -eq $Viewers) { exit 0 }
if ($connected -gt 0) { exit 2 }
exit 1