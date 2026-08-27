[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('dev', 'build', 'info')]
  [string]$TauriCommand,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TauriArguments = @()
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath $cargoBin -PathType Container) {
  $pathEntries = @($env:PATH -split ';')
  if ($pathEntries -notcontains $cargoBin) {
    $env:PATH = "$cargoBin;$env:PATH"
  }
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
    [string]$OriginalFileName
  )

  foreach ($command in @(Get-Command $Name -All -ErrorAction SilentlyContinue)) {
    if ($command.CommandType -eq 'Application' -and
      (Test-MicrosoftExecutable -Path $command.Source -OriginalFileName $OriginalFileName)) {
      return $command.Source
    }
  }
  return $null
}

function Import-VisualStudioEnvironment {
  $existingCompiler = Resolve-MicrosoftExecutable -Name 'cl.exe' -OriginalFileName 'cl.exe'
  $existingLinker = Resolve-MicrosoftExecutable -Name 'link.exe' -OriginalFileName 'link.exe'
  if ($existingCompiler -and $existingLinker) {
    return
  }

  $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    return
  }

  $installationPath = & $vswhere -latest -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$installationPath)) {
    return
  }
  $installationPath = [string]($installationPath | Select-Object -First 1)

  $developerCommand = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path -LiteralPath $developerCommand -PathType Leaf)) {
    return
  }

  $developerCommandLine = "call `"$developerCommand`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
  $environmentLines = & $env:COMSPEC /d /s /c $developerCommandLine
  if ($LASTEXITCODE -ne 0) {
    throw 'Visual Studio developer environment initialization failed.'
  }
  foreach ($line in $environmentLines) {
    $separator = $line.IndexOf('=')
    if ($separator -le 0) {
      continue
    }
    $name = $line.Substring(0, $separator)
    $value = $line.Substring($separator + 1)
    Set-Item -LiteralPath "Env:$name" -Value $value
  }
}

Import-VisualStudioEnvironment

if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
  throw 'Rust cargo is unavailable. Install rustup or add %USERPROFILE%\.cargo\bin to PATH.'
}

if ($TauriCommand -ne 'info') {
  $compilerPath = Resolve-MicrosoftExecutable -Name 'cl.exe' -OriginalFileName 'cl.exe'
  $linkerPath = Resolve-MicrosoftExecutable -Name 'link.exe' -OriginalFileName 'link.exe'
  $missingTools = @()
  if (-not $compilerPath) {
    $missingTools += 'Microsoft cl.exe'
  }
  if (-not $linkerPath) {
    $missingTools += 'Microsoft link.exe'
  }
  if ($missingTools.Count -gt 0) {
    throw "MSVC developer tools are unavailable or a non-Microsoft executable shadows them: $($missingTools -join ', '). Install the repository .vsconfig and retry."
  }

  $linkerDirectory = Split-Path -Parent $linkerPath
  $remainingPath = @($env:PATH -split ';') |
    Where-Object { $_ -and $_ -ne $linkerDirectory }
  $env:PATH = (@($linkerDirectory) + $remainingPath) -join ';'
}

$pnpmPath = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpmPath) {
  throw 'pnpm is unavailable. Install the package-manager version declared in package.json.'
}

$pnpmArguments = @('--filter', '@fanshuye/desktop', 'exec', 'tauri', $TauriCommand) + $TauriArguments
Push-Location $repositoryRoot
try {
  & pnpm @pnpmArguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}
