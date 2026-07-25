$sig = '[DllImport("user32.dll")] public static extern int SendMessage(IntPtr hWnd, int hMsg, IntPtr wParam, IntPtr lParam);'
$t = Add-Type -MemberDefinition $sig -Name 'Win' -Namespace 'Polaris' -PassThru
$HWND_BROADCAST = [IntPtr](-1)
$WM_SYSCOMMAND = 0x0112
$SC_MONITORPOWER = [IntPtr]0xF170
$OFF = [IntPtr]2
[void]$t::SendMessage($HWND_BROADCAST, $WM_SYSCOMMAND, $SC_MONITORPOWER, $OFF)
Write-Output 'monitor-off-sent'
