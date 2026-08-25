[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RepositoryPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ContaminationCommit,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedBadBlob,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedStableBlob,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RepairBranch,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$MergeRequestTitle,
    [switch]$PromoteExistingRepairBranchToMain
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'Credential.ps1')
. (Join-Path $PSScriptRoot 'PowerShell-Direct.ps1')

$credential = Import-RelayCredential -Path $CredentialPath
$remoteOutput = Invoke-RelayPowerShellDirect `
    -VMName $VMName `
    -Credential $credential `
    -Stage 'exact-remote-path-repair-tree-filter' `
    -TimeoutSeconds 240 `
    -ArgumentList @(
        $GuestProjectPath,
        $RepositoryPath,
        $ContaminationCommit,
        $ExpectedBadBlob.ToLowerInvariant(),
        $ExpectedStableBlob.ToLowerInvariant(),
        $RepairBranch,
        $MergeRequestTitle,
        [bool]$PromoteExistingRepairBranchToMain
    ) `
    -ScriptBlock {
        param(
            $ProjectPath,
            $Path,
            $BadCommit,
            $BadBlobExpected,
            $StableBlobExpected,
            $Branch,
            $MrTitle,
            $PromoteExisting
        )
        $ErrorActionPreference = 'Stop'
        Set-StrictMode -Version Latest
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        $OutputEncoding = [Console]::OutputEncoding

        function Invoke-Git([string[]]$Arguments) {
            $previousErrorActionPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $output = @(
                    & git @Arguments 2>&1 | ForEach-Object { [string]$_ }
                )
                $exitCode = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousErrorActionPreference
            }
            if ($exitCode -ne 0) {
                throw "git $($Arguments -join ' ') failed with exit $exitCode`: $([string]::Join(
                    [Environment]::NewLine,
                    $output
                ))"
            }
            return $output
        }

        function Get-RemoteSha([string]$Reference) {
            $line = @(
                Invoke-Git @(
                    '-c', 'credential.interactive=never', '-C', $ProjectPath,
                    'ls-remote', 'origin', $Reference
                )
            ) | Select-Object -Last 1
            if ([string]::IsNullOrWhiteSpace($line)) { return '' }
            return ([string]$line -split '\s+')[0]
        }

        function Get-CommitTree([string]$GitDirectory, [string]$Commit) {
            $record = @(
                Invoke-Git @(('--git-dir=' + $GitDirectory), 'cat-file', '-p', $Commit)
            ) | Where-Object { $_.StartsWith('tree ') } | Select-Object -First 1
            if ([string]::IsNullOrWhiteSpace($record)) {
                throw "Commit '$Commit' did not expose a tree."
            }
            return ([string]$record).Substring(5).Trim()
        }

        function Get-TreeEntries([string]$GitDirectory, [string]$Tree) {
            $entries = New-Object System.Collections.Generic.List[object]
            foreach ($lineValue in @(
                Invoke-Git @(
                    '-c', 'core.quotePath=false', ('--git-dir=' + $GitDirectory),
                    'ls-tree', $Tree
                )
            )) {
                $line = [string]$lineValue
                $tab = $line.IndexOf("`t")
                if ($tab -lt 1) { throw "Unexpected ls-tree record '$line'." }
                $metadata = $line.Substring(0, $tab) -split ' '
                if ($metadata.Count -ne 3) {
                    throw "Unexpected ls-tree metadata '$line'."
                }
                $entries.Add([pscustomobject]@{
                    mode = $metadata[0]
                    type = $metadata[1]
                    oid = $metadata[2]
                    name = $line.Substring($tab + 1)
                })
            }
            return $entries.ToArray()
        }

        function Find-TreeEntry([object[]]$Entries, [string]$Name) {
            $matches = @($Entries | Where-Object { [string]$_.name -eq $Name })
            if ($matches.Count -ne 1) {
                throw "Tree entry '$Name' resolved to $($matches.Count) records."
            }
            return $matches[0]
        }

        function Write-TreeEntries(
            [string]$GitDirectory,
            [object[]]$Entries,
            [string]$ReplaceName,
            [string]$ReplaceOid
        ) {
            $replaced = 0
            $lines = @(
                foreach ($entry in $Entries) {
                    $oid = [string]$entry.oid
                    if ([string]$entry.name -eq $ReplaceName) {
                        $oid = $ReplaceOid
                        $replaced += 1
                    }
                    "$($entry.mode) $($entry.type) $oid`t$($entry.name)"
                }
            )
            if ($replaced -ne 1) {
                throw "Tree rewrite for '$ReplaceName' replaced $replaced entries."
            }
            $payload = [string]::Join("`n", $lines) + "`n"
            $startInfo = New-Object System.Diagnostics.ProcessStartInfo
            $startInfo.FileName = 'git'
            $startInfo.Arguments = (
                '--git-dir="' + $GitDirectory.Replace('"', '\"') +
                '" mktree --missing'
            )
            $startInfo.UseShellExecute = $false
            $startInfo.CreateNoWindow = $true
            $startInfo.RedirectStandardInput = $true
            $startInfo.RedirectStandardOutput = $true
            $startInfo.RedirectStandardError = $true
            $utf8 = New-Object System.Text.UTF8Encoding($false)
            $startInfo.StandardOutputEncoding = $utf8
            $startInfo.StandardErrorEncoding = $utf8
            $process = New-Object System.Diagnostics.Process
            $process.StartInfo = $startInfo
            try {
                [void]$process.Start()
                $payloadBytes = $utf8.GetBytes($payload)
                $process.StandardInput.BaseStream.Write(
                    $payloadBytes,
                    0,
                    $payloadBytes.Length
                )
                $process.StandardInput.Close()
                $stdout = $process.StandardOutput.ReadToEnd()
                $stderr = $process.StandardError.ReadToEnd()
                $process.WaitForExit()
                $exitCode = $process.ExitCode
            } finally {
                $process.Dispose()
            }
            if ($exitCode -ne 0) {
                throw "git mktree failed with exit $exitCode`: $stderr"
            }
            return $stdout.Trim()
        }

        function Get-PathBlob(
            [string]$GitDirectory,
            [string]$RootTree,
            [string[]]$Parts
        ) {
            $tree = $RootTree
            for ($index = 0; $index -lt $Parts.Count; $index += 1) {
                $entry = Find-TreeEntry `
                    -Entries @(Get-TreeEntries $GitDirectory $tree) `
                    -Name $Parts[$index]
                if ($index -eq $Parts.Count - 1) {
                    if ([string]$entry.type -ne 'blob') {
                        throw "Target '$($Parts[$index])' was not a blob."
                    }
                    return [string]$entry.oid
                }
                if ([string]$entry.type -ne 'tree') {
                    throw "Path component '$($Parts[$index])' was not a tree."
                }
                $tree = [string]$entry.oid
            }
            throw 'Repository path contained no components.'
        }

        $origin = (& git -C $ProjectPath remote get-url origin).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($origin)) {
            throw 'Unable to resolve origin URL.'
        }
        $status = @(& git -C $ProjectPath status --porcelain=v1 --untracked-files=all)
        if ($LASTEXITCODE -ne 0 -or $status.Count -ne 0) {
            throw 'Retained workspace was not clean.'
        }
        $localBlob = (& git -C $ProjectPath hash-object -- $Path).Trim()
        if ($LASTEXITCODE -ne 0 -or $localBlob -ne $StableBlobExpected) {
            throw "Retained workspace blob '$localBlob' did not equal '$StableBlobExpected'."
        }

        $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
        $temp = [IO.Path]::GetFullPath((Join-Path $tempRoot (
            'relay-tree-repair-' + [guid]::NewGuid().ToString('N') + '.git'
        )))
        if (-not $temp.StartsWith(
            $tempRoot + '\',
            [StringComparison]::OrdinalIgnoreCase
        )) {
            throw 'Resolved temporary repository escaped TEMP.'
        }

        try {
            Invoke-Git @('init', '--bare', $temp) | Out-Null
            Invoke-Git @(('--git-dir=' + $temp), 'remote', 'add', 'origin', $origin) | Out-Null
            Invoke-Git @(
                ('--git-dir=' + $temp), 'config', 'remote.origin.promisor', 'true'
            ) | Out-Null
            Invoke-Git @(
                ('--git-dir=' + $temp), 'config',
                'remote.origin.partialclonefilter', 'tree:0'
            ) | Out-Null
            Invoke-Git @(
                ('--git-dir=' + $temp), 'config', 'extensions.partialClone', 'origin'
            ) | Out-Null

            $mainBefore = Get-RemoteSha 'refs/heads/main'
            if ([string]::IsNullOrWhiteSpace($mainBefore)) {
                throw 'origin/main did not resolve.'
            }
            $existingRepairBranch = Get-RemoteSha ('refs/heads/' + $Branch)
            if (-not [string]::IsNullOrWhiteSpace($existingRepairBranch)) {
                if (-not [bool]$PromoteExisting) {
                    throw "Repair branch '$Branch' already exists at '$existingRepairBranch'."
                }
                Invoke-Git @(
                    '-c', 'protocol.version=2', '-c', 'credential.interactive=never',
                    ('--git-dir=' + $temp), 'fetch', '--filter=tree:0', '--depth=2',
                    'origin',
                    ('refs/heads/' + $Branch + ':refs/remotes/origin/repair')
                ) | Out-Null
                $repairCommit = @(
                    Invoke-Git @(
                        ('--git-dir=' + $temp), 'rev-parse',
                        'refs/remotes/origin/repair'
                    )
                ) | Select-Object -Last 1
                if ([string]$repairCommit -ne $existingRepairBranch) {
                    throw "Fetched repair '$repairCommit' did not equal remote '$existingRepairBranch'."
                }
                $repairParent = @(
                    Invoke-Git @(
                        ('--git-dir=' + $temp), 'rev-parse',
                        ([string]$repairCommit + '^')
                    )
                ) | Select-Object -Last 1
                if ([string]$repairParent -ne $mainBefore) {
                    throw "Repair parent '$repairParent' did not equal current main '$mainBefore'."
                }
                $parts = @($Path.Replace('\', '/').Split('/') | Where-Object { $_ })
                $nameStatus = @(
                    Invoke-Git @(
                        ('--git-dir=' + $temp), 'diff-tree', '--no-commit-id',
                        '--name-status', '--no-renames', '-r', $mainBefore,
                        [string]$repairCommit
                    )
                )
                if (
                    $nameStatus.Count -ne 1 -or
                    [string]$nameStatus[0] -ne ("M`t$Path")
                ) {
                    throw 'Existing repair branch did not have the exact one-path diff.'
                }
                $repairRoot = Get-CommitTree $temp ([string]$repairCommit)
                $repairBlob = Get-PathBlob $temp $repairRoot $parts
                if ($repairBlob -ne $StableBlobExpected) {
                    throw "Existing repair blob '$repairBlob' did not equal stable blob."
                }
                $pushOutput = @(
                    Invoke-Git @(
                        '-c', 'credential.interactive=never',
                        ('--git-dir=' + $temp), 'push', 'origin',
                        ('refs/remotes/origin/repair:refs/heads/main')
                    )
                )
                $mainAfter = Get-RemoteSha 'refs/heads/main'
                if ($mainAfter -ne [string]$repairCommit) {
                    throw "main '$mainAfter' did not verify as repair '$repairCommit'."
                }
                $mainRoot = Get-CommitTree $temp $mainAfter
                $mainBlobAfter = Get-PathBlob $temp $mainRoot $parts
                if ($mainBlobAfter -ne $StableBlobExpected) {
                    throw "Promoted main blob '$mainBlobAfter' did not equal stable blob."
                }
                return ([pscustomobject]@{
                    originMainBefore = $mainBefore
                    contaminationCommit = $BadCommit
                    badBlob = $BadBlobExpected
                    stableBlob = $StableBlobExpected
                    repairCommit = [string]$repairCommit
                    repairBranch = $Branch
                    remoteBranch = $existingRepairBranch
                    nameStatus = $nameStatus
                    pushOutput = $pushOutput
                    mainAfter = $mainAfter
                    mainBlobAfter = $mainBlobAfter
                    merged = $true
                    promotedDirectly = $true
                } | ConvertTo-Json -Depth 8 -Compress)
            }
            Invoke-Git @(
                '-c', 'protocol.version=2', '-c', 'credential.interactive=never',
                ('--git-dir=' + $temp), 'fetch', '--filter=tree:0', '--depth=1',
                'origin', 'refs/heads/main:refs/remotes/origin/main'
            ) | Out-Null
            $fetchedTip = @(
                Invoke-Git @(('--git-dir=' + $temp), 'rev-parse', 'refs/remotes/origin/main')
            ) | Select-Object -Last 1
            if ([string]$fetchedTip -ne $mainBefore) {
                throw "Fetched tip '$fetchedTip' did not equal main '$mainBefore'."
            }

            $rootTree = Get-CommitTree $temp $mainBefore
            $parts = @($Path.Replace('\', '/').Split('/') | Where-Object { $_ })
            $badBlob = Get-PathBlob $temp $rootTree $parts
            if ($badBlob -ne $BadBlobExpected) {
                throw "Current main blob '$badBlob' did not equal '$BadBlobExpected'."
            }
            $storedStableBlob = @(
                Invoke-Git @(
                    ('--git-dir=' + $temp), 'hash-object', '-w', '--',
                    (Join-Path $ProjectPath $Path)
                )
            ) | Select-Object -Last 1
            if ([string]$storedStableBlob -ne $StableBlobExpected) {
                throw "Stored stable blob '$storedStableBlob' did not verify."
            }

            $levels = New-Object System.Collections.Generic.List[object]
            $currentTree = $rootTree
            for ($index = 0; $index -lt $parts.Count - 1; $index += 1) {
                $entries = @(Get-TreeEntries $temp $currentTree)
                $entry = Find-TreeEntry $entries $parts[$index]
                if ([string]$entry.type -ne 'tree') {
                    throw "Path component '$($parts[$index])' was not a tree."
                }
                $levels.Add([pscustomobject]@{
                    entries = $entries
                    childName = $parts[$index]
                })
                $currentTree = [string]$entry.oid
            }
            $leafEntries = @(Get-TreeEntries $temp $currentTree)
            $newTree = Write-TreeEntries `
                -GitDirectory $temp `
                -Entries $leafEntries `
                -ReplaceName $parts[-1] `
                -ReplaceOid $StableBlobExpected
            for ($index = $levels.Count - 1; $index -ge 0; $index -= 1) {
                $level = $levels[$index]
                $newTree = Write-TreeEntries `
                    -GitDirectory $temp `
                    -Entries @($level.entries) `
                    -ReplaceName ([string]$level.childName) `
                    -ReplaceOid $newTree
            }

            $env:GIT_AUTHOR_NAME = 'Relay Unity Orchestrator'
            $env:GIT_AUTHOR_EMAIL = 'relay-unity-orchestrator@localhost'
            $env:GIT_COMMITTER_NAME = $env:GIT_AUTHOR_NAME
            $env:GIT_COMMITTER_EMAIL = $env:GIT_AUTHOR_EMAIL
            $repairCommit = @(
                Invoke-Git @(
                    ('--git-dir=' + $temp), 'commit-tree', $newTree,
                    '-p', $mainBefore,
                    '-m', 'fix(unity): revert unintended Launcher scene drift from task #76'
                )
            ) | Select-Object -Last 1
            Invoke-Git @(
                ('--git-dir=' + $temp), 'update-ref', ('refs/heads/' + $Branch),
                [string]$repairCommit
            ) | Out-Null
            $nameStatus = @(
                Invoke-Git @(
                    ('--git-dir=' + $temp), 'diff-tree', '--no-commit-id',
                    '--name-status', '--no-renames', '-r', $mainBefore,
                    [string]$repairCommit
                )
            )
            if (
                $nameStatus.Count -ne 1 -or
                [string]$nameStatus[0] -ne ("M`t$Path")
            ) {
                throw "Repair commit file set was not exact: $([string]::Join('; ', $nameStatus))."
            }
            $repairRoot = Get-CommitTree $temp ([string]$repairCommit)
            $repairBlob = Get-PathBlob $temp $repairRoot $parts
            if ($repairBlob -ne $StableBlobExpected) {
                throw "Repair commit blob '$repairBlob' did not equal stable blob."
            }

            $pushOutput = @(
                Invoke-Git @(
                    '-c', 'credential.interactive=never', ('--git-dir=' + $temp),
                    'push', 'origin',
                    ([string]$repairCommit + ':refs/heads/' + $Branch),
                    '-o', 'merge_request.create',
                    '-o', 'merge_request.target=main',
                    '-o', 'merge_request.merge_when_pipeline_succeeds',
                    '-o', 'merge_request.remove_source_branch',
                    '-o', ('merge_request.title=' + $MrTitle)
                )
            )
            $remoteBranch = Get-RemoteSha ('refs/heads/' + $Branch)
            if ($remoteBranch -ne [string]$repairCommit) {
                throw "Remote repair branch '$remoteBranch' did not verify."
            }

            $mainAfter = $mainBefore
            $mainBlobAfter = $badBlob
            for ($attempt = 1; $attempt -le 10; $attempt += 1) {
                Start-Sleep -Seconds 2
                $candidateMain = Get-RemoteSha 'refs/heads/main'
                if ($candidateMain -eq $mainBefore) { continue }
                Invoke-Git @(
                    '-c', 'protocol.version=2', '-c', 'credential.interactive=never',
                    ('--git-dir=' + $temp), 'fetch', '--filter=tree:0', '--depth=1',
                    'origin', $candidateMain
                ) | Out-Null
                $candidateRoot = Get-CommitTree $temp $candidateMain
                $candidateBlob = Get-PathBlob $temp $candidateRoot $parts
                $mainAfter = $candidateMain
                $mainBlobAfter = $candidateBlob
                if ($candidateBlob -eq $StableBlobExpected) { break }
            }

            [pscustomobject]@{
                originMainBefore = $mainBefore
                contaminationCommit = $BadCommit
                badBlob = $badBlob
                stableBlob = $StableBlobExpected
                repairCommit = [string]$repairCommit
                repairBranch = $Branch
                remoteBranch = $remoteBranch
                nameStatus = $nameStatus
                pushOutput = $pushOutput
                mainAfter = $mainAfter
                mainBlobAfter = $mainBlobAfter
                merged = $mainBlobAfter -eq $StableBlobExpected
            } | ConvertTo-Json -Depth 8 -Compress
        } finally {
            $env:GIT_AUTHOR_NAME = $null
            $env:GIT_AUTHOR_EMAIL = $null
            $env:GIT_COMMITTER_NAME = $null
            $env:GIT_COMMITTER_EMAIL = $null
            if (Test-Path -LiteralPath $temp) {
                $resolved = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $temp).Path)
                if (-not $resolved.StartsWith(
                    $tempRoot + '\',
                    [StringComparison]::OrdinalIgnoreCase
                )) {
                    throw 'Refusing to remove a temporary repository outside TEMP.'
                }
                Get-ChildItem -LiteralPath $resolved -Recurse -Force `
                    -ErrorAction SilentlyContinue |
                    ForEach-Object { try { $_.Attributes = 'Normal' } catch {} }
                Remove-Item -LiteralPath $resolved -Recurse -Force
            }
        }
    }

$records = @(
    $remoteOutput |
        ForEach-Object { ([string]$_).Trim() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)
if ($records.Count -ne 1) {
    throw "Exact remote path repair returned $($records.Count) records; expected one."
}
$records[0]
