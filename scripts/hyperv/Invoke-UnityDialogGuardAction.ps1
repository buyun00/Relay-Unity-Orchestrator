[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$DialogId,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ButtonId,
    [ValidateNotNullOrEmpty()][string]$RequestedBy = 'relay-codex',
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Rationale,
    [bool]$Remember = $true,
    [switch]$AllowHighRisk,
    [ValidateRange(2, 30)][int]$TimeoutSeconds = 10,
    [string]$ControlDirectory = 'C:\ProgramData\Relay\UnityDialogGuard\control'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'Credential.ps1')
$credential = Import-RelayCredential -Path $CredentialPath
$requestId = [Guid]::NewGuid().ToString('N')

$response = Invoke-Command -VMName $VMName -Credential $credential -ArgumentList @(
    $ControlDirectory,
    $requestId,
    $DialogId,
    $ButtonId,
    $RequestedBy,
    $Rationale,
    $Remember,
    [bool]$AllowHighRisk,
    $TimeoutSeconds
) -ScriptBlock {
    param(
        $ControlPath,
        $RequestId,
        $RequestedDialogId,
        $RequestedButtonId,
        $Actor,
        $Reason,
        $RememberDecision,
        $HighRiskAuthorized,
        $Timeout
    )
    $ErrorActionPreference = 'Stop'
    $requestDirectory = Join-Path $ControlPath 'requests'
    $responseDirectory = Join-Path $ControlPath 'responses'
    New-Item -ItemType Directory -Path $requestDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $responseDirectory -Force | Out-Null
    $requestPath = Join-Path $requestDirectory ($RequestId + '.json')
    $temporaryPath = $requestPath + '.tmp'
    $responsePath = Join-Path $responseDirectory ($RequestId + '.json')
    [pscustomobject]@{
        schemaVersion = 1
        requestId = $RequestId
        dialogId = $RequestedDialogId
        buttonId = $RequestedButtonId
        requestedBy = $Actor
        rationale = $Reason
        remember = [bool]$RememberDecision
        allowHighRisk = [bool]$HighRiskAuthorized
    } | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $requestPath

    $deadline = [DateTime]::UtcNow.AddSeconds($Timeout)
    do {
        if (Test-Path -LiteralPath $responsePath -PathType Leaf) {
            $json = Get-Content -LiteralPath $responsePath -Raw -Encoding UTF8
            Remove-Item -LiteralPath $responsePath -Force
            return $json
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "UnityDialogGuard did not answer request '$RequestId' within $Timeout seconds."
} -ErrorAction Stop

$response
