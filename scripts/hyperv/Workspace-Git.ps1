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

function Invoke-RelayGitProcess {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [hashtable]$Environment = @{}
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = 'git'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $nativeArguments = @('-C', $RepositoryPath) + @($Arguments)
    $startInfo.Arguments = (
        $nativeArguments |
            ForEach-Object { ConvertTo-RelayNativeArgument ([string]$_) }
    ) -join ' '
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
    try {
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $stderrTask = $process.StandardError.BaseStream.CopyToAsync($stderr)
        $process.WaitForExit()
        [System.Threading.Tasks.Task]::WaitAll(
            [System.Threading.Tasks.Task[]]@($stdoutTask, $stderrTask)
        )
        $exitCode = $process.ExitCode
    } finally {
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
    }
}

function Invoke-RelayGit {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [hashtable]$Environment = @{}
    )

    $result = Invoke-RelayGitProcess $RepositoryPath $Arguments $Environment
    if ($result.exitCode -ne 0) {
        $message = $result.stderr.Trim()
        if ([string]::IsNullOrWhiteSpace($message)) {
            $message = $result.stdout.Trim()
        }
        throw "git '$($Arguments[0])' failed with exit code $($result.exitCode): $message"
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
    return $entries.ToArray()
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
    param([Parameter(Mandatory = $true)][object[]]$Status)

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
        [Parameter(Mandatory = $true)][object[]]$Expected,
        [Parameter(Mandatory = $true)][object[]]$Actual
    )

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
        [Parameter(Mandatory = $true)][object[]]$AuditedFiles
    )

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
        [Parameter(Mandatory = $true)][object[]]$AuditedFiles
    )

    try {
        $commitType = Get-RelayGitValue $RepositoryPath @('cat-file', '-t', $Commit)
        if ($commitType -ne 'commit') {
            return [pscustomobject]@{ valid = $false; reason = "'$Commit' is not a commit." }
        }
        $parentLine = Get-RelayGitValue $RepositoryPath @(
            'rev-list', '--parents', '-n', '1', $Commit
        )
        $parentFields = @($parentLine -split ' ')
        if ($parentFields.Count -ne 2 -or $parentFields[1] -ne $AuditHead) {
            return [pscustomobject]@{
                valid = $false
                reason = "Commit '$Commit' parent did not equal audited HEAD '$AuditHead'."
            }
        }

        $expectedChanges = @(Get-RelayExpectedChanges $AuditedFiles)
        $actualChanges = @(Get-RelayCommitChanges $RepositoryPath $AuditHead $Commit)
        $comparison = Compare-RelayChangeSets $expectedChanges $actualChanges
        if (-not $comparison.matches) {
            return [pscustomobject]@{
                valid = $false
                reason = "Commit '$Commit' name-status did not equal the audited change set."
                changes = $actualChanges
                missing = $comparison.missing
                unexpected = $comparison.unexpected
            }
        }
        if (@($actualChanges | Where-Object { $_.status.StartsWith('D') }).Count -gt 0) {
            return [pscustomobject]@{
                valid = $false
                reason = "Commit '$Commit' contained a deletion."
                changes = $actualChanges
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
        $tree = Get-RelayGitValue $RepositoryPath @('rev-parse', "$Commit^{tree}")
        return [pscustomobject]@{
            valid = $true
            reason = $null
            parent = $AuditHead
            tree = $tree
            changes = $actualChanges
            files = $files.ToArray()
        }
    } catch {
        return [pscustomobject]@{
            valid = $false
            reason = $_.Exception.Message
        }
    }
}
