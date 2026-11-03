param([switch]$WithProcesses)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$system = Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 8
$processors = @(Get-CimInstance Win32_Processor -OperationTimeoutSec 8)
$cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -OperationTimeoutSec 8
if (!$cpu) { throw 'Windows CPU performance counters are unavailable' }
$total = [double]$system.TotalVisibleMemorySize * 1024
$free = [double]$system.FreePhysicalMemory * 1024
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -OperationTimeoutSec 8 | ForEach-Object {
  @{ device = $_.DeviceID; mount = $_.DeviceID; fsType = $_.FileSystem; total = [double]$_.Size; used = [double]$_.Size - [double]$_.FreeSpace; available = [double]$_.FreeSpace }
})
$network = @(Get-NetAdapterStatistics | ForEach-Object { @{ name = $_.Name; rxBytes = [double]$_.ReceivedBytes; txBytes = [double]$_.SentBytes } })
$processes = @()
if ($WithProcesses) {
  $cores = [Math]::Max(1, ($processors | Measure-Object NumberOfLogicalProcessors -Sum).Sum)
  $processes = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -OperationTimeoutSec 8 | Where-Object { $_.IDProcess -gt 0 } | Sort-Object PercentProcessorTime -Descending | Select-Object -First 15 | ForEach-Object {
    @{ pid = $_.IDProcess; user = ''; cpu = [double]$_.PercentProcessorTime / $cores; mem = [double]$_.WorkingSetPrivate / $total * 100; command = $_.Name }
  })
}
@{
  hostname = $env:COMPUTERNAME
  os = $system.Caption
  kernel = $system.Version
  arch = $system.OSArchitecture
  uptime = ((Get-Date) - $system.LastBootUpTime).TotalSeconds
  cpu = @{ usage = [double]$cpu.PercentProcessorTime; cores = ($processors | Measure-Object NumberOfLogicalProcessors -Sum).Sum; model = $processors[0].Name }
  memory = @{ total = $total; used = $total - $free; free = $free; available = $free }
  disks = $disks
  network = $network
  processes = $processes
} | ConvertTo-Json -Depth 6 -Compress
