[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [ValidateRange(30, 900)][int]$TimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Import-Module Hyper-V -ErrorAction Stop
. (Join-Path $PSScriptRoot 'Saved-State-Recovery.ps1')

$credentialFile = [System.IO.Path]::GetFullPath($CredentialPath)
if (-not (Test-Path -LiteralPath $credentialFile -PathType Leaf)) {
    throw "Credential file '$credentialFile' does not exist."
}
$credential = Import-Clixml -LiteralPath $credentialFile
if ($credential -isnot [System.Management.Automation.PSCredential]) {
    throw 'CredentialPath did not contain a PSCredential exported with Export-Clixml.'
}

$startResult = Start-RelayVMWithSavedStateFallback -VMName $VMName

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$guestComputerName = $null
do {
    try {
        $guestComputerName = Invoke-Command -VMName $VMName -Credential $credential `
            -ScriptBlock { $env:COMPUTERNAME } -ErrorAction Stop
        break
    } catch {
        Start-Sleep -Seconds 3
    }
} while ([DateTime]::UtcNow -lt $deadline)

if ([string]::IsNullOrWhiteSpace($guestComputerName)) {
    throw "VM '$VMName' is running, but PowerShell Direct did not become ready within $TimeoutSeconds seconds."
}

[pscustomobject]@{
    vmName = $VMName
    state = (Get-VM -Name $VMName -ErrorAction Stop).State.ToString()
    guestReady = $true
    guestComputerName = $guestComputerName.ToString().Trim()
    checkpointRestored = $false
    savedStateDiscarded = [bool]$startResult.savedStateDiscarded
    resumeError = $startResult.resumeError
} | ConvertTo-Json -Compress
