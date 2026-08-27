[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [string]$ExpectedSignerSubject = $env:WINDOWS_EXPECTED_SIGNER_SUBJECT,

  [string]$ExpectedSha256,

  [string]$ExpectedProductName,

  [string]$ExpectedProductVersion
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Desktop') {
  # Avoid loading PowerShell 7 modules into Windows PowerShell when a parent
  # process has prepended its own PSModulePath.
  $env:PSModulePath = "$env:ProgramFiles\WindowsPowerShell\Modules;$env:SystemRoot\system32\WindowsPowerShell\v1.0\Modules"
}
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path
$installer = Get-Item -LiteralPath $resolvedInstaller
if ($installer.Extension -ne '.exe') {
  throw 'InstallerPath must point to an executable installer.'
}
if ($installer.Length -le 0) {
  throw 'InstallerPath must point to a non-empty executable installer.'
}
if ($ExpectedSha256 -and $ExpectedSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
  throw 'ExpectedSha256 must contain exactly 64 hexadecimal characters.'
}

$hash = Microsoft.PowerShell.Utility\Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedInstaller
$signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $resolvedInstaller
$signerSubject = if ($signature.SignerCertificate) {
  $signature.SignerCertificate.Subject
} else {
  $null
}
$timeStamperSubject = if ($signature.TimeStamperCertificate) {
  $signature.TimeStamperCertificate.Subject
} else {
  $null
}
$signerMatches = if ([string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
  $true
} else {
  $signerSubject -eq $ExpectedSignerSubject
}
$sha256Matches = if ([string]::IsNullOrWhiteSpace($ExpectedSha256)) {
  $true
} else {
  $hash.Hash -eq $ExpectedSha256
}
$productNameMatches = if ([string]::IsNullOrWhiteSpace($ExpectedProductName)) {
  $true
} else {
  $installer.VersionInfo.ProductName -eq $ExpectedProductName
}
$productVersionMatches = if ([string]::IsNullOrWhiteSpace($ExpectedProductVersion)) {
  $true
} else {
  $installer.VersionInfo.ProductVersion -eq $ExpectedProductVersion
}
$timestampPresent = -not [string]::IsNullOrWhiteSpace($timeStamperSubject)

$result = [ordered]@{
  installerPath = $resolvedInstaller
  lengthBytes = $installer.Length
  sha256 = $hash.Hash.ToLowerInvariant()
  fileVersion = $installer.VersionInfo.FileVersion
  productVersion = $installer.VersionInfo.ProductVersion
  signatureStatus = [string]$signature.Status
  signerSubject = $signerSubject
  timeStamperSubject = $timeStamperSubject
  timestampPresent = $timestampPresent
  expectedSignerMatched = $signerMatches
  expectedSha256Matched = $sha256Matches
  expectedProductNameMatched = $productNameMatches
  expectedProductVersionMatched = $productVersionMatches
  passed = $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid -and
    $timestampPresent -and
    $signerMatches -and
    $sha256Matches -and
    $productNameMatches -and
    $productVersionMatches
}
$result | ConvertTo-Json -Depth 4

if (-not $result.passed) {
  exit 5
}
