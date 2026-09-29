using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// Only the desktop document and its own API/assets may enter the embedded view.
// No CLI credentials, host objects, arbitrary navigation or downloads are exposed.
internal static class DesktopWebPolicy
{
    internal const string RuntimeDownload = "https://developer.microsoft.com/microsoft-edge/webview2/#download-section";
    internal static bool SameOrigin(DesktopInstance instance, string target)
    {
        Uri url;
        return instance != null && Uri.TryCreate(target, UriKind.Absolute, out url)
            && url.Scheme == "http" && url.Host == "127.0.0.1" && url.Port == instance.Origin.Port
            && String.IsNullOrEmpty(url.UserInfo);
    }
    internal static bool Document(DesktopInstance instance, string target)
    {
        if (!SameOrigin(instance, target)) return false;
        var url = new Uri(target);
        return url.AbsolutePath == "/desktop.html" && String.IsNullOrEmpty(url.Query);
    }
    internal static bool Request(DesktopInstance instance, string target, string method)
    {
        if (!SameOrigin(instance, target)) return false;
        var url = new Uri(target);
        if (!String.IsNullOrEmpty(url.Fragment)) return false;
        if (method == "GET" && ((url.AbsolutePath == "/desktop.html" && String.IsNullOrEmpty(url.Query))
            || (Regex.IsMatch(url.AbsolutePath, @"^/assets/[A-Za-z0-9_.-]+\.(?:js|css|svg|ico|png|woff2?)$") && String.IsNullOrEmpty(url.Query))
            || url.PathAndQuery == "/api/session" || url.PathAndQuery == "/health")) return true;
        if (method == "POST" && Regex.IsMatch(url.PathAndQuery, @"^/api/auth/refresh\?accountId=(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})?$")) return true;
        if (method == "GET" && url.AbsolutePath == "/api/desktop/records" && url.PathAndQuery.Length <= 4096)
        {
            // An explicit empty account pins the all-local-records view. Keep
            // every remaining parameter under the existing strict validator.
            var parameters = url.Query.TrimStart('?').Split('&'); var retained = new List<string>();
            int accountParameters = 0, emptyAccounts = 0;
            foreach (var parameter in parameters)
            {
                if (parameter.StartsWith("accountId=", StringComparison.Ordinal)) accountParameters++;
                if (parameter == "accountId=") emptyAccounts++; else retained.Add(parameter);
            }
            if (accountParameters == 1 && emptyAccounts == 1)
                return DesktopNativeApi.Allowed("/api/desktop/records?" + String.Join("&", retained), "GET");
        }
        return DesktopNativeApi.Allowed(url.PathAndQuery, method);
    }
    internal static bool External(string target)
    {
        Uri url;
        return Uri.TryCreate(target, UriKind.Absolute, out url) && url.Scheme == "https" && url.IsDefaultPort
            && String.IsNullOrEmpty(url.UserInfo) && String.IsNullOrEmpty(url.Query)
            && Regex.IsMatch(url.Host, @"^(?:github\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com)$", RegexOptions.IgnoreCase)
            && (url.AbsolutePath == "/settings/copilot/features" || url.AbsolutePath == "/settings/billing/premium_requests"
                || url.AbsolutePath == "/settings/billing/summary");
    }
    internal static bool Account(string value) { return value == null || Regex.IsMatch(value, @"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"); }
    internal static bool Quota(string value) { return value == null || Regex.IsMatch(value, @"^[A-Za-z][A-Za-z0-9_-]{0,63}$"); }
}

internal sealed class DesktopWebWindow : Form
{
    private readonly string directory;
    private readonly string runtimeRoot;
    private readonly DesktopSessionStarter sessionStarter = new DesktopSessionStarter();
    private readonly Func<Task> reconnect;
    private readonly Panel fallback;
    private readonly Label status;
    private readonly Button retry, install;
    private WebView2 view;
    private DesktopInstance service, documentService;
    private DesktopPetPreferences preferences;
    private bool initializing, initialized, pageReady, disposed, recoveryAvailable, recovering;
    private int navigationGeneration;
    private string mutationOperation;
    private string message = "正在连接本机服务…", selectedAccount, selectedQuota;
    internal bool AccountMutationPending { get; private set; }
    internal string AccountMutationOperation { get { return mutationOperation; } }
    internal int ServiceEpoch { get { return navigationGeneration; } }
    internal bool OwnsAccountMutation(string operation, int epoch)
    { return !disposed && AccountMutationPending && operation != null && mutationOperation == operation && navigationGeneration == epoch; }
    internal event EventHandler<NativeQuotaSelectionEventArgs> QuotaSelectionChanged;

    internal DesktopWebWindow(string directory, Func<Task> reconnect, string runtimeRoot = null)
    {
        this.directory = directory; this.reconnect = reconnect; this.runtimeRoot = runtimeRoot;
        Text = "PilotMeter"; StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi; ClientSize = new Size(1260, 850); MinimumSize = new Size(760, 580);
        BackColor = Color.FromArgb(247, 248, 250); Font = new Font("Microsoft YaHei UI", 10F);
        fallback = new Panel { Dock = DockStyle.Fill, BackColor = BackColor, Padding = new Padding(40) };
        var stack = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 5 };
        stack.RowStyles.Add(new RowStyle(SizeType.Percent, 45));
        stack.RowStyles.Add(new RowStyle(SizeType.AutoSize)); stack.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        stack.RowStyles.Add(new RowStyle(SizeType.AutoSize)); stack.RowStyles.Add(new RowStyle(SizeType.Percent, 55));
        var brand = new Label { Text = "PilotMeter", AutoSize = true, Font = new Font("Segoe UI", 27, FontStyle.Bold), ForeColor = Color.FromArgb(24, 33, 45), Anchor = AnchorStyles.None, Margin = new Padding(0, 0, 0, 16) };
        status = new Label { Text = message, AutoSize = true, MaximumSize = new Size(610, 0), ForeColor = Color.FromArgb(89, 102, 119), TextAlign = ContentAlignment.MiddleCenter, Anchor = AnchorStyles.None, Margin = new Padding(0, 0, 0, 22) };
        var actions = new FlowLayoutPanel { AutoSize = true, Anchor = AnchorStyles.None, FlowDirection = FlowDirection.LeftToRight, WrapContents = true };
        retry = new Button { Text = "重新连接", AutoSize = true, Padding = new Padding(14, 9, 14, 9), FlatStyle = FlatStyle.Flat };
        install = new Button { Text = "安装 Microsoft WebView2", AutoSize = true, Padding = new Padding(14, 9, 14, 9), FlatStyle = FlatStyle.Flat, Visible = false };
        retry.Click += async delegate { await RetryAsync(); };
        install.Click += delegate { OpenBrowser(DesktopWebPolicy.RuntimeDownload, true); };
        actions.Controls.Add(retry); actions.Controls.Add(install);
        stack.Controls.Add(brand, 0, 1); stack.Controls.Add(status, 0, 2); stack.Controls.Add(actions, 0, 3);
        fallback.Controls.Add(stack); Controls.Add(fallback);
        Shown += async delegate { await EnsureViewAsync(); };
        FormClosed += delegate { SetMutation(false); };
    }

    internal void SetPetPreferences(DesktopPetPreferences value)
    {
        if (preferences != null) preferences.Changed -= PreferencesChanged;
        preferences = value;
        if (preferences != null) preferences.Changed += PreferencesChanged;
        SendPets();
    }
    private void PreferencesChanged(object sender, EventArgs args) { SendPets(); }
    internal void RestoreQuotaSelection(string account, string quota) { selectedAccount = account; selectedQuota = quota; SendState(); }
    internal void SetServiceRecovery(bool available, bool busy)
    {
        recoveryAvailable = available; recovering = busy;
        retry.Text = busy ? "正在恢复…" : available ? "重启本机服务" : "重新连接";
        retry.Enabled = !busy; SendState();
    }
    internal void SetService(DesktopInstance value, string unavailable)
    {
        if (disposed) return;
        bool changed = value == null ? service != null : !value.SameAs(service);
        service = value; message = unavailable;
        if (value == null)
        {
            navigationGeneration++; documentService = null; pageReady = false; mutationOperation = null; SetMutation(false);
            if (initialized) { view.CoreWebView2.Stop(); view.CoreWebView2.Navigate("about:blank"); }
            ShowFallback(unavailable ?? "本机服务已断开。请重新连接。");
        }
        else if (initialized && (changed || documentService == null)) NavigateVerifiedAsync();
        else SendState();
    }

    private void ShowFallback(string text)
    {
        if (disposed) return;
        status.Text = text;
        if (view != null) view.Visible = false;
        fallback.Visible = true; fallback.BringToFront();
    }
    private async Task RetryAsync()
    {
        if (disposed || recovering) return;
        retry.Enabled = false;
        try
        {
            if (!initialized) await EnsureViewAsync();
            if (reconnect != null) await reconnect();
            if (initialized && service != null && documentService == null) NavigateVerifiedAsync();
        }
        catch (Exception error) { ShowFallback(NativeData.Error(error)); }
        finally { if (!disposed) retry.Enabled = !recovering; }
    }
    private async Task EnsureViewAsync()
    {
        if (disposed || initialized || initializing) return;
        initializing = true;
        try
        {
            CoreWebView2Environment.GetAvailableBrowserVersionString();
            install.Visible = false;
            if (view != null) { view.Dispose(); view = null; }
            var created = new WebView2 { Dock = DockStyle.Fill, Visible = false, DefaultBackgroundColor = BackColor };
            view = created; Controls.Add(created);
            var options = new CoreWebView2EnvironmentOptions("--disable-background-networking --disable-component-update");
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(directory, "webview2"), options);
            if (disposed) { created.Dispose(); return; }
            await created.EnsureCoreWebView2Async(environment);
            if (disposed) return;
            var core = created.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false; core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDefaultScriptDialogsEnabled = false; core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsStatusBarEnabled = false; core.Settings.IsZoomControlEnabled = false;
            core.Settings.IsBuiltInErrorPageEnabled = false; core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false; core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs args) { args.State = CoreWebView2PermissionState.Deny; args.Handled = true; };
            core.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs args) { args.Cancel = true; args.Handled = true; };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args) { args.Handled = true; if (args.IsUserInitiated) OpenBrowser(args.Uri, false); };
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) {
                if (args.Uri == "about:blank" && documentService == null) return;
                if (DesktopWebPolicy.Document(documentService, args.Uri)) return;
                args.Cancel = true; if (args.IsUserInitiated) OpenBrowser(args.Uri, false);
            };
            core.FrameNavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) { args.Cancel = true; };
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += delegate(object sender, CoreWebView2WebResourceRequestedEventArgs args) {
                if (!DesktopWebPolicy.Request(documentService, args.Request.Uri, args.Request.Method))
                { args.Response = environment.CreateWebResourceResponse(null, 403, "Blocked", "Content-Type: text/plain"); return; }
                args.Request.Headers.SetHeader("x-pilotmeter-instance", documentService.InstanceId);
            };
            core.WebMessageReceived += MessageReceived;
            core.ProcessFailed += delegate { navigationGeneration++; documentService = null; initialized = false; pageReady = false; mutationOperation = null; SetMutation(false); ShowFallback("应用界面暂时中断，请点击重新连接。"); };
            core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs args) {
                if (documentService == null) return;
                if (!args.IsSuccess) { documentService = null; pageReady = false; ShowFallback("主界面加载失败，请检查本机服务后重新连接。"); return; }
            };
            initialized = true;
            if (service != null) NavigateVerifiedAsync();
        }
        catch (WebView2RuntimeNotFoundException)
        { install.Visible = true; ShowFallback("主程序需要 Microsoft Edge WebView2 运行时。点击下方按钮打开微软官方下载页面，安装 Evergreen x64 后点击重新连接。桌面宠物仍可使用。"); }
        catch (Exception error)
        { ShowFallback("应用界面未能启动。" + NativeData.Error(error)); }
        finally { initializing = false; if (!initialized && view != null) { view.Dispose(); view = null; } }
    }

    private async void NavigateVerifiedAsync()
    {
        var expected = service; int generation = ++navigationGeneration;
        if (!initialized || expected == null || disposed) return;
        pageReady = false; ShowFallback("正在准备你的工作台…");
        try
        {
            using (var api = new DesktopNativeApi(expected)) await api.RequestAsync("/api/auth/accounts");
            if (disposed || generation != navigationGeneration || !expected.SameAs(service)) return;
            documentService = expected;
            view.CoreWebView2.Navigate(new Uri(expected.Origin, "desktop.html").AbsoluteUri);
        }
        catch (Exception error)
        { if (!disposed && generation == navigationGeneration) { documentService = null; ShowFallback(NativeData.Error(error)); } }
    }

    private void Send(Dictionary<string, object> content)
    {
        if (!pageReady || disposed || !initialized || documentService == null) return;
        view.CoreWebView2.PostWebMessageAsJson(new JavaScriptSerializer().Serialize(content));
    }
    private void SendState()
    {
        Send(new Dictionary<string, object> { { "type", "service-state" }, { "connected", service != null },
            { "epoch", navigationGeneration },
            { "sessionLaunchAvailable", DesktopSessionLaunch.Available(runtimeRoot) },
            { "instanceId", service == null ? null : service.InstanceId }, { "version", service == null ? null : service.Version },
            { "recoverable", recoveryAvailable }, { "recovering", recovering }, { "message", message },
            { "accountId", selectedAccount }, { "quotaKey", selectedQuota } });
    }
    private void SendPets()
    {
        if (preferences == null) return;
        var pets = new List<Dictionary<string, object>>();
        foreach (var pet in DesktopPetCatalog.All) pets.Add(new Dictionary<string, object> { { "id", pet.Id }, { "name", pet.Name }, { "description", pet.Description } });
        Send(new Dictionary<string, object> { { "type", "pet-state" }, { "petId", preferences.PetId },
            { "sizePixels", preferences.SizePixels }, { "motionEnabled", preferences.MotionEnabled },
            { "alwaysOnTop", preferences.AlwaysOnTop }, { "pets", pets }, { "persistenceWarning", preferences.PersistenceWarning } });
    }
    private void SetMutation(bool pending)
    {
        if (AccountMutationPending == pending) return;
        AccountMutationPending = pending;
        if (pending) selectedAccount = selectedQuota = null;
        RaiseSelection();
    }
    private void RaiseSelection()
    {
        var handler = QuotaSelectionChanged;
        if (handler != null) handler(this, new NativeQuotaSelectionEventArgs(selectedAccount, selectedQuota));
    }
    private async void MessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (disposed || !DesktopWebPolicy.Document(documentService, args.Source)) return;
        try
        {
            var content = DesktopJson.Parse(args.WebMessageAsJson, 4096);
            var type = DesktopJson.String(content, "type", 40);
            if (type == "ready") { pageReady = true; fallback.Visible = false; view.Visible = true; view.BringToFront(); SendState(); SendPets(); return; }
            if (!pageReady) return;
            object epoch;
            if (!content.TryGetValue("epoch", out epoch) || !(epoch is int) || (int)epoch != navigationGeneration) return;
            if (type == "start-session")
            {
                var requestId = DesktopJson.String(content, "requestId", 80);
                var accountId = DesktopJson.String(content, "accountId", 36);
                // No arbitrary executable, path, argument or command can cross
                // this bridge, even as an ignored extra property.
                if (!DesktopSessionLaunch.RequestId(requestId)) return;
                if (content.Count != 4 || !DesktopWebPolicy.Account(accountId))
                { SendSessionResult(requestId, (int)epoch, new DesktopSessionResult("error", "启动参数无效，请刷新后重试。")); return; }
                await StartSessionAsync(requestId, accountId, (int)epoch); return;
            }
            if (type == "open-external")
            {
                var loginId = DesktopJson.OptionalString(content, "loginId", 36);
                if (loginId == null) OpenBrowser(DesktopJson.String(content, "url", 1024), false);
                else if (DesktopWebPolicy.Account(loginId)) await OpenLoginAsync(loginId);
                return;
            }
            if (type == "restart-service") { await RetryAsync(); return; }
            if (type == "account-mutation")
            {
                object pending; var operation = DesktopJson.String(content, "operationId", 80);
                if (!Regex.IsMatch(operation, @"^[A-Za-z0-9_-]{1,80}$") || !content.TryGetValue("pending", out pending) || !(pending is bool)) return;
                if ((bool)pending) { if (mutationOperation != null && mutationOperation != operation) return; mutationOperation = operation; SetMutation(true); }
                else { if (mutationOperation != operation) return; mutationOperation = null; SetMutation(false); }
                Send(new Dictionary<string, object> { { "type", "account-mutation-state" }, { "operationId", operation }, { "pending", pending }, { "epoch", navigationGeneration } });
                return;
            }
            if (type == "quota-selection")
            {
                var account = DesktopJson.OptionalString(content, "accountId", 36); var quota = DesktopJson.OptionalString(content, "key", 64);
                if (!DesktopWebPolicy.Account(account) || !DesktopWebPolicy.Quota(quota) || account == null && quota != null) return;
                selectedAccount = account; selectedQuota = quota; RaiseSelection(); return;
            }
            if (type == "pet-update" && preferences != null)
            {
                object value;
                // Validate the whole message before applying any part.
                if (content.TryGetValue("petId", out value) && (!(value is string) || DesktopPetCatalog.Find((string)value) == null)) return;
                if (content.TryGetValue("sizePixels", out value) && (!(value is int) || (int)value < 64 || (int)value > 160)) return;
                if (content.TryGetValue("motionEnabled", out value) && !(value is bool)) return;
                if (content.TryGetValue("alwaysOnTop", out value) && !(value is bool)) return;
                if (content.TryGetValue("petId", out value)) preferences.SelectPet((string)value);
                if (content.TryGetValue("sizePixels", out value)) preferences.SetSize((int)value);
                if (content.TryGetValue("motionEnabled", out value)) preferences.SetMotion((bool)value);
                if (content.TryGetValue("alwaysOnTop", out value)) preferences.SetAlwaysOnTop((bool)value);
                SendPets();
            }
        }
        catch (Exception error)
        { if (error is OutOfMemoryException || error is StackOverflowException) throw; SendError("操作未完成，请重试。" + NativeData.Error(error)); }
    }
    private bool SessionCurrent(DesktopInstance expected, int epoch)
    {
        return !disposed && pageReady && initialized && epoch == navigationGeneration && !AccountMutationPending && !recovering
            && expected != null && expected.SameAs(service) && expected.SameAs(documentService);
    }
    private async Task StartSessionAsync(string requestId, string accountId, int epoch)
    {
        if (!DesktopSessionLaunch.Available(runtimeRoot))
        { SendSessionResult(requestId, epoch, new DesktopSessionResult("error", "当前窗口不支持启动会话，请使用完整的 Windows EXE。")); return; }
        var expected = documentService;
        using (var api = new DesktopNativeApi(expected))
        {
            var result = await sessionStarter.StartAsync(accountId, delegate { return SessionCurrent(expected, epoch); },
                delegate { return api.RequestAsync("/api/auth/accounts"); },
                delegate {
                    using (var picker = new FolderBrowserDialog { Description = "选择 Copilot 会话的项目目录。接下来会打开当前 GitHub 账号的 Copilot 终端，并采集实际请求的用量。", ShowNewFolderButton = false })
                        return picker.ShowDialog(this) == DialogResult.OK ? picker.SelectedPath : null;
                },
                delegate(string pinnedAccount, string project) { LaunchSessionProcess(pinnedAccount, project, expected, epoch); });
            // A replaced document must never receive the old operation's result.
            if (!disposed && epoch == navigationGeneration && expected != null && expected.SameAs(documentService))
                SendSessionResult(requestId, epoch, result);
        }
    }
    private void LaunchSessionProcess(string accountId, string project, DesktopInstance expected, int epoch)
    {
        var child = new Process { StartInfo = DesktopSessionLaunch.StartInfo(runtimeRoot, directory, accountId, project), EnableRaisingEvents = true };
        child.Exited += delegate {
            int exitCode;
            try { exitCode = child.ExitCode; } catch (InvalidOperationException) { exitCode = -1; }
            child.Dispose();
            // Console processes can fail before users have time to read them.
            // Surface a safe actionable message in the workbench as well.
            if (DesktopSessionLaunch.ExpectedExit(exitCode) || disposed || !IsHandleCreated) return;
            try { BeginInvoke((Action)delegate {
                if (!disposed && epoch == navigationGeneration && expected.SameAs(documentService))
                    Send(DesktopSessionLaunch.ExitMessage(accountId, epoch, exitCode));
            }); }
            catch (InvalidOperationException) { }
        };
        try { if (!child.Start()) throw new IOException("Copilot 终端未能打开，请重试。"); }
        catch { child.Dispose(); throw; }
    }
    private void SendSessionResult(string requestId, int epoch, DesktopSessionResult result)
    {
        Send(new Dictionary<string, object> { { "type", "session-start-result" }, { "requestId", requestId },
            { "epoch", epoch }, { "status", result.Status }, { "message", result.Message } });
    }
    private async Task OpenLoginAsync(string id)
    {
        var expected = documentService; var generation = navigationGeneration;
        if (expected == null) return;
        using (var api = new DesktopNativeApi(expected))
        {
            var login = NativeLogin.Read(await api.RequestAsync("/api/auth/login/" + id));
            if (disposed || generation != navigationGeneration || !expected.SameAs(documentService)) return;
            if (login == null || !login.Active) { SendError("这次登录已经结束，请重新获取验证码。"); return; }
            var expires = NativeData.Date(login.ExpiresAt);
            if (!expires.HasValue || expires.Value <= DateTimeOffset.UtcNow) { SendError("验证码已过期，请重新获取后再打开 GitHub。"); return; }
            var target = NativeData.DevicePage(login.Host, login.VerificationUri);
            if (target == null || !DesktopLinks.IsDeviceLogin(target)) { SendError("登录地址尚未准备好，请稍后重试。"); return; }
            try { Process.Start(new ProcessStartInfo { FileName = target, UseShellExecute = true }); }
            catch (Exception error) { if (error is OutOfMemoryException || error is StackOverflowException) throw; SendError("未能打开浏览器，请检查系统默认浏览器后重试。"); }
        }
    }
    private void SendError(string text) { Send(new Dictionary<string, object> { { "type", "host-error" }, { "message", text } }); }
    private void OpenBrowser(string target, bool runtime)
    {
        if (!(runtime && target == DesktopWebPolicy.RuntimeDownload) && !DesktopWebPolicy.External(target)) return;
        try { Process.Start(new ProcessStartInfo { FileName = target, UseShellExecute = true }); }
        catch (Exception error) { if (error is OutOfMemoryException || error is StackOverflowException) throw; ShowFallback("未能打开浏览器，请检查系统默认浏览器后重试。"); }
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing && !disposed)
        {
            SetMutation(false); disposed = true; navigationGeneration++;
            if (preferences != null) preferences.Changed -= PreferencesChanged;
        }
        base.Dispose(disposing);
    }
}
