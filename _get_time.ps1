$d = Get-Date
$tz = Get-TimeZone
Write-Host "=== Current Date/Time ==="
Write-Host ($d.ToString("yyyy-MM-dd HH:mm:ss"))
Write-Host ""
Write-Host "=== Timezone Information ==="
Write-Host ("ID: " + $tz.Id)
Write-Host ("Display Name: " + $tz.DisplayName)
Write-Host ("UTC Offset: " + $tz.BaseUtcOffset.ToString())
Write-Host ("Supports Daylight Saving: " + $tz.SupportsDaylightSavingTime)