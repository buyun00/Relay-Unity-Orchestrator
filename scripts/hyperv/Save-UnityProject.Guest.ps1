[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https?://')]
    [string]$ConfiguredSaveUrl,
    [ValidatePattern('^https?://')]
    [string]$GuestUnitySkillsEndpoint = 'http://127.0.0.1:8090',
    [ValidateRange(1, 300)][int]$TimeoutSeconds = 90,
    [ValidateRange(1, 30)][int]$ConnectionTimeoutSeconds = 5,
    [ValidateRange(0, 5)][int]$DomainReloadRetryCount = 3,
    [ValidateRange(100, 10000)][int]$DomainReloadRetryDelayMilliseconds = 750,
    [switch]$OutputJson
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Net.Http

function New-UnitySaveError {
    param(
        [Parameter(Mandatory = $true)][string]$Code,
        [Parameter(Mandatory = $true)][string]$Message,
        [switch]$Retryable
    )

    $exception = New-Object System.Exception "[$Code] $Message"
    $exception.Data['RelayCode'] = $Code
    if ($Retryable) {
        $exception.Data['RetryableDomainReload'] = $true
    }
    return $exception
}

function Test-ConnectionRefused {
    param([AllowNull()][System.Exception]$Exception)

    $current = $Exception
    while ($null -ne $current) {
        if (
            $current -is [System.Net.Sockets.SocketException] -and
            $current.SocketErrorCode -eq [System.Net.Sockets.SocketError]::ConnectionRefused
        ) {
            return $true
        }
        $current = $current.InnerException
    }
    return $false
}

function Get-BoundedDiagnostic {
    param([AllowNull()][string]$Text)

    $normalized = ([string]$Text).Replace("`r", ' ').Replace("`n", ' ').Trim()
    if ($normalized.Length -le 500) {
        return $normalized
    }
    return $normalized.Substring(0, 500) + '...'
}

function Assert-UnityEndpointConnection {
    param(
        [Parameter(Mandatory = $true)][System.Uri]$Uri,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )

    $client = New-Object System.Net.Sockets.TcpClient
    $asyncResult = $null
    try {
        $asyncResult = $client.BeginConnect($Uri.Host, $Uri.Port, $null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne(
            [System.TimeSpan]::FromSeconds($TimeoutSeconds)
        )) {
            throw (New-UnitySaveError `
                -Code 'UNITY_SAVE_CONNECTION_TIMEOUT' `
                -Message "Timed out after $TimeoutSeconds second(s) connecting to guest-local Unity save endpoint '$Uri'.")
        }
        try {
            $client.EndConnect($asyncResult)
        } catch [System.Net.Sockets.SocketException] {
            if (
                $_.Exception.SocketErrorCode -eq
                [System.Net.Sockets.SocketError]::ConnectionRefused
            ) {
                throw (New-UnitySaveError `
                    -Code 'UNITY_SAVE_CONNECTION_REFUSED' `
                    -Message "Connection was refused by guest-local Unity save endpoint '$Uri'." `
                    -Retryable)
            }
            throw (New-UnitySaveError `
                -Code 'UNITY_SAVE_CONNECTION_FAILED' `
                -Message "Could not connect to guest-local Unity save endpoint '$Uri': $($_.Exception.Message)")
        }
    } finally {
        if ($null -ne $asyncResult) {
            $asyncResult.AsyncWaitHandle.Close()
        }
        $client.Close()
    }
}

function Resolve-GuestSaveUri {
    param(
        [Parameter(Mandatory = $true)][string]$ConfiguredUrl,
        [Parameter(Mandatory = $true)][string]$GuestEndpoint
    )

    try {
        $configured = New-Object System.Uri $ConfiguredUrl
        $guest = New-Object System.Uri $GuestEndpoint
    } catch {
        throw (New-UnitySaveError `
            -Code 'UNITY_SAVE_ENDPOINT_INVALID' `
            -Message "Unity save endpoint configuration was invalid: $($_.Exception.Message)")
    }
    if (-not $configured.IsAbsoluteUri -or -not $guest.IsAbsoluteUri) {
        throw (New-UnitySaveError `
            -Code 'UNITY_SAVE_ENDPOINT_INVALID' `
            -Message 'Unity save endpoints must be absolute HTTP URLs.')
    }
    if (
        $guest.Scheme -notin @('http', 'https') -or
        -not $guest.IsLoopback -or
        -not [string]::IsNullOrEmpty($guest.UserInfo)
    ) {
        throw (New-UnitySaveError `
            -Code 'UNITY_SAVE_ENDPOINT_NOT_LOOPBACK' `
            -Message "Guest UnitySkills endpoint '$GuestEndpoint' must use an HTTP loopback address without user information.")
    }

    $builder = New-Object System.UriBuilder $guest
    if ($guest.AbsolutePath -eq '/' -and $configured.AbsolutePath -ne '/') {
        $builder.Path = $configured.AbsolutePath
    }
    if (
        [string]::IsNullOrEmpty($guest.Query) -and
        -not [string]::IsNullOrEmpty($configured.Query)
    ) {
        $builder.Query = $configured.Query.TrimStart('?')
    }
    return $builder.Uri
}

function ConvertFrom-RequiredJsonObject {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][System.Uri]$Uri
    )

    try {
        $value = $Content | ConvertFrom-Json
    } catch {
        throw (New-UnitySaveError `
            -Code 'UNITY_SAVE_INVALID_RESPONSE' `
            -Message "Guest-local Unity save endpoint '$Uri' returned invalid JSON: $($_.Exception.Message)")
    }
    if (
        $null -eq $value -or
        $value -isnot [psobject] -or
        $value -is [System.Array] -or
        $value -is [string]
    ) {
        throw (New-UnitySaveError `
            -Code 'UNITY_SAVE_INVALID_RESPONSE' `
            -Message "Guest-local Unity save endpoint '$Uri' returned JSON that was not an object.")
    }
    return $value
}

function Invoke-JsonPost {
    param(
        [Parameter(Mandatory = $true)][System.Uri]$Uri,
        [Parameter(Mandatory = $true)][string]$Body,
        [Parameter(Mandatory = $true)][int]$ConnectionTimeout,
        [Parameter(Mandatory = $true)][int]$ResponseTimeout
    )

    Assert-UnityEndpointConnection `
        -Uri $Uri `
        -TimeoutSeconds $ConnectionTimeout

    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.UseProxy = $false
    $handler.Proxy = $null
    $client = New-Object System.Net.Http.HttpClient $handler
    $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
    $client.DefaultRequestHeaders.ConnectionClose = $true
    $request = New-Object System.Net.Http.HttpRequestMessage(
        [System.Net.Http.HttpMethod]::Post,
        $Uri
    )
    $request.Content = New-Object System.Net.Http.StringContent(
        $Body,
        [System.Text.Encoding]::UTF8,
        'application/json'
    )
    $connectionCts = New-Object System.Threading.CancellationTokenSource
    $response = $null
    try {
        $connectionCts.CancelAfter(
            [System.TimeSpan]::FromSeconds($ConnectionTimeout)
        )
        try {
            $response = $client.SendAsync(
                $request,
                [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead,
                $connectionCts.Token
            ).GetAwaiter().GetResult()
        } catch [System.Threading.Tasks.TaskCanceledException] {
            throw (New-UnitySaveError `
                -Code 'UNITY_SAVE_CONNECTION_TIMEOUT' `
                -Message "Timed out after $ConnectionTimeout second(s) connecting to guest-local Unity save endpoint '$Uri'.")
        } catch [System.Net.Http.HttpRequestException] {
            if (Test-ConnectionRefused -Exception $_.Exception) {
                throw (New-UnitySaveError `
                    -Code 'UNITY_SAVE_CONNECTION_REFUSED' `
                    -Message "Connection was refused by guest-local Unity save endpoint '$Uri'." `
                    -Retryable)
            }
            throw (New-UnitySaveError `
                -Code 'UNITY_SAVE_CONNECTION_FAILED' `
                -Message "Could not connect to guest-local Unity save endpoint '$Uri': $($_.Exception.Message)")
        }

        try {
            $readTask = $response.Content.ReadAsStringAsync()
            $delayTask = [System.Threading.Tasks.Task]::Delay(
                [System.TimeSpan]::FromSeconds($ResponseTimeout)
            )
            $completed = [System.Threading.Tasks.Task]::WhenAny(
                [System.Threading.Tasks.Task[]]@($readTask, $delayTask)
            ).GetAwaiter().GetResult()
            if ($completed -ne $readTask) {
                throw (New-UnitySaveError `
                    -Code 'UNITY_SAVE_RESPONSE_TIMEOUT' `
                    -Message "Guest-local Unity save endpoint '$Uri' did not complete its response within $ResponseTimeout second(s).")
            }
            $content = $readTask.GetAwaiter().GetResult()
            $statusCode = [int]$response.StatusCode
            if (-not $response.IsSuccessStatusCode) {
                $diagnostic = Get-BoundedDiagnostic -Text $content
                $domainReload = (
                    $statusCode -in @(409, 423, 425, 429, 503) -and
                    $diagnostic -match '(?i)domain\s*reload|compil|import|busy|not\s+ready'
                )
                if ($domainReload) {
                    throw (New-UnitySaveError `
                        -Code 'UNITY_SAVE_DOMAIN_RELOAD' `
                        -Message "Unity is temporarily unavailable during a domain reload/import (HTTP $statusCode): $diagnostic" `
                        -Retryable)
                }
                throw (New-UnitySaveError `
                    -Code 'UNITY_SAVE_HTTP_FAILURE' `
                    -Message "Guest-local Unity save endpoint '$Uri' returned HTTP ${statusCode}: $diagnostic")
            }
            $json = ConvertFrom-RequiredJsonObject -Content $content -Uri $Uri
            return [pscustomobject]@{
                statusCode = $statusCode
                content = $content
                json = $json
            }
        } finally {
            if ($null -ne $response) {
                $response.Dispose()
            }
        }
    } finally {
        $connectionCts.Dispose()
        $request.Dispose()
        $client.Dispose()
        $handler.Dispose()
    }
}

function Invoke-WithDomainReloadRetry {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Operation,
        [Parameter(Mandatory = $true)][int]$RetryCount,
        [Parameter(Mandatory = $true)][int]$RetryDelayMilliseconds
    )

    for ($attempt = 1; $attempt -le ($RetryCount + 1); $attempt += 1) {
        try {
            $operationResult = & $Operation
            return [pscustomobject]@{
                response = $operationResult
                attempts = $attempt
            }
        } catch {
            $retryable = [bool]$_.Exception.Data['RetryableDomainReload']
            if (-not $retryable -or $attempt -gt $RetryCount) {
                throw
            }
            Start-Sleep -Milliseconds $RetryDelayMilliseconds
        }
    }
}

function Test-CustomSaveSuccess {
    param([Parameter(Mandatory = $true)][psobject]$Json)

    if ($Json.PSObject.Properties.Name -contains 'saved' -and [bool]$Json.saved) {
        return $true
    }
    if ($Json.PSObject.Properties.Name -contains 'success' -and [bool]$Json.success) {
        return $true
    }
    if ($Json.PSObject.Properties.Name -contains 'status') {
        return ([string]$Json.status).ToLowerInvariant() -in @(
            'success', 'saved', 'ok', 'completed'
        )
    }
    return $false
}

$saveUri = Resolve-GuestSaveUri `
    -ConfiguredUrl $ConfiguredSaveUrl `
    -GuestEndpoint $GuestUnitySkillsEndpoint
$isUnitySkillsRest = (
    $saveUri.AbsolutePath.TrimEnd('/') -ieq '/skill/editor_execute_menu'
)
$totalAttempts = 0
if ($isUnitySkillsRest) {
    $body = @{ menuPath = 'File/Save' } | ConvertTo-Json -Compress
    $dryRunBuilder = New-Object System.UriBuilder $saveUri
    if ([string]::IsNullOrEmpty($dryRunBuilder.Query)) {
        $dryRunBuilder.Query = 'mode=dryRun'
    } else {
        $dryRunBuilder.Query = $dryRunBuilder.Query.TrimStart('?') + '&mode=dryRun'
    }
    $dryRunResult = Invoke-WithDomainReloadRetry `
        -RetryCount $DomainReloadRetryCount `
        -RetryDelayMilliseconds $DomainReloadRetryDelayMilliseconds `
        -Operation {
            Invoke-JsonPost `
                -Uri $dryRunBuilder.Uri `
                -Body $body `
                -ConnectionTimeout $ConnectionTimeoutSeconds `
                -ResponseTimeout $TimeoutSeconds
        }
    $totalAttempts += $dryRunResult.attempts
    $dryRun = $dryRunResult.response.json
    if (
        -not ($dryRun.PSObject.Properties.Name -contains 'status') -or
        $dryRun.status -ne 'dryRun' -or
        -not ($dryRun.PSObject.Properties.Name -contains 'valid') -or
        -not [bool]$dryRun.valid
    ) {
        throw (New-UnitySaveError `
            -Code 'UNITY_SAVE_INVALID_RESPONSE' `
            -Message "UnitySkills save dry-run response was not valid: $(Get-BoundedDiagnostic $dryRunResult.response.content)")
    }

    $executionResult = Invoke-WithDomainReloadRetry `
        -RetryCount $DomainReloadRetryCount `
        -RetryDelayMilliseconds $DomainReloadRetryDelayMilliseconds `
        -Operation {
            Invoke-JsonPost `
                -Uri $saveUri `
                -Body $body `
                -ConnectionTimeout $ConnectionTimeoutSeconds `
                -ResponseTimeout $TimeoutSeconds
        }
    $totalAttempts += $executionResult.attempts
    $execution = $executionResult.response.json
    if (
        -not ($execution.PSObject.Properties.Name -contains 'status') -or
        $execution.status -ne 'success' -or
        -not ($execution.PSObject.Properties.Name -contains 'result') -or
        $null -eq $execution.result -or
        $execution.result.executed -ne 'File/Save'
    ) {
        throw (New-UnitySaveError `
            -Code 'UNITY_SAVE_INVALID_RESPONSE' `
            -Message "UnitySkills save response was not valid: $(Get-BoundedDiagnostic $executionResult.response.content)")
    }
    $statusCode = $executionResult.response.statusCode
    $provider = 'UnitySkillsRest'
} else {
    $body = @{
        action = 'saveAll'
        waitForCompletion = $true
    } | ConvertTo-Json -Compress
    $saveResult = Invoke-WithDomainReloadRetry `
        -RetryCount $DomainReloadRetryCount `
        -RetryDelayMilliseconds $DomainReloadRetryDelayMilliseconds `
        -Operation {
            Invoke-JsonPost `
                -Uri $saveUri `
                -Body $body `
                -ConnectionTimeout $ConnectionTimeoutSeconds `
                -ResponseTimeout $TimeoutSeconds
        }
    $totalAttempts = $saveResult.attempts
    if (-not (Test-CustomSaveSuccess -Json $saveResult.response.json)) {
        throw (New-UnitySaveError `
            -Code 'UNITY_SAVE_INVALID_RESPONSE' `
            -Message "Unity save response did not confirm success: $(Get-BoundedDiagnostic $saveResult.response.content)")
    }
    $statusCode = $saveResult.response.statusCode
    $provider = 'Custom'
}

$result = [pscustomobject]@{
    saved = $true
    statusCode = [int]$statusCode
    provider = $provider
    endpoint = $saveUri.AbsoluteUri
    attempts = [int]$totalAttempts
    proxyDisabled = $true
}
if ($OutputJson) {
    $result | ConvertTo-Json -Depth 8 -Compress
} else {
    $result
}
