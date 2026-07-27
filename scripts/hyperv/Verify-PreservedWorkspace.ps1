[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TaskBranch,
    [string]$ExpectedHead,
    [AllowNull()][string]$AuditedFilesJson
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function ConvertFrom-AuditedFilesJson {
    param([AllowNull()][string]$Json)

    if ([string]::IsNullOrWhiteSpace($Json)) {
        return ,([object[]]@())
    }
    try {
        $decoded = $Json | ConvertFrom-Json
    } catch {
        throw "AuditedFilesJson was not valid JSON: $($_.Exception.Message)"
    }
    if ($null -eq $decoded) {
        return ,([object[]]@())
    }
    $items = [object[]]@($decoded)
    foreach ($item in $items) {
        if ($null -eq $item -or $item -isnot [psobject]) {
            throw 'AuditedFilesJson must contain an array of audited file objects or null.'
        }
    }
    return ,$items
}

function ConvertTo-VerificationArray {
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
$guestScriptPath = Join-Path $PSScriptRoot 'Verify-PreservedWorkspace.Guest.ps1'
foreach ($requiredScript in @($helperPath, $guestScriptPath)) {
    if (-not (Test-Path -LiteralPath $requiredScript -PathType Leaf)) {
        throw "Preserved workspace verification script '$requiredScript' was not found."
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
$auditedFiles = ConvertFrom-AuditedFilesJson -Json $AuditedFilesJson
$normalizedAuditedFilesJson = ConvertTo-Json `
    -InputObject ([object[]]$auditedFiles) `
    -Depth 12 `
    -Compress

# A nested array inside an array expression is enumerated by Windows
# PowerShell. Populate fixed slots so the normalized JSON remains exactly one
# PowerShell Direct argument for empty, single-file, and multi-file audits.
$argumentList = New-Object object[] 6
$argumentList[0] = $GuestProjectPath
$argumentList[1] = $TaskBranch
$argumentList[2] = $ExpectedHead
$argumentList[3] = $normalizedAuditedFilesJson
$argumentList[4] = $helperSource
$argumentList[5] = $guestSource
$remoteOutput = @(
    Invoke-Command -VMName $VMName -Credential $credential `
        -ArgumentList $argumentList `
        -ScriptBlock {
            param(
                $ProjectPath,
                $ExpectedBranch,
                $ExpectedHead,
                $AuditedFilesJson,
                $HelperSource,
                $GuestSource
            )
            $ErrorActionPreference = 'Stop'
            Set-StrictMode -Version Latest
            . ([scriptblock]::Create($HelperSource))
            & ([scriptblock]::Create($GuestSource)) `
                -ProjectPath $ProjectPath `
                -ExpectedBranch $ExpectedBranch `
                -ExpectedHead $ExpectedHead `
                -AuditedFilesJson $AuditedFilesJson `
                -OutputJson
        }
)
$remoteRecords = @(
    $remoteOutput |
        ForEach-Object { ([string]$_).Trim() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)
if ($remoteRecords.Count -ne 1) {
    throw "Guest workspace verification returned $($remoteRecords.Count) success-stream records; exactly one JSON object was required."
}
try {
    $guestResult = $remoteRecords[0] | ConvertFrom-Json
} catch {
    throw "Guest workspace verification did not return valid JSON: $($_.Exception.Message)"
}
if ($null -eq $guestResult -or $guestResult -isnot [psobject]) {
    throw 'Guest workspace verification returned JSON that was not an object.'
}
$guestResult = $guestResult | Select-Object -Property @(
    'ready', 'preserved', 'code', 'message', 'projectPath', 'branch', 'head',
    'expectedBranch', 'expectedHead', 'changedFiles', 'status', 'auditedFiles'
)
$result = [pscustomobject]@{
    ready = [bool]$guestResult.ready
    preserved = [bool]$guestResult.preserved
    code = $guestResult.code
    message = $guestResult.message
    projectPath = $guestResult.projectPath
    branch = $guestResult.branch
    head = $guestResult.head
    expectedBranch = $guestResult.expectedBranch
    expectedHead = $guestResult.expectedHead
    changedFiles = [int]$guestResult.changedFiles
    status = [object[]](ConvertTo-VerificationArray -Value $guestResult.status)
    auditedFiles = [object[]](ConvertTo-VerificationArray -Value $guestResult.auditedFiles)
    transport = [pscustomobject]@{
        boundary = 'PowerShellDirect'
        resultRecords = $remoteRecords.Count
        auditedFilesParameters = 1
        auditedFilesCount = $auditedFiles.Count
    }
}

$result | ConvertTo-Json -Depth 12 -Compress
