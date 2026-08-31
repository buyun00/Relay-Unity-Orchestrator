$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '..\..\scripts\hyperv\Host-Workspace.ps1')

$script:probeCount = 0
$script:sleepCount = 0
$script:readyOnProbe = 1
$script:throwOnProbe = $false
function Test-Path {
    [CmdletBinding()]
    param([string]$LiteralPath, [string]$PathType)
    if ($LiteralPath -ne '\\fake-worker\d\repo' -or $PathType -ne 'Container') {
        throw 'Unexpected workspace probe.'
    }
    $script:probeCount += 1
    if ($script:probeCount -ge $script:readyOnProbe) { return $true }
    if ($script:throwOnProbe) { throw 'Simulated SMB transport unavailable.' }
    return $false
}
function Start-Sleep {
    param([int]$Milliseconds)
    if ($Milliseconds -le 0 -or $Milliseconds -gt 2000) { throw 'Unbounded poll delay.' }
    $script:sleepCount += 1
    if ($script:sleepCount -gt 5) { throw 'Readiness polling did not stop.' }
}
function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$share = '\\fake-worker\d\repo'
Assert-True (Wait-RelayHostWorkspace -SharePath $share) 'Healthy share was refused.'
Assert-True ($script:probeCount -eq 1 -and $script:sleepCount -eq 0) 'Healthy share must not wait.'

$script:probeCount = 0
$script:readyOnProbe = 3
Assert-True (Wait-RelayHostWorkspace -SharePath $share) 'Delayed SMB startup was not tolerated.'
Assert-True ($script:probeCount -eq 3 -and $script:sleepCount -eq 2) 'Unexpected startup retry count.'

$script:probeCount = 0
$script:sleepCount = 0
$script:throwOnProbe = $true
Assert-True (Wait-RelayHostWorkspace -SharePath $share) 'Transient transport exception was not tolerated.'
Assert-True ($script:probeCount -eq 3) 'Transport recovery did not recheck the share.'

$script:probeCount = 0
$script:sleepCount = 0
$script:readyOnProbe = [int]::MaxValue
Assert-True (-not (Wait-RelayHostWorkspace -SharePath $share -TimeoutSeconds 0)) 'Persistent outage was accepted.'
Assert-True ($script:probeCount -eq 1 -and $script:sleepCount -eq 0) 'Expired budget must not retry.'

$script:probeCount = 0
Assert-True (Wait-RelayHostWorkspace -SharePath '') 'Optional share path should remain supported.'
Assert-True ($script:probeCount -eq 0) 'Empty share path must not be probed.'

[pscustomobject]@{passed = 5; startupRaceRecovered = $true; persistentFailurePreserved = $true} | ConvertTo-Json -Compress
