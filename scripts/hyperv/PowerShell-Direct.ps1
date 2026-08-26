Set-StrictMode -Version Latest

function New-RelayStageException {
    param(
        [Parameter(Mandatory = $true)][string]$Stage,
        [Parameter(Mandatory = $true)][string]$Message,
        [AllowNull()][object]$ExitCode = $null,
        [string]$Stdout = '',
        [string]$Stderr = '',
        [bool]$TimedOut = $false
    )

    $exception = if ($TimedOut) {
        New-Object System.TimeoutException($Message)
    } else {
        New-Object System.InvalidOperationException($Message)
    }
    $exception.Data['relayStage'] = $Stage
    $exception.Data['relayExitCode'] = $ExitCode
    $exception.Data['relayStdout'] = $Stdout
    $exception.Data['relayStderr'] = $Stderr
    $exception.Data['relayTimedOut'] = $TimedOut
    return $exception
}

function Invoke-RelayPowerShellDirect {
    param(
        [Parameter(Mandatory = $true)][string]$VMName,
        [Parameter(Mandatory = $true)][pscredential]$Credential,
        [Parameter(Mandatory = $true)][object[]]$ArgumentList,
        [Parameter(Mandatory = $true)][scriptblock]$ScriptBlock,
        [Parameter(Mandatory = $true)][string]$Stage,
        [ValidateRange(1, 3600)][int]$TimeoutSeconds = 300
    )

    $job = $null
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $job = Invoke-Command -VMName $VMName -Credential $Credential -ArgumentList $ArgumentList -ScriptBlock $ScriptBlock -AsJob
        if ($job -isnot [System.Management.Automation.Job]) {
            # In-process regression harnesses can replace Invoke-Command with a
            # synchronous function. Production PowerShell Direct with -AsJob
            # always returns a Job and follows the bounded path below.
            $synchronousResult = @($job)
            $job = $null
            return $synchronousResult
        }
        $completed = Wait-Job -Job $job -Timeout $TimeoutSeconds
        if ($null -eq $completed) {
            # Stop only the remoting job created above. Never stop jobs by name,
            # VM, owner, or process image.
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            $partialOutput = @(
                Receive-Job -Job $job -Keep -ErrorAction SilentlyContinue |
                    ForEach-Object { [string]$_ }
            ) -join [Environment]::NewLine
            $partialErrors = @(
                $job.ChildJobs |
                    ForEach-Object { $_.Error } |
                    ForEach-Object { [string]$_ }
            ) -join [Environment]::NewLine
            throw (New-RelayStageException -Stage $Stage -Message "PowerShell Direct stage '$Stage' timed out after $TimeoutSeconds seconds; its owned remoting job was stopped." -Stdout $partialOutput -Stderr $partialErrors -TimedOut $true)
        }

        # Keep the streams until the structured failure has been assembled.
        # Receive-Job without -Keep drains the child Error stream first, which
        # used to reduce real guest failures to an empty "stage failed" shell.
        $remoteOutput = @(Receive-Job -Job $job -Keep -ErrorAction SilentlyContinue)
        $remoteErrors = @(
            foreach ($childJob in @($job.ChildJobs)) {
                foreach ($errorRecord in @($childJob.Error)) {
                    [string]$errorRecord
                }
                # Terminating remoting failures can populate only the child
                # JobStateInfo reason, leaving Error empty. Preserve that
                # concrete guest exception as part of the stage evidence.
                if ($null -ne $childJob.JobStateInfo.Reason) {
                    [string]$childJob.JobStateInfo.Reason
                }
            }
        )
        if ($job.State -ne 'Completed' -or $remoteErrors.Count -gt 0) {
            $stdout = @($remoteOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
            $stderr = $remoteErrors -join [Environment]::NewLine
            throw (New-RelayStageException -Stage $Stage -Message "PowerShell Direct stage '$Stage' failed: $stderr" -Stdout $stdout -Stderr $stderr)
        }
        return $remoteOutput
    } finally {
        $stopwatch.Stop()
        if ($null -ne $job) {
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
    }
}
