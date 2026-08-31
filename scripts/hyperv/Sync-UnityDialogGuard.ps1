[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$VMName,
    [Parameter(Mandatory = $true)][string]$CredentialPath,
    [string]$PackageDirectory = (Join-Path $PSScriptRoot '..\..\.pipeline-data\unity-dialog-guard')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$manifestPath = Join-Path $PackageDirectory 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    return [pscustomobject]@{ changed = $false; reason = 'no-published-package' }
}
$manifest = Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
$executable = Join-Path $PackageDirectory 'UnityDialogGuard.exe'
if ($manifest.schemaVersion -ne 1 -or $manifest.validated -ne $true -or
    (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash -ne $manifest.sha256) {
    throw 'DialogGuard package is not a validated, hash-matched artifact.'
}
. (Join-Path $PSScriptRoot 'Credential.ps1')
$credential = Import-RelayCredential -Path $CredentialPath
$payload = [Convert]::ToBase64String([IO.File]::ReadAllBytes($executable))
$ruleJson = $manifest.additiveRule | ConvertTo-Json -Depth 20 -Compress
Invoke-Command -VMName $VMName -Credential $credential `
    -FilePath (Join-Path $PSScriptRoot 'Sync-UnityDialogGuard.Guest.ps1') `
    -ArgumentList $payload, $manifest.sha256, $manifest.version, $ruleJson
