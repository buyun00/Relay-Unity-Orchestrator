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

$gitResult = Invoke-Command -VMName $VMName -Credential $credential -ArgumentList @(
    $GuestProjectPath, $RepoUrl, $BaseBranch, $TaskBranch, $Mode,
    $GitAuthorName, $GitAuthorEmail
) -ScriptBlock {
    param(
        $ProjectPath,
        $RepositoryUrl,
        $Base,
        $Branch,
        $RequestedMode,
        $AuthorName,
        $AuthorEmail
    )
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = [Console]::OutputEncoding
    $env:GCM_INTERACTIVE = '0'

    function Invoke-Git([string[]]$Arguments) {
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            # Git Credential Manager may write non-fatal provider warnings to
            # stderr. PowerShell 5 converts those lines to ErrorRecord objects,
            # so judge success by Git's exit code instead.
            $ErrorActionPreference = 'Continue'
            $output = & git -C $ProjectPath @Arguments 2>&1
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($exitCode -ne 0) {
            throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
        }
        return $output
    }

    $usesUnencryptedHttp = $RepositoryUrl -match '^http://'
    if ($usesUnencryptedHttp) {
        # This project is hosted on an isolated GitLab that does not expose
        # HTTPS. Limit the GCM opt-in to this process and this repository.
        $env:GCM_ALLOW_UNSAFE_REMOTES = 'true'
    }

    if (-not (Test-Path -LiteralPath (Join-Path $ProjectPath '.git'))) {
        $parent = Split-Path -Parent $ProjectPath
        if (-not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $cloneOutput = & git clone -- $RepositoryUrl $ProjectPath 2>&1
            $cloneExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($cloneExitCode -ne 0) {
            throw "git clone failed: $($cloneOutput -join [Environment]::NewLine)"
        }
    }

    if ($usesUnencryptedHttp) {
        Invoke-Git @('config', '--local', 'credential.allowUnsafeRemotes', 'true') | Out-Null
    }
    Invoke-Git @('config', '--local', 'user.name', $AuthorName) | Out-Null
    Invoke-Git @('config', '--local', 'user.email', $AuthorEmail) | Out-Null
    Invoke-Git @('remote', 'set-url', 'origin', $RepositoryUrl) | Out-Null
    Invoke-Git @('fetch', 'origin', '--prune') | Out-Null

    & git -C $ProjectPath show-ref --verify --quiet "refs/remotes/origin/$Branch"
    $taskRemoteExists = $LASTEXITCODE -eq 0
    $source = if ($taskRemoteExists) { "origin/$Branch" } else { "origin/$Base" }
    Invoke-Git @('rev-parse', '--verify', $source) | Out-Null
    Invoke-Git @('checkout', '-B', $Branch, $source) | Out-Null
    Invoke-Git @('reset', '--hard', $source) | Out-Null
    Invoke-Git @('clean', '-fd') | Out-Null

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
