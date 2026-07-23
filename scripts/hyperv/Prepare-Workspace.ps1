[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RepoUrl,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$BaseBranch,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TaskBranch,
    [Parameter(Mandatory = $true)][ValidateSet('new', 'resume')][string]$Mode,
    [string]$SharePath,
    [string]$UnityHealthUrl,
    [ValidateRange(30, 900)][int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$credential = Import-Clixml -LiteralPath ([System.IO.Path]::GetFullPath($CredentialPath))
if ($credential -isnot [System.Management.Automation.PSCredential]) {
    throw 'CredentialPath did not contain a PSCredential.'
}

$gitResult = Invoke-Command -VMName $VMName -Credential $credential -ArgumentList @(
    $GuestProjectPath, $RepoUrl, $BaseBranch, $TaskBranch, $Mode
) -ScriptBlock {
    param($ProjectPath, $RepositoryUrl, $Base, $Branch, $RequestedMode)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest

    function Invoke-Git([string[]]$Arguments) {
        $output = & git -C $ProjectPath @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
        }
        return $output
    }

    if (-not (Test-Path -LiteralPath (Join-Path $ProjectPath '.git'))) {
        $parent = Split-Path -Parent $ProjectPath
        if (-not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        $cloneOutput = & git clone -- $RepositoryUrl $ProjectPath 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "git clone failed: $($cloneOutput -join [Environment]::NewLine)"
        }
    }

    Invoke-Git @('remote', 'set-url', 'origin', $RepositoryUrl) | Out-Null
    Invoke-Git @('fetch', 'origin', '--prune') | Out-Null

    & git -C $ProjectPath show-ref --verify --quiet "refs/remotes/origin/$Branch"
    $taskRemoteExists = $LASTEXITCODE -eq 0
    $source = if ($taskRemoteExists) { "origin/$Branch" } else { "origin/$Base" }
    Invoke-Git @('rev-parse', '--verify', $source) | Out-Null
    Invoke-Git @('checkout', '-B', $Branch, $source) | Out-Null
    Invoke-Git @('reset', '--hard', $source) | Out-Null

    $head = (Invoke-Git @('rev-parse', 'HEAD') | Select-Object -Last 1).ToString().Trim()
    [pscustomobject]@{
        projectPath = $ProjectPath
        branch = $Branch
        source = $source
        head = $head
        mode = $RequestedMode
        remoteBranchExisted = $taskRemoteExists
    }
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
    unityReady = $unityReady
    skillReady = $skillReady
    smbReady = [string]::IsNullOrWhiteSpace($SharePath) -or (Test-Path -LiteralPath $SharePath)
} | ConvertTo-Json -Compress
