[CmdletBinding()]
param(
  [string]$DrillId = (Get-Date -Format 'yyyyMMddTHHmmss')
)

$ErrorActionPreference = 'Stop'

if ($DrillId -notmatch '^[A-Za-z0-9_-]{8,32}$') {
  throw 'DrillId must contain only letters, digits, underscores, or hyphens (8-32 characters).'
}

$dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
if ($null -ne $dockerCommand) {
  $script:DockerExecutable = $dockerCommand.Source
} else {
  $dockerDesktopCli = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'
  if (-not (Test-Path -LiteralPath $dockerDesktopCli)) {
    throw 'docker.exe was not found on PATH or in the default Docker Desktop installation.'
  }
  $script:DockerExecutable = $dockerDesktopCli
}

$safeSuffix = ($DrillId.ToLowerInvariant() -replace '[^a-z0-9_]', '_')
$sourceDatabase = "fanshuye_drill_src_$safeSuffix"
$restoreDatabase = "fanshuye_drill_restore_$safeSuffix"
$dumpFile = "/tmp/$sourceDatabase.dump"
$databaseUser = 'fanshuye'
$repositoryRoot = Split-Path -Parent $PSScriptRoot

function Invoke-PostgresContainer {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$ContainerArguments
  )

  $output = & $script:DockerExecutable compose exec -T postgres @ContainerArguments 2>&1
  $exitCode = $LASTEXITCODE
  $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
  if ($exitCode -ne 0) {
    throw "Container command failed with exit code $exitCode`: $($ContainerArguments -join ' ')`n$text"
  }
  return $text.Trim()
}

function Invoke-ScalarQuery {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Database,
    [Parameter(Mandatory = $true)]
    [string]$Sql
  )

  return Invoke-PostgresContainer -ContainerArguments @(
    'psql', '-U', $databaseUser, '-d', $Database, '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', $Sql
  )
}

$sourceCreated = $false
$restoreCreated = $false
$dumpWritten = $false
$runFailure = $null
$cleanupFailures = [System.Collections.Generic.List[string]]::new()
$sourceFingerprint = ''
$restoredFingerprint = ''
$archiveSha256 = ''
$archiveTableDataEntries = 0
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

Push-Location $repositoryRoot
try {
  try {
    $readiness = Invoke-PostgresContainer -ContainerArguments @(
      'pg_isready', '-U', $databaseUser, '-d', 'fanshuye'
    )
    if ($readiness -notmatch 'accepting connections') {
      throw "PostgreSQL is not ready: $readiness"
    }

    $collisionCount = Invoke-ScalarQuery -Database 'postgres' -Sql (
      "SELECT count(*) FROM pg_database WHERE datname IN ('$sourceDatabase', '$restoreDatabase');"
    )
    if ($collisionCount -ne '0') {
      throw "Refusing to run because a drill database already exists for DrillId '$DrillId'."
    }

    Invoke-PostgresContainer -ContainerArguments @(
      'createdb', '-U', $databaseUser, $sourceDatabase
    ) | Out-Null
    $sourceCreated = $true

    $seedSql = @"
CREATE SCHEMA backup_drill;
CREATE TABLE backup_drill.task_probe (
  id integer PRIMARY KEY,
  title text NOT NULL,
  status text NOT NULL,
  points integer NOT NULL,
  recorded_at timestamptz NOT NULL
);
INSERT INTO backup_drill.task_probe (id, title, status, points, recorded_at) VALUES
  (1, 'desktop overlay', 'IN_PROGRESS', 8, '2026-08-26T01:00:00Z'),
  (2, 'dependency graph', 'TODO', 13, '2026-08-26T02:00:00Z'),
  (3, 'sync recovery', 'REVIEW', 21, '2026-08-26T03:00:00Z');
"@
    Invoke-PostgresContainer -ContainerArguments @(
      'psql', '-U', $databaseUser, '-d', $sourceDatabase, '-v', 'ON_ERROR_STOP=1', '-c', $seedSql
    ) | Out-Null

    $fingerprintSql = @"
SELECT count(*)::text || '|' || sum(points)::text || '|' ||
       md5(string_agg(id::text || ':' || title || ':' || status || ':' || points::text || ':' ||
                      to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'), ',' ORDER BY id))
FROM backup_drill.task_probe;
"@
    $sourceFingerprint = Invoke-ScalarQuery -Database $sourceDatabase -Sql $fingerprintSql

    Invoke-PostgresContainer -ContainerArguments @(
      'pg_dump', '--format=custom', '--no-owner', '--no-privileges', '-U', $databaseUser,
      '--file', $dumpFile, $sourceDatabase
    ) | Out-Null
    $dumpWritten = $true

    $archiveSha256Output = Invoke-PostgresContainer -ContainerArguments @('sha256sum', $dumpFile)
    $archiveSha256 = ($archiveSha256Output -split '\s+')[0]
    $archiveList = Invoke-PostgresContainer -ContainerArguments @('pg_restore', '--list', $dumpFile)
    $archiveTableDataEntries = @(
      $archiveList -split "`r?`n" | Where-Object { $_ -match 'TABLE DATA backup_drill task_probe' }
    ).Count
    if ($archiveTableDataEntries -ne 1) {
      throw "Expected one task_probe TABLE DATA entry in the custom archive; found $archiveTableDataEntries."
    }

    Invoke-PostgresContainer -ContainerArguments @(
      'createdb', '-U', $databaseUser, $restoreDatabase
    ) | Out-Null
    $restoreCreated = $true

    Invoke-PostgresContainer -ContainerArguments @(
      'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '-U', $databaseUser,
      '--dbname', $restoreDatabase, $dumpFile
    ) | Out-Null

    $restoredFingerprint = Invoke-ScalarQuery -Database $restoreDatabase -Sql $fingerprintSql
    if ($restoredFingerprint -ne $sourceFingerprint) {
      throw "Restore verification failed: source '$sourceFingerprint', restored '$restoredFingerprint'."
    }
  } catch {
    $runFailure = $_
  } finally {
    if ($restoreCreated) {
      try {
        Invoke-PostgresContainer -ContainerArguments @(
          'dropdb', '--if-exists', '--force', '-U', $databaseUser, $restoreDatabase
        ) | Out-Null
      } catch {
        $cleanupFailures.Add($_.Exception.Message)
      }
    }
    if ($sourceCreated) {
      try {
        Invoke-PostgresContainer -ContainerArguments @(
          'dropdb', '--if-exists', '--force', '-U', $databaseUser, $sourceDatabase
        ) | Out-Null
      } catch {
        $cleanupFailures.Add($_.Exception.Message)
      }
    }
    if ($dumpWritten) {
      try {
        Invoke-PostgresContainer -ContainerArguments @('rm', '-f', $dumpFile) | Out-Null
      } catch {
        $cleanupFailures.Add($_.Exception.Message)
      }
    }
  }

  if ($null -ne $runFailure) {
    throw $runFailure
  }
  if ($cleanupFailures.Count -gt 0) {
    throw "The data verification passed, but cleanup failed:`n$($cleanupFailures -join "`n")"
  }

  $remainingDatabases = Invoke-ScalarQuery -Database 'postgres' -Sql (
    "SELECT count(*) FROM pg_database WHERE datname IN ('$sourceDatabase', '$restoreDatabase');"
  )
  if ($remainingDatabases -ne '0') {
    throw "Cleanup verification failed: $remainingDatabases drill database(s) remain."
  }

  $stopwatch.Stop()
  Write-Output 'RESULT=PASS'
  Write-Output "drill_id=$DrillId"
  Write-Output "source_database=$sourceDatabase"
  Write-Output "restore_database=$restoreDatabase"
  Write-Output 'archive_format=custom'
  Write-Output "archive_sha256=$archiveSha256"
  Write-Output "archive_table_data_entries=$archiveTableDataEntries"
  Write-Output "source_fingerprint=$sourceFingerprint"
  Write-Output "restored_fingerprint=$restoredFingerprint"
  Write-Output "cleanup_remaining_databases=$remainingDatabases"
  Write-Output "elapsed_ms=$($stopwatch.ElapsedMilliseconds)"
} finally {
  Pop-Location
}
