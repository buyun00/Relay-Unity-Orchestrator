[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RepoUrl,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$BaseBranch,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TaskBranch,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedRemoteTip,
    [string]$SharePath,
    [ValidateNotNullOrEmpty()][string]$ApprovedOverlayPathsJson = '[]',
    [ValidateRange(10, 120)][int]$GitNetworkTimeoutSeconds = 45,
    [ValidateRange(60, 600)][int]$PowerShellDirectTimeoutSeconds = 360
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'Credential.ps1')
. (Join-Path $PSScriptRoot 'PowerShell-Direct.ps1')

function Write-RecoveryResult(
    [Parameter(Mandatory = $true)][object]$Payload,
    [int]$ExitCode = 0,
    [string]$ErrorMarker
) {
    $json = $Payload | ConvertTo-Json -Depth 12 -Compress
    [Console]::Out.WriteLine($json)
    if (-not [string]::IsNullOrWhiteSpace($ErrorMarker)) {
        [Console]::Error.WriteLine($ErrorMarker + $json)
    }
    if ($ExitCode -ne 0) { exit $ExitCode }
}

function New-HostRecoveryFailure(
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string]$Message,
    [AllowNull()][object]$ExitCode = $null,
    [string]$Stdout = '',
    [string]$Stderr = '',
    [bool]$TimedOut = $false
) {
    return [pscustomobject]@{
        proofVersion = 2
        proven = $false
        ready = $false
        code = $Code
        phase = $Stage
        reason = $Code
        message = $Message
        refusal = [pscustomobject]@{
            phase = $Stage
            reason = $Code
            code = $Code
            message = $Message
        }
        stage = $Stage
        exitCode = $ExitCode
        stdout = $Stdout
        stderr = $Stderr
        timedOut = $TimedOut
        expectedRemoteTip = $ExpectedRemoteTip
        remoteTip = $null
        remoteRef = "refs/heads/$TaskBranch"
        taskBranch = $TaskBranch
        taskBranchCreated = $false
        taskBranchFastForwarded = $false
        currentBranch = $null
        statusAfter = @()
        untrackedFilesAfter = @()
        preservationRef = $null
        preservationRefCreated = $false
    }
}

$credential = Import-RelayCredential -Path $CredentialPath
$helperPath = Join-Path $PSScriptRoot 'Workspace-Git.ps1'
$guestScriptPath = Join-Path $PSScriptRoot 'Recover-Workspace.Guest.ps1'
foreach ($requiredScript in @($helperPath, $guestScriptPath)) {
    if (-not (Test-Path -LiteralPath $requiredScript -PathType Leaf)) {
        throw "Recovery dependency '$requiredScript' was not found."
    }
}
$helperSource = [System.IO.File]::ReadAllText($helperPath, [System.Text.Encoding]::UTF8)
$guestSource = [System.IO.File]::ReadAllText($guestScriptPath, [System.Text.Encoding]::UTF8)

try {
    $remoteOutput = @(
        Invoke-RelayPowerShellDirect -VMName $VMName -Credential $credential -ArgumentList @(
            $GuestProjectPath, $RepoUrl, $BaseBranch, $TaskBranch,
            $ExpectedRemoteTip, $GitNetworkTimeoutSeconds, $ApprovedOverlayPathsJson,
            $helperSource, $guestSource
        ) -Stage 'powershell-direct-recovery' -TimeoutSeconds $PowerShellDirectTimeoutSeconds -ScriptBlock {
            param(
                $ProjectPath, $RepositoryUrl, $Base, $Branch,
                $ExpectedTip, $GitTimeout, $ApprovedOverlaysJson,
                $HelperSource, $GuestSource
            )
            $ErrorActionPreference = 'Stop'
            Set-StrictMode -Version Latest
            $env:RELAY_APPROVED_OVERLAY_PATHS_JSON = $ApprovedOverlaysJson
            . ([scriptblock]::Create($HelperSource))
            & ([scriptblock]::Create($GuestSource)) -ProjectPath $ProjectPath -RepositoryUrl $RepositoryUrl -BaseBranch $Base -TaskBranch $Branch -ExpectedRemoteTip $ExpectedTip -GitNetworkTimeoutSeconds $GitTimeout -OutputJson
        }
    )
    $records = @(
        $remoteOutput |
            ForEach-Object { ([string]$_).Trim() } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($records.Count -ne 1) {
        $failure = New-HostRecoveryFailure -Code 'RECOVERY_HOST_OUTPUT_CARDINALITY' -Stage 'powershell-direct-output' -Message "Recovery received $($records.Count) success-stream records; exactly one JSON record was required."
        Write-RecoveryResult $failure 1 'RELAY_RECOVERY_FAILED:'
    }
    try {
        $result = $records[0] | ConvertFrom-Json
    } catch {
        $failure = New-HostRecoveryFailure -Code 'RECOVERY_HOST_JSON_INVALID' -Stage 'powershell-direct-output' -Message "Recovery returned invalid JSON: $($_.Exception.Message)" -Stdout $records[0]
        Write-RecoveryResult $failure 1 'RELAY_RECOVERY_FAILED:'
    }
    if ($null -eq $result -or $result -isnot [psobject]) {
        $failure = New-HostRecoveryFailure -Code 'RECOVERY_HOST_JSON_INVALID' -Stage 'powershell-direct-output' -Message 'Recovery returned JSON that was not an object.' -Stdout $records[0]
        Write-RecoveryResult $failure 1 'RELAY_RECOVERY_FAILED:'
    }
    if (-not [bool]$result.ready) {
        Write-RecoveryResult $result 42 'RELAY_WORKSPACE_REFUSED:'
    }
    # Strip PowerShell Direct remoting metadata and native helper buffers from
    # the only success-stream JSON record.
    $result = $result | Select-Object -Property @(
        'proofVersion', 'proven', 'ready', 'projectPath', 'branch', 'head',
        'source', 'originalBranch', 'originalHead', 'statusBefore',
        'porcelainV2Before', 'untrackedFilesBefore', 'auditFingerprint',
        'auditedHead', 'expectedRemoteTip', 'remoteTip', 'remoteRef',
        'remoteTipAttempts', 'fetchAttempts', 'branchAction',
        'localTaskHeadBefore', 'localTaskHeadAfter', 'taskBranch',
        'taskBranchCreated', 'taskBranchFastForwarded', 'currentBranch',
        'statusAfter', 'porcelainV2After', 'untrackedFilesAfter',
        'preservationRef', 'preservationRefCreated', 'preservedBranch',
        'preservedCommit', 'preservationBranch', 'preservationCommit',
        'preservationParent', 'reused', 'parentVerified',
        'nameStatusVerified', 'treeVerified', 'blobVerified', 'verifiedFiles',
        'preservedTree', 'preservedNameStatus', 'preservedFiles', 'auditedFiles',
        'reusedPreservation', 'preservationVerified',
        'preTargetCheckoutBranch', 'preTargetCheckoutHead'
    )
    if (-not [string]::IsNullOrWhiteSpace($SharePath) -and -not (Test-Path -LiteralPath $SharePath)) {
        $failure = New-HostRecoveryFailure -Code 'RECOVERY_SMB_UNREACHABLE' -Stage 'host-smb-verification' -Message "Host SMB workspace '$SharePath' is not reachable after guest recovery."
        Write-RecoveryResult $failure 1 'RELAY_RECOVERY_FAILED:'
    }
    Write-RecoveryResult $result
} catch {
    $stage = [string]$_.Exception.Data['relayStage']
    if ([string]::IsNullOrWhiteSpace($stage)) { $stage = 'recovery-host-wrapper' }
    $timedOut = [bool]$_.Exception.Data['relayTimedOut']
    $code = if ($timedOut) { 'RECOVERY_STAGE_TIMEOUT' } else { 'RECOVERY_HOST_EXCEPTION' }
    $failure = New-HostRecoveryFailure -Code $code -Stage $stage -Message $_.Exception.Message -ExitCode $_.Exception.Data['relayExitCode'] -Stdout ([string]$_.Exception.Data['relayStdout']) -Stderr ([string]$_.Exception.Data['relayStderr']) -TimedOut $timedOut
    Write-RecoveryResult $failure 1 'RELAY_RECOVERY_FAILED:'
}
