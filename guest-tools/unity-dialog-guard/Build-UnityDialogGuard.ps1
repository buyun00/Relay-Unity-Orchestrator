[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [switch]$IncludeTestFixture
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot 'bin'
}

$compilerCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $compilerCandidates |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
if (-not $compiler) {
    throw 'The .NET Framework C# compiler was not found. Install/enable .NET Framework 4.x.'
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null

$frameworkDirectory = Split-Path -Parent $compiler
$wpfDirectory = Join-Path $frameworkDirectory 'WPF'
$references = @(
    'System.dll',
    'System.Core.dll',
    'System.Drawing.dll',
    'System.Web.Extensions.dll',
    'System.Windows.Forms.dll',
    (Join-Path $wpfDirectory 'WindowsBase.dll'),
    (Join-Path $wpfDirectory 'UIAutomationClient.dll'),
    (Join-Path $wpfDirectory 'UIAutomationTypes.dll')
)
$referenceArgument = '/reference:' + ($references -join ',')
$guardOutput = Join-Path $resolvedOutput 'UnityDialogGuard.exe'
$guardSource = Join-Path $PSScriptRoot 'src\UnityDialogGuard.cs'

& $compiler @(
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/checked+',
    $referenceArgument,
    ('/out:' + $guardOutput),
    $guardSource
)
if ($LASTEXITCODE -ne 0) {
    throw "UnityDialogGuard compilation failed with exit code $LASTEXITCODE."
}

if ($IncludeTestFixture) {
    $fixtureOutput = Join-Path $resolvedOutput 'UnityDialogFixture.exe'
    $fixtureSource = Join-Path $PSScriptRoot 'tests\UnityDialogFixture.cs'
    $fixtureReferences = @(
        'System.dll',
        'System.Core.dll',
        'System.Xaml.dll',
        (Join-Path $wpfDirectory 'PresentationCore.dll'),
        (Join-Path $wpfDirectory 'PresentationFramework.dll'),
        (Join-Path $wpfDirectory 'WindowsBase.dll')
    )
    & $compiler @(
        '/nologo',
        '/target:winexe',
        '/platform:anycpu',
        '/optimize+',
        ('/reference:' + ($fixtureReferences -join ',')),
        ('/out:' + $fixtureOutput),
        $fixtureSource
    )
    if ($LASTEXITCODE -ne 0) {
        throw "UnityDialogFixture compilation failed with exit code $LASTEXITCODE."
    }
}

$artifact = Get-Item -LiteralPath $guardOutput
$hash = Get-FileHash -LiteralPath $guardOutput -Algorithm SHA256
[pscustomobject]@{
    executable = $artifact.FullName
    size = $artifact.Length
    sha256 = $hash.Hash
    compiler = $compiler
    testFixtureIncluded = [bool]$IncludeTestFixture
} | ConvertTo-Json -Compress
