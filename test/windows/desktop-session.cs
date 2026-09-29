using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

internal static class DesktopSessionTests
{
    private const string Account = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private const string OtherAccount = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    private static int checks;
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    private static void Check(bool value, string name) { if (!value) throw new Exception(name); checks++; }
    private static void Reject(Action operation, string name)
    {
        try { operation(); } catch (InvalidOperationException) { checks++; return; }
        catch (ArgumentException) { checks++; return; } catch (IOException) { checks++; return; }
        catch (InvalidDataException) { checks++; return; }
        throw new Exception(name);
    }
    private static Dictionary<string, object> Overview(string selected = Account, string status = "connected")
    {
        return new Dictionary<string, object> {
            { "enabled", true }, { "activeAccountId", selected }, { "login", null },
            { "accounts", new object[] { new Dictionary<string, object> { { "id", Account }, { "status", status } } } }
        };
    }
    internal static async Task<int> Run(string temporary)
    {
        foreach (var id in new[] { "launch-1", Account, "request_123" }) Check(DesktopSessionLaunch.RequestId(id), "Bounded request identifiers accepted");
        foreach (var id in new[] { null, "", "a b", "a&calc", "a\nb", new string('a', 81) }) Check(!DesktopSessionLaunch.RequestId(id), "Malformed request identifiers rejected");
        DesktopSessionLaunch.VerifyAccount(Overview(), Account); checks++;
        foreach (var id in new[] { null, "", "none", OtherAccount, Account + " & calc" })
            Reject(delegate { DesktopSessionLaunch.VerifyAccount(Overview(), id); }, "Only the selected saved account may launch");
        DesktopSessionLaunch.VerifyAccount(Overview(Account, "error"), Account); checks++;
        foreach (var status in new[] { "reauth-required", "ready", "unknown" })
            Reject(delegate { DesktopSessionLaunch.VerifyAccount(Overview(Account, status), Account); }, "Unconnected saved account rejected");
        Reject(delegate { DesktopSessionLaunch.VerifyAccount(Overview(null), Account); }, "All-local view cannot launch with an implicit account");
        var disabled = Overview(); disabled["enabled"] = false;
        Reject(delegate { DesktopSessionLaunch.VerifyAccount(disabled, Account); }, "Demo and disabled account capability rejected");
        var removed = Overview(); removed["accounts"] = new object[0];
        Reject(delegate { DesktopSessionLaunch.VerifyAccount(removed, Account); }, "Removed profile rejected even with stale selected ID");
        foreach (var status in new[] { "starting", "pending", "verifying" })
        {
            var login = Overview(); login["login"] = new Dictionary<string, object> { { "status", status } };
            Reject(delegate { DesktopSessionLaunch.VerifyAccount(login, Account); }, "Active login prevents a new session");
        }
        foreach (var status in new[] { "complete", "cancelled", "failed", "expired" })
        {
            var login = Overview(); login["login"] = new Dictionary<string, object> { { "status", status } };
            DesktopSessionLaunch.VerifyAccount(login, Account); checks++;
        }
        Check(!DesktopSessionLaunch.Available(null) && !DesktopSessionLaunch.Available(temporary), "No launcher capability without bundled runtime files");
        var runtime = Path.Combine(temporary, "session runtime &(test) %PATH%");
        Directory.CreateDirectory(Path.Combine(runtime, "runtime")); Directory.CreateDirectory(Path.Combine(runtime, "app", "bin"));
        File.WriteAllText(Path.Combine(runtime, "runtime", "node.exe"), "test fixture; never executed");
        File.WriteAllText(Path.Combine(runtime, "app", "bin", "pilotmeter.js"), "test fixture; never executed");
        var project = Path.Combine(temporary, "项目 &(whoami) %PATH% ! $ '"); Directory.CreateDirectory(project);
        Check(DesktopSessionLaunch.Available(runtime), "Bundled runtime enables native launch");
        var info = DesktopSessionLaunch.StartInfo(runtime, temporary, Account, project);
        Check(!info.UseShellExecute && !info.CreateNoWindow && !info.RedirectStandardInput && !info.RedirectStandardOutput && !info.RedirectStandardError, "Interactive console directly inherits its own terminal without shell or redirected credentials");
        Check(info.FileName == Path.Combine(runtime, "runtime", "node.exe") && info.WorkingDirectory == project, "Only bundled Node and native-selected directory are used");
        Check(!info.EnvironmentVariables.ContainsKey("PILOTMETER_COPILOT_BIN"), "Desktop session cannot redirect Copilot to an environment override");
        foreach (var code in new[] { 0, 130, -1073741510 }) Check(DesktopSessionLaunch.ExpectedExit(code), "Normal completion and Ctrl+C do not show failure");
        Check(!DesktopSessionLaunch.ExpectedExit(1), "Unexpected CLI failure is reported");
        var exit = DesktopSessionLaunch.ExitMessage(Account, 19, 1);
        Check((string)exit["type"] == "session-exit" && (string)exit["accountId"] == Account && (int)exit["epoch"] == 19 && (int)exit["exitCode"] == 1, "Terminal failure preserves pinned account and page epoch for frontend ownership checks");
        Check(exit.Count == 5 && !((string)exit["message"]).Contains(temporary), "Exit bridge carries only safe status and no process path or credential fields");
        foreach (var key in new[] { "OTEL_EXPORTER_OTLP_ENDPOINT", "COPILOT_OTEL_ENABLED", "OTEL_TRACES_EXPORTER", "OTEL_SDK_DISABLED" })
        {
            var environment = new StringDictionary(); environment[key] = "private-value-never-displayed";
            Reject(delegate { DesktopSessionLaunch.VerifyEnvironment(environment); }, "Existing telemetry is rejected before opening a disappearing console");
        }
        var unrelated = new StringDictionary(); unrelated["PATH"] = "unchanged"; unrelated["OTEL_EXPORTER_OTLP_ENDPOINT"] = "";
        DesktopSessionLaunch.VerifyEnvironment(unrelated); checks++;
        int count; var parsed = CommandLineToArgvW(DesktopApp.Quote(info.FileName) + " " + info.Arguments, out count);
        Check(parsed != IntPtr.Zero, "Windows can parse the actual process arguments");
        try
        {
            var expected = new[] { info.FileName, Path.Combine(runtime, "app", "bin", "pilotmeter.js"), "--data-dir", temporary, "run", "--account", Account, "--", "--no-auto-update" };
            Check(count == expected.Length, "Shell-like characters never create extra arguments");
            for (int index = 0; index < count; index++) Check(Marshal.PtrToStringUni(Marshal.ReadIntPtr(parsed, IntPtr.Size * index)) == expected[index], "Each process argument roundtrips through Windows exactly");
        }
        finally { LocalFree(parsed); }
        Reject(delegate { DesktopSessionLaunch.StartInfo(runtime, temporary, Account + " --replace-telemetry", project); }, "Injected account arguments rejected");
        Reject(delegate { DesktopSessionLaunch.StartInfo(runtime, temporary, Account, "relative"); }, "Relative project paths rejected");
        Reject(delegate { DesktopSessionLaunch.StartInfo(runtime, temporary, Account, Path.Combine(temporary, "missing")); }, "Missing project paths rejected");

        var starter = new DesktopSessionStarter(); int reads = 0, picks = 0, launches = 0;
        Func<Task<Dictionary<string, object>>> read = delegate { reads++; return Task.FromResult(Overview()); };
        Func<string> pick = delegate { picks++; return project; };
        Action<string, string> launch = delegate(string id, string chosen) { Check(id == Account && chosen == project, "Actual launch retains selected account and chosen project"); launches++; };
        var result = await starter.StartAsync(Account, delegate { return true; }, read, pick, launch);
        Check(result.Status == "started" && reads == 2 && picks == 1 && launches == 1 && !starter.Busy, "Launch revalidates account after native project selection");
        reads = picks = launches = 0;
        result = await starter.StartAsync(Account, delegate { return true; }, read, delegate { picks++; return null; }, launch);
        Check(result.Status == "cancelled" && reads == 1 && picks == 1 && launches == 0 && !starter.Busy, "Cancelling native dialog never opens a process");
        reads = picks = 0;
        result = await starter.StartAsync(Account, delegate { return false; }, read, pick, launch);
        Check(result.Status == "error" && reads == 0 && picks == 0 && launches == 0, "Mutation, recovery or stale epoch rejects before reading accounts");
        bool current = true;
        result = await starter.StartAsync(Account, delegate { return current; }, delegate { current = false; return Task.FromResult(Overview()); }, pick, launch);
        Check(result.Status == "error" && picks == 0 && launches == 0, "Page replacement during account read never opens dialog");
        current = true;
        result = await starter.StartAsync(Account, delegate { return current; }, read, delegate { current = false; return project; }, launch);
        Check(result.Status == "error" && launches == 0, "Page or mutation state changing during folder selection prevents launch");
        reads = 0;
        result = await starter.StartAsync(Account, delegate { return true; }, delegate { reads++; return Task.FromResult(Overview(reads == 1 ? Account : OtherAccount)); }, pick, launch);
        Check(result.Status == "error" && reads == 2 && launches == 0, "Account changed while picker was open is never launched");
        var pendingRead = new TaskCompletionSource<Dictionary<string, object>>();
        var first = starter.StartAsync(Account, delegate { return true; }, delegate { return pendingRead.Task; }, pick, launch);
        Check(starter.Busy && !first.IsCompleted, "Async read owns launch lock");
        var second = await starter.StartAsync(Account, delegate { return true; }, read, pick, launch);
        Check(second.Status == "error" && launches == 0, "Duplicate launch cannot open another dialog or terminal");
        pendingRead.SetResult(Overview()); await first;
        Check(launches == 1 && !starter.Busy, "First request keeps its ownership until it completes");
        result = await starter.StartAsync(Account, delegate { return true; }, read, pick, delegate { throw new IOException("终端未能打开。"); });
        Check(result.Status == "error" && result.Message.Contains("终端") && !starter.Busy, "Process errors return useful feedback and release launch lock");
        return checks;
    }
}
