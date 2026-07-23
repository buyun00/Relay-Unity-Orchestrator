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

$credentialFile = [System.IO.Path]::GetFullPath($CredentialPath)
if (-not (Test-Path -LiteralPath $credentialFile -PathType Leaf)) {
    throw "Credential file '$credentialFile' does not exist."
}
$credential = Import-Clixml -LiteralPath $credentialFile
if ($credential -isnot [System.Management.Automation.PSCredential]) {
    throw 'CredentialPath did not contain a PSCredential exported with Export-Clixml.'
}

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -eq [Microsoft.HyperV.PowerShell.VMState]::Off) {
    Start-VM -VM $vm -ErrorAction Stop | Out-Null
} elseif ($vm.State -ne [Microsoft.HyperV.PowerShell.VMState]::Running) {
    throw "VM '$VMName' is in state '$($vm.State)' and cannot be prepared automatically."
}

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
} | ConvertTo-Json -Compress
