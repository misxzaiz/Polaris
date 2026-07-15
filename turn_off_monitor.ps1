Add-Type -Name Monitor -Namespace Win32 -MemberDefinition '[DllImport("user32.dll")]public static extern int SendMessage(int hWnd, int hMsg, int wParam, int lParam);'
[Win32.Monitor]::SendMessage(-1, 0x0112, 0xF170, 2)
Start-Sleep -Seconds 1