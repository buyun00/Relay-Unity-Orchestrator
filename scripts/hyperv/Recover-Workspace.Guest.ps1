[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RepositoryUrl,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$BaseBranch,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TaskBranch,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedRemoteTip,
    [ValidateRange(10, 120)][int]$GitNetworkTimeoutSeconds = 45,
    [switch]$OutputJson
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'Never'

if (-not (Get-Command Invoke-RelayGit -CommandType Function -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Workspace-Git.ps1')
}

function Complete-RecoveryResult([object]$Result) {
    if ($OutputJson) {
        return ($Result | ConvertTo-Json -Depth 12 -Compress)
    }
    return $Result
}

function Get-GitValue([string[]]$Arguments) {
    return Get-RelayGitValue $ProjectPath $Arguments
}

function Get-CompleteWorkspaceState {
    $status = @(Get-RelayWorkspaceStatus $ProjectPath)
    $porcelainResult = Invoke-RelayGit $ProjectPath @(
        'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'
    ) @{} 30 'workspace-status-porcelain-v2'
    $porcelain = @(ConvertFrom-RelayNulFields $porcelainResult.stdoutBytes)
    $untracked = @(
        $status |
            Where-Object { $_.code -eq '??' } |
            ForEach-Object { $_.path }
    )
    return [pscustomobject]@{
        status = $status
        porcelainV2 = $porcelain
        untrackedFiles = $untracked
    }
}

function New-RecoveryRefusal {
    param(
        [Parameter(Mandatory = $true)][string]$Code,
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][string]$Message,
        [object]$WorkspaceState,
        [string]$OriginalBranch = '',
        [string]$OriginalHead = '',
        [object[]]$Attempts = @(),
        [AllowNull()][object]$ExitCode = $null,
        [string]$Stdout = '',
        [string]$Stderr = '',
        [bool]$TimedOut = $false,
        [string]$RemoteTip = $null
    )

    $status = if ($null -eq $WorkspaceState) { @() } else { @($WorkspaceState.status) }
    $porcelain = if ($null -eq $WorkspaceState) { @() } else { @($WorkspaceState.porcelainV2) }
    $untracked = if ($null -eq $WorkspaceState) { @() } else { @($WorkspaceState.untrackedFiles) }
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
        projectPath = $ProjectPath
        originalBranch = $OriginalBranch
        originalHead = $OriginalHead
        statusBefore = $status
        porcelainV2Before = $porcelain
        untrackedFilesBefore = $untracked
        blockedPaths = @($status | ForEach-Object { $_.path } | Sort-Object -Unique)
        expectedRemoteTip = $ExpectedRemoteTip.ToLowerInvariant()
        remoteTip = $RemoteTip
        remoteRef = "refs/heads/$TaskBranch"
        stage = $Stage
        attempts = @($Attempts)
        exitCode = $ExitCode
        stdout = $Stdout
        stderr = $Stderr
        timedOut = $TimedOut
        taskBranch = $TaskBranch
        taskBranchCreated = $false
        taskBranchFastForwarded = $false
        currentBranch = $OriginalBranch
        statusAfter = $status
        porcelainV2After = $porcelain
        untrackedFilesAfter = $untracked
        preservationRef = $null
        preservationRefCreated = $false
    }
}

function Complete-Refusal {
    param([Parameter(Mandatory = $true)][object]$Refusal)
    return (Complete-RecoveryResult $Refusal)
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectPath '.git'))) {
    return (Complete-Refusal (New-RecoveryRefusal -Code 'PRESERVED_WORKSPACE_NOT_FOUND' -Stage 'workspace-inspection' -Message "Recovery requires the existing Git workspace '$ProjectPath'; no clone was attempted."))
}

$originalBranch = Get-GitValue @('branch', '--show-current')
$originalHead = Get-GitValue @('rev-parse', '--verify', 'HEAD')
$workspaceState = Get-CompleteWorkspaceState
if ($workspaceState.status.Count -gt 0) {
    return (Complete-Refusal (New-RecoveryRefusal -Code 'WORKSPACE_DIRTY_REFUSED' -Stage 'workspace-cleanliness' -Message 'Recovery refused because complete porcelain v2 or untracked state is not clean; no remote or branch operation was attempted.' -WorkspaceState $workspaceState -OriginalBranch $originalBranch -OriginalHead $originalHead))
}
if ($originalBranch -ne $BaseBranch) {
    return (Complete-Refusal (New-RecoveryRefusal -Code 'WORKSPACE_BASE_BRANCH_MISMATCH' -Stage 'workspace-branch' -Message "Recovery expected clean restored branch '$BaseBranch', but found '$originalBranch'; no mutation was attempted." -WorkspaceState $workspaceState -OriginalBranch $originalBranch -OriginalHead $originalHead))
}
$baseRefHead = Get-GitValue @('rev-parse', '--verify', "refs/heads/$BaseBranch")
if ($baseRefHead -ne $originalHead) {
    return (Complete-Refusal (New-RecoveryRefusal -Code 'WORKSPACE_BASE_REF_MISMATCH' -Stage 'workspace-branch' -Message "Checked-out '$BaseBranch' did not resolve to '$originalHead'; no mutation was attempted." -WorkspaceState $workspaceState -OriginalBranch $originalBranch -OriginalHead $originalHead))
}
$ExpectedRemoteTip = $ExpectedRemoteTip.ToLowerInvariant()
$originUrl = Get-GitValue @('remote', 'get-url', 'origin')
if ($originUrl -ne $RepositoryUrl) {
    return (Complete-Refusal (New-RecoveryRefusal -Code 'WORKSPACE_REMOTE_MISMATCH' -Stage 'remote-identity' -Message "Configured origin '$originUrl' does not equal expected '$RepositoryUrl'; Relay did not change it." -WorkspaceState $workspaceState -OriginalBranch $originalBranch -OriginalHead $originalHead))
}

try {
    $tipQuery = Invoke-RelayGitWithRetry $ProjectPath @(
        'ls-remote', '--exit-code', '--refs', 'origin', "refs/heads/$TaskBranch"
    ) 'remote-tip-ls-remote' @{} $GitNetworkTimeoutSeconds 3 1000
} catch {
    $failure = New-RecoveryRefusal -Code 'RECOVERY_REMOTE_TIP_QUERY_FAILED' -Stage ([string]$_.Exception.Data['relayStage']) -Message $_.Exception.Message -WorkspaceState $workspaceState -OriginalBranch $originalBranch -OriginalHead $originalHead -Attempts @($_.Exception.Data['relayAttempts']) -ExitCode $_.Exception.Data['relayExitCode'] -Stdout ([string]$_.Exception.Data['relayStdout']) -Stderr ([string]$_.Exception.Data['relayStderr']) -TimedOut ([bool]$_.Exception.Data['relayTimedOut'])
    return (Complete-Refusal $failure)
}
$tipLines = @($tipQuery.result.stdout.Trim() -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$expectedRemoteRef = "refs/heads/$TaskBranch"
if ($tipLines.Count -ne 1 -or $tipLines[0] -notmatch '^([0-9a-fA-F]{40})\s+(.+)$' -or $Matches[2] -ne $expectedRemoteRef) {
    return (Complete-Refusal (New-RecoveryRefusal -Code 'RECOVERY_REMOTE_TIP_INVALID' -Stage 'remote-tip-ls-remote' -Message "Remote tip query returned an invalid or ambiguous result for '$expectedRemoteRef'." -WorkspaceState $workspaceState -OriginalBranch $originalBranch -OriginalHead $originalHead -Attempts $tipQuery.attempts -Stdout $tipQuery.result.stdout -Stderr $tipQuery.result.stderr))
}
$remoteTip = $Matches[1].ToLowerInvariant()
if ($remoteTip -ne $ExpectedRemoteTip) {
    return (Complete-Refusal (New-RecoveryRefusal -Code 'RECOVERY_REMOTE_TIP_MISMATCH' -Stage 'remote-tip-verification' -Message "Remote '$expectedRemoteRef' resolved to '$remoteTip', not durably delivered '$ExpectedRemoteTip'; no fetch or branch operation was attempted." -WorkspaceState $workspaceState -OriginalBranch $originalBranch -OriginalHead $originalHead -Attempts $tipQuery.attempts -RemoteTip $remoteTip))
}

try {
    $fetch = Invoke-RelayGitWithRetry $ProjectPath @(
        'fetch', '--no-tags', '--no-prune', 'origin',
        "refs/heads/$($TaskBranch):refs/remotes/origin/$TaskBranch"
    ) 'task-branch-fetch' @{} $GitNetworkTimeoutSeconds 3 1000
} catch {
    $failure = New-RecoveryRefusal -Code 'RECOVERY_FETCH_FAILED' -Stage ([string]$_.Exception.Data['relayStage']) -Message $_.Exception.Message -WorkspaceState $workspaceState -OriginalBranch $originalBranch -OriginalHead $originalHead -Attempts @($_.Exception.Data['relayAttempts']) -ExitCode $_.Exception.Data['relayExitCode'] -Stdout ([string]$_.Exception.Data['relayStdout']) -Stderr ([string]$_.Exception.Data['relayStderr']) -TimedOut ([bool]$_.Exception.Data['relayTimedOut']) -RemoteTip $remoteTip
    return (Complete-Refusal $failure)
}
$fetchedTip = Get-GitValue @('rev-parse', '--verify', "refs/remotes/origin/$TaskBranch")
if ($fetchedTip -ne $ExpectedRemoteTip) {
    return (Complete-Refusal (New-RecoveryRefusal -Code 'RECOVERY_REMOTE_CHANGED_DURING_FETCH' -Stage 'fetched-tip-verification' -Message "Fetched remote-tracking tip '$fetchedTip' no longer equals '$ExpectedRemoteTip'; no local branch operation was attempted." -WorkspaceState $workspaceState -OriginalBranch $originalBranch -OriginalHead $originalHead -Attempts $fetch.attempts -RemoteTip $remoteTip))
}
Invoke-RelayGit $ProjectPath @('cat-file', '-e', "$($ExpectedRemoteTip)^{commit}") @{} 30 'fetched-commit-type' | Out-Null
$verifiedCommit = Get-GitValue @('rev-parse', "$($ExpectedRemoteTip)^{commit}")
if ($verifiedCommit -ne $ExpectedRemoteTip) {
    return (Complete-Refusal (New-RecoveryRefusal -Code 'RECOVERY_COMMIT_OBJECT_MISMATCH' -Stage 'fetched-commit-verification' -Message "Fetched object resolved to '$verifiedCommit', not '$ExpectedRemoteTip'; no branch operation was attempted." -WorkspaceState $workspaceState -OriginalBranch $originalBranch -OriginalHead $originalHead -Attempts $fetch.attempts -RemoteTip $remoteTip))
}

$preBranchState = Get-CompleteWorkspaceState
$preBranchName = Get-GitValue @('branch', '--show-current')
$preBranchHead = Get-GitValue @('rev-parse', '--verify', 'HEAD')
if ($preBranchState.status.Count -gt 0 -or $preBranchName -ne $originalBranch -or $preBranchHead -ne $originalHead) {
    return (Complete-Refusal (New-RecoveryRefusal -Code 'WORKSPACE_CHANGED_BEFORE_BRANCH_OPERATION' -Stage 'pre-branch-verification' -Message 'Workspace branch, HEAD, porcelain v2, or untracked state changed during remote verification; no branch operation was attempted.' -WorkspaceState $preBranchState -OriginalBranch $originalBranch -OriginalHead $originalHead -RemoteTip $remoteTip))
}

$localTaskExists = Test-RelayGitReference $ProjectPath "refs/heads/$TaskBranch"
$localTaskHeadBefore = $null
$taskBranchCreated = $false
$taskBranchFastForwarded = $false
$branchAction = 'created'
if ($localTaskExists) {
    $localTaskHeadBefore = Get-GitValue @('rev-parse', "refs/heads/$TaskBranch")
    $ancestorResult = Invoke-RelayGitProcess $ProjectPath @(
        'merge-base', '--is-ancestor', $localTaskHeadBefore, $ExpectedRemoteTip
    ) @{} 30 'local-task-compatibility'
    if ($ancestorResult.exitCode -eq 1) {
        return (Complete-Refusal (New-RecoveryRefusal -Code 'WORKSPACE_TARGET_BRANCH_NON_FAST_FORWARD' -Stage 'local-task-compatibility' -Message "Local '$TaskBranch' at '$localTaskHeadBefore' cannot fast-forward to '$ExpectedRemoteTip'; it was not switched or changed." -WorkspaceState $preBranchState -OriginalBranch $originalBranch -OriginalHead $originalHead -RemoteTip $remoteTip))
    }
    if ($ancestorResult.exitCode -ne 0 -or $ancestorResult.timedOut) {
        throw (New-RelayGitFailure $ancestorResult @('merge-base'))
    }
    Invoke-RelayGit $ProjectPath @('checkout', $TaskBranch) @{} 30 'task-branch-checkout' | Out-Null
    if ($localTaskHeadBefore -eq $ExpectedRemoteTip) {
        $branchAction = 'existing-compatible'
    } else {
        Invoke-RelayGit $ProjectPath @('merge', '--ff-only', $ExpectedRemoteTip) @{} 30 'task-branch-fast-forward' | Out-Null
        $taskBranchFastForwarded = $true
        $branchAction = 'fast-forwarded'
    }
} else {
    Invoke-RelayGit $ProjectPath @(
        'checkout', '-b', $TaskBranch, '--track', "origin/$TaskBranch"
    ) @{} 30 'task-branch-create-tracking' | Out-Null
    $taskBranchCreated = $true
}

$head = Get-GitValue @('rev-parse', '--verify', 'HEAD')
$currentBranch = Get-GitValue @('branch', '--show-current')
$statusAfterState = Get-CompleteWorkspaceState
if ($currentBranch -ne $TaskBranch -or $head -ne $ExpectedRemoteTip -or $statusAfterState.status.Count -gt 0) {
    return (Complete-Refusal (New-RecoveryRefusal -Code 'RECOVERY_POST_BRANCH_VERIFICATION_FAILED' -Stage 'post-branch-verification' -Message "Recovery ended on '$currentBranch' at '$head' with $($statusAfterState.status.Count) workspace change(s); the worker must remain in attention." -WorkspaceState $statusAfterState -OriginalBranch $originalBranch -OriginalHead $originalHead -RemoteTip $remoteTip))
}

Complete-RecoveryResult ([pscustomobject]@{
    proofVersion = 2
    proven = $true
    ready = $true
    projectPath = $ProjectPath
    branch = $TaskBranch
    head = $head
    source = "origin/$TaskBranch"
    originalBranch = $originalBranch
    originalHead = $originalHead
    statusBefore = @($workspaceState.status)
    porcelainV2Before = @($workspaceState.porcelainV2)
    untrackedFilesBefore = @($workspaceState.untrackedFiles)
    auditFingerprint = Get-RelayAuditFingerprint $originalHead @()
    auditedHead = $originalHead
    expectedRemoteTip = $ExpectedRemoteTip
    remoteTip = $remoteTip
    remoteRef = $expectedRemoteRef
    remoteTipAttempts = @($tipQuery.attempts)
    fetchAttempts = @($fetch.attempts)
    branchAction = $branchAction
    localTaskHeadBefore = $localTaskHeadBefore
    localTaskHeadAfter = $head
    taskBranch = $TaskBranch
    taskBranchCreated = $taskBranchCreated
    taskBranchFastForwarded = $taskBranchFastForwarded
    currentBranch = $currentBranch
    statusAfter = @($statusAfterState.status)
    porcelainV2After = @($statusAfterState.porcelainV2)
    untrackedFilesAfter = @($statusAfterState.untrackedFiles)
    preservationRef = $null
    preservationRefCreated = $false
    preservedBranch = $originalBranch
    preservedCommit = $originalHead
    preservationBranch = $originalBranch
    preservationCommit = $originalHead
    preservationParent = $originalHead
    reused = $true
    parentVerified = $true
    nameStatusVerified = $true
    treeVerified = $true
    blobVerified = $true
    verifiedFiles = @()
    preservedTree = Get-GitValue @('rev-parse', "$($originalHead)^{tree}")
    preservedNameStatus = @()
    preservedFiles = @()
    auditedFiles = @()
    preservationVerified = $true
    preTargetCheckoutBranch = $originalBranch
    preTargetCheckoutHead = $originalHead
})
