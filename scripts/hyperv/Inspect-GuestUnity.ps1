[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VMName,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$CredentialPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GuestRepositoryPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Import-Module Hyper-V -ErrorAction Stop

$credential = Import-Clixml -LiteralPath ([System.IO.Path]::GetFullPath($CredentialPath))
if ($credential -isnot [System.Management.Automation.PSCredential]) {
    throw 'CredentialPath did not contain a PSCredential.'
}

$integrationServices = @(Get-VMIntegrationService -VMName $VMName -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{
        name = $_.Name
        enabled = [bool]$_.Enabled
        primaryStatus = $_.PrimaryStatusDescription
        secondaryStatus = $_.SecondaryStatusDescription
        id = $_.Id.ToString()
    }
})

$guest = Invoke-Command -VMName $VMName -Credential $credential -ArgumentList $GuestRepositoryPath -ScriptBlock {
    param($RepositoryPath)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest

    $projectCandidates = @()
    $rootProjectVersion = Join-Path $RepositoryPath 'ProjectSettings\ProjectVersion.txt'
    if (Test-Path -LiteralPath $rootProjectVersion) {
        $projectCandidates += [pscustomobject]@{
            path = $RepositoryPath
            versionFile = $rootProjectVersion
        }
    }
    if (Test-Path -LiteralPath $RepositoryPath) {
        $projectCandidates += @(Get-ChildItem -LiteralPath $RepositoryPath -Directory -ErrorAction SilentlyContinue |
            ForEach-Object {
                $versionFile = Join-Path $_.FullName 'ProjectSettings\ProjectVersion.txt'
                if (Test-Path -LiteralPath $versionFile) {
                    [pscustomobject]@{
                        path = $_.FullName
                        versionFile = $versionFile
                    }
                }
            })
    }
    $projectCandidates = @($projectCandidates | ForEach-Object {
        $text = Get-Content -LiteralPath $_.versionFile -Raw
        $match = [regex]::Match($text, '(?m)^m_EditorVersion:\s*(?<version>\S+)')
        [pscustomobject]@{
            path = $_.path
            unityVersion = if ($match.Success) { $match.Groups['version'].Value } else { $null }
        }
    })

    $installedEditors = @()
    $editorRoots = @(
        'C:\Program Files\Unity\Hub\Editor',
        'C:\Program Files (x86)\Unity\Hub\Editor',
        'D:\Unity\Hub\Editor',
        'D:\Unity Editors',
        'D:\Unity'
    )
    foreach ($editorRoot in $editorRoots) {
        if (-not (Test-Path -LiteralPath $editorRoot)) { continue }
        $installedEditors += @(Get-ChildItem -LiteralPath $editorRoot -Directory -ErrorAction SilentlyContinue |
                ForEach-Object {
                    $directExecutable = Join-Path $_.FullName 'Unity.exe'
                    $nestedExecutable = Join-Path $_.FullName 'Editor\Unity.exe'
                    $executable = if (Test-Path -LiteralPath $directExecutable) {
                        $directExecutable
                    } elseif (Test-Path -LiteralPath $nestedExecutable) {
                        $nestedExecutable
                    } else {
                        $null
                    }
                    if ($executable) {
                        [pscustomobject]@{
                            version = $_.Name
                            executable = $executable
                        }
                    }
                })
    }

    $uninstallEntries = @()
    $uninstallRoots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($uninstallRoot in $uninstallRoots) {
        $uninstallEntries += @(Get-ItemProperty -Path $uninstallRoot -ErrorAction SilentlyContinue |
            Where-Object {
                $_.PSObject.Properties['DisplayName'] -and
                [string]$_.PSObject.Properties['DisplayName'].Value -match 'Unity'
            } |
            ForEach-Object {
                [pscustomobject]@{
                    displayName = [string]$_.PSObject.Properties['DisplayName'].Value
                    installLocation = if ($_.PSObject.Properties['InstallLocation']) {
                        [string]$_.PSObject.Properties['InstallLocation'].Value
                    } else {
                        $null
                    }
                    displayIcon = if ($_.PSObject.Properties['DisplayIcon']) {
                        [string]$_.PSObject.Properties['DisplayIcon'].Value
                    } else {
                        $null
                    }
                }
            })
    }

    $hubSettings = @()
    $hubSettingsPaths = @(
        (Join-Path $env:APPDATA 'UnityHub\secondaryInstallPath.json'),
        (Join-Path $env:APPDATA 'UnityHub\settings.json')
    )
    foreach ($settingsPath in $hubSettingsPaths) {
        if (Test-Path -LiteralPath $settingsPath) {
            $hubSettings += [pscustomobject]@{
                path = $settingsPath
                content = (Get-Content -LiteralPath $settingsPath -Raw)
            }
        }
    }

    $driveRoots = @(Get-PSDrive -PSProvider FileSystem | ForEach-Object {
        [pscustomobject]@{
            name = $_.Name
            root = $_.Root
            topDirectories = if (Test-Path -LiteralPath $_.Root) {
                @(Get-ChildItem -LiteralPath $_.Root -Directory -ErrorAction SilentlyContinue |
                    Select-Object -ExpandProperty FullName)
            } else {
                @()
            }
        }
    })

    $unityProcesses = @(Get-CimInstance Win32_Process -Filter "Name='Unity.exe'" -ErrorAction SilentlyContinue |
        ForEach-Object {
            [pscustomobject]@{
                processId = [int]$_.ProcessId
                executable = $_.ExecutablePath
                commandLine = $_.CommandLine
            }
        })

    [pscustomobject]@{
        computerName = $env:COMPUTERNAME
        projectCandidates = $projectCandidates
        installedEditors = $installedEditors
        uninstallEntries = $uninstallEntries
        hubSettings = $hubSettings
        driveRoots = $driveRoots
        unityProcesses = $unityProcesses
        unitySkillsPortListening = [bool](Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue)
    }
}

[pscustomobject]@{
    vmName = $VMName
    integrationServices = $integrationServices
    guest = $guest
} | ConvertTo-Json -Depth 8 -Compress
