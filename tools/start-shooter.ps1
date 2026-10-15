$ErrorActionPreference = 'Stop'
$gameRoot = Split-Path -Parent $PSScriptRoot
$address = 'http://127.0.0.1:8124'
try {
    $state = Invoke-RestMethod -Uri "$address/api/status" -TimeoutSec 2
} catch { $state = $null }
if (-not $state -or $null -eq $state.navNodes) {
    $runtime = Join-Path $gameRoot 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $runtime)) { $runtime = (Get-Command node.exe -ErrorAction Stop).Source }
    if (-not (Test-Path -LiteralPath (Join-Path $gameRoot 'node_modules\three'))) {
        throw 'Missing runtime dependencies. Restore the complete extracted game folder.'
    }
    $logFolder = Join-Path $gameRoot 'work'
    New-Item -ItemType Directory -Force -Path $logFolder | Out-Null
    Start-Process -FilePath $runtime -ArgumentList 'shooter/server.cjs' -WorkingDirectory $gameRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logFolder 'shooter-server.log') -RedirectStandardError (Join-Path $logFolder 'shooter-server-error.log')
    for ($attempt = 0; $attempt -lt 35; $attempt++) {
        Start-Sleep -Milliseconds 250
        try { $state = Invoke-RestMethod -Uri "$address/api/status" -TimeoutSec 1; break } catch {}
    }
    if (-not $state) { throw 'Game server did not start. See work/shooter-server-error.log.' }
}
Start-Process $address
