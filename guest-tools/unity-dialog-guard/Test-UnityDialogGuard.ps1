[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Start-GuardProcess {
    param(
        [string]$Executable,
        [string]$ConfigPath,
        [string]$LearnedPath,
        [string]$LogDirectory,
        [string]$ControlDirectory
    )
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.Arguments = '--config "{0}" --learned "{1}" --log-dir "{2}" --control-dir "{3}" --run-seconds 90 --no-mutex' -f `
        $ConfigPath, $LearnedPath, $LogDirectory, $ControlDirectory
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

function Read-ControlState {
    param([string]$Path)
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        try {
            return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch [System.IO.IOException] {
            Start-Sleep -Milliseconds 50
        }
    }
    throw "Control state '$Path' remained unavailable."
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
$controlDirectory = Join-Path $testRoot 'control'

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
        -LogDirectory $logDirectory `
        -ControlDirectory $controlDirectory
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

    $ownedOutput = Join-Path $testRoot 'owned-scene-result.txt'
    $ownedFixture = Start-FixtureProcess -Executable $fixtureExecutable -Mode 'owned-scene' -OutputPath $ownedOutput
    $fixtures.Add($ownedFixture)
    Wait-Until -Condition { Test-Path -LiteralPath $ownedOutput } -FailureMessage 'Owned external-scene dialog was not handled.'
    if ((Get-Content -LiteralPath $ownedOutput -Raw) -ne 'Ignore') {
        throw 'External scene dialog did not preserve in-memory changes.'
    }

    $stuckOutput = Join-Path $testRoot 'known-stuck-result.txt'
    $stuckFixture = Start-FixtureProcess -Executable $fixtureExecutable -Mode 'known-stuck' -OutputPath $stuckOutput
    $fixtures.Add($stuckFixture)
    Wait-Until -Condition { Test-Path -LiteralPath $stuckOutput } -FailureMessage 'Stuck known dialog never received its first action.'
    Start-Sleep -Milliseconds 400
    $statePath = Join-Path $controlDirectory 'state.json'
    Wait-Until -Condition {
        $pending = (Read-ControlState -Path $statePath).pendingDialogs
        @($pending | Where-Object { $_.processId -eq $stuckFixture.Id }).Count -eq 1
    } -FailureMessage 'A known dialog still open after the automatic action disappeared from pending state.'
    $stuckFixture.Kill()
    $stuckFixture.WaitForExit(3000) | Out-Null

    $aiOutput = Join-Path $testRoot 'ai-result.txt'
    $aiFixture = Start-FixtureProcess `
        -Executable $fixtureExecutable `
        -Mode 'ai' `
        -OutputPath $aiOutput
    $fixtures.Add($aiFixture)
    $statePath = Join-Path $controlDirectory 'state.json'
    Wait-Until `
        -Condition {
            (Test-Path -LiteralPath $statePath) -and
            ((Read-ControlState -Path $statePath) | ConvertTo-Json -Depth 20) -match 'Unknown AI Decision Notice'
        } `
        -FailureMessage 'The AI control state did not expose the unknown dialog.'
    $state = Read-ControlState -Path $statePath
    $aiDialog = $state.pendingDialogs |
        Where-Object { $_.title -eq 'Unknown AI Decision Notice' } |
        Select-Object -First 1
    $aiButton = $aiDialog.buttons |
        Where-Object { $_.name -eq 'Proceed Safely' } |
        Select-Object -First 1
    if (-not $aiDialog -or -not $aiButton) {
        throw 'The AI control state omitted the expected dialog or button.'
    }
    $requestId = [Guid]::NewGuid().ToString('N')
    $requestDirectory = Join-Path $controlDirectory 'requests'
    $responsePath = Join-Path (Join-Path $controlDirectory 'responses') ($requestId + '.json')
    $requestPath = Join-Path $requestDirectory ($requestId + '.json')
    $temporaryRequestPath = $requestPath + '.tmp'
    [pscustomobject]@{
        schemaVersion = 1
        requestId = $requestId
        dialogId = [string]$aiDialog.dialogId
        buttonId = [string]$aiButton.buttonId
        requestedBy = 'integration-test'
        rationale = 'Validate the bounded AI dialog action interface.'
        remember = $true
        allowHighRisk = $false
    } | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath $temporaryRequestPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryRequestPath -Destination $requestPath
    Wait-Until `
        -Condition { Test-Path -LiteralPath $responsePath } `
        -FailureMessage 'The AI dialog action did not produce a response.'
    $aiResponse = Get-Content -LiteralPath $responsePath -Raw -Encoding UTF8 |
        ConvertFrom-Json
    if ($aiResponse.status -ne 'success') {
        throw "The AI dialog action returned '$($aiResponse.status)': $($aiResponse.message)"
    }
    Wait-Until `
        -Condition { Test-Path -LiteralPath $aiOutput } `
        -FailureMessage 'The AI-selected dialog action did not invoke the fixture button.'
    $aiResult = [string](Get-Content -LiteralPath $aiOutput -Raw)
    if ($aiResult -ne 'Proceed Safely') {
        throw "AI dialog action selected '$aiResult' instead of 'Proceed Safely'."
    }
    Wait-Until `
        -Condition {
            (Get-Content -LiteralPath $learnedPath -Raw -Encoding UTF8) -match
                'Proceed Safely'
        } `
        -FailureMessage 'The AI-selected action was not persisted as a learned rule.'

    $aiLearnedOutput = Join-Path $testRoot 'ai-learned-result.txt'
    $aiLearnedFixture = Start-FixtureProcess `
        -Executable $fixtureExecutable `
        -Mode 'ai' `
        -OutputPath $aiLearnedOutput
    $fixtures.Add($aiLearnedFixture)
    Wait-Until `
        -Condition { Test-Path -LiteralPath $aiLearnedOutput } `
        -FailureMessage 'The learned AI dialog rule was not applied on recurrence.'
    $aiLearnedResult = [string](
        Get-Content -LiteralPath $aiLearnedOutput -Raw
    )
    if ($aiLearnedResult -ne 'Proceed Safely') {
        throw "Learned AI dialog selected '$aiLearnedResult' instead of 'Proceed Safely'."
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

    $actionLog = Join-Path $logDirectory 'actions.jsonl'
    $actions = Get-Content -LiteralPath $actionLog -Raw
    if ($actions -notmatch '"ruleType":"known"' -or
        $actions -notmatch '"ruleType":"learned"' -or
        $actions -notmatch '"ruleType":"ai"' -or
        $actions -notmatch '"type":"dialog.ai-action"' -or
        $actions -notmatch '"type":"dialog.learned"') {
        throw 'Action log does not prove known, AI, learned, and learning flows.'
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
        ownedScenePreserved = $true
        unresolvedKnownDialogRemainsVisible = $true
        aiDialogExposed = $true
        aiDialogAction = $aiResult
        unknownDialogRecorded = $true
        aiActionLearned = $true
        interactiveLearningHooksRegistered = $true
        learnedDialogAction = $aiLearnedResult
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
