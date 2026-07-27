[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RepositoryUrl,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Base,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Branch,
    [Parameter(Mandatory = $true)][ValidateSet('new', 'resume', 'recovery')][string]$RequestedMode,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$AuthorName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$AuthorEmail,
    [string]$AuditJson,
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
$script:preservedFiles = @()
$script:preservationVerified = $false
$script:preTargetCheckoutBranch = $null
$script:preTargetCheckoutHead = $null
$script:auditedFiles = @()
$script:auditFingerprint = $null
$script:reusedPreservation = $false
$script:preservationParent = $null
$script:parentVerified = $false
$script:nameStatusVerified = $false
$script:treeVerified = $false
$script:blobVerified = $false
$script:verifiedFiles = @()
$script:taskBranchCreated = $false
$script:currentBranch = $null
$script:candidateDiagnostics = $null

if (-not (Get-Command Invoke-RelayGit -CommandType Function -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Workspace-Git.ps1')
}

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [hashtable]$Environment = @{}
    )
    return (Invoke-RelayGit $ProjectPath $Arguments $Environment).stdout
}

function Test-GitReference([string]$Reference) {
    return Test-RelayGitReference $ProjectPath $Reference
}

function Get-GitValue {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [hashtable]$Environment = @{}
    )
    return Get-RelayGitValue $ProjectPath $Arguments $Environment
}

function Get-WorkspaceStatus {
    return @(Get-RelayWorkspaceStatus $ProjectPath)
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

function Get-RefusalPhase([string]$Code) {
    switch -Regex ($Code) {
        '^WORKSPACE_AUDIT_' { return 'audit-validation' }
        '^WORKSPACE_(?:UNSAFE|UNSUPPORTED|DETACHED)' { return 'workspace-safety' }
        '^WORKSPACE_PRESERVATION_AMBIGUOUS$' { return 'preservation-discovery' }
        '^WORKSPACE_CHANGED_DURING_PRESERVATION$' { return 'preservation-tree' }
        '^WORKSPACE_PRESERVATION_UNPROVEN$' { return 'preservation-proof' }
        '^WORKSPACE_CHANGED_BEFORE_TARGET_CHECKOUT$' { return 'pre-target-checkout' }
        '^WORKSPACE_TARGET_BRANCH_' { return 'target-branch-precheck' }
        '^WORKSPACE_TARGET_NOT_CLEAN$' { return 'target-checkout-verification' }
        default { return 'workspace-recovery' }
    }
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
    $phase = Get-RefusalPhase $Code
    $refusal = [pscustomobject]@{
        phase = $phase
        reason = $Code
        code = $Code
        message = $Message
    }
    return [pscustomobject]@{
        proofVersion = 1
        proven = $false
        ready = $false
        code = $Code
        message = $Message
        phase = $phase
        reason = $Code
        refusal = $refusal
        projectPath = $ProjectPath
        originalBranch = $OriginalBranch
        originalHead = $OriginalHead
        statusBefore = @($Status)
        porcelainV2Before = @($script:porcelainV2Before)
        untrackedFilesBefore = @($script:untrackedFilesBefore)
        auditedFiles = @($script:auditedFiles)
        auditFingerprint = $script:auditFingerprint
        blockedPaths = @($BlockedPaths)
        deletionPaths = @($DeletionPaths)
        prohibitedPaths = @($ProhibitedPaths)
        unsupportedChanges = @($UnsupportedChanges)
        preservedBranch = $PreservedBranch
        preservedCommit = $PreservedCommit
        preservedTree = $script:preservedTree
        preservedNameStatus = @($script:preservedNameStatus)
        preservedFiles = @($script:preservedFiles)
        candidateDiagnostics = $script:candidateDiagnostics
        reusedPreservation = $script:reusedPreservation
        preservationVerified = $script:preservationVerified
        preTargetCheckoutBranch = $script:preTargetCheckoutBranch
        preTargetCheckoutHead = $script:preTargetCheckoutHead
        auditedHead = $OriginalHead
        preservationBranch = $PreservedBranch
        preservationCommit = $PreservedCommit
        preservationParent = $script:preservationParent
        reused = $script:reusedPreservation
        parentVerified = $script:parentVerified
        nameStatusVerified = $script:nameStatusVerified
        treeVerified = $script:treeVerified
        blobVerified = $script:blobVerified
        verifiedFiles = @($script:verifiedFiles)
        statusAfter = @()
        taskBranch = $Branch
        taskBranchCreated = $script:taskBranchCreated
        currentBranch = $script:currentBranch
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

# Capture only the audited changes. The preservation tree starts at the audited
# HEAD, but baseline paths are deliberately not part of the expected diff.
function Get-AuditedFiles([object[]]$Status) {
    return @(
        foreach ($entry in $Status) {
            $normalizedPath = ConvertTo-RelayGitPath ([string]$entry.path)
            $absolutePath = [System.IO.Path]::GetFullPath(
                (Join-Path $ProjectPath $normalizedPath)
            )
            [pscustomobject]@{
                code = [string]$entry.code
                path = $normalizedPath
                originalPath = if ([string]::IsNullOrEmpty([string]$entry.originalPath)) {
                    $null
                } else {
                    ConvertTo-RelayGitPath ([string]$entry.originalPath)
                }
                auditBlob = if ([System.IO.File]::Exists($absolutePath)) {
                    Get-RelayPathBlob $ProjectPath $normalizedPath
                } else {
                    ''
                }
            }
        }
    )
}

function Test-WorkspaceMatchesAudit(
    [string]$ExpectedBranch,
    [string]$ExpectedHead,
    [string]$ExpectedFingerprint
) {
    $currentBranch = Get-GitValue @('branch', '--show-current')
    $currentHead = Get-GitValue @('rev-parse', '--verify', 'HEAD')
    $currentStatus = @(Get-WorkspaceStatus)
    $currentFiles = @(Get-AuditedFiles $currentStatus)
    $currentFingerprint = Get-RelayAuditFingerprint $currentHead $currentFiles
    return [pscustomobject]@{
        matches = (
            $currentBranch -eq $ExpectedBranch -and
            $currentHead -eq $ExpectedHead -and
            $currentFingerprint -eq $ExpectedFingerprint
        )
        branch = $currentBranch
        head = $currentHead
        status = $currentStatus
        files = $currentFiles
        fingerprint = $currentFingerprint
    }
}

$observedBranch = Get-GitValue @('branch', '--show-current')
$observedHead = Get-GitValue @('rev-parse', '--verify', 'HEAD')
$script:currentBranch = $observedBranch
$observedStatus = @(Get-WorkspaceStatus)
$observedFiles = @(Get-AuditedFiles $observedStatus)
$observedFingerprint = Get-RelayAuditFingerprint $observedHead $observedFiles

if (-not [string]::IsNullOrWhiteSpace($AuditJson)) {
    try {
        $suppliedAudit = $AuditJson | ConvertFrom-Json
        if (
            [int]$suppliedAudit.version -ne 1 -or
            [string]::IsNullOrWhiteSpace([string]$suppliedAudit.head) -or
            [string]::IsNullOrWhiteSpace([string]$suppliedAudit.fingerprint)
        ) {
            throw 'Audit version, HEAD, or fingerprint was missing.'
        }
        $originalBranch = [string]$suppliedAudit.branch
        $originalHead = ([string]$suppliedAudit.head).ToLowerInvariant()
        $statusBefore = @(
            foreach ($change in @($suppliedAudit.changes)) {
                [pscustomobject]@{
                    code = [string]$change.code
                    path = ConvertTo-RelayGitPath ([string]$change.path)
                    originalPath = if ([string]::IsNullOrEmpty([string]$change.originalPath)) {
                        $null
                    } else {
                        ConvertTo-RelayGitPath ([string]$change.originalPath)
                    }
                }
            }
        )
        $script:auditedFiles = @(
            foreach ($change in @($suppliedAudit.changes)) {
                [pscustomobject]@{
                    code = [string]$change.code
                    path = ConvertTo-RelayGitPath ([string]$change.path)
                    originalPath = if ([string]::IsNullOrEmpty([string]$change.originalPath)) {
                        $null
                    } else {
                        ConvertTo-RelayGitPath ([string]$change.originalPath)
                    }
                    auditBlob = ([string]$change.auditBlob).ToLowerInvariant()
                }
            }
        )
        $script:auditFingerprint = Get-RelayAuditFingerprint $originalHead $script:auditedFiles
        if ($script:auditFingerprint -ne [string]$suppliedAudit.fingerprint) {
            throw 'Audit fingerprint did not match its HEAD, paths, status, and blobs.'
        }
    } catch {
        $refusalArguments = @{
            Code = 'WORKSPACE_AUDIT_INVALID'
            Message = "Workspace recovery audit was invalid: $($_.Exception.Message)"
            Status = $observedStatus
            BlockedPaths = @()
            DeletionPaths = @()
            ProhibitedPaths = @()
            UnsupportedChanges = @()
            OriginalBranch = $observedBranch
            OriginalHead = $observedHead
        }
        return (Complete-Result (New-RefusalResult @refusalArguments))
    }
} else {
    $originalBranch = $observedBranch
    $originalHead = $observedHead
    $statusBefore = $observedStatus
    $script:auditedFiles = $observedFiles
    $script:auditFingerprint = $observedFingerprint
}

$auditMatch = Test-WorkspaceMatchesAudit `
    $originalBranch $originalHead $script:auditFingerprint
if (-not $auditMatch.matches) {
    $refusalArguments = @{
        Code = 'WORKSPACE_AUDIT_MISMATCH'
        Message = "Workspace changed after inspection; expected '$originalBranch' at '$originalHead'. It remains in attention."
        Status = $statusBefore
        BlockedPaths = @($auditMatch.status | ForEach-Object { $_.path })
        DeletionPaths = @()
        ProhibitedPaths = @()
        UnsupportedChanges = @()
        OriginalBranch = $originalBranch
        OriginalHead = $originalHead
    }
    return (Complete-Result (New-RefusalResult @refusalArguments))
}
$skipWorktreePaths = @(Get-RelaySkipWorktreePaths $ProjectPath)

$porcelainV2Result = Invoke-RelayGit $ProjectPath @(
    'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'
)
$script:porcelainV2Before = @(
    ConvertFrom-RelayNulFields $porcelainV2Result.stdoutBytes
)
$script:untrackedFilesBefore = @(
    $statusBefore |
        Where-Object { $_.code -eq '??' } |
        ForEach-Object { $_.path }
)

$deletionPaths = New-Object System.Collections.Generic.List[string]
$prohibitedPaths = New-Object System.Collections.Generic.List[object]
$unsupportedChanges = New-Object System.Collections.Generic.List[object]
$blockedPaths = New-Object System.Collections.Generic.List[string]
foreach ($entry in $statusBefore) {
    $entryPaths = @($entry.path)
    if (-not [string]::IsNullOrWhiteSpace([string]$entry.originalPath)) {
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
        $entry.code -match '^[ MARC][ MARC]$' -and
        $entry.code.Trim().Length -gt 0
    )
    if (-not $allowedStatus) {
        $unsupportedChanges.Add($entry)
        foreach ($statusPath in $entryPaths) { $blockedPaths.Add($statusPath) }
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

$allowedPaths = @($script:auditedFiles | ForEach-Object { $_.path })
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

$projectRoot = [System.IO.Path]::GetFullPath($ProjectPath).TrimEnd('\', '/') +
    [System.IO.Path]::DirectorySeparatorChar
foreach ($statusPath in $allowedPaths) {
    $absolutePath = [System.IO.Path]::GetFullPath((Join-Path $ProjectPath $statusPath))
    if (
        -not $absolutePath.StartsWith(
            $projectRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        -not [System.IO.File]::Exists($absolutePath)
    ) {
        $refusalArguments = @{
            Code = 'WORKSPACE_UNSUPPORTED_CHANGES'
            Message = "Workspace checkout refused because '$statusPath' is not a regular project file."
            Status = $statusBefore
            BlockedPaths = @($statusPath)
            DeletionPaths = @()
            ProhibitedPaths = @()
            UnsupportedChanges = @([pscustomobject]@{
                code = 'NON_FILE'
                path = $statusPath
            })
            OriginalBranch = $originalBranch
            OriginalHead = $originalHead
        }
        return (Complete-Result (New-RefusalResult @refusalArguments))
    }
}

# A prior interrupted recovery may already have created the task ref. Without
# durable completion proof it must not be switched to or overwritten.
if ($RequestedMode -eq 'recovery' -and (Test-GitReference "refs/heads/$Branch")) {
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
    }
    return (Complete-Result (New-RefusalResult @refusalArguments))
}

function Set-RepositoryIdentity {
    if ($usesUnencryptedHttp) {
        Invoke-Git @(
            'config', '--local', 'credential.allowUnsafeRemotes', 'true'
        ) | Out-Null
    }
    Invoke-Git @('config', '--local', 'user.name', $AuthorName) | Out-Null
    Invoke-Git @('config', '--local', 'user.email', $AuthorEmail) | Out-Null
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
    $preservationPrefix = "relay/preserved/$taskPart-"
    $commitMessage = "chore(relay): preserve workspace before $Branch"

    # Validate all matching refs without changing them. Exactly one valid
    # candidate is reusable. A single invalid legacy ref may have been created
    # by an older Relay before proof metadata was added; retain it unchanged
    # and create a new verified preservation ref from the still-matching audit.
    # Multiple invalid refs without a valid candidate remain ambiguous.
    $referenceOutput = Invoke-Git @(
        'for-each-ref', '--format=%(refname)%09%(objectname)',
        "refs/heads/$preservationPrefix*"
    )
    $matchingRefs = New-Object System.Collections.Generic.List[object]
    foreach ($line in @($referenceOutput -split '\r?\n')) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $fields = @($line -split "`t", 2)
        if ($fields.Count -ne 2) {
            throw "Unexpected preservation reference record '$line'."
        }
        $matchingRefs.Add([pscustomobject]@{
            branch = $fields[0].Substring('refs/heads/'.Length)
            commit = $fields[1]
        })
    }
    $currentCheckpointRefs = New-Object System.Collections.Generic.List[object]
    $auditCandidateRefs = New-Object System.Collections.Generic.List[object]
    foreach ($candidate in $matchingRefs) {
        if (
            $candidate.branch -eq $originalBranch -and
            $candidate.commit -eq $originalHead -and
            $originalBranch.StartsWith(
                $preservationPrefix,
                [System.StringComparison]::Ordinal
            )
        ) {
            $currentCheckpointRefs.Add($candidate)
        } else {
            $auditCandidateRefs.Add($candidate)
        }
    }
    $validCandidates = New-Object System.Collections.Generic.List[object]
    foreach ($candidate in $auditCandidateRefs) {
        $proof = Test-RelayPreservationCommit `
            $ProjectPath $candidate.commit $originalHead $script:auditedFiles `
            $script:auditFingerprint
        if ($proof.valid) {
            $validCandidates.Add([pscustomobject]@{
                branch = $candidate.branch
                commit = $candidate.commit
                proof = $proof
            })
        }
    }

    if ($validCandidates.Count -gt 1 -or (
        $validCandidates.Count -eq 0 -and $auditCandidateRefs.Count -gt 1
    )) {
        $refusalArguments = @{
            Code = 'WORKSPACE_PRESERVATION_AMBIGUOUS'
            Message = "Recovery found $($matchingRefs.Count) existing preservation refs, $($currentCheckpointRefs.Count) current checkpoint refs, and $($validCandidates.Count) uniquely valid candidates; none were changed."
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

    $candidateProof = $null
    $needsPreservationRef = $false
    if ($validCandidates.Count -eq 1) {
        $preservedBranch = $validCandidates[0].branch
        $preservedCommit = $validCandidates[0].commit
        $candidateProof = $validCandidates[0].proof
        $script:reusedPreservation = $true
    } else {
        # commit-tree may have completed before an earlier process was
        # interrupted. Search unreachable commits read-only and reuse the
        # unique valid one instead of manufacturing another snapshot.
        $unreachableOutput = Invoke-Git @(
            'fsck', '--unreachable', '--no-reflogs', '--no-progress'
        )
        $validUnreachable = New-Object System.Collections.Generic.List[object]
        $invalidPartialCommits = New-Object System.Collections.Generic.List[string]
        foreach ($line in @($unreachableOutput -split '\r?\n')) {
            if ($line -notmatch '^unreachable commit ([0-9a-f]{40})$') { continue }
            $candidateCommit = $Matches[1]
            $subject = Get-GitValue @('log', '-1', '--format=%s', $candidateCommit)
            if ($subject -ne $commitMessage) { continue }
            $proof = Test-RelayPreservationCommit `
                $ProjectPath $candidateCommit $originalHead $script:auditedFiles `
                $script:auditFingerprint
            if ($proof.valid) {
                $validUnreachable.Add([pscustomobject]@{
                    commit = $candidateCommit
                    proof = $proof
                })
            } else {
                $invalidPartialCommits.Add($candidateCommit)
            }
        }
        if (
            $validUnreachable.Count -gt 1 -or
            $invalidPartialCommits.Count -gt 1
        ) {
            $refusalArguments = @{
                Code = 'WORKSPACE_PRESERVATION_AMBIGUOUS'
                Message = "Recovery found ambiguous partial preservation commits; none were changed or rebuilt."
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
        if ($validUnreachable.Count -eq 1) {
            $preservedCommit = $validUnreachable[0].commit
            $candidateProof = $validUnreachable[0].proof
            $script:reusedPreservation = $true
            $needsPreservationRef = $true
        } else {
            $preservationNonce = [Guid]::NewGuid().ToString('N').Substring(0, 12)
            $gitDirectoryValue = Get-GitValue @('rev-parse', '--git-dir')
            $gitDirectory = if ([System.IO.Path]::IsPathRooted($gitDirectoryValue)) {
                [System.IO.Path]::GetFullPath($gitDirectoryValue)
            } else {
                [System.IO.Path]::GetFullPath(
                    (Join-Path $ProjectPath $gitDirectoryValue)
                )
            }
            $evidenceDirectory = Join-Path $gitDirectory 'relay-preservation-indexes'
            if (-not (Test-Path -LiteralPath $evidenceDirectory -PathType Container)) {
                New-Item -ItemType Directory -Path $evidenceDirectory | Out-Null
            }
            $evidenceIndex = Join-Path $evidenceDirectory "$preservationNonce.index"
            if (Test-Path -LiteralPath $evidenceIndex) {
                throw "Generated preservation evidence index '$evidenceIndex' already exists."
            }
            $indexEnvironment = @{
                GIT_INDEX_FILE = $evidenceIndex
                GIT_LITERAL_PATHSPECS = '1'
            }
            Invoke-Git @('read-tree', $originalHead) $indexEnvironment | Out-Null
            $preservationPaths = @(
                foreach ($auditedFile in $script:auditedFiles) {
                    ConvertTo-RelayGitPath ([string]$auditedFile.path)
                    if (
                        -not [string]::IsNullOrEmpty(
                            [string]$auditedFile.originalPath
                        )
                    ) {
                        ConvertTo-RelayGitPath ([string]$auditedFile.originalPath)
                    }
                }
            )
            foreach ($preservationPath in $preservationPaths) {
                Invoke-Git @(
                    'add', '--all', '--', [string]$preservationPath
                ) $indexEnvironment | Out-Null
            }
            $script:preservedTree = Get-GitValue @('write-tree') $indexEnvironment

            $beforeCommit = Test-WorkspaceMatchesAudit `
                $originalBranch $originalHead $script:auditFingerprint
            if (-not $beforeCommit.matches) {
                $refusalArguments = @{
                    Code = 'WORKSPACE_CHANGED_DURING_PRESERVATION'
                    Message = 'Workspace changed while Relay prepared its preservation tree; it remains in attention.'
                    Status = $statusBefore
                    BlockedPaths = @($beforeCommit.status | ForEach-Object { $_.path })
                    DeletionPaths = @()
                    ProhibitedPaths = @()
                    UnsupportedChanges = @()
                    OriginalBranch = $originalBranch
                    OriginalHead = $originalHead
                }
                return (Complete-Result (New-RefusalResult @refusalArguments))
            }

            Set-RepositoryIdentity
            $preservedCommit = Get-GitValue @(
                'commit-tree', $script:preservedTree, '-p', $originalHead,
                '-m', $commitMessage,
                '-m', "Relay-Audit-Fingerprint: $($script:auditFingerprint)"
            )
            $candidateProof = Test-RelayPreservationCommit `
                $ProjectPath $preservedCommit $originalHead $script:auditedFiles `
                $script:auditFingerprint
            if (-not $candidateProof.valid) {
                $script:candidateDiagnostics = $candidateProof
                if (
                    $candidateProof.PSObject.Properties.Name -contains
                        'changes'
                ) {
                    $script:preservedNameStatus = @($candidateProof.changes)
                }
                $refusalArguments = @{
                    Code = 'WORKSPACE_PRESERVATION_UNPROVEN'
                    Message = "New preservation commit failed validation: $($candidateProof.reason)"
                    Status = $statusBefore
                    BlockedPaths = @()
                    DeletionPaths = @()
                    ProhibitedPaths = @()
                    UnsupportedChanges = @()
                    OriginalBranch = $originalBranch
                    OriginalHead = $originalHead
                    PreservedCommit = $preservedCommit
                }
                return (Complete-Result (New-RefusalResult @refusalArguments))
            }
            $needsPreservationRef = $true
        }

        if ($needsPreservationRef) {
            $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
            $suffix = $script:auditFingerprint.Substring(0, 12)
            $preservedBranch = "$preservationPrefix$timestamp-$suffix"
            Invoke-Git @('check-ref-format', '--branch', $preservedBranch) | Out-Null
            if (Test-GitReference "refs/heads/$preservedBranch") {
                throw "Preservation branch '$preservedBranch' unexpectedly already exists."
            }
            $zeroObjectId = '0000000000000000000000000000000000000000'
            Invoke-Git @(
                'update-ref', '--create-reflog', "refs/heads/$preservedBranch",
                $preservedCommit, $zeroObjectId
            ) | Out-Null
        }
    }

    $branchCommit = Get-GitValue @('rev-parse', "refs/heads/$preservedBranch")
    if ($branchCommit -ne $preservedCommit) {
        throw "Preserved branch '$preservedBranch' did not resolve to '$preservedCommit'."
    }
    $requiredCandidateProperties = @(
        'parent', 'tree', 'changes', 'files', 'parentVerified',
        'nameStatusVerified', 'treeVerified', 'blobVerified'
    )
    $missingCandidateProperties = @(
        $requiredCandidateProperties |
            Where-Object { $candidateProof.PSObject.Properties.Name -notcontains $_ }
    )
    if (
        $missingCandidateProperties.Count -gt 0 -or
        -not [bool]$candidateProof.parentVerified -or
        -not [bool]$candidateProof.nameStatusVerified -or
        -not [bool]$candidateProof.treeVerified -or
        -not [bool]$candidateProof.blobVerified -or
        [string]$candidateProof.parent -ne $originalHead
    ) {
        $refusalArguments = @{
            Code = 'WORKSPACE_PRESERVATION_UNPROVEN'
            Message = "Preservation candidate proof was incomplete before target branch creation; missing: $($missingCandidateProperties -join ', ')."
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
    $script:preservedTree = $candidateProof.tree
    $script:preservedNameStatus = @($candidateProof.changes)
    $script:preservedFiles = @($candidateProof.files)
    $script:preservationParent = $candidateProof.parent
    $script:parentVerified = [bool]$candidateProof.parentVerified
    $script:nameStatusVerified = [bool]$candidateProof.nameStatusVerified
    $script:treeVerified = [bool]$candidateProof.treeVerified
    $script:blobVerified = [bool]$candidateProof.blobVerified
    $script:verifiedFiles = @($candidateProof.files)
    $preservedFiles = @($candidateProof.files)

    $preTarget = Test-WorkspaceMatchesAudit `
        $originalBranch $originalHead $script:auditFingerprint
    $script:preTargetCheckoutBranch = $preTarget.branch
    $script:preTargetCheckoutHead = $preTarget.head
    if (-not $preTarget.matches) {
        $refusalArguments = @{
            Code = 'WORKSPACE_CHANGED_BEFORE_TARGET_CHECKOUT'
            Message = 'Workspace changed after preservation validation; the task branch was not created or switched.'
            Status = $statusBefore
            BlockedPaths = @($preTarget.status | ForEach-Object { $_.path })
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
    $script:preservationVerified = $true
}

Set-RepositoryIdentity
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
    $literalPathEnvironment = @{ GIT_LITERAL_PATHSPECS = '1' }
    foreach ($skipWorktreePath in $skipWorktreePaths) {
        Invoke-Git @(
            'update-index', '--skip-worktree', '--',
            [string]$skipWorktreePath
        ) $literalPathEnvironment | Out-Null
    }
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
    $auditedSkipWorktreePaths = @(
        $script:auditedFiles |
            ForEach-Object { ConvertTo-RelayGitPath ([string]$_.path) } |
            Where-Object { $skipWorktreePaths -contains $_ }
    )
    foreach ($auditedSkipWorktreePath in $auditedSkipWorktreePaths) {
        Invoke-Git @(
            'update-index', '--no-skip-worktree', '--',
            [string]$auditedSkipWorktreePath
        ) $literalPathEnvironment | Out-Null
    }
}
if ($localTaskExists) {
    Invoke-Git @('checkout', $Branch) | Out-Null
} else {
    Invoke-Git @('checkout', '-b', $Branch, $source) | Out-Null
    $script:taskBranchCreated = $true
}

$head = Get-GitValue @('rev-parse', 'HEAD')
$checkedOutBranch = Get-GitValue @('branch', '--show-current')
$script:currentBranch = $checkedOutBranch
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
    proofVersion = 1
    proven = $RequestedMode -ne 'recovery' -or $script:preservationVerified
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
    auditedFiles = $script:auditedFiles
    auditFingerprint = $script:auditFingerprint
    preservedBranch = $preservedBranch
    preservedCommit = $preservedCommit
    preservedTree = $script:preservedTree
    preservedNameStatus = $script:preservedNameStatus
    preservedFiles = $preservedFiles
    reusedPreservation = $script:reusedPreservation
    preservationVerified = $script:preservationVerified
    preTargetCheckoutBranch = $script:preTargetCheckoutBranch
    preTargetCheckoutHead = $script:preTargetCheckoutHead
    auditedHead = $originalHead
    preservationBranch = $preservedBranch
    preservationCommit = $preservedCommit
    preservationParent = $script:preservationParent
    reused = $script:reusedPreservation
    parentVerified = $script:parentVerified
    nameStatusVerified = $script:nameStatusVerified
    treeVerified = $script:treeVerified
    blobVerified = $script:blobVerified
    verifiedFiles = @($script:verifiedFiles)
    statusAfter = $statusAfter
    taskBranch = $Branch
    taskBranchCreated = $script:taskBranchCreated
    currentBranch = $checkedOutBranch
}
Complete-Result $result
