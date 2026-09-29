using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

internal static class DesktopApp
{
    internal const string AppName = "pilotmeter";

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint length, uint flags);

    internal static string AbsolutePath(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || !Regex.IsMatch(value, @"^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)"))
            throw new ArgumentException("PilotMeter 需要绝对路径。请从原始 EXE 启动。");
        return Path.GetFullPath(value);
    }

    // Resolve junctions and short names before deriving the per-directory instance key.
    internal static string CanonicalDirectory(string value)
    {
        var absolute = AbsolutePath(value);
        Directory.CreateDirectory(absolute);
        using (var handle = CreateFile(absolute, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new IOException("无法打开 PilotMeter 数据目录。");
            var buffer = new StringBuilder(32768);
            var length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0 || length >= buffer.Capacity) throw new IOException("无法确认 PilotMeter 数据目录。");
            var canonical = buffer.ToString();
            if (canonical.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) canonical = @"\\" + canonical.Substring(8);
            else if (canonical.StartsWith(@"\\?\", StringComparison.Ordinal)) canonical = canonical.Substring(4);
            var root = Path.GetPathRoot(canonical);
            return canonical.Length > root.Length ? canonical.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) : canonical;
        }
    }

    internal static string DirectoryKey(string directory)
    {
        using (var sha = SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(directory.ToUpperInvariant()))).Replace("-", "");
    }

    internal static string Quote(string value)
    {
        var output = new StringBuilder("\"");
        var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\') { slashes++; continue; }
            output.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            slashes = 0;
            output.Append(character);
        }
        output.Append('\\', slashes * 2).Append('"');
        return output.ToString();
    }

    private static void WakeExisting(string eventName)
    {
        var timer = Stopwatch.StartNew();
        while (timer.ElapsedMilliseconds < 2000)
        {
            try { using (var signal = EventWaitHandle.OpenExisting(eventName)) { signal.Set(); return; } }
            catch (WaitHandleCannotBeOpenedException) { Thread.Sleep(50); }
        }
    }

    [STAThread]
    public static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            var options = DesktopOptions.Parse(args);
            var runtimeRoot = options.RuntimeRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var expectedDesktop = Path.Combine(runtimeRoot, "desktop", "PilotMeter.Desktop.exe");
            if (!String.Equals(Path.GetFullPath(Assembly.GetExecutingAssembly().Location), expectedDesktop, StringComparison.OrdinalIgnoreCase)
                || !File.Exists(Path.Combine(runtimeRoot, "runtime", "node.exe"))
                || !File.Exists(Path.Combine(runtimeRoot, "app", "bin", "pilotmeter.js"))
                || !File.Exists(options.Launcher))
                throw new InvalidDataException("桌面运行文件不完整。请重新打开原始 PilotMeter EXE。");
            var package = DesktopJson.ReadFile(Path.Combine(runtimeRoot, "app", "package.json"));
            var version = DesktopJson.String(package, "version", 80);
            if (DesktopJson.String(package, "name", 80) != AppName || !Regex.IsMatch(version, @"^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$"))
                throw new InvalidDataException("PilotMeter 版本信息无效。");
            var directory = CanonicalDirectory(options.DataDirectory);
            var key = DirectoryKey(directory);
            var eventName = "Local\\PilotMeter.Desktop.Wake." + key;
            var openEventName = "Local\\PilotMeter.Desktop.Open." + key;
            using (var mutex = new Mutex(false, "Local\\PilotMeter.Desktop." + key))
            {
                bool owned;
                try { owned = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { owned = true; }
                if (!owned) { WakeExisting(options.OpenMain ? openEventName : eventName); return 0; }
                try
                {
                    using (var signal = new EventWaitHandle(false, EventResetMode.AutoReset, eventName))
                    using (var openSignal = new EventWaitHandle(false, EventResetMode.AutoReset, openEventName))
                    using (var context = new DesktopContext(runtimeRoot, options.Launcher, directory, version, signal, openSignal, options.OpenMain))
                        Application.Run(context);
                }
                finally { mutex.ReleaseMutex(); }
            }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "PilotMeter 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}

internal sealed class DesktopOptions
{
    internal string RuntimeRoot;
    internal string Launcher;
    internal string DataDirectory;
    internal bool OpenMain;

    internal static DesktopOptions Parse(string[] args)
    {
        if (args == null) throw new ArgumentException("桌面启动参数无效。");
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        var openMain = false;
        for (var index = 0; index < args.Length; index += 2)
        {
            var name = args[index];
            if (name == "--open-main" && index == args.Length - 1) { openMain = true; break; }
            if ((name != "--runtime-root" && name != "--launcher" && name != "--data-dir") || index + 1 >= args.Length || values.ContainsKey(name))
                throw new ArgumentException("桌面启动参数无效。请直接打开 PilotMeter EXE。");
            values.Add(name, DesktopApp.AbsolutePath(args[index + 1]));
        }
        if (values.Count != 3) throw new ArgumentException("请从 PilotMeter EXE 打开桌面挂件。");
        return new DesktopOptions {
            RuntimeRoot = values["--runtime-root"], Launcher = values["--launcher"], DataDirectory = values["--data-dir"], OpenMain = openMain
        };
    }
}

internal static class DesktopJson
{
    internal const int MaxLength = 65536;
    internal const int ApiMaxLength = 1048576;

    internal static Dictionary<string, object> Parse(string content, int maximum = MaxLength)
    {
        if (maximum < 1 || maximum > ApiMaxLength) throw new ArgumentOutOfRangeException("maximum");
        if (content.Length > maximum) throw new InvalidDataException("本地服务响应过大。");
        var serializer = new JavaScriptSerializer { MaxJsonLength = maximum, RecursionLimit = 16 };
        var result = serializer.DeserializeObject(content) as Dictionary<string, object>;
        if (result == null) throw new InvalidDataException("本地服务响应无效。");
        return result;
    }

    internal static Dictionary<string, object> ReadFile(string path)
    {
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            if (stream.Length > MaxLength) throw new InvalidDataException("本地状态文件过大。");
            using (var reader = new StreamReader(stream, Encoding.UTF8, true))
            {
                var buffer = new char[MaxLength + 1];
                var count = reader.ReadBlock(buffer, 0, buffer.Length);
                if (count > MaxLength) throw new InvalidDataException("本地状态文件过大。");
                return Parse(new string(buffer, 0, count));
            }
        }
    }

    internal static string String(Dictionary<string, object> value, string key, int limit)
    {
        object item;
        if (!value.TryGetValue(key, out item) || !(item is string) || ((string)item).Length > limit)
            throw new InvalidDataException("本地服务字段无效。");
        return (string)item;
    }

    internal static string OptionalString(Dictionary<string, object> value, string key, int limit)
    {
        object item;
        if (!value.TryGetValue(key, out item) || item == null) return null;
        return String(value, key, limit);
    }
}

internal sealed class DesktopInstance
{
    internal string Version;
    internal string InstanceId;
    internal Uri Origin;

    internal static DesktopInstance FromDescriptor(Dictionary<string, object> value)
    {
        if (DesktopJson.String(value, "app", 80) != DesktopApp.AppName) throw new InvalidDataException("服务类型不符。");
        var url = DesktopJson.String(value, "url", 256);
        Uri origin;
        if (!Regex.IsMatch(url, @"^http://127\.0\.0\.1:[0-9]{1,5}/?$") || !Uri.TryCreate(url, UriKind.Absolute, out origin)
            || origin.Port < 1 || origin.Port > 65535)
            throw new InvalidDataException("服务地址不是受支持的本机地址。");
        var instance = new DesktopInstance {
            Version = DesktopJson.String(value, "version", 80),
            InstanceId = DesktopJson.String(value, "instanceId", 80),
            Origin = new Uri(origin.GetLeftPart(UriPartial.Authority) + "/")
        };
        Guid id;
        if (!Guid.TryParse(instance.InstanceId, out id)) throw new InvalidDataException("本地服务标识无效。");
        return instance;
    }

    internal bool Matches(Dictionary<string, object> value)
    {
        return DesktopJson.String(value, "app", 80) == DesktopApp.AppName
            && DesktopJson.String(value, "version", 80) == Version
            && DesktopJson.String(value, "instanceId", 80) == InstanceId;
    }

    internal bool SameAs(DesktopInstance other)
    {
        return other != null && other.Version == Version && other.InstanceId == InstanceId && other.Origin == Origin;
    }
}

internal sealed class DesktopContext : ApplicationContext
{
    private readonly string runtimeRoot;
    private readonly string launcher;
    private readonly string directory;
    private readonly string version;
    private readonly DesktopWidget widget;
    private readonly DesktopPetPreferences petPreferences;
    private readonly System.Windows.Forms.Timer timer;
    private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
    private readonly HttpClient http;
    private readonly RegisteredWaitHandle wake;
    private readonly RegisteredWaitHandle openWake;
    private DesktopInstance instance;
    private DesktopInstance recoveryInstance;
    private bool recoveringService;
    private DashboardWindow dashboard;
    private DesktopNativeApi pendingAction;
    private bool refreshing;
    private bool actionBusy, refreshQueued, queuedAllowStart, dashboardMutationObserved;
    private readonly WidgetSnapshotGate snapshotGate = new WidgetSnapshotGate();
    private string selectedQuotaAccountId, selectedQuotaKey;
    private bool exiting;
    private string unavailable = "正在连接本机服务…";
    private bool DashboardChangingAccount { get { return dashboard != null && !dashboard.IsDisposed && dashboard.AccountMutationPending; } }

    internal DesktopContext(string runtimeRoot, string launcher, string directory, string version, EventWaitHandle signal, EventWaitHandle openSignal, bool openMain)
    {
        this.runtimeRoot = runtimeRoot;
        this.launcher = launcher;
        this.directory = directory;
        this.version = version;
        http = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false });
        http.Timeout = TimeSpan.FromSeconds(3);
        petPreferences = new DesktopPetPreferences(directory);
        widget = new DesktopWidget(petPreferences, OpenMain, ExitDesktop,
            async delegate(string accountId) { await ChangeAccountAsync(accountId); },
            async delegate { await ChangeAccountAsync(null); });
        SetSnapshot("loading", "PilotMeter", "连接中", unavailable);
        widget.ShowWidget();
        wake = ThreadPool.RegisterWaitForSingleObject(signal, delegate {
            if (exiting || widget.IsDisposed) return;
            try { widget.BeginInvoke(new Action(delegate { if (!exiting) widget.ShowWidget(); })); }
            catch (InvalidOperationException) { }
        }, null, Timeout.Infinite, false);
        openWake = ThreadPool.RegisterWaitForSingleObject(openSignal, delegate {
            if (exiting || widget.IsDisposed) return;
            try { widget.BeginInvoke(new Action(delegate { if (!exiting) OpenMain(); })); }
            catch (InvalidOperationException) { }
        }, null, Timeout.Infinite, false);
        timer = new System.Windows.Forms.Timer { Interval = 5000 };
        timer.Tick += async delegate { await RefreshAsync(false); };
        timer.Start();
        widget.BeginInvoke(new Action(async delegate {
            await RefreshAsync(true);
            if (openMain && !exiting) OpenMain();
        }));
    }

    private void SetSnapshot(string state, string title, string value, string detail)
    {
        widget.ApplySnapshot(new WidgetSnapshot { State = state, Title = title, Value = value, Detail = detail, Percentage = null });
    }

    private async Task<Dictionary<string, object>> GetJsonAsync(Uri uri)
    {
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
        {
            timeout.CancelAfter(3000);
            using (var response = await http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, timeout.Token))
            using (timeout.Token.Register(response.Dispose))
            {
                if (response.StatusCode != HttpStatusCode.OK || (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value > DesktopJson.MaxLength))
                    throw new InvalidDataException("本机服务暂不可用。");
                using (var input = await response.Content.ReadAsStreamAsync())
                using (var output = new MemoryStream())
                {
                    var buffer = new byte[4096];
                    int count;
                    while ((count = await input.ReadAsync(buffer, 0, buffer.Length, timeout.Token)) > 0)
                    {
                        if (output.Length + count > DesktopJson.MaxLength) throw new InvalidDataException("本机服务响应过大。");
                        output.Write(buffer, 0, count);
                    }
                    return DesktopJson.Parse(Encoding.UTF8.GetString(output.ToArray()));
                }
            }
        }
    }

    private async Task<DesktopInstance> ProbeAsync()
    {
        try
        {
            // The file also contains CLI credentials. Only these three identity
            // fields and the loopback URL leave this method; none enter the native account controls.
            var candidate = DesktopInstance.FromDescriptor(DesktopJson.ReadFile(Path.Combine(directory, "instance.json")));
            var health = await GetJsonAsync(new Uri(candidate.Origin, "health"));
            return candidate.Matches(health) ? candidate : null;
        }
        catch (Exception error)
        {
            if (error is OutOfMemoryException || error is StackOverflowException) throw;
            return null;
        }
    }

    private Task StartServiceAsync() { return RunServiceCommandAsync("start --background", "本机服务启动失败，请重试。"); }

    private async Task RunServiceCommandAsync(string command, string failure)
    {
        await Task.Run(delegate {
            lifetime.Token.ThrowIfCancellationRequested();
            var executable = Path.Combine(runtimeRoot, "runtime", "node.exe");
            var start = new ProcessStartInfo {
                FileName = executable,
                Arguments = DesktopApp.Quote(Path.Combine(runtimeRoot, "app", "bin", "pilotmeter.js")) + " --data-dir " + DesktopApp.Quote(directory) + " " + command,
                WorkingDirectory = directory,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            start.EnvironmentVariables["PILOTMETER_LAUNCHER_PATH"] = launcher;
            // No redirected pipes are inherited by the detached daemon.
            using (var child = Process.Start(start))
            {
                if (child == null) throw new IOException("本机服务未能启动。");
                var elapsed = Stopwatch.StartNew();
                while (!child.WaitForExit(100))
                {
                    if (lifetime.IsCancellationRequested || elapsed.ElapsedMilliseconds > 15000)
                    {
                        try { child.Kill(); } catch (InvalidOperationException) { }
                        lifetime.Token.ThrowIfCancellationRequested();
                        throw new IOException("本机服务操作超时，请稍后重试。");
                    }
                }
                if (child.ExitCode != 0) throw new IOException(failure);
            }
        }, lifetime.Token);
    }

    private void Disconnect(string state, string message)
    {
        instance = null;
        widget.SetAccounts(null, null, false);
        unavailable = message;
        SetSnapshot(state, "PilotMeter", state == "loading" ? "连接中" : "未连接", message);
        if (dashboard != null && !dashboard.IsDisposed)
        {
            dashboard.SetService(null, message);
            dashboard.SetServiceRecovery(recoveryInstance != null, recoveringService);
        }
    }

    // Only the explicit recovery button may replace a running service. Timer
    // probes never stop it, and the CLI pins shutdown to the observed instance.
    private async Task RefreshRequestedAsync()
    {
        if (exiting || actionBusy || recoveringService || DashboardChangingAccount) return;
        var expected = recoveryInstance;
        if (expected == null) { await RefreshAsync(true); return; }
        actionBusy = recoveringService = true; snapshotGate.BeginMutation(); widget.SetActionBusy(true);
        var recovered = false;
        try
        {
            Disconnect("loading", "正在重启本机服务，完成后即可登录…");
            var current = await ProbeAsync();
            if (current != null && !expected.SameAs(current)) recovered = true;
            else
            {
                if (current != null)
                {
                    await RunServiceCommandAsync("stop --if-instance " + DesktopApp.Quote(expected.InstanceId), "后台状态已变化，未执行重启。请重试连接。");
                    var deadline = Stopwatch.StartNew();
                    while (Directory.Exists(Path.Combine(directory, "writer.lock")))
                    {
                        lifetime.Token.ThrowIfCancellationRequested();
                        if (deadline.ElapsedMilliseconds > 30000) throw new IOException("后台仍在结束操作，请稍后点击“重启本机服务”。");
                        await Task.Delay(100, lifetime.Token);
                    }
                }
                // With no live service, normal startup handles stale lock
                // recovery using the lock owner's identity and process liveness.
                await StartServiceAsync(); recovered = true;
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            if (error is OutOfMemoryException || error is StackOverflowException) throw;
            if (!exiting) Disconnect("error", NativeData.Error(error));
        }
        finally
        {
            actionBusy = recoveringService = false; snapshotGate.EndMutation();
            if (!exiting)
            {
                widget.SetActionBusy(DashboardChangingAccount);
                if (dashboard != null && !dashboard.IsDisposed) dashboard.SetServiceRecovery(recoveryInstance != null, false);
            }
        }
        if (!exiting && recovered) { recoveryInstance = null; await RefreshAsync(true); }
    }

    private async Task RefreshAsync(bool allowStart)
    {
        if (exiting || DashboardChangingAccount || !snapshotGate.CanRead) return;
        if (refreshing || actionBusy) { refreshQueued = true; queuedAllowStart |= allowStart; return; }
        refreshing = true;
        long generation = snapshotGate.Capture();
        try
        {
            var candidate = await ProbeAsync();
            if (exiting || !snapshotGate.Accepts(generation)) return;
            if (candidate == null && allowStart)
            {
                Disconnect("loading", "正在启动本机服务…");
                await StartServiceAsync();
                candidate = await ProbeAsync();
            }
            if (exiting || !snapshotGate.Accepts(generation)) return;
            if (candidate == null) { Disconnect("offline", "本机服务已断开。点击挂件打开主程序后重试。"); return; }
            if (candidate.Version != version)
            {
                recoveryInstance = candidate;
                Disconnect("error", "后台仍在运行 " + candidate.Version + "，当前窗口为 " + version + "。请点击右上角“重启本机服务”恢复登录。若有采集中的会话，请先结束会话再重启。");
                return;
            }
            recoveryInstance = null;
            if (!candidate.SameAs(instance))
            {
                Disconnect("loading", "正在重新读取当前账号…");
                instance = candidate;
            }
            // The health probe and the identity-bearing widget response bracket this small read.
            // Keep it on the same three-second, cancellation-bound transport as the widget.
            var accounts = WidgetAccountSet.Read(await GetJsonAsync(new Uri(candidate.Origin, "api/auth/accounts")));
            if (exiting || !snapshotGate.Accepts(generation) || DashboardChangingAccount) return;
            if (accounts.ActiveId != selectedQuotaAccountId) { selectedQuotaAccountId = accounts.ActiveId; selectedQuotaKey = null; }
            string widgetPath = "api/widget";
            if (selectedQuotaKey != null && selectedQuotaAccountId != null)
                widgetPath += "?quotaKey=" + Uri.EscapeDataString(selectedQuotaKey) + "&accountId=" + Uri.EscapeDataString(selectedQuotaAccountId);
            var snapshot = await GetJsonAsync(new Uri(candidate.Origin, widgetPath));
            if (exiting || !snapshotGate.Accepts(generation) || DashboardChangingAccount) return;
            if (!candidate.Matches(snapshot)) throw new InvalidDataException("本机服务已更换。");
            accounts.VerifySnapshot(snapshot);
            var state = DesktopJson.String(snapshot, "state", 40);
            if (!new HashSet<string>(new[] { "loading", "ready", "offline", "empty", "needs-login", "reauth", "stale", "waiting", "error" }).Contains(state))
                throw new InvalidDataException("挂件状态无效。");
            double? percentage = null;
            object raw;
            if (state == "ready" && snapshot.TryGetValue("percentage", out raw) && raw != null)
            {
                if (!(raw is decimal) && !(raw is double) && !(raw is int) && !(raw is long)) throw new InvalidDataException("额度比例无效。");
                var number = Convert.ToDouble(raw, CultureInfo.InvariantCulture);
                if (Double.IsNaN(number) || Double.IsInfinity(number) || number < 0 || number > 100) throw new InvalidDataException("额度比例无效。");
                percentage = number;
            }
            widget.ApplySnapshot(new WidgetSnapshot {
                State = state, Title = DesktopJson.String(snapshot, "title", 200),
                Value = DesktopJson.String(snapshot, "value", 200), Detail = DesktopJson.String(snapshot, "detail", 1000),
                AccountLogin = DesktopJson.OptionalString(snapshot, "accountLogin", 200),
                UpdatedAt = DesktopJson.OptionalString(snapshot, "updatedAt", 80), Percentage = percentage,
                UnitLabel = DesktopJson.OptionalString(snapshot, "unitLabel", 40), UnitUnspecified = snapshot.TryGetValue("unitUnspecified", out raw) && raw is bool && (bool)raw
            });
            widget.SetAccounts(accounts.Accounts, accounts.ActiveId, accounts.Enabled);
            if (dashboard != null && !dashboard.IsDisposed) { dashboard.SetService(candidate, null); dashboard.SetServiceRecovery(false, false); }
        }
        catch (OperationCanceledException) { if (!exiting && snapshotGate.Accepts(generation)) Disconnect("offline", "本机服务响应超时。点击挂件重试。"); }
        catch (Exception error)
        {
            if (error is OutOfMemoryException || error is StackOverflowException) throw;
            if (!exiting && snapshotGate.Accepts(generation)) Disconnect("offline", "无法读取本机服务。点击挂件打开主程序后重试。");
        }
        finally
        {
            refreshing = false;
            if (refreshQueued && !actionBusy && !exiting)
            {
                bool start = queuedAllowStart; refreshQueued = queuedAllowStart = false;
                try { widget.BeginInvoke(new Action(async delegate { await RefreshAsync(start); })); } catch (InvalidOperationException) { }
            }
        }
    }

    // A switch clears the old account before the mutation. Generation guards discard late GETs.
    private async Task ChangeAccountAsync(string accountId)
    {
        if (actionBusy || exiting || DashboardChangingAccount) return;
        if (instance == null) await RefreshAsync(true);
        if (actionBusy || exiting || DashboardChangingAccount) return;
        if (instance == null) { widget.ShowNotice("本机服务尚未连接，请打开主窗口后重试。"); return; }
        actionBusy = true; snapshotGate.BeginMutation(); widget.SetActionBusy(true);
        var expected = instance;
        SetSnapshot("loading", "PilotMeter", accountId == null ? "正在同步…" : "正在切换账号…", "正在重新读取当前账号的用量。");
        if (accountId != null)
        {
            selectedQuotaAccountId = selectedQuotaKey = null;
            if (dashboard != null && !dashboard.IsDisposed) dashboard.SetService(null, "正在重新读取当前账号…");
        }
        var api = new DesktopNativeApi(expected); pendingAction = api;
        try
        {
            if (accountId == null) await api.RequestAsync("/api/auth/refresh", "POST");
            else await api.RequestAsync("/api/auth/select", "POST", new Dictionary<string, object> { { "accountId", accountId } });
        }
        catch (Exception error)
        {
            if (error is OutOfMemoryException || error is StackOverflowException) throw;
            if (!exiting) widget.ShowNotice("操作未能确认，请查看当前状态后重试。" + Environment.NewLine + DesktopWidget.Clean(error.Message, 160));
        }
        finally
        {
            if (pendingAction == api) pendingAction = null; api.Dispose(); actionBusy = false; snapshotGate.EndMutation();
            if (!exiting) widget.SetActionBusy(DashboardChangingAccount);
        }
        if (!exiting) { refreshQueued = queuedAllowStart = false; await RefreshAsync(true); }
    }

    private void OpenMain()
    {
        if (exiting) return;
        if (dashboard == null || dashboard.IsDisposed)
        {
            dashboard = new DashboardWindow(directory, RefreshRequestedAsync);
            dashboard.SetPetPreferences(petPreferences);
            Icon dashboardIcon = DesktopBrand.CreateIcon();
            dashboard.Icon = dashboardIcon;
            dashboard.Disposed += delegate { dashboardIcon.Dispose(); };
            dashboard.SetService(instance, unavailable);
            dashboard.SetServiceRecovery(recoveryInstance != null, recoveringService);
            dashboard.RestoreQuotaSelection(selectedQuotaAccountId, selectedQuotaKey);
            dashboard.QuotaSelectionChanged += async delegate(object sender, NativeQuotaSelectionEventArgs choice)
            {
                if (exiting) return;
                bool pending = DashboardChangingAccount, wasPending = dashboardMutationObserved;
                if (pending && !wasPending) snapshotGate.BeginMutation();
                if (!pending && wasPending) snapshotGate.EndMutation();
                dashboardMutationObserved = pending; widget.SetActionBusy(actionBusy || pending);
                if (!pending && !wasPending && selectedQuotaAccountId == choice.AccountId && selectedQuotaKey == choice.Key) return;
                selectedQuotaAccountId = choice.AccountId; selectedQuotaKey = choice.Key; snapshotGate.Invalidate();
                SetSnapshot("loading", "PilotMeter", pending ? "正在更新账号…" : "正在更新用量…", "正在读取当前账号选择的额度类别。");
                if (pending) return;
                await RefreshAsync(false);
            };
        }
        dashboard.Show();
        if (dashboard.WindowState == FormWindowState.Minimized) dashboard.WindowState = FormWindowState.Normal;
        dashboard.Activate();
    }

    private void ExitDesktop()
    {
        if (exiting) return;
        exiting = true;
        timer.Stop();
        lifetime.Cancel();
        if (pendingAction != null) pendingAction.Dispose();
        if (dashboard != null) { dashboard.Dispose(); dashboard = null; }
        widget.Dispose();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            exiting = true;
            lifetime.Cancel();
            if (pendingAction != null) pendingAction.Dispose();
            timer.Dispose();
            wake.Unregister(null);
            openWake.Unregister(null);
            if (dashboard != null) dashboard.Dispose();
            widget.Dispose();
            http.Dispose();
            // A pending startup worker may still inspect this cancellation token.
            // Its source has no unmanaged wait handle and expires with the process.
        }
        base.Dispose(disposing);
    }
}
