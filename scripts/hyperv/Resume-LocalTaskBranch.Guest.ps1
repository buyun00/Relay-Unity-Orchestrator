[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ProjectPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^codex/task-[0-9]+-')][string]$TaskBranch,
    [Parameter(Mandatory = $true)][string]$ExpectedCurrentBranch,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedCurrentHead
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not (Get-Command Invoke-RelayGit -CommandType Function -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Workspace-Git.ps1')
}

$branch = Get-RelayGitValue $ProjectPath @('branch', '--show-current')
$head = Get-RelayGitValue $ProjectPath @('rev-parse', '--verify', 'HEAD')
if ($branch -ne $ExpectedCurrentBranch -or $head -ne $ExpectedCurrentHead) {
    throw 'LOCAL_DRAFT_WORKSPACE_CHANGED: current branch/HEAD changed since inspection; nothing was switched.'
}
$status = Get-RelayGitValue $ProjectPath @('status', '--porcelain=v1', '--untracked-files=all')
if (-not [string]::IsNullOrWhiteSpace($status)) {
    throw 'LOCAL_DRAFT_WORKSPACE_DIRTY: preserve the current task changes before switching branches.'
}
$taskRef = 'refs/heads/' + $TaskBranch
if (-not (Test-RelayGitReference $ProjectPath $taskRef)) {
    throw 'LOCAL_DRAFT_NOT_FOUND: the task branch is absent; restore its verified backup before resuming.'
}
$draftHead = Get-RelayGitValue $ProjectPath @('rev-parse', '--verify', ($taskRef + '^{commit}'))
# No reset, checkout -B, fetch, push, or checkpoint restore. Git also refuses to
# overwrite ignored files which happen to collide with this local task branch.
$null = Invoke-RelayGit $ProjectPath @('checkout', '--no-overwrite-ignore', $TaskBranch)
$afterBranch = Get-RelayGitValue $ProjectPath @('branch', '--show-current')
$afterHead = Get-RelayGitValue $ProjectPath @('rev-parse', '--verify', 'HEAD')
$previousRef = Get-RelayGitValue $ProjectPath @('rev-parse', '--verify', ('refs/heads/' + $ExpectedCurrentBranch))
$statusAfter = Get-RelayGitValue $ProjectPath @('status', '--porcelain=v1', '--untracked-files=all')
if ($afterBranch -ne $TaskBranch -or $afterHead -ne $draftHead -or $previousRef -ne $ExpectedCurrentHead -or -not [string]::IsNullOrWhiteSpace($statusAfter)) {
    throw 'LOCAL_DRAFT_IDENTITY_CHANGED: branch verification failed; no destructive recovery was attempted.'
}
[pscustomobject]@{
    ready = $true
    preserved = $true
    localDraft = $true
    branch = $afterBranch
    head = $afterHead
    originalBranch = $branch
    originalHead = $head
} | ConvertTo-Json -Compress
