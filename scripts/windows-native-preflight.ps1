[CmdletBinding()]
param(
  [switch]$RequireSigning
)

$ErrorActionPreference = 'Stop'

function Get-ExecutableCandidates {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [string[]]$FallbackPaths = @()
  )

  $candidates = [System.Collections.Generic.List[string]]::new()
  foreach ($command in @(Get-Command $Name -All -ErrorAction SilentlyContinue)) {
    if ($command.CommandType -eq 'Application' -and $command.Source) {
      $candidates.Add($command.Source)
    }
  }
  foreach ($candidate in $FallbackPaths) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      $candidates.Add((Resolve-Path -LiteralPath $candidate).Path)
    }
  }

  return @($candidates | Select-Object -Unique)
}

function Resolve-Executable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [string[]]$FallbackPaths = @()
  )

  return Get-ExecutableCandidates -Name $Name -FallbackPaths $FallbackPaths |
    Select-Object -First 1
}

function Test-MicrosoftExecutable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$OriginalFileName
  )

  try {
    $versionInfo = (Get-Item -LiteralPath $Path -ErrorAction Stop).VersionInfo
    return $versionInfo.CompanyName -match '^Microsoft' -and
      $versionInfo.OriginalFilename -ieq $OriginalFileName
  } catch {
    return $false
  }
}

function Resolve-MicrosoftExecutable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$OriginalFileName,
    [string[]]$FallbackPaths = @()
  )

  foreach ($candidate in @(Get-ExecutableCandidates -Name $Name -FallbackPaths $FallbackPaths)) {
    if (Test-MicrosoftExecutable -Path $candidate -OriginalFileName $OriginalFileName) {
      return $candidate
    }
  }
  return $null
}

function Find-VisualStudioTools {
  $emptyResult = [pscustomobject]@{
    installationPath = $null
    developerCommand = $null
    cl = $null
    link = $null
    msbuild = $null
  }
  $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    return $emptyResult
  }

  $installationPath = & $vswhere -latest -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$installationPath)) {
    return $emptyResult
  }
  $installationPath = [string]($installationPath | Select-Object -First 1)

  $vcToolsRoot = Join-Path $installationPath 'VC\Tools\MSVC'
  $vcToolsVersion = Get-ChildItem -LiteralPath $vcToolsRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending |
    Select-Object -First 1
  $toolBin = if ($vcToolsVersion) {
    Join-Path $vcToolsVersion.FullName 'bin\Hostx64\x64'
  } else {
    $null
  }

  return [pscustomobject]@{
    installationPath = $installationPath
    developerCommand = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
    cl = if ($toolBin) { Join-Path $toolBin 'cl.exe' } else { $null }
    link = if ($toolBin) { Join-Path $toolBin 'link.exe' } else { $null }
    msbuild = Join-Path $installationPath 'MSBuild\Current\Bin\MSBuild.exe'
  }
}

function Invoke-VersionCommand {
  param(
    [string]$Path,
    [string[]]$Arguments = @()
  )

  if (-not $Path) {
    return $null
  }
  $output = & $Path @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) {
    return $null
  }
  return [string]($output -join "`n")
}

function Find-WebView2Runtime {
  $registryRoots = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients'
  )

  foreach ($registryRoot in $registryRoots) {
    if (-not (Test-Path -LiteralPath $registryRoot)) {
      continue
    }
    $runtime = Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue |
      ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue } |
      Where-Object { $_.name -match 'WebView2' } |
      Select-Object -First 1
    if ($runtime) {
      return [pscustomobject]@{
        installed = $true
        name = $runtime.name
        version = $runtime.pv
      }
    }
  }

  return [pscustomobject]@{
    installed = $false
    name = $null
    version = $null
  }
}

function Find-WindowsSdk {
  $installedRoots = Get-ItemProperty `
    -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' `
    -ErrorAction SilentlyContinue
  $kitsRoot = if ($installedRoots) { $installedRoots.KitsRoot10 } else { $null }
  if (-not $kitsRoot) {
    return [pscustomobject]@{ installed = $false; root = $null; version = $null; signtool = $null }
  }

  $includeRoot = Join-Path $kitsRoot 'Include'
  $versions = @(Get-ChildItem -LiteralPath $includeRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending)
  foreach ($versionDirectory in $versions) {
    $windowsHeader = Join-Path $versionDirectory.FullName 'um\Windows.h'
    $kernelLibrary = Join-Path $kitsRoot "Lib\$($versionDirectory.Name)\um\x64\kernel32.lib"
    if ((Test-Path -LiteralPath $windowsHeader) -and (Test-Path -LiteralPath $kernelLibrary)) {
      $candidateSignTool = Join-Path $kitsRoot "bin\$($versionDirectory.Name)\x64\signtool.exe"
      return [pscustomobject]@{
        installed = $true
        root = $kitsRoot
        version = $versionDirectory.Name
        signtool = if (Test-Path -LiteralPath $candidateSignTool) { $candidateSignTool } else { $null }
      }
    }
  }

  return [pscustomobject]@{ installed = $false; root = $kitsRoot; version = $null; signtool = $null }
}

$cargoFallback = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
$rustcFallback = Join-Path $env:USERPROFILE '.cargo\bin\rustc.exe'
$visualStudio = Find-VisualStudioTools
$nodePath = Resolve-Executable -Name 'node.exe'
$pnpmPath = Resolve-Executable -Name 'pnpm.cmd'
$cargoPath = Resolve-Executable -Name 'cargo.exe' -FallbackPaths @($cargoFallback)
$rustcPath = Resolve-Executable -Name 'rustc.exe' -FallbackPaths @($rustcFallback)
$clPath = Resolve-MicrosoftExecutable -Name 'cl.exe' -OriginalFileName 'cl.exe' `
  -FallbackPaths @($visualStudio.cl)
$linkCandidates = @(Get-ExecutableCandidates -Name 'link.exe' -FallbackPaths @($visualStudio.link))
$linkPath = [string](
  $linkCandidates |
    Where-Object { Test-MicrosoftExecutable -Path $_ -OriginalFileName 'link.exe' } |
    Select-Object -First 1
)
if ([string]::IsNullOrWhiteSpace($linkPath)) {
  $linkPath = $null
}
$msbuildPath = Resolve-MicrosoftExecutable -Name 'msbuild.exe' -OriginalFileName 'MSBuild.exe' `
  -FallbackPaths @($visualStudio.msbuild)
$rejectedLinkPaths = @($linkCandidates | Where-Object { $_ -ne $linkPath })
$windowsSdk = Find-WindowsSdk
$signtoolPath = Resolve-MicrosoftExecutable -Name 'signtool.exe' -OriginalFileName 'signtool.exe' `
  -FallbackPaths @($windowsSdk.signtool)
$webView2 = Find-WebView2Runtime

$nodeVersion = Invoke-VersionCommand -Path $nodePath -Arguments @('--version')
$pnpmVersion = Invoke-VersionCommand -Path $pnpmPath -Arguments @('--version')
$cargoVersion = Invoke-VersionCommand -Path $cargoPath -Arguments @('--version')
$rustDetails = Invoke-VersionCommand -Path $rustcPath -Arguments @('-vV')
$rustVersion = if ($rustDetails) { ($rustDetails -split "`n" | Select-Object -First 1).Trim() } else { $null }
$rustHost = if ($rustDetails -match '(?m)^host:\s*(\S+)\s*$') { $Matches[1] } else { $null }
$nodeVersionSupported = [bool]($nodeVersion -match '^v?(\d+)\.' -and [int]$Matches[1] -ge 22)
$pnpmVersionSupported = [bool]($pnpmVersion -match '^(\d+)\.' -and [int]$Matches[1] -eq 11)

$buildChecks = [ordered]@{
  node = [bool]$nodePath
  nodeVersion = $nodeVersionSupported
  pnpm = [bool]$pnpmPath
  pnpmVersion = $pnpmVersionSupported
  cargo = [bool]$cargoPath
  rustc = [bool]$rustcPath
  rustMsvcHost = $rustHost -eq 'x86_64-pc-windows-msvc'
  msvcCompiler = [bool]$clPath
  msvcLinker = [bool]$linkPath
  msbuild = [bool]$msbuildPath
  windowsSdk = $windowsSdk.installed
  webView2 = $webView2.installed
}

$missingBuildChecks = @(
  $buildChecks.GetEnumerator() |
    Where-Object { -not $_.Value } |
    ForEach-Object { $_.Key }
)
$readyForNativeBuild = $missingBuildChecks.Count -eq 0

$certificateThumbprint = [string]$env:WINDOWS_CERT_THUMBPRINT -replace '\s', ''
$timestampUrl = [string]$env:WINDOWS_TIMESTAMP_URL
$expectedSignerSubject = [string]$env:WINDOWS_EXPECTED_SIGNER_SUBJECT
$timestampUri = $null
$validTimestampUrl = [uri]::TryCreate($timestampUrl, [System.UriKind]::Absolute, [ref]$timestampUri) -and
  $timestampUri.Scheme -eq 'https'
$signingChecks = [ordered]@{
  signtool = [bool]$signtoolPath
  certificateThumbprint = $certificateThumbprint -match '^[A-Fa-f0-9]{40}$'
  timestampUrl = $validTimestampUrl
  expectedSignerSubject = -not [string]::IsNullOrWhiteSpace($expectedSignerSubject)
}
$missingSigningChecks = @(
  $signingChecks.GetEnumerator() |
    Where-Object { -not $_.Value } |
    ForEach-Object { $_.Key }
)
$readyForSigning = $readyForNativeBuild -and $missingSigningChecks.Count -eq 0

$result = [ordered]@{
  platform = [System.Environment]::OSVersion.VersionString
  readyForNativeBuild = $readyForNativeBuild
  readyForSigning = $readyForSigning
  missingBuildChecks = $missingBuildChecks
  missingSigningChecks = $missingSigningChecks
  tools = [ordered]@{
    node = $nodePath
    nodeVersion = if ($nodeVersion) { $nodeVersion.Trim() } else { $null }
    pnpm = $pnpmPath
    pnpmVersion = if ($pnpmVersion) { $pnpmVersion.Trim() } else { $null }
    cargo = $cargoPath
    cargoVersion = if ($cargoVersion) { $cargoVersion.Trim() } else { $null }
    rustc = $rustcPath
    rustVersion = $rustVersion
    rustHost = $rustHost
    cl = $clPath
    link = $linkPath
    rejectedLinkCandidates = $rejectedLinkPaths
    msbuild = $msbuildPath
    signtool = $signtoolPath
  }
  visualStudio = $visualStudio
  webView2 = $webView2
  windowsSdk = $windowsSdk
}

$result | ConvertTo-Json -Depth 6

if (-not $readyForNativeBuild) {
  [Console]::Error.WriteLine("Windows native build prerequisites are incomplete: $($missingBuildChecks -join ', ')")
  exit 2
}

if ($RequireSigning -and -not $readyForSigning) {
  [Console]::Error.WriteLine("Windows signing prerequisites are incomplete: $($missingSigningChecks -join ', ')")
  exit 3
}
