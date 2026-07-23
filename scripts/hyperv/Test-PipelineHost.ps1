[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$hyperV = $null -ne (Get-Module -ListAvailable -Name Hyper-V)
$node = Get-Command node -ErrorAction SilentlyContinue
$codex = Get-Command codex -ErrorAction SilentlyContinue
$nodeVersion = if ($node) { (& node --version) } else { $null }

[pscustomobject]@{
    hyperVModule = $hyperV
    nodeFound = $null -ne $node
    nodeVersion = $nodeVersion
    codexFound = $null -ne $codex
    codexPath = if ($codex) { $codex.Source } else { $null }
    elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator
    )
} | ConvertTo-Json -Compress
