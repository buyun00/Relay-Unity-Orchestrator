[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RepoUrl,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$BaseBranch,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TaskBranch,
    [Parameter(Mandatory = $true)][ValidateSet('new', 'resume', 'recovery')][string]$Mode,
    [ValidateNotNullOrEmpty()][string]$GitAuthorName = 'Relay Unity Orchestrator',
    [ValidateNotNullOrEmpty()][string]$GitAuthorEmail = 'relay-unity-orchestrator@localhost',
    [string]$AuditJson,
    [string]$SharePath,
    [string]$UnityHealthUrl,
    [ValidateRange(30, 900)][int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$credential = Import-Clixml -LiteralPath ([System.IO.Path]::GetFullPath($CredentialPath))
if ($credential -isnot [System.Management.Automation.PSCredential]) {
    throw 'CredentialPath did not contain a PSCredential.'
}

$helperPath = Join-Path $PSScriptRoot 'Workspace-Git.ps1'
$guestScriptPath = Join-Path $PSScriptRoot 'Prepare-Workspace.Guest.ps1'
foreach ($requiredScript in @($helperPath, $guestScriptPath)) {
    if (-not (Test-Path -LiteralPath $requiredScript -PathType Leaf)) {
        throw "Guest workspace preparation script '$requiredScript' was not found."
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
$gitResult = Invoke-Command -VMName $VMName -Credential $credential -ArgumentList @(
    $GuestProjectPath, $RepoUrl, $BaseBranch, $TaskBranch, $Mode,
    $GitAuthorName, $GitAuthorEmail, $AuditJson, $helperSource, $guestSource
) -ScriptBlock {
    param(
        $ProjectPath, $RepositoryUrl, $Base, $Branch, $RequestedMode,
        $AuthorName, $AuthorEmail, $AuditJson, $HelperSource, $GuestSource
    )
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    . ([scriptblock]::Create($HelperSource))
    & ([scriptblock]::Create($GuestSource)) `
        -ProjectPath $ProjectPath `
        -RepositoryUrl $RepositoryUrl `
        -Base $Base `
        -Branch $Branch `
        -RequestedMode $RequestedMode `
        -AuthorName $AuthorName `
        -AuthorEmail $AuthorEmail `
        -AuditJson $AuditJson
}

if (-not [bool]$gitResult.ready) {
    $refusal = $gitResult | Select-Object -Property @(
        'ready', 'code', 'message', 'projectPath', 'originalBranch', 'originalHead',
        'statusBefore', 'porcelainV2Before', 'untrackedFilesBefore', 'blockedPaths',
        'deletionPaths', 'prohibitedPaths', 'unsupportedChanges', 'preservedBranch',
        'preservedCommit', 'preservedTree', 'preservedNameStatus',
        'preservedFiles', 'auditedFiles', 'auditFingerprint', 'reusedPreservation',
        'preservationVerified', 'preTargetCheckoutBranch', 'preTargetCheckoutHead'
    )
    [Console]::Error.WriteLine(
        "RELAY_WORKSPACE_REFUSED:$($refusal | ConvertTo-Json -Depth 12 -Compress)"
    )
    exit 42
}

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$unityReady = $false
$skillReady = [string]::IsNullOrWhiteSpace($UnityHealthUrl)
do {
    $unityReady = [bool](Invoke-Command -VMName $VMName -Credential $credential -ScriptBlock {
        @(Get-Process -Name 'Unity' -ErrorAction SilentlyContinue).Count -gt 0
    })
    $skillReady = [string]::IsNullOrWhiteSpace($UnityHealthUrl)
    if (-not $skillReady) {
        try {
            $healthResponse = Invoke-WebRequest -Uri $UnityHealthUrl -Method Get -UseBasicParsing `
                -TimeoutSec 5 -ErrorAction Stop
            $skillReady = $healthResponse.StatusCode -ge 200 -and $healthResponse.StatusCode -lt 300
        } catch {
            $skillReady = $false
        }
    }
    if ($unityReady -and $skillReady) { break }
    Start-Sleep -Seconds 3
} while ([DateTime]::UtcNow -lt $deadline)

if (-not $unityReady) { throw "Unity did not become ready inside '$VMName'." }
if (-not $skillReady) { throw "Unity health endpoint '$UnityHealthUrl' did not become reachable from the host for '$VMName'." }
if (-not [string]::IsNullOrWhiteSpace($SharePath) -and -not (Test-Path -LiteralPath $SharePath)) {
    throw "Host SMB workspace '$SharePath' is not reachable."
}

[pscustomobject]@{
    vmName = $VMName
    workspace = $gitResult.projectPath
    branch = $gitResult.branch
    head = $gitResult.head
    source = $gitResult.source
    originalBranch = $gitResult.originalBranch
    originalHead = $gitResult.originalHead
    statusBefore = $gitResult.statusBefore
    porcelainV2Before = $gitResult.porcelainV2Before
    untrackedFilesBefore = $gitResult.untrackedFilesBefore
    auditedFiles = $gitResult.auditedFiles
    auditFingerprint = $gitResult.auditFingerprint
    preservedBranch = $gitResult.preservedBranch
    preservedCommit = $gitResult.preservedCommit
    preservedTree = $gitResult.preservedTree
    preservedNameStatus = $gitResult.preservedNameStatus
    preservedFiles = $gitResult.preservedFiles
    reusedPreservation = $gitResult.reusedPreservation
    preservationVerified = $gitResult.preservationVerified
    preTargetCheckoutBranch = $gitResult.preTargetCheckoutBranch
    preTargetCheckoutHead = $gitResult.preTargetCheckoutHead
    unityReady = $unityReady
    skillReady = $skillReady
    smbReady = [string]::IsNullOrWhiteSpace($SharePath) -or (Test-Path -LiteralPath $SharePath)
} | ConvertTo-Json -Depth 8 -Compress
