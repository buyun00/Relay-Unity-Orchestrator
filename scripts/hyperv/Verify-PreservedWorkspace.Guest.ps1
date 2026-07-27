[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ExpectedBranch,
    [string]$ExpectedHead,
    [AllowNull()][string]$AuditedFilesJson,
    [switch]$OutputJson
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

if (-not (Get-Command Invoke-RelayGit -CommandType Function -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Workspace-Git.ps1')
}

function Complete-Verification([object]$Result) {
    if ($OutputJson) {
        return ($Result | ConvertTo-Json -Depth 12 -Compress)
    }
    return $Result
}

function ConvertFrom-AuditedFilesJson {
    param([AllowNull()][string]$Json)

    if ([string]::IsNullOrWhiteSpace($Json)) {
        return ,([object[]]@())
    }
    try {
        $decoded = $Json | ConvertFrom-Json
    } catch {
        throw "AuditedFilesJson was not valid JSON inside the guest: $($_.Exception.Message)"
    }
    if ($null -eq $decoded) {
        return ,([object[]]@())
    }
    $items = [object[]]@($decoded)
    foreach ($item in $items) {
        if ($null -eq $item -or $item -isnot [psobject]) {
            throw 'AuditedFilesJson must contain an array of audited file objects or null.'
        }
    }
    return ,$items
}

function New-VerificationFailure(
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Message,
    [AllowNull()][string]$Branch,
    [AllowNull()][string]$Head,
    [AllowNull()][AllowEmptyCollection()][object[]]$Status = @(),
    [AllowNull()][AllowEmptyCollection()][object[]]$AuditedFiles = @()
) {
    if ($null -eq $Status) {
        $Status = [object[]]@()
    }
    if ($null -eq $AuditedFiles) {
        $AuditedFiles = [object[]]@()
    }
    return [pscustomobject]@{
        ready = $false
        preserved = $true
        code = $Code
        message = $Message
        projectPath = $ProjectPath
        branch = $Branch
        head = $Head
        expectedBranch = $ExpectedBranch
        expectedHead = $ExpectedHead
        changedFiles = @($Status).Count
        status = [object[]]@($Status)
        auditedFiles = [object[]]@($AuditedFiles)
    }
}

$auditedFiles = ConvertFrom-AuditedFilesJson -Json $AuditedFilesJson
if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) {
    return (Complete-Verification (New-VerificationFailure `
        -Code 'PRESERVED_WORKSPACE_NOT_FOUND' `
        -Message "Preserved workspace was not found at '$ProjectPath'." `
        -Branch $null `
        -Head $null `
        -AuditedFiles $auditedFiles))
}
if (-not (Test-Path -LiteralPath (Join-Path $ProjectPath '.git'))) {
    return (Complete-Verification (New-VerificationFailure `
        -Code 'PRESERVED_REPOSITORY_NOT_FOUND' `
        -Message "Git metadata was not found at '$ProjectPath'." `
        -Branch $null `
        -Head $null `
        -AuditedFiles $auditedFiles))
}

$currentBranch = Get-RelayGitValue $ProjectPath @('branch', '--show-current')
$currentHead = Get-RelayGitValue $ProjectPath @('rev-parse', '--verify', 'HEAD')
if ([string]::IsNullOrWhiteSpace($currentBranch)) {
    return (Complete-Verification (New-VerificationFailure `
        -Code 'PRESERVED_WORKSPACE_DETACHED' `
        -Message 'Preserved workspace has a detached HEAD.' `
        -Branch $null `
        -Head $currentHead `
        -AuditedFiles $auditedFiles))
}
if ($currentBranch -ne $ExpectedBranch) {
    return (Complete-Verification (New-VerificationFailure `
        -Code 'PRESERVED_WORKSPACE_BRANCH_CHANGED' `
        -Message "Expected preserved branch '$ExpectedBranch', but found '$currentBranch'." `
        -Branch $currentBranch `
        -Head $currentHead `
        -AuditedFiles $auditedFiles))
}
if (
    -not [string]::IsNullOrWhiteSpace($ExpectedHead) -and
    $currentHead -ne $ExpectedHead
) {
    return (Complete-Verification (New-VerificationFailure `
        -Code 'PRESERVED_WORKSPACE_HEAD_CHANGED' `
        -Message "Expected preserved HEAD '$ExpectedHead', but found '$currentHead'." `
        -Branch $currentBranch `
        -Head $currentHead `
        -AuditedFiles $auditedFiles))
}
$status = @(Get-RelayWorkspaceStatus $ProjectPath)
if ($auditedFiles.Count -gt 0 -or $status.Count -gt 0) {
    $blockedPaths = @(
        @($auditedFiles | ForEach-Object { [string]$_.path }) +
        @($status | ForEach-Object { [string]$_.path }) |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Sort-Object -Unique
    )
    return (Complete-Verification (New-VerificationFailure `
        -Code 'PRESERVED_WORKSPACE_DIRTY' `
        -Message "Established task branch '$ExpectedBranch' is not clean; refusing to resume Codex: $($blockedPaths -join ', ')" `
        -Branch $currentBranch `
        -Head $currentHead `
        -Status $status `
        -AuditedFiles $auditedFiles))
}
$result = [pscustomobject]@{
    ready = $true
    code = $null
    message = "Established task branch '$ExpectedBranch' is clean and verified."
    projectPath = $ProjectPath
    branch = $currentBranch
    head = $currentHead
    expectedBranch = $ExpectedBranch
    expectedHead = $ExpectedHead
    changedFiles = 0
    status = [object[]]@()
    auditedFiles = [object[]]@()
    preserved = $true
}
Complete-Verification $result
