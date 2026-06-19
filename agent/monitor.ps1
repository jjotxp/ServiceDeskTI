param(
  [string]$ServiceDeskUrl = $env:SERVICEDESK_URL,
  [string]$MonitorToken = $env:MONITOR_AGENT_TOKEN,
  [int]$PingCount = 2
)

$ErrorActionPreference = "Stop"

function ConvertFrom-SecureStringToPlainText {
  param([securestring]$SecureValue)

  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

if ([string]::IsNullOrWhiteSpace($ServiceDeskUrl)) {
  Write-Host "Informe a URL do ServiceDesk no Railway. Exemplo: https://seu-app.up.railway.app" -ForegroundColor Yellow
  $ServiceDeskUrl = Read-Host "SERVICEDESK_URL"
}

if ([string]::IsNullOrWhiteSpace($MonitorToken)) {
  Write-Host "Informe o MONITOR_AGENT_TOKEN com o mesmo valor configurado no Railway." -ForegroundColor Yellow
  $secureToken = Read-Host "MONITOR_AGENT_TOKEN" -AsSecureString
  $MonitorToken = ConvertFrom-SecureStringToPlainText -SecureValue $secureToken
}

if ([string]::IsNullOrWhiteSpace($ServiceDeskUrl) -or [string]::IsNullOrWhiteSpace($MonitorToken)) {
  Write-Error "SERVICEDESK_URL e MONITOR_AGENT_TOKEN sao obrigatorios para executar o agente."
  exit 1
}

$baseUrl = $ServiceDeskUrl.TrimEnd("/")
$headers = @{
  Authorization = "Bearer $MonitorToken"
}

function Get-LocalSoftware {
  $paths = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )

  $items = foreach ($path in $paths) {
    Get-ItemProperty -Path $path -ErrorAction SilentlyContinue |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_.DisplayName) } |
      Select-Object -ExpandProperty DisplayName
  }

  $items | Sort-Object -Unique | Select-Object -First 80
}

function Test-IsLocalAsset {
  param([string]$Name, [string]$IpAddress)

  $localName = $env:COMPUTERNAME
  if ($Name -and $Name.Equals($localName, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }

  $localIps = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -ne "127.0.0.1" } |
    Select-Object -ExpandProperty IPAddress

  return $localIps -contains $IpAddress
}

function Test-Asset {
  param($Asset)

  $target = if ($Asset.ipAddress) { $Asset.ipAddress } else { $Asset.name }
  $checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  $online = $false
  $latency = $null
  $errorMessage = ""

  try {
    $ping = Test-Connection -ComputerName $target -Count $PingCount -ErrorAction Stop
    $online = $true
    $latency = [math]::Round(($ping | Measure-Object -Property ResponseTime -Average).Average, 0)
  } catch {
    $errorMessage = $_.Exception.Message
  }

  $result = [ordered]@{
    name = $Asset.name
    ipAddress = $Asset.ipAddress
    online = $online
    latencyMs = $latency
    error = $errorMessage
    checkedAt = $checkedAt
  }

  if (Test-IsLocalAsset -Name $Asset.name -IpAddress $Asset.ipAddress) {
    $result.os = (Get-CimInstance Win32_OperatingSystem).Caption
    $result.softwares = @(Get-LocalSoftware)
  }

  return $result
}

$assets = Invoke-RestMethod -Method Get -Uri "$baseUrl/api/monitor/assets" -Headers $headers

foreach ($asset in $assets) {
  $result = Test-Asset -Asset $asset
  $json = $result | ConvertTo-Json -Depth 5
  Invoke-RestMethod -Method Post -Uri "$baseUrl/api/monitor/results" -Headers $headers -ContentType "application/json" -Body $json | Out-Null
  Write-Host "$($result.name) [$($result.ipAddress)] => $(if ($result.online) { 'Online' } else { 'Offline' })"
}
