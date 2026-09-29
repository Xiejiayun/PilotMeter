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
    internal string Used, Limit, Remaining, Overage, RemainingSource, UsedPercentageText, RemainingPercentageText, RawUsed, RawLimit, RawRemainingPercentage;
    internal double? Percentage, RemainingPercentage;
    internal bool Unlimited;
    public override string ToString() { return Label; }

    internal static NativeBucket Read(Dictionary<string, object> source)
    {
        var result = new NativeBucket {
            Key = NativeData.Text(source, "key", 160), Label = NativeData.Clean(NativeData.Text(source, "label", 160), 80),
            Value = NativeData.Clean(NativeData.Text(source, "value", 600), 600), Detail = NativeData.Clean(NativeData.Text(source, "detail", 600), 600),
            NextResetAt = NativeData.Text(source, "nextResetAt", 80, true),
            Unit = NativeData.Text(source, "unit", 32), UnitLabel = NativeData.Clean(NativeData.Text(source, "unitLabel", 80), 80), Unlimited = NativeData.Flag(source, "unlimited")
        };
        if (result.Unit != "ai-credits" && result.Unit != "premium-requests" && result.Unit != "unspecified") throw new InvalidDataException("额度单位无效。");
        result.Used = NativeDisplay.Quantity(source, "used"); result.Limit = NativeDisplay.Quantity(source, "limit");
        result.Remaining = NativeDisplay.Quantity(source, "remaining"); result.Overage = NativeDisplay.Quantity(source, "overage");
        result.RemainingPercentage = NativeDisplay.Percent(source, "remainingPercentage");
        result.RemainingPercentageText = NativeDisplay.Quantity(source, "remainingPercentage");
        result.UsedPercentageText = NativeDisplay.Quantity(source, "usedPercentage");
        NativeDisplay.Percent(source, "usedPercentage");
        result.RemainingSource = NativeData.Text(source, "remainingSource", 32, true);
        if (result.RemainingSource != null && result.RemainingSource != "calculated" || result.Unit == "unspecified" && (result.Used != null || result.Limit != null || result.Remaining != null || result.Overage != null)
            || result.Unlimited && (result.Limit != null || result.Remaining != null || result.Overage != null)) throw new InvalidDataException("额度数量与计量单位不一致。");
        var raw = NativeData.Map(source, "raw");
        result.RawUsed = NativeDisplay.Quantity(raw, "used"); result.RawLimit = NativeDisplay.Quantity(raw, "limit");
        result.RawRemainingPercentage = NativeDisplay.Quantity(raw, "remainingPercentage");
        NativeDisplay.Percent(raw, "remainingPercentage");
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
    internal bool Enabled, Refreshing, Stale, QuotaAvailable, QuotaHasSnapshot;
    internal NativeBucket Primary;
    internal NativeLogin Login;
    internal NativeModels Models;
    internal NativeLocalUsage Local;
    internal NativeAccount Active { get { return Accounts.Find(delegate(NativeAccount account) { return account.Id == ActiveId; }); } }
    internal bool CanDisplayQuota { get { return Active != null && Active.Status == "connected" && QuotaAvailable && !Stale; } }
    internal bool CanDisplaySnapshot { get { return Active != null && Active.Status == "connected" && QuotaHasSnapshot && Buckets.Count > 0; } }

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
            result.QuotaHasSnapshot = result.QuotaAvailable || NativeData.Text(quota, "state", 32) == "error";
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
        result.Models = NativeModels.Read(NativeData.Map(source, "models"), result.ActiveId);
        result.Local = NativeLocalUsage.Read(NativeData.Map(source, "local"), result.ActiveId);
        return result;
    }
}

internal abstract class NativeForm : Form
{
    protected static readonly Color Ink = Color.FromArgb(47, 67, 45);
    protected static readonly Color Muted = Color.FromArgb(111, 129, 100);
    protected static readonly Color Accent = Color.FromArgb(79, 113, 75);
    private readonly List<Font> fonts = new List<Font>();

    protected NativeForm()
    {
        // Defer the first DPI pass until the derived form has built every row,
        // card and button. Otherwise only the form/font scale on a 150% screen.
        SuspendLayout();
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96, 96);
        Font = Typeface(9.5F, FontStyle.Regular);
        ForeColor = Ink;
        BackColor = Color.FromArgb(249, 250, 244);
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
        button.FlatAppearance.BorderColor = Color.FromArgb(218, 226, 209);
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(237, 243, 229);
        return button;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing) { foreach (var font in fonts) font.Dispose(); fonts.Clear(); }
    }
}

internal sealed class NativeLoginDialog : NativeForm
{
    private readonly DesktopNativeApi api;
    private readonly NativeAccount expected;
    private readonly TextBox host, code, address;
    private readonly Label status, expiry, copyFeedback;
    private readonly Button start, copy, open, cancel;
    private readonly System.Windows.Forms.Timer timer;
    private NativeLogin login;
    private bool working, polling, closing, allowClose, disconnected, disposed, startUncertain, resumed;
    private int generation, pollFailures;
    internal bool Succeeded;
    internal string Feedback;

    internal NativeLoginDialog(DesktopInstance service, NativeAccount expected, NativeLogin pending)
    {
        api = new DesktopNativeApi(service); this.expected = pending == null ? expected : null; login = pending; resumed = pending != null;
        Text = pending != null ? "继续登录 · PilotMeter" : expected == null ? "登录 GitHub · PilotMeter" : "重新登录 · PilotMeter";
        Name = "PilotMeterLoginWindow";
        ClientSize = new Size(560, 660);
        MinimumSize = new Size(500, 490);
        FormBorderStyle = FormBorderStyle.Sizable;
        ShowInTaskbar = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterParent;
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, RowCount = 2, Margin = Padding.Empty };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        var scroll = new Panel { Name = "LoginInstructions", Dock = DockStyle.Fill, AutoScroll = true, Margin = Padding.Empty };
        var body = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, RowCount = 12, Margin = Padding.Empty, Padding = new Padding(0, 0, 12, 8) };
        body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        foreach (var height in new[] { 36, 46, 28, 38, 44, 60, 40, 24, 26, 30, 30 }) body.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
        body.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var title = LabelFor(pending != null ? "继续 GitHub 登录" : expected == null ? "连接 GitHub 账号" : "重新登录 @" + expected.Login, Ink); title.Font = Typeface(15F, FontStyle.Bold);
        body.Controls.Add(title, 0, 0);
        var intro = LabelFor(pending != null ? "继续之前发起的授权，请确认网页上是你要连接的账号。\n如需更换账号，请取消后重新开始。" : expected == null ? "用 GitHub 设备码连接个人或工作账号。\n密码只需在 GitHub 网站输入。" : "请在 GitHub 网页确认当前账号为 @" + expected.Login + "，再授权。", Muted);
        intro.AutoEllipsis = false; intro.AutoSize = true; intro.MinimumSize = new Size(0, 46);
        body.RowStyles[1].SizeType = SizeType.AutoSize; body.Controls.Add(intro, 0, 1);
        body.Controls.Add(LabelFor("1. 获取验证码 · 登录网站通常无需更改", Ink), 0, 2);
        var hostRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 1, Margin = Padding.Empty };
        hostRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        hostRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); hostRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 10)); hostRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 108));
        host = new TextBox { Name = "GitHubHost", AccessibleName = "GitHub 登录主机", Text = pending != null ? pending.Host : expected != null ? expected.Host : "https://github.com", Dock = DockStyle.Fill, Margin = new Padding(0, 5, 0, 0), ReadOnly = expected != null || pending != null };
        start = ButtonFor("获取验证码"); start.Name = "StartDeviceLogin";
        hostRow.Controls.Add(host, 0, 0); hostRow.Controls.Add(start, 2, 0); body.Controls.Add(hostRow, 0, 3);
        body.Controls.Add(LabelFor("2. 复制下方验证码，在 GitHub 授权页粘贴并确认", Ink), 0, 4);
        code = new TextBox { Name = "GitHubDeviceCode", AccessibleName = "GitHub 设备验证码", ReadOnly = true, TextAlign = HorizontalAlignment.Center, Dock = DockStyle.Fill, BorderStyle = BorderStyle.FixedSingle, BackColor = Color.White, Margin = new Padding(0, 5, 0, 5), Font = Typeface(23F, FontStyle.Bold), TabStop = true };
        body.Controls.Add(code, 0, 5);
        var actions = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 1, Margin = Padding.Empty };
        actions.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 102)); actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 10)); actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        copy = ButtonFor("仅复制"); copy.Name = "CopyGitHubDeviceCode";
        open = ButtonFor("复制并打开 GitHub"); open.Name = "OpenGitHubDevicePage"; open.BackColor = Accent; open.ForeColor = Color.White;
        actions.Controls.Add(copy, 0, 0); actions.Controls.Add(open, 2, 0); body.Controls.Add(actions, 0, 6);
        copyFeedback = LabelFor("", Muted); copyFeedback.Name = "CopyDeviceCodeFeedback"; copyFeedback.AutoEllipsis = false;
        copyFeedback.AutoSize = true; copyFeedback.MinimumSize = new Size(0, 24); body.RowStyles[7].SizeType = SizeType.AutoSize; body.Controls.Add(copyFeedback, 0, 7);
        expiry = LabelFor("", Muted); expiry.Name = "DeviceCodeExpiry"; body.Controls.Add(expiry, 0, 8);
        address = new TextBox { Name = "GitHubDeviceAddress", AccessibleName = "GitHub 授权网址，可手动复制", ReadOnly = true, Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, BackColor = BackColor, ForeColor = Muted, Margin = new Padding(0, 6, 0, 0) };
        body.Controls.Add(address, 0, 9);
        body.Controls.Add(LabelFor("3. 授权后回到这里，账号会自动连接", Ink), 0, 10);
        status = LabelFor("点击“获取验证码”开始登录。", Muted); status.Name = "GitHubLoginStatus";
        status.AutoEllipsis = false; status.AutoSize = true; status.MinimumSize = new Size(0, 48); status.TextAlign = ContentAlignment.TopLeft;
        status.Padding = new Padding(0, 6, 0, 8); body.Controls.Add(status, 0, 11);
        body.SizeChanged += delegate {
            var maximum = new Size(Math.Max(1, body.ClientSize.Width - body.Padding.Horizontal), 0);
            status.MaximumSize = intro.MaximumSize = copyFeedback.MaximumSize = maximum;
        };
        scroll.Controls.Add(body); root.Controls.Add(scroll, 0, 0);
        cancel = ButtonFor("取消登录"); cancel.Name = "CancelDeviceLogin"; cancel.Width = 112; cancel.Dock = DockStyle.Right; cancel.Margin = new Padding(0, 8, 0, 0); root.Controls.Add(cancel, 0, 1);
        Controls.Add(root);
        CancelButton = cancel; AcceptButton = start;
        start.Click += async delegate { await StartAsync(); };
        cancel.Click += delegate { Close(); };
        copy.Click += delegate {
            if (!CodeUsable()) { Render(); return; }
            CopyCode();
        };
        open.Click += delegate {
            if (!CodeUsable()) { Render(); return; }
            var target = login != null && login.Active ? NativeData.DevicePage(login.Host, login.VerificationUri) : null;
            if (target == null || !open.Enabled) return;
            CopyCode();
            try { using (var child = Process.Start(new ProcessStartInfo { FileName = target, UseShellExecute = true })) { } }
            catch { copyFeedback.Text = "无法打开浏览器，请复制下方网址到浏览器，再输入验证码。"; }
        };
        timer = new System.Windows.Forms.Timer { Interval = 1000 };
        timer.Tick += async delegate { await PollAsync(); };
        Shown += delegate {
            var area = Screen.FromControl(this).WorkingArea;
            MinimumSize = new Size(Math.Min(MinimumSize.Width, area.Width), Math.Min(MinimumSize.Height, area.Height));
            Size = new Size(Math.Min(Width, area.Width), Math.Min(Height, area.Height));
            Render(); if (login != null && login.Active) timer.Start();
        };
        FormClosing += OnClosing;
        Render();
        ResumeLayout(true);
    }

    private bool Current(int value) { return !disposed && !disconnected && value == generation; }

    private bool CodeUsable()
    {
        var expires = login == null ? null : NativeData.Date(login.ExpiresAt);
        return login != null && login.Active && !closing && !disconnected && !String.IsNullOrEmpty(code.Text)
            && (!expires.HasValue || expires.Value > DateTimeOffset.UtcNow);
    }

    private void CopyCode()
    {
        try { Clipboard.SetText(code.Text); copyFeedback.Text = "验证码已复制，到 GitHub 粘贴并确认授权。"; }
        catch { copyFeedback.Text = "无法复制，请手动选中上方验证码后按 Ctrl+C。"; }
    }

    private void ServiceChanged()
    {
        EndDisconnectedLogin("本机服务已重启，此验证码已失效。请关闭此窗口，再点击登录获取新验证码。", "本机服务已更换，请重新开始登录。");
    }

    private void EndDisconnectedLogin(string description, string feedback)
    {
        disconnected = true; working = false; timer.Stop(); ClearCode(); copyFeedback.Text = "";
        start.Enabled = false; host.ReadOnly = true; cancel.Text = "关闭";
        status.Text = description;
        Feedback = feedback;
    }

    private void ClearCode()
    {
        code.Text = ""; address.Text = ""; copy.Enabled = open.Enabled = false; expiry.Text = "";
    }

    private void Render()
    {
        if (disposed || disconnected) return;
        var active = login != null && login.Active;
        var expires = login == null ? null : NativeData.Date(login.ExpiresAt);
        var expired = expires.HasValue && expires.Value <= DateTimeOffset.UtcNow;
        start.Enabled = !working && !closing && (!active || expired);
        start.Text = login == null ? "获取验证码" : "重新获取";
        host.ReadOnly = expected != null || active;
        if (!active && expected != null) host.Text = expected.Host;
        cancel.Text = closing ? "正在取消…" : active ? "取消登录" : "关闭";
        if (login == null) { ClearCode(); cancel.Text = "取消登录"; return; }
        if (active && !expired && !String.IsNullOrEmpty(login.UserCode) && NativeData.DevicePage(login.Host, login.VerificationUri) != null)
        {
            if (code.Text != login.UserCode) copyFeedback.Text = "";
            code.Text = login.UserCode; copy.Enabled = open.Enabled = !closing;
            address.Text = NativeData.DevicePage(login.Host, login.VerificationUri);
            var seconds = expires.HasValue ? Math.Max(0, (int)Math.Ceiling((expires.Value - DateTimeOffset.UtcNow).TotalSeconds)) : 0;
            expiry.Text = expires.HasValue ? "验证码剩余 " + (seconds / 60) + " 分 " + (seconds % 60).ToString("00", CultureInfo.InvariantCulture) + " 秒" : "请在 GitHub 提示的有效期内完成授权。";
        }
        else { ClearCode(); copyFeedback.Text = ""; }
        switch (login.Status)
        {
            case "starting": status.Text = "正在连接 GitHub 获取验证码，通常需要几秒。请稍候…"; break;
            case "pending": status.Text = expired ? "验证码已过期。点击“重新获取”，再使用新验证码授权。" : "等待 GitHub 授权。请在网页输入上方验证码，确认账号并点击授权；完成后这里会自动更新。"; break;
            case "verifying": status.Text = "正在确认已授权的账号…"; break;
            case "complete": status.Text = "登录成功。"; break;
            case "expired": status.Text = "验证码已过期。点击“重新获取”，再使用新验证码授权。"; break;
            case "cancelled": status.Text = "登录已取消，可重新获取验证码。"; break;
            default: status.Text = "登录未完成。" + NativeData.Clean(login.Error, 400) + "\n处理后点击“重新获取”重试。"; break;
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
        var current = ++generation; working = true; timer.Stop(); ClearCode(); copyFeedback.Text = ""; start.Enabled = false; host.ReadOnly = true; status.Text = "正在连接 GitHub 获取验证码…";
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
        catch (DesktopServiceChangedException)
        {
            if (Current(current)) ServiceChanged();
            return;
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
            login = result; pollFailures = 0;
            if (result.Status == "complete") { Complete(); return; }
            Render(); if (!login.Active) timer.Stop();
        }
        catch (DesktopServiceChangedException)
        {
            if (Current(current)) ServiceChanged();
        }
        catch (Exception error)
        {
            if (Current(current))
            {
                if (++pollFailures >= 3)
                    EndDisconnectedLogin("无法连接本机服务，暂时不能确认授权结果。请关闭此窗口，重试连接后查看账号；仍未登录时再获取新验证码。", "登录连接已中断，请重试连接并查看当前账号状态。");
                else { Render(); status.Text = "暂时无法确认授权状态，正在自动重试。\n" + NativeData.Error(error); }
            }
        }
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
