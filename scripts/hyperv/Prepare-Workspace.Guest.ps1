[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RepositoryUrl,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Base,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Branch,
    [Parameter(Mandatory = $true)][ValidateSet('new', 'resume')][string]$RequestedMode,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$AuthorName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$AuthorEmail,
    [switch]$OutputJson
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$env:GCM_INTERACTIVE = '0'

function Invoke-Git([string[]]$Arguments) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Git Credential Manager may write non-fatal provider warnings to
        # stderr. PowerShell 5 converts those lines to ErrorRecord objects,
        # so judge success by Git's exit code instead.
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

function Test-GitReference([string]$Reference) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & git -C $ProjectPath show-ref --verify --quiet $Reference 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -eq 0) { return $true }
    if ($exitCode -eq 1) { return $false }
    throw "git show-ref --verify --quiet $Reference failed: $($output -join [Environment]::NewLine)"
}

function Get-GitValue([string[]]$Arguments) {
    $lines = @(Invoke-Git $Arguments)
    if ($lines.Count -eq 0) { return '' }
    return $lines[-1].ToString().Trim()
}

function ConvertFrom-PorcelainStatus([string]$RawStatus) {
    $records = @($RawStatus -split [char]0)
    $entries = New-Object System.Collections.Generic.List[object]
    for ($index = 0; $index -lt $records.Count; $index += 1) {
        $record = $records[$index]
        if ([string]::IsNullOrEmpty($record)) { continue }
        if ($record.Length -lt 4 -or $record[2] -ne ' ') {
            throw "Unexpected Git porcelain status record: '$record'"
        }
        $statusCode = $record.Substring(0, 2)
        $statusPath = $record.Substring(3)
        $originalPath = $null
        if (@('R', 'C') -contains $statusCode[0] -or @('R', 'C') -contains $statusCode[1]) {
            $index += 1
            if ($index -ge $records.Count -or [string]::IsNullOrEmpty($records[$index])) {
                throw "Git porcelain rename/copy record for '$statusPath' did not include its original path."
            }
            $originalPath = $records[$index]
        }
        $entries.Add([pscustomobject]@{
            code = $statusCode
            path = $statusPath
            originalPath = $originalPath
        })
    }
    return $entries.ToArray()
}

function Get-WorkspaceStatus {
    $rawStatus = (Invoke-Git @(
        'status', '--porcelain=v1', '-z', '--untracked-files=all'
    )) -join ''
    return @(ConvertFrom-PorcelainStatus $rawStatus)
}

function Get-NulSeparatedPaths([string[]]$Arguments) {
    $rawPaths = (Invoke-Git $Arguments) -join ''
    if ([string]::IsNullOrEmpty($rawPaths)) { return @() }
    return @($rawPaths -split [char]0 | Where-Object { -not [string]::IsNullOrEmpty($_) })
}

function Get-ProhibitedPathCategories([string]$StatusPath) {
    $normalized = $StatusPath.Replace('\', '/')
    $leaf = [System.IO.Path]::GetFileName($normalized)
    $categories = New-Object System.Collections.Generic.List[string]

    $isEnvironmentSecret = (
        $leaf -match '^\.env(?:\.|$)' -and
        $leaf -notmatch '^\.env\.(?:example|sample|template)$'
    ) -or $leaf -match '^(?:\.envrc|\.npmrc|\.pypirc|\.netrc|\.git-credentials)$'
    $isKeyMaterial = $leaf -match '\.(?:pem|key|pfx|p12|jks|keystore|kdbx|ovpn)$' -or
        $leaf -match '^(?:id_rsa|id_ed25519|credentials?|secrets?|tokens?|passwords?|service-account)(?:\..+)?$' -or
        $normalized -match '(^|/)(?:\.?secrets?|credentials?)(/|$)'
    if ($isEnvironmentSecret -or $isKeyMaterial) {
        $categories.Add('sensitive')
    }

    if ($leaf -match '\.(?:log|trace)$' -or $normalized -match '(^|/)logs?(/|$)') {
        $categories.Add('log')
    }
    if ($normalized -match '(^|/)(?:Library|Temp|Obj|Cache|Caches|\.cache|node_modules|\.pnpm-store|\.gradle|\.vs)(/|$)') {
        $categories.Add('cache')
    }
    if ($normalized -match '(^|/)(?:Build|Builds|dist|out|bin|artifacts?|coverage)(/|$)' -or
        $leaf -match '\.(?:dll|exe|pdb|so|dylib|apk|aab|ipa|unitypackage|zip|7z)$') {
        $categories.Add('build')
    }
    return $categories.ToArray()
}

function Complete-Result([object]$Result) {
    if ($OutputJson) {
        return ($Result | ConvertTo-Json -Depth 12 -Compress)
    }
    return $Result
}

function New-RefusalResult(
    [string]$Code,
    [string]$Message,
    [object[]]$Status,
    [string[]]$BlockedPaths,
    [string[]]$DeletionPaths,
    [object[]]$ProhibitedPaths,
    [object[]]$UnsupportedChanges,
    [string]$OriginalBranch,
    [string]$OriginalHead,
    [string]$PreservedBranch = $null,
    [string]$PreservedCommit = $null
) {
    return [pscustomobject]@{
        ready = $false
        code = $Code
        message = $Message
        projectPath = $ProjectPath
        originalBranch = $OriginalBranch
        originalHead = $OriginalHead
        statusBefore = @($Status)
        blockedPaths = @($BlockedPaths)
        deletionPaths = @($DeletionPaths)
        prohibitedPaths = @($ProhibitedPaths)
        unsupportedChanges = @($UnsupportedChanges)
        preservedBranch = $PreservedBranch
        preservedCommit = $PreservedCommit
    }
}

$usesUnencryptedHttp = $RepositoryUrl -match '^http://'
if ($usesUnencryptedHttp) {
    # This project is hosted on an isolated GitLab that does not expose HTTPS.
    # Limit the GCM opt-in to this process and this repository.
    $env:GCM_ALLOW_UNSAFE_REMOTES = 'true'
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectPath '.git'))) {
    $parent = Split-Path -Parent $ProjectPath
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $cloneOutput = & git clone -- $RepositoryUrl $ProjectPath 2>&1
        $cloneExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($cloneExitCode -ne 0) {
        throw "git clone failed: $($cloneOutput -join [Environment]::NewLine)"
    }
}

# Capture the guest workspace before any checkout or branch creation. Repository
# configuration and fetches do not alter the index or working tree, but unsafe
# content is preserved or refused before either of them is attempted.
$originalBranch = Get-GitValue @('branch', '--show-current')
$originalHead = Get-GitValue @('rev-parse', '--verify', 'HEAD')
$statusBefore = @(Get-WorkspaceStatus)

if ($usesUnencryptedHttp) {
    Invoke-Git @('config', '--local', 'credential.allowUnsafeRemotes', 'true') | Out-Null
}
Invoke-Git @('config', '--local', 'user.name', $AuthorName) | Out-Null
Invoke-Git @('config', '--local', 'user.email', $AuthorEmail) | Out-Null

$deletionPaths = New-Object System.Collections.Generic.List[string]
$prohibitedPaths = New-Object System.Collections.Generic.List[object]
$unsupportedChanges = New-Object System.Collections.Generic.List[object]
$blockedPaths = New-Object System.Collections.Generic.List[string]

foreach ($entry in $statusBefore) {
    $entryPaths = @($entry.path)
    if (-not [string]::IsNullOrWhiteSpace($entry.originalPath)) {
        $entryPaths += $entry.originalPath
    }
    if ($entry.code.Contains('D')) {
        foreach ($statusPath in $entryPaths) {
            $deletionPaths.Add($statusPath)
            $blockedPaths.Add($statusPath)
        }
    }

    $unmergedStatuses = @('DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU')
    $allowedStatus = $entry.code -eq '??' -or (
        $unmergedStatuses -notcontains $entry.code -and
        $entry.code -match '^[ MA][ MA]$' -and
        $entry.code.Trim().Length -gt 0
    )
    if (-not $allowedStatus) {
        $unsupportedChanges.Add($entry)
        foreach ($statusPath in $entryPaths) {
            $blockedPaths.Add($statusPath)
        }
    }

    foreach ($statusPath in $entryPaths) {
        $categories = @(Get-ProhibitedPathCategories $statusPath)
        if ($categories.Count -gt 0) {
            $prohibitedPaths.Add([pscustomobject]@{
                path = $statusPath
                categories = $categories
            })
            $blockedPaths.Add($statusPath)
        }
    }
}

if ($deletionPaths.Count -gt 0 -or $prohibitedPaths.Count -gt 0 -or $unsupportedChanges.Count -gt 0) {
    $blocked = @($blockedPaths.ToArray() | Sort-Object -Unique)
    $reasons = New-Object System.Collections.Generic.List[string]
    if ($deletionPaths.Count -gt 0) { $reasons.Add('deletion status') }
    if ($prohibitedPaths.Count -gt 0) { $reasons.Add('sensitive/log/cache/build path') }
    if ($unsupportedChanges.Count -gt 0) { $reasons.Add('unsupported Git status') }
    $refusalArguments = @{
        Code = 'WORKSPACE_UNSAFE_CHANGES'
        Message = "Workspace checkout refused because $($reasons -join ', ') was detected: $($blocked -join ', ')"
        Status = $statusBefore
        BlockedPaths = $blocked
        DeletionPaths = @($deletionPaths.ToArray())
        ProhibitedPaths = @($prohibitedPaths.ToArray())
        UnsupportedChanges = @($unsupportedChanges.ToArray())
        OriginalBranch = $originalBranch
        OriginalHead = $originalHead
    }
    return (Complete-Result (New-RefusalResult @refusalArguments))
}

$allowedPaths = @($statusBefore | ForEach-Object { $_.path } | Sort-Object -Unique)
if ([string]::IsNullOrWhiteSpace($originalBranch) -and $allowedPaths.Count -eq 0) {
    $refusalArguments = @{
        Code = 'WORKSPACE_DETACHED_HEAD'
        Message = "Workspace checkout refused because HEAD '$originalHead' is detached and has no preserving branch."
        Status = $statusBefore
        BlockedPaths = @()
        DeletionPaths = @()
        ProhibitedPaths = @()
        UnsupportedChanges = @()
        OriginalBranch = $originalBranch
        OriginalHead = $originalHead
    }
    return (Complete-Result (New-RefusalResult @refusalArguments))
}
$originalBlobs = @{}
$projectRoot = [System.IO.Path]::GetFullPath($ProjectPath).TrimEnd('\', '/') +
    [System.IO.Path]::DirectorySeparatorChar
foreach ($statusPath in $allowedPaths) {
    $absolutePath = [System.IO.Path]::GetFullPath((Join-Path $ProjectPath $statusPath))
    if (-not $absolutePath.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [System.IO.File]::Exists($absolutePath)) {
        $refusalArguments = @{
            Code = 'WORKSPACE_UNSUPPORTED_CHANGES'
            Message = "Workspace checkout refused because '$statusPath' is not a regular project file."
            Status = $statusBefore
            BlockedPaths = @($statusPath)
            DeletionPaths = @()
            ProhibitedPaths = @()
            UnsupportedChanges = @([pscustomobject]@{ code = 'NON_FILE'; path = $statusPath })
            OriginalBranch = $originalBranch
            OriginalHead = $originalHead
        }
        return (Complete-Result (New-RefusalResult @refusalArguments))
    }
    $originalBlobs[$statusPath] = Get-GitValue @(
        'hash-object', "--path=$statusPath", '--', $statusPath
    )
}

$preservedBranch = $null
$preservedCommit = $null
$preservedFiles = @()
if ($allowedPaths.Count -gt 0) {
    $taskPart = ($Branch -replace '[^A-Za-z0-9._-]+', '-').Trim('-', '.')
    if ([string]::IsNullOrWhiteSpace($taskPart)) { $taskPart = 'task' }
    if ($taskPart.Length -gt 80) {
        $taskPart = $taskPart.Substring(0, 80).TrimEnd('-', '.')
    }
    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $preservedBranch = "relay/preserved/$taskPart-$timestamp"
    $collision = 0
    while (Test-GitReference "refs/heads/$preservedBranch") {
        $collision += 1
        $preservedBranch = "relay/preserved/$taskPart-$timestamp-$collision"
    }
    Invoke-Git @('check-ref-format', '--branch', $preservedBranch) | Out-Null
    Invoke-Git @('checkout', '-b', $preservedBranch) | Out-Null

    Invoke-Git (@('--literal-pathspecs', 'add', '--') + $allowedPaths) | Out-Null
    $stagedPaths = @(Get-NulSeparatedPaths @(
        'diff', '--cached', '--name-only', '-z'
    ))
    $stagedDeletions = @(Get-NulSeparatedPaths @(
        'diff', '--cached', '--diff-filter=D', '--name-only', '-z'
    ))
    $expectedSorted = @($allowedPaths | Sort-Object)
    $stagedSorted = @($stagedPaths | Sort-Object)
    $pathDifferences = @(Compare-Object -ReferenceObject $expectedSorted -DifferenceObject $stagedSorted)
    if ($pathDifferences.Count -gt 0 -or $stagedDeletions.Count -gt 0) {
        $unexpected = @($stagedPaths + $stagedDeletions | Sort-Object -Unique)
        $refusalArguments = @{
            Code = 'WORKSPACE_PRESERVATION_MISMATCH'
            Message = "Workspace preservation stopped because the staged paths did not exactly match the safe status snapshot: $($unexpected -join ', ')"
            Status = $statusBefore
            BlockedPaths = $unexpected
            DeletionPaths = $stagedDeletions
            ProhibitedPaths = @()
            UnsupportedChanges = @()
            OriginalBranch = $originalBranch
            OriginalHead = $originalHead
            PreservedBranch = $preservedBranch
        }
        return (Complete-Result (New-RefusalResult @refusalArguments))
    }

    foreach ($statusPath in $allowedPaths) {
        $currentBlob = Get-GitValue @(
            'hash-object', "--path=$statusPath", '--', $statusPath
        )
        if ($currentBlob -ne $originalBlobs[$statusPath]) {
            $refusalArguments = @{
                Code = 'WORKSPACE_CHANGED_DURING_PRESERVATION'
                Message = "Workspace preservation stopped because '$statusPath' changed after the status snapshot."
                Status = $statusBefore
                BlockedPaths = @($statusPath)
                DeletionPaths = @()
                ProhibitedPaths = @()
                UnsupportedChanges = @()
                OriginalBranch = $originalBranch
                OriginalHead = $originalHead
                PreservedBranch = $preservedBranch
            }
            return (Complete-Result (New-RefusalResult @refusalArguments))
        }
    }

    Invoke-Git @(
        'commit', '--no-verify', '--no-gpg-sign',
        '-m', "chore(relay): preserve workspace before $Branch"
    ) | Out-Null
    $preservedCommit = Get-GitValue @('rev-parse', 'HEAD')
    Invoke-Git @('cat-file', '-e', "$preservedCommit^{commit}") | Out-Null
    $branchCommit = Get-GitValue @('rev-parse', "refs/heads/$preservedBranch")
    if ($branchCommit -ne $preservedCommit) {
        throw "Preserved branch '$preservedBranch' did not resolve to '$preservedCommit'."
    }
    $preservedDeletions = @(Get-NulSeparatedPaths @(
        'diff-tree', '--no-commit-id', '--diff-filter=D', '--name-only', '-r', '-z',
        $preservedCommit
    ))
    if ($preservedDeletions.Count -gt 0) {
        throw "Preserved commit unexpectedly contains deletions: $($preservedDeletions -join ', ')"
    }
    foreach ($statusPath in $allowedPaths) {
        $commitPath = $preservedCommit + ':' + $statusPath
        $commitBlob = Get-GitValue @('rev-parse', $commitPath)
        if ($commitBlob -ne $originalBlobs[$statusPath]) {
            throw "Preserved commit content verification failed for '$statusPath'."
        }
        $preservedFiles += [pscustomobject]@{
            path = $statusPath
            blob = $commitBlob
        }
    }
    $postPreservationStatus = @(Get-WorkspaceStatus)
    if ($postPreservationStatus.Count -gt 0) {
        $changedPaths = @($postPreservationStatus | ForEach-Object { $_.path } | Sort-Object -Unique)
        $refusalArguments = @{
            Code = 'WORKSPACE_CHANGED_DURING_PRESERVATION'
            Message = "Workspace preservation committed the original snapshot, but new changes appeared before checkout: $($changedPaths -join ', ')"
            Status = $statusBefore
            BlockedPaths = $changedPaths
            DeletionPaths = @()
            ProhibitedPaths = @()
            UnsupportedChanges = @($postPreservationStatus)
            OriginalBranch = $originalBranch
            OriginalHead = $originalHead
            PreservedBranch = $preservedBranch
            PreservedCommit = $preservedCommit
        }
        return (Complete-Result (New-RefusalResult @refusalArguments))
    }
}

Invoke-Git @('remote', 'set-url', 'origin', $RepositoryUrl) | Out-Null
Invoke-Git @('fetch', 'origin') | Out-Null

$taskRemoteExists = Test-GitReference "refs/remotes/origin/$Branch"
$source = if ($preservedCommit) {
    "origin/$Base"
} elseif ($taskRemoteExists) {
    "origin/$Branch"
} else {
    "origin/$Base"
}
$sourceHead = Get-GitValue @('rev-parse', '--verify', $source)
$localTaskExists = Test-GitReference "refs/heads/$Branch"
if ($localTaskExists) {
    $localTaskHead = Get-GitValue @('rev-parse', "refs/heads/$Branch")
    if ($localTaskHead -ne $sourceHead) {
        $refusalArguments = @{
            Code = 'WORKSPACE_TARGET_BRANCH_CONFLICT'
            Message = "Target branch '$Branch' already exists at '$localTaskHead' and was not overwritten with '$sourceHead'."
            Status = $statusBefore
            BlockedPaths = @()
            DeletionPaths = @()
            ProhibitedPaths = @()
            UnsupportedChanges = @()
            OriginalBranch = $originalBranch
            OriginalHead = $originalHead
            PreservedBranch = $preservedBranch
            PreservedCommit = $preservedCommit
        }
        return (Complete-Result (New-RefusalResult @refusalArguments))
    }
    Invoke-Git @('checkout', $Branch) | Out-Null
} else {
    Invoke-Git @('checkout', '-b', $Branch, $source) | Out-Null
}

$head = Get-GitValue @('rev-parse', 'HEAD')
$checkedOutBranch = Get-GitValue @('branch', '--show-current')
if ($checkedOutBranch -ne $Branch -or $head -ne $sourceHead) {
    throw "Target checkout verification failed: branch '$checkedOutBranch' at '$head', expected '$Branch' at '$sourceHead'."
}
$statusAfter = @(Get-WorkspaceStatus)
if ($statusAfter.Count -gt 0) {
    $changedPaths = @($statusAfter | ForEach-Object { $_.path } | Sort-Object -Unique)
    $refusalArguments = @{
        Code = 'WORKSPACE_TARGET_NOT_CLEAN'
        Message = "Target branch checkout completed, but the workspace changed during preparation: $($changedPaths -join ', ')"
        Status = $statusBefore
        BlockedPaths = $changedPaths
        DeletionPaths = @()
        ProhibitedPaths = @()
        UnsupportedChanges = @($statusAfter)
        OriginalBranch = $originalBranch
        OriginalHead = $originalHead
        PreservedBranch = $preservedBranch
        PreservedCommit = $preservedCommit
    }
    return (Complete-Result (New-RefusalResult @refusalArguments))
}

$result = [pscustomobject]@{
    ready = $true
    projectPath = $ProjectPath
    branch = $Branch
    source = $source
    head = $head
    mode = $RequestedMode
    remoteBranchExisted = $taskRemoteExists
    originalBranch = $originalBranch
    originalHead = $originalHead
    statusBefore = $statusBefore
    preservedBranch = $preservedBranch
    preservedCommit = $preservedCommit
    preservedFiles = $preservedFiles
}
Complete-Result $result
