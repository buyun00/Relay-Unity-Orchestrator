[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$hyperV = $null -ne (Get-Module -ListAvailable -Name Hyper-V)
$node = Get-Command node -ErrorAction SilentlyContinue
$codex = Get-Command codex -ErrorAction SilentlyContinue
$nodeVersion = if ($node) { (& node --version) } else { $null }
$hyperVAccess = $false
$hyperVError = $null
if ($hyperV) {
    try {
        Import-Module Hyper-V -ErrorAction Stop
        $null = @(Get-VM -ErrorAction Stop)
        $hyperVAccess = $true
    } catch {
        $hyperVError = $_.Exception.Message
    }
}
$codexVersion = $null
$codexAuthenticated = $false
if ($codex) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Codex may write its human-readable status to stderr even on success.
        $ErrorActionPreference = 'Continue'
        $versionOutput = @(& $codex.Source --version 2>&1)
        $versionExitCode = $LASTEXITCODE
        $loginOutput = @(& $codex.Source login status 2>&1)
        $loginExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($versionExitCode -eq 0 -and $versionOutput.Count -gt 0) {
        $codexVersion = $versionOutput[-1].ToString().Trim()
    }
    $codexAuthenticated = $loginExitCode -eq 0
}

[pscustomobject]@{
    hyperVModule = $hyperV
    hyperVAccess = $hyperVAccess
    hyperVError = $hyperVError
    nodeFound = $null -ne $node
    nodeVersion = $nodeVersion
    codexFound = $null -ne $codex
    codexPath = if ($codex) { $codex.Source } else { $null }
    codexVersion = $codexVersion
    codexAuthenticated = $codexAuthenticated
    elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator
    )
} | ConvertTo-Json -Compress
