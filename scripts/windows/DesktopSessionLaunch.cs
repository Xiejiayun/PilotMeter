using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

// The page supplies only a saved account ID. Paths and executable arguments
// come from the verified desktop runtime and the native project picker.
internal static class DesktopSessionLaunch
{
    internal static bool RequestId(string value)
    { return value != null && Regex.IsMatch(value, @"^[A-Za-z0-9_-]{1,80}$"); }

    internal static bool Available(string runtimeRoot)
    {
        if (String.IsNullOrEmpty(runtimeRoot)) return false;
        try { return File.Exists(Path.Combine(runtimeRoot, "runtime", "node.exe")) && File.Exists(Path.Combine(runtimeRoot, "app", "bin", "pilotmeter.js")); }
        catch (ArgumentException) { return false; }
    }

    internal static void VerifyAccount(Dictionary<string, object> overview, string accountId)
    {
        if (accountId == null || !DesktopWebPolicy.Account(accountId)) throw new InvalidDataException("请先选择一个已登录的 GitHub 账号。");
        object value;
        if (!overview.TryGetValue("enabled", out value) || !(value is bool) || !(bool)value)
            throw new InvalidOperationException("当前环境不支持启动真实会话。");
        if (DesktopJson.OptionalString(overview, "activeAccountId", 36) != accountId)
            throw new InvalidOperationException("当前账号已变化，请刷新后重新启动会话。");
        if (overview.TryGetValue("login", out value) && value != null)
        {
            var login = value as Dictionary<string, object>;
            if (login == null) throw new InvalidDataException("无法确认登录状态，请刷新后重试。");
            var status = DesktopJson.String(login, "status", 32);
            if (status == "starting" || status == "pending" || status == "verifying")
                throw new InvalidOperationException("请先完成或取消当前登录，再启动 Copilot 会话。");
        }
        if (!overview.TryGetValue("accounts", out value) || !(value is object[])) throw new InvalidDataException("无法确认账号，请刷新后重试。");
        foreach (var item in (object[])value)
        {
            var profile = item as Dictionary<string, object>;
            if (profile == null) throw new InvalidDataException("无法确认账号，请刷新后重试。");
            if (DesktopJson.String(profile, "id", 36) != accountId) continue;
            var profileStatus = DesktopJson.String(profile, "status", 32);
            if (profileStatus == "reauth-required")
                throw new InvalidOperationException("这个账号需要重新登录。请前往账号页面完成登录后重试。");
            // A quota refresh can fail transiently while the saved sign-in is
            // still valid. The CLI run-context verifies its identity at launch.
            if (profileStatus != "connected" && profileStatus != "error")
                throw new InvalidDataException("无法确认账号状态，请刷新后重试。");
            return;
        }
        throw new InvalidOperationException("这个账号已移除。请先选择一个已登录的账号。");
    }

    internal static ProcessStartInfo StartInfo(string runtimeRoot, string directory, string accountId, string project)
    {
        if (accountId == null || !DesktopWebPolicy.Account(accountId)) throw new ArgumentException("会话账号无效。");
        var runtime = DesktopApp.AbsolutePath(runtimeRoot);
        var data = DesktopApp.AbsolutePath(directory);
        var workingDirectory = DesktopApp.AbsolutePath(project);
        if (!Available(runtime)) throw new IOException("桌面运行文件不完整，请重新打开原始 PilotMeter EXE。");
        if (!Directory.Exists(data) || !Directory.Exists(workingDirectory)) throw new IOException("所选目录已不存在，请重新选择项目目录。");
        var start = new ProcessStartInfo {
            FileName = Path.Combine(runtime, "runtime", "node.exe"),
            Arguments = DesktopApp.Quote(Path.Combine(runtime, "app", "bin", "pilotmeter.js")) + " --data-dir " + DesktopApp.Quote(data)
                + " run --account " + DesktopApp.Quote(accountId) + " -- --no-auto-update",
            WorkingDirectory = workingDirectory,
            UseShellExecute = false, CreateNoWindow = false, WindowStyle = ProcessWindowStyle.Normal
        };
        // Desktop launch always uses the installed bundled CLI. The explicit
        // development override remains available only to CLI users.
        start.EnvironmentVariables.Remove("PILOTMETER_COPILOT_BIN");
        VerifyEnvironment(start.EnvironmentVariables);
        return start;
    }

    internal static void VerifyEnvironment(StringDictionary environment)
    {
        foreach (string key in environment.Keys)
            if (!String.IsNullOrEmpty(environment[key]) && Regex.IsMatch(key, @"^(OTEL_EXPORTER_OTLP(?:_|$)|COPILOT_OTEL_|OTEL_(?:TRACES|METRICS|LOGS)_EXPORTER$|OTEL_SDK_DISABLED$)", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("当前环境已配置其他遥测导出器，尚未启动会话。请清除冲突的 OTEL / COPILOT_OTEL 环境变量后重启应用；或在已有终端使用 EXE 的 run --replace-telemetry 命令。");
    }

    internal static bool ExpectedExit(int exitCode)
    { return exitCode == 0 || exitCode == 130 || exitCode == -1073741510; }

    internal static Dictionary<string, object> ExitMessage(string accountId, int epoch, int exitCode)
    {
        if (accountId == null || !DesktopWebPolicy.Account(accountId)) throw new ArgumentException("会话账号无效。");
        return new Dictionary<string, object> { { "type", "session-exit" }, { "accountId", accountId },
            { "epoch", epoch }, { "exitCode", exitCode },
            { "message", "Copilot 终端已异常退出（退出码 " + exitCode + "）。请在账号页面确认登录状态后重试。若仍失败，可在已有终端运行 PilotMeter EXE 的 run 命令查看原因。" } };
    }
}

internal sealed class DesktopSessionResult
{
    internal string Status, Message;
    internal DesktopSessionResult(string status, string message) { Status = status; Message = message; }
}

// Separate the async checks from the native dialog/process to exercise account
// changes and page replacement without opening a real terminal in tests.
internal sealed class DesktopSessionStarter
{
    private bool busy;
    internal bool Busy { get { return busy; } }
    internal async Task<DesktopSessionResult> StartAsync(string accountId, Func<bool> current,
        Func<Task<Dictionary<string, object>>> readAccounts, Func<string> chooseProject, Action<string, string> launch)
    {
        if (busy) return new DesktopSessionResult("error", "正在准备另一个会话，请完成目录选择后重试。");
        busy = true;
        try
        {
            EnsureCurrent(current);
            DesktopSessionLaunch.VerifyAccount(await readAccounts(), accountId);
            EnsureCurrent(current);
            var project = chooseProject();
            EnsureCurrent(current);
            if (project == null) return new DesktopSessionResult("cancelled", "已取消启动，尚未打开 Copilot 会话。");
            DesktopSessionLaunch.VerifyAccount(await readAccounts(), accountId);
            EnsureCurrent(current);
            launch(accountId, project);
            return new DesktopSessionResult("started", "已打开 Copilot 终端。发送请求后，用量记录会自动更新。");
        }
        catch (Exception error)
        {
            if (error is OutOfMemoryException || error is StackOverflowException) throw;
            return new DesktopSessionResult("error", NativeData.Error(error));
        }
        finally { busy = false; }
    }
    private static void EnsureCurrent(Func<bool> current)
    { if (!current()) throw new InvalidOperationException("服务或账号状态已变化，请等待操作完成后重新启动会话。"); }
}
