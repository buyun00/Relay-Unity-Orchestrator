[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$VMName,
    [Parameter(Mandatory = $true)][string]$CredentialPath,
    [Parameter(Mandatory = $true)][string]$GuestProjectPath,
    [Parameter(Mandatory = $true)][string]$TaskBranch,
    [Parameter(Mandatory = $true)][string]$ExpectedCurrentBranch,
    [Parameter(Mandatory = $true)][string]$ExpectedCurrentHead
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'Credential.ps1')
. (Join-Path $PSScriptRoot 'PowerShell-Direct.ps1')
$credential = Import-RelayCredential -Path $CredentialPath
$helper = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Workspace-Git.ps1'))
$guest = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Resume-LocalTaskBranch.Guest.ps1'))
$records = @(Invoke-RelayPowerShellDirect -VMName $VMName -Credential $credential `
    -Stage 'resume-local-task-branch' -TimeoutSeconds 180 `
    -ArgumentList @($GuestProjectPath, $TaskBranch, $ExpectedCurrentBranch, $ExpectedCurrentHead, $helper, $guest) `
    -ScriptBlock {
        param($ProjectPath, $TaskBranch, $ExpectedBranch, $ExpectedHead, $Helper, $Guest)
        $ErrorActionPreference = 'Stop'
        . ([scriptblock]::Create($Helper))
        & ([scriptblock]::Create($Guest)) -ProjectPath $ProjectPath -TaskBranch $TaskBranch `
            -ExpectedCurrentBranch $ExpectedBranch -ExpectedCurrentHead $ExpectedHead
    })
if ($records.Count -ne 1) { throw 'Local task branch resume returned an invalid response count.' }
$records[0].ToString()
