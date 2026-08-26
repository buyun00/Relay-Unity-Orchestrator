[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ShareRoot,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$FullAccessPrincipal
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

if ($ShareRoot -notmatch '^\\\\([^\\]+)\\([^\\]+)$') {
    throw "ShareRoot '$ShareRoot' must be an exact UNC share root."
}
$shareServer = $Matches[1]
if ($shareServer -ne $VMName) {
    throw "ShareRoot server '$shareServer' does not match VMName '$VMName'."
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Creating an SMB global mapping requires an elevated PowerShell process.'
}

Import-Module SmbShare -ErrorAction Stop
. (Join-Path $PSScriptRoot 'Credential.ps1')

$credential = Import-RelayCredential -Path $CredentialPath
if ($credential.UserName -notmatch '[\\@]') {
    $credential = New-Object System.Management.Automation.PSCredential(
        "$shareServer\$($credential.UserName)",
        $credential.Password
    )
}

$existing = @(
    Get-SmbGlobalMapping -RemotePath $ShareRoot -ErrorAction SilentlyContinue |
        Where-Object { $_.RemotePath -eq $ShareRoot }
)
if ($existing.Count -gt 1) {
    throw "Found more than one SMB global mapping for '$ShareRoot'."
}
$reconnected = $false
if ($existing.Count -eq 1 -and $existing[0].Status.ToString() -ne 'OK') {
    Remove-SmbGlobalMapping `
        -RemotePath $ShareRoot `
        -Force `
        -ErrorAction Stop
    $existing = @()
    $reconnected = $true
}
$created = $existing.Count -eq 0
if ($existing.Count -eq 0) {
    New-SmbGlobalMapping `
        -RemotePath $ShareRoot `
        -Credential $credential `
        -Persistent $true `
        -FullAccess @($FullAccessPrincipal) `
        -ErrorAction Stop | Out-Null
}

$mapping = @(
    Get-SmbGlobalMapping -RemotePath $ShareRoot -ErrorAction Stop |
        Where-Object { $_.RemotePath -eq $ShareRoot }
)
if ($mapping.Count -ne 1) {
    throw "Failed to verify the SMB global mapping for '$ShareRoot'."
}

[pscustomobject]@{
    vmName = $VMName
    shareRoot = $ShareRoot
    fullAccessPrincipal = $FullAccessPrincipal
    status = $mapping[0].Status.ToString()
    persistent = $true
    created = $created
    reconnected = $reconnected
} | ConvertTo-Json -Compress
