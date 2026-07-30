[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^https?://')][string]$UnitySaveUrl,
    [ValidatePattern('^https?://')][string]$GuestUnitySkillsEndpoint = 'http://127.0.0.1:8090',
    [ValidateRange(1, 300)][int]$TimeoutSeconds = 90,
    [ValidateRange(1, 30)][int]$ConnectionTimeoutSeconds = 5,
    [ValidateRange(0, 5)][int]$DomainReloadRetryCount = 3,
    [ValidateRange(100, 10000)][int]$DomainReloadRetryDelayMilliseconds = 750
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'Credential.ps1')

$credential = Import-RelayCredential -Path $CredentialPath
$guestScriptPath = Join-Path $PSScriptRoot 'Save-UnityProject.Guest.ps1'
if (-not (Test-Path -LiteralPath $guestScriptPath -PathType Leaf)) {
    throw "Guest Unity save script '$guestScriptPath' was not found."
}
$guestSource = [System.IO.File]::ReadAllText(
    $guestScriptPath,
    [System.Text.Encoding]::UTF8
)

# The configured URL supplies only the save route contract. The HTTP request is
# created in the guest and its authority always comes from this explicit
# loopback endpoint; a worker corporate/LAN address is never contacted here.
$argumentList = New-Object object[] 7
$argumentList[0] = $UnitySaveUrl
$argumentList[1] = $GuestUnitySkillsEndpoint
$argumentList[2] = $TimeoutSeconds
$argumentList[3] = $ConnectionTimeoutSeconds
$argumentList[4] = $DomainReloadRetryCount
$argumentList[5] = $DomainReloadRetryDelayMilliseconds
$argumentList[6] = $guestSource

$remoteOutput = @(
    Invoke-Command -VMName $VMName -Credential $credential `
        -ArgumentList $argumentList `
        -ScriptBlock {
            param(
                $ConfiguredSaveUrl,
                $GuestEndpoint,
                $ResponseTimeout,
                $ConnectionTimeout,
                $RetryCount,
                $RetryDelayMilliseconds,
                $GuestSource
            )
            $ErrorActionPreference = 'Stop'
            Set-StrictMode -Version Latest
            & ([scriptblock]::Create($GuestSource)) `
                -ConfiguredSaveUrl $ConfiguredSaveUrl `
                -GuestUnitySkillsEndpoint $GuestEndpoint `
                -TimeoutSeconds $ResponseTimeout `
                -ConnectionTimeoutSeconds $ConnectionTimeout `
                -DomainReloadRetryCount $RetryCount `
                -DomainReloadRetryDelayMilliseconds $RetryDelayMilliseconds `
                -OutputJson
        }
)
$remoteRecords = @(
    $remoteOutput |
        ForEach-Object { ([string]$_).Trim() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)
if ($remoteRecords.Count -ne 1) {
    throw "Guest Unity save returned $($remoteRecords.Count) success-stream records; exactly one JSON object was required."
}
try {
    $guestResult = $remoteRecords[0] | ConvertFrom-Json
} catch {
    throw "Guest Unity save did not return valid JSON: $($_.Exception.Message)"
}
if ($null -eq $guestResult -or $guestResult -isnot [psobject]) {
    throw 'Guest Unity save returned JSON that was not an object.'
}

[pscustomobject]@{
    vmName = $VMName
    saved = [bool]$guestResult.saved
    statusCode = [int]$guestResult.statusCode
    provider = [string]$guestResult.provider
    endpoint = [string]$guestResult.endpoint
    attempts = [int]$guestResult.attempts
    proxyDisabled = [bool]$guestResult.proxyDisabled
} | ConvertTo-Json -Compress
