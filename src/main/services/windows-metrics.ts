/** 固定、只读的系统采样脚本；不接受渲染端提供的命令或参数。 */
export const windowsMetricsScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$previousGpu = $null
$gpuCategory = $null
$gpuNames = ''
try { $gpuCategory = [Diagnostics.PerformanceCounterCategory]::new('GPU Engine') } catch {}
try { $gpuNames = (@(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join ' / ') } catch {}
while ($true) {
  $gpu = $null
  $gpuState = 'unavailable'
  try {
    $currentGpu = $gpuCategory.ReadCategory()['Utilization Percentage']
    if ($null -ne $currentGpu) {
      $gpuState = 'loading'
      if ($null -ne $previousGpu) {
        $engines = @{}
        foreach ($instance in $currentGpu.Keys) {
          if ($previousGpu.Contains($instance)) {
            $value = [double][Diagnostics.CounterSample]::Calculate($previousGpu[$instance].Sample, $currentGpu[$instance].Sample)
            if (-not [double]::IsNaN($value) -and -not [double]::IsInfinity($value)) {
              $engine = $instance -replace '^pid_\d+_', ''
              $engines[$engine] += [Math]::Max(0, $value)
            }
          }
        }
        if ($currentGpu.Count -eq 0 -or $engines.Count -gt 0) {
          $gpu = 0.0
          foreach ($value in $engines.Values) { $gpu = [Math]::Max($gpu, $value) }
          $gpu = [Math]::Min(100, $gpu)
          $gpuState = 'ready'
        }
      }
      $previousGpu = $currentGpu
    }
  } catch { $previousGpu = $null }
  $network = @()
  $networkOk = $true
  try {
    foreach ($adapter in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      if ($adapter.OperationalStatus -ne 'Up' -or $adapter.NetworkInterfaceType -eq 'Loopback' -or $adapter.NetworkInterfaceType -eq 'Tunnel') { continue }
      try {
        # 过滤 Windows 的重复过滤驱动接口；不把同一网卡吞吐量重复相加。
        if ($adapter.GetIPProperties().UnicastAddresses.Count -eq 0) { continue }
        $statistics = $adapter.GetIPStatistics()
        $network += @{ id = $adapter.Id; name = $adapter.Name; received = $statistics.BytesReceived; sent = $statistics.BytesSent }
      } catch { $networkOk = $false }
    }
  } catch { $networkOk = $false }
  @{ gpu = $gpu; gpuState = $gpuState; gpuName = $gpuNames; network = @($network); networkOk = $networkOk } | ConvertTo-Json -Compress -Depth 4 | ForEach-Object { [Console]::WriteLine($_) }
  Start-Sleep -Milliseconds 2000
}
`
