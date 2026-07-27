[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RepoUrl,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$BaseBranch,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TaskBranch,
    [Parameter(Mandatory = $true)][ValidateSet('new', 'resume')][string]$Mode,
    [ValidateNotNullOrEmpty()][string]$GitAuthorName = 'Relay Unity Orchestrator',
    [ValidateNotNullOrEmpty()][string]$GitAuthorEmail = 'relay-unity-orchestrator@localhost',
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

$guestScriptPath = Join-Path $PSScriptRoot 'Prepare-Workspace.Guest.ps1'
if (-not (Test-Path -LiteralPath $guestScriptPath)) {
    throw "Guest workspace preparation script '$guestScriptPath' was not found."
}
$guestScript = [scriptblock]::Create(
    [System.IO.File]::ReadAllText($guestScriptPath, [System.Text.Encoding]::UTF8)
)
$gitResult = Invoke-Command -VMName $VMName -Credential $credential -ArgumentList @(
    $GuestProjectPath, $RepoUrl, $BaseBranch, $TaskBranch, $Mode,
    $GitAuthorName, $GitAuthorEmail
) -ScriptBlock $guestScript

if (-not [bool]$gitResult.ready) {
    $refusal = $gitResult | Select-Object -Property @(
        'ready', 'code', 'message', 'projectPath', 'originalBranch', 'originalHead',
        'statusBefore', 'blockedPaths', 'deletionPaths', 'prohibitedPaths',
        'unsupportedChanges', 'preservedBranch', 'preservedCommit'
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
    preservedBranch = $gitResult.preservedBranch
    preservedCommit = $gitResult.preservedCommit
    preservedFiles = $gitResult.preservedFiles
    unityReady = $unityReady
    skillReady = $skillReady
    smbReady = [string]::IsNullOrWhiteSpace($SharePath) -or (Test-Path -LiteralPath $SharePath)
} | ConvertTo-Json -Depth 8 -Compress
