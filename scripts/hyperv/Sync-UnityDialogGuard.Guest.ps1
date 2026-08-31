[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExecutableBase64,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][string]$AdditiveRuleJson,
    [string]$InstallDirectory = 'C:\ProgramData\Relay\UnityDialogGuard'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath($InstallDirectory)
if ($root -eq [IO.Path]::GetPathRoot($root)) { throw 'Expected a specific DialogGuard installation directory.' }
$exePath = Join-Path $root 'UnityDialogGuard.exe'
$configPath = Join-Path $root 'config.json'
$statePath = Join-Path $root 'control\state.json'
$task = Get-ScheduledTask -TaskPath '\Relay\' -TaskName 'UnityDialogGuard' -ErrorAction SilentlyContinue
if (-not $task -or -not (Test-Path -LiteralPath $exePath) -or -not (Test-Path -LiteralPath $configPath)) {
    return [pscustomobject]@{ changed = $false; reason = 'guard-not-installed' }
}
$actions = @($task.Actions)
if ($actions.Count -ne 1 -or [IO.Path]::GetFullPath($actions[0].Execute) -ne $exePath) {
    throw 'DialogGuard scheduled task points outside the expected installation; left untouched.'
}
$bytes = [Convert]::FromBase64String($ExecutableBase64)
$hasher = [Security.Cryptography.SHA256]::Create()
try { $actualHash = [BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace('-', '') }
finally { $hasher.Dispose() }
if ($actualHash -ne $ExpectedSha256) { throw 'DialogGuard payload hash mismatch.' }
$config = Get-Content -LiteralPath $configPath -Encoding UTF8 -Raw | ConvertFrom-Json
$rule = $AdditiveRuleJson | ConvertFrom-Json
if ($config.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace($rule.id)) { throw 'Invalid DialogGuard configuration.' }
$addRule = @($config.rules | Where-Object { $_.id -eq $rule.id }).Count -eq 0
$binaryChanged = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash -ne $ExpectedSha256
if (-not $binaryChanged -and -not $addRule) {
    return [pscustomobject]@{ changed = $false; reason = 'already-current'; version = $ExpectedVersion; sha256 = $ExpectedSha256 }
}

function Get-InstalledGuardProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='UnityDialogGuard.exe'" | Where-Object {
        $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $exePath
    })
}
function Stop-InstalledGuard {
    Stop-ScheduledTask -TaskPath '\Relay\' -TaskName 'UnityDialogGuard'
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    while (@(Get-InstalledGuardProcesses).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
    # Only the positively identified guard executable; never Unity or a business process.
    foreach ($guard in @(Get-InstalledGuardProcesses)) {
        Stop-Process -Id ([int]$guard.ProcessId) -Force
    }
    # Task Scheduler can still report Running for a few seconds after its
    # process exits. Starting during that window is silently ignored because
    # this task uses MultipleInstances=IgnoreNew.
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
        Start-Sleep -Milliseconds 250
        $taskState = (Get-ScheduledTask -TaskPath '\Relay\' -TaskName 'UnityDialogGuard').State
    } while (($taskState -eq 'Running' -or @(Get-InstalledGuardProcesses).Count -gt 0) -and [DateTime]::UtcNow -lt $deadline)
    if ($taskState -eq 'Running' -or @(Get-InstalledGuardProcesses).Count -gt 0) {
        throw 'DialogGuard task did not stop before deployment.'
    }
}

$backup = Join-Path $root ('rollback\' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item -LiteralPath $exePath -Destination (Join-Path $backup 'UnityDialogGuard.exe')
Copy-Item -LiteralPath $configPath -Destination (Join-Path $backup 'config.json')
$wasDisabled = [string]$task.State -eq 'Disabled'
try {
    Stop-InstalledGuard
    [IO.File]::WriteAllBytes($exePath, $bytes)
    if ($addRule) {
        # Keep all local settings, disabled rules and learned-rules.json unchanged.
        $config.rules = @($rule) + @($config.rules)
        [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 40), (New-Object Text.UTF8Encoding($false)))
    }
    if ((Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash -ne $ExpectedSha256) { throw 'Installed DialogGuard hash mismatch.' }
    if (-not $wasDisabled) {
        $startedAfter = [DateTime]::UtcNow
        Start-ScheduledTask -TaskPath '\Relay\' -TaskName 'UnityDialogGuard'
        $deadline = $startedAfter.AddSeconds(30)
        $ready = $false
        do {
            Start-Sleep -Milliseconds 400
            try {
                $state = Get-Content -LiteralPath $statePath -Encoding UTF8 -Raw | ConvertFrom-Json
                $pids = @(Get-InstalledGuardProcesses | ForEach-Object { [int]$_.ProcessId })
                $ready = $state.version -eq $ExpectedVersion -and $state.healthy -eq $true -and
                    [DateTime]::Parse($state.lastScanAt).ToUniversalTime() -ge $startedAfter -and $pids -contains [int]$state.processId
            } catch { $ready = $false }
        } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
        if (-not $ready) {
            $diagnosticTask = (Get-ScheduledTask -TaskPath '\Relay\' -TaskName 'UnityDialogGuard').State.ToString()
            $diagnosticPids = @((Get-InstalledGuardProcesses) | ForEach-Object { [int]$_.ProcessId }) -join ','
            $diagnosticState = try {
                $lastState = Get-Content -LiteralPath $statePath -Encoding UTF8 -Raw | ConvertFrom-Json
                "version=$($lastState.version),pid=$($lastState.processId),scan=$($lastState.lastScanAt),healthy=$($lastState.healthy)"
            } catch { 'unreadable' }
            throw "Updated DialogGuard did not publish a fresh healthy heartbeat (task=$diagnosticTask, pids=$diagnosticPids, state=$diagnosticState)."
        }
    }
    [pscustomobject]@{ changed = $true; version = $ExpectedVersion; sha256 = $ExpectedSha256; ruleAdded = $addRule; backup = $backup; disabledPreserved = $wasDisabled }
} catch {
    $deploymentError = $_.Exception.Message
    Stop-InstalledGuard
    Copy-Item -LiteralPath (Join-Path $backup 'UnityDialogGuard.exe') -Destination $exePath -Force
    Copy-Item -LiteralPath (Join-Path $backup 'config.json') -Destination $configPath -Force
    if (-not $wasDisabled) { Start-ScheduledTask -TaskPath '\Relay\' -TaskName 'UnityDialogGuard' }
    throw "DialogGuard update rolled back: $deploymentError. Backup: $backup"
}
