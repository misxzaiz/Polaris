Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Off {
    [DllImport("ntdll.dll")]
    public static extern int NtSetSystemPowerState(bool sleeping, int state, int flags);
    public static void Main() {
        int r = NtSetSystemPowerState(false, 1, 0);
        System.Console.WriteLine("ret=" + r);
    }
}
'@
[Off]::Main()
