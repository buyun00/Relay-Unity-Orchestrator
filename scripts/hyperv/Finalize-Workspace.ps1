[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TaskBranch,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CommitMessage,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ExpectedAuditJson,
    [ValidateNotNullOrEmpty()][string]$GitAuthorName = 'Relay Unity Orchestrator',
    [ValidateNotNullOrEmpty()][string]$GitAuthorEmail = 'relay-unity-orchestrator@localhost'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'Credential.ps1')
$credential = Import-RelayCredential -Path $CredentialPath

$result = Invoke-Command -VMName $VMName -Credential $credential -ArgumentList @(
    $GuestProjectPath, $TaskBranch, $CommitMessage, $GitAuthorName, $GitAuthorEmail,
    $ExpectedAuditJson
) -ScriptBlock {
    param($ProjectPath, $Branch, $Message, $AuthorName, $AuthorEmail, $AuditJson)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = [Console]::OutputEncoding
    $env:GCM_INTERACTIVE = '0'

    function Invoke-Git([string[]]$Arguments) {
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            # Git Credential Manager writes some non-fatal provider warnings
            # to stderr. Use the native exit code as the source of truth.
            $ErrorActionPreference = 'Continue'
            $output = & git -C $ProjectPath @Arguments 2>&1
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($exitCode -ne 0) {
            throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
        }
        return $output
    }

    function ConvertTo-SafeGitPath([string]$Path) {
        if ([string]::IsNullOrWhiteSpace($Path)) {
            throw 'DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: audited path was empty.'
        }
        $normalized = $Path.Replace('\', '/')
        if (
            $normalized.StartsWith('/', [System.StringComparison]::Ordinal) -or
            $normalized.StartsWith('//', [System.StringComparison]::Ordinal) -or
            $normalized -match '^[A-Za-z]:/'
        ) {
            throw "DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: audited path '$Path' was not repository-relative."
        }
        $parts = New-Object System.Collections.Generic.List[string]
        foreach ($part in $normalized.Split('/')) {
            if ([string]::IsNullOrEmpty($part) -or $part -eq '.') { continue }
            if ($part -eq '..') {
                throw "DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: audited path '$Path' escaped the repository."
            }
            $parts.Add($part)
        }
        if ($parts.Count -eq 0) {
            throw "DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: audited path '$Path' normalized to an empty path."
        }
        return [string]::Join('/', $parts.ToArray())
    }

    function Get-FileSha256([string]$LiteralPath) {
        $stream = [System.IO.File]::Open(
            $LiteralPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite
        )
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString(
                $sha256.ComputeHash($stream)
            )).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha256.Dispose()
            $stream.Dispose()
        }
    }

    function Get-WorkspaceStatusRecords {
        $records = New-Object System.Collections.Generic.List[object]
        $statusLines = @(
            Invoke-Git @(
                '-c', 'core.quotePath=false', 'status', '--porcelain=v1',
                '--untracked-files=all', '--no-renames'
            ) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
        )
        foreach ($lineValue in $statusLines) {
            $line = [string]$lineValue
            if ($line.Length -lt 4 -or $line[2] -ne ' ') {
                throw "DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: unexpected Git status record '$line'."
            }
            $records.Add([pscustomobject]@{
                code = $line.Substring(0, 2)
                path = ConvertTo-SafeGitPath $line.Substring(3)
            })
        }
        return $records.ToArray()
    }

    function Assert-ExactAuditedWorkspace(
        [object[]]$ExpectedFiles,
        [bool]$RequireFullyStaged
    ) {
        $actual = @(Get-WorkspaceStatusRecords)
        if ($actual.Count -ne $ExpectedFiles.Count) {
            throw "DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: expected $($ExpectedFiles.Count) changed path(s), found $($actual.Count)."
        }
        $actualByPath = @{}
        foreach ($entry in $actual) {
            if ($actualByPath.ContainsKey([string]$entry.path)) {
                throw "DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: duplicate changed path '$($entry.path)'."
            }
            $actualByPath[[string]$entry.path] = $entry
        }
        foreach ($expected in $ExpectedFiles) {
            $expectedPath = ConvertTo-SafeGitPath ([string]$expected.path)
            if (-not $actualByPath.ContainsKey($expectedPath)) {
                throw "DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: audited path '$expectedPath' was missing from Git status."
            }
            $actualEntry = $actualByPath[$expectedPath]
            if ($RequireFullyStaged) {
                if (
                    @('M', 'A') -notcontains [string]$actualEntry.code[0] -or
                    $actualEntry.code[1] -ne ' '
                ) {
                    throw "DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: '$expectedPath' was not exactly staged after the audit."
                }
            } elseif ([string]$actualEntry.code -ne [string]$expected.code) {
                throw "DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: '$expectedPath' status changed from '$($expected.code)' to '$($actualEntry.code)'."
            }
            $absolutePath = Join-Path $ProjectPath $expectedPath
            if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
                throw "DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: audited file '$expectedPath' was missing."
            }
            $actualSha256 = Get-FileSha256 $absolutePath
            if ($actualSha256 -ne ([string]$expected.sha256).ToLowerInvariant()) {
                throw "DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: audited file '$expectedPath' changed hash before commit."
            }
        }
    }

    $headPath = Join-Path $ProjectPath '.git\HEAD'
    if (-not (Test-Path -LiteralPath $headPath -PathType Leaf)) {
        throw "Git HEAD file was not found at '$headPath'."
    }
    $headReference = (Get-Content -LiteralPath $headPath -Raw -Encoding UTF8).Trim()
    $headPrefix = 'ref: refs/heads/'
    if (-not $headReference.StartsWith($headPrefix, [System.StringComparison]::Ordinal)) {
        throw "Guest workspace has a detached HEAD: '$headReference'."
    }
    $currentBranch = $headReference.Substring($headPrefix.Length)
    if ($currentBranch -ne $Branch) {
        throw "Expected branch '$Branch', but guest workspace is on '$currentBranch'."
    }

    try {
        $expectedAudit = $AuditJson | ConvertFrom-Json
    } catch {
        throw "DELIVERY_AUDIT_REQUIRED: ExpectedAuditJson was invalid: $($_.Exception.Message)"
    }
    if (
        $null -eq $expectedAudit -or
        $expectedAudit.version -ne 1 -or
        -not [bool]$expectedAudit.ready -or
        -not [bool]$expectedAudit.exact -or
        -not [bool]$expectedAudit.safeForDeliveryRetry -or
        -not [bool]$expectedAudit.completeFileSet
    ) {
        throw 'DELIVERY_AUDIT_REQUIRED: exact safe delivery audit was missing or unsafe.'
    }
    $currentHead = (Invoke-Git @('rev-parse', 'HEAD') | Select-Object -Last 1).ToString().Trim()
    if ($currentHead -ne [string]$expectedAudit.head) {
        throw "DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: HEAD changed from '$($expectedAudit.head)' to '$currentHead'."
    }
    $expectedFiles = @($expectedAudit.files)
    $expectedPathSet = New-Object 'System.Collections.Generic.HashSet[string]' (
        [System.StringComparer]::Ordinal
    )
    foreach ($expected in $expectedFiles) {
        $expectedPath = ConvertTo-SafeGitPath ([string]$expected.path)
        $expectedCode = [string]$expected.code
        if (
            $null -ne $expected.unsafeReason -or
            $expectedCode -notmatch '^[ MA]{2}$' -or
            $expectedCode -notmatch '[MA]'
        ) {
            throw "DELIVERY_AUDIT_REQUIRED: audited path '$expectedPath' had an unsafe status."
        }
        if (-not $expectedPathSet.Add($expectedPath)) {
            throw "DELIVERY_AUDIT_REQUIRED: duplicate audited path '$expectedPath'."
        }
    }

    $statusBefore = @(Get-WorkspaceStatusRecords)
    $alreadyCommitted = $statusBefore.Count -eq 0 -and $expectedFiles.Count -gt 0
    if ($alreadyCommitted) {
        if ([string]$expectedAudit.source -eq 'workspace') {
            throw 'DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: workspace changes disappeared before finalization.'
        }
    } else {
        Assert-ExactAuditedWorkspace $expectedFiles $false
    }

    # Set identity on the managed repository itself. This keeps delivery
    # independent from whichever Windows account happens to own the VM.
    Invoke-Git @('config', '--local', 'user.name', $AuthorName) | Out-Null
    Invoke-Git @('config', '--local', 'user.email', $AuthorEmail) | Out-Null
    if (-not $alreadyCommitted -and $expectedFiles.Count -gt 0) {
        $addArguments = [string[]](@('add', '--') + @($expectedPathSet))
        Invoke-Git $addArguments | Out-Null
        Assert-ExactAuditedWorkspace $expectedFiles $true
    }
    & git -C $ProjectPath diff --cached --quiet
    $hasChanges = $LASTEXITCODE -ne 0
    if ($hasChanges) {
        Invoke-Git @('commit', '-m', $Message) | Out-Null
    }
    $statusAfterCommit = @(Get-WorkspaceStatusRecords)
    if ($statusAfterCommit.Count -ne 0) {
        $remainingPaths = @($statusAfterCommit | ForEach-Object { [string]$_.path })
        throw "DELIVERY_WORKSPACE_CHANGED_AFTER_AUDIT: workspace changed during commit: $([string]::Join(', ', $remainingPaths))."
    }
    $localSha = (Invoke-Git @('rev-parse', 'HEAD') | Select-Object -Last 1).ToString().Trim()
    Invoke-Git @('push', '--set-upstream', 'origin', $Branch) | Out-Null
    $remoteLine = (Invoke-Git @('ls-remote', 'origin', "refs/heads/$Branch") | Select-Object -Last 1).ToString().Trim()
    $remoteSha = ($remoteLine -split '\s+')[0]
    if ([string]::IsNullOrWhiteSpace($remoteSha) -or $remoteSha -ne $localSha) {
        throw "Remote verification failed. Local SHA '$localSha'; remote SHA '$remoteSha'."
    }
    [pscustomobject]@{
        commitSha = $localSha
        remoteSha = $remoteSha
        pushed = $true
        verified = $true
        hadChanges = $hasChanges
    }
}

$result | ConvertTo-Json -Compress
