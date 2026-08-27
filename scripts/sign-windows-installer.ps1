[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [string]$CertificateThumbprint = $env:WINDOWS_CERT_THUMBPRINT,
  [string]$TimestampUrl = $env:WINDOWS_TIMESTAMP_URL,
  [string]$ExpectedSignerSubject = $env:WINDOWS_EXPECTED_SIGNER_SUBJECT
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'Authenticode signing is only supported on Windows.'
}

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path
$installer = Get-Item -LiteralPath $resolvedInstaller
if ($installer.Extension -ine '.exe' -or $installer.Length -le 0) {
  throw 'InstallerPath must reference a non-empty .exe installer.'
}

$thumbprint = [string]$CertificateThumbprint -replace '\s', ''
if ($thumbprint -notmatch '^[A-Fa-f0-9]{40}$') {
  throw 'WINDOWS_CERT_THUMBPRINT must contain exactly 40 hexadecimal characters.'
}
$timestamp = $null
if (-not [uri]::TryCreate($TimestampUrl, [UriKind]::Absolute, [ref]$timestamp) -or
  $timestamp.Scheme -ne 'https') {
  throw 'WINDOWS_TIMESTAMP_URL must be an absolute HTTPS URL.'
}
if ([string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) {
  throw 'WINDOWS_EXPECTED_SIGNER_SUBJECT is required as an external signer trust anchor.'
}

$certificate = @(Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
    Where-Object { $_.Thumbprint -eq $thumbprint }) | Select-Object -First 1
if (-not $certificate) { throw 'The configured code-signing certificate is not installed.' }
if (-not $certificate.HasPrivateKey) {
  throw 'The configured code-signing certificate has no accessible private key.'
}
$codeSigningEku = @($certificate.EnhancedKeyUsageList | ForEach-Object ObjectId) -contains
  '1.3.6.1.5.5.7.3.3'
if (-not $codeSigningEku) { throw 'The configured certificate is not valid for code signing.' }
$now = Get-Date
if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -le $now) {
  throw 'The configured code-signing certificate is outside its validity period.'
}
if ($certificate.Subject -ne $ExpectedSignerSubject) {
  throw 'The configured certificate subject does not match WINDOWS_EXPECTED_SIGNER_SUBJECT.'
}

$signTool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' `
  -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
  Where-Object FullName -Match '\\x64\\signtool\.exe$' |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $signTool) { throw 'Windows SDK signtool.exe is unavailable.' }

& $signTool sign /sha1 $thumbprint /fd SHA256 /tr $timestamp.AbsoluteUri /td SHA256 $resolvedInstaller
if ($LASTEXITCODE -ne 0) { throw "signtool sign failed with exit code $LASTEXITCODE." }
& $signTool verify /pa /v $resolvedInstaller
if ($LASTEXITCODE -ne 0) { throw "signtool verify failed with exit code $LASTEXITCODE." }

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedInstaller
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Authenticode verification failed with status $($signature.Status)."
}
if ($signature.SignerCertificate.Subject -ne $ExpectedSignerSubject) {
  throw 'The signed installer does not match the expected signer subject.'
}
if (-not $signature.TimeStamperCertificate) { throw 'The signed installer has no trusted timestamp.' }

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedInstaller
[ordered]@{
  installerPath = $resolvedInstaller
  sha256 = $hash.Hash.ToLowerInvariant()
  signatureStatus = [string]$signature.Status
  signerSubject = $signature.SignerCertificate.Subject
  timeStamperSubject = $signature.TimeStamperCertificate.Subject
  certificateNotAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')
  passed = $true
} | ConvertTo-Json -Depth 4
