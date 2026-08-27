[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('native-e2e', 'release')]
  [string]$Kind,

  [Parameter(Mandatory = $true)]
  [string]$EvidencePath,

  [string]$ExpectedSignerSubject = $env:WINDOWS_EXPECTED_SIGNER_SUBJECT
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$resolvedEvidencePath = (Resolve-Path -LiteralPath $EvidencePath -ErrorAction Stop).Path
$evidenceDirectory = Split-Path -Parent $resolvedEvidencePath
$evidence = Get-Content -Raw -Encoding UTF8 -LiteralPath $resolvedEvidencePath | ConvertFrom-Json
$failures = [System.Collections.Generic.List[string]]::new()
$validatedEvidenceFiles = [System.Collections.Generic.List[string]]::new()
$evidenceHashUsage = @{}

function Require-Text {
  param([string]$Name, [object]$Value)

  if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) {
    $failures.Add("Missing or non-text metadata field: $Name")
  }
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $algorithm.ComputeHash($stream)
      return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Resolve-ReferencedFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Reference,
    [Parameter(Mandatory = $true)]
    [string]$FieldName
  )

  if ($Reference -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
    $failures.Add("$FieldName must reference a local evidence file, not a URI")
    return $null
  }
  $candidate = if ([System.IO.Path]::IsPathRooted($Reference)) {
    $Reference
  } else {
    Join-Path $evidenceDirectory $Reference
  }
  try {
    $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
      $failures.Add("$FieldName does not reference a regular file: $Reference")
      return $null
    }
    return $resolved
  } catch {
    $failures.Add("$FieldName evidence file does not exist: $Reference")
    return $null
  }
}

function Convert-ToVersion {
  param(
    [string]$Name,
    [object]$Value
  )

  if ($Value -isnot [string] -or $Value -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') {
    $failures.Add("$Name must be a numeric three- or four-part version")
    return $null
  }
  try {
    return [version]$Value
  } catch {
    $failures.Add("$Name is not a valid version")
    return $null
  }
}

function Get-NormalizedVersion {
  param([Parameter(Mandatory = $true)][version]$Version)

  $build = if ($Version.Build -lt 0) { 0 } else { $Version.Build }
  $revision = if ($Version.Revision -lt 0) { 0 } else { $Version.Revision }
  return "$($Version.Major).$($Version.Minor).$build.$revision"
}

function Test-JsonFiniteNumber {
  param([object]$Value)

  $isNumeric = $Value -is [byte] -or $Value -is [sbyte] -or
    $Value -is [int16] -or $Value -is [uint16] -or
    $Value -is [int32] -or $Value -is [uint32] -or
    $Value -is [int64] -or $Value -is [uint64] -or
    $Value -is [single] -or $Value -is [double] -or $Value -is [decimal]
  if (-not $isNumeric) { return $false }
  $number = [double]$Value
  return -not [double]::IsNaN($number) -and -not [double]::IsInfinity($number)
}

function Test-JsonNonNegativeNumber {
  param([object]$Value)

  return (Test-JsonFiniteNumber -Value $Value) -and [double]$Value -ge 0
}

function Test-JsonNonNegativeInteger {
  param([object]$Value)

  return (Test-JsonNonNegativeNumber -Value $Value) -and
    [Math]::Truncate([double]$Value) -eq [double]$Value
}

function Test-MediaEvidenceSignature {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Extension
  )

  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $prefix = [byte[]]::new(16)
    $read = $stream.Read($prefix, 0, $prefix.Length)
  } finally {
    $stream.Dispose()
  }
  if ($read -lt 12) { return $false }

  $ascii = [System.Text.Encoding]::ASCII.GetString($prefix)
  switch ($Extension) {
    '.png' { return ($prefix[0..7] -join ',') -eq '137,80,78,71,13,10,26,10' }
    '.jpg' { return $prefix[0] -eq 0xff -and $prefix[1] -eq 0xd8 -and $prefix[2] -eq 0xff }
    '.jpeg' { return $prefix[0] -eq 0xff -and $prefix[1] -eq 0xd8 -and $prefix[2] -eq 0xff }
    '.gif' { return $ascii.StartsWith('GIF87a') -or $ascii.StartsWith('GIF89a') }
    '.webp' { return $ascii.StartsWith('RIFF') -and $ascii.Substring(8, 4) -eq 'WEBP' }
    '.mp4' { return $ascii.Substring(4, 4) -eq 'ftyp' }
    '.mov' { return $ascii.Substring(4, 4) -eq 'ftyp' }
    '.webm' { return ($prefix[0..3] -join ',') -eq '26,69,223,163' }
    '.mkv' { return ($prefix[0..3] -join ',') -eq '26,69,223,163' }
    default { return $false }
  }
}

function Test-ResidencyEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$CaseId
  )

  try {
    $measurement = Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json
  } catch {
    $failures.Add("Case $CaseId must reference valid residency JSON")
    return $false
  }
  if (-not (Test-JsonNonNegativeInteger -Value $measurement.schemaVersion) -or
    [int]$measurement.schemaVersion -ne 1 -or
    $measurement.processName -cne 'fanshuye-desktop' -or
    -not (Test-JsonNonNegativeInteger -Value $measurement.durationSeconds) -or
    [int]$measurement.durationSeconds -lt 1800 -or
    -not (Test-JsonNonNegativeInteger -Value $measurement.warmupSeconds) -or
    [int]$measurement.warmupSeconds -lt 300 -or
    [int]$measurement.warmupSeconds -ge [int]$measurement.durationSeconds -or
    -not (Test-JsonNonNegativeInteger -Value $measurement.sampleSeconds) -or
    [int]$measurement.sampleSeconds -lt 1 -or
    [int]$measurement.sampleSeconds -gt 60 -or
    $measurement.passed -isnot [bool] -or
    $measurement.passed -ne $true -or
    $measurement.failures -isnot [array] -or
    @($measurement.failures).Count -ne 0 -or
    $null -eq $measurement.thresholds -or
    $null -eq $measurement.summary -or
    $measurement.samples -isnot [array]) {
    $failures.Add("Case $CaseId does not contain a passing 30-minute residency measurement")
    return $false
  }

  if (-not (Test-JsonNonNegativeNumber -Value $measurement.thresholds.maxAverageCpuPercent) -or
    -not (Test-JsonNonNegativeNumber -Value $measurement.thresholds.maxP95CpuPercent) -or
    -not (Test-JsonNonNegativeNumber -Value $measurement.thresholds.maxWorkingSetGrowthMb) -or
    -not (Test-JsonNonNegativeInteger -Value $measurement.thresholds.maxEstablishedTcpConnections) -or
    -not (Test-JsonNonNegativeNumber -Value $measurement.summary.averageCpuPercent) -or
    -not (Test-JsonNonNegativeNumber -Value $measurement.summary.p95CpuPercent) -or
    -not (Test-JsonFiniteNumber -Value $measurement.summary.workingSetGrowthMb) -or
    -not (Test-JsonNonNegativeInteger -Value $measurement.summary.maximumEstablishedTcpConnections) -or
    -not (Test-JsonNonNegativeInteger -Value $measurement.summary.postWarmupSamples) -or
    [double]$measurement.thresholds.maxAverageCpuPercent -gt 1.0 -or
    [double]$measurement.thresholds.maxP95CpuPercent -gt 3.0 -or
    [double]$measurement.thresholds.maxWorkingSetGrowthMb -gt 50.0 -or
    [int]$measurement.thresholds.maxEstablishedTcpConnections -ne 0 -or
    [double]$measurement.summary.averageCpuPercent -gt 1.0 -or
    [double]$measurement.summary.p95CpuPercent -gt 3.0 -or
    [double]$measurement.summary.workingSetGrowthMb -gt 50.0 -or
    [int]$measurement.summary.maximumEstablishedTcpConnections -ne 0) {
    $failures.Add("Case $CaseId used weaker residency thresholds or exceeded the product limits")
    return $false
  }

  $startedAt = [datetimeoffset]::MinValue
  $completedAt = [datetimeoffset]::MinValue
  $hasValidTimes = [datetimeoffset]::TryParse([string]$measurement.startedAt, [ref]$startedAt) -and
    [datetimeoffset]::TryParse([string]$measurement.completedAt, [ref]$completedAt)
  if (-not $hasValidTimes -or
    ($completedAt - $startedAt).TotalSeconds -lt ([double]$measurement.durationSeconds - 2)) {
    $failures.Add("Case $CaseId timestamps do not span the declared residency duration")
    return $false
  }

  $previousElapsed = -1.0
  foreach ($sample in @($measurement.samples)) {
    if ($sample.includedAfterWarmup -isnot [bool] -or
      -not (Test-JsonNonNegativeNumber -Value $sample.elapsedSeconds) -or
      -not (Test-JsonNonNegativeNumber -Value $sample.cpuPercent) -or
      -not (Test-JsonNonNegativeNumber -Value $sample.workingSetMb) -or
      ($sample.includedAfterWarmup -and
        -not (Test-JsonNonNegativeInteger -Value $sample.establishedTcpConnections)) -or
      [double]$sample.elapsedSeconds -lt $previousElapsed -or
      $sample.includedAfterWarmup -ne (
        [double]$sample.elapsedSeconds -ge [double]$measurement.warmupSeconds
      )) {
      $failures.Add("Case $CaseId contains malformed or inconsistent raw samples")
      return $false
    }
    $previousElapsed = [double]$sample.elapsedSeconds
  }

  $postWarmupSamples = @($measurement.samples | Where-Object { $_.includedAfterWarmup -eq $true })
  $theoreticalPostWarmupSamples = (
    [double]$measurement.durationSeconds - [double]$measurement.warmupSeconds
  ) / [double]$measurement.sampleSeconds
  $minimumPostWarmupSamples = [Math]::Max(
    2,
    [Math]::Floor($theoreticalPostWarmupSamples * 0.8)
  )
  if ($postWarmupSamples.Count -lt $minimumPostWarmupSamples -or
    [int]$measurement.summary.postWarmupSamples -ne $postWarmupSamples.Count) {
    $failures.Add("Case $CaseId sample count is inconsistent with the declared duration")
    return $false
  }
  $lastSample = @($measurement.samples)[-1]
  if ([double]$lastSample.elapsedSeconds -lt (
      [double]$measurement.durationSeconds - [double]$measurement.sampleSeconds - 2
    )) {
    $failures.Add("Case $CaseId samples do not cover the declared residency duration")
    return $false
  }

  $cpuValues = @($postWarmupSamples | ForEach-Object { [double]$_.cpuPercent })
  $recomputedAverage = [double](($cpuValues | Measure-Object -Average).Average)
  $sortedCpu = @($cpuValues | Sort-Object)
  $p95Index = [Math]::Max(0, [Math]::Ceiling($sortedCpu.Count * 0.95) - 1)
  $recomputedP95 = [double]$sortedCpu[$p95Index]
  $recomputedGrowth = [double]$postWarmupSamples[-1].workingSetMb -
    [double]$postWarmupSamples[0].workingSetMb
  $tcpValues = @(
    $postWarmupSamples |
      Where-Object { $null -ne $_.establishedTcpConnections } |
      ForEach-Object { [int]$_.establishedTcpConnections }
  )
  $recomputedMaxTcp = if ($tcpValues.Count -eq 0) {
    $null
  } else {
    [int](($tcpValues | Measure-Object -Maximum).Maximum)
  }
  if ([Math]::Abs($recomputedAverage - [double]$measurement.summary.averageCpuPercent) -gt 0.01 -or
    [Math]::Abs($recomputedP95 - [double]$measurement.summary.p95CpuPercent) -gt 0.01 -or
    [Math]::Abs($recomputedGrowth - [double]$measurement.summary.workingSetGrowthMb) -gt 0.01 -or
    $null -eq $recomputedMaxTcp -or
    $recomputedMaxTcp -ne [int]$measurement.summary.maximumEstablishedTcpConnections) {
    $failures.Add("Case $CaseId summary does not match its raw samples")
    return $false
  }
  return $true
}

if ($evidence.schemaVersion -isnot [int] -or $evidence.schemaVersion -ne 1) {
  $failures.Add('schemaVersion must be the number 1')
}

Require-Text -Name 'tester' -Value $evidence.tester
Require-Text -Name 'executedAt' -Value $evidence.executedAt
Require-Text -Name 'windowsBuild' -Value $evidence.windowsBuild
Require-Text -Name 'webView2Version' -Value $evidence.webView2Version
Require-Text -Name 'appVersion' -Value $evidence.appVersion

if ($evidence.tester -is [string] -and
  $evidence.tester -match '^(?i:todo|tbd|unknown|template|tester|n/?a|null|-)$') {
  $failures.Add('tester must identify the actual human tester and cannot be a placeholder')
}

$parsedExecutedAt = [datetimeoffset]::MinValue
$hasTimezone = $evidence.executedAt -is [string] -and
  $evidence.executedAt -match '(?:Z|[+-]\d{2}:\d{2})$'
$validExecutedAt = $hasTimezone -and [datetimeoffset]::TryParse(
  [string]$evidence.executedAt,
  [System.Globalization.CultureInfo]::InvariantCulture,
  [System.Globalization.DateTimeStyles]::RoundtripKind,
  [ref]$parsedExecutedAt
)
if ($evidence.executedAt -and -not $validExecutedAt) {
  $failures.Add('executedAt must be an ISO-8601 timestamp with an explicit timezone')
} elseif ($validExecutedAt -and $parsedExecutedAt -gt [datetimeoffset]::Now.AddMinutes(15)) {
  $failures.Add('executedAt cannot be more than 15 minutes in the future')
}

$rootPackage = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repositoryRoot 'package.json') |
  ConvertFrom-Json
$desktopPackage = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repositoryRoot 'apps\desktop\package.json') |
  ConvertFrom-Json
$tauriConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repositoryRoot 'apps\desktop\src-tauri\tauri.conf.json') |
  ConvertFrom-Json
$repositoryVersions = @(
  @(
    [string]$rootPackage.version,
    [string]$desktopPackage.version,
    [string]$tauriConfig.version
  ) | Select-Object -Unique
)
if ($repositoryVersions.Count -ne 1) {
  $failures.Add("Repository app versions disagree: $($repositoryVersions -join ', ')")
} elseif ($evidence.appVersion -ne $repositoryVersions[0]) {
  $failures.Add("appVersion must match the repository version $($repositoryVersions[0])")
}
$currentVersion = Convert-ToVersion -Name 'appVersion' -Value $evidence.appVersion

$requiredCaseIds = if ($Kind -eq 'native-e2e') {
  @(
    'display.single-monitor',
    'display.dual-monitor',
    'dpi.100',
    'dpi.125',
    'dpi.150',
    'dpi.200',
    'display.primary-switch',
    'display.unplug-resume',
    'overlay.hover-delay',
    'overlay.pin-escape',
    'overlay.editor-focus',
    'tray.toggle-exit',
    'shortcut.single-instance-autostart',
    'runtime.restart-session-entry',
    'security.credential-manager-isolation',
    'runtime.server-health-snapshot',
    'resource.hidden-cpu-memory',
    'fallback.side-panel',
    'privacy.dnd-reduced-motion',
    'sync.offline-reconnect-conflict'
  )
} else {
  Require-Text -Name 'installerPath' -Value $evidence.installerPath
  Require-Text -Name 'installerSha256' -Value $evidence.installerSha256
  Require-Text -Name 'signatureStatus' -Value $evidence.signatureStatus
  Require-Text -Name 'signerSubject' -Value $evidence.signerSubject
  Require-Text -Name 'previousVersion' -Value $evidence.previousVersion
  if ($evidence.installerSha256 -and $evidence.installerSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    $failures.Add('installerSha256 must contain exactly 64 hexadecimal characters')
  }
  if ($evidence.signatureStatus -and $evidence.signatureStatus -ne 'Valid') {
    $failures.Add('signatureStatus must be Valid')
  }
  if ([string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
    $failures.Add('ExpectedSignerSubject or WINDOWS_EXPECTED_SIGNER_SUBJECT is required as an external signer trust anchor')
  }
  $previousVersion = Convert-ToVersion -Name 'previousVersion' -Value $evidence.previousVersion
  if ($currentVersion -and $previousVersion -and $previousVersion -ge $currentVersion) {
    $failures.Add('previousVersion must be lower than appVersion for an upgrade test')
  }
  @(
    'install.clean',
    'install.upgrade',
    'runtime.single-instance',
    'runtime.normal-exit',
    'uninstall.application-removed',
    'uninstall.cache-policy'
  )
}

if ($evidence.cases -isnot [array]) {
  $failures.Add('cases must be a JSON array')
}
$caseIndex = @{}
foreach ($recordedCase in @($evidence.cases)) {
  if ($recordedCase.id -isnot [string] -or [string]::IsNullOrWhiteSpace($recordedCase.id)) {
    $failures.Add('Every case must have a non-empty text id')
    continue
  }
  if ($caseIndex.ContainsKey($recordedCase.id)) {
    $failures.Add("Duplicate case id: $($recordedCase.id)")
    continue
  }
  $caseIndex[$recordedCase.id] = $recordedCase
}

$mediaEvidenceExtensions = @(
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.mp4',
  '.webm',
  '.mkv',
  '.mov'
)
foreach ($requiredCaseId in $requiredCaseIds) {
  if (-not $caseIndex.ContainsKey($requiredCaseId)) {
    $failures.Add("Missing required case: $requiredCaseId")
    continue
  }
  $recordedCase = $caseIndex[$requiredCaseId]
  if ($recordedCase.status -isnot [string] -or $recordedCase.status -cne 'pass') {
    $failures.Add("Case $requiredCaseId is not pass (status=$($recordedCase.status))")
  }
  if ($recordedCase.notes -isnot [string] -or [string]::IsNullOrWhiteSpace($recordedCase.notes)) {
    $failures.Add("Case $requiredCaseId must describe the observed behavior in notes")
  }
  if ($recordedCase.evidence -isnot [string] -or
    [string]::IsNullOrWhiteSpace($recordedCase.evidence)) {
    $failures.Add("Case $requiredCaseId has no local evidence reference")
    continue
  }
  if ($recordedCase.evidenceSha256 -isnot [string] -or
    $recordedCase.evidenceSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    $failures.Add("Case $requiredCaseId evidenceSha256 must contain exactly 64 hexadecimal characters")
    continue
  }

  $caseEvidencePath = Resolve-ReferencedFile `
    -Reference $recordedCase.evidence `
    -FieldName "Case $requiredCaseId"
  if (-not $caseEvidencePath) {
    continue
  }
  if ($caseEvidencePath -eq $resolvedEvidencePath) {
    $failures.Add("Case $requiredCaseId cannot use the evidence manifest itself as evidence")
    continue
  }
  $caseEvidenceFile = Get-Item -LiteralPath $caseEvidencePath
  $extension = $caseEvidenceFile.Extension.ToLowerInvariant()
  $allowedEvidenceExtensions = if ($requiredCaseId -eq 'resource.hidden-cpu-memory') {
    @('.json')
  } else {
    $mediaEvidenceExtensions
  }
  if ($allowedEvidenceExtensions -notcontains $extension) {
    $failures.Add("Case $requiredCaseId uses an unsupported evidence file type: $($caseEvidenceFile.Extension)")
    continue
  }
  $minimumBytes = if ($extension -eq '.json') { 512 } elseif ($extension -in @('.mp4', '.webm', '.mkv', '.mov')) { 32768 } else { 2048 }
  if ($caseEvidenceFile.Length -lt $minimumBytes) {
    $failures.Add("Case $requiredCaseId evidence file is too small for its declared type")
    continue
  }
  if ($extension -eq '.json') {
    if (-not (Test-ResidencyEvidence -Path $caseEvidencePath -CaseId $requiredCaseId)) {
      continue
    }
  } elseif (-not (Test-MediaEvidenceSignature -Path $caseEvidencePath -Extension $extension)) {
    $failures.Add("Case $requiredCaseId evidence file signature does not match $extension")
    continue
  }
  $actualEvidenceHash = Get-Sha256 -Path $caseEvidencePath
  if ($actualEvidenceHash -ne $recordedCase.evidenceSha256) {
    $failures.Add("Case $requiredCaseId evidence SHA-256 does not match the referenced file")
    continue
  }
  if (-not $evidenceHashUsage.ContainsKey($actualEvidenceHash)) {
    $evidenceHashUsage[$actualEvidenceHash] = [System.Collections.Generic.List[string]]::new()
  }
  $evidenceHashUsage[$actualEvidenceHash].Add($requiredCaseId)
  if ($validatedEvidenceFiles -notcontains $caseEvidencePath) {
    $validatedEvidenceFiles.Add($caseEvidencePath)
  }
}

foreach ($usage in $evidenceHashUsage.GetEnumerator()) {
  if ($usage.Value.Count -le 1) { continue }
  foreach ($caseId in $usage.Value) {
    $notes = [string]$caseIndex[$caseId].notes
    if ($notes -notmatch '(?i:timecode)=\d{1,2}:[0-5]\d:[0-5]\d(?!\d)') {
      $failures.Add("Case $caseId reuses evidence and must include its recording timecode in notes")
    }
  }
}

$validatedInstallerPath = $null
if ($Kind -eq 'release' -and $evidence.installerPath -is [string] -and $evidence.installerPath) {
  $validatedInstallerPath = Resolve-ReferencedFile `
    -Reference $evidence.installerPath `
    -FieldName 'installerPath'
  if ($validatedInstallerPath) {
    $installer = Get-Item -LiteralPath $validatedInstallerPath
    if ($installer.Extension -ine '.exe' -or $installer.Length -le 0) {
      $failures.Add('installerPath must reference a non-empty .exe file')
    } else {
      $actualInstallerHash = Get-Sha256 -Path $validatedInstallerPath
      if ($actualInstallerHash -ne $evidence.installerSha256) {
        $failures.Add('installerSha256 does not match the referenced installer')
      }

      if ($PSVersionTable.PSEdition -eq 'Desktop') {
        $env:PSModulePath = "$env:ProgramFiles\WindowsPowerShell\Modules;$env:SystemRoot\system32\WindowsPowerShell\v1.0\Modules"
      }
      Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
      $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature `
        -LiteralPath $validatedInstallerPath
      $actualSignerSubject = if ($signature.SignerCertificate) {
        $signature.SignerCertificate.Subject
      } else {
        $null
      }
      $timeStamperSubject = if ($signature.TimeStamperCertificate) {
        $signature.TimeStamperCertificate.Subject
      } else {
        $null
      }
      if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        $failures.Add("Installer Authenticode status is $($signature.Status), not Valid")
      }
      if ([string]::IsNullOrWhiteSpace($timeStamperSubject)) {
        $failures.Add('Installer has no trusted Authenticode timestamp')
      }
      if ($actualSignerSubject -ne $evidence.signerSubject) {
        $failures.Add('signerSubject does not match the referenced installer')
      }
      if ($ExpectedSignerSubject -and $actualSignerSubject -ne $ExpectedSignerSubject) {
        $failures.Add('Installer signer does not match the external expected signer subject')
      }
      if ($installer.VersionInfo.ProductName -ne $tauriConfig.productName) {
        $failures.Add("Installer product name must be $($tauriConfig.productName)")
      }
      $installerProductVersion = Convert-ToVersion `
        -Name 'installer product version' `
        -Value $installer.VersionInfo.ProductVersion
      if ($currentVersion -and $installerProductVersion -and
        (Get-NormalizedVersion -Version $installerProductVersion) -ne
        (Get-NormalizedVersion -Version $currentVersion)) {
        $failures.Add('Installer product version does not match appVersion')
      }
    }
  }
}

$result = [ordered]@{
  kind = $Kind
  evidencePath = $resolvedEvidencePath
  requiredCases = $requiredCaseIds.Count
  recordedCases = $caseIndex.Count
  validatedEvidenceFiles = $validatedEvidenceFiles.Count
  validatedInstallerPath = $validatedInstallerPath
  signerTrustAnchorConfigured = -not [string]::IsNullOrWhiteSpace($ExpectedSignerSubject)
  passed = $failures.Count -eq 0
  failures = @($failures)
}
$result | ConvertTo-Json -Depth 5

if ($failures.Count -gt 0) {
  exit 4
}
