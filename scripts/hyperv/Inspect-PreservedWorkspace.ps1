[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function ConvertTo-InspectionArray {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) {
        return ,([object[]]@())
    }
    return ,([object[]]@($Value))
}

$credential = Import-Clixml -LiteralPath ([System.IO.Path]::GetFullPath($CredentialPath))
if ($credential -isnot [System.Management.Automation.PSCredential]) {
    throw 'CredentialPath did not contain a PSCredential.'
}

$helperPath = Join-Path $PSScriptRoot 'Workspace-Git.ps1'
$guestScriptPath = Join-Path $PSScriptRoot 'Inspect-PreservedWorkspace.Guest.ps1'
foreach ($requiredScript in @($helperPath, $guestScriptPath)) {
    if (-not (Test-Path -LiteralPath $requiredScript -PathType Leaf)) {
        throw "Preserved workspace inspection script '$requiredScript' was not found."
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
$remoteOutput = @(
    Invoke-Command -VMName $VMName -Credential $credential -ArgumentList @(
        $GuestProjectPath, $helperSource, $guestSource
    ) -ScriptBlock {
        param($ProjectPath, $HelperSource, $GuestSource)
        $ErrorActionPreference = 'Stop'
        Set-StrictMode -Version Latest
        . ([scriptblock]::Create($HelperSource))
        & ([scriptblock]::Create($GuestSource)) -ProjectPath $ProjectPath
    }
)
if ($remoteOutput.Count -ne 1) {
    throw "Guest workspace inspection returned $($remoteOutput.Count) success-stream records; exactly one structured result was required."
}
$guestResult = $remoteOutput[0]
if ($null -eq $guestResult -or $guestResult -isnot [psobject]) {
    throw 'Guest workspace inspection did not return a structured result.'
}
$guestResult = $guestResult | Select-Object -Property @(
    'ready', 'code', 'message', 'projectPath', 'repositoryExists', 'branch',
    'head', 'statusBefore', 'auditedFiles', 'auditFingerprint', 'audit',
    'porcelainV2', 'untrackedFiles'
)

$auditedFiles = ConvertTo-InspectionArray -Value $guestResult.auditedFiles
$audit = $null
if ($null -ne $guestResult.audit) {
    $auditChanges = ConvertTo-InspectionArray -Value $guestResult.audit.changes
    if ($null -eq $guestResult.auditedFiles) {
        $auditedFiles = $auditChanges
    }
    $audit = [pscustomobject]@{
        version = $guestResult.audit.version
        branch = $guestResult.audit.branch
        head = $guestResult.audit.head
        fingerprint = $guestResult.audit.fingerprint
        changes = [object[]]$auditChanges
    }
}
$result = [pscustomobject]@{
    ready = [bool]$guestResult.ready
    code = $guestResult.code
    message = $guestResult.message
    projectPath = $guestResult.projectPath
    repositoryExists = [bool]$guestResult.repositoryExists
    branch = $guestResult.branch
    head = $guestResult.head
    statusBefore = [object[]](ConvertTo-InspectionArray -Value $guestResult.statusBefore)
    auditedFiles = [object[]]$auditedFiles
    auditFingerprint = $guestResult.auditFingerprint
    audit = $audit
    porcelainV2 = [object[]](ConvertTo-InspectionArray -Value $guestResult.porcelainV2)
    untrackedFiles = [object[]](ConvertTo-InspectionArray -Value $guestResult.untrackedFiles)
    transport = [pscustomobject]@{
        boundary = 'PowerShellDirect'
        resultRecords = $remoteOutput.Count
        auditedFilesCount = $auditedFiles.Count
    }
}

$result | ConvertTo-Json -Depth 12 -Compress
