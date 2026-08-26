[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TaskBranch,
    [AllowNull()][string]$ExpectedHead,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ChangedFilesJson,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ValidationJson,
    [AllowNull()][string]$ExpectedAuditJson,
    [ValidateNotNullOrEmpty()][string]$ApprovedOverlayPathsJson = '[]'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'Credential.ps1')

$credential = Import-RelayCredential -Path $CredentialPath
$helperPath = Join-Path $PSScriptRoot 'Workspace-Git.ps1'
$guestScriptPath = Join-Path $PSScriptRoot 'Get-DeliveryWorkspaceAudit.Guest.ps1'
foreach ($requiredScript in @($helperPath, $guestScriptPath)) {
    if (-not (Test-Path -LiteralPath $requiredScript -PathType Leaf)) {
        throw "Delivery workspace audit script '$requiredScript' was not found."
    }
}
$helperSource = [System.IO.File]::ReadAllText(
    $helperPath,
    [System.Text.Encoding]::UTF8
)
$guestSource = [System.IO.File]::ReadAllText(
    $guestScriptPath,
    [System.Text.Encoding]::UTF8
)

$argumentList = New-Object object[] 9
$argumentList[0] = $GuestProjectPath
$argumentList[1] = $TaskBranch
$argumentList[2] = $ExpectedHead
$argumentList[3] = $ChangedFilesJson
$argumentList[4] = $ValidationJson
$argumentList[5] = $ExpectedAuditJson
$argumentList[6] = $ApprovedOverlayPathsJson
$argumentList[7] = $helperSource
$argumentList[8] = $guestSource

$remoteOutput = @(
    Invoke-Command -VMName $VMName -Credential $credential `
        -ArgumentList $argumentList `
        -ScriptBlock {
            param(
                $ProjectPath,
                $ExpectedBranch,
                $ExpectedHead,
                $ChangedFilesJson,
                $ValidationJson,
                $ExpectedAuditJson,
                $ApprovedOverlaysJson,
                $HelperSource,
                $GuestSource
            )
            $ErrorActionPreference = 'Stop'
            Set-StrictMode -Version Latest
            $env:RELAY_APPROVED_OVERLAY_PATHS_JSON = $ApprovedOverlaysJson
            . ([scriptblock]::Create($HelperSource))
            & ([scriptblock]::Create($GuestSource)) `
                -ProjectPath $ProjectPath `
                -ExpectedBranch $ExpectedBranch `
                -ExpectedHead $ExpectedHead `
                -ChangedFilesJson $ChangedFilesJson `
                -ValidationJson $ValidationJson `
                -ExpectedAuditJson $ExpectedAuditJson `
                -OutputJson
        }
)
$remoteRecords = @(
    $remoteOutput |
        ForEach-Object { ([string]$_).Trim() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)
if ($remoteRecords.Count -ne 1) {
    throw "Guest delivery workspace audit returned $($remoteRecords.Count) success-stream records; exactly one JSON object was required."
}
try {
    $guestResult = $remoteRecords[0] | ConvertFrom-Json
} catch {
    throw "Guest delivery workspace audit did not return valid JSON: $($_.Exception.Message)"
}
if ($null -eq $guestResult -or $guestResult -isnot [psobject]) {
    throw 'Guest delivery workspace audit returned JSON that was not an object.'
}
$guestResult | ConvertTo-Json -Depth 16 -Compress
