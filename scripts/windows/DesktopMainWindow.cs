using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class NativeData
{
    internal static Dictionary<string, object> Map(Dictionary<string, object> source, string key)
    {
        object value;
        return source != null && source.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
    }

    internal static string Text(Dictionary<string, object> source, string key, int limit, bool optional = false)
    {
        if (source == null) { if (optional) return null; throw new InvalidDataException("账号信息暂时无法读取。"); }
        return optional ? DesktopJson.OptionalString(source, key, limit) : DesktopJson.String(source, key, limit);
    }

    internal static bool Flag(Dictionary<string, object> source, string key)
    {
        object value;
        return source != null && source.TryGetValue(key, out value) && value is bool && (bool)value;
    }

    internal static List<Dictionary<string, object>> Rows(Dictionary<string, object> source, string key, int maximum)
    {
        object raw;
        if (source == null || !source.TryGetValue(key, out raw) || !(raw is IList)) throw new InvalidDataException("账号信息暂时无法读取。");
        var items = (IList)raw;
        if (items.Count > maximum) throw new InvalidDataException("账号信息数量异常。");
        var result = new List<Dictionary<string, object>>();
        foreach (var item in items)
        {
            var row = item as Dictionary<string, object>;
            if (row == null) throw new InvalidDataException("账号信息暂时无法读取。");
            result.Add(row);
        }
        return result;
    }

    internal static string Identifier(Dictionary<string, object> source, string key, bool optional = false)
    {
        var value = Text(source, key, 36, optional);
        if (value == null && optional) return null;
        if (!Regex.IsMatch(value ?? "", @"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"))
            throw new InvalidDataException("账号标识无效，请刷新。");
        return value;
    }

    internal static string Clean(string value, int limit)
    {
        if (String.IsNullOrEmpty(value)) return String.Empty;
        var text = Regex.Replace(value, @"[\p{Cc}\p{Cf}]", " ").Trim();
        return text.Length <= limit ? text : text.Substring(0, limit) + "…";
    }

    internal static string Error(Exception error)
    {
        if (error is OperationCanceledException || error is ObjectDisposedException) return "连接已中断，请重试。";
        return Clean(error.Message, 180);
    }

    internal static DateTimeOffset? Date(string value)
    {
        DateTimeOffset date;
        return !String.IsNullOrEmpty(value) && DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out date) ? date : (DateTimeOffset?)null;
    }

    internal static string Host(string input)
    {
        if (String.IsNullOrWhiteSpace(input)) return null;
        var value = input.Trim();
        if (!value.Contains("://")) value = "https://" + value;
        Uri url;
        if (!Uri.TryCreate(value, UriKind.Absolute, out url) || url.Scheme != "https" || !url.IsDefaultPort
            || !String.IsNullOrEmpty(url.UserInfo) || !String.IsNullOrEmpty(url.Query) || !String.IsNullOrEmpty(url.Fragment)
            || url.AbsolutePath != "/" || !Regex.IsMatch(url.Host, @"^(?:github\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com)$", RegexOptions.IgnoreCase)) return null;
        return url.GetLeftPart(UriPartial.Authority);
    }

    internal static string DevicePage(string host, string target)
    {
        var official = Host(host);
        Uri url;
        if (official == null || !Uri.TryCreate(target, UriKind.Absolute, out url) || url.Scheme != "https" || !url.IsDefaultPort
            || !String.IsNullOrEmpty(url.UserInfo) || !String.IsNullOrEmpty(url.Query) || !String.IsNullOrEmpty(url.Fragment)
            || url.AbsolutePath != "/login/device" || url.GetLeftPart(UriPartial.Authority) != official) return null;
        return url.AbsoluteUri;
    }
}

internal sealed class NativeAccount
{
    internal string Id, Login, Host, Status;
    public override string ToString() { return Id == null ? "选择 GitHub 账号…" : Login + "  ·  " + new Uri(Host).Host; }
}

internal sealed class NativeBucket
{
    internal string Key, Label, Value, Detail, NextResetAt, Unit, UnitLabel;
    internal double? Percentage;
    internal bool Unlimited;
    public override string ToString() { return Label; }

    internal static NativeBucket Read(Dictionary<string, object> source)
    {
        var result = new NativeBucket {
            Key = NativeData.Text(source, "key", 160), Label = NativeData.Clean(NativeData.Text(source, "label", 160), 80),
            Value = NativeData.Clean(NativeData.Text(source, "value", 160), 100), Detail = NativeData.Clean(NativeData.Text(source, "detail", 600), 300),
            NextResetAt = NativeData.Text(source, "nextResetAt", 80, true),
            Unit = NativeData.Text(source, "unit", 32), UnitLabel = NativeData.Clean(NativeData.Text(source, "unitLabel", 80), 80), Unlimited = NativeData.Flag(source, "unlimited")
        };
        if (result.Unit != "ai-credits" && result.Unit != "premium-requests" && result.Unit != "unspecified") throw new InvalidDataException("额度单位无效。");
        object percentage;
        if (source.TryGetValue("percentage", out percentage) && percentage != null)
        {
            if (!(percentage is int) && !(percentage is long) && !(percentage is decimal) && !(percentage is double)) throw new InvalidDataException("额度比例无效。");
            var number = Convert.ToDouble(percentage, CultureInfo.InvariantCulture);
            if (Double.IsNaN(number) || Double.IsInfinity(number) || number < 0 || number > 100) throw new InvalidDataException("额度比例无效。");
            result.Percentage = number;
        }
        return result;
    }
}

internal sealed class NativeLogin
{
    internal string Id, Host, Status, UserCode, VerificationUri, ExpiresAt, Error;
    internal bool Active { get { return Status == "starting" || Status == "pending" || Status == "verifying"; } }

    internal static NativeLogin Read(Dictionary<string, object> source)
    {
        if (source == null) return null;
        var result = new NativeLogin {
            Id = NativeData.Identifier(source, "id"), Host = NativeData.Text(source, "host", 256),
            Status = NativeData.Text(source, "status", 24), UserCode = NativeData.Text(source, "userCode", 40, true),
            VerificationUri = NativeData.Text(source, "verificationUri", 512, true), ExpiresAt = NativeData.Text(source, "expiresAt", 80, true),
            Error = NativeData.Text(NativeData.Map(source, "error"), "message", 600, true)
        };
        if (NativeData.Host(result.Host) != result.Host || !new HashSet<string>(new[] { "starting", "pending", "verifying", "complete", "cancelled", "failed", "expired" }).Contains(result.Status))
            throw new InvalidDataException("登录信息无效，请重试。");
        if (result.UserCode != null && !Regex.IsMatch(result.UserCode, @"^[A-Z0-9-]{4,32}$")) throw new InvalidDataException("登录验证码无效，请重试。");
        return result;
    }
}

internal sealed class NativeOverview
{
    internal readonly List<NativeAccount> Accounts = new List<NativeAccount>();
    internal readonly List<NativeBucket> Buckets = new List<NativeBucket>();
    internal string ActiveId, Selection, FetchedAt, QuotaError;
    internal bool Enabled, Refreshing, Stale, QuotaAvailable;
    internal NativeBucket Primary;
    internal NativeLogin Login;
    internal NativeAccount Active { get { return Accounts.Find(delegate(NativeAccount account) { return account.Id == ActiveId; }); } }
    internal bool CanDisplayQuota { get { return Active != null && Active.Status == "connected" && QuotaAvailable && !Stale; } }

    internal static NativeOverview Read(Dictionary<string, object> source, DesktopInstance expected)
    {
        if (!expected.Matches(source)) throw new InvalidDataException("本机服务已更换，请重试。");
        var result = new NativeOverview {
            ActiveId = NativeData.Identifier(source, "activeAccountId", true), Enabled = NativeData.Flag(source, "enabled"),
            Refreshing = NativeData.Flag(source, "refreshing"), Login = NativeLogin.Read(NativeData.Map(source, "login"))
        };
        var ids = new HashSet<string>();
        foreach (var item in NativeData.Rows(source, "accounts", 20))
        {
            var account = new NativeAccount {
                Id = NativeData.Identifier(item, "id"), Login = NativeData.Clean(NativeData.Text(item, "login", 128), 128),
                Host = NativeData.Text(item, "host", 256), Status = NativeData.Text(item, "status", 32)
            };
            if (!ids.Add(account.Id) || NativeData.Host(account.Host) != account.Host || !new HashSet<string>(new[] { "connected", "reauth-required", "error" }).Contains(account.Status))
                throw new InvalidDataException("账号列表无效，请重试。");
            result.Accounts.Add(account);
        }
        if (result.ActiveId != null && result.Active == null) throw new InvalidDataException("当前账号已更换，请刷新。");
        var quota = NativeData.Map(source, "quota");
        if (quota != null)
        {
            // /api/desktop already validates signed-in-user scope before
            // projecting it. Its small metadata DTO intentionally omits scope.
            if (NativeData.Identifier(quota, "accountId") != result.ActiveId)
                throw new InvalidDataException("额度与当前账号不一致，请刷新。");
            result.QuotaAvailable = NativeData.Text(quota, "state", 32) == "available";
            result.QuotaError = NativeData.Text(NativeData.Map(quota, "error"), "message", 600, true);
        }
        var presentation = NativeData.Map(source, "presentation");
        result.Selection = NativeData.Text(presentation, "selection", 32);
        if (!new HashSet<string>(new[] { "premium", "single-finite", "explicit", "required", "none" }).Contains(result.Selection))
            throw new InvalidDataException("额度类别暂时无法读取。");
        result.FetchedAt = NativeData.Text(presentation, "fetchedAt", 80, true);
        result.Stale = NativeData.Flag(presentation, "stale") || NativeData.Flag(quota, "stale");
        foreach (var bucket in NativeData.Rows(presentation, "buckets", 64)) result.Buckets.Add(NativeBucket.Read(bucket));
        var primary = NativeData.Map(presentation, "primary");
        if (primary != null)
        {
            result.Primary = NativeBucket.Read(primary);
            if (!result.Buckets.Exists(delegate(NativeBucket bucket) { return bucket.Key == result.Primary.Key; })) throw new InvalidDataException("额度类别已更换，请刷新。");
        }
        return result;
    }
}

internal abstract class NativeForm : Form
{
    protected static readonly Color Ink = Color.FromArgb(32, 44, 60);
    protected static readonly Color Muted = Color.FromArgb(101, 116, 133);
    protected static readonly Color Accent = Color.FromArgb(30, 111, 171);
    private readonly List<Font> fonts = new List<Font>();

    protected NativeForm()
    {
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96, 96);
        Font = Typeface(9.5F, FontStyle.Regular);
        ForeColor = Ink;
        BackColor = Color.FromArgb(244, 247, 250);
        ShowInTaskbar = true;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
    }

    protected Font Typeface(float size, FontStyle style)
    {
        var font = new Font("Microsoft YaHei UI", size, style);
        fonts.Add(font);
        return font;
    }

    protected static Label LabelFor(string value, Color color)
    {
        return new Label { Text = value, ForeColor = color, Dock = DockStyle.Fill, AutoEllipsis = true, UseMnemonic = false, TextAlign = ContentAlignment.MiddleLeft, Margin = Padding.Empty };
    }

    protected static Button ButtonFor(string value)
    {
        var button = new Button { Text = value, AutoSize = false, Dock = DockStyle.Fill, FlatStyle = FlatStyle.Flat, BackColor = Color.White, Cursor = Cursors.Hand, Margin = Padding.Empty, UseVisualStyleBackColor = false };
        button.FlatAppearance.BorderColor = Color.FromArgb(206, 215, 225);
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(234, 241, 247);
        return button;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing) { foreach (var font in fonts) font.Dispose(); fonts.Clear(); }
    }
}

internal sealed class DashboardWindow : NativeForm
{
    private readonly Func<Task> retry;
    private readonly ComboBox accounts, bucketChoice;
    private readonly Button add, accountMenu, refresh;
    private readonly ContextMenuStrip menu;
    private readonly ToolStripMenuItem reauthenticate, remove;
    private readonly Label accountStatus, category, value, detail, reset, synced, feedback;
    private readonly ProgressBar progress;
    private readonly LinkLabel other;
    private readonly Panel otherPanel;
    private readonly Label otherText;
    private readonly System.Windows.Forms.Timer timer;
    private DesktopInstance service;
    private DesktopNativeApi api;
    private NativeOverview overview;
    private NativeLoginDialog loginDialog;
    private string quotaKey, quotaAccount;
    private string accountSignature;
    private int generation;
    private bool suppress, loading, busy, expanded, disposed;
    private DateTime nextRefresh = DateTime.MinValue;

    internal DashboardWindow(string directory, Func<Task> retry)
    {
        this.retry = retry;
        Text = "PilotMeter";
        Name = "PilotMeterMainWindow";
        ClientSize = new Size(664, 521);
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), RowCount = 7, ColumnCount = 1, Margin = Padding.Empty };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 55));
        var heading = LabelFor("PilotMeter", Ink); heading.Font = Typeface(17F, FontStyle.Bold); root.Controls.Add(heading, 0, 0);
        var accountRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 5, Margin = Padding.Empty };
        accountRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        accountRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 10));
        accountRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 96));
        accountRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 8));
        accountRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 38));
        accounts = new ComboBox { Name = "AccountSelector", AccessibleName = "GitHub 账号", Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList, IntegralHeight = false, DropDownHeight = 220, Margin = new Padding(0, 4, 0, 0) };
        add = ButtonFor("添加账号"); add.Name = "AddAccount";
        accountMenu = ButtonFor("···"); accountMenu.AccessibleName = "账号设置";
        accountRow.Controls.Add(accounts, 0, 0); accountRow.Controls.Add(add, 2, 0); accountRow.Controls.Add(accountMenu, 4, 0);
        root.Controls.Add(accountRow, 0, 1);
        accountStatus = LabelFor("正在连接…", Muted); root.Controls.Add(accountStatus, 0, 2);
        var card = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Color.White, Padding = new Padding(22, 18, 22, 14), ColumnCount = 1, RowCount = 6, Margin = Padding.Empty };
        card.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        card.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        card.RowStyles.Add(new RowStyle(SizeType.Absolute, 10));
        card.RowStyles.Add(new RowStyle(SizeType.Absolute, 13));
        card.RowStyles.Add(new RowStyle(SizeType.Absolute, 43));
        card.RowStyles.Add(new RowStyle(SizeType.Absolute, 23));
        category = LabelFor("Copilot 额度", Muted); category.Font = Typeface(10F, FontStyle.Bold);
        value = LabelFor("—", Ink); value.Name = "QuotaValue"; value.Font = Typeface(34F, FontStyle.Bold);
        progress = new ProgressBar { Name = "QuotaProgress", AccessibleName = "当前类别已用额度", Dock = DockStyle.Fill, Minimum = 0, Maximum = 1000, Style = ProgressBarStyle.Continuous, Margin = Padding.Empty, Visible = false };
        detail = LabelFor("登录后查看当前账号的额度。", Muted);
        reset = LabelFor("", Muted); reset.Font = Typeface(8.5F, FontStyle.Regular);
        card.Controls.Add(category, 0, 0); card.Controls.Add(value, 0, 1); card.Controls.Add(progress, 0, 2); card.Controls.Add(detail, 0, 4); card.Controls.Add(reset, 0, 5);
        root.Controls.Add(card, 0, 3);
        other = new LinkLabel { Text = "其他额度 ▸", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, LinkColor = Accent, ActiveLinkColor = Accent, Margin = Padding.Empty, Visible = false };
        root.Controls.Add(other, 0, 4);
        otherPanel = new Panel { Dock = DockStyle.Fill, Height = 116, Visible = false, Margin = Padding.Empty };
        bucketChoice = new ComboBox { Name = "QuotaCategorySelector", AccessibleName = "选择额度类别", DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Top, IntegralHeight = false, DropDownHeight = 180 };
        otherText = LabelFor("", Muted); otherText.Dock = DockStyle.Fill; otherText.TextAlign = ContentAlignment.TopLeft; otherText.Padding = new Padding(0, 8, 0, 0);
        otherPanel.Controls.Add(otherText); otherPanel.Controls.Add(bucketChoice);
        root.Controls.Add(otherPanel, 0, 5);
        var footer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 2, Margin = Padding.Empty, Padding = new Padding(0, 12, 0, 0) };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 12)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 94));
        footer.RowStyles.Add(new RowStyle(SizeType.Absolute, 20)); footer.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        synced = LabelFor("尚未同步", Muted); synced.Font = Typeface(8.5F, FontStyle.Regular);
        feedback = LabelFor("", Muted); feedback.Font = Typeface(8.5F, FontStyle.Regular);
        refresh = ButtonFor("刷新"); refresh.Name = "RefreshQuota"; footer.SetRowSpan(refresh, 2);
        footer.Controls.Add(synced, 0, 0); footer.Controls.Add(feedback, 0, 1); footer.Controls.Add(refresh, 2, 0); root.Controls.Add(footer, 0, 6);
        Controls.Add(root);
        menu = new ContextMenuStrip();
        reauthenticate = new ToolStripMenuItem("重新登录当前账号", null, delegate { OpenLogin(true); });
        remove = new ToolStripMenuItem("移除当前账号…", null, async delegate { await RemoveAsync(); });
        menu.Items.Add(reauthenticate); menu.Items.Add(remove);
        accountMenu.Click += delegate { menu.Show(accountMenu, new Point(0, accountMenu.Height)); };
        add.Click += delegate { OpenLogin(false); };
        accounts.SelectedIndexChanged += async delegate {
            if (suppress || busy || overview == null) return;
            var selected = accounts.SelectedItem as NativeAccount;
            if (selected == null || selected.Id == overview.ActiveId) return;
            quotaKey = quotaAccount = null;
            await ChangeAsync("/api/auth/select", "POST", new Dictionary<string, object> { { "accountId", selected.Id } }, "正在切换账号…");
        };
        bucketChoice.SelectedIndexChanged += async delegate {
            if (suppress || busy || overview == null) return;
            var selected = bucketChoice.SelectedItem as NativeBucket;
            if (selected == null || selected.Key == quotaKey) return;
            quotaKey = selected.Key; quotaAccount = overview.ActiveId; generation++; loading = false; ClearQuota("正在读取此类别…");
            await LoadAsync(false);
        };
        other.LinkClicked += delegate { ExpandOther(!expanded); };
        refresh.Click += async delegate {
            if (busy || loading) return;
            if (api == null) { await retry(); if (api != null) await LoadAsync(true); }
            else if (overview == null) await LoadAsync(true);
            else await ChangeAsync("/api/auth/refresh", "POST", null, "正在同步额度…");
        };
        timer = new System.Windows.Forms.Timer { Interval = 5000 };
        timer.Tick += async delegate { await LoadAsync(true); };
        Shown += async delegate { UpdatePolling(); await LoadAsync(true); };
        VisibleChanged += delegate { UpdatePolling(); };
        Resize += delegate { UpdatePolling(); };
        UpdateControls();
    }

    private bool CanRead { get { return !disposed && Visible && WindowState != FormWindowState.Minimized && api != null && loginDialog == null; } }

    private void UpdatePolling()
    {
        if (timer == null) return;
        if (CanRead) timer.Start(); else timer.Stop();
    }

    internal void SetService(DesktopInstance instance, string explanation)
    {
        if (disposed || instance != null && instance.SameAs(service) && api != null) return;
        generation++; loading = busy = false;
        if (loginDialog != null) loginDialog.Disconnect();
        if (api != null) api.Dispose();
        api = null; service = instance; overview = null; quotaKey = quotaAccount = null; accountSignature = null;
        suppress = true; accounts.Items.Clear(); suppress = false;
        ClearQuota(instance == null ? explanation ?? "本机服务未连接。" : "正在读取当前账号…");
        accountStatus.Text = instance == null ? "未连接" : "正在连接…";
        synced.Text = "尚未同步"; feedback.Text = "";
        ExpandOther(false); other.Visible = false;
        nextRefresh = DateTime.MinValue;
        if (instance != null) api = new DesktopNativeApi(instance);
        UpdateControls(); UpdatePolling();
        if (CanRead) BeginInvoke(new Action(async delegate { await LoadAsync(true); }));
    }

    private void ClearQuota(string description)
    {
        category.Text = "Copilot 额度"; value.Text = "—"; value.ForeColor = Ink;
        progress.Visible = false; progress.Value = 0; detail.Text = NativeData.Clean(description, 220); reset.Text = "";
        otherText.Text = ""; suppress = true; bucketChoice.Items.Clear(); suppress = false;
    }

    private void UpdateControls()
    {
        if (disposed) return;
        var ready = api != null && overview != null && overview.Enabled && !busy && loginDialog == null;
        accounts.Enabled = ready && overview.Accounts.Count > 0;
        add.Enabled = ready;
        add.Text = overview != null && overview.Login != null && overview.Login.Active ? "继续登录" : overview != null && overview.Accounts.Count == 0 ? "登录 GitHub" : "添加账号";
        var selected = ready && overview.Active != null;
        accountMenu.Enabled = selected;
        reauthenticate.Enabled = selected && !(overview.Login != null && overview.Login.Active);
        remove.Enabled = selected;
        refresh.Enabled = !busy && !loading && loginDialog == null;
        refresh.Text = api == null ? "重试连接" : busy ? "同步中…" : "刷新";
        bucketChoice.Enabled = !busy && !loading;
    }

    private async Task<NativeOverview> ReadOverviewAsync(DesktopNativeApi client, DesktopInstance identity, int current)
    {
        var key = quotaKey;
        var result = NativeOverview.Read(await client.RequestAsync("/api/desktop" + (key == null ? "" : "?quotaKey=" + Uri.EscapeDataString(key))), identity);
        if (current != generation || disposed) return null;
        if (key != null && result.ActiveId != quotaAccount)
        {
            quotaKey = quotaAccount = null;
            result = NativeOverview.Read(await client.RequestAsync("/api/desktop"), identity);
        }
        return current == generation && !disposed ? result : null;
    }

    private async Task LoadAsync(bool autoRefresh)
    {
        if (!CanRead || loading || busy) return;
        var current = generation; var client = api; var identity = service;
        loading = true;
        bool refreshDue = false;
        try
        {
            var result = await ReadOverviewAsync(client, identity, current);
            if (result == null) return;
            ApplyOverview(result);
            refreshDue = autoRefresh && result.Enabled && result.Active != null && !result.Refreshing && DateTime.UtcNow >= nextRefresh;
        }
        catch (Exception error)
        {
            if (current != generation || disposed) return;
            overview = null; ClearQuota("暂时无法读取当前账号。请刷新重试。"); other.Visible = false; ExpandOther(false); feedback.Text = NativeData.Error(error);
        }
        finally { if (current == generation && !disposed) { loading = false; UpdateControls(); } }
        if (refreshDue && current == generation && CanRead) await ChangeAsync("/api/auth/refresh", "POST", null, "正在同步额度…");
    }

    private async Task ChangeAsync(string path, string method, Dictionary<string, object> payload, string description)
    {
        if (api == null || busy || disposed || loginDialog != null) return;
        var current = ++generation; var client = api; var identity = service;
        busy = true; loading = false; nextRefresh = DateTime.UtcNow.AddMinutes(1);
        if (path != "/api/auth/refresh" || overview == null || !overview.CanDisplayQuota) ClearQuota(description);
        feedback.Text = description; UpdateControls();
        try
        {
            await client.RequestAsync(path, method, payload);
            if (current != generation || disposed) return;
            var result = await ReadOverviewAsync(client, identity, current);
            if (result != null) { ApplyOverview(result); feedback.Text = result.Refreshing ? "正在同步…" : ""; }
        }
        catch (Exception error)
        {
            if (current == generation && !disposed) { overview = null; ClearQuota("操作未完成，请刷新重试。"); other.Visible = false; ExpandOther(false); feedback.Text = NativeData.Error(error); }
        }
        finally { if (current == generation && !disposed) { busy = false; UpdateControls(); } }
    }

    private void ApplyOverview(NativeOverview result)
    {
        overview = result;
        var signature = String.Join("|", result.Accounts.ConvertAll(delegate(NativeAccount account) { return account.Id + ":" + account.Login + ":" + account.Host; }).ToArray());
        suppress = true;
        if (accountSignature != signature)
        {
            accounts.Items.Clear(); accounts.Items.Add(new NativeAccount());
            foreach (var account in result.Accounts) accounts.Items.Add(account);
            accountSignature = signature;
        }
        accounts.SelectedIndex = 0;
        for (var index = 1; index < accounts.Items.Count; index++) if (((NativeAccount)accounts.Items[index]).Id == result.ActiveId) accounts.SelectedIndex = index;
        suppress = false;
        var selected = result.Active;
        accountStatus.Text = !result.Enabled ? "演示模式" : selected == null ? "连接你的个人或工作账号" : selected.Status == "reauth-required" ? "登录已失效 · 在账号设置中重新登录" : selected.Status == "error" ? "账号连接异常 · 请刷新或重新登录" : "已连接  ·  " + new Uri(selected.Host).Host;
        var fetched = NativeData.Date(result.FetchedAt);
        synced.Text = fetched.HasValue ? "上次同步  " + fetched.Value.ToLocalTime().ToString("M月d日 HH:mm", CultureInfo.GetCultureInfo("zh-CN")) : "尚未同步";
        feedback.Text = result.Refreshing ? "正在同步…" : result.Stale ? "等待最新额度" : "";
        if (selected == null) ClearQuota("登录或选择一个 GitHub 账号，查看 Copilot 额度。");
        else if (selected.Status == "reauth-required") ClearQuota("请重新登录当前账号。额度暂不可用。");
        else if (!result.CanDisplayQuota) ClearQuota(result.QuotaError ?? (result.Refreshing ? "正在同步当前账号的额度…" : "尚未取得当前额度，请刷新。"));
        else if (result.Primary == null) ClearQuota(result.Buckets.Count > 0 ? "请选择要查看的额度类别。不同类别分别计量。" : "GitHub 尚未返回此账号的额度。");
        else
        {
            var bucket = result.Primary;
            category.Text = (bucket.Label.Contains("额度") ? bucket.Label : bucket.Label + "额度") + " · 当前周期";
            value.Text = bucket.Value.Contains("%") ? "已用 " + bucket.Value : bucket.Value;
            value.ForeColor = Ink;
            detail.Text = !bucket.Unlimited && !bucket.Value.Contains("%") && bucket.Unit != "unspecified" ? bucket.UnitLabel : "";
            progress.Visible = bucket.Percentage.HasValue;
            progress.Value = bucket.Percentage.HasValue ? (int)Math.Round(bucket.Percentage.Value * 10) : 0;
            var resetDate = NativeData.Date(bucket.NextResetAt);
            reset.Text = resetDate.HasValue && fetched.HasValue && resetDate.Value > fetched.Value && resetDate.Value > DateTimeOffset.UtcNow
                ? "下次重置  " + resetDate.Value.ToLocalTime().ToString("M月d日 HH:mm", CultureInfo.GetCultureInfo("zh-CN")) : "";
        }
        var canChoose = result.CanDisplayQuota;
        other.Visible = canChoose && (result.Buckets.Count > 1 || result.Primary == null && result.Buckets.Count > 0);
        other.Text = (result.Primary == null ? "选择额度类别" : "其他额度") + (expanded ? " ▾" : " ▸");
        suppress = true; bucketChoice.Items.Clear();
        if (canChoose)
        {
            foreach (var bucket in result.Buckets) bucketChoice.Items.Add(bucket);
            bucketChoice.SelectedIndex = -1;
            for (var index = 0; index < bucketChoice.Items.Count; index++) if (result.Primary != null && ((NativeBucket)bucketChoice.Items[index]).Key == result.Primary.Key) bucketChoice.SelectedIndex = index;
            var lines = new List<string>();
            foreach (var bucket in result.Buckets) if (result.Primary == null || bucket.Key != result.Primary.Key) lines.Add(bucket.Label + "  ·  " + bucket.Value);
            if (result.Primary != null) lines.Add(result.Primary.Detail);
            otherText.Text = String.Join(Environment.NewLine, lines.ToArray());
        }
        suppress = false;
        if (!other.Visible) ExpandOther(false);
        else if (result.Primary == null) ExpandOther(true);
        UpdateControls();
    }

    private void ExpandOther(bool show)
    {
        if (expanded == show) return;
        expanded = show; otherPanel.Visible = show;
        ClientSize = new Size(ClientSize.Width, ClientSize.Height + (show ? otherPanel.Height : -otherPanel.Height));
        other.Text = (overview != null && overview.Primary == null ? "选择额度类别" : "其他额度") + (show ? " ▾" : " ▸");
    }

    private async Task RemoveAsync()
    {
        if (overview == null || overview.Active == null || busy) return;
        var account = overview.Active;
        if (MessageBox.Show(this, "移除 " + account.Login + " 的登录连接？\n本机用量记录会保留。", "移除账号", MessageBoxButtons.OKCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.OK) return;
        quotaKey = quotaAccount = null;
        await ChangeAsync("/api/auth/accounts/" + account.Id, "DELETE", null, "正在移除账号…");
    }

    private async void OpenLogin(bool reauth)
    {
        if (api == null || service == null || overview == null || !overview.Enabled || busy || loginDialog != null) return;
        var identity = service; var expected = reauth ? overview.Active : null;
        var pending = overview.Login != null && overview.Login.Active ? overview.Login : null;
        generation++; loading = false; timer.Stop();
        using (var dialog = new NativeLoginDialog(identity, expected, pending))
        {
            loginDialog = dialog; UpdateControls();
            dialog.ShowDialog(this);
            loginDialog = null;
            if (disposed) return;
            if (service == null || !service.SameAs(identity))
            {
                UpdateControls(); UpdatePolling();
                if (CanRead) await LoadAsync(true);
                return;
            }
            generation++; overview = null; quotaKey = quotaAccount = null; nextRefresh = DateTime.MinValue;
            ClearQuota(dialog.Succeeded ? "登录成功，正在读取额度…" : "正在读取当前账号…");
            await LoadAsync(true);
            if (!disposed && !String.IsNullOrEmpty(dialog.Feedback)) feedback.Text = dialog.Feedback;
        }
        UpdateControls(); UpdatePolling();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !disposed)
        {
            disposed = true; generation++;
            timer.Stop(); timer.Dispose(); menu.Dispose();
            if (loginDialog != null) loginDialog.Disconnect();
            if (api != null) api.Dispose();
        }
        base.Dispose(disposing);
    }
}

internal sealed class NativeLoginDialog : NativeForm
{
    private readonly DesktopNativeApi api;
    private readonly NativeAccount expected;
    private readonly TextBox host, code;
    private readonly Label status, expiry;
    private readonly Button start, copy, open, cancel;
    private readonly System.Windows.Forms.Timer timer;
    private NativeLogin login;
    private bool working, polling, closing, allowClose, disconnected, disposed, startUncertain, resumed;
    private int generation;
    internal bool Succeeded;
    internal string Feedback;

    internal NativeLoginDialog(DesktopInstance service, NativeAccount expected, NativeLogin pending)
    {
        api = new DesktopNativeApi(service); this.expected = expected; login = pending;
        Text = expected == null ? "登录 GitHub · PilotMeter" : "重新登录 · PilotMeter";
        Name = "PilotMeterLoginWindow";
        ClientSize = new Size(500, 410);
        ShowInTaskbar = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterParent;
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(26), ColumnCount = 1, RowCount = 9, Margin = Padding.Empty };
        foreach (var height in new[] { 34, 32, 38, 20, 59, 36, 30, 70, 37 }) root.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
        var title = LabelFor(expected == null ? "连接 GitHub 账号" : "重新登录 @" + expected.Login, Ink); title.Font = Typeface(15F, FontStyle.Bold);
        root.Controls.Add(title, 0, 0);
        root.Controls.Add(LabelFor("在 GitHub 授权页选择要连接的账号。", Muted), 0, 1);
        var hostRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, Margin = Padding.Empty };
        hostRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); hostRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 10)); hostRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 108));
        host = new TextBox { Name = "GitHubHost", AccessibleName = "GitHub 登录主机", Text = pending != null ? pending.Host : expected != null ? expected.Host : "https://github.com", Dock = DockStyle.Fill, Margin = new Padding(0, 5, 0, 0), ReadOnly = expected != null || pending != null };
        start = ButtonFor("获取验证码"); start.Name = "StartDeviceLogin";
        hostRow.Controls.Add(host, 0, 0); hostRow.Controls.Add(start, 2, 0); root.Controls.Add(hostRow, 0, 2);
        code = new TextBox { Name = "GitHubDeviceCode", AccessibleName = "GitHub 设备验证码", ReadOnly = true, TextAlign = HorizontalAlignment.Center, Dock = DockStyle.Fill, BorderStyle = BorderStyle.FixedSingle, BackColor = Color.White, Margin = new Padding(0, 5, 0, 5), Font = Typeface(23F, FontStyle.Bold), TabStop = true };
        root.Controls.Add(code, 0, 4);
        var actions = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, Margin = Padding.Empty };
        actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 102)); actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 10)); actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        copy = ButtonFor("复制验证码"); open = ButtonFor("打开 GitHub 授权页"); open.Name = "OpenGitHubDevicePage";
        actions.Controls.Add(copy, 0, 0); actions.Controls.Add(open, 2, 0); root.Controls.Add(actions, 0, 5);
        expiry = LabelFor("", Muted); expiry.Font = Typeface(8.5F, FontStyle.Regular); root.Controls.Add(expiry, 0, 6);
        status = LabelFor(expected == null ? "无需在此输入密码。获取验证码后，在 GitHub 完成授权。" : "请确认授权页登录的是 " + expected.Login + "。", Muted); root.Controls.Add(status, 0, 7);
        cancel = ButtonFor("取消"); cancel.Width = 100; cancel.Dock = DockStyle.Right; root.Controls.Add(cancel, 0, 8);
        Controls.Add(root);
        start.Click += async delegate { await StartAsync(); };
        cancel.Click += delegate { Close(); };
        copy.Click += delegate {
            if (String.IsNullOrEmpty(code.Text)) return;
            try { Clipboard.SetText(code.Text); expiry.Text = "验证码已复制。"; }
            catch { expiry.Text = "无法访问剪贴板，请选中验证码后复制。"; }
        };
        open.Click += delegate {
            var target = login != null && login.Active ? NativeData.DevicePage(login.Host, login.VerificationUri) : null;
            if (target == null || !open.Enabled) return;
            try { using (var child = Process.Start(new ProcessStartInfo { FileName = target, UseShellExecute = true })) { } }
            catch { status.Text = "无法打开默认浏览器，请检查浏览器设置后重试。"; }
        };
        timer = new System.Windows.Forms.Timer { Interval = 1000 };
        timer.Tick += async delegate { await PollAsync(); };
        Shown += delegate { Render(); if (login != null && login.Active) timer.Start(); };
        FormClosing += OnClosing;
        Render();
    }

    private bool Current(int value) { return !disposed && !disconnected && value == generation; }

    private void ClearCode()
    {
        code.Text = ""; copy.Enabled = open.Enabled = false; expiry.Text = "";
    }

    private void Render()
    {
        if (disposed || disconnected) return;
        ClearCode();
        var active = login != null && login.Active;
        var expires = login == null ? null : NativeData.Date(login.ExpiresAt);
        var expired = expires.HasValue && expires.Value <= DateTimeOffset.UtcNow;
        start.Enabled = !working && !closing && (!active || expired);
        start.Text = login == null ? "获取验证码" : "重新获取";
        host.ReadOnly = expected != null || active;
        if (!active && expected != null) host.Text = expected.Host;
        cancel.Text = closing ? "正在取消…" : "取消";
        if (login == null) return;
        if (active && !expired && !String.IsNullOrEmpty(login.UserCode) && NativeData.DevicePage(login.Host, login.VerificationUri) != null)
        {
            code.Text = login.UserCode; copy.Enabled = open.Enabled = !closing;
            expiry.Text = expires.HasValue ? "有效至 " + expires.Value.ToLocalTime().ToString("HH:mm:ss", CultureInfo.InvariantCulture) : "请在 GitHub 提示的有效期内完成授权。";
        }
        switch (login.Status)
        {
            case "starting": status.Text = "正在向 GitHub 获取验证码…"; break;
            case "pending": status.Text = expired ? "验证码已过期，请重新获取。" : "复制验证码后打开 GitHub 授权页。完成后会自动确认账号。"; break;
            case "verifying": status.Text = "正在确认已授权的账号…"; break;
            case "complete": status.Text = "登录成功。"; break;
            case "expired": status.Text = "验证码已过期，请重新获取。"; break;
            case "cancelled": status.Text = "登录已取消，可重新获取验证码。"; break;
            default: status.Text = "登录未完成。" + NativeData.Clean(login.Error, 200); break;
        }
        if (closing) status.Text = "正在取消此次登录…";
        else if (resumed && login.Status == "pending") status.Text = "继续尚未完成的登录。请确认 GitHub 授权页上的账号，或取消后重新开始。";
    }

    private void Complete()
    {
        Succeeded = true; allowClose = true; timer.Stop(); ClearCode(); Close();
    }

    private async Task StartAsync()
    {
        if (working || closing || disposed || disconnected) return;
        var targetHost = NativeData.Host(expected != null ? expected.Host : host.Text);
        if (targetHost == null) { status.Text = "请输入 github.com 或企业专属的 tenant.ghe.com。"; return; }
        var current = ++generation; working = true; timer.Stop(); ClearCode(); start.Enabled = false; host.ReadOnly = true; status.Text = "正在获取验证码…";
        string failure = null;
        try
        {
            if (login != null && login.Active)
            {
                login = NativeLogin.Read(await api.RequestAsync("/api/auth/login/" + login.Id + "/cancel", "POST"));
                if (!Current(current)) return;
                if (login.Status == "complete") { Complete(); return; }
            }
            var payload = new Dictionary<string, object> { { "host", targetHost } };
            if (expected != null) payload.Add("accountId", expected.Id);
            startUncertain = true;
            var result = NativeLogin.Read(await api.RequestAsync("/api/auth/login", "POST", payload));
            if (!Current(current)) return;
            startUncertain = false; resumed = false; login = result; host.Text = result.Host;
            if (login.Status == "complete") { Complete(); return; }
        }
        catch (Exception error)
        {
            if (!Current(current)) return;
            failure = "无法获取验证码：" + NativeData.Error(error);
            status.Text = failure;
        }
        if (failure != null)
        {
            // A timed-out start may still have created the one pending attempt.
            // Recover its public state instead of starting an additional login.
            try
            {
                var state = await api.RequestAsync("/api/auth/accounts");
                if (!Current(current)) return;
                var existing = NativeLogin.Read(NativeData.Map(state, "login"));
                startUncertain = false;
                if (existing != null && existing.Active) { login = existing; host.Text = existing.Host; resumed = true; Text = "继续登录 · PilotMeter"; }
            }
            catch { }
        }
        if (Current(current))
        {
            working = false;
            if (closing) await CancelAndCloseAsync();
            else
            {
                Render();
                if (login != null && login.Active) timer.Start();
                else if (failure != null) status.Text = failure;
            }
        }
    }

    private async Task PollAsync()
    {
        if (disposed || disconnected || !Visible || WindowState == FormWindowState.Minimized || working || polling || closing || login == null || !login.Active) return;
        var current = generation; var id = login.Id; polling = true;
        try
        {
            var result = NativeLogin.Read(await api.RequestAsync("/api/auth/login/" + id));
            if (!Current(current)) return;
            login = result;
            if (result.Status == "complete") { Complete(); return; }
            Render(); if (!login.Active) timer.Stop();
        }
        catch (Exception error) { if (Current(current)) { ClearCode(); status.Text = "登录状态暂不可用：" + NativeData.Error(error); } }
        finally { polling = false; }
    }

    private void OnClosing(object sender, FormClosingEventArgs e)
    {
        if (allowClose || disconnected) return;
        if (working || startUncertain || login != null && login.Active)
        {
            e.Cancel = true;
            if (!closing)
            {
                closing = true; timer.Stop(); ClearCode(); status.Text = "正在取消此次登录…"; start.Enabled = false;
                if (!working) BeginInvoke(new Action(async delegate { await CancelAndCloseAsync(); }));
            }
        }
    }

    private async Task CancelAndCloseAsync()
    {
        if (disposed || disconnected || working) return;
        working = true; generation++; timer.Stop(); ClearCode();
        try
        {
            if (startUncertain)
            {
                var state = await api.RequestAsync("/api/auth/accounts");
                login = NativeLogin.Read(NativeData.Map(state, "login"));
                startUncertain = false;
            }
            if (login != null && login.Active)
            {
                var result = NativeLogin.Read(await api.RequestAsync("/api/auth/login/" + login.Id + "/cancel", "POST"));
                Succeeded = result.Status == "complete";
            }
        }
        catch { Feedback = "未能确认登录取消。请勿继续使用刚才的验证码。"; }
        finally { if (!disposed) { working = false; allowClose = true; Close(); } }
    }

    internal void Disconnect()
    {
        if (disposed) return;
        disconnected = true; generation++; timer.Stop(); ClearCode(); allowClose = true;
        Feedback = "本机服务已断开，请重新开始登录。";
        Close();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !disposed) { disposed = true; generation++; timer.Stop(); timer.Dispose(); api.Dispose(); }
        base.Dispose(disposing);
    }
}
