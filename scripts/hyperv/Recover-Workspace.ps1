[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RepoUrl,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$BaseBranch,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TaskBranch,
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

function Write-RecoveryResult(
    [Parameter(Mandatory = $true)][object]$Payload,
    [int]$ExitCode = 0,
    [string]$ErrorMarker
) {
    $json = $Payload | ConvertTo-Json -Depth 12 -Compress
    [Console]::Out.WriteLine($json)
    if (-not [string]::IsNullOrWhiteSpace($ErrorMarker)) {
        [Console]::Error.WriteLine("${ErrorMarker}${json}")
    }
    if ($ExitCode -ne 0) {
        exit $ExitCode
    }
}

function New-RecoveryFailure(
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Phase,
    [Parameter(Mandatory = $true)][string]$Message,
    [string[]]$MissingFields = @()
) {
    $refusal = [pscustomobject]@{
        phase = $Phase
        reason = $Code
        code = $Code
        message = $Message
    }
    return [pscustomobject]@{
        proofVersion = 1
        proven = $false
        ready = $false
        code = $Code
        phase = $Phase
        reason = $Code
        message = $Message
        refusal = $refusal
        missingFields = @($MissingFields)
        taskBranch = $TaskBranch
        taskBranchCreated = $false
        currentBranch = $null
    }
}

$prepareScript = Join-Path $PSScriptRoot 'Prepare-Workspace.ps1'
if (-not (Test-Path -LiteralPath $prepareScript -PathType Leaf)) {
    throw "Workspace preparation script '$prepareScript' was not found."
}

try {
    $prepareOutput = @(
        & $prepareScript `
            -VMName $VMName `
            -CredentialPath $CredentialPath `
            -GuestProjectPath $GuestProjectPath `
            -RepoUrl $RepoUrl `
            -BaseBranch $BaseBranch `
            -TaskBranch $TaskBranch `
            -Mode recovery `
            -GitAuthorName $GitAuthorName `
            -GitAuthorEmail $GitAuthorEmail `
            -AuditJson $AuditJson `
            -SharePath $SharePath `
            -UnityHealthUrl $UnityHealthUrl `
            -TimeoutSeconds $TimeoutSeconds `
            -OutputObject
    )
    if ($prepareOutput.Count -ne 1) {
        $failure = New-RecoveryFailure `
            -Code 'RECOVERY_HOST_OUTPUT_CARDINALITY' `
            -Phase 'host-wrapper' `
            -Message "Recovery host wrapper received $($prepareOutput.Count) result objects; exactly one was required."
        Write-RecoveryResult $failure 1 'RELAY_RECOVERY_FAILED:'
    }
    $prepareResult = $prepareOutput[0]
    if (-not [bool]$prepareResult.ready) {
        Write-RecoveryResult $prepareResult 42 'RELAY_WORKSPACE_REFUSED:'
    }

    $requiredProofFields = @(
        'proofVersion', 'proven', 'auditFingerprint', 'auditedHead',
        'preservationBranch', 'preservationCommit', 'preservationParent',
        'reused', 'parentVerified', 'nameStatusVerified', 'treeVerified',
        'blobVerified', 'verifiedFiles', 'statusAfter', 'taskBranch',
        'taskBranchCreated', 'currentBranch'
    )
    $missingFields = @(
        $requiredProofFields |
            Where-Object { $prepareResult.PSObject.Properties.Name -notcontains $_ }
    )
    if ($missingFields.Count -gt 0) {
        $failure = New-RecoveryFailure `
            -Code 'RECOVERY_PROOF_FIELDS_MISSING' `
            -Phase 'host-proof-validation' `
            -Message "Recovery proof was missing required fields: $($missingFields -join ', ')." `
            -MissingFields $missingFields
        Write-RecoveryResult $failure 43 'RELAY_RECOVERY_FAILED:'
    }

    # Rebuild the object from an explicit allow-list so PowerShell Direct
    # metadata (PSComputerName, RunspaceId, PSShowComputerName) and any native
    # byte buffers can never cross the host process success stream.
    $proof = $prepareResult | Select-Object -Property @(
        'proofVersion', 'proven', 'auditFingerprint', 'auditedHead',
        'preservationBranch', 'preservationCommit', 'preservationParent',
        'reused', 'parentVerified', 'nameStatusVerified', 'treeVerified',
        'blobVerified', 'verifiedFiles', 'statusAfter', 'taskBranch',
        'taskBranchCreated', 'currentBranch',
        'ready', 'vmName', 'workspace', 'branch', 'head', 'source',
        'originalBranch', 'originalHead', 'statusBefore', 'porcelainV2Before',
        'untrackedFilesBefore', 'auditedFiles', 'preservedBranch',
        'preservedCommit', 'preservedTree', 'preservedNameStatus',
        'preservedFiles', 'reusedPreservation', 'preservationVerified',
        'preTargetCheckoutBranch', 'preTargetCheckoutHead', 'unityReady',
        'skillReady', 'smbReady'
    )
    Write-RecoveryResult $proof
} catch {
    $failure = New-RecoveryFailure `
        -Code 'RECOVERY_HOST_EXCEPTION' `
        -Phase 'host-wrapper' `
        -Message "Recovery host wrapper failed: $($_.Exception.Message)"
    Write-RecoveryResult $failure 1 'RELAY_RECOVERY_FAILED:'
}
