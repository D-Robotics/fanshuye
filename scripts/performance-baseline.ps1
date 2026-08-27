param(
  [string]$DatabaseUrl = $env:PERF_DATABASE_URL
)

$ErrorActionPreference = 'Stop'
$baselineWorkspace = Split-Path -Parent $PSScriptRoot
$baselineDatabaseUrl = $DatabaseUrl

if ([string]::IsNullOrWhiteSpace($baselineDatabaseUrl)) {
  $baselineDatabaseUrl = 'postgresql://fanshuye:fanshuye@127.0.0.1:5432/fanshuye'
  Write-Host 'PERF_DATABASE_URL is unset; using the local Compose PostgreSQL database.'
}

$parsedDatabaseUrl = [Uri]$baselineDatabaseUrl
$localHosts = @('localhost', '127.0.0.1', '::1')
if ($parsedDatabaseUrl.Host -notin $localHosts -and $env:PERF_ALLOW_REMOTE_DATABASE -ne '1') {
  throw 'Refusing a remote performance database. Set PERF_ALLOW_REMOTE_DATABASE=1 only for an isolated test PostgreSQL instance.'
}

Push-Location $baselineWorkspace
try {
  $env:PERFORMANCE_BASELINE = '1'
  $env:PERF_DATABASE_URL = $baselineDatabaseUrl

  Write-Host 'Running the 1,000-task UI aggregation and SVG layout baseline...'
  & pnpm --filter @fanshuye/ui exec vitest run src/performance-baseline.test.ts --reporter verbose
  if ($LASTEXITCODE -ne 0) {
    throw "UI performance baseline failed with exit code $LASTEXITCODE."
  }

  Write-Host 'Running the isolated PostgreSQL dependency-query baseline...'
  & pnpm --filter @fanshuye/server exec vitest run test/performance-baseline.test.ts --reporter verbose
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL performance baseline failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
