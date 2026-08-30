[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RepoUrl,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$BaseBranch,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CheckpointName,
    [Parameter(Mandatory = $true)][ValidatePattern('^https?://')][string]$UnitySaveUrl,
    [ValidatePattern('^https?://')][string]$GuestUnitySkillsEndpoint = 'http://127.0.0.1:8090',
    [ValidateNotNullOrEmpty()][string]$ApprovedOverlayPathsJson = '[]',
    [ValidateRange(2, 10)][int]$RetentionCount = 2,
    [ValidateRange(1, 20)][int]$PostRefreshStableTimeoutMinutes = 5,
    [ValidateSet(0, 1)][int]$UseCurrentRestoredState = 0,
    [ValidateSet('Refresh', 'Validate')][string]$Mode = 'Refresh'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Import-Module Hyper-V -ErrorAction Stop
. (Join-Path $PSScriptRoot 'Credential.ps1')
. (Join-Path $PSScriptRoot 'PowerShell-Direct.ps1')

$credentialFile = [System.IO.Path]::GetFullPath($CredentialPath)
$credential = Import-RelayCredential -Path $credentialFile
$gitHelperPath = Join-Path $PSScriptRoot 'Workspace-Git.ps1'
$restoreScript = Join-Path $PSScriptRoot 'Restore-Worker.ps1'
$saveScript = Join-Path $PSScriptRoot 'Save-UnityProject.ps1'
$dialogScript = Join-Path $PSScriptRoot 'Get-UnityDialogGuardState.ps1'
foreach ($requiredScript in @($gitHelperPath, $restoreScript, $saveScript, $dialogScript)) {
    if (-not (Test-Path -LiteralPath $requiredScript -PathType Leaf)) {
        throw "Required maintenance script was not found: $requiredScript"
    }
}
$gitHelperSource = [System.IO.File]::ReadAllText(
    $gitHelperPath,
    [System.Text.Encoding]::UTF8
)

function Write-CheckpointProgress([string]$Step, [object]$Data = $null) {
    [pscustomobject]@{
        step = $Step
        at = [DateTime]::UtcNow.ToString('o')
        data = $Data
    } | ConvertTo-Json -Depth 6 -Compress |
        ForEach-Object { Write-Output "RELAY_CHECKPOINT_PROGRESS:$_" }
}

function Get-StageDiagnostic([System.Management.Automation.ErrorRecord]$ErrorRecord) {
    $parts = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($ErrorRecord.Exception.Message)) {
        $parts.Add($ErrorRecord.Exception.Message.Trim())
    }
    foreach ($key in @('relayStdout', 'relayStderr')) {
        if ($ErrorRecord.Exception.Data.Contains($key)) {
            $value = [string]$ErrorRecord.Exception.Data[$key]
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                $parts.Add($value.Trim())
            }
        }
    }
    return ($parts | Select-Object -Unique) -join ' '
}

function Get-CheckpointDirtySummary([System.Management.Automation.ErrorRecord]$ErrorRecord) {
    if ($ErrorRecord.Exception.Data.Contains('checkpointDirtyJson')) {
        try {
            $direct = [string]$ErrorRecord.Exception.Data['checkpointDirtyJson'] |
                ConvertFrom-Json
            if (@($direct.paths).Count -gt 0 -and @($direct.entries).Count -gt 0) {
                return $direct
            }
        } catch {
            # Fall through to the original PowerShell Direct transport.
        }
    }

    if (-not $ErrorRecord.Exception.Data.Contains('relayStdout')) {
        return $null
    }
    $stdout = [string]$ErrorRecord.Exception.Data['relayStdout']
    $summaryMarker = 'RELAY_CHECKPOINT_DIRTY_SUMMARY:'
    foreach ($line in @($stdout -split '\r?\n')) {
        $trimmed = $line.Trim()
        $summaryIndex = $trimmed.IndexOf(
            $summaryMarker,
            [System.StringComparison]::Ordinal
        )
        if ($summaryIndex -lt 0) { continue }
        $candidate = $trimmed.Substring(
            $summaryIndex + $summaryMarker.Length
        ).Trim()
        try {
            $summary = $candidate | ConvertFrom-Json
            if (@($summary.paths).Count -gt 0 -and @($summary.entries).Count -gt 0) {
                return $summary
            }
        } catch {
            # A RELAY_CHECKPOINT_FAILURE envelope can contain an escaped copy
            # of the marker; parse that envelope below instead.
        }
    }

    $failureMarker = 'RELAY_CHECKPOINT_FAILURE:'
    foreach ($line in @($stdout -split '\r?\n')) {
        $trimmed = $line.Trim()
        $failureIndex = $trimmed.IndexOf(
            $failureMarker,
            [System.StringComparison]::Ordinal
        )
        if ($failureIndex -lt 0) { continue }
        try {
            $failure = $trimmed.Substring(
                $failureIndex + $failureMarker.Length
            ).Trim() | ConvertFrom-Json
            $message = [string]$failure.message
            $summaryIndex = $message.LastIndexOf(
                $summaryMarker,
                [System.StringComparison]::Ordinal
            )
            if ($summaryIndex -lt 0) { continue }
            $summary = $message.Substring(
                $summaryIndex + $summaryMarker.Length
            ).Trim() | ConvertFrom-Json
            if (@($summary.paths).Count -gt 0 -and @($summary.entries).Count -gt 0) {
                return $summary
            }
        } catch {
            # Do not downgrade malformed transport text into trusted evidence.
        }
    }
    return $null
}

function Get-ActiveCheckpoint {
    $matches = @(Get-VMCheckpoint -VMName $VMName -Name $CheckpointName -ErrorAction SilentlyContinue)
    if ($matches.Count -ne 1) {
        throw "Expected exactly one checkpoint named '$CheckpointName' for '$VMName'; found $($matches.Count)."
    }
    return $matches[0]
}

function Restore-CheckpointByName([string]$Name) {
    $output = @(& $restoreScript `
        -VMName $VMName `
        -CredentialPath $credentialFile `
        -CheckpointName $Name)
    return ($output | Select-Object -Last 1 | ConvertFrom-Json)
}

function Invoke-GuestGitState([bool]$Update) {
    try {
        $remoteOutput = @(
            Invoke-RelayPowerShellDirect `
            -VMName $VMName `
            -Credential $credential `
            -Stage $(if ($Update) { 'checkpoint-git-update' } else { 'checkpoint-git-validation' }) `
            -TimeoutSeconds 1800 `
            -ArgumentList @(
                $GuestProjectPath,
                $RepoUrl,
                $BaseBranch,
                $ApprovedOverlayPathsJson,
                $gitHelperSource,
                $Update
            ) `
            -ScriptBlock {
                param(
                    $ProjectPath,
                    $RepositoryUrl,
                    $Base,
                    $ApprovedOverlaysJson,
                    $HelperSource,
                    $ShouldUpdate
                )
                $ErrorActionPreference = 'Stop'
                Set-StrictMode -Version Latest
                trap {
                    $failure = [pscustomobject]@{
                        stage = 'checkpoint-guest-git'
                        message = $_.Exception.Message
                        category = [string]$_.CategoryInfo
                        scriptStackTrace = $_.ScriptStackTrace
                    } | ConvertTo-Json -Compress
                    Write-Output "RELAY_CHECKPOINT_FAILURE:$failure"
                    throw
                }
                $env:RELAY_APPROVED_OVERLAY_PATHS_JSON = $ApprovedOverlaysJson
                . ([scriptblock]::Create($HelperSource))

                function Write-CheckpointProgress([string]$Step, [object]$Data = $null) {
                    [pscustomobject]@{
                        step = $Step
                        at = [DateTime]::UtcNow.ToString('o')
                        data = $Data
                    } | ConvertTo-Json -Depth 6 -Compress |
                        ForEach-Object { Write-Output "RELAY_CHECKPOINT_PROGRESS:$_" }
                }

                Write-CheckpointProgress 'guest-git-start'

                function Get-VisibleWorkspaceStatus([hashtable]$Environment = @{}) {
                    $result = Invoke-RelayGit $ProjectPath @(
                        'status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames'
                    ) $Environment
                    $records = @(ConvertFrom-RelayNulFields $result.stdoutBytes)
                    $entries = New-Object System.Collections.Generic.List[object]
                    for ($index = 0; $index -lt $records.Count; $index += 1) {
                        $record = $records[$index]
                        if ($record.Length -lt 4 -or $record[2] -ne ' ') {
                            throw "Unexpected Git porcelain status record '$record'."
                        }
                        $code = $record.Substring(0, 2)
                        $statusPath = ConvertTo-RelayGitPath $record.Substring(3)
                        $originalPath = $null
                        if (@('R', 'C') -contains $code[0] -or @('R', 'C') -contains $code[1]) {
                            $index += 1
                            if ($index -ge $records.Count) {
                                throw "Git rename/copy record for '$statusPath' did not include its original path."
                            }
                            $originalPath = ConvertTo-RelayGitPath $records[$index]
                        }
                        $entries.Add([pscustomobject]@{
                            code = $code
                            path = $statusPath
                            originalPath = $originalPath
                        })
                    }
                    return $entries.ToArray()
                }

                function Set-SkipWorktreePaths {
                    param(
                        [Parameter(Mandatory = $true)][string[]]$Paths,
                        [Parameter(Mandatory = $true)][bool]$Enabled,
                        [hashtable]$Environment = @{}
                    )
                    $mode = if ($Enabled) { '--skip-worktree' } else { '--no-skip-worktree' }
                    $commandEnvironment = @{}
                    foreach ($name in $Environment.Keys) {
                        $commandEnvironment[$name] = $Environment[$name]
                    }
                    $commandEnvironment['GIT_LITERAL_PATHSPECS'] = '1'
                    for ($offset = 0; $offset -lt $Paths.Count; $offset += 80) {
                        $last = [Math]::Min($offset + 79, $Paths.Count - 1)
                        $chunk = @($Paths[$offset..$last])
                        $arguments = @('update-index', $mode, '--') + $chunk
                        Invoke-RelayGit $ProjectPath $arguments $commandEnvironment 120 `
                            "checkpoint-skip-worktree-$mode" | Out-Null
                    }
                }

                function Merge-ApprovedOverlayBytes {
                    param(
                        [Parameter(Mandatory = $true)][string]$OverlayPath,
                        [Parameter(Mandatory = $true)][byte[]]$LocalBytes,
                        [Parameter(Mandatory = $true)][byte[]]$OldBaseBytes,
                        [Parameter(Mandatory = $true)][byte[]]$NewBaseBytes
                    )
                    $temporaryFiles = @(
                        [System.IO.Path]::GetTempFileName(),
                        [System.IO.Path]::GetTempFileName(),
                        [System.IO.Path]::GetTempFileName()
                    )
                    try {
                        [System.IO.File]::WriteAllBytes($temporaryFiles[0], $LocalBytes)
                        [System.IO.File]::WriteAllBytes($temporaryFiles[1], $OldBaseBytes)
                        [System.IO.File]::WriteAllBytes($temporaryFiles[2], $NewBaseBytes)
                        $merge = Invoke-RelayGitProcess $ProjectPath @(
                            'merge-file', '--stdout',
                            $temporaryFiles[0],
                            $temporaryFiles[1],
                            $temporaryFiles[2]
                        ) @{} 120 'checkpoint-overlay-three-way-merge'
                        if ($merge.timedOut -or $merge.exitCode -ne 0) {
                            throw "Upstream changed approved overlay base '$OverlayPath', and its local override did not merge cleanly."
                        }
                        return ,([byte[]]$merge.stdoutBytes)
                    } finally {
                        foreach ($temporaryFile in $temporaryFiles) {
                            Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
                        }
                    }
                }

                function Get-MaintenanceWorkspaceStatus([bool]$Deep) {
                    if (-not $Deep) {
                        return @(Get-VisibleWorkspaceStatus)
                    }
                    $approved = @(Get-RelayApprovedOverlayPaths $ProjectPath)
                    $hidden = @(
                        Get-RelaySkipWorktreePaths $ProjectPath |
                            Where-Object {
                                $approved -notcontains $_ -and
                                (Test-Path -LiteralPath (Join-Path $ProjectPath $_) -PathType Leaf)
                            }
                    )
                    if ($hidden.Count -eq 0) {
                        return @(Get-VisibleWorkspaceStatus)
                    }
                    $indexPath = Get-RelayGitValue $ProjectPath @(
                        'rev-parse', '--git-path', 'index'
                    )
                    if (-not [System.IO.Path]::IsPathRooted($indexPath)) {
                        $indexPath = Join-Path $ProjectPath $indexPath
                    }
                    $temporaryIndex = Join-Path (
                        [System.IO.Path]::GetTempPath()
                    ) "relay-checkpoint-index-$([Guid]::NewGuid().ToString('N'))"
                    try {
                        Copy-Item -LiteralPath $indexPath -Destination $temporaryIndex -ErrorAction Stop
                        $temporaryEnvironment = @{ GIT_INDEX_FILE = $temporaryIndex }
                        Set-SkipWorktreePaths -Paths $hidden -Enabled $false `
                            -Environment $temporaryEnvironment
                        return @(Get-VisibleWorkspaceStatus $temporaryEnvironment)
                    } finally {
                        Remove-Item -LiteralPath $temporaryIndex -Force -ErrorAction SilentlyContinue
                    }
                }

                function Get-WorkspaceStatusEvidence([object[]]$Status) {
                    $literal = @{ GIT_LITERAL_PATHSPECS = '1' }
                    $evidence = New-Object System.Collections.Generic.List[object]
                    foreach ($entry in $Status) {
                        $statusPath = [string]$entry.path
                        $absolutePath = Join-Path $ProjectPath $statusPath
                        $exists = Test-Path -LiteralPath $absolutePath -PathType Leaf
                        $fileBytes = if ($exists) {
                            [System.IO.File]::ReadAllBytes($absolutePath)
                        } else {
                            $null
                        }
                        $sha256 = $null
                        $worktreeBlob = $null
                        if ($null -ne $fileBytes) {
                            $hasher = [System.Security.Cryptography.SHA256]::Create()
                            try {
                                $sha256 = ([System.BitConverter]::ToString(
                                    $hasher.ComputeHash([byte[]]$fileBytes)
                                )).Replace('-', '').ToLowerInvariant()
                            } finally {
                                $hasher.Dispose()
                            }
                            $worktreeBlob = Get-RelayGitValue $ProjectPath @(
                                'hash-object', '--', $statusPath
                            ) $literal
                        }

                        $headResult = Invoke-RelayGitProcess $ProjectPath @(
                            'rev-parse', '--verify', "HEAD`:$statusPath"
                        ) $literal 60 'checkpoint-dirty-head-blob'
                        $headBlob = if (-not $headResult.timedOut -and $headResult.exitCode -eq 0) {
                            [System.Text.Encoding]::UTF8.GetString(
                                [byte[]]$headResult.stdoutBytes
                            ).Trim()
                        } else {
                            $null
                        }

                        $indexResult = Invoke-RelayGitProcess $ProjectPath @(
                            'ls-files', '--stage', '--', $statusPath
                        ) $literal 60 'checkpoint-dirty-index-blob'
                        $indexRecord = if (-not $indexResult.timedOut -and $indexResult.exitCode -eq 0) {
                            [System.Text.Encoding]::UTF8.GetString(
                                [byte[]]$indexResult.stdoutBytes
                            ).Trim()
                        } else {
                            ''
                        }
                        $indexBlob = if ($indexRecord -match '^\d+\s+([0-9a-f]{40,64})\s+\d+\t') {
                            $Matches[1]
                        } else {
                            $null
                        }

                        $captureContent = $statusPath.EndsWith(
                            '.meta',
                            [System.StringComparison]::OrdinalIgnoreCase
                        ) -and $null -ne $fileBytes -and $fileBytes.Length -le 65536
                        $diffText = $null
                        if ($captureContent) {
                            $diffResult = Invoke-RelayGitProcess $ProjectPath @(
                                'diff', '--no-ext-diff', '--', $statusPath
                            ) $literal 60 'checkpoint-dirty-diff'
                            if (-not $diffResult.timedOut -and $diffResult.exitCode -eq 0 -and
                                $diffResult.stdoutBytes.Length -le 65536) {
                                $diffText = [System.Text.Encoding]::UTF8.GetString(
                                    [byte[]]$diffResult.stdoutBytes
                                )
                            }
                        }

                        $evidence.Add([pscustomobject]@{
                            code = [string]$entry.code
                            path = $statusPath
                            originalPath = $entry.originalPath
                            exists = $exists
                            length = if ($null -ne $fileBytes) { $fileBytes.Length } else { $null }
                            sha256 = $sha256
                            headBlob = $headBlob
                            indexBlob = $indexBlob
                            worktreeBlob = $worktreeBlob
                            contentBase64 = if ($captureContent) {
                                [System.Convert]::ToBase64String([byte[]]$fileBytes)
                            } else {
                                $null
                            }
                            diff = $diffText
                        })
                    }
                    return $evidence.ToArray()
                }

                function Restore-RemoteMetaOnlyWorkspace([object[]]$Status) {
                    if ($Status.Count -eq 0) {
                        return @()
                    }

                    # Checkpoint maintenance never owns business changes. Only
                    # discard the narrow shape Unity itself produces in an idle
                    # maintenance workspace: unstaged tracked .meta edits/deletes
                    # or new untracked .meta files. If any non-.meta, staged, or
                    # rename/copy entry exists, leave the entire workspace intact
                    # so the normal dirty-workspace gate can preserve and report it.
                    $eligible = @(
                        $Status |
                            Where-Object {
                                ([string]$_.path).EndsWith(
                                    '.meta',
                                    [System.StringComparison]::OrdinalIgnoreCase
                                ) -and
                                $null -eq $_.originalPath -and
                                @(' M', ' D', '??') -contains [string]$_.code
                            }
                    )
                    if ($eligible.Count -ne $Status.Count) {
                        return @()
                    }

                    $literal = @{ GIT_LITERAL_PATHSPECS = '1' }
                    $sourceHead = Get-RelayGitValue $ProjectPath @(
                        'rev-parse', '--verify', 'HEAD'
                    )
                    $evidence = @(Get-WorkspaceStatusEvidence $eligible)
                    $projectRoot = [System.IO.Path]::GetFullPath($ProjectPath)
                    $projectPrefix = $projectRoot.TrimEnd('\') + '\'
                    $restored = New-Object System.Collections.Generic.List[object]

                    foreach ($entry in $eligible) {
                        $statusPath = [string]$entry.path
                        $matchingEvidence = $evidence |
                            Where-Object { $_.path -eq $statusPath } |
                            Select-Object -First 1
                        if ([string]$entry.code -eq '??') {
                            $absolutePath = [System.IO.Path]::GetFullPath(
                                (Join-Path $ProjectPath $statusPath)
                            )
                            if (-not $absolutePath.StartsWith(
                                $projectPrefix,
                                [System.StringComparison]::OrdinalIgnoreCase
                            )) {
                                throw "Refusing to remove out-of-repository meta path '$statusPath'."
                            }
                            if (Test-Path -LiteralPath $absolutePath -PathType Leaf) {
                                Remove-Item -LiteralPath $absolutePath -Force -ErrorAction Stop
                            } elseif (Test-Path -LiteralPath $absolutePath) {
                                throw "Refusing to remove non-file meta path '$statusPath'."
                            }
                            $action = 'removed-untracked'
                        } else {
                            Invoke-RelayGit $ProjectPath @(
                                'restore', '--source=HEAD', '--worktree', '--', $statusPath
                            ) $literal 120 'checkpoint-restore-remote-meta' | Out-Null
                            $action = 'restored-head'
                        }
                        $restored.Add([pscustomobject]@{
                            code = [string]$entry.code
                            path = $statusPath
                            action = $action
                            sourceHead = $sourceHead
                            remoteBlob = $matchingEvidence.headBlob
                            discardedWorktreeBlob = $matchingEvidence.worktreeBlob
                            discardedSha256 = $matchingEvidence.sha256
                        })
                    }

                    return $restored.ToArray()
                }

                function Throw-WorkspaceGateFailure(
                    [Parameter(Mandatory = $true)][string]$Message,
                    [Parameter(Mandatory = $true)][object[]]$Status
                ) {
                    $paths = @($Status | ForEach-Object { $_.path } | Sort-Object -Unique)
                    $entries = @(Get-WorkspaceStatusEvidence $Status)
                    $diagnostic = [pscustomobject]@{
                        paths = $paths
                        entries = $entries
                    } | ConvertTo-Json -Depth 8 -Compress
                    # PowerShell's native-error rendering may retain only the
                    # tail of a long payload. Repeat a concise exact summary at
                    # the end so every dirty path/blob and changed meta setting
                    # survives transport truncation after rollback.
                    $summary = [pscustomobject]@{
                        paths = $paths
                        entries = @($entries | ForEach-Object {
                            $evidence = $_
                            [pscustomobject]@{
                                code = $evidence.code
                                path = $evidence.path
                                length = $evidence.length
                                sha256 = $evidence.sha256
                                headBlob = $evidence.headBlob
                                indexBlob = $evidence.indexBlob
                                worktreeBlob = $evidence.worktreeBlob
                                changedMetaSettings = @(
                                    [string]$evidence.diff -split "`r?`n" |
                                        Where-Object {
                                            $_ -match '^[+-]\s+(?:customWidth|customHeight):'
                                        }
                                )
                            }
                        })
                    } | ConvertTo-Json -Depth 7 -Compress
                    Write-Output "RELAY_CHECKPOINT_DIRTY_SUMMARY:$summary"
                    throw "$Message $($paths -join ', ') RELAY_CHECKPOINT_DIRTY:$diagnostic RELAY_CHECKPOINT_DIRTY_SUMMARY:$summary"
                }

                if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) {
                    throw "Guest repository '$ProjectPath' does not exist."
                }
                if (-not (Test-Path -LiteralPath (Join-Path $ProjectPath '.git'))) {
                    throw "Guest repository '$ProjectPath' has no .git directory."
                }
                $origin = Get-RelayGitValue $ProjectPath @('remote', 'get-url', 'origin')
                $normalizeUrl = {
                    param([string]$Value)
                    return $Value.Trim().TrimEnd('/').ToLowerInvariant()
                }
                if ((& $normalizeUrl $origin) -ne (& $normalizeUrl $RepositoryUrl)) {
                    throw "Guest origin '$origin' does not match configured repository '$RepositoryUrl'."
                }
                $branch = Get-RelayGitValue $ProjectPath @('branch', '--show-current')
                if ($branch -ne $Base) {
                    throw "Checkpoint refresh requires branch '$Base'; guest is on '$branch'."
                }
                $remoteMetaRestores = New-Object System.Collections.Generic.List[object]
                Write-CheckpointProgress 'baseline-status-start'
                $statusBefore = @(Get-MaintenanceWorkspaceStatus $true)
                foreach ($restoredMeta in @(Restore-RemoteMetaOnlyWorkspace $statusBefore)) {
                    $remoteMetaRestores.Add($restoredMeta)
                }
                $statusBefore = @(Get-MaintenanceWorkspaceStatus $true)
                if ($statusBefore.Count -gt 0) {
                    Throw-WorkspaceGateFailure `
                        -Message 'Checkpoint refresh refused a non-clean guest workspace:' `
                        -Status $statusBefore
                }
                Write-CheckpointProgress 'baseline-status-clean'

                $oldHead = Get-RelayGitValue $ProjectPath @('rev-parse', '--verify', 'HEAD')
                $newHead = $oldHead
                $fetchAttempts = @()
                $overlayMerges = New-Object System.Collections.Generic.List[object]
                if ([bool]$ShouldUpdate) {
                    Write-CheckpointProgress 'fetch-start' ([pscustomobject]@{
                        oldHead = $oldHead
                        branch = $Base
                    })
                    $fetch = Invoke-RelayGitWithRetry $ProjectPath @(
                        'fetch', '--no-tags', '--no-prune', 'origin',
                        "refs/heads/${Base}:refs/remotes/origin/${Base}"
                    # A recovered PROJECT_READY checkpoint can legitimately
                    # lag a large media-heavy main update. The current
                    # 3,602-file delta needed 584 seconds in a live transfer;
                    # allow one bounded transfer instead of restarting it.
                    ) 'checkpoint-main-fetch' @{} 900 1 1000
                    $fetchAttempts = @($fetch.attempts)
                    $target = "refs/remotes/origin/$Base"
                    $newHead = Get-RelayGitValue $ProjectPath @('rev-parse', '--verify', $target)
                    Write-CheckpointProgress 'fetch-complete' ([pscustomobject]@{
                        newHead = $newHead
                        attempts = $fetchAttempts
                    })
                    $ancestor = Invoke-RelayGitProcess $ProjectPath @(
                        'merge-base', '--is-ancestor', $oldHead, $newHead
                    ) @{} 60 'checkpoint-fast-forward-gate'
                    if ($ancestor.exitCode -ne 0 -or $ancestor.timedOut) {
                        throw "Guest '$Base' cannot fast-forward from '$oldHead' to '$newHead'; no reset was attempted."
                    }

                    if ($oldHead -eq $newHead) {
                        # Keep approved Unity package overlays byte-for-byte and
                        # timestamp-for-timestamp stable when main is already
                        # current. Suspending them to the HEAD baseline and
                        # immediately replaying identical local bytes makes
                        # Unity Package Manager treat manifest.json and
                        # packages-lock.json as changed, forcing an unnecessary
                        # domain reload that can strand the UnitySkills listener.
                        Write-CheckpointProgress 'fast-forward-skipped' ([pscustomobject]@{
                            head = $oldHead
                            reason = 'already-current'
                        })
                    } else {
                    $configuredOverlays = @()
                    try {
                        # Windows PowerShell 5.1 emits a JSON array as one
                        # Object[] when ConvertFrom-Json is wrapped directly
                        # in @(...). Assign first so normal array enumeration
                        # preserves each approved overlay as its own path.
                        $configuredOverlays = $ApprovedOverlaysJson | ConvertFrom-Json
                    } catch {
                        throw "Approved overlay JSON is invalid: $($_.Exception.Message)"
                    }
                    if ($configuredOverlays.Count -eq 1 -and $configuredOverlays[0] -is [string] -and
                        [string]::IsNullOrWhiteSpace([string]$configuredOverlays[0])) {
                        $configuredOverlays = @()
                    }
                    $overlayPaths = @(
                        $configuredOverlays |
                            ForEach-Object { ConvertTo-RelayGitPath ([string]$_) } |
                            Sort-Object -Unique
                    )
                    $skipPaths = @(Get-RelaySkipWorktreePaths $ProjectPath)
                    $backups = New-Object System.Collections.Generic.List[object]
                    $literal = @{ GIT_LITERAL_PATHSPECS = '1' }
                    Write-CheckpointProgress 'overlay-suspension-start' ([pscustomobject]@{
                        paths = $overlayPaths
                    })
                    try {
                        foreach ($overlayPath in $overlayPaths) {
                            if ($skipPaths -notcontains $overlayPath) {
                                throw "Approved overlay '$overlayPath' is not marked skip-worktree."
                            }
                            $absolutePath = Join-Path $ProjectPath $overlayPath
                            if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
                                throw "Approved overlay '$overlayPath' is missing from the guest."
                            }
                            $oldBlob = Get-RelayGitValue $ProjectPath @(
                                'rev-parse', "$oldHead`:$overlayPath"
                            ) $literal
                            $newBlob = Get-RelayGitValue $ProjectPath @(
                                'rev-parse', "$newHead`:$overlayPath"
                            ) $literal
                            if ($oldBlob -eq $newBlob) {
                                # A fast-forward that does not change this
                                # tracked baseline can leave its skip-worktree
                                # overlay in place. Replaying identical local
                                # package files still changes their timestamps
                                # and unnecessarily starts Unity Package
                                # Manager plus a domain reload.
                                $overlayMerges.Add([pscustomobject]@{
                                    path = $overlayPath
                                    oldBaseBlob = $oldBlob
                                    newBaseBlob = $newBlob
                                    baseChanged = $false
                                })
                                continue
                            }
                            $oldBaseline = Invoke-RelayGit $ProjectPath @(
                                'show', "$oldHead`:$overlayPath"
                            ) $literal
                            $newBaseline = Invoke-RelayGit $ProjectPath @(
                                'show', "$newHead`:$overlayPath"
                            ) $literal
                            $localBytes = [System.IO.File]::ReadAllBytes($absolutePath)
                            $replayedBytes = [byte[]](Merge-ApprovedOverlayBytes `
                                -OverlayPath $overlayPath `
                                -LocalBytes $localBytes `
                                -OldBaseBytes ([byte[]]$oldBaseline.stdoutBytes) `
                                -NewBaseBytes ([byte[]]$newBaseline.stdoutBytes))
                            $backups.Add([pscustomobject]@{
                                path = $overlayPath
                                absolutePath = $absolutePath
                                bytes = $replayedBytes
                            })
                            $overlayMerges.Add([pscustomobject]@{
                                path = $overlayPath
                                oldBaseBlob = $oldBlob
                                newBaseBlob = $newBlob
                                baseChanged = $true
                            })
                            Invoke-RelayGit $ProjectPath @(
                                'update-index', '--no-skip-worktree', '--', $overlayPath
                            ) $literal | Out-Null
                            [System.IO.File]::WriteAllBytes(
                                $absolutePath,
                                [byte[]]$oldBaseline.stdoutBytes
                            )
                        }
                        $visibleStatus = @(Get-MaintenanceWorkspaceStatus $true)
                        if ($visibleStatus.Count -gt 0) {
                            Throw-WorkspaceGateFailure `
                                -Message 'Overlay suspension did not produce a clean baseline:' `
                                -Status $visibleStatus
                        }
                        Write-CheckpointProgress 'fast-forward-start' ([pscustomobject]@{
                            oldHead = $oldHead
                            newHead = $newHead
                        })
                        Invoke-RelayGit $ProjectPath @(
                            'merge', '--ff-only', "refs/remotes/origin/$Base"
                        ) @{} 600 'checkpoint-main-fast-forward' | Out-Null
                        Write-CheckpointProgress 'fast-forward-complete'
                    } finally {
                        foreach ($backup in $backups) {
                            [System.IO.File]::WriteAllBytes(
                                [string]$backup.absolutePath,
                                [byte[]]$backup.bytes
                            )
                            Invoke-RelayGit $ProjectPath @(
                                'update-index', '--skip-worktree', '--', [string]$backup.path
                            ) $literal | Out-Null
                        }
                    }
                    }
                    $actualHead = Get-RelayGitValue $ProjectPath @('rev-parse', '--verify', 'HEAD')
                    if ($actualHead -ne $newHead) {
                        throw "Guest fast-forward ended at '$actualHead'; expected '$newHead'."
                    }
                }

                Write-CheckpointProgress 'final-status-start'
                $statusAfter = @(Get-MaintenanceWorkspaceStatus $true)
                foreach ($restoredMeta in @(Restore-RemoteMetaOnlyWorkspace $statusAfter)) {
                    $remoteMetaRestores.Add($restoredMeta)
                }
                $statusAfter = @(Get-MaintenanceWorkspaceStatus $true)
                if ($statusAfter.Count -gt 0) {
                    Throw-WorkspaceGateFailure `
                        -Message 'Guest workspace is not clean after checkpoint maintenance:' `
                        -Status $statusAfter
                }
                Write-CheckpointProgress 'final-status-clean'
                $skipAfter = @(Get-RelaySkipWorktreePaths $ProjectPath)
                $configuredAfter = @(Get-RelayApprovedOverlayPaths $ProjectPath)
                foreach ($requiredOverlay in $configuredAfter) {
                    if ($skipAfter -notcontains $requiredOverlay) {
                        throw "Approved overlay '$requiredOverlay' lost its skip-worktree marker."
                    }
                }
                [pscustomobject]@{
                    branch = $branch
                    oldHead = $oldHead
                    newHead = Get-RelayGitValue $ProjectPath @('rev-parse', '--verify', 'HEAD')
                    statusCount = $statusAfter.Count
                    untrackedCount = @($statusAfter | Where-Object { $_.code -eq '??' }).Count
                    approvedOverlays = $configuredAfter
                    overlayMerges = $overlayMerges.ToArray()
                    remoteMetaRestores = $remoteMetaRestores.ToArray()
                    skipWorktreeCount = $skipAfter.Count
                    fetchAttempts = $fetchAttempts
                } | ConvertTo-Json -Depth 8 -Compress
            }
        )
    } catch {
        $stageDiagnostic = Get-StageDiagnostic $_
        $checkpointDirty = Get-CheckpointDirtySummary $_
        if ($null -ne $checkpointDirty) {
            $summaryJson = $checkpointDirty | ConvertTo-Json -Depth 8 -Compress
            $exception = New-Object System.InvalidOperationException(
                "Guest Git checkpoint gate failed: post-Unity workspace was not clean. RELAY_CHECKPOINT_DIRTY:$summaryJson"
            )
            $exception.Data['checkpointDirtyJson'] = $summaryJson
            throw $exception
        }
        throw "Guest Git checkpoint gate failed: $stageDiagnostic"
    }
    $records = @(
        $remoteOutput |
            ForEach-Object { ([string]$_).Trim() } |
            Where-Object {
                -not [string]::IsNullOrWhiteSpace($_) -and
                $_ -notlike 'RELAY_CHECKPOINT_PROGRESS:*'
            }
    )
    if ($records.Count -ne 1) {
        throw "Guest Git stage returned $($records.Count) records; exactly one JSON result was required."
    }
    return ($records[0] | ConvertFrom-Json)
}

function Wait-GuestUnitySkills {
    param(
        [ValidateRange(1, 60)][int]$TimeoutMinutes = 20
    )
    try {
        $remoteOutput = @(
            Invoke-RelayPowerShellDirect `
            -VMName $VMName `
            -Credential $credential `
            -Stage 'checkpoint-unityskills-stable' `
            -TimeoutSeconds 1800 `
            -ArgumentList @($GuestUnitySkillsEndpoint, $GuestProjectPath, $TimeoutMinutes) `
            -ScriptBlock {
                param($Endpoint, $ProjectPath, $StableTimeoutMinutes)
                $ErrorActionPreference = 'Stop'
                Set-StrictMode -Version Latest
                trap {
                    $failure = [pscustomobject]@{
                        stage = 'checkpoint-unityskills-stable'
                        message = $_.Exception.Message
                        category = [string]$_.CategoryInfo
                        scriptStackTrace = $_.ScriptStackTrace
                    } | ConvertTo-Json -Compress
                    Write-Output "RELAY_CHECKPOINT_FAILURE:$failure"
                    throw
                }
                $builder = New-Object System.UriBuilder $Endpoint
                $builder.Path = $builder.Path.TrimEnd('/') + '/health'
                $builder.Query = ''
                # /health is processed by the Unity main thread. A large Git
                # fast-forward can legitimately keep that thread inside an
                # automatic asset import for well beyond the normal startup
                # window. Keep the overall wait bounded, but let each request
                # remain pending long enough that we do not enqueue a new
                # abandoned health request every few seconds while Unity is
                # making progress.
                $deadline = [DateTime]::UtcNow.AddMinutes($StableTimeoutMinutes)
                $stableCount = 0
                $probeCount = 0
                $lastError = $null
                $lastHealth = $null
                do {
                    $probeCount += 1
                    try {
                        $health = Invoke-RestMethod -Uri $builder.Uri.AbsoluteUri `
                            -Method Get -TimeoutSec 180 -Proxy $null -UseBasicParsing
                        $lastHealth = $health
                        $stable = (
                            [string]$health.status -eq 'ok' -and
                            [bool]$health.serverRunning -and
                            [int]$health.queuedRequests -eq 0 -and
                            [int]$health.pendingCount -eq 0 -and
                            -not [bool]$health.compilation.isCompiling -and
                            -not [bool]$health.compilation.isUpdating -and
                            -not [bool]$health.compilation.domainReloadPending -and
                            [bool]$health.threads.listenerAlive -and
                            [bool]$health.threads.keepAliveAlive
                        )
                        if ($stable) {
                            $stableCount += 1
                            if ($stableCount -ge 3) { break }
                        } else {
                            $stableCount = 0
                        }
                        $lastError = $null
                    } catch {
                        $stableCount = 0
                        $lastError = $_.Exception.Message
                    }
                    Start-Sleep -Seconds 5
                } while ([DateTime]::UtcNow -lt $deadline)
                if ($stableCount -lt 3 -or $null -eq $lastHealth) {
                    $lastHealthJson = if ($null -eq $lastHealth) {
                        'null'
                    } else {
                        $lastHealth | ConvertTo-Json -Depth 6 -Compress
                    }
                    $unityDiagnostics = @(
                        Get-CimInstance Win32_Process -Filter "Name='Unity.exe'" |
                            Where-Object {
                                $_.CommandLine -and $_.CommandLine -like "*$ProjectPath*"
                            } |
                            ForEach-Object {
                                $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
                                [pscustomobject]@{
                                    processId = [int]$_.ProcessId
                                    responding = if ($null -ne $process) {
                                        [bool]$process.Responding
                                    } else {
                                        $false
                                    }
                                    workingSetMb = if ($null -ne $process) {
                                        [Math]::Round($process.WorkingSet64 / 1MB, 1)
                                    } else {
                                        $null
                                    }
                                    cpuSeconds = if ($null -ne $process) {
                                        [Math]::Round($process.CPU, 1)
                                    } else {
                                        $null
                                    }
                                }
                            }
                    )
                    $editorLogPath = @(
                        'C:\ProgramData\Relay\UnityEditor\Editor.log'
                        (Join-Path $env:LOCALAPPDATA 'Unity\Editor\Editor.log')
                    ) | Where-Object {
                        Test-Path -LiteralPath $_ -PathType Leaf
                    } | Sort-Object {
                        (Get-Item -LiteralPath $_).LastWriteTimeUtc
                    } -Descending | Select-Object -First 1
                    $editorLog = if (-not [string]::IsNullOrWhiteSpace($editorLogPath)) {
                        $logFile = Get-Item -LiteralPath $editorLogPath
                        [pscustomobject]@{
                            path = $editorLogPath
                            lastWriteUtc = $logFile.LastWriteTimeUtc.ToString('o')
                            length = [long]$logFile.Length
                            recentSignals = @(
                                Get-Content -LiteralPath $editorLogPath -Tail 800 -ErrorAction SilentlyContinue |
                                    Select-String -Pattern 'Refresh|Import|Reload|OutOfMemory|Exception|Error' |
                                    Select-Object -Last 20 |
                                    ForEach-Object {
                                        $line = [string]$_.Line
                                        if ($line.Length -gt 500) {
                                            $line.Substring(0, 500)
                                        } else {
                                            $line
                                        }
                                    }
                            )
                        }
                    } else {
                        $null
                    }
                    $dialogStatePath = 'C:\ProgramData\Relay\UnityDialogGuard\control\state.json'
                    $dialogState = if (Test-Path -LiteralPath $dialogStatePath -PathType Leaf) {
                        try {
                            $state = Get-Content -LiteralPath $dialogStatePath -Raw -Encoding UTF8 |
                                ConvertFrom-Json
                            [pscustomobject]@{
                                healthy = [bool]$state.healthy
                                lastScanAt = [string]$state.lastScanAt
                                pendingCount = @($state.pendingDialogs).Count
                                pendingTitles = @(
                                    $state.pendingDialogs |
                                        ForEach-Object { [string]$_.title }
                                )
                            }
                        } catch {
                            [pscustomobject]@{ error = $_.Exception.Message }
                        }
                    } else {
                        $null
                    }
                    $os = Get-CimInstance Win32_OperatingSystem
                    $failureDiagnostic = [pscustomobject]@{
                        observedAt = [DateTime]::UtcNow.ToString('o')
                        unity = $unityDiagnostics
                        memory = [pscustomobject]@{
                            totalGb = [Math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
                            freeGb = [Math]::Round($os.FreePhysicalMemory / 1MB, 2)
                            totalVirtualGb = [Math]::Round($os.TotalVirtualMemorySize / 1MB, 2)
                            freeVirtualGb = [Math]::Round($os.FreeVirtualMemory / 1MB, 2)
                            pageFiles = @(
                                Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue |
                                    Select-Object Name, AllocatedBaseSize, CurrentUsage, PeakUsage
                            )
                        }
                        port8090 = @(
                            Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue |
                                Select-Object LocalAddress, LocalPort, OwningProcess
                        )
                        editorLog = $editorLog
                        dialogGuard = $dialogState
                    } | ConvertTo-Json -Depth 8 -Compress
                    throw (
                        "UnitySkills did not become stably idle after $probeCount probes. " +
                        "Last error: $lastError Last health: $lastHealthJson " +
                        "Diagnostic: $failureDiagnostic"
                    )
                }
                $unity = @(Get-CimInstance Win32_Process -Filter "Name='Unity.exe'" |
                    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$ProjectPath*" })
                if ($unity.Count -ne 1) {
                    throw "Expected one Unity process for '$ProjectPath'; found $($unity.Count)."
                }
                [pscustomobject]@{
                    status = [string]$lastHealth.status
                    service = [string]$lastHealth.service
                    version = [string]$lastHealth.version
                    localBackend = [string]$lastHealth.localBackend
                    serverRunning = [bool]$lastHealth.serverRunning
                    queuedRequests = [int]$lastHealth.queuedRequests
                    pendingCount = [int]$lastHealth.pendingCount
                    compilation = $lastHealth.compilation
                    unityProcessId = [int]$unity[0].ProcessId
                    stableChecks = $stableCount
                    timeoutMinutes = [int]$StableTimeoutMinutes
                } | ConvertTo-Json -Depth 6 -Compress
            }
        )
    } catch {
        throw "Guest UnitySkills checkpoint gate failed: $(Get-StageDiagnostic $_)"
    }
    $records = @(
        $remoteOutput |
            ForEach-Object { ([string]$_).Trim() } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($records.Count -ne 1) {
        throw "UnitySkills validation returned $($records.Count) records; exactly one JSON result was required."
    }
    return ($records[0] | ConvertFrom-Json)
}

function Restart-GuestUnityEditorAfterRefresh {
    try {
        $remoteOutput = @(
            Invoke-RelayPowerShellDirect `
                -VMName $VMName `
                -Credential $credential `
                -Stage 'checkpoint-unityeditor-post-refresh-recovery' `
                -TimeoutSeconds 360 `
                -ArgumentList @($GuestProjectPath) `
                -ScriptBlock {
                    param($ProjectPath)
                    $ErrorActionPreference = 'Stop'
                    Set-StrictMode -Version Latest
                    trap {
                        $failure = [pscustomobject]@{
                            stage = 'checkpoint-unityeditor-post-refresh-recovery'
                            message = $_.Exception.Message
                            category = [string]$_.CategoryInfo
                            scriptStackTrace = $_.ScriptStackTrace
                        } | ConvertTo-Json -Compress
                        Write-Output "RELAY_CHECKPOINT_FAILURE:$failure"
                        throw
                    }

                    # This recovery is deliberately narrower than a VM or service
                    # restart. It is allowed only after asset_refresh returned
                    # success and the caller's post-refresh stability gate timed
                    # out. Every remaining condition proves the known state where
                    # Unity finished AssetDatabase.Refresh but stopped consuming
                    # UnitySkills requests from EditorApplication.update.
                    $taskPath = '\Relay\'
                    $taskName = 'UnityEditor'
                    $tasks = @(Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop)
                    if ($tasks.Count -ne 1) {
                        throw "Expected exactly one scheduled task '$taskPath$taskName'; found $($tasks.Count)."
                    }
                    $task = $tasks[0]
                    if (
                        [int]$task.Principal.LogonType -ne 3 -or
                        [int]$task.Principal.RunLevel -ne 1
                    ) {
                        throw (
                            "Scheduled task '$taskPath$taskName' must use Interactive logon " +
                            'with Highest run level before UnityEditor recovery.'
                        )
                    }
                    $actions = @($task.Actions)
                    if ($actions.Count -ne 1) {
                        throw "Scheduled task '$taskPath$taskName' has $($actions.Count) actions; exactly one is required."
                    }
                    $action = $actions[0]
                    if ([System.IO.Path]::GetFileName([string]$action.Execute) -ine 'Unity.exe') {
                        throw "Scheduled task '$taskPath$taskName' does not execute Unity.exe."
                    }
                    $normalizedProject = [System.IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
                    $normalizedArguments = ([string]$action.Arguments).Replace('/', '\')
                    if ($normalizedArguments.IndexOf(
                        $normalizedProject,
                        [System.StringComparison]::OrdinalIgnoreCase
                    ) -lt 0) {
                        throw "Scheduled task '$taskPath$taskName' is not bound to '$normalizedProject'."
                    }

                    $unity = @(
                        Get-CimInstance Win32_Process -Filter "Name='Unity.exe'" |
                            Where-Object {
                                $_.CommandLine -and
                                $_.CommandLine.IndexOf(
                                    $normalizedProject,
                                    [System.StringComparison]::OrdinalIgnoreCase
                                ) -ge 0
                            }
                    )
                    if ($unity.Count -ne 1) {
                        throw "Expected one Unity process for '$normalizedProject'; found $($unity.Count)."
                    }
                    $oldProcessId = [int]$unity[0].ProcessId
                    $oldProcess = Get-Process -Id $oldProcessId -ErrorAction Stop
                    if (-not [bool]$oldProcess.Responding) {
                        throw "Unity process '$oldProcessId' is not responding; refusing the narrow scheduled-task recovery."
                    }
                    $portOwners = @(
                        Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction Stop |
                            Select-Object -ExpandProperty OwningProcess -Unique
                    )
                    if ($portOwners.Count -ne 1 -or [int]$portOwners[0] -ne $oldProcessId) {
                        throw "Unity process '$oldProcessId' is not the unique owner of loopback service port 8090."
                    }

                    $dialogStatePath = 'C:\ProgramData\Relay\UnityDialogGuard\control\state.json'
                    if (-not (Test-Path -LiteralPath $dialogStatePath -PathType Leaf)) {
                        throw "UnityDialogGuard state does not exist at '$dialogStatePath'."
                    }
                    $dialog = Get-Content -LiteralPath $dialogStatePath -Raw -Encoding UTF8 |
                        ConvertFrom-Json
                    $lastDialogScan = [DateTimeOffset]::Parse(
                        [string]$dialog.lastScanAt,
                        [Globalization.CultureInfo]::InvariantCulture,
                        [Globalization.DateTimeStyles]::AssumeUniversal
                    ).UtcDateTime
                    $dialogAgeSeconds = ([DateTime]::UtcNow - $lastDialogScan).TotalSeconds
                    if (
                        -not [bool]$dialog.healthy -or
                        @($dialog.pendingDialogs).Count -ne 0 -or
                        $dialogAgeSeconds -gt 30
                    ) {
                        throw (
                            "UnityDialogGuard is not stably idle: healthy=$([bool]$dialog.healthy) " +
                            "pending=$(@($dialog.pendingDialogs).Count) ageSeconds=$([Math]::Round($dialogAgeSeconds, 1))."
                        )
                    }

                    $editorLogPath = @(
                        'C:\ProgramData\Relay\UnityEditor\Editor.log'
                        (Join-Path $env:LOCALAPPDATA 'Unity\Editor\Editor.log')
                    ) | Where-Object {
                        Test-Path -LiteralPath $_ -PathType Leaf
                    } | Sort-Object {
                        (Get-Item -LiteralPath $_).LastWriteTimeUtc
                    } -Descending | Select-Object -First 1
                    if ([string]::IsNullOrWhiteSpace($editorLogPath)) {
                        throw 'No Unity Editor.log was available to prove a completed AssetDatabase.Refresh.'
                    }
                    $editorLogFile = Get-Item -LiteralPath $editorLogPath
                    $editorLogAgeSeconds = ([DateTime]::UtcNow - $editorLogFile.LastWriteTimeUtc).TotalSeconds
                    if ($editorLogAgeSeconds -gt 900) {
                        throw "The newest Unity Editor.log is stale ($([Math]::Round($editorLogAgeSeconds, 1)) seconds)."
                    }
                    $logLines = @(Get-Content -LiteralPath $editorLogPath -Tail 6000 -ErrorAction Stop)
                    $refreshIndex = -1
                    for ($index = 0; $index -lt $logLines.Count; $index += 1) {
                        if (([string]$logLines[$index]) -match 'Asset Pipeline Refresh.*Total:') {
                            $refreshIndex = $index
                        }
                    }
                    if ($refreshIndex -lt 0) {
                        throw 'Editor.log does not contain a completed Asset Pipeline Refresh signal.'
                    }
                    $fatalAfterRefresh = if ($refreshIndex -lt ($logLines.Count - 1)) {
                        @(
                            $logLines[($refreshIndex + 1)..($logLines.Count - 1)] |
                                Select-String -Pattern (
                                    'Scripts have compiler errors|Compilation failed|OutOfMemory|' +
                                    'Crash!!!|Fatal error|Aborting batchmode due to failure'
                                )
                        )
                    } else {
                        @()
                    }
                    if (@($fatalAfterRefresh).Count -gt 0) {
                        throw 'Editor.log contains a fatal or compiler failure after the completed Asset Pipeline Refresh.'
                    }

                    Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
                    $stopDeadline = [DateTime]::UtcNow.AddMinutes(2)
                    while (
                        $null -ne (Get-Process -Id $oldProcessId -ErrorAction SilentlyContinue) -and
                        [DateTime]::UtcNow -lt $stopDeadline
                    ) {
                        Start-Sleep -Seconds 2
                    }
                    if ($null -ne (Get-Process -Id $oldProcessId -ErrorAction SilentlyContinue)) {
                        throw "Scheduled task stop did not terminate Unity process '$oldProcessId'."
                    }
                    Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
                    $startDeadline = [DateTime]::UtcNow.AddMinutes(3)
                    $newUnity = @()
                    do {
                        Start-Sleep -Seconds 2
                        $newUnity = @(
                            Get-CimInstance Win32_Process -Filter "Name='Unity.exe'" |
                                Where-Object {
                                    $_.CommandLine -and
                                    $_.CommandLine.IndexOf(
                                        $normalizedProject,
                                        [System.StringComparison]::OrdinalIgnoreCase
                                    ) -ge 0 -and
                                    [int]$_.ProcessId -ne $oldProcessId
                                }
                        )
                    } while ($newUnity.Count -ne 1 -and [DateTime]::UtcNow -lt $startDeadline)
                    if ($newUnity.Count -ne 1) {
                        throw "Scheduled task start produced $($newUnity.Count) replacement Unity processes; exactly one is required."
                    }
                    [pscustomobject]@{
                        reason = 'post-refresh-main-thread-request-consumer-stalled'
                        taskPath = $taskPath
                        taskName = $taskName
                        oldProcessId = $oldProcessId
                        newProcessId = [int]$newUnity[0].ProcessId
                        dialogGuardHealthy = [bool]$dialog.healthy
                        dialogGuardPendingCount = @($dialog.pendingDialogs).Count
                        dialogGuardAgeSeconds = [Math]::Round($dialogAgeSeconds, 3)
                        editorLogPath = $editorLogPath
                        editorLogLastWriteUtc = $editorLogFile.LastWriteTimeUtc.ToString('o')
                        assetRefreshSignal = [string]$logLines[$refreshIndex]
                    } | ConvertTo-Json -Compress
                }
        )
    } catch {
        throw "Narrow UnityEditor post-refresh recovery failed: $(Get-StageDiagnostic $_)"
    }
    $records = @(
        $remoteOutput |
            ForEach-Object { ([string]$_).Trim() } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($records.Count -ne 1) {
        throw "UnityEditor recovery returned $($records.Count) records; exactly one JSON result was required."
    }
    return ($records[0] | ConvertFrom-Json)
}

function Invoke-UnityAssetRefresh {
    try {
        $remoteOutput = @(
            Invoke-RelayPowerShellDirect `
                -VMName $VMName `
                -Credential $credential `
                -Stage 'checkpoint-unity-asset-refresh' `
                -TimeoutSeconds 600 `
                -ArgumentList @($GuestUnitySkillsEndpoint) `
                -ScriptBlock {
                    param($Endpoint)
                    $ErrorActionPreference = 'Stop'
                    Set-StrictMode -Version Latest
                    trap {
                        $failure = [pscustomobject]@{
                            stage = 'checkpoint-unity-asset-refresh'
                            message = $_.Exception.Message
                            category = [string]$_.CategoryInfo
                            scriptStackTrace = $_.ScriptStackTrace
                        } | ConvertTo-Json -Compress
                        Write-Output "RELAY_CHECKPOINT_FAILURE:$failure"
                        throw
                    }
                    $builder = New-Object System.UriBuilder $Endpoint
                    $builder.Path = '/skill/asset_refresh'
                    $builder.Query = ''
                    $response = Invoke-RestMethod -Uri $builder.Uri.AbsoluteUri `
                        -Method Post `
                        -ContentType 'application/json' `
                        -Body '{}' `
                        -TimeoutSec 540 `
                        -Proxy $null `
                        -UseBasicParsing
                    if (
                        [string]$response.status -ne 'success' -or
                        $null -eq $response.result -or
                        -not [bool]$response.result.success
                    ) {
                        throw 'UnitySkills asset_refresh did not return a successful result.'
                    }
                    [pscustomobject]@{
                        status = [string]$response.status
                        success = [bool]$response.result.success
                        message = [string]$response.result.message
                    } | ConvertTo-Json -Compress
                }
        )
    } catch {
        throw "Unity asset refresh failed: $(Get-StageDiagnostic $_)"
    }
    $records = @(
        $remoteOutput |
            ForEach-Object { ([string]$_).Trim() } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($records.Count -ne 1) {
        throw "Unity asset refresh returned $($records.Count) records; exactly one JSON result was required."
    }
    return ($records[0] | ConvertFrom-Json)
}

function Wait-DialogGuard {
    $deadline = [DateTime]::UtcNow.AddMinutes(2)
    $state = $null
    do {
        $records = @(& $dialogScript -VMName $VMName -CredentialPath $credentialFile)
        $state = $records | Select-Object -Last 1 | ConvertFrom-Json
        $lastScan = [DateTimeOffset]::Parse(
            [string]$state.lastScanAt,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal
        ).UtcDateTime
        $heartbeatAgeSeconds = ([DateTime]::UtcNow - $lastScan).TotalSeconds
        if (
            [bool]$state.healthy -and
            [bool]$state.guardProcessRunning -and
            $heartbeatAgeSeconds -le 30 -and
            @($state.pendingDialogs).Count -eq 0
        ) {
            $state.heartbeatAgeSeconds = [Math]::Round($heartbeatAgeSeconds, 3)
            return $state
        }
        Start-Sleep -Seconds 5
    } while ([DateTime]::UtcNow -lt $deadline)
    $pending = @($state.pendingDialogs | ForEach-Object { $_.dialogId }) -join ', '
    throw "UnityDialogGuard did not become healthy and clear pending dialogs. Pending: $pending"
}

function Invoke-UnitySaveValidation {
    $records = @(& $saveScript `
        -VMName $VMName `
        -CredentialPath $credentialFile `
        -UnitySaveUrl $UnitySaveUrl `
        -GuestUnitySkillsEndpoint $GuestUnitySkillsEndpoint `
        -TimeoutSeconds 300 `
        -DomainReloadRetryCount 5 `
        -DomainReloadRetryDelayMilliseconds 2000)
    $result = $records | Select-Object -Last 1 | ConvertFrom-Json
    if (-not [bool]$result.saved -or [string]$result.provider -ne 'UnitySkillsRest') {
        throw 'Unity save validation did not return a successful UnitySkillsRest result.'
    }
    return $result
}

function Get-CheckpointResult {
    return @(
        Get-VMCheckpoint -VMName $VMName |
            Sort-Object CreationTime -Descending |
            ForEach-Object {
                [pscustomobject]@{
                    name = $_.Name
                    id = $_.Id.ToString()
                    creationTime = $_.CreationTime.ToString('o')
                    parentCheckpointName = $_.ParentCheckpointName
                }
            }
    )
}

$activeCheckpoint = Get-ActiveCheckpoint
if ($Mode -eq 'Validate') {
    $git = Invoke-GuestGitState $false
    $unity = Wait-GuestUnitySkills
    $dialog = Wait-DialogGuard
    [pscustomobject]@{
        mode = $Mode
        vmName = $VMName
        checkpointName = $activeCheckpoint.Name
        checkpointId = $activeCheckpoint.Id.ToString()
        git = $git
        unitySkills = $unity
        dialogGuard = [pscustomobject]@{
            healthy = [bool]$dialog.healthy
            guardProcessRunning = [bool]$dialog.guardProcessRunning
            pendingCount = @($dialog.pendingDialogs).Count
            lastScanAt = $dialog.lastScanAt
        }
        checkpoints = Get-CheckpointResult
    } | ConvertTo-Json -Depth 10 -Compress
    exit 0
}

$archiveCheckpoint = $null
$newCheckpoint = $null
$canaryPassed = $false
$gitResult = $null
$unityResult = $null
$saveResult = $null
$assetRefreshResult = $null
$postRefreshStableFailure = $null
$unityEditorRecovery = $null
$postRefreshGitResult = $null
$postSaveGitResult = $null
$canaryPostSaveGitResult = $null
$dialogResult = $null
$initialRestoreSkipped = $false
try {
    if ($UseCurrentRestoredState -eq 1) {
        $currentVm = Get-VM -Name $VMName -ErrorAction Stop
        if ($currentVm.ParentCheckpointId -ne $activeCheckpoint.Id) {
            throw (
                "Current VM parent checkpoint '$($currentVm.ParentCheckpointId)' " +
                "does not match retained '$CheckpointName' '$($activeCheckpoint.Id)'."
            )
        }
        $initialRestoreSkipped = $true
        Write-CheckpointProgress 'initial-restore-skipped' ([pscustomobject]@{
            checkpointName = $CheckpointName
            checkpointId = $activeCheckpoint.Id.ToString()
            reason = 'current-vm-parent-matches-retained-checkpoint'
        })
    } else {
        $null = Restore-CheckpointByName $CheckpointName
    }
    $gitResult = Invoke-GuestGitState $true
    $unityResult = Wait-GuestUnitySkills
    if ($gitResult.oldHead -ne $gitResult.newHead) {
        $assetRefreshResult = Invoke-UnityAssetRefresh
        try {
            $unityResult = Wait-GuestUnitySkills `
                -TimeoutMinutes $PostRefreshStableTimeoutMinutes
        } catch {
            $postRefreshStableFailure = Get-StageDiagnostic $_
            Write-CheckpointProgress 'post-refresh-stable-timeout' ([pscustomobject]@{
                timeoutMinutes = $PostRefreshStableTimeoutMinutes
                diagnostic = $postRefreshStableFailure
            })
            $unityEditorRecovery = Restart-GuestUnityEditorAfterRefresh
            Write-CheckpointProgress 'unityeditor-post-refresh-restarted' $unityEditorRecovery
            $unityResult = Wait-GuestUnitySkills
        }
        # Unity importer .meta drift is maintenance-local state. The Git stage
        # restores pure unstaged .meta-only drift to the fetched HEAD and never
        # turns it into a commit; any mixed or non-.meta dirt still fails closed.
        $postRefreshGitResult = Invoke-GuestGitState $false
    }
    $saveResult = Invoke-UnitySaveValidation
    # File/Save is itself a mutation boundary. Re-run the same fail-closed Git
    # gate after it so serialized scene/settings corruption cannot be captured
    # by PROJECT_READY merely because the pre-save refresh check was clean.
    $postSaveGitResult = Invoke-GuestGitState $false
    $dialogResult = Wait-DialogGuard

    $activeCheckpoint = Get-ActiveCheckpoint
    $archiveName = '{0}_PREV_{1}' -f $CheckpointName, $activeCheckpoint.CreationTime.ToString('yyyyMMdd-HHmmss')
    if (@(Get-VMCheckpoint -VMName $VMName -Name $archiveName -ErrorAction SilentlyContinue).Count -gt 0) {
        $archiveName = '{0}_{1}' -f $archiveName, $activeCheckpoint.Id.ToString('N').Substring(0, 8)
    }
    $archiveId = $activeCheckpoint.Id
    $activeCheckpoint | Rename-VMSnapshot -NewName $archiveName -ErrorAction Stop | Out-Null
    $archiveCheckpoint = Get-VMCheckpoint -VMName $VMName | Where-Object { $_.Id -eq $archiveId }
    if ($null -eq $archiveCheckpoint -or $archiveCheckpoint.Name -ne $archiveName) {
        throw "Failed to verify renamed rollback checkpoint '$archiveName'."
    }

    $newCheckpoint = Checkpoint-VM -Name $VMName -SnapshotName $CheckpointName -Passthru -ErrorAction Stop
    $verifiedNew = Get-ActiveCheckpoint
    if ($verifiedNew.Id -ne $newCheckpoint.Id) {
        throw "New '$CheckpointName' identity did not match the created checkpoint."
    }
    $newCheckpoint = $verifiedNew

    $null = Restore-CheckpointByName $CheckpointName
    $canaryGit = Invoke-GuestGitState $false
    if ($canaryGit.newHead -ne $gitResult.newHead) {
        throw "Checkpoint canary restored Git HEAD '$($canaryGit.newHead)'; expected '$($gitResult.newHead)'."
    }
    $canaryUnity = Wait-GuestUnitySkills
    $canarySave = Invoke-UnitySaveValidation
    # The restored canary must remain clean after its own Unity save before the
    # checkpoint is accepted or any older managed checkpoint is pruned.
    $canaryPostSaveGitResult = Invoke-GuestGitState $false
    $canaryDialog = Wait-DialogGuard
    $canaryPassed = $true

    $managed = @(
        Get-VMCheckpoint -VMName $VMName |
            Where-Object {
                $_.Name -eq $CheckpointName -or
                $_.Name -like "${CheckpointName}_PREV_*"
            } |
            Sort-Object CreationTime -Descending
    )
    $obsolete = @($managed | Select-Object -Skip $RetentionCount)
    foreach ($checkpoint in $obsolete) {
        $checkpoint | Remove-VMCheckpoint -Confirm:$false -ErrorAction Stop
    }
    $finalCheckpoints = Get-CheckpointResult
    $managedFinal = @($finalCheckpoints | Where-Object {
        $_.name -eq $CheckpointName -or $_.name -like "${CheckpointName}_PREV_*"
    })
    if ($managedFinal.Count -gt $RetentionCount) {
        throw "Managed checkpoint retention failed; found $($managedFinal.Count), expected at most $RetentionCount."
    }

    [pscustomobject]@{
        mode = $Mode
        vmName = $VMName
        checkpointName = $CheckpointName
        checkpointId = $newCheckpoint.Id.ToString()
        previousCheckpointName = $archiveCheckpoint.Name
        previousCheckpointId = $archiveCheckpoint.Id.ToString()
        initialRestoreSkipped = $initialRestoreSkipped
        oldHead = $gitResult.oldHead
        newHead = $gitResult.newHead
        git = $gitResult
        postRefreshGit = $postRefreshGitResult
        postSaveGit = $postSaveGitResult
        canaryPostSaveGit = $canaryPostSaveGitResult
        assetRefresh = $assetRefreshResult
        postRefreshStableFailure = $postRefreshStableFailure
        unityEditorRecovery = $unityEditorRecovery
        unitySkills = $canaryUnity
        unitySave = $canarySave
        dialogGuard = [pscustomobject]@{
            healthy = [bool]$canaryDialog.healthy
            guardProcessRunning = [bool]$canaryDialog.guardProcessRunning
            pendingCount = @($canaryDialog.pendingDialogs).Count
            lastScanAt = $canaryDialog.lastScanAt
        }
        canaryPassed = $canaryPassed
        checkpoints = $finalCheckpoints
    } | ConvertTo-Json -Depth 12 -Compress
} catch {
    $primaryError = $_.Exception.Message
    $checkpointDirty = Get-CheckpointDirtySummary $_
    # Match only the full evidence marker. The concise
    # RELAY_CHECKPOINT_DIRTY_SUMMARY marker deliberately shares the prefix.
    $dirtyMarker = 'RELAY_CHECKPOINT_DIRTY:{'
    $dirtyMarkerIndex = $primaryError.LastIndexOf(
        $dirtyMarker,
        [System.StringComparison]::Ordinal
    )
    if ($null -eq $checkpointDirty -and $dirtyMarkerIndex -ge 0) {
        $dirtyJson = '{' + $primaryError.Substring(
            $dirtyMarkerIndex + $dirtyMarker.Length
        ).Trim()
        $dirtySummarySuffix = ' RELAY_CHECKPOINT_DIRTY_SUMMARY:'
        $dirtySummaryIndex = $dirtyJson.IndexOf(
            $dirtySummarySuffix,
            [System.StringComparison]::Ordinal
        )
        if ($dirtySummaryIndex -ge 0) {
            $dirtyJson = $dirtyJson.Substring(0, $dirtySummaryIndex).Trim()
        }
        try {
            $checkpointDirty = $dirtyJson | ConvertFrom-Json
        } catch {
            $checkpointDirty = $null
        }
    }
    $rollbackErrors = New-Object System.Collections.Generic.List[string]
    if (-not $canaryPassed) {
        try {
            if ($null -ne $archiveCheckpoint) {
                $archiveNow = Get-VMCheckpoint -VMName $VMName |
                    Where-Object { $_.Id -eq $archiveCheckpoint.Id }
                if ($null -ne $archiveNow) {
                    $null = Restore-CheckpointByName $archiveNow.Name
                    $newNow = if ($null -ne $newCheckpoint) {
                        Get-VMCheckpoint -VMName $VMName |
                            Where-Object { $_.Id -eq $newCheckpoint.Id }
                    } else {
                        $null
                    }
                    if ($null -ne $newNow) {
                        $newNow | Remove-VMCheckpoint -Confirm:$false -ErrorAction Stop
                    }
                    $archiveNow = Get-VMCheckpoint -VMName $VMName |
                        Where-Object { $_.Id -eq $archiveCheckpoint.Id }
                    if ($null -ne $archiveNow -and $archiveNow.Name -ne $CheckpointName) {
                        $archiveNow | Rename-VMSnapshot -NewName $CheckpointName -ErrorAction Stop | Out-Null
                    }
                }
            } else {
                $currentActive = @(Get-VMCheckpoint -VMName $VMName -Name $CheckpointName -ErrorAction SilentlyContinue)
                if ($currentActive.Count -eq 1) {
                    $null = Restore-CheckpointByName $CheckpointName
                }
            }
        } catch {
            $rollbackErrors.Add($_.Exception.Message)
        }
    }
    $rollbackMessage = if ($rollbackErrors.Count -gt 0) {
        " Rollback errors: $($rollbackErrors -join '; ')"
    } elseif ($canaryPassed) {
        ' The new canary passed; it was retained because only post-canary retention cleanup failed.'
    } else {
        ' The previous PROJECT_READY checkpoint was restored and retained.'
    }
    if ($null -ne $checkpointDirty) {
        $dirtyPaths = @($checkpointDirty.paths | ForEach-Object { [string]$_ })
        [Console]::Out.WriteLine((
            [pscustomobject]@{
                code = 'CHECKPOINT_WORKSPACE_DIRTY'
                message = "Unity refresh changed non-approved tracked files: $($dirtyPaths -join ', ')"
                checkpointName = $CheckpointName
                previousCheckpointRetained = -not $canaryPassed
                checkpointDirty = $checkpointDirty
            } | ConvertTo-Json -Depth 12 -Compress
        ))
        throw "PROJECT_READY refresh failed because Unity changed non-approved tracked files: $($dirtyPaths -join ', ').$rollbackMessage"
    }
    throw "PROJECT_READY refresh failed: $primaryError$rollbackMessage"
}
