[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RepositoryUrl,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Base,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Branch,
    [Parameter(Mandatory = $true)][ValidateSet('new', 'resume', 'recovery')][string]$RequestedMode,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$AuthorName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$AuthorEmail,
    [switch]$OutputJson
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$env:GCM_INTERACTIVE = '0'
$script:porcelainV2Before = @()
$script:untrackedFilesBefore = @()
$script:preservedTree = $null
$script:preservedNameStatus = @()
$script:preservationVerified = $false
$script:preTargetCheckoutBranch = $null
$script:preTargetCheckoutHead = $null

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
        porcelainV2Before = @($script:porcelainV2Before)
        untrackedFilesBefore = @($script:untrackedFilesBefore)
        blockedPaths = @($BlockedPaths)
        deletionPaths = @($DeletionPaths)
        prohibitedPaths = @($ProhibitedPaths)
        unsupportedChanges = @($UnsupportedChanges)
        preservedBranch = $PreservedBranch
        preservedCommit = $PreservedCommit
        preservedTree = $script:preservedTree
        preservedNameStatus = @($script:preservedNameStatus)
        preservationVerified = $script:preservationVerified
        preTargetCheckoutBranch = $script:preTargetCheckoutBranch
        preTargetCheckoutHead = $script:preTargetCheckoutHead
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
$script:porcelainV2Before = @(
    Invoke-Git @(
        'status', '--porcelain=v2', '--branch', '--untracked-files=all'
    ) | ForEach-Object { $_.ToString() }
)
$script:untrackedFilesBefore = @(
    Get-NulSeparatedPaths @(
        'ls-files', '--others', '--exclude-standard', '-z'
    ) | Sort-Object
)

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
$expectedWorkspacePaths = @(
    Get-NulSeparatedPaths @(
        'ls-files', '--cached', '--others', '--exclude-standard', '-z'
    ) | Sort-Object -Unique
)
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
$shouldPreserve = $RequestedMode -eq 'recovery' -or $allowedPaths.Count -gt 0
if ($shouldPreserve) {
    $taskPart = ($Branch -replace '^codex/', '')
    $taskPart = ($taskPart -replace '[^A-Za-z0-9._-]+', '-').Trim('-', '.')
    if ([string]::IsNullOrWhiteSpace($taskPart)) { $taskPart = 'task' }
    if ($taskPart.Length -gt 64) {
        $taskPart = $taskPart.Substring(0, 64).TrimEnd('-', '.')
    }
    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $preservationNonce = [Guid]::NewGuid().ToString('N').Substring(0, 12)
    $preservedBranch = "relay/preserved/$taskPart-$timestamp-$preservationNonce"
    if (Test-GitReference "refs/heads/$preservedBranch") {
        throw "Generated preservation branch '$preservedBranch' already exists."
    }
    Invoke-Git @('check-ref-format', '--branch', $preservedBranch) | Out-Null

    $gitDirectoryValue = Get-GitValue @('rev-parse', '--git-dir')
    $gitDirectory = if ([System.IO.Path]::IsPathRooted($gitDirectoryValue)) {
        [System.IO.Path]::GetFullPath($gitDirectoryValue)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path $ProjectPath $gitDirectoryValue))
    }
    $evidenceDirectory = Join-Path $gitDirectory 'relay-preservation-indexes'
    if (-not (Test-Path -LiteralPath $evidenceDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $evidenceDirectory | Out-Null
    }
    $evidenceIndex = Join-Path $evidenceDirectory "$preservationNonce.index"
    if (Test-Path -LiteralPath $evidenceIndex) {
        throw "Generated preservation evidence index '$evidenceIndex' already exists."
    }

    $previousIndexFile = [Environment]::GetEnvironmentVariable(
        'GIT_INDEX_FILE',
        [EnvironmentVariableTarget]::Process
    )
    try {
        [Environment]::SetEnvironmentVariable(
            'GIT_INDEX_FILE',
            $evidenceIndex,
            [EnvironmentVariableTarget]::Process
        )
        Invoke-Git @('read-tree', $originalHead) | Out-Null
        Invoke-Git @('add', '--all', '--', '.') | Out-Null
        $script:preservedTree = Get-GitValue @('write-tree')
    } finally {
        [Environment]::SetEnvironmentVariable(
            'GIT_INDEX_FILE',
            $previousIndexFile,
            [EnvironmentVariableTarget]::Process
        )
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

    $preservedCommit = Get-GitValue @(
        'commit-tree', $script:preservedTree, '-p', $originalHead,
        '-m', "chore(relay): preserve workspace before $Branch"
    )
    Invoke-Git @('cat-file', '-e', "$preservedCommit^{commit}") | Out-Null
    $commitTree = Get-GitValue @('rev-parse', "$preservedCommit^{tree}")
    if ($commitTree -ne $script:preservedTree) {
        throw "Preserved commit tree '$commitTree' did not match prepared tree '$($script:preservedTree)'."
    }
    $commitParent = Get-GitValue @('rev-parse', "$preservedCommit^")
    if ($commitParent -ne $originalHead) {
        throw "Preserved commit parent '$commitParent' did not match original HEAD '$originalHead'."
    }

    $zeroObjectId = '0000000000000000000000000000000000000000'
    Invoke-Git @(
        'update-ref', '--create-reflog', "refs/heads/$preservedBranch",
        $preservedCommit, $zeroObjectId
    ) | Out-Null
    $branchCommit = Get-GitValue @('rev-parse', "refs/heads/$preservedBranch")
    if ($branchCommit -ne $preservedCommit) {
        throw "Preserved branch '$preservedBranch' did not resolve to '$preservedCommit'."
    }

    $preservedTreePaths = @(
        Get-NulSeparatedPaths @(
            'ls-tree', '-r', '--name-only', '-z', $preservedCommit
        ) | Sort-Object -Unique
    )
    $treePathDifferences = @(
        Compare-Object `
            -ReferenceObject $expectedWorkspacePaths `
            -DifferenceObject $preservedTreePaths
    )
    if ($treePathDifferences.Count -gt 0) {
        $missingPaths = @(
            $treePathDifferences |
                Where-Object { $_.SideIndicator -eq '<=' } |
                ForEach-Object { $_.InputObject }
        )
        $unexpectedPaths = @(
            $treePathDifferences |
                Where-Object { $_.SideIndicator -eq '=>' } |
                ForEach-Object { $_.InputObject }
        )
        throw "Preserved tree inventory mismatch. Missing: $($missingPaths -join ', '); unexpected: $($unexpectedPaths -join ', ')."
    }

    $nameStatusRecords = @(
        Get-NulSeparatedPaths @(
            'diff-tree', '--no-commit-id', '--name-status', '-r', '-z',
            $preservedCommit
        )
    )
    $preservedNameStatus = New-Object System.Collections.Generic.List[object]
    for ($nameIndex = 0; $nameIndex -lt $nameStatusRecords.Count; $nameIndex += 2) {
        if ($nameIndex + 1 -ge $nameStatusRecords.Count) {
            throw "Preserved commit name-status evidence ended unexpectedly at '$($nameStatusRecords[$nameIndex])'."
        }
        $preservedNameStatus.Add([pscustomobject]@{
            status = $nameStatusRecords[$nameIndex]
            path = $nameStatusRecords[$nameIndex + 1]
        })
    }
    $script:preservedNameStatus = @($preservedNameStatus.ToArray())
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

    $script:preTargetCheckoutBranch = Get-GitValue @('branch', '--show-current')
    $script:preTargetCheckoutHead = Get-GitValue @('rev-parse', '--verify', 'HEAD')
    $preTargetPorcelainV2 = @(
        Invoke-Git @(
            'status', '--porcelain=v2', '--branch', '--untracked-files=all'
        ) | ForEach-Object { $_.ToString() }
    )
    $preTargetUntrackedFiles = @(
        Get-NulSeparatedPaths @(
            'ls-files', '--others', '--exclude-standard', '-z'
        ) | Sort-Object
    )
    $statusEvidenceDifferences = @(
        Compare-Object `
            -ReferenceObject $script:porcelainV2Before `
            -DifferenceObject $preTargetPorcelainV2
    )
    $untrackedEvidenceMatches =
        $script:untrackedFilesBefore.Count -eq $preTargetUntrackedFiles.Count
    if ($untrackedEvidenceMatches) {
        for (
            $untrackedIndex = 0;
            $untrackedIndex -lt $script:untrackedFilesBefore.Count;
            $untrackedIndex += 1
        ) {
            if (
                $script:untrackedFilesBefore[$untrackedIndex] -ne
                $preTargetUntrackedFiles[$untrackedIndex]
            ) {
                $untrackedEvidenceMatches = $false
                break
            }
        }
    }
    if (
        $script:preTargetCheckoutBranch -ne $originalBranch -or
        $script:preTargetCheckoutHead -ne $originalHead -or
        $statusEvidenceDifferences.Count -gt 0 -or
        -not $untrackedEvidenceMatches
    ) {
        throw "Workspace changed before target checkout. Branch '$($script:preTargetCheckoutBranch)' at '$($script:preTargetCheckoutHead)'; expected '$originalBranch' at '$originalHead'."
    }
    $script:preservationVerified = $true
}

Invoke-Git @('remote', 'set-url', 'origin', $RepositoryUrl) | Out-Null
Invoke-Git @('fetch', 'origin') | Out-Null

$taskRemoteExists = Test-GitReference "refs/remotes/origin/$Branch"
$source = if ($RequestedMode -eq 'recovery' -or $preservedCommit) {
    "origin/$Base"
} elseif ($taskRemoteExists) {
    "origin/$Branch"
} else {
    "origin/$Base"
}
$sourceHead = Get-GitValue @('rev-parse', '--verify', $source)
$localTaskExists = Test-GitReference "refs/heads/$Branch"
if ($RequestedMode -eq 'recovery' -and $localTaskExists) {
    $localTaskHead = Get-GitValue @('rev-parse', "refs/heads/$Branch")
    $refusalArguments = @{
        Code = 'WORKSPACE_TARGET_BRANCH_EXISTS'
        Message = "Recovery target branch '$Branch' already exists at '$localTaskHead'; it was not checked out or overwritten."
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
}
if ($preservedCommit) {
    if (-not $script:preservationVerified) {
        throw "Preserved branch checkout was blocked because preservation proof is incomplete."
    }
    # The proof above guarantees that this tree exactly represents every
    # current tracked and untracked file. Align only the index first so the
    # subsequent branch switch does not overwrite the working tree.
    Invoke-Git @('read-tree', $preservedCommit) | Out-Null
    Invoke-Git @('checkout', $preservedBranch) | Out-Null
    $preservedCheckoutBranch = Get-GitValue @('branch', '--show-current')
    $preservedCheckoutHead = Get-GitValue @('rev-parse', '--verify', 'HEAD')
    $preservedCheckoutStatus = @(Get-WorkspaceStatus)
    if (
        $preservedCheckoutBranch -ne $preservedBranch -or
        $preservedCheckoutHead -ne $preservedCommit -or
        $preservedCheckoutStatus.Count -gt 0
    ) {
        throw "Preserved branch checkout proof failed at '$preservedCheckoutBranch' '$preservedCheckoutHead'; expected '$preservedBranch' '$preservedCommit'."
    }
}
if ($localTaskExists) {
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
    porcelainV2Before = $script:porcelainV2Before
    untrackedFilesBefore = $script:untrackedFilesBefore
    preservedBranch = $preservedBranch
    preservedCommit = $preservedCommit
    preservedTree = $script:preservedTree
    preservedNameStatus = $script:preservedNameStatus
    preservedFiles = $preservedFiles
    preservationVerified = $script:preservationVerified
    preTargetCheckoutBranch = $script:preTargetCheckoutBranch
    preTargetCheckoutHead = $script:preTargetCheckoutHead
}
Complete-Result $result
