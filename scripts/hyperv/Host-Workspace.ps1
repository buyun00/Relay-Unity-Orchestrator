function Wait-RelayHostWorkspace {
    [CmdletBinding()]
    param(
        [AllowEmptyString()][string]$SharePath,
        [ValidateRange(0, 60)][int]$TimeoutSeconds = 60
    )

    if ([string]::IsNullOrWhiteSpace($SharePath)) { return $true }

    # PowerShell Direct can be ready before the restored guest's SMB service.
    # Only probe here: never reset sessions, restore checkpoints, or touch Git.
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        try {
            if (Test-Path -LiteralPath $SharePath -PathType Container -ErrorAction Stop) {
                return $true
            }
        } catch {
            # A transient transport exception is also an unavailable share.
        }
        $remainingMs = ($TimeoutSeconds * 1000) - $timer.ElapsedMilliseconds
        if ($remainingMs -le 0) { return $false }
        Start-Sleep -Milliseconds ([int][Math]::Min(2000, $remainingMs))
    } while ($true)
}
