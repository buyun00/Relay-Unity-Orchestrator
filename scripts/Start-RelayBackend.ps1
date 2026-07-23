[CmdletBinding()]
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [System.IO.Path]::GetFullPath($ProjectRoot)
$entry = Join-Path $root 'server\index.mjs'
if (-not (Test-Path -LiteralPath $entry)) {
    throw "Relay backend entrypoint was not found: $entry"
}

Push-Location $root
try {
    & node $entry
    if ($LASTEXITCODE -ne 0) { throw "Relay backend exited with code $LASTEXITCODE." }
} finally {
    Pop-Location
}
