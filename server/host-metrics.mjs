import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./process.mjs";

const HARDWARE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$disks = @()
$diskActivityPercent = $null
try {
  $disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
    Where-Object { $_.Size -gt 0 } |
    ForEach-Object {
      [pscustomobject]@{
        name = [string]$_.DeviceID
        totalBytes = [double]$_.Size
        freeBytes = [double]$_.FreeSpace
      }
    })
} catch {}
try {
  $physicalDiskTotal = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk |
    Where-Object { $_.Name -eq '_Total' } |
    Select-Object -First 1
  if ($null -ne $physicalDiskTotal.PercentDiskTime) {
    $diskActivityPercent = [double]$physicalDiskTotal.PercentDiskTime
  }
} catch {}

$gpuName = $null
try {
  $gpuName = @(Get-CimInstance Win32_VideoController |
    Where-Object { $_.Name -and $_.Name -notmatch 'Remote|Basic Display' } |
    Select-Object -ExpandProperty Name -First 1)[0]
} catch {}

$gpuUsage = $null
$gpuMemoryUsedMiB = $null
$gpuMemoryTotalMiB = $null
$gpuTemperature = $null
$gpuSource = $null
$nvidiaSmi = $null
try {
  $nvidiaSmi = (Get-Command nvidia-smi.exe -ErrorAction Stop).Source
} catch {
  $knownNvidiaPaths = @(
    (Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'),
    (Join-Path $env:SystemRoot 'System32\nvidia-smi.exe')
  )
  $nvidiaSmi = $knownNvidiaPaths | Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
}

if ($nvidiaSmi) {
  try {
    $gpuLine = @(& $nvidiaSmi '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu' '--format=csv,noheader,nounits' 2>$null)[0]
    if ($gpuLine) {
      $gpuParts = @($gpuLine -split ',' | ForEach-Object { $_.Trim() })
      if ($gpuParts.Count -ge 5) {
        $gpuName = $gpuParts[0]
        $gpuUsage = [double]$gpuParts[1]
        $gpuMemoryUsedMiB = [double]$gpuParts[2]
        $gpuMemoryTotalMiB = [double]$gpuParts[3]
        $gpuTemperature = [double]$gpuParts[4]
        $gpuSource = 'nvidia-smi'
      }
    }
  } catch {}
}

if ($null -eq $gpuUsage) {
  try {
    $engines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine |
      Where-Object { $_.Name -match 'engtype_(3D|Graphics|Compute)' })
    if ($engines.Count -gt 0) {
      $maximum = ($engines | Measure-Object -Property UtilizationPercentage -Maximum).Maximum
      if ($null -ne $maximum) {
        $gpuUsage = [double]$maximum
        $gpuSource = 'windows-gpu-counters'
      }
    }
  } catch {}
}

$temperature = $null
$temperatureSensor = $null
$temperatureKind = $null
$temperatureSource = $null
foreach ($provider in @('root/LibreHardwareMonitor', 'root/OpenHardwareMonitor')) {
  if ($null -ne $temperature) { break }
  try {
    $cpuSensors = @(Get-CimInstance -Namespace $provider -ClassName Sensor |
      Where-Object {
        $_.SensorType -eq 'Temperature' -and
        $_.Value -ne $null -and
        ($_.Name -match 'CPU|Package|Core|Tctl|Tdie')
      } |
      Sort-Object -Property Value -Descending)
    if ($cpuSensors.Count -gt 0) {
      $temperature = [double]$cpuSensors[0].Value
      $temperatureSensor = [string]$cpuSensors[0].Name
      $temperatureKind = 'cpu'
      $temperatureSource = $provider
    }
  } catch {}
}

if ($null -eq $temperature) {
  try {
    $acpiSensors = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature |
      Where-Object { $_.CurrentTemperature -gt 0 })
    if ($acpiSensors.Count -gt 0) {
      $converted = @($acpiSensors | ForEach-Object {
        [pscustomobject]@{
          name = [string]$_.InstanceName
          value = ([double]$_.CurrentTemperature / 10) - 273.15
        }
      } | Where-Object { $_.value -gt 0 -and $_.value -lt 150 } |
        Sort-Object -Property value -Descending)
      if ($converted.Count -gt 0) {
        $temperature = [double]$converted[0].value
        $temperatureSensor = $converted[0].name
        $temperatureKind = 'system'
        $temperatureSource = 'windows-acpi'
      }
    }
  } catch {}
}

if ($null -eq $temperature -and $null -ne $gpuTemperature) {
  $temperature = $gpuTemperature
  $temperatureSensor = if ($gpuName) { "$gpuName core" } else { 'GPU core' }
  $temperatureKind = 'gpu'
  $temperatureSource = $gpuSource
}

[pscustomobject]@{
  disks = $disks
  diskActivityPercent = $diskActivityPercent
  gpu = [pscustomobject]@{
    name = $gpuName
    usagePercent = $gpuUsage
    memoryUsedMiB = $gpuMemoryUsedMiB
    memoryTotalMiB = $gpuMemoryTotalMiB
    temperatureCelsius = $gpuTemperature
    source = $gpuSource
  }
  temperature = [pscustomobject]@{
    celsius = $temperature
    sensor = $temperatureSensor
    kind = $temperatureKind
    source = $temperatureSource
  }
} | ConvertTo-Json -Depth 5 -Compress
`;

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function cpuTotals(cpus) {
  return cpus.reduce(
    (totals, cpu) => {
      for (const [name, value] of Object.entries(cpu.times ?? {})) {
        totals.total += Number(value) || 0;
        if (name === "idle") totals.idle += Number(value) || 0;
      }
      return totals;
    },
    { idle: 0, total: 0 },
  );
}

function normalizeDisk(disk) {
  const totalBytes = Number(disk?.totalBytes);
  const freeBytes = Number(disk?.freeBytes);
  if (
    !disk?.name ||
    !Number.isFinite(totalBytes) ||
    totalBytes <= 0 ||
    !Number.isFinite(freeBytes)
  )
    return null;
  const safeFreeBytes = Math.min(totalBytes, Math.max(0, freeBytes));
  return {
    name: String(disk.name),
    totalBytes,
    freeBytes: safeFreeBytes,
    usedBytes: totalBytes - safeFreeBytes,
    usagePercent: clampPercent(
      ((totalBytes - safeFreeBytes) / totalBytes) * 100,
    ),
  };
}

function fallbackDisks({ cwd, env, fileSystem }) {
  const roots = new Set(
    [env.SystemDrive ? `${env.SystemDrive}\\` : null, path.parse(cwd).root]
      .filter(Boolean)
      .map((root) => path.resolve(root)),
  );
  const disks = [];
  for (const root of roots) {
    try {
      const stats = fileSystem.statfsSync(root);
      const blockSize = Number(stats.bsize);
      const totalBytes = blockSize * Number(stats.blocks);
      const freeBytes = blockSize * Number(stats.bavail);
      const disk = normalizeDisk({
        name: path.parse(root).root.replace(/\\$/, ""),
        totalBytes,
        freeBytes,
      });
      if (disk) disks.push(disk);
    } catch {
      // A missing drive should not make the remaining host metrics unavailable.
    }
  }
  return disks;
}

async function collectWindowsHardware(runCommand) {
  const encodedCommand = Buffer.from(HARDWARE_SCRIPT, "utf16le").toString(
    "base64",
  );
  const { stdout } = await runCommand(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedCommand,
    ],
    { timeoutMs: 4_000 },
  );
  const payload = JSON.parse(stdout.trim());
  return {
    disks: Array.isArray(payload.disks)
      ? payload.disks
      : payload.disks
        ? [payload.disks]
        : [],
    diskActivityPercent: payload.diskActivityPercent,
    gpu: payload.gpu ?? {},
    temperature: payload.temperature ?? {},
  };
}

export class HostMetricsSampler {
  constructor({
    cacheTtlMs = 5_000,
    clock = () => Date.now(),
    cwd = process.cwd(),
    env = process.env,
    fileSystem = fs,
    operatingSystem = os,
    platform = process.platform,
    runCommand = runProcess,
    hardwareCollector,
  } = {}) {
    this.cacheTtlMs = cacheTtlMs;
    this.clock = clock;
    this.cwd = cwd;
    this.env = env;
    this.fileSystem = fileSystem;
    this.operatingSystem = operatingSystem;
    this.platform = platform;
    this.runCommand = runCommand;
    this.hardwareCollector =
      hardwareCollector ??
      (() =>
        platform === "win32"
          ? collectWindowsHardware(runCommand)
          : Promise.resolve({ disks: [], gpu: {}, temperature: {} }));
    this.previousCpu = cpuTotals(operatingSystem.cpus());
    this.lastCpuUsage = null;
    this.hardware = null;
    this.hardwareSampledAt = 0;
    this.hardwareInFlight = null;
  }

  sampleCpu() {
    const current = cpuTotals(this.operatingSystem.cpus());
    const totalDelta = current.total - this.previousCpu.total;
    const idleDelta = current.idle - this.previousCpu.idle;
    this.previousCpu = current;
    if (totalDelta > 0) {
      this.lastCpuUsage = clampPercent(
        (1 - Math.max(0, idleDelta) / totalDelta) * 100,
      );
    }
    return {
      available: this.lastCpuUsage !== null,
      usagePercent: this.lastCpuUsage,
      logicalProcessors: this.operatingSystem.cpus().length,
      source: "node-os",
    };
  }

  sampleMemory() {
    const totalBytes = Number(this.operatingSystem.totalmem());
    const freeBytes = Number(this.operatingSystem.freemem());
    const available =
      Number.isFinite(totalBytes) &&
      totalBytes > 0 &&
      Number.isFinite(freeBytes);
    const usedBytes = available
      ? totalBytes - Math.min(totalBytes, Math.max(0, freeBytes))
      : null;
    return {
      available,
      usagePercent: available
        ? clampPercent((usedBytes / totalBytes) * 100)
        : null,
      totalBytes: available ? totalBytes : null,
      usedBytes,
      source: "node-os",
    };
  }

  async sampleHardware() {
    const now = this.clock();
    if (
      this.hardware &&
      now - this.hardwareSampledAt >= 0 &&
      now - this.hardwareSampledAt < this.cacheTtlMs
    )
      return this.hardware;
    if (this.hardwareInFlight) return this.hardwareInFlight;

    this.hardwareInFlight = Promise.resolve()
      .then(() => this.hardwareCollector())
      .then((hardware) => {
        this.hardware = hardware ?? {};
        this.hardwareSampledAt = this.clock();
        return this.hardware;
      })
      .catch((error) => {
        this.hardware = {
          disks: [],
          gpu: {},
          temperature: {},
          error: String(error?.message || error),
        };
        this.hardwareSampledAt = this.clock();
        return this.hardware;
      })
      .finally(() => {
        this.hardwareInFlight = null;
      });
    return this.hardwareInFlight;
  }

  async getSnapshot() {
    const hardware = await this.sampleHardware();
    const disks = (hardware.disks ?? []).map(normalizeDisk).filter(Boolean);
    const effectiveDisks = disks.length
      ? disks
      : fallbackDisks({
          cwd: this.cwd,
          env: this.env,
          fileSystem: this.fileSystem,
        });
    const diskTotalBytes = effectiveDisks.reduce(
      (sum, disk) => sum + disk.totalBytes,
      0,
    );
    const diskUsedBytes = effectiveDisks.reduce(
      (sum, disk) => sum + disk.usedBytes,
      0,
    );
    const rawDiskActivity = hardware.diskActivityPercent;
    const diskActivityPercent =
      rawDiskActivity === null || rawDiskActivity === undefined
        ? null
        : clampPercent(Number(rawDiskActivity));
    const diskCapacityUsagePercent =
      diskTotalBytes > 0
        ? clampPercent((diskUsedBytes / diskTotalBytes) * 100)
        : null;

    const rawGpuUsage = hardware.gpu?.usagePercent;
    const gpuUsage =
      rawGpuUsage === null || rawGpuUsage === undefined
        ? null
        : clampPercent(Number(rawGpuUsage));
    const gpuMemoryUsedBytes =
      hardware.gpu?.memoryUsedMiB !== null &&
      hardware.gpu?.memoryUsedMiB !== undefined &&
      Number.isFinite(Number(hardware.gpu.memoryUsedMiB))
        ? Number(hardware.gpu.memoryUsedMiB) * 1024 * 1024
        : null;
    const gpuMemoryTotalBytes =
      hardware.gpu?.memoryTotalMiB !== null &&
      hardware.gpu?.memoryTotalMiB !== undefined &&
      Number.isFinite(Number(hardware.gpu.memoryTotalMiB))
        ? Number(hardware.gpu.memoryTotalMiB) * 1024 * 1024
        : null;
    const temperatureCelsius = Number(hardware.temperature?.celsius);
    const temperatureAvailable =
      Number.isFinite(temperatureCelsius) &&
      temperatureCelsius > 0 &&
      temperatureCelsius < 150;
    const sampledAt = this.clock();

    return {
      sampledAt: new Date(sampledAt).toISOString(),
      cacheAgeMs: Math.max(0, sampledAt - this.hardwareSampledAt),
      cpu: this.sampleCpu(),
      memory: this.sampleMemory(),
      temperature: {
        available: temperatureAvailable,
        celsius: temperatureAvailable
          ? Math.round(temperatureCelsius * 10) / 10
          : null,
        sensor: temperatureAvailable
          ? String(hardware.temperature?.sensor || "Temperature sensor")
          : null,
        kind: temperatureAvailable
          ? String(hardware.temperature?.kind || "system")
          : null,
        source: temperatureAvailable
          ? String(hardware.temperature?.source || "windows-sensor")
          : null,
      },
      gpu: {
        available: gpuUsage !== null || Boolean(hardware.gpu?.name),
        usagePercent: gpuUsage,
        name: hardware.gpu?.name ? String(hardware.gpu.name) : null,
        memoryUsedBytes: gpuMemoryUsedBytes,
        memoryTotalBytes: gpuMemoryTotalBytes,
        memoryUsagePercent:
          gpuMemoryUsedBytes !== null &&
          gpuMemoryTotalBytes !== null &&
          gpuMemoryTotalBytes > 0
            ? clampPercent((gpuMemoryUsedBytes / gpuMemoryTotalBytes) * 100)
            : null,
        source: hardware.gpu?.source ? String(hardware.gpu.source) : null,
      },
      disk: {
        available: effectiveDisks.length > 0 && diskTotalBytes > 0,
        usagePercent: diskActivityPercent ?? diskCapacityUsagePercent,
        capacityUsagePercent: diskCapacityUsagePercent,
        metricKind: diskActivityPercent !== null ? "activity" : "capacity",
        totalBytes: diskTotalBytes || null,
        usedBytes: diskTotalBytes ? diskUsedBytes : null,
        volumes: effectiveDisks,
        source:
          diskActivityPercent !== null
            ? "windows-disk-counters"
            : disks.length
              ? "windows-cim"
              : "node-statfs",
      },
      warning: hardware.error ?? null,
    };
  }
}
