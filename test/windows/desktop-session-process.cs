using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

#if SESSION_CONSOLE_PROBE
// Never contacts Copilot or GitHub: this replaces node.exe inside the test's
// isolated runtime and reports what an actual console process receives.
internal static class DesktopSessionConsoleProbe
{
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")] private static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
    public static int Main(string[] args)
    {
        if (args.Length != 8 || args[1] != "--data-dir") return 2;
        uint mode;
        File.WriteAllText(Path.Combine(args[2], "session-console-probe.json"), new JavaScriptSerializer().Serialize(new {
            arguments = args, directory = Environment.CurrentDirectory, console = GetConsoleWindow() != IntPtr.Zero,
            input = GetConsoleMode(GetStdHandle(-10), out mode), output = GetConsoleMode(GetStdHandle(-11), out mode),
            error = GetConsoleMode(GetStdHandle(-12), out mode)
        }));
        return 0;
    }
}
#else
// Compiled as winexe, exactly like the shipping GUI. Hiding the fixture's
// console changes only its initial visibility; console allocation and stream
// inheritance retain the shipping StartInfo behavior.
internal static class DesktopSessionProcessTests
{
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
    public static int Main(string[] args)
    {
        try
        {
            if (GetConsoleWindow() != IntPtr.Zero) throw new Exception("The GUI fixture must not own a console.");
            const string account = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            var start = DesktopSessionLaunch.StartInfo(args[0], args[1], account, args[2]);
            start.WindowStyle = ProcessWindowStyle.Hidden;
            using (var child = Process.Start(start))
            {
                if (child == null) throw new Exception("No child process was created.");
                if (!child.WaitForExit(10000)) { child.Kill(); throw new Exception("The bounded console probe timed out."); }
                if (child.ExitCode != 0) throw new Exception("The console probe failed.");
            }
            var result = DesktopJson.ReadFile(Path.Combine(args[1], "session-console-probe.json"));
            if (!(bool)result["console"] || !(bool)result["input"] || !(bool)result["output"] || !(bool)result["error"])
                throw new Exception("The console child did not receive interactive console handles.");
            if ((string)result["directory"] != args[2]) throw new Exception("The selected project directory changed.");
            var actual = (object[])result["arguments"];
            var expected = new[] { Path.Combine(args[0], "app", "bin", "pilotmeter.js"), "--data-dir", args[1], "run", "--account", account, "--", "--no-auto-update" };
            if (actual.Length != expected.Length) throw new Exception("Arguments were injected or lost.");
            for (int index = 0; index < actual.Length; index++) if ((string)actual[index] != expected[index]) throw new Exception("A pinned launch argument changed.");
            File.WriteAllText(Path.Combine(args[1], "session-process-result.txt"), "Desktop session process: GUI parent created interactive console handles; all 8 arguments and project directory verified.");
            return 0;
        }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(args[1], "session-process-result.txt"), error.ToString());
            return 1;
        }
    }
}
#endif
