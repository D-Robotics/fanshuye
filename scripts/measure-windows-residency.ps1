[CmdletBinding()]
param(
  [string]$ProcessName = 'fanshuye-desktop',

  [ValidateRange(10, 86400)]
  [int]$DurationSeconds = 1800,

  [ValidateRange(0, 3600)]
  [int]$WarmupSeconds = 300,

  [ValidateRange(1, 60)]
  [int]$SampleSeconds = 10,

  [ValidateRange(0.0, 100.0)]
  [double]$MaxAverageCpuPercent = 1.0,

  [ValidateRange(0.0, 100.0)]
  [double]$MaxP95CpuPercent = 3.0,

  [ValidateRange(0.0, 4096.0)]
  [double]$MaxWorkingSetGrowthMb = 50.0,

  [ValidateRange(0, 1000)]
  [int]$MaxEstablishedTcpConnections = 0,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
if ($WarmupSeconds -ge $DurationSeconds) {
  throw 'WarmupSeconds must be lower than DurationSeconds.'
}
if ([System.IO.Path]::GetExtension($OutputPath) -ine '.json') {
  throw 'OutputPath must use the .json extension.'
}
$outputDirectoryInput = Split-Path -Parent $OutputPath
if ([string]::IsNullOrWhiteSpace($outputDirectoryInput)) {
  $outputDirectoryInput = '.'
}
$outputDirectory = (Resolve-Path -LiteralPath $outputDirectoryInput -ErrorAction Stop).Path
$resolvedOutputPath = Join-Path $outputDirectory (Split-Path -Leaf $OutputPath)

# The evidence is invalid if Windows suspends the machine between samples. This
# execution-state request is scoped to this PowerShell process and is released
# automatically when the sampler exits; it does not keep the display awake.
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class FanshuyeResidencyNativeMethods {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint executionState);
}
'@
$executionStateContinuous = [Convert]::ToUInt32('80000000', 16)
$executionStateSystemRequired = [uint32]0x00000001
$executionStateResult = [FanshuyeResidencyNativeMethods]::SetThreadExecutionState(
  $executionStateContinuous -bor $executionStateSystemRequired
)
if ($executionStateResult -eq 0) {
  throw 'Windows did not accept the residency sampler sleep-prevention request.'
}

function Get-TrackedProcessIds {
  param([int[]]$RootIds)

  $processRows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
  $tracked = [System.Collections.Generic.HashSet[int]]::new()
  $pending = [System.Collections.Generic.Queue[int]]::new()
  foreach ($rootId in $RootIds) {
    [void]$tracked.Add($rootId)
    $pending.Enqueue($rootId)
  }
  while ($pending.Count -gt 0) {
    $parentId = $pending.Dequeue()
    foreach ($child in @($processRows | Where-Object { $_.ParentProcessId -eq $parentId })) {
      $childId = [int]$child.ProcessId
      if ($tracked.Add($childId)) {
        $pending.Enqueue($childId)
      }
    }
  }
  return @($tracked)
}

function Get-EstablishedTcpCount {
  param([int[]]$ProcessIds)

  if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    return $null
  }
  try {
    return @(
      Get-NetTCPConnection -State Established -ErrorAction Stop |
        Where-Object { $ProcessIds -contains [int]$_.OwningProcess }
    ).Count
  } catch {
    return $null
  }
}

function Get-Percentile95 {
  param([double[]]$Values)

  if ($Values.Count -eq 0) {
    return 0.0
  }
  $sorted = @($Values | Sort-Object)
  $index = [Math]::Max(0, [Math]::Ceiling($sorted.Count * 0.95) - 1)
  return [double]$sorted[$index]
}

$rootProcesses = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
if ($rootProcesses.Count -eq 0) {
  [Console]::Error.WriteLine("No running process named '$ProcessName' was found.")
  exit 6
}

$logicalProcessorCount = [Math]::Max(1, [Environment]::ProcessorCount)
$previousCpuByProcess = @{}
$samples = [System.Collections.Generic.List[object]]::new()
$startedAt = [datetimeoffset]::Now
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$previousElapsedSeconds = 0.0

while ($stopwatch.Elapsed.TotalSeconds -lt $DurationSeconds) {
  $rootIds = @(
    Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
      ForEach-Object { [int]$_.Id }
  )
  if ($rootIds.Count -eq 0) {
    [Console]::Error.WriteLine("The process '$ProcessName' exited during residency sampling.")
    exit 6
  }
  $processIds = @(Get-TrackedProcessIds -RootIds $rootIds)
  $processes = @(Get-Process -Id $processIds -ErrorAction SilentlyContinue)
  $elapsedSeconds = $stopwatch.Elapsed.TotalSeconds
  $intervalSeconds = [Math]::Max(0.001, $elapsedSeconds - $previousElapsedSeconds)
  $hasCpuBaseline = $previousCpuByProcess.Count -gt 0
  $cpuDeltaSeconds = 0.0
  $currentCpuByProcess = @{}
  foreach ($process in $processes) {
    $cpuSeconds = if ($null -eq $process.CPU) { 0.0 } else { [double]$process.CPU }
    $currentCpuByProcess[$process.Id] = $cpuSeconds
    if ($previousCpuByProcess.ContainsKey($process.Id)) {
      $cpuDeltaSeconds += [Math]::Max(0.0, $cpuSeconds - [double]$previousCpuByProcess[$process.Id])
    }
  }
  $cpuPercent = 100.0 * $cpuDeltaSeconds / $intervalSeconds / $logicalProcessorCount
  $workingSetBytes = [double](($processes | Measure-Object -Property WorkingSet64 -Sum).Sum)
  $privateBytes = [double](($processes | Measure-Object -Property PrivateMemorySize64 -Sum).Sum)
  $handleCount = [int](($processes | Measure-Object -Property HandleCount -Sum).Sum)
  $tcpConnections = Get-EstablishedTcpCount -ProcessIds $processIds
  $samples.Add([pscustomobject][ordered]@{
      elapsedSeconds = [Math]::Round($elapsedSeconds, 3)
      includedAfterWarmup = $elapsedSeconds -ge $WarmupSeconds -and $hasCpuBaseline
      processCount = $processes.Count
      cpuPercent = [Math]::Round($cpuPercent, 4)
      workingSetMb = [Math]::Round($workingSetBytes / 1MB, 3)
      privateMemoryMb = [Math]::Round($privateBytes / 1MB, 3)
      handleCount = $handleCount
      establishedTcpConnections = $tcpConnections
    })
  $previousCpuByProcess = $currentCpuByProcess
  $previousElapsedSeconds = $elapsedSeconds

  $remainingSeconds = $DurationSeconds - $stopwatch.Elapsed.TotalSeconds
  if ($remainingSeconds -gt 0) {
    Start-Sleep -Milliseconds ([int]([Math]::Min($SampleSeconds, $remainingSeconds) * 1000))
  }
}
$stopwatch.Stop()

$acceptedSamples = @($samples | Where-Object { $_.includedAfterWarmup })
if ($acceptedSamples.Count -lt 2) {
  throw 'Residency measurement produced fewer than two post-warmup samples.'
}
$theoreticalPostWarmupSamples = ($DurationSeconds - $WarmupSeconds) / $SampleSeconds
$minimumPostWarmupSamples = [Math]::Max(
  2,
  [Math]::Floor($theoreticalPostWarmupSamples * 0.8)
)
$maximumAllowedSampleGapSeconds = $SampleSeconds * 2.5 + 2
$maximumObservedSampleGapSeconds = 0.0
for ($index = 1; $index -lt $samples.Count; $index += 1) {
  $gapSeconds = [double]$samples[$index].elapsedSeconds - [double]$samples[$index - 1].elapsedSeconds
  $maximumObservedSampleGapSeconds = [Math]::Max($maximumObservedSampleGapSeconds, $gapSeconds)
}
$cpuValues = @($acceptedSamples | ForEach-Object { [double]$_.cpuPercent })
$averageCpu = [double](($cpuValues | Measure-Object -Average).Average)
$p95Cpu = Get-Percentile95 -Values $cpuValues
$workingSetGrowth = [double]$acceptedSamples[-1].workingSetMb - [double]$acceptedSamples[0].workingSetMb
$knownTcpSamples = @(
  $acceptedSamples | Where-Object { $null -ne $_.establishedTcpConnections }
)
$maximumTcpConnections = if ($knownTcpSamples.Count -eq 0) {
  $null
} else {
  [int](($knownTcpSamples | Measure-Object -Property establishedTcpConnections -Maximum).Maximum)
}
$failures = [System.Collections.Generic.List[string]]::new()
if ($acceptedSamples.Count -lt $minimumPostWarmupSamples) {
  $failures.Add('Residency sampling was interrupted and did not collect enough post-warmup samples.')
}
if ($maximumObservedSampleGapSeconds -gt $maximumAllowedSampleGapSeconds) {
  $failures.Add('Residency sampling was interrupted by an excessive sample gap.')
}
if ($averageCpu -gt $MaxAverageCpuPercent) {
  $failures.Add('Average hidden CPU exceeded the configured threshold.')
}
if ($p95Cpu -gt $MaxP95CpuPercent) {
  $failures.Add('P95 hidden CPU exceeded the configured threshold.')
}
if ($workingSetGrowth -gt $MaxWorkingSetGrowthMb) {
  $failures.Add('Hidden working-set growth exceeded the configured threshold.')
}
if ($null -eq $maximumTcpConnections) {
  $failures.Add('Established TCP connection count could not be measured.')
} elseif ($maximumTcpConnections -gt $MaxEstablishedTcpConnections) {
  $failures.Add('Hidden process tree retained established TCP connections.')
}

$result = [ordered]@{
  schemaVersion = 1
  processName = $ProcessName
  rootProcessIdsAtStart = @($rootProcesses | ForEach-Object { $_.Id })
  startedAt = $startedAt.ToString('o')
  completedAt = [datetimeoffset]::Now.ToString('o')
  durationSeconds = $DurationSeconds
  warmupSeconds = $WarmupSeconds
  sampleSeconds = $SampleSeconds
  logicalProcessorCount = $logicalProcessorCount
  systemSleepPreventedDuringSampling = $true
  thresholds = [ordered]@{
    maxAverageCpuPercent = $MaxAverageCpuPercent
    maxP95CpuPercent = $MaxP95CpuPercent
    maxWorkingSetGrowthMb = $MaxWorkingSetGrowthMb
    maxEstablishedTcpConnections = $MaxEstablishedTcpConnections
    maximumAllowedSampleGapSeconds = [Math]::Round($maximumAllowedSampleGapSeconds, 3)
  }
  summary = [ordered]@{
    averageCpuPercent = [Math]::Round($averageCpu, 4)
    p95CpuPercent = [Math]::Round($p95Cpu, 4)
    workingSetGrowthMb = [Math]::Round($workingSetGrowth, 3)
    maximumEstablishedTcpConnections = $maximumTcpConnections
    postWarmupSamples = $acceptedSamples.Count
    minimumRequiredPostWarmupSamples = $minimumPostWarmupSamples
    maximumObservedSampleGapSeconds = [Math]::Round($maximumObservedSampleGapSeconds, 3)
  }
  passed = $failures.Count -eq 0
  failures = @($failures)
  samples = @($samples)
}
$json = $result | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($resolvedOutputPath, $json, [System.Text.UTF8Encoding]::new($false))
$json

if ($failures.Count -gt 0) {
  exit 7
}
