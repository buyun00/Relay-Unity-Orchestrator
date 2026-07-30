[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ExpectedBranch,
    [AllowNull()][string]$ExpectedHead,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ChangedFilesJson,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ValidationJson,
    [AllowNull()][string]$ExpectedAuditJson,
    [switch]$OutputJson
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

if (-not (Get-Command Invoke-RelayGit -CommandType Function -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Workspace-Git.ps1')
}

function ConvertFrom-RequiredStringArray {
    param(
        [Parameter(Mandatory = $true)][string]$Json,
        [Parameter(Mandatory = $true)][string]$Label,
        [switch]$NormalizePaths
    )

    try {
        $decoded = $Json | ConvertFrom-Json
    } catch {
        throw "$Label was not valid JSON: $($_.Exception.Message)"
    }
    if ($null -eq $decoded) {
        return ,([string[]]@())
    }
    $values = New-Object System.Collections.Generic.List[string]
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' (
        [System.StringComparer]::Ordinal
    )
    foreach ($item in @($decoded)) {
        if ($item -isnot [string] -or [string]::IsNullOrWhiteSpace($item)) {
            throw "$Label must contain only non-empty strings."
        }
        $value = if ($NormalizePaths) {
            ConvertTo-RelayGitPath $item
        } else {
            [string]$item
        }
        if (-not $seen.Add($value)) {
            throw "$Label contained duplicate value '$value'."
        }
        $values.Add($value)
    }
    return ,([string[]]$values.ToArray())
}

function ConvertFrom-ExpectedAudit {
    param([AllowNull()][string]$Json)

    if ([string]::IsNullOrWhiteSpace($Json)) {
        return $null
    }
    try {
        $decoded = $Json | ConvertFrom-Json
    } catch {
        throw "ExpectedAuditJson was not valid JSON: $($_.Exception.Message)"
    }
    if ($null -eq $decoded -or $decoded -isnot [psobject] -or $decoded -is [array]) {
        throw 'ExpectedAuditJson must contain one JSON object.'
    }
    return $decoded
}

function Get-OrdinalSortedStrings {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]]$Values
    )

    $copy = [string[]]@($Values)
    [Array]::Sort($copy, [System.StringComparer]::Ordinal)
    return ,$copy
}

function Test-ExactStringArray {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]]$Left,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]]$Right
    )

    if ($Left.Count -ne $Right.Count) {
        return $false
    }
    for ($index = 0; $index -lt $Left.Count; $index += 1) {
        if (-not [string]::Equals(
            $Left[$index],
            $Right[$index],
            [System.StringComparison]::Ordinal
        )) {
            return $false
        }
    }
    return $true
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

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

function Get-DeliveryAuditFingerprint {
    param(
        [Parameter(Mandatory = $true)][string]$Branch,
        [Parameter(Mandatory = $true)][string]$Head,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]]$ChangedFiles,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]]$Validation,
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Files
    )

    $records = New-Object System.Collections.Generic.List[string]
    foreach ($file in $Files) {
        $records.Add(
            ([string]$file.code) + [char]0 +
            ([string]$file.originalPath) + [char]0 +
            ([string]$file.path) + [char]0 +
            ([string]$file.gitBlob).ToLowerInvariant() + [char]0 +
            ([string]$file.sha256).ToLowerInvariant()
        )
    }
    $sortedRecords = Get-OrdinalSortedStrings -Values $records.ToArray()
    $sortedChanged = Get-OrdinalSortedStrings -Values $ChangedFiles
    $payload = @(
        'relay-delivery-audit-v1',
        $Branch,
        $Head.ToLowerInvariant(),
        [string]::Join([char]0, $sortedChanged),
        [string]::Join([char]0, $Validation),
        [string]::Join([char]0, $sortedRecords)
    ) -join [char]0
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($payload)
        return ([BitConverter]::ToString(
            $sha256.ComputeHash($bytes)
        )).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

function Complete-DeliveryAudit {
    param([Parameter(Mandatory = $true)][object]$Result)

    if ($OutputJson) {
        return ($Result | ConvertTo-Json -Depth 16 -Compress)
    }
    return $Result
}

function New-DeliveryAuditRefusal {
    param(
        [Parameter(Mandatory = $true)][string]$Code,
        [Parameter(Mandatory = $true)][string]$Message,
        [AllowNull()][string]$Branch,
        [AllowNull()][string]$Head,
        [AllowNull()][AllowEmptyCollection()][object[]]$Files = @(),
        [AllowNull()][AllowEmptyCollection()][string[]]$BlockedPaths = @(),
        [AllowNull()][string]$Fingerprint = $null
    )

    return [pscustomobject]@{
        version = 1
        ready = $false
        exact = $false
        safeForDeliveryRetry = $false
        code = $Code
        message = $Message
        projectPath = $ProjectPath
        branch = $Branch
        head = $Head
        expectedBranch = $ExpectedBranch
        expectedHead = $ExpectedHead
        changedFiles = [string[]]@($script:changedFiles)
        validation = [string[]]@($script:validation)
        files = [object[]]@($Files)
        blockedPaths = [string[]]@($BlockedPaths)
        fingerprint = $Fingerprint
    }
}

$script:changedFiles = ConvertFrom-RequiredStringArray `
    -Json $ChangedFilesJson `
    -Label 'ChangedFilesJson' `
    -NormalizePaths
$script:validation = ConvertFrom-RequiredStringArray `
    -Json $ValidationJson `
    -Label 'ValidationJson'
$expectedAudit = ConvertFrom-ExpectedAudit -Json $ExpectedAuditJson

if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) {
    return (Complete-DeliveryAudit (New-DeliveryAuditRefusal `
        -Code 'DELIVERY_RETRY_WORKSPACE_NOT_FOUND' `
        -Message "Delivery workspace was not found at '$ProjectPath'." `
        -Branch $null `
        -Head $null))
}
if (-not (Test-Path -LiteralPath (Join-Path $ProjectPath '.git'))) {
    return (Complete-DeliveryAudit (New-DeliveryAuditRefusal `
        -Code 'DELIVERY_RETRY_REPOSITORY_NOT_FOUND' `
        -Message "Git metadata was not found at '$ProjectPath'." `
        -Branch $null `
        -Head $null))
}

$branch = Get-RelayGitValue $ProjectPath @('branch', '--show-current')
$head = Get-RelayGitValue $ProjectPath @('rev-parse', '--verify', 'HEAD')
if ([string]::IsNullOrWhiteSpace($branch)) {
    return (Complete-DeliveryAudit (New-DeliveryAuditRefusal `
        -Code 'DELIVERY_RETRY_DETACHED_HEAD' `
        -Message 'Delivery workspace has a detached HEAD.' `
        -Branch $null `
        -Head $head))
}
if ($branch -ne $ExpectedBranch) {
    return (Complete-DeliveryAudit (New-DeliveryAuditRefusal `
        -Code 'DELIVERY_RETRY_BRANCH_MISMATCH' `
        -Message "Expected delivery branch '$ExpectedBranch', but found '$branch'." `
        -Branch $branch `
        -Head $head))
}
if (
    -not [string]::IsNullOrWhiteSpace($ExpectedHead) -and
    $head -ne $ExpectedHead
) {
    return (Complete-DeliveryAudit (New-DeliveryAuditRefusal `
        -Code 'DELIVERY_RETRY_HEAD_MISMATCH' `
        -Message "Expected delivery HEAD '$ExpectedHead', but found '$head'." `
        -Branch $branch `
        -Head $head))
}

$status = @(Get-RelayWorkspaceStatus $ProjectPath)
$files = New-Object System.Collections.Generic.List[object]
$blocked = New-Object System.Collections.Generic.List[string]
$actualPaths = New-Object System.Collections.Generic.List[string]
foreach ($entry in $status) {
    $statusPath = ConvertTo-RelayGitPath ([string]$entry.path)
    $actualPaths.Add($statusPath)
    $absolutePath = [System.IO.Path]::GetFullPath(
        (Join-Path $ProjectPath $statusPath)
    )
    $exists = Test-Path -LiteralPath $absolutePath -PathType Leaf
    $gitBlob = if ($exists) {
        Get-RelayPathBlob $ProjectPath $statusPath
    } else {
        ''
    }
    $sha256 = if ($exists) {
        Get-FileSha256 -LiteralPath $absolutePath
    } else {
        ''
    }
    $code = [string]$entry.code
    $unsafeReason = $null
    if ($code -eq '??') {
        $unsafeReason = 'untracked'
    } elseif ($code.Contains('D')) {
        $unsafeReason = 'deleted'
    } elseif (
        $code.Contains('R') -or
        $code.Contains('C') -or
        -not [string]::IsNullOrWhiteSpace([string]$entry.originalPath)
    ) {
        $unsafeReason = 'renamed-or-copied'
    } elseif ($code -notmatch '^[ MATAU]{2}$' -or $code -notmatch '[MA]') {
        $unsafeReason = 'unsupported-status'
    } elseif (-not $exists) {
        $unsafeReason = 'missing'
    }
    if ($null -ne $unsafeReason) {
        $blocked.Add($statusPath)
    }
    $files.Add([pscustomobject]@{
        code = $code
        path = $statusPath
        originalPath = if ($null -eq $entry.originalPath) {
            $null
        } else {
            ConvertTo-RelayGitPath ([string]$entry.originalPath)
        }
        gitBlob = ([string]$gitBlob).ToLowerInvariant()
        sha256 = ([string]$sha256).ToLowerInvariant()
        unsafeReason = $unsafeReason
    })
}

$sortedExpectedPaths = Get-OrdinalSortedStrings -Values $script:changedFiles
$sortedActualPaths = Get-OrdinalSortedStrings -Values $actualPaths.ToArray()
$completeFileSet = Test-ExactStringArray `
    -Left $sortedExpectedPaths `
    -Right $sortedActualPaths
if (-not $completeFileSet) {
    foreach ($candidate in @($sortedExpectedPaths + $sortedActualPaths)) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $blocked.Add($candidate)
        }
    }
}
$blockedPaths = Get-OrdinalSortedStrings -Values @(
    $blocked.ToArray() | Select-Object -Unique
)
$fingerprint = Get-DeliveryAuditFingerprint `
    -Branch $branch `
    -Head $head `
    -ChangedFiles $script:changedFiles `
    -Validation $script:validation `
    -Files $files.ToArray()
$safeForRetry = $completeFileSet -and $blockedPaths.Count -eq 0

$currentAudit = [pscustomobject]@{
    version = 1
    ready = $true
    exact = $null -eq $expectedAudit
    safeForDeliveryRetry = $safeForRetry
    code = $null
    message = if ($safeForRetry) {
        "Recorded an exact delivery audit for $($files.Count) modified tracked file(s)."
    } else {
        'Recorded delivery state, but it is not eligible for delivery-only retry.'
    }
    projectPath = $ProjectPath
    branch = $branch
    head = $head
    expectedBranch = $ExpectedBranch
    expectedHead = $ExpectedHead
    completeFileSet = $completeFileSet
    changedFiles = [string[]]@($script:changedFiles)
    validation = [string[]]@($script:validation)
    files = [object[]]$files.ToArray()
    blockedPaths = [string[]]@($blockedPaths)
    fingerprint = $fingerprint
}
if ($null -eq $expectedAudit) {
    return (Complete-DeliveryAudit $currentAudit)
}

if (
    $expectedAudit.version -ne 1 -or
    -not [bool]$expectedAudit.safeForDeliveryRetry -or
    [string]::IsNullOrWhiteSpace([string]$expectedAudit.fingerprint)
) {
    return (Complete-DeliveryAudit (New-DeliveryAuditRefusal `
        -Code 'DELIVERY_RETRY_AUDIT_UNSAFE' `
        -Message 'The recorded delivery audit was missing, invalid, or not marked safe for delivery-only retry.' `
        -Branch $branch `
        -Head $head `
        -Files $files.ToArray() `
        -BlockedPaths $blockedPaths `
        -Fingerprint $fingerprint))
}
if (
    -not $safeForRetry -or
    $fingerprint -ne [string]$expectedAudit.fingerprint
) {
    $mismatchPaths = Get-OrdinalSortedStrings -Values @(
        @($blockedPaths) +
        @($script:changedFiles) +
        @($files.ToArray() | ForEach-Object { [string]$_.path }) |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Select-Object -Unique
    )
    return (Complete-DeliveryAudit (New-DeliveryAuditRefusal `
        -Code 'DELIVERY_RETRY_AUDIT_MISMATCH' `
        -Message 'The delivery workspace no longer matches the exact recorded branch, HEAD, file set, hashes, statuses, and validation output.' `
        -Branch $branch `
        -Head $head `
        -Files $files.ToArray() `
        -BlockedPaths $mismatchPaths `
        -Fingerprint $fingerprint))
}

$currentAudit.exact = $true
$currentAudit.message = 'The delivery workspace exactly matches its recorded delivery audit.'
Complete-DeliveryAudit $currentAudit
