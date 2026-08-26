$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$fixture = Join-Path $tempBase ("relay-meta-policy-$([Guid]::NewGuid().ToString('N'))")
New-Item -ItemType Directory -Path $fixture -ErrorAction Stop | Out-Null

try {
    & git -C $fixture init --quiet
    & git -C $fixture config user.name Test
    & git -C $fixture config user.email test@example.invalid
    Set-Content -LiteralPath (Join-Path $fixture 'asset.meta') -Value 'remote-meta' -NoNewline
    Set-Content -LiteralPath (Join-Path $fixture 'code.txt') -Value 'remote-code' -NoNewline
    & git -C $fixture add -- asset.meta code.txt
    & git -C $fixture commit --quiet -m baseline
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to create the checkpoint meta policy fixture.'
    }

    $ProjectPath = $fixture
    function Get-RelayGitValue {
        param(
            [string]$RepositoryPath,
            [object[]]$Arguments,
            [hashtable]$Environment = @{}
        )
        $value = @(& git -C $RepositoryPath @Arguments)
        if ($LASTEXITCODE -ne 0) {
            throw "git failed: $($Arguments -join ' ')"
        }
        return ($value -join [Environment]::NewLine).Trim()
    }
    function Invoke-RelayGit {
        param(
            [string]$RepositoryPath,
            [object[]]$Arguments,
            [hashtable]$Environment = @{},
            [int]$TimeoutSeconds = 120,
            [string]$Stage = 'test'
        )
        $value = @(& git -C $RepositoryPath @Arguments)
        if ($LASTEXITCODE -ne 0) {
            throw "git failed at ${Stage}: $($Arguments -join ' ')"
        }
        return $value
    }
    function Get-WorkspaceStatusEvidence([object[]]$Status) {
        return @($Status | ForEach-Object {
            $item = $_
            $absolute = Join-Path $ProjectPath $item.path
            $headBlob = if ([string]$item.code -eq '??') {
                $null
            } else {
                $head = @(& git -C $ProjectPath rev-parse --verify "HEAD:$($item.path)")
                if ($LASTEXITCODE -ne 0) {
                    throw "Failed to resolve fixture HEAD blob for '$($item.path)'."
                }
                ($head -join '').Trim()
            }
            $worktreeBlob = if (Test-Path -LiteralPath $absolute -PathType Leaf) {
                (@(& git -C $ProjectPath hash-object -- $item.path) -join '').Trim()
            } else {
                $null
            }
            [pscustomobject]@{
                path = $item.path
                headBlob = $headBlob
                worktreeBlob = $worktreeBlob
                sha256 = if (Test-Path -LiteralPath $absolute -PathType Leaf) {
                    $hasher = [System.Security.Cryptography.SHA256]::Create()
                    try {
                        $bytes = [System.IO.File]::ReadAllBytes($absolute)
                        ([System.BitConverter]::ToString(
                            $hasher.ComputeHash([byte[]]$bytes)
                        )).Replace('-', '').ToLowerInvariant()
                    } finally {
                        $hasher.Dispose()
                    }
                } else {
                    $null
                }
            }
        })
    }

    $tokens = $null
    $parseErrors = $null
    $scriptPath = Join-Path $PSScriptRoot '..\..\scripts\hyperv\Update-ProjectReadyCheckpoint.ps1'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        [System.IO.Path]::GetFullPath($scriptPath),
        [ref]$tokens,
        [ref]$parseErrors
    )
    if ($parseErrors.Count -gt 0) {
        throw ($parseErrors | Out-String)
    }
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq 'Restore-RemoteMetaOnlyWorkspace'
    }, $true)
    if ($null -eq $functionAst) {
        throw 'Restore-RemoteMetaOnlyWorkspace AST not found.'
    }
    Invoke-Expression $functionAst.Extent.Text

    Set-Content -LiteralPath (Join-Path $fixture 'asset.meta') -Value 'unity-meta' -NoNewline
    $metaOnly = @([pscustomobject]@{
        code = ' M'
        path = 'asset.meta'
        originalPath = $null
    })
    $restored = @(Restore-RemoteMetaOnlyWorkspace $metaOnly)
    if ($restored.Count -ne 1 -or
        (Get-Content -LiteralPath (Join-Path $fixture 'asset.meta') -Raw) -ne 'remote-meta') {
        throw 'Tracked Unity meta drift was not restored to HEAD.'
    }
    if (@(& git -C $fixture status --porcelain --untracked-files=all).Count -ne 0) {
        throw 'Tracked meta restoration did not leave a clean workspace.'
    }

    Set-Content -LiteralPath (Join-Path $fixture 'asset.meta') -Value 'unity-meta-2' -NoNewline
    Set-Content -LiteralPath (Join-Path $fixture 'code.txt') -Value 'user-code' -NoNewline
    $mixed = @(
        [pscustomobject]@{ code = ' M'; path = 'asset.meta'; originalPath = $null },
        [pscustomobject]@{ code = ' M'; path = 'code.txt'; originalPath = $null }
    )
    if (@(Restore-RemoteMetaOnlyWorkspace $mixed).Count -ne 0) {
        throw 'Mixed workspace was touched.'
    }
    if ((Get-Content -LiteralPath (Join-Path $fixture 'asset.meta') -Raw) -ne 'unity-meta-2' -or
        (Get-Content -LiteralPath (Join-Path $fixture 'code.txt') -Raw) -ne 'user-code') {
        throw 'Mixed workspace content changed.'
    }

    & git -C $fixture restore --worktree -- asset.meta code.txt
    Set-Content -LiteralPath (Join-Path $fixture 'new.asset.meta') -Value 'unity-new-meta' -NoNewline
    $untracked = @([pscustomobject]@{
        code = '??'
        path = 'new.asset.meta'
        originalPath = $null
    })
    $removed = @(Restore-RemoteMetaOnlyWorkspace $untracked)
    if ($removed.Count -ne 1 -or (Test-Path -LiteralPath (Join-Path $fixture 'new.asset.meta'))) {
        throw 'Untracked Unity meta drift was not removed.'
    }

    Set-Content -LiteralPath (Join-Path $fixture 'asset.meta') -Value 'staged-meta' -NoNewline
    & git -C $fixture add -- asset.meta
    $staged = @([pscustomobject]@{
        code = 'M '
        path = 'asset.meta'
        originalPath = $null
    })
    if (@(Restore-RemoteMetaOnlyWorkspace $staged).Count -ne 0) {
        throw 'Staged meta evidence was touched.'
    }
    & git -C $fixture diff --cached --quiet -- asset.meta
    if ($LASTEXITCODE -ne 1) {
        throw 'Staged meta evidence was not preserved.'
    }

    [pscustomobject]@{
        trackedMetaRestored = $true
        mixedWorkspacePreserved = $true
        untrackedMetaRemoved = $true
        stagedMetaPreserved = $true
    } | ConvertTo-Json -Compress
} finally {
    $resolvedFixture = [System.IO.Path]::GetFullPath($fixture)
    if (-not $resolvedFixture.StartsWith(
        $tempBase,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Refusing to remove unexpected fixture path '$resolvedFixture'."
    }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force -ErrorAction Stop
}
