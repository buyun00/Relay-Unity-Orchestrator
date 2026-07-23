[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Destination,

    [string]$UserName
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolvedDestination = [System.IO.Path]::GetFullPath($Destination)
$parent = Split-Path -Parent $resolvedDestination
if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
}

$prompt = 'Enter the local Windows credential used by PowerShell Direct inside this VM.'
$credential = if ([string]::IsNullOrWhiteSpace($UserName)) {
    Get-Credential -Message $prompt
} else {
    Get-Credential -UserName $UserName -Message $prompt
}
if ($null -eq $credential) {
    throw 'Credential entry was cancelled.'
}

$credential | Export-Clixml -LiteralPath $resolvedDestination -Force

[pscustomobject]@{
    credentialPath = $resolvedDestination
    userName = $credential.UserName
    protection = 'Windows DPAPI; readable only by the Windows account that exported it'
} | ConvertTo-Json -Compress
