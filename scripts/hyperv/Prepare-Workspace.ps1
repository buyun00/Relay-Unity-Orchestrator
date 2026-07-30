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
    # Retained for compatibility. Workspace preparation intentionally does not
    # probe or wait for the Unity Skill health endpoint.
    [string]$UnityHealthUrl,
    [ValidateRange(30, 900)][int]$TimeoutSeconds = 300,
    [switch]$OutputObject
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'Credential.ps1')
. (Join-Path $PSScriptRoot 'PowerShell-Direct.ps1')
$credential = Import-RelayCredential -Path $CredentialPath

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
$remoteOutput = @(
    Invoke-RelayPowerShellDirect -VMName $VMName -Credential $credential -ArgumentList @(
        $GuestProjectPath, $RepoUrl, $BaseBranch, $TaskBranch, $Mode,
        $GitAuthorName, $GitAuthorEmail, $AuditJson, $helperSource, $guestSource
    ) -Stage 'powershell-direct-workspace-prepare' -TimeoutSeconds $TimeoutSeconds -ScriptBlock {
        param(
            $ProjectPath, $RepositoryUrl, $Base, $Branch, $RequestedMode,
            $AuthorName, $AuthorEmail, $AuditJson, $HelperSource, $GuestSource
        )
        $ErrorActionPreference = 'Stop'
        Set-StrictMode -Version Latest
        . ([scriptblock]::Create($HelperSource))
        & ([scriptblock]::Create($GuestSource)) -ProjectPath $ProjectPath -RepositoryUrl $RepositoryUrl -Base $Base -Branch $Branch -RequestedMode $RequestedMode -AuthorName $AuthorName -AuthorEmail $AuthorEmail -AuditJson $AuditJson -OutputJson
    }
)
$remoteRecords = @(
    $remoteOutput |
        ForEach-Object { ([string]$_).Trim() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)
if ($remoteRecords.Count -ne 1) {
    throw "Guest workspace preparation returned $($remoteRecords.Count) success-stream records; exactly one JSON object was required."
}
try {
    $gitResult = $remoteRecords[0] | ConvertFrom-Json
} catch {
    throw "Guest workspace preparation did not return valid JSON: $($_.Exception.Message)"
}
if ($null -eq $gitResult -or $gitResult -isnot [psobject]) {
    throw 'Guest workspace preparation returned JSON that was not an object.'
}

if (-not [bool]$gitResult.ready) {
    $refusal = $gitResult | Select-Object -Property @(
        'proofVersion', 'proven', 'ready', 'code', 'message', 'phase', 'reason',
        'refusal', 'projectPath', 'originalBranch', 'originalHead',
        'statusBefore', 'porcelainV2Before', 'untrackedFilesBefore', 'blockedPaths',
        'deletionPaths', 'prohibitedPaths', 'unsupportedChanges', 'preservedBranch',
        'preservedCommit', 'preservedTree', 'preservedNameStatus',
        'preservedFiles', 'auditedFiles', 'auditFingerprint', 'reusedPreservation',
        'preservationVerified', 'preTargetCheckoutBranch', 'preTargetCheckoutHead',
        'auditedHead', 'preservationBranch', 'preservationCommit',
        'preservationParent', 'reused', 'parentVerified', 'nameStatusVerified',
        'treeVerified', 'blobVerified', 'verifiedFiles', 'statusAfter', 'taskBranch',
        'taskBranchCreated', 'currentBranch'
    )
    if ($OutputObject) {
        return $refusal
    }
    $refusalJson = $refusal | ConvertTo-Json -Depth 12 -Compress
    [Console]::Out.WriteLine($refusalJson)
    [Console]::Error.WriteLine(
        "RELAY_WORKSPACE_REFUSED:$refusalJson"
    )
    exit 42
}

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$unityReady = $false
do {
    $unityReady = [bool](Invoke-Command -VMName $VMName -Credential $credential -ScriptBlock {
        @(Get-Process -Name 'Unity' -ErrorAction SilentlyContinue).Count -gt 0
    })
    if ($unityReady) { break }
    Start-Sleep -Seconds 3
} while ([DateTime]::UtcNow -lt $deadline)

if (-not $unityReady) { throw "Unity did not become ready inside '$VMName'." }
if (-not [string]::IsNullOrWhiteSpace($SharePath) -and -not (Test-Path -LiteralPath $SharePath)) {
    throw "Host SMB workspace '$SharePath' is not reachable."
}

$result = [pscustomobject]@{
    proofVersion = $gitResult.proofVersion
    proven = $gitResult.proven
    ready = $true
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
    auditedHead = $gitResult.auditedHead
    preservationBranch = $gitResult.preservationBranch
    preservationCommit = $gitResult.preservationCommit
    preservationParent = $gitResult.preservationParent
    reused = $gitResult.reused
    parentVerified = $gitResult.parentVerified
    nameStatusVerified = $gitResult.nameStatusVerified
    treeVerified = $gitResult.treeVerified
    blobVerified = $gitResult.blobVerified
    verifiedFiles = $gitResult.verifiedFiles
    statusAfter = $gitResult.statusAfter
    taskBranch = $gitResult.taskBranch
    taskBranchCreated = $gitResult.taskBranchCreated
    currentBranch = $gitResult.currentBranch
    unityReady = $unityReady
    skillReady = $null
    smbReady = [string]::IsNullOrWhiteSpace($SharePath) -or (Test-Path -LiteralPath $SharePath)
}
if ($OutputObject) {
    return $result
}
[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 12 -Compress))
