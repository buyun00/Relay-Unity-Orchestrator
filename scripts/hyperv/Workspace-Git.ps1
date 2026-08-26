Set-StrictMode -Version Latest

function ConvertTo-RelayNativeArgument {
    param([AllowEmptyString()][string]$Argument)

    if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') {
        return $Argument
    }

    $quoted = New-Object System.Text.StringBuilder
    [void]$quoted.Append('"')
    $backslashes = 0
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes += 1
            continue
        }
        if ($character -eq '"') {
            [void]$quoted.Append(('\' * (($backslashes * 2) + 1)))
            [void]$quoted.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$quoted.Append(('\' * $backslashes))
            $backslashes = 0
        }
        [void]$quoted.Append($character)
    }
    if ($backslashes -gt 0) {
        [void]$quoted.Append(('\' * ($backslashes * 2)))
    }
    [void]$quoted.Append('"')
    return $quoted.ToString()
}

function Stop-RelayOwnedChildProcesses {
    param([Parameter(Mandatory = $true)][int]$RootProcessId)

    # Process.Kill() in Windows PowerShell/.NET Framework terminates only the
    # direct Git process. Helpers such as git-remote-http can otherwise keep
    # redirected pipe handles open long after the timeout. Snapshot descendants
    # from this exact root and terminate them deepest-first; never sweep by name.
    $processSnapshot = @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Select-Object ProcessId, ParentProcessId
    )
    $ownedIds = New-Object System.Collections.Generic.List[int]
    $pending = New-Object System.Collections.Generic.Queue[int]
    $pending.Enqueue($RootProcessId)
    while ($pending.Count -gt 0) {
        $parentId = $pending.Dequeue()
        foreach ($child in @($processSnapshot | Where-Object {
            [int]$_.ParentProcessId -eq $parentId
        })) {
            $childId = [int]$child.ProcessId
            $ownedIds.Add($childId)
            $pending.Enqueue($childId)
        }
    }
    $orderedIds = @($ownedIds.ToArray())
    [Array]::Reverse($orderedIds)
    foreach ($ownedId in $orderedIds) {
        try {
            $ownedProcess = [System.Diagnostics.Process]::GetProcessById($ownedId)
            try {
                if (-not $ownedProcess.HasExited) {
                    $ownedProcess.Kill()
                    [void]$ownedProcess.WaitForExit(5000)
                }
            } finally {
                $ownedProcess.Dispose()
            }
        } catch {
            # A descendant may exit between the snapshot and termination.
        }
    }
}

function Invoke-RelayGitProcess {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [hashtable]$Environment = @{},
        [ValidateRange(1, 1200)][int]$TimeoutSeconds = 60,
        [string]$Stage = ''
    )

    if ([string]::IsNullOrWhiteSpace($Stage)) {
        $Stage = "git:$($Arguments[0])"
    }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = 'git'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $nativeArguments = @(
        '-c', 'http.version=HTTP/1.1',
        '-c', 'credential.interactive=never',
        '-c', 'http.lowSpeedLimit=1',
        '-c', 'http.lowSpeedTime=30',
        '-C', $RepositoryPath
    ) + @($Arguments)
    $startInfo.Arguments = (
        $nativeArguments |
            ForEach-Object { ConvertTo-RelayNativeArgument ([string]$_) }
    ) -join ' '
    $startInfo.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
    $startInfo.EnvironmentVariables['GIT_ASKPASS'] = ''
    $startInfo.EnvironmentVariables['SSH_ASKPASS'] = ''
    $startInfo.EnvironmentVariables['GCM_INTERACTIVE'] = 'Never'
    $startInfo.EnvironmentVariables['GCM_GUI_PROMPT'] = '0'
    foreach ($name in $Environment.Keys) {
        $value = $Environment[$name]
        if ($null -eq $value) {
            [void]$startInfo.EnvironmentVariables.Remove([string]$name)
        } else {
            $startInfo.EnvironmentVariables[[string]$name] = [string]$value
        }
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $stdout = New-Object System.IO.MemoryStream
    $stderr = New-Object System.IO.MemoryStream
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $timedOut = $false
    $exitCode = $null
    try {
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $stderrTask = $process.StandardError.BaseStream.CopyToAsync($stderr)
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $timedOut = $true
            Stop-RelayOwnedChildProcesses -RootProcessId $process.Id
            try {
                # This Process instance owns exactly this Git child. Do not use
                # a name-based process sweep or unrelated process tree.
                $process.Kill()
            } catch {
                # Preserve the original timeout as the primary diagnostic.
            }
            [void]$process.WaitForExit(5000)
        }
        $streamTasks = [System.Threading.Tasks.Task[]]@($stdoutTask, $stderrTask)
        $streamsDrained = [System.Threading.Tasks.Task]::WaitAll($streamTasks, 5000)
        if (-not $streamsDrained) {
            # Do not let inherited pipe handles defeat the process timeout.
            try { $process.StandardOutput.Close() } catch {}
            try { $process.StandardError.Close() } catch {}
            try {
                [void][System.Threading.Tasks.Task]::WaitAll($streamTasks, 1000)
            } catch {
                # Partial output already captured remains useful diagnostics.
            }
        }
        if ($process.HasExited) {
            $exitCode = $process.ExitCode
        }
    } finally {
        $stopwatch.Stop()
        $process.Dispose()
    }

    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    try {
        $stdoutText = $utf8.GetString($stdout.ToArray())
        $stderrText = $utf8.GetString($stderr.ToArray())
    } catch {
        throw "Git emitted output that was not valid UTF-8 while running '$($Arguments[0])'."
    }

    [pscustomobject]@{
        exitCode = $exitCode
        stdoutBytes = $stdout.ToArray()
        stdout = $stdoutText
        stderr = $stderrText
        stage = $Stage
        timedOut = $timedOut
        timeoutSeconds = $TimeoutSeconds
        durationMs = $stopwatch.ElapsedMilliseconds
    }
}

function New-RelayGitFailure {
    param(
        [Parameter(Mandatory = $true)][object]$Result,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [object[]]$Attempts = @()
    )

    $message = $Result.stderr.Trim()
    if ([string]::IsNullOrWhiteSpace($message)) {
        $message = $Result.stdout.Trim()
    }
    $summary = if ([bool]$Result.timedOut) {
        "Git stage '$($Result.stage)' timed out after $($Result.timeoutSeconds)s; the owned Git child was terminated."
    } else {
        "Git stage '$($Result.stage)' failed with exit code $($Result.exitCode): $message"
    }
    $exception = if ([bool]$Result.timedOut) {
        New-Object System.TimeoutException($summary)
    } else {
        New-Object System.InvalidOperationException($summary)
    }
    $exception.Data['relayStage'] = [string]$Result.stage
    $exception.Data['relayExitCode'] = $Result.exitCode
    $exception.Data['relayStdout'] = [string]$Result.stdout
    $exception.Data['relayStderr'] = [string]$Result.stderr
    $exception.Data['relayTimedOut'] = [bool]$Result.timedOut
    $exception.Data['relayAttempts'] = @($Attempts)
    $exception.Data['relayGitCommand'] = [string]$Arguments[0]
    return $exception
}

function Test-RelayTransientGitFailure {
    param([Parameter(Mandatory = $true)][object]$Result)

    if ([bool]$Result.timedOut) { return $true }
    $diagnostic = ([string]$Result.stderr + [Environment]::NewLine + [string]$Result.stdout)
    return $diagnostic -match '(?im)(?:curl\s+18|transfer closed with outstanding read data|early EOF|unexpected disconnect|invalid index-pack output|connection (?:was )?reset|connection reset by peer|could not resolve host|temporary failure in name resolution|operation timed out|low speed|less than \d+ bytes/sec transferred)'
}

function Invoke-RelayGitWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Stage,
        [hashtable]$Environment = @{},
        [ValidateRange(1, 1200)][int]$TimeoutSeconds = 60,
        [ValidateRange(1, 3)][int]$MaximumAttempts = 3,
        [ValidateRange(0, 10000)][int]$InitialBackoffMilliseconds = 1000,
        [scriptblock]$ProcessInvoker,
        [scriptblock]$BackoffWaiter
    )

    $attempts = New-Object System.Collections.Generic.List[object]
    for ($attempt = 1; $attempt -le $MaximumAttempts; $attempt += 1) {
        $result = if ($null -eq $ProcessInvoker) {
            Invoke-RelayGitProcess $RepositoryPath $Arguments $Environment $TimeoutSeconds $Stage
        } else {
            & $ProcessInvoker $RepositoryPath $Arguments $Environment $TimeoutSeconds $Stage $attempt
        }
        $transient = $result.exitCode -ne 0 -and
            (Test-RelayTransientGitFailure $result)
        $backoffMilliseconds = if ($transient -and $attempt -lt $MaximumAttempts) {
            $InitialBackoffMilliseconds * [Math]::Pow(2, $attempt - 1)
        } else {
            0
        }
        $attempts.Add([pscustomobject]@{
            attempt = $attempt
            stage = $Stage
            exitCode = $result.exitCode
            stdout = $result.stdout
            stderr = $result.stderr
            timedOut = [bool]$result.timedOut
            timeoutSeconds = $result.timeoutSeconds
            durationMs = $result.durationMs
            transient = [bool]$transient
            backoffMilliseconds = [int]$backoffMilliseconds
        })
        if ($result.exitCode -eq 0 -and -not $result.timedOut) {
            return [pscustomobject]@{
                result = $result
                attempts = $attempts.ToArray()
            }
        }
        if (-not $transient -or $attempt -eq $MaximumAttempts) {
            throw (New-RelayGitFailure $result $Arguments $attempts.ToArray())
        }
        if ($null -eq $BackoffWaiter) {
            Start-Sleep -Milliseconds $backoffMilliseconds
        } else {
            & $BackoffWaiter $backoffMilliseconds $attempt
        }
    }
}

function Invoke-RelayGit {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [hashtable]$Environment = @{},
        [ValidateRange(1, 1200)][int]$TimeoutSeconds = 60,
        [string]$Stage = ''
    )

    $result = Invoke-RelayGitProcess $RepositoryPath $Arguments $Environment $TimeoutSeconds $Stage
    if ($result.exitCode -ne 0 -or $result.timedOut) {
        throw (New-RelayGitFailure $result $Arguments)
    }
    return $result
}

function Get-RelayGitValue {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [hashtable]$Environment = @{}
    )

    $result = Invoke-RelayGit $RepositoryPath $Arguments $Environment
    return $result.stdout.Trim()
}

function Test-RelayGitReference {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryPath,
        [Parameter(Mandatory = $true)][string]$Reference
    )

    $result = Invoke-RelayGitProcess $RepositoryPath @(
        'show-ref', '--verify', '--quiet', $Reference
    )
    if ($result.exitCode -eq 0) { return $true }
    if ($result.exitCode -eq 1) { return $false }
    throw "git 'show-ref' failed with exit code $($result.exitCode): $($result.stderr.Trim())"
}

function ConvertFrom-RelayNulFields {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [byte[]]$Bytes
    )

    if ($Bytes.Length -eq 0) { return @() }
    if ($Bytes[$Bytes.Length - 1] -ne 0) {
        throw 'Git NUL-delimited output did not end with a NUL byte.'
    }

    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $fields = New-Object System.Collections.Generic.List[string]
    $fieldStart = 0
    for ($index = 0; $index -lt $Bytes.Length; $index += 1) {
        if ($Bytes[$index] -ne 0) { continue }
        $fieldLength = $index - $fieldStart
        if ($fieldLength -eq 0) {
            $fields.Add('')
        } else {
            $fields.Add($utf8.GetString($Bytes, $fieldStart, $fieldLength))
        }
        $fieldStart = $index + 1
    }
    return $fields.ToArray()
}

function ConvertTo-RelayGitPath {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Path)

    if ([string]::IsNullOrEmpty($Path)) {
        throw 'Git returned an empty path.'
    }
    if ($Path.IndexOf([char]0) -ge 0) {
        throw 'Git returned a path containing a NUL character.'
    }

    $normalized = $Path.Replace('\', '/')
    if (
        $normalized -eq '.' -or
        $normalized.StartsWith('/', [System.StringComparison]::Ordinal) -or
        $normalized -match '^[A-Za-z]:/' -or
        $normalized.StartsWith('//', [System.StringComparison]::Ordinal)
    ) {
        throw "Git returned a non-relative project path '$Path'."
    }

    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($part in $normalized.Split('/')) {
        if ([string]::IsNullOrEmpty($part) -or $part -eq '.') { continue }
        if ($part -eq '..') {
            throw "Git returned a path outside the project root '$Path'."
        }
        $parts.Add($part)
    }
    if ($parts.Count -eq 0) {
        throw "Git path '$Path' normalized to '.'."
    }
    return [string]::Join('/', $parts.ToArray())
}

function Get-RelayWorkspaceStatus {
    param([Parameter(Mandatory = $true)][string]$RepositoryPath)

    $result = Invoke-RelayGit $RepositoryPath @(
        'status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames'
    )
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
        if (
            @('R', 'C') -contains $code[0] -or
            @('R', 'C') -contains $code[1]
        ) {
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

    # A previous interrupted recovery or a sparse checkout can leave tracked
    # paths marked skip-worktree. Git status deliberately hides those paths,
    # even when an existing working-tree file no longer matches the audited
    # commit. Surface only real, present-file drift; absent sparse baseline
    # entries remain tree context and are not treated as deletions.
    $knownPaths = New-Object 'System.Collections.Generic.HashSet[string]' (
        [System.StringComparer]::Ordinal
    )
    foreach ($entry in $entries) {
        [void]$knownPaths.Add((ConvertTo-RelayGitPath ([string]$entry.path)))
    }
    $approvedOverlayPaths = New-Object `
        'System.Collections.Generic.HashSet[string]' `
        ([System.StringComparer]::Ordinal)
    foreach ($approvedPath in @(Get-RelayApprovedOverlayPaths $RepositoryPath)) {
        [void]$approvedOverlayPaths.Add($approvedPath)
    }
    $head = Get-RelayGitValue $RepositoryPath @('rev-parse', '--verify', 'HEAD')
    $literalPathEnvironment = @{ GIT_LITERAL_PATHSPECS = '1' }
    foreach ($skipPath in @(Get-RelaySkipWorktreePaths $RepositoryPath)) {
        if ($knownPaths.Contains($skipPath)) { continue }
        $absolutePath = Join-Path $RepositoryPath $skipPath
        if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
            continue
        }
        $headEntry = Invoke-RelayGit $RepositoryPath @(
            'ls-tree', '-z', '--format=%(objectname)', $head, '--', $skipPath
        ) $literalPathEnvironment
        $headBlobs = @(ConvertFrom-RelayNulFields $headEntry.stdoutBytes)
        if ($headBlobs.Count -ne 1) {
            throw "Unable to resolve the audited HEAD blob for skip-worktree path '$skipPath'."
        }
        $worktreeBlob = Get-RelayPathBlob $RepositoryPath $skipPath
        if ($worktreeBlob -eq $headBlobs[0]) { continue }
        # A local infrastructure overlay is excluded only when an administrator
        # explicitly records its exact repository-relative path and the index
        # still marks it skip-worktree. Ordinary skip-worktree drift remains
        # visible and fail-closed.
        if ($approvedOverlayPaths.Contains($skipPath)) { continue }
        $entries.Add([pscustomobject]@{
            code = ' M'
            path = $skipPath
            originalPath = $null
        })
    }
    return $entries.ToArray()
}

function Get-RelayApprovedOverlayPaths {
    param([Parameter(Mandatory = $true)][string]$RepositoryPath)

    $paths = New-Object `
        'System.Collections.Generic.HashSet[string]' `
        ([System.StringComparer]::Ordinal)
    $result = Invoke-RelayGitProcess $RepositoryPath @(
        'config', '--local', '--get-all', 'relay.approvedOverlayPath'
    )
    if ($result.exitCode -notin @(0, 1) -or $result.timedOut) {
        throw (New-RelayGitFailure $result @(
            'config', '--local', '--get-all', 'relay.approvedOverlayPath'
        ))
    }
    if ($result.exitCode -eq 0) {
        foreach ($line in @($result.stdout -split "`r?`n")) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            [void]$paths.Add((ConvertTo-RelayGitPath $line))
        }
    }

    $configuredJson = [Environment]::GetEnvironmentVariable(
        'RELAY_APPROVED_OVERLAY_PATHS_JSON',
        [EnvironmentVariableTarget]::Process
    )
    if (-not [string]::IsNullOrWhiteSpace($configuredJson)) {
        try {
            $configured = $configuredJson | ConvertFrom-Json
        } catch {
            throw "RELAY_APPROVED_OVERLAY_PATHS_JSON was not valid JSON: $($_.Exception.Message)"
        }
        if ($null -ne $configured -and $configured -is [string]) {
            throw 'RELAY_APPROVED_OVERLAY_PATHS_JSON must contain a JSON array of repository-relative paths.'
        }
        foreach ($configuredPath in @($configured)) {
            if ($configuredPath -isnot [string] -or [string]::IsNullOrWhiteSpace($configuredPath)) {
                throw 'RELAY_APPROVED_OVERLAY_PATHS_JSON must contain only non-empty string paths.'
            }
            [void]$paths.Add((ConvertTo-RelayGitPath $configuredPath))
        }
    }
    return @($paths | Sort-Object)
}

function Get-RelaySkipWorktreePaths {
    param([Parameter(Mandatory = $true)][string]$RepositoryPath)

    $result = Invoke-RelayGit $RepositoryPath @('ls-files', '-t', '-z')
    $paths = New-Object System.Collections.Generic.List[string]
    foreach ($record in @(ConvertFrom-RelayNulFields $result.stdoutBytes)) {
        if ($record.StartsWith('S ', [System.StringComparison]::Ordinal)) {
            $paths.Add((ConvertTo-RelayGitPath $record.Substring(2)))
        }
    }
    return $paths.ToArray()
}

function Get-RelayPathBlob {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryPath,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $normalized = ConvertTo-RelayGitPath $Path
    return Get-RelayGitValue $RepositoryPath @(
        'hash-object', "--path=$normalized", '--', $normalized
    )
}

function Get-RelayExpectedChanges {
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [AllowEmptyCollection()]
        [object[]]$Status
    )

    if ($null -eq $Status) {
        $Status = [object[]]@()
    }
    $changes = New-Object System.Collections.Generic.List[object]
    foreach ($entry in $Status) {
        $code = [string]$entry.code
        $status = if ($code -eq '??') {
            'A'
        } elseif ($code.Contains('R')) {
            'R'
        } elseif ($code.Contains('C')) {
            'C'
        } elseif ($code.Contains('A')) {
            'A'
        } elseif ($code.Contains('M')) {
            'M'
        } else {
            throw "Unsupported audited Git status '$code' for '$($entry.path)'."
        }
        $path = ConvertTo-RelayGitPath ([string]$entry.path)
        $originalPath = $null
        if ($status -in @('R', 'C')) {
            if ([string]::IsNullOrEmpty([string]$entry.originalPath)) {
                throw "Audited $status status for '$path' did not include its original path."
            }
            $originalPath = ConvertTo-RelayGitPath ([string]$entry.originalPath)
        }
        $changes.Add([pscustomobject]@{
            status = $status
            path = $path
            originalPath = $originalPath
        })
    }
    return $changes.ToArray()
}

function Get-RelayCommitChanges {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryPath,
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Commit
    )

    $result = Invoke-RelayGit $RepositoryPath @(
        'diff-tree', '--no-commit-id', '--name-status', '-r', '-z',
        '--find-renames', '--find-copies', $Parent, $Commit
    )
    $fields = @(ConvertFrom-RelayNulFields $result.stdoutBytes)
    $changes = New-Object System.Collections.Generic.List[object]
    for ($index = 0; $index -lt $fields.Count; $index += 1) {
        $statusText = $fields[$index]
        if ([string]::IsNullOrEmpty($statusText)) {
            throw 'Preservation commit contained an empty name-status record.'
        }
        $status = $statusText.Substring(0, 1)
        if ($status -in @('R', 'C')) {
            if ($index + 2 -ge $fields.Count) {
                throw "Preservation commit $statusText record ended unexpectedly."
            }
            $originalPath = ConvertTo-RelayGitPath $fields[$index + 1]
            $path = ConvertTo-RelayGitPath $fields[$index + 2]
            $index += 2
        } else {
            if ($index + 1 -ge $fields.Count) {
                throw "Preservation commit $statusText record ended unexpectedly."
            }
            $originalPath = $null
            $path = ConvertTo-RelayGitPath $fields[$index + 1]
            $index += 1
        }
        $changes.Add([pscustomobject]@{
            status = $statusText
            path = $path
            originalPath = $originalPath
        })
    }
    return $changes.ToArray()
}

function Get-RelayChangeKey {
    param([Parameter(Mandatory = $true)][object]$Change)

    $status = ([string]$Change.status).Substring(0, 1)
    $path = ConvertTo-RelayGitPath ([string]$Change.path)
    $originalPath = if ([string]::IsNullOrEmpty([string]$Change.originalPath)) {
        ''
    } else {
        ConvertTo-RelayGitPath ([string]$Change.originalPath)
    }
    return $status + [char]0 + $originalPath + [char]0 + $path
}

function Compare-RelayChangeSets {
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [AllowEmptyCollection()]
        [object[]]$Expected,
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [AllowEmptyCollection()]
        [object[]]$Actual
    )

    if ($null -eq $Expected) {
        $Expected = [object[]]@()
    }
    if ($null -eq $Actual) {
        $Actual = [object[]]@()
    }
    $expectedSet = New-Object 'System.Collections.Generic.HashSet[string]' (
        [System.StringComparer]::Ordinal
    )
    $actualSet = New-Object 'System.Collections.Generic.HashSet[string]' (
        [System.StringComparer]::Ordinal
    )
    foreach ($change in $Expected) {
        if (-not $expectedSet.Add((Get-RelayChangeKey $change))) {
            throw "Duplicate audited preservation change for '$($change.path)'."
        }
    }
    foreach ($change in $Actual) {
        if (-not $actualSet.Add((Get-RelayChangeKey $change))) {
            throw "Duplicate commit preservation change for '$($change.path)'."
        }
    }

    $missing = New-Object System.Collections.Generic.List[string]
    $unexpected = New-Object System.Collections.Generic.List[string]
    foreach ($key in $expectedSet) {
        if (-not $actualSet.Contains($key)) { $missing.Add($key) }
    }
    foreach ($key in $actualSet) {
        if (-not $expectedSet.Contains($key)) { $unexpected.Add($key) }
    }
    [pscustomobject]@{
        matches = $missing.Count -eq 0 -and $unexpected.Count -eq 0
        missing = $missing.ToArray()
        unexpected = $unexpected.ToArray()
    }
}

function Get-RelayAuditFingerprint {
    param(
        [Parameter(Mandatory = $true)][string]$Head,
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [AllowEmptyCollection()]
        [object[]]$AuditedFiles
    )

    if ($null -eq $AuditedFiles) {
        $AuditedFiles = [object[]]@()
    }
    $records = @(
        foreach ($file in $AuditedFiles) {
            $code = [string]$file.code
            $path = ConvertTo-RelayGitPath ([string]$file.path)
            $originalPath = if ([string]::IsNullOrEmpty([string]$file.originalPath)) {
                ''
            } else {
                ConvertTo-RelayGitPath ([string]$file.originalPath)
            }
            $blob = ([string]$file.auditBlob).ToLowerInvariant()
            $code + [char]0 + $originalPath + [char]0 + $path + [char]0 + $blob
        }
    )
    [Array]::Sort($records, [System.StringComparer]::Ordinal)
    $payload = $Head.ToLowerInvariant() + [char]0 + [string]::Join([char]0, $records)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($payload)
        return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

function Test-RelayPreservationCommit {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryPath,
        [Parameter(Mandatory = $true)][string]$Commit,
        [Parameter(Mandatory = $true)][string]$AuditHead,
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [AllowEmptyCollection()]
        [object[]]$AuditedFiles,
        [string]$AuditFingerprint
    )

    if ($null -eq $AuditedFiles) {
        $AuditedFiles = [object[]]@()
    }
    try {
        $commitType = Get-RelayGitValue $RepositoryPath @('cat-file', '-t', $Commit)
        if ($commitType -ne 'commit') {
            return [pscustomobject]@{
                valid = $false
                reason = "'$Commit' is not a commit."
                parentVerified = $false
                nameStatusVerified = $false
                treeVerified = $false
                blobVerified = $false
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($AuditFingerprint)) {
            $commitMessage = Get-RelayGitValue $RepositoryPath @(
                'log', '-1', '--format=%B', $Commit
            )
            $fingerprintMarker = "Relay-Audit-Fingerprint: $AuditFingerprint"
            if (@($commitMessage -split '\r?\n') -notcontains $fingerprintMarker) {
                return [pscustomobject]@{
                    valid = $false
                    reason = "Commit '$Commit' did not contain the audited fingerprint '$AuditFingerprint'."
                    parentVerified = $false
                    nameStatusVerified = $false
                    treeVerified = $false
                    blobVerified = $false
                }
            }
        }
        $parentLine = Get-RelayGitValue $RepositoryPath @(
            'rev-list', '--parents', '-n', '1', $Commit
        )
        $parentFields = @($parentLine -split ' ')
        if ($parentFields.Count -ne 2 -or $parentFields[1] -ne $AuditHead) {
            return [pscustomobject]@{
                valid = $false
                reason = "Commit '$Commit' parent did not equal audited HEAD '$AuditHead'."
                parentVerified = $false
                nameStatusVerified = $false
                treeVerified = $false
                blobVerified = $false
            }
        }

        $tree = Get-RelayGitValue $RepositoryPath @('rev-parse', "$Commit^{tree}")
        $expectedChanges = @(Get-RelayExpectedChanges $AuditedFiles)
        $actualChanges = @(Get-RelayCommitChanges $RepositoryPath $AuditHead $Commit)
        $comparison = Compare-RelayChangeSets $expectedChanges $actualChanges
        if (-not $comparison.matches) {
            return [pscustomobject]@{
                valid = $false
                reason = "Commit '$Commit' name-status did not equal the audited change set."
                parent = $AuditHead
                tree = $tree
                expectedChanges = $expectedChanges
                changes = $actualChanges
                missing = $comparison.missing
                unexpected = $comparison.unexpected
                parentVerified = $true
                nameStatusVerified = $false
                treeVerified = $false
                blobVerified = $false
            }
        }
        if (@($actualChanges | Where-Object { $_.status.StartsWith('D') }).Count -gt 0) {
            return [pscustomobject]@{
                valid = $false
                reason = "Commit '$Commit' contained a deletion."
                changes = $actualChanges
                parentVerified = $true
                nameStatusVerified = $false
                treeVerified = $false
                blobVerified = $false
            }
        }

        $files = New-Object System.Collections.Generic.List[object]
        foreach ($file in $AuditedFiles) {
            $path = ConvertTo-RelayGitPath ([string]$file.path)
            $auditBlob = ([string]$file.auditBlob).ToLowerInvariant()
            $commitBlob = (
                Get-RelayGitValue $RepositoryPath @('rev-parse', "$Commit`:$path")
            ).ToLowerInvariant()
            if ($commitBlob -ne $auditBlob) {
                return [pscustomobject]@{
                    valid = $false
                    reason = "Commit '$Commit' blob for '$path' did not equal its audit blob."
                    changes = $actualChanges
                    parentVerified = $true
                    nameStatusVerified = $true
                    treeVerified = $false
                    blobVerified = $false
                }
            }
            $files.Add([pscustomobject]@{
                path = $path
                code = [string]$file.code
                originalPath = $file.originalPath
                auditBlob = $auditBlob
                preservedBlob = $commitBlob
                blob = $commitBlob
            })
        }
        return [pscustomobject]@{
            valid = $true
            reason = $null
            parent = $AuditHead
            tree = $tree
            changes = $actualChanges
            files = $files.ToArray()
            parentVerified = $true
            nameStatusVerified = $true
            treeVerified = $true
            blobVerified = $true
        }
    } catch {
        return [pscustomobject]@{
            valid = $false
            reason = $_.Exception.Message
            parentVerified = $false
            nameStatusVerified = $false
            treeVerified = $false
            blobVerified = $false
        }
    }
}
