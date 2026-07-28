Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Display {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int SendMessage(int hWnd, int Msg, int wParam, int lParam);
    public const int HWND_BROADCAST = 0xFFFF;
    public const int WM_SYSCOMMAND = 0x0112;
    public const int SC_MONITORPOWER = 0xF170;
    public const int MONITOR_OFF = 2;
}
"@
[Display]::SendMessage([Display]::HWND_BROADCAST, [Display]::WM_SYSCOMMAND, [Display]::SC_MONITORPOWER, [Display]::MONITOR_OFF)
Write-Output "Done: monitor off signal sent"