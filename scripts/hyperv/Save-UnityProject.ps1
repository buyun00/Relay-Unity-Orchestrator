[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^https?://')][string]$UnitySaveUrl,
    [ValidateRange(10, 300)][int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$credential = Import-Clixml -LiteralPath ([System.IO.Path]::GetFullPath($CredentialPath))
if ($credential -isnot [System.Management.Automation.PSCredential]) {
    throw 'CredentialPath did not contain a PSCredential.'
}

$result = Invoke-Command -VMName $VMName -Credential $credential -ArgumentList @($UnitySaveUrl, $TimeoutSeconds) -ScriptBlock {
    param($SaveUrl, $Timeout)
    $body = @{ action = 'saveAll'; waitForCompletion = $true } | ConvertTo-Json -Compress
    $response = Invoke-WebRequest -Uri $SaveUrl -Method Post -ContentType 'application/json' -Body $body `
        -UseBasicParsing -TimeoutSec $Timeout -ErrorAction Stop
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
        throw "Unity save endpoint returned HTTP $($response.StatusCode)."
    }
    [pscustomobject]@{ saved = $true; statusCode = $response.StatusCode }
}

[pscustomobject]@{
    vmName = $VMName
    saved = [bool]$result.saved
    statusCode = [int]$result.statusCode
} | ConvertTo-Json -Compress
