Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MonitorOff {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int SendMessage(int h, int M, int w, int l);
    public const int HWND_BROADCAST = 0xFFFF;
    public const int WM_SYSCOMMAND = 0x112;
    public const int SC_MONITORPOWER = 0xF170;
    public const int MONITOR_OFF = 2;
}
"@
[MonitorOff]::SendMessage([MonitorOff]::HWND_BROADCAST, [MonitorOff]::WM_SYSCOMMAND, [MonitorOff]::SC_MONITORPOWER, [MonitorOff]::MONITOR_OFF)