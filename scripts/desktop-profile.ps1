param(
  [Parameter(Mandatory = $true)][int]$AppProcessId,
  [ValidateSet('visible','hidden')][string]$Mode = 'visible',
  [int]$Seconds = 15
)
$ErrorActionPreference = 'Stop'
$allProcesses = Get-CimInstance Win32_Process
$ownedIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$ownedIds.Add($AppProcessId)
do {
  $previousCount = $ownedIds.Count
  foreach ($candidate in $allProcesses) {
    if ($ownedIds.Contains([int]$candidate.ParentProcessId)) { [void]$ownedIds.Add([int]$candidate.ProcessId) }
  }
} while ($ownedIds.Count -ne $previousCount)
$before = @{}
foreach ($processId in $ownedIds) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) { $before[$processId] = $process.TotalProcessorTime.TotalMilliseconds }
}
$watch = [System.Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Seconds $Seconds
$elapsed = $watch.Elapsed.TotalMilliseconds
$cpu = 0.0
$working = 0L
$private = 0L
$details = @()
foreach ($processId in $ownedIds) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process -and $before.ContainsKey($processId)) {
    $delta = [Math]::Max(0, $process.TotalProcessorTime.TotalMilliseconds - $before[$processId])
    $cpu += $delta
    $working += $process.WorkingSet64
    $private += $process.PrivateMemorySize64
    $details += @{ name = $process.ProcessName; pid = $processId; cpu_ms = $delta; working_mib = [Math]::Round($process.WorkingSet64 / 1MB, 2) }
  }
}
$report = @{
  measured_at = (Get-Date).ToUniversalTime().ToString('o')
  mode = $Mode; interval_ms = [Math]::Round($elapsed); cpu_ms = $cpu
  cpu_percent_one_core = [Math]::Round(100 * $cpu / $elapsed, 3)
  working_set_mib = [Math]::Round($working / 1MB, 2)
  private_mib = [Math]::Round($private / 1MB, 2)
  processes = $details
  note = 'Mneme and its descendant core/WebView2 processes; working-set sum can include shared pages. CPU percentage uses one logical core as 100%.'
}
New-Item -ItemType Directory -Force artifacts/desktop | Out-Null
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 "artifacts/desktop/$Mode-performance.json"
$report | ConvertTo-Json -Depth 6
