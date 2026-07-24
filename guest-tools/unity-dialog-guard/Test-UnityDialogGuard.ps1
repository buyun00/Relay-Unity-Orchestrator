[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Start-GuardProcess {
    param(
        [string]$Executable,
        [string]$ConfigPath,
        [string]$LearnedPath,
        [string]$LogDirectory
    )
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.Arguments = '--config "{0}" --learned "{1}" --log-dir "{2}" --run-seconds 30 --no-mutex' -f `
        $ConfigPath, $LearnedPath, $LogDirectory
    $info.UseShellExecute = $false
    return [System.Diagnostics.Process]::Start($info)
}

function Start-FixtureProcess {
    param(
        [string]$Executable,
        [string]$Mode,
        [string]$OutputPath,
        [string]$Variant = '42'
    )
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.Arguments = '--mode "{0}" --output "{1}" --variant "{2}"' -f `
        $Mode, $OutputPath, $Variant
    $info.UseShellExecute = $false
    return [System.Diagnostics.Process]::Start($info)
}

function Wait-Until {
    param(
        [scriptblock]$Condition,
        [string]$FailureMessage,
        [int]$TimeoutSeconds = 12
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (& $Condition) {
            return
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw $FailureMessage
}

function Invoke-DialogButton {
    param(
        [int]$ProcessId,
        [string]$ButtonName
    )
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $processCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        $ProcessId
    )
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        $processCondition
    )
    if (-not $windows -or $windows.Count -eq 0) {
        throw "No fixture window was found for process $ProcessId."
    }
    $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        $ButtonName
    )
    $button = $null
    foreach ($window in $windows) {
        $button = $window.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            $buttonCondition
        )
        if ($button) {
            break
        }
    }
    if (-not $button) {
        throw "Button '$ButtonName' was not found."
    }
    $pattern = $button.GetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern
    )
    $pattern.Invoke()
}

$build = & (Join-Path $PSScriptRoot 'Build-UnityDialogGuard.ps1') `
    -IncludeTestFixture |
    ConvertFrom-Json
$guardExecutable = [string]$build.executable
$fixtureExecutable = Join-Path (Split-Path -Parent $guardExecutable) 'UnityDialogFixture.exe'

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'Relay-UnityDialogGuard-' + [Guid]::NewGuid().ToString('N')
)
New-Item -ItemType Directory -Path $testRoot | Out-Null
$logDirectory = Join-Path $testRoot 'logs'
$configPath = Join-Path $testRoot 'config.json'
$learnedPath = Join-Path $testRoot 'learned-rules.json'

$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8 |
    ConvertFrom-Json
$config.pollIntervalMs = 100
$config.initialActionDelayMs = 100
$config.captureUnknownDialogScreenshots = $false
$config.unityProcessNames = @('UnityDialogFixture')
$config | ConvertTo-Json -Depth 20 |
    Set-Content -LiteralPath $configPath -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'learned-rules.example.json') `
    -Destination $learnedPath

$guard = $null
$fixtures = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
try {
    $guard = Start-GuardProcess `
        -Executable $guardExecutable `
        -ConfigPath $configPath `
        -LearnedPath $learnedPath `
        -LogDirectory $logDirectory
    Start-Sleep -Milliseconds 500

    $knownOutput = Join-Path $testRoot 'known-result.txt'
    $knownFixture = Start-FixtureProcess `
        -Executable $fixtureExecutable `
        -Mode 'known' `
        -OutputPath $knownOutput
    $fixtures.Add($knownFixture)
    Wait-Until `
        -Condition { Test-Path -LiteralPath $knownOutput } `
        -FailureMessage 'Known Reload dialog was not handled automatically.'
    $knownResult = [string](Get-Content -LiteralPath $knownOutput -Raw)
    if ($knownResult -ne 'Reload') {
        throw "Known dialog selected '$knownResult' instead of 'Reload'."
    }

    $unknownOutput = Join-Path $testRoot 'unknown-first-result.txt'
    $unknownFixture = Start-FixtureProcess `
        -Executable $fixtureExecutable `
        -Mode 'unknown' `
        -OutputPath $unknownOutput `
        -Variant '42'
    $fixtures.Add($unknownFixture)
    $unknownLog = Join-Path $logDirectory 'unknown-dialogs.jsonl'
    Wait-Until `
        -Condition {
            (Test-Path -LiteralPath $unknownLog) -and
            (Get-Content -LiteralPath $unknownLog -Raw) -match 'Custom Import Notice'
        } `
        -FailureMessage 'Unknown dialog was not recorded.'

    Invoke-DialogButton -ProcessId $unknownFixture.Id -ButtonName 'Apply Now'
    Wait-Until `
        -Condition { Test-Path -LiteralPath $unknownOutput } `
        -FailureMessage 'The simulated first manual action did not complete.'
    Wait-Until `
        -Condition {
            (Get-Content -LiteralPath $learnedPath -Raw) -match 'Apply Now'
        } `
        -FailureMessage 'The learning operation was not persisted to learned-rules.json.'

    $learnedOutput = Join-Path $testRoot 'unknown-learned-result.txt'
    $learnedFixture = Start-FixtureProcess `
        -Executable $fixtureExecutable `
        -Mode 'unknown' `
        -OutputPath $learnedOutput `
        -Variant '99'
    $fixtures.Add($learnedFixture)
    Wait-Until `
        -Condition { Test-Path -LiteralPath $learnedOutput } `
        -FailureMessage 'The learned dialog rule was not applied on the second occurrence.'
    $learnedResult = [string](Get-Content -LiteralPath $learnedOutput -Raw)
    if ($learnedResult -ne 'Apply Now') {
        throw "Learned dialog selected '$learnedResult' instead of 'Apply Now'."
    }

    $actionLog = Join-Path $logDirectory 'actions.jsonl'
    $actions = Get-Content -LiteralPath $actionLog -Raw
    if ($actions -notmatch '"ruleType":"known"' -or
        $actions -notmatch '"ruleType":"learned"' -or
        $actions -notmatch '"type":"dialog.learned"') {
        throw 'Action log does not prove known, learned, and learning flows.'
    }
    $nativeMonitor = Get-Content -LiteralPath $actionLog |
        ForEach-Object { $_ | ConvertFrom-Json } |
        Where-Object { $_.type -eq 'native-monitor.started' } |
        Select-Object -First 1
    if (-not $nativeMonitor -or
        [long]$nativeMonitor.winEventHook -eq 0 -or
        [long]$nativeMonitor.mouseHook -eq 0 -or
        [long]$nativeMonitor.keyboardHook -eq 0) {
        throw 'The interactive WinEvent, mouse, or keyboard learning hook did not register.'
    }

    [pscustomobject]@{
        passed = $true
        knownDialogAction = $knownResult
        unknownDialogRecorded = $true
        manualActionLearned = $true
        interactiveLearningHooksRegistered = $true
        learnedDialogAction = $learnedResult
        learnedRulesPath = $learnedPath
        actionLog = $actionLog
        unknownDialogLog = $unknownLog
        testRoot = $testRoot
    } | ConvertTo-Json -Compress
} finally {
    foreach ($fixture in $fixtures) {
        if ($fixture -and -not $fixture.HasExited) {
            $fixture.Kill()
            $fixture.WaitForExit(3000) | Out-Null
        }
        if ($fixture) {
            $fixture.Dispose()
        }
    }
    if ($guard -and -not $guard.HasExited) {
        $guard.Kill()
        $guard.WaitForExit(3000) | Out-Null
    }
    if ($guard) {
        $guard.Dispose()
    }
}
