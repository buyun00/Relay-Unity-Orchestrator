[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^https?://')][string]$UnitySaveUrl,
    [ValidateRange(10, 300)][int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'Credential.ps1')
$credential = Import-RelayCredential -Path $CredentialPath

$result = Invoke-Command -VMName $VMName -Credential $credential -ArgumentList @($UnitySaveUrl, $TimeoutSeconds) -ScriptBlock {
    param($SaveUrl, $Timeout)

    $uri = [Uri]$SaveUrl
    $isUnitySkillsRest = $uri.AbsolutePath.TrimEnd('/') -ieq '/skill/editor_execute_menu'
    if ($isUnitySkillsRest) {
        $body = @{ menuPath = 'File/Save' } | ConvertTo-Json -Compress
        $separator = if ($SaveUrl.Contains('?')) { '&' } else { '?' }
        $dryRunUrl = "${SaveUrl}${separator}mode=dryRun"
        $dryRunResponse = Invoke-WebRequest -Uri $dryRunUrl -Method Post -ContentType 'application/json' -Body $body `
            -UseBasicParsing -TimeoutSec $Timeout -ErrorAction Stop
        $dryRun = $dryRunResponse.Content | ConvertFrom-Json
        if ($dryRunResponse.StatusCode -lt 200 -or $dryRunResponse.StatusCode -ge 300 -or `
            $dryRun.status -ne 'dryRun' -or -not [bool]$dryRun.valid) {
            throw "UnitySkills save dry-run was not valid: $($dryRunResponse.Content)"
        }

        $response = Invoke-WebRequest -Uri $SaveUrl -Method Post -ContentType 'application/json' -Body $body `
            -UseBasicParsing -TimeoutSec $Timeout -ErrorAction Stop
        $execution = $response.Content | ConvertFrom-Json
        if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300 -or `
            $execution.status -ne 'success' -or $execution.result.executed -ne 'File/Save') {
            throw "UnitySkills save failed: $($response.Content)"
        }
        [pscustomobject]@{
            saved = $true
            statusCode = $response.StatusCode
            provider = 'UnitySkillsRest'
        }
    } else {
        $body = @{ action = 'saveAll'; waitForCompletion = $true } | ConvertTo-Json -Compress
        $response = Invoke-WebRequest -Uri $SaveUrl -Method Post -ContentType 'application/json' -Body $body `
            -UseBasicParsing -TimeoutSec $Timeout -ErrorAction Stop
        if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
            throw "Unity save endpoint returned HTTP $($response.StatusCode)."
        }
        [pscustomobject]@{
            saved = $true
            statusCode = $response.StatusCode
            provider = 'Custom'
        }
    }
}

[pscustomobject]@{
    vmName = $VMName
    saved = [bool]$result.saved
    statusCode = [int]$result.statusCode
    provider = [string]$result.provider
} | ConvertTo-Json -Compress
