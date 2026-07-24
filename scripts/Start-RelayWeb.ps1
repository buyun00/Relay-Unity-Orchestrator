[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$NodePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$root = [System.IO.Path]::GetFullPath($ProjectRoot)
$entry = Join-Path $root 'server\web.mjs'
$clientDirectory = Join-Path $root 'dist\client'
if (-not (Test-Path -LiteralPath $entry)) {
    throw "Relay web entrypoint was not found: $entry"
}
if (-not (Test-Path -LiteralPath $clientDirectory)) {
    throw "Relay web production build was not found: $clientDirectory. Run the build first."
}

$resolvedNode = $null
if (-not [string]::IsNullOrWhiteSpace($NodePath)) {
    $resolvedNode = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
} else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $resolvedNode = $nodeCommand.Source
    } else {
        $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
        if (Test-Path -LiteralPath $bundledNode) {
            $resolvedNode = $bundledNode
        }
    }
}
if (-not $resolvedNode) {
    throw 'Node.js was not found in PATH or the bundled Codex runtime. Pass -NodePath explicitly.'
}

Push-Location $root
try {
    & $resolvedNode '--env-file-if-exists=.env.local' $entry
    if ($LASTEXITCODE -ne 0) { throw "Relay web service exited with code $LASTEXITCODE." }
} finally {
    Pop-Location
}
