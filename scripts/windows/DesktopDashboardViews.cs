using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

// Display values remain strings so exact decimal quantities never pass through
// a floating-point formatter. Only the decorative progress bar uses a double.
internal static class NativeDisplay
{
    internal static string Quantity(Dictionary<string, object> source, string key)
    {
        var value = NativeData.Text(source, key, 256, true);
        if (value != null && !Regex.IsMatch(value, @"^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$"))
            throw new InvalidDataException("用量数值无效，请重新同步。");
        return value;
    }

    internal static string Amount(string value)
    {
        if (value == null) return "—";
        var parts = value.Split('.');
        var whole = Regex.Replace(parts[0], @"\B(?=(?:[0-9]{3})+(?![0-9]))", ",");
        return whole + (parts.Length == 2 ? "." + parts[1] : "");
    }

    internal static string CompactAmount(string value)
    {
        if (value == null) return "—";
        var formatted = Amount(value);
        if (formatted.Length <= 9) return formatted;
        var parts = value.Split('.'); var digits = parts[0] + (parts.Length == 2 ? parts[1] : "");
        var start = digits.IndexOfAny("123456789".ToCharArray()); if (start < 0) return "0";
        var significant = digits.Substring(start); var count = Math.Min(3, significant.Length);
        var mantissa = significant.Substring(0, 1) + (count > 1 ? "." + significant.Substring(1, count - 1).TrimEnd('0') : "");
        mantissa = mantissa.TrimEnd('.');
        var approximate = significant.Length > count && Regex.IsMatch(significant.Substring(count), "[1-9]");
        return (approximate ? "≈" : "") + mantissa + "e" + (parts[0].Length - start - 1).ToString(CultureInfo.InvariantCulture);
    }

    internal static double? Percent(Dictionary<string, object> source, string key)
    {
        var value = Quantity(source, key);
        if (value == null) return null;
        var parts = value.Split('.');
        if (parts[0].Length > 3 || Int32.Parse(parts[0], CultureInfo.InvariantCulture) > 100 || parts[0] == "100" && parts.Length == 2 && Regex.IsMatch(parts[1], "[1-9]"))
            throw new InvalidDataException("额度比例无效。");
        double number;
        if (!Double.TryParse(value, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out number) || number > 100 || Double.IsNaN(number) || Double.IsInfinity(number))
            throw new InvalidDataException("额度比例无效。");
        return number;
    }

    internal static string Percentage(double? value)
    {
        if (!value.HasValue) return "—";
        if (value.Value > 0 && value.Value < .1) return "<0.1%";
        if (value.Value < 100 && value.Value > 99.9) return ">99.9%";
        return value.Value.ToString("0.#", CultureInfo.InvariantCulture) + "%";
    }

    internal static string ExactPercentage(string value)
    {
        if (value == null) return "—";
        var normalized = value.Contains(".") ? value.TrimEnd('0').TrimEnd('.') : value;
        var number = Double.Parse(value, CultureInfo.InvariantCulture);
        if (number == 100 && normalized != "100") return ">99.9%";
        if (number == 0 && normalized != "0") return "<0.1%";
        return Percentage(number);
    }

    internal static long Count(Dictionary<string, object> source, string key)
    {
        object value;
        if (source == null || !source.TryGetValue(key, out value) || value == null) return 0;
        if (!(value is int) && !(value is long) && !(value is decimal) && !(value is double)) throw new InvalidDataException("记录数量无效。");
        var number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
        if (Double.IsNaN(number) || Double.IsInfinity(number) || number < 0 || number > 9007199254740991D || Math.Floor(number) != number) throw new InvalidDataException("记录数量无效。");
        return (long)number;
    }

    internal static bool? OptionalFlag(Dictionary<string, object> source, string key)
    {
        object value;
        if (source == null || !source.TryGetValue(key, out value) || value == null) return null;
        if (!(value is bool)) throw new InvalidDataException("模型能力信息无效。");
        return (bool)value;
    }

    internal static string Time(string value)
    {
        var date = NativeData.Date(value);
        return date.HasValue ? date.Value.ToLocalTime().ToString("M月d日 HH:mm", CultureInfo.GetCultureInfo("zh-CN")) : "尚未同步";
    }

    internal static string ModelStatus(NativeModel item, bool stale)
    {
        if (item.Status == "available") return stale ? "上次可用" : "可用";
        if (item.Status == "disabled") return stale ? "上次禁用" : "已禁用";
        return "待验证";
    }
}

internal sealed class NativeModel
{
    internal string Id, Name, Status, Reason, PolicyState, Multiplier;
    internal bool? Vision, ReasoningEffort;
    internal long? ContextWindowTokens;

    internal static NativeModel Read(Dictionary<string, object> source)
    {
        var item = new NativeModel {
            Id = NativeData.Clean(NativeData.Text(source, "id", 256), 256), Name = NativeData.Clean(NativeData.Text(source, "name", 256), 256),
            Status = NativeData.Text(source, "status", 32), Reason = NativeData.Clean(NativeData.Text(source, "reason", 600), 600),
            PolicyState = NativeData.Text(source, "policyState", 32, true), Multiplier = NativeDisplay.Quantity(source, "multiplier"),
            Vision = NativeDisplay.OptionalFlag(source, "vision"), ReasoningEffort = NativeDisplay.OptionalFlag(source, "reasoningEffort")
        };
        if (String.IsNullOrWhiteSpace(item.Id) || String.IsNullOrWhiteSpace(item.Name)
            || !new HashSet<string>(new[] { "available", "disabled", "unknown" }).Contains(item.Status)
            || item.PolicyState != null && !new HashSet<string>(new[] { "enabled", "disabled", "unconfigured" }).Contains(item.PolicyState)
            || item.Status == "available" && item.PolicyState != "enabled" || item.Status == "disabled" && item.PolicyState != "disabled")
            throw new InvalidDataException("模型授权信息无效，请刷新。");
        object context;
        if (source.TryGetValue("contextWindowTokens", out context) && context != null) item.ContextWindowTokens = NativeDisplay.Count(source, "contextWindowTokens");
        return item;
    }

    internal string Capabilities
    {
        get {
            var values = new List<string>();
            if (Vision == true) values.Add("图像");
            if (ReasoningEffort == true) values.Add("推理配置");
            if (ContextWindowTokens.HasValue) values.Add(NativeDisplay.Amount(ContextWindowTokens.Value.ToString(CultureInfo.InvariantCulture)) + " 上下文");
            return values.Count == 0 ? "能力待确认" : String.Join(" · ", values.ToArray());
        }
    }
}

internal sealed class NativeModels
{
    internal string AccountId, State, Source, FetchedAt, Error;
    internal bool Stale, Refreshing;
    internal readonly List<NativeModel> Items = new List<NativeModel>();

    internal static NativeModels Read(Dictionary<string, object> source, string activeId)
    {
        if (source == null) return null;
        var result = new NativeModels {
            AccountId = NativeData.Identifier(source, "accountId"), State = NativeData.Text(source, "state", 32),
            Source = NativeData.Text(source, "source", 80), FetchedAt = NativeData.Text(source, "fetchedAt", 80, true),
            Stale = NativeData.Flag(source, "stale"), Refreshing = NativeData.Flag(source, "refreshing"),
            Error = NativeData.Clean(NativeData.Text(NativeData.Map(source, "error"), "message", 600, true), 300)
        };
        if (result.AccountId != activeId || result.Source != "copilot-cli-models.list"
            || !new HashSet<string>(new[] { "available", "unavailable", "error" }).Contains(result.State)) throw new InvalidDataException("模型列表与当前账号不一致。");
        var ids = new HashSet<string>();
        foreach (var row in NativeData.Rows(source, "items", 512))
        {
            var item = NativeModel.Read(row);
            if (!ids.Add(item.Id)) throw new InvalidDataException("模型列表存在重复项。");
            result.Items.Add(item);
        }
        var fetched = NativeData.Date(result.FetchedAt);
        result.Stale = result.Stale || result.State != "available" || !String.IsNullOrEmpty(result.Error)
            || !fetched.HasValue || fetched.Value > DateTimeOffset.UtcNow || DateTimeOffset.UtcNow - fetched.Value > TimeSpan.FromMinutes(5);
        return result;
    }
}

internal sealed class NativeLocalUsage
{
    internal string AccountId, Period, Scope, Coverage, NanoAiu, Credits, UpdatedAt;
    internal bool UnitVerified, Retained;
    internal long KnownCalls, UnknownCalls, PendingCalls, SessionCount;

    internal static NativeLocalUsage Read(Dictionary<string, object> source, string activeId)
    {
        if (source == null) return null;
        var result = new NativeLocalUsage {
            AccountId = NativeData.Identifier(source, "accountId", true), Period = NativeData.Text(source, "period", 7),
            Scope = NativeData.Clean(NativeData.Text(source, "scope", 600), 400), Coverage = NativeData.Text(source, "coverage", 24),
            NanoAiu = NativeDisplay.Quantity(source, "nanoAiu"), Credits = NativeDisplay.Quantity(source, "credits"),
            UnitVerified = NativeData.Flag(source, "unitVerified"), Retained = NativeData.Flag(source, "retained"),
            KnownCalls = NativeDisplay.Count(source, "knownCalls"), UnknownCalls = NativeDisplay.Count(source, "unknownCalls"),
            PendingCalls = NativeDisplay.Count(source, "pendingCalls"), SessionCount = NativeDisplay.Count(source, "sessionCount"),
            UpdatedAt = NativeData.Text(source, "updatedAt", 80, true)
        };
        if (result.AccountId != activeId || NativeData.Text(source, "source", 32) != "local-otel"
            || !Regex.IsMatch(result.Period, @"^[0-9]{4}-(?:0[1-9]|1[0-2])$") || result.Coverage != "partial" && result.Coverage != "empty")
            throw new InvalidDataException("本机记录范围无效。");
        return result;
    }
}

internal sealed class NativeUsageRecord
{
    internal string Id, SessionId, FirstSeen, LastSeen, NanoAiu, Credits;
    internal bool UnitVerified;
    internal long KnownCalls, UnknownCalls, PendingCalls;
    internal readonly List<string> Models = new List<string>();
    internal static NativeUsageRecord Read(Dictionary<string, object> source)
    {
        var row = new NativeUsageRecord {
            Id = NativeData.Text(source, "id", 256), SessionId = NativeData.Clean(NativeData.Text(source, "sessionId", 256), 256),
            FirstSeen = NativeData.Text(source, "firstSeen", 80, true), LastSeen = NativeData.Text(source, "lastSeen", 80, true),
            NanoAiu = NativeDisplay.Quantity(source, "nanoAiu"), Credits = NativeDisplay.Quantity(source, "credits"), UnitVerified = NativeData.Flag(source, "unitVerified"),
            KnownCalls = NativeDisplay.Count(source, "knownCalls"), UnknownCalls = NativeDisplay.Count(source, "unknownCalls"), PendingCalls = NativeDisplay.Count(source, "pendingCalls")
        };
        if (row.FirstSeen != null && !NativeData.Date(row.FirstSeen).HasValue || row.LastSeen != null && !NativeData.Date(row.LastSeen).HasValue) throw new InvalidDataException("记录时间无效。");
        object raw;
        if (!source.TryGetValue("models", out raw) || !(raw is System.Collections.IList)) throw new InvalidDataException("模型记录无效。");
        var models = (System.Collections.IList)raw;
        if (models.Count > 256) throw new InvalidDataException("模型记录过多。");
        foreach (var model in models)
        {
            if (!(model is string) || ((string)model).Length > 256) throw new InvalidDataException("模型记录无效。");
            row.Models.Add(NativeData.Clean((string)model, 256));
        }
        return row;
    }
}

internal sealed class NativeRecords
{
    internal string AccountId, Period, Scope, NextCursor;
    internal readonly List<NativeUsageRecord> Items = new List<NativeUsageRecord>();
    internal static NativeRecords Read(Dictionary<string, object> source, DesktopInstance expected, string accountId, string period)
    {
        if (!expected.Matches(source)) throw new InvalidDataException("本机服务已更换，请重试。");
        var result = new NativeRecords {
            AccountId = NativeData.Identifier(source, "accountId", true), Period = NativeData.Text(source, "period", 7),
            Scope = NativeData.Clean(NativeData.Text(source, "scope", 600), 400), NextCursor = NativeData.Text(source, "nextCursor", 2048, true)
        };
        if (result.AccountId != accountId || result.Period != period || NativeData.Text(source, "source", 32) != "local-otel"
            || NativeData.Text(source, "coverage", 24) != "partial" || result.NextCursor != null && !Regex.IsMatch(result.NextCursor, @"^[A-Za-z0-9_-]{1,2048}$"))
            throw new InvalidDataException("记录与当前账号或月份不一致。");
        var ids = new HashSet<string>();
        foreach (var item in NativeData.Rows(source, "items", 50))
        {
            var row = NativeUsageRecord.Read(item);
            if (!ids.Add(row.Id)) throw new InvalidDataException("记录重复，请刷新。");
            result.Items.Add(row);
        }
        return result;
    }
}

internal sealed class NativeSurface : Panel
{
    internal Color SurfaceColor = Color.White;
    internal Color BorderColor = Color.FromArgb(221, 229, 215);
    internal int Radius = 16;
    internal NativeSurface()
    {
        DoubleBuffered = true;
        SetStyle(ControlStyles.ResizeRedraw | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint, true);
        BackColor = Color.Transparent;
    }
    internal static GraphicsPath Rounded(RectangleF bounds, float radius)
    {
        var path = new GraphicsPath();
        var diameter = Math.Max(1, Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height)));
        path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure(); return path;
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (Width < 2 || Height < 2) return;
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (var path = Rounded(new RectangleF(.5F, .5F, Width - 1, Height - 1), Radius))
        using (var fill = new SolidBrush(SurfaceColor))
        using (var edge = new Pen(BorderColor)) { e.Graphics.FillPath(fill, path); e.Graphics.DrawPath(edge, path); }
    }
}

internal sealed class NativeUsageBar : Control
{
    private double? percentage;
    internal double? Percentage { get { return percentage; } set { percentage = value; AccessibleDescription = value.HasValue ? "已用 " + NativeDisplay.Percentage(value) : "比例未知"; Invalidate(); } }
    internal NativeUsageBar() { DoubleBuffered = true; SetStyle(ControlStyles.ResizeRedraw, true); Height = 8; AccessibleRole = AccessibleRole.ProgressBar; AccessibleName = "当前类别已用额度"; }
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (Width < 2 || Height < 2) return;
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (var track = NativeSurface.Rounded(new RectangleF(0, 0, Width, Height), Height / 2F))
        using (var brush = new SolidBrush(Color.FromArgb(221, 232, 212))) e.Graphics.FillPath(brush, track);
        if (!percentage.HasValue || percentage <= 0) return;
        using (var bar = NativeSurface.Rounded(new RectangleF(0, 0, Math.Max(2, (float)(Width * Math.Min(100, percentage.Value) / 100)), Height), Height / 2F))
        using (var brush = new SolidBrush(Color.FromArgb(91, 126, 87))) e.Graphics.FillPath(brush, bar);
    }
}

internal sealed class NativeQuotaSelectionEventArgs : EventArgs
{
    internal readonly string AccountId, Key;
    internal NativeQuotaSelectionEventArgs(string accountId, string key) { AccountId = accountId; Key = key; }
}

internal sealed class DashboardWindow : NativeForm
{
    private readonly Func<Task> retry;
    private readonly Dictionary<string, Control> pages = new Dictionary<string, Control>();
    private readonly Dictionary<string, Button> navigation = new Dictionary<string, Button>();
    private readonly List<Image> petImages = new List<Image>();
    private readonly List<Button> petButtons = new List<Button>();
    private readonly List<NativeUsageRecord> recordItems = new List<NativeUsageRecord>();
    private readonly ToolTip tips = new ToolTip { AutoPopDelay = 15000 };
    private readonly System.Windows.Forms.Timer timer;
    private readonly ContextMenuStrip accountMenu;
    private readonly ToolStripMenuItem reauthenticate, remove;
    private Panel pageHost;
    private ComboBox accounts, bucketChoice, modelFilter, recordSort;
    private Button add, refresh, accountSettings, accountReauth, accountRemove, loadMore;
    private Label pageTitle, pageSubtitle, breadcrumb, accountStatus, feedback, synced, category, quotaCaption, quotaValue, quotaUnit, quotaUsed, quotaUsedUnit, quotaTotal, quotaTotalUnit, quotaRatios, quotaDetail, reset, localSummary, modelSummary, modelState, recordScope, recordState, accountHint, petHint, petSizeLabel;
    private LinkLabel other, raw;
    private NativeSurface otherPanel, rawPanel;
    private TextBox rawText, modelSearch;
    private NativeUsageBar progress;
    private DataGridView modelsGrid, overviewModels, recordsGrid, accountsGrid;
    private DateTimePicker recordMonth;
    private TrackBar petSize;
    private CheckBox petMotion, petTop;
    private PictureBox petPreview;
    private DesktopPetPreferences petPreferences;
    private DesktopInstance service;
    private DesktopNativeApi api;
    private NativeOverview overview;
    private NativeLoginDialog loginDialog;
    private string currentPage = "overview", quotaKey, quotaAccount, accountSignature, accountsGridSignature, modelsSignature, recordsAccount, recordsCursor, networkError, publishedAccount, publishedKey;
    private int generation, recordsGeneration;
    private bool suppress, suppressPets, loading, busy, expanded, rawExpanded, disposed, recordsLoading, recordsLoaded;
    private DateTime nextRefresh = DateTime.MinValue;
    internal event EventHandler<NativeQuotaSelectionEventArgs> QuotaSelectionChanged;
    internal bool AccountMutationPending { get; private set; }

    internal DashboardWindow(string directory, Func<Task> retry)
    {
        this.retry = retry;
        Text = "PilotMeter"; Name = "PilotMeterMainWindow";
        FormBorderStyle = FormBorderStyle.Sizable; MaximizeBox = true;
        ClientSize = new Size(1280, 850); MinimumSize = new Size(880, 640);
        DoubleBuffered = true;
        var shell = Columns(190, -1); shell.BackColor = BackColor;
        var sidebar = Rows(62, 28, 50, 50, 50, 50, -1, 178, 34);
        sidebar.Padding = new Padding(20, 24, 18, 18); sidebar.BackColor = Color.FromArgb(242, 246, 234);
        var brand = LabelFor("PilotMeter", Ink); brand.Font = Typeface(17, FontStyle.Bold); sidebar.Controls.Add(brand, 0, 0);
        var edition = LabelFor("YOUR QUIET COPILOT", Muted); edition.Font = Typeface(7.2F, FontStyle.Regular); sidebar.Controls.Add(edition, 0, 1);
        var names = new[] { "总览", "可用模型", "用量记录", "账户" }; var keys = new[] { "overview", "models", "records", "accounts" };
        for (var index = 0; index < keys.Length; index++)
        {
            var key = keys[index]; var navigationIndex = index; var button = ButtonFor(names[index]);
            button.Name = "Navigate" + key; button.TextAlign = ContentAlignment.MiddleLeft; button.Padding = new Padding(16, 0, 0, 0);
            button.Margin = new Padding(0, 3, 0, 3); button.FlatAppearance.BorderSize = 0;
            button.Click += delegate { Navigate(key); }; navigation.Add(key, button); sidebar.Controls.Add(button, 0, index + 2);
            button.KeyDown += delegate(object sender, KeyEventArgs e) {
                if (e.KeyCode != Keys.Up && e.KeyCode != Keys.Down) return;
                var next = (navigationIndex + (e.KeyCode == Keys.Down ? 1 : 3)) % 4; navigation[keys[next]].Focus(); Navigate(keys[next]); e.Handled = true;
            };
        }
        var companion = Rows(92, 28, 38); companion.Padding = new Padding(8); companion.BackColor = Color.FromArgb(233, 240, 222);
        petPreview = new PictureBox { Dock = DockStyle.Fill, SizeMode = PictureBoxSizeMode.Zoom, AccessibleName = "当前桌面宠物", TabStop = false };
        companion.Controls.Add(petPreview, 0, 0);
        companion.Controls.Add(LabelFor("陪你专注的小伙伴", Muted), 0, 1);
        var customize = ButtonFor("更换桌面宠物"); customize.Click += delegate { Navigate("accounts"); if (petButtons.Count > 0) petButtons[0].Focus(); }; companion.Controls.Add(customize, 0, 2);
        sidebar.Controls.Add(companion, 0, 7);
        var bottom = LabelFor("关闭窗口后，宠物继续陪伴。", Muted); bottom.Font = Typeface(7.6F, FontStyle.Regular); sidebar.Controls.Add(bottom, 0, 8);
        shell.Controls.Add(sidebar, 0, 0);

        var content = Rows(54, 100, -1, 42); content.Padding = new Padding(28, 22, 28, 10);
        var topbar = Columns(-1, 310, 42, 118);
        accountStatus = LabelFor("正在连接本机服务…", Muted); topbar.Controls.Add(accountStatus, 0, 0);
        accounts = new ComboBox { Name = "AccountSelector", AccessibleName = "当前 GitHub 账号", Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList, IntegralHeight = false, DropDownHeight = 250, Margin = new Padding(10, 9, 8, 0) };
        accountSettings = ButtonFor("···"); accountSettings.AccessibleName = "当前账号操作"; accountSettings.Margin = new Padding(0, 3, 6, 9);
        refresh = ButtonFor("刷新数据"); refresh.Name = "RefreshQuota"; refresh.Margin = new Padding(5, 3, 0, 9);
        topbar.Controls.Add(accounts, 1, 0); topbar.Controls.Add(accountSettings, 2, 0); topbar.Controls.Add(refresh, 3, 0); content.Controls.Add(topbar, 0, 0);
        var heading = Rows(22, 43, 30); breadcrumb = LabelFor("YOUR COPILOT, AT A GLANCE", Muted); breadcrumb.Font = Typeface(7.5F, FontStyle.Regular);
        pageTitle = LabelFor("用量概览", Ink); pageTitle.Font = Typeface(23, FontStyle.Bold);
        pageSubtitle = LabelFor("了解当前额度，找到适合下一项任务的模型。", Muted);
        heading.Controls.Add(breadcrumb, 0, 0); heading.Controls.Add(pageTitle, 0, 1); heading.Controls.Add(pageSubtitle, 0, 2); content.Controls.Add(heading, 0, 1);
        pageHost = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty }; content.Controls.Add(pageHost, 0, 2);
        var footer = Columns(-1, 190); feedback = LabelFor("", Muted); feedback.Font = Typeface(8, FontStyle.Regular); synced = LabelFor("尚未同步", Muted); synced.TextAlign = ContentAlignment.MiddleRight; synced.Font = Typeface(8, FontStyle.Regular);
        footer.Controls.Add(feedback, 0, 0); footer.Controls.Add(synced, 1, 0); content.Controls.Add(footer, 0, 3);
        shell.Controls.Add(content, 1, 0); Controls.Add(shell);

        BuildOverview(); BuildModels(); BuildRecords(); BuildAccounts();
        accountMenu = new ContextMenuStrip();
        reauthenticate = new ToolStripMenuItem("重新登录当前账号", null, delegate { OpenLogin(true); });
        remove = new ToolStripMenuItem("移除当前账号…", null, async delegate { await RemoveAsync(); });
        accountMenu.Items.Add(reauthenticate); accountMenu.Items.Add(remove);
        accountSettings.Click += delegate { accountMenu.Show(accountSettings, new Point(0, accountSettings.Height)); };
        accounts.SelectedIndexChanged += async delegate {
            if (suppress || busy || overview == null) return;
            var selected = accounts.SelectedItem as NativeAccount;
            if (selected != null && selected.Id != null && selected.Id != overview.ActiveId) await SelectAccountAsync(selected.Id);
        };
        refresh.Click += async delegate {
            if (busy || loading) return;
            if (api == null) { await retry(); if (api != null) await LoadAsync(true); }
            else if (overview == null) await LoadAsync(true);
            else await ChangeAsync("/api/auth/refresh", "POST", null, "正在同步额度和模型权限…");
        };
        timer = new System.Windows.Forms.Timer { Interval = 5000 };
        timer.Tick += async delegate { await LoadAsync(true); };
        Shown += async delegate {
            var area = Screen.FromControl(this).WorkingArea;
            MinimumSize = new Size(Math.Min(MinimumSize.Width, area.Width), Math.Min(MinimumSize.Height, area.Height));
            if (Width > area.Width || Height > area.Height) { Size = new Size(Math.Min(Width, area.Width), Math.Min(Height, area.Height)); Location = area.Location; }
            UpdatePolling(); await LoadAsync(true);
        };
        VisibleChanged += delegate { UpdatePolling(); }; Resize += delegate { UpdatePolling(); };
        Navigate("overview"); ClearQuota("连接 GitHub 账号后，查看当前账户的额度。"); UpdateControls();
    }

    private static TableLayoutPanel Rows(params int[] heights)
    {
        var table = new TableLayoutPanel { Dock = DockStyle.Fill, Margin = Padding.Empty, ColumnCount = 1, RowCount = heights.Length, BackColor = Color.Transparent };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        foreach (var height in heights) table.RowStyles.Add(new RowStyle(height < 0 ? SizeType.Percent : SizeType.Absolute, height < 0 ? 100 : height));
        return table;
    }

    private static TableLayoutPanel Columns(params int[] widths)
    {
        var table = new TableLayoutPanel { Dock = DockStyle.Fill, Margin = Padding.Empty, RowCount = 1, ColumnCount = widths.Length, BackColor = Color.Transparent };
        table.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        foreach (var width in widths) table.ColumnStyles.Add(new ColumnStyle(width < 0 ? SizeType.Percent : SizeType.Absolute, width < 0 ? 100 : width));
        return table;
    }

    private FlowLayoutPanel Page(string key)
    {
        var page = new FlowLayoutPanel { Name = "Page" + key, Dock = DockStyle.Fill, AutoScroll = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, Margin = Padding.Empty, Padding = new Padding(0, 4, 0, 4), Visible = false };
        page.SizeChanged += delegate { SizeCards(page); }; page.ControlAdded += delegate { SizeCards(page); };
        pageHost.Controls.Add(page); pages.Add(key, page); return page;
    }

    private static void SizeCards(FlowLayoutPanel page)
    {
        foreach (Control control in page.Controls) control.Width = Math.Max(180, page.ClientSize.Width - SystemInformation.VerticalScrollBarWidth - 2);
    }

    private NativeSurface Card(FlowLayoutPanel page, int height)
    {
        var card = new NativeSurface { Height = height, Padding = new Padding(22), Margin = new Padding(0, 0, 0, 16) }; page.Controls.Add(card); return card;
    }

    private Label Caption(string text) { var label = LabelFor(text, Muted); label.Font = Typeface(8, FontStyle.Regular); return label; }
    private Label Title(string text) { var label = LabelFor(text, Ink); label.Font = Typeface(13, FontStyle.Bold); return label; }
    private LinkLabel Link(string text)
    {
        return new LinkLabel { Text = text, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, LinkColor = Accent, ActiveLinkColor = Accent, VisitedLinkColor = Accent, Margin = Padding.Empty, AutoEllipsis = true };
    }

    private DataGridView Grid(params string[] columns)
    {
        var grid = new DataGridView { Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false, AllowUserToDeleteRows = false, AllowUserToResizeRows = false,
            RowHeadersVisible = false, BackgroundColor = Color.White, BorderStyle = BorderStyle.None, CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal,
            GridColor = Color.FromArgb(232, 238, 226), SelectionMode = DataGridViewSelectionMode.FullRowSelect, MultiSelect = false,
            AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells,
            ColumnHeadersHeight = 38, ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing, EnableHeadersVisualStyles = false };
        grid.DefaultCellStyle = new DataGridViewCellStyle { BackColor = Color.White, ForeColor = Ink, SelectionBackColor = Color.FromArgb(235, 242, 226), SelectionForeColor = Ink, Padding = new Padding(8, 10, 8, 10), WrapMode = DataGridViewTriState.True };
        grid.ColumnHeadersDefaultCellStyle = new DataGridViewCellStyle { BackColor = Color.FromArgb(247, 249, 241), ForeColor = Muted, SelectionBackColor = Color.FromArgb(247, 249, 241), Padding = new Padding(8, 0, 8, 0) };
        foreach (var name in columns) grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = name, Name = name, SortMode = DataGridViewColumnSortMode.NotSortable });
        return grid;
    }

    private Label Metric(TableLayoutPanel container, int column, string caption, float size)
    {
        var metric = Rows(28, -1, 26); metric.Padding = new Padding(column == 0 ? 0 : 20, 5, 0, 5);
        var title = Caption(caption); metric.Controls.Add(title, 0, 0);
        var amount = LabelFor("—", Ink); amount.Font = Typeface(size, FontStyle.Bold); metric.Controls.Add(amount, 0, 1);
        var unit = Caption(""); metric.Controls.Add(unit, 0, 2); container.Controls.Add(metric, column, 0);
        if (column == 0) { quotaCaption = title; quotaUnit = unit; }
        else if (column == 1) quotaUsedUnit = unit; else quotaTotalUnit = unit;
        amount.TextChanged += delegate { tips.SetToolTip(amount, amount.Text); amount.AccessibleDescription = amount.Text; };
        return amount;
    }

    private void BuildOverview()
    {
        var page = Page("overview");
        var quota = Card(page, 310); quota.SurfaceColor = Color.FromArgb(246, 249, 238);
        var layout = Rows(32, 136, 8, 30, 38, 22); var top = Columns(-1, 100);
        category = Title("当前账户额度"); top.Controls.Add(category, 0, 0);
        var details = Link("额度明细  →"); details.LinkClicked += delegate { ShowQuotaDetails(); }; top.Controls.Add(details, 1, 0); layout.Controls.Add(top, 0, 0);
        var metrics = Columns(-1, -1, -1);
        quotaValue = Metric(metrics, 0, "剩余可用", 32); quotaValue.Name = "QuotaValue";
        quotaUsed = Metric(metrics, 1, "已经使用", 23); quotaUsed.Name = "QuotaUsed";
        quotaTotal = Metric(metrics, 2, "当前总额", 23); quotaTotal.Name = "QuotaTotal";
        layout.Controls.Add(metrics, 0, 1);
        progress = new NativeUsageBar { Name = "QuotaProgress", Dock = DockStyle.Fill, Margin = Padding.Empty }; layout.Controls.Add(progress, 0, 2);
        quotaRatios = Caption("额度比例待同步"); layout.Controls.Add(quotaRatios, 0, 3);
        quotaDetail = LabelFor("", Muted); quotaDetail.Font = Typeface(8.4F, FontStyle.Regular); layout.Controls.Add(quotaDetail, 0, 4);
        reset = Caption(""); layout.Controls.Add(reset, 0, 5); quota.Controls.Add(layout);

        var expanders = new Panel { Height = 34, Margin = new Padding(3, 0, 0, 8) }; var expandRow = Columns(-1, -1);
        other = Link("其他额度 ▸"); raw = Link("原始数值（单位待确认） ▸"); raw.TextAlign = ContentAlignment.MiddleRight;
        other.LinkClicked += delegate { ExpandOther(!expanded); }; raw.LinkClicked += delegate { ExpandRaw(!rawExpanded); };
        expandRow.Controls.Add(other, 0, 0); expandRow.Controls.Add(raw, 1, 0); expanders.Controls.Add(expandRow); page.Controls.Add(expanders);
        otherPanel = Card(page, 136); var categoryLayout = Rows(28, 35, 24);
        categoryLayout.Controls.Add(Caption("每种类别独立计量，不相加；选择后同步更新主额度。"), 0, 0);
        bucketChoice = new ComboBox { Name = "QuotaCategorySelector", AccessibleName = "额度类别", DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill, IntegralHeight = false, DropDownHeight = 200 };
        bucketChoice.SelectedIndexChanged += async delegate {
            if (suppress || busy || overview == null) return;
            var selected = bucketChoice.SelectedItem as NativeBucket;
            if (selected == null || selected.Key == quotaKey) return;
            quotaKey = selected.Key; quotaAccount = overview.ActiveId; PublishQuotaSelection(quotaAccount, quotaKey); generation++; loading = false; ClearQuota("正在读取所选额度类别…"); await LoadAsync(false);
        };
        categoryLayout.Controls.Add(bucketChoice, 0, 1); categoryLayout.Controls.Add(Caption("聊天、补全等无固定上限类别不视为账户总余额。"), 0, 2); otherPanel.Controls.Add(categoryLayout); otherPanel.Visible = false;
        rawPanel = Card(page, 160); rawPanel.SurfaceColor = Color.FromArgb(252, 246, 230);
        rawText = new TextBox { Name = "RawQuotaFields", AccessibleName = "允许展示的原始额度数值", Multiline = true, ReadOnly = true, BorderStyle = BorderStyle.None, BackColor = rawPanel.SurfaceColor, ForeColor = Ink, Dock = DockStyle.Fill, ScrollBars = ScrollBars.Vertical };
        rawPanel.Controls.Add(rawText); rawPanel.Visible = false;
        var local = Card(page, 124); var localLayout = Rows(29, -1);
        var localHeader = Columns(-1, 110); localHeader.Controls.Add(Title("本机用量"), 0, 0); var history = Link("查看记录  →"); history.LinkClicked += delegate { Navigate("records"); }; localHeader.Controls.Add(history, 1, 0);
        localSummary = LabelFor("尚未读取本机会话。", Muted); localSummary.AutoEllipsis = false; localLayout.Controls.Add(localHeader, 0, 0); localLayout.Controls.Add(localSummary, 0, 1); local.Controls.Add(localLayout);
        var modelCard = Card(page, 295); var modelsLayout = Rows(32, 33, -1);
        var modelHeader = Columns(-1, 110); modelHeader.Controls.Add(Title("账户可用模型"), 0, 0); var all = Link("查看全部  →"); all.LinkClicked += delegate { Navigate("models"); }; modelHeader.Controls.Add(all, 1, 0);
        modelSummary = Caption("模型权限待验证；登录成功不会自动授予模型权限。"); overviewModels = Grid("模型", "访问状态", "能力"); overviewModels.Name = "OverviewModels";
        overviewModels.CellDoubleClick += delegate(object sender, DataGridViewCellEventArgs e) { ShowModelFrom(overviewModels, e.RowIndex); };
        modelsLayout.Controls.Add(modelHeader, 0, 0); modelsLayout.Controls.Add(modelSummary, 0, 1); modelsLayout.Controls.Add(overviewModels, 0, 2); modelCard.Controls.Add(modelsLayout);
        var scope = Caption("数据来源：Copilot CLI 当前账户额度。账户额度与组织／企业月度账单分别核对；本机记录仅覆盖通过 PilotMeter 启动的会话。");
        scope.Height = 54; scope.Dock = DockStyle.None; scope.AutoEllipsis = false; scope.Margin = new Padding(4, 0, 4, 12); page.Controls.Add(scope);
    }

    private void BuildModels()
    {
        var page = Page("models"); var card = Card(page, 620); var layout = Rows(45, 65, -1, 40);
        var tools = Columns(74, -1, 16, 180); modelSearch = new TextBox { Name = "ModelSearch", AccessibleName = "搜索模型名称或标识", Dock = DockStyle.Fill, Margin = new Padding(0, 7, 0, 0) };
        tips.SetToolTip(modelSearch, "按模型名称或标识搜索"); modelFilter = new ComboBox { Name = "ModelFilter", AccessibleName = "模型访问状态筛选", Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList, Margin = new Padding(0, 7, 0, 0) };
        modelFilter.Items.AddRange(new object[] { "全部状态", "可用", "已禁用", "待验证" }); modelFilter.SelectedIndex = 0;
        modelSearch.TextChanged += delegate { RenderModels(); }; modelFilter.SelectedIndexChanged += delegate { RenderModels(); };
        tools.Controls.Add(Caption("搜索模型"), 0, 0); tools.Controls.Add(modelSearch, 1, 0); tools.Controls.Add(modelFilter, 3, 0); layout.Controls.Add(tools, 0, 0);
        modelState = LabelFor("尚未取得当前账户的模型目录与访问状态。", Muted); modelState.AutoEllipsis = false; layout.Controls.Add(modelState, 0, 1);
        modelsGrid = Grid("模型", "访问状态", "支持能力", "计费倍率"); modelsGrid.Name = "AvailableModels"; modelsGrid.Columns[0].FillWeight = 130; modelsGrid.Columns[2].FillWeight = 130; modelsGrid.Columns[3].FillWeight = 65;
        modelsGrid.CellDoubleClick += delegate(object sender, DataGridViewCellEventArgs e) { ShowModelFrom(modelsGrid, e.RowIndex); };
        modelsGrid.KeyDown += delegate(object sender, KeyEventArgs e) { if (e.KeyCode == Keys.Enter && modelsGrid.CurrentRow != null) { e.Handled = true; ShowModelFrom(modelsGrid, modelsGrid.CurrentRow.Index); } };
        layout.Controls.Add(modelsGrid, 0, 2); layout.Controls.Add(Caption("双击或按 Enter 查看来源、策略和验证时间。模型共享账户额度，没有独立模型余额。"), 0, 3); card.Controls.Add(layout);
    }

    private void BuildRecords()
    {
        var page = Page("records"); var card = Card(page, 630); var layout = Rows(43, 66, -1, 36, 40);
        var tools = Columns(175, 20, 175, -1); recordMonth = new DateTimePicker { Name = "RecordMonth", AccessibleName = "记录月份", Dock = DockStyle.Fill, Format = DateTimePickerFormat.Custom, CustomFormat = "yyyy 年 MM 月", ShowUpDown = true, Margin = new Padding(0, 5, 0, 0), Value = DateTime.Now };
        recordSort = new ComboBox { Name = "RecordSort", AccessibleName = "记录排序", Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList, Margin = new Padding(0, 5, 0, 0) };
        recordSort.Items.AddRange(new object[] { "最近更新优先", "已知用量优先" }); recordSort.SelectedIndex = 0;
        tools.Controls.Add(recordMonth, 0, 0); tools.Controls.Add(recordSort, 2, 0); layout.Controls.Add(tools, 0, 0);
        recordScope = LabelFor("只展示本地留存记录；它们不等于整个账户或组织的账单。", Muted); recordScope.AutoEllipsis = false; layout.Controls.Add(recordScope, 0, 1);
        recordsGrid = Grid("最后活动", "使用模型", "本机消耗", "调用状态"); recordsGrid.Name = "UsageRecords"; recordsGrid.Columns[1].FillWeight = 145;
        recordsGrid.CellDoubleClick += delegate(object sender, DataGridViewCellEventArgs e) { ShowRecord(e.RowIndex); };
        recordsGrid.KeyDown += delegate(object sender, KeyEventArgs e) { if (e.KeyCode == Keys.Enter && recordsGrid.CurrentRow != null) { e.Handled = true; ShowRecord(recordsGrid.CurrentRow.Index); } };
        layout.Controls.Add(recordsGrid, 0, 2); recordState = Caption("尚未读取记录。"); layout.Controls.Add(recordState, 0, 3);
        loadMore = ButtonFor("加载更多记录"); loadMore.Name = "LoadMoreRecords"; loadMore.Enabled = false; layout.Controls.Add(loadMore, 0, 4); card.Controls.Add(layout);
        loadMore.Click += async delegate { await LoadRecordsAsync(true); };
        recordMonth.ValueChanged += async delegate { ResetRecords(); await LoadRecordsAsync(false); };
        recordSort.SelectedIndexChanged += async delegate { ResetRecords(); await LoadRecordsAsync(false); };
        var note = Caption("记录中的模型是实际观测到的使用历史，不构成当前可用模型授权。没有验证计量单位的记录不会显示成 AI Credits。\n尚未归属或仍在等待结束的调用会保留状态，不按零消耗处理。");
        note.Dock = DockStyle.None; note.Height = 62; note.AutoEllipsis = false; page.Controls.Add(note);
    }

    private void BuildAccounts()
    {
        var page = Page("accounts"); var card = Card(page, 330); var layout = Rows(35, 50, -1, 42);
        var titleRow = Columns(-1, 118); titleRow.Controls.Add(Title("已连接的 GitHub 账号"), 0, 0); add = ButtonFor("添加账号"); add.Name = "AddAccount"; add.Click += delegate { OpenLogin(false); }; titleRow.Controls.Add(add, 1, 0); layout.Controls.Add(titleRow, 0, 0);
        accountHint = LabelFor("连接个人或工作账号。身份、额度和模型权限分别验证。", Muted); accountHint.AutoEllipsis = false; layout.Controls.Add(accountHint, 0, 1);
        accountsGrid = Grid("账号", "连接状态", "当前账户"); accountsGrid.Name = "ConnectedAccounts"; accountsGrid.Columns[0].FillWeight = 170;
        accountsGrid.CellDoubleClick += async delegate(object sender, DataGridViewCellEventArgs e) { if (e.RowIndex >= 0 && accountsGrid.Rows[e.RowIndex].Tag is NativeAccount) await SelectAccountAsync(((NativeAccount)accountsGrid.Rows[e.RowIndex].Tag).Id); };
        accountsGrid.KeyDown += async delegate(object sender, KeyEventArgs e) { if (e.KeyCode == Keys.Enter && accountsGrid.CurrentRow != null) { e.Handled = true; var selected = accountsGrid.CurrentRow.Tag as NativeAccount; if (selected != null) await SelectAccountAsync(selected.Id); } };
        layout.Controls.Add(accountsGrid, 0, 2); var actions = Columns(-1, 142, 12, 142);
        actions.Controls.Add(Caption("双击账号或按 Enter 切换"), 0, 0); accountReauth = ButtonFor("重新登录当前账号"); accountRemove = ButtonFor("移除当前账号…");
        accountReauth.Click += delegate { OpenLogin(true); }; accountRemove.Click += async delegate { await RemoveAsync(); };
        actions.Controls.Add(accountReauth, 1, 0); actions.Controls.Add(accountRemove, 3, 0); layout.Controls.Add(actions, 0, 3); card.Controls.Add(layout);

        var pets = Card(page, 444); var petLayout = Rows(34, 40, 234, 58, 28); petLayout.Controls.Add(Title("选择你的桌面伙伴"), 0, 0);
        petHint = LabelFor("10 个角色，选择后立即更新桌面宠物。", Muted); petLayout.Controls.Add(petHint, 0, 1);
        var choices = new TableLayoutPanel { Name = "PetSelector", Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 5, Margin = Padding.Empty };
        for (var col = 0; col < 5; col++) choices.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 20));
        choices.RowStyles.Add(new RowStyle(SizeType.Percent, 50)); choices.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        var index = 0;
        foreach (var pet in DesktopPetCatalog.All)
        {
            var definition = pet; var button = ButtonFor(pet.Name); button.Name = "SelectPet" + pet.Id; button.AccessibleName = "选择宠物 " + pet.Name;
            button.Margin = new Padding(4); button.TextImageRelation = TextImageRelation.ImageAboveText; button.ImageAlign = ContentAlignment.MiddleCenter; button.TextAlign = ContentAlignment.BottomCenter;
            button.Font = Typeface(8.2F, FontStyle.Regular); button.Image = PetThumbnail(pet.Id, 62); petImages.Add(button.Image); tips.SetToolTip(button, pet.Description); button.Tag = pet.Id;
            button.Click += delegate { if (petPreferences != null) petPreferences.SelectPet(definition.Id); };
            choices.Controls.Add(button, index % 5, index / 5); petButtons.Add(button); index++;
        }
        petLayout.Controls.Add(choices, 0, 2);
        var settings = Columns(110, -1, 115, 115); petSizeLabel = Caption("宠物大小 96 px"); petSize = new TrackBar { Name = "PetSize", AccessibleName = "宠物大小，逻辑像素", Dock = DockStyle.Fill, Minimum = 64, Maximum = 160, TickFrequency = 24, SmallChange = 8, LargeChange = 16, Value = 96, Margin = new Padding(0, 6, 10, 0) };
        petMotion = new CheckBox { Name = "PetMotion", Text = "轻微动效", Dock = DockStyle.Fill, ForeColor = Ink }; petTop = new CheckBox { Name = "PetAlwaysOnTop", Text = "保持置顶", Dock = DockStyle.Fill, ForeColor = Ink };
        settings.Controls.Add(petSizeLabel, 0, 0); settings.Controls.Add(petSize, 1, 0); settings.Controls.Add(petMotion, 2, 0); settings.Controls.Add(petTop, 3, 0); petLayout.Controls.Add(settings, 0, 3);
        petLayout.Controls.Add(Caption("拖动宠物可调整位置，点击宠物打开主窗口。关闭此窗口后，宠物和服务继续运行。"), 0, 4); pets.Controls.Add(petLayout);
        petSize.ValueChanged += delegate { if (!suppressPets && petPreferences != null) petPreferences.SetSize(petSize.Value); };
        petMotion.CheckedChanged += delegate { if (!suppressPets && petPreferences != null) petPreferences.SetMotion(petMotion.Checked); };
        petTop.CheckedChanged += delegate { if (!suppressPets && petPreferences != null) petPreferences.SetAlwaysOnTop(petTop.Checked); };
        ApplyPetPreferences();
    }

    private static Bitmap PetThumbnail(string id, int size)
    {
        using (var source = DesktopPetCatalog.CreateBitmap(id))
        {
            var bitmap = new Bitmap(size, size);
            using (var graphics = Graphics.FromImage(bitmap)) { graphics.InterpolationMode = InterpolationMode.HighQualityBicubic; graphics.DrawImage(source, 0, 0, size, size); }
            return bitmap;
        }
    }

    internal void SetPetPreferences(DesktopPetPreferences preferences)
    {
        if (petPreferences != null) petPreferences.Changed -= PetPreferencesChanged;
        petPreferences = preferences;
        if (petPreferences != null) petPreferences.Changed += PetPreferencesChanged;
        ApplyPetPreferences();
    }

    internal void RestoreQuotaSelection(string accountId, string key)
    {
        if (disposed || accountId == null || key == null) return;
        if (!Regex.IsMatch(accountId, @"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$") || !Regex.IsMatch(key, @"^[A-Za-z][A-Za-z0-9_-]{0,63}$")) return;
        quotaAccount = accountId; quotaKey = key;
        PublishQuotaSelection(accountId, key);
    }

    private void PublishQuotaSelection(string accountId, string key, bool force = false)
    {
        if (!force && publishedAccount == accountId && publishedKey == key) return;
        publishedAccount = accountId; publishedKey = key;
        var handler = QuotaSelectionChanged; if (handler != null) handler(this, new NativeQuotaSelectionEventArgs(accountId, key));
    }

    private void PetPreferencesChanged(object sender, EventArgs e)
    {
        if (disposed) return;
        if (InvokeRequired) { if (IsHandleCreated) BeginInvoke(new Action(ApplyPetPreferences)); return; }
        ApplyPetPreferences();
    }

    private void ApplyPetPreferences()
    {
        if (disposed || petSize == null) return;
        suppressPets = true;
        try
        {
            foreach (var button in petButtons)
            {
                var selected = petPreferences != null && (string)button.Tag == petPreferences.PetId;
                button.Enabled = petPreferences != null; button.BackColor = selected ? Color.FromArgb(230, 239, 218) : Color.White;
                button.FlatAppearance.BorderColor = selected ? Accent : Color.FromArgb(221, 229, 215); button.FlatAppearance.BorderSize = selected ? 2 : 1;
            }
            petSize.Enabled = petMotion.Enabled = petTop.Enabled = petPreferences != null;
            if (petPreferences == null) return;
            petSize.Value = Math.Max(64, Math.Min(160, petPreferences.SizePixels)); petMotion.Checked = petPreferences.MotionEnabled; petTop.Checked = petPreferences.AlwaysOnTop;
            petSizeLabel.Text = "宠物大小 " + petSize.Value + " px";
            string name = petPreferences.PetId;
            foreach (var pet in DesktopPetCatalog.All) if (pet.Id == petPreferences.PetId) name = pet.Name;
            petHint.Text = "当前伙伴：" + name + "。" + (String.IsNullOrEmpty(petPreferences.PersistenceWarning) ? "选择已保存在本机，立即生效。" : NativeData.Clean(petPreferences.PersistenceWarning, 300));
            tips.SetToolTip(petHint, petHint.Text);
            var old = petPreview.Image; petPreview.Image = PetThumbnail(petPreferences.PetId, 100); if (old != null) old.Dispose();
        }
        finally { suppressPets = false; }
    }

    private async void Navigate(string page)
    {
        if (disposed || !pages.ContainsKey(page)) return;
        currentPage = page;
        foreach (var item in pages) item.Value.Visible = item.Key == page;
        foreach (var item in navigation) { item.Value.BackColor = item.Key == page ? Color.FromArgb(223, 233, 208) : Color.FromArgb(242, 246, 234); item.Value.ForeColor = item.Key == page ? Ink : Muted; }
        var titles = new Dictionary<string, string[]> {
            { "overview", new[] { "用量概览", "YOUR COPILOT, AT A GLANCE", "了解当前额度，找到适合下一项任务的模型。" } },
            { "models", new[] { "可用模型", "A MODEL FOR YOUR NEXT IDEA", "查看当前账号实际返回的模型目录与访问状态。" } },
            { "records", new[] { "用量记录", "KNOW WHERE YOUR CREDITS GO", "本机留存的会话记录，按月份与账号分别查看。" } },
            { "accounts", new[] { "我的账号", "YOUR ACCOUNTS, IN ONE PLACE", "管理工作与个人账号，挑选陪你工作的桌面伙伴。" } }
        };
        pageTitle.Text = titles[page][0]; breadcrumb.Text = titles[page][1]; pageSubtitle.Text = titles[page][2];
        if (page == "records" && !recordsLoaded) await LoadRecordsAsync(false);
    }

    private bool CanRead { get { return !disposed && Visible && WindowState != FormWindowState.Minimized && api != null && loginDialog == null; } }
    private void UpdatePolling() { if (timer != null) { if (CanRead) timer.Start(); else timer.Stop(); } }

    internal void SetService(DesktopInstance instance, string explanation)
    {
        if (disposed || instance != null && instance.SameAs(service) && api != null) return;
        generation++; loading = busy = AccountMutationPending = false;
        if (loginDialog != null) loginDialog.Disconnect();
        if (api != null) api.Dispose();
        api = null; service = instance; overview = null; quotaKey = quotaAccount = accountSignature = accountsGridSignature = modelsSignature = networkError = null;
        suppress = true; accounts.Items.Clear(); suppress = false; accountsGrid.Rows.Clear();
        ResetRecords(); RenderModels(); ClearQuota(instance == null ? explanation ?? "本机服务未连接。" : "正在读取当前账号…");
        accountStatus.Text = instance == null ? "本机服务离线" : "正在连接…"; synced.Text = "尚未同步"; feedback.Text = ""; localSummary.Text = "尚未读取本机会话。";
        nextRefresh = DateTime.MinValue;
        if (instance != null) api = new DesktopNativeApi(instance);
        UpdateControls(); UpdatePolling();
        if (CanRead) BeginInvoke(new Action(async delegate { await LoadAsync(true); }));
    }

    private void ClearQuota(string description)
    {
        category.Text = "当前账户额度"; quotaCaption.Text = "剩余可用"; quotaValue.Text = quotaUsed.Text = quotaTotal.Text = "—"; quotaUnit.Text = quotaUsedUnit.Text = quotaTotalUnit.Text = "";
        progress.Percentage = null; quotaRatios.Text = "额度比例待同步"; quotaDetail.Text = NativeData.Clean(description, 400); reset.Text = "";
        tips.SetToolTip(quotaDetail, quotaDetail.Text); rawText.Text = ""; raw.Visible = other.Visible = false;
        ExpandRaw(false); ExpandOther(false);
        suppress = true; bucketChoice.Items.Clear(); suppress = false;
    }

    private void UpdateControls()
    {
        if (disposed || add == null) return;
        var ready = api != null && overview != null && overview.Enabled && !busy && loginDialog == null;
        accounts.Enabled = ready && overview.Accounts.Count > 0; add.Enabled = ready;
        add.Text = overview != null && overview.Login != null && overview.Login.Active ? "继续登录" : overview != null && overview.Accounts.Count == 0 ? "登录 GitHub" : "添加账号";
        var selected = ready && overview.Active != null;
        accountSettings.Enabled = selected; accountReauth.Enabled = selected && !(overview.Login != null && overview.Login.Active); accountRemove.Enabled = selected;
        if (reauthenticate != null) { reauthenticate.Enabled = accountReauth.Enabled; remove.Enabled = selected; }
        refresh.Enabled = !busy && !loading && loginDialog == null; refresh.Text = api == null ? "重试连接" : busy ? "同步中…" : "刷新数据";
        bucketChoice.Enabled = !busy && !loading; accountsGrid.Enabled = ready;
        loadMore.Enabled = !busy && !recordsLoading && recordsCursor != null && api != null;
    }

    private async Task<NativeOverview> ReadOverviewAsync(DesktopNativeApi client, DesktopInstance identity, int current)
    {
        var key = quotaKey;
        var query = key == null ? "" : "?quotaKey=" + Uri.EscapeDataString(key) + (quotaAccount == null ? "" : "&accountId=" + quotaAccount);
        var result = NativeOverview.Read(await client.RequestAsync("/api/desktop" + query), identity);
        if (current != generation || disposed) return null;
        if (key != null && result.ActiveId != quotaAccount) { quotaKey = quotaAccount = null; result = NativeOverview.Read(await client.RequestAsync("/api/desktop"), identity); }
        return current == generation && !disposed ? result : null;
    }

    private async Task LoadAsync(bool autoRefresh)
    {
        if (!CanRead || loading || busy) return;
        var current = generation; var client = api; var identity = service; loading = true;
        bool refreshDue = false;
        try
        {
            var result = await ReadOverviewAsync(client, identity, current); if (result == null) return;
            networkError = null; ApplyOverview(result);
            refreshDue = autoRefresh && result.Enabled && result.Active != null && !result.Refreshing && DateTime.UtcNow >= nextRefresh;
        }
        catch (Exception error)
        {
            if (current != generation || disposed) return;
            networkError = NativeData.Error(error);
            if (overview != null) ApplyOverview(overview); else { ClearQuota("暂时无法读取账户，请刷新重试。"); RenderModels(); }
            feedback.Text = "同步失败 · " + networkError; tips.SetToolTip(feedback, feedback.Text);
            // A server-side selection change must not trap the reader behind a
            // stale category/account query; the next poll resolves its identity.
            quotaKey = quotaAccount = null;
        }
        finally { if (current == generation && !disposed) { loading = false; UpdateControls(); } }
        if (refreshDue && current == generation && CanRead) await ChangeAsync("/api/auth/refresh", "POST", null, "正在同步额度和模型权限…");
        else if (current == generation && currentPage == "records" && !recordsLoaded) await LoadRecordsAsync(false);
    }

    private async Task ChangeAsync(string path, string method, Dictionary<string, object> payload, string description)
    {
        if (api == null || busy || disposed || loginDialog != null) return;
        var current = ++generation; var client = api; var identity = service; var refreshOnly = path == "/api/auth/refresh";
        busy = true; loading = false; nextRefresh = DateTime.UtcNow.AddMinutes(1);
        if (!refreshOnly)
        {
            AccountMutationPending = true;
            object selectedId; var targetAccount = payload != null && payload.TryGetValue("accountId", out selectedId) ? selectedId as string : null;
            PublishQuotaSelection(targetAccount, null, true);
            ClearQuota(description); ResetRecords(); modelsSignature = null; modelsGrid.Rows.Clear(); overviewModels.Rows.Clear(); modelState.Text = description; localSummary.Text = description;
        }
        feedback.Text = description; UpdateControls();
        try
        {
            await client.RequestAsync(path, method, payload); if (current != generation || disposed) return;
            var result = await ReadOverviewAsync(client, identity, current);
            if (result != null) { networkError = null; ApplyOverview(result); }
        }
        catch (Exception error)
        {
            if (current != generation || disposed) return;
            networkError = NativeData.Error(error);
            if (refreshOnly && overview != null) ApplyOverview(overview);
            else { overview = null; ClearQuota("操作尚未确认，请刷新后重试。"); RenderModels(); }
            feedback.Text = "操作未完成 · " + networkError; tips.SetToolTip(feedback, feedback.Text);
        }
        finally {
            if (current == generation && !disposed)
            {
                busy = false;
                if (!refreshOnly) { AccountMutationPending = false; PublishQuotaSelection(overview == null ? null : overview.ActiveId, quotaKey, true); }
                UpdateControls();
            }
        }
        if (current == generation && currentPage == "records") await LoadRecordsAsync(false);
    }

    private void ApplyOverview(NativeOverview result)
    {
        var changed = overview == null || overview.ActiveId != result.ActiveId; overview = result;
        if (quotaAccount != result.ActiveId) quotaKey = quotaAccount = null;
        if (quotaKey != null && (result.Primary == null || result.Primary.Key != quotaKey)) quotaKey = quotaAccount = null;
        PublishQuotaSelection(result.ActiveId, quotaKey);
        if (changed) ResetRecords();
        var signature = String.Join("|", result.Accounts.ConvertAll(delegate(NativeAccount account) { return account.Id + ":" + account.Login + ":" + account.Host + ":" + account.Status; }).ToArray());
        suppress = true;
        if (accountSignature != signature) { accounts.Items.Clear(); accounts.Items.Add(new NativeAccount()); foreach (var account in result.Accounts) accounts.Items.Add(account); accountSignature = signature; }
        accounts.SelectedIndex = 0;
        for (var index = 1; index < accounts.Items.Count; index++) if (((NativeAccount)accounts.Items[index]).Id == result.ActiveId) accounts.SelectedIndex = index;
        suppress = false;
        var active = result.Active;
        accountStatus.Text = active == null ? "连接你的个人或工作账号" : active.Status == "reauth-required" ? "登录已失效 · 请重新登录" : active.Status == "error" ? "账号连接异常" : "当前账号 · " + active.Login;
        synced.Text = "上次同步  " + NativeDisplay.Time(result.FetchedAt);
        feedback.Text = networkError != null ? "同步失败 · 当前展示上次读取的数据" : result.Refreshing ? "正在同步额度与模型权限…" : result.Stale ? "旧快照 · 等待最新数据" : "";
        accountHint.Text = !result.Enabled ? "当前服务未启用真实账号操作。" : active == null ? "连接 GitHub 后分别验证身份、额度和模型权限。" : "当前账号：" + active.Login + "。切换账号后，额度、模型与记录同步切换。";
        if (active == null) ClearQuota("登录或选择一个 GitHub 账号，查看 Copilot 额度。");
        else if (active.Status != "connected") ClearQuota("当前账号需要重新验证，请在账户页重新登录。");
        else if (!result.CanDisplaySnapshot) ClearQuota(result.QuotaError ?? "尚未取得当前账户额度，请刷新。");
        else RenderQuota(result);
        if (accountsGridSignature != signature + ":" + result.ActiveId)
        {
            accountsGrid.Rows.Clear();
            foreach (var account in result.Accounts)
            {
                var row = accountsGrid.Rows[accountsGrid.Rows.Add(account.Login + "\n" + new Uri(account.Host).Host, account.Status == "connected" ? "已连接" : account.Status == "reauth-required" ? "需要重新登录" : "连接异常", account.Id == result.ActiveId ? "当前账号" : "双击切换")]; row.Tag = account;
            }
            accountsGridSignature = signature + ":" + result.ActiveId;
        }
        var local = result.Local;
        localSummary.Text = local == null ? "暂无本机会话数据。通过 PilotMeter 启动的 Copilot 会话才会进入此处。" : local.Scope + "\n" + local.Period + " · " + local.SessionCount + " 个会话 · " + (local.UnitVerified && local.Credits != null ? NativeDisplay.Amount(local.Credits) + " AI Credits" : "数量单位待确认") + " · " + local.UnknownCalls + " 次未知消耗 · " + local.PendingCalls + " 次等待结束";
        tips.SetToolTip(localSummary, localSummary.Text);
        RenderModels(); UpdateControls();
    }

    private void RenderQuota(NativeOverview result)
    {
        var bucket = result.Primary;
        if (bucket == null) { ClearQuota("请选择要查看的额度类别。各类别独立计量。"); }
        else
        {
            category.Text = bucket.Label + " · 当前账户额度"; quotaUnit.Text = quotaUsedUnit.Text = quotaTotalUnit.Text = bucket.UnitLabel;
            quotaCaption.Text = bucket.Unlimited ? "当前额度" : bucket.Remaining != null ? "剩余可用" : bucket.RemainingPercentage.HasValue ? "剩余比例" : "已用比例";
            quotaValue.Text = bucket.Unlimited ? "无固定上限" : bucket.Remaining != null ? NativeDisplay.CompactAmount(bucket.Remaining) : bucket.RemainingPercentage.HasValue ? NativeDisplay.ExactPercentage(bucket.RemainingPercentageText) : NativeDisplay.Percentage(bucket.Percentage);
            quotaUsed.Text = NativeDisplay.CompactAmount(bucket.Used); quotaTotal.Text = bucket.Unlimited ? "无固定上限" : NativeDisplay.CompactAmount(bucket.Limit);
            if (bucket.Remaining != null) { tips.SetToolTip(quotaValue, NativeDisplay.Amount(bucket.Remaining)); quotaValue.AccessibleDescription = NativeDisplay.Amount(bucket.Remaining); }
            tips.SetToolTip(quotaUsed, NativeDisplay.Amount(bucket.Used)); quotaUsed.AccessibleDescription = NativeDisplay.Amount(bucket.Used);
            tips.SetToolTip(quotaTotal, bucket.Unlimited ? "无固定上限" : NativeDisplay.Amount(bucket.Limit)); quotaTotal.AccessibleDescription = bucket.Unlimited ? "无固定上限" : NativeDisplay.Amount(bucket.Limit);
            progress.Percentage = bucket.Percentage;
            quotaRatios.Text = bucket.Unlimited ? "此类别无固定上限，不与其他额度相加。" : "已用 " + NativeDisplay.Percentage(bucket.Percentage) + "    ·    剩余 " + NativeDisplay.ExactPercentage(bucket.RemainingPercentageText);
            var stale = result.Stale || networkError != null;
            quotaDetail.Text = (stale ? "旧快照 · " + NativeDisplay.Time(result.FetchedAt) + " · " : "") + (bucket.Unit == "unspecified" ? "单位待确认；可展开 GitHub 返回的原始计量值。" : bucket.Overage != null && bucket.Overage != "0" ? "已超出固定额度 " + NativeDisplay.Amount(bucket.Overage) + " " + bucket.UnitLabel : "同一账户、同一额度类别；与组织／企业月度账单独立。");
            quotaDetail.ForeColor = stale || bucket.Unit == "unspecified" ? Color.FromArgb(145, 105, 41) : Muted; tips.SetToolTip(quotaDetail, quotaDetail.Text);
            var date = NativeData.Date(bucket.NextResetAt); reset.Text = date.HasValue && date.Value > DateTimeOffset.UtcNow ? "下次重置  " + NativeDisplay.Time(bucket.NextResetAt) : "重置时间待确认";
            raw.Visible = bucket.Unit == "unspecified"; rawText.Text = RawValues(bucket); if (!raw.Visible) ExpandRaw(false);
        }
        other.Visible = result.Buckets.Count > 1 || result.Primary == null && result.Buckets.Count > 0;
        suppress = true; bucketChoice.Items.Clear(); foreach (var item in result.Buckets) bucketChoice.Items.Add(item);
        bucketChoice.SelectedIndex = -1; for (var index = 0; index < bucketChoice.Items.Count; index++) if (bucket != null && ((NativeBucket)bucketChoice.Items[index]).Key == bucket.Key) bucketChoice.SelectedIndex = index;
        suppress = false;
        if (!other.Visible) ExpandOther(false); else if (bucket == null) ExpandOther(true);
    }

    private static string RawValues(NativeBucket bucket)
    {
        return "单位待确认 · 仅展示允许公开的数值字段\r\n原始已用 (used)：" + NativeDisplay.Amount(bucket.RawUsed) + "\r\n原始总额 (limit)：" + NativeDisplay.Amount(bucket.RawLimit) + "\r\n返回剩余比例 (remainingPercentage)：" + (bucket.RawRemainingPercentage ?? "—") + "\r\n这些原始数值不能标作 AI Credits 或请求次数。";
    }

    private void ExpandOther(bool show) { expanded = show; otherPanel.Visible = show; other.Text = (overview != null && overview.Primary == null ? "选择额度类别" : "其他额度") + (show ? " ▾" : " ▸"); }
    private void ExpandRaw(bool show) { rawExpanded = show; rawPanel.Visible = show; raw.Text = "原始数值（单位待确认）" + (show ? " ▾" : " ▸"); }

    private void RenderModels()
    {
        if (modelsGrid == null || overviewModels == null) return;
        var catalog = overview == null ? null : overview.Models;
        if (catalog == null || overview.Active == null || overview.Active.Status != "connected")
        {
            modelsSignature = null; modelsGrid.Rows.Clear(); overviewModels.Rows.Clear();
            modelState.Text = "尚未取得当前账户的模型目录。登录成功不等于所有模型可用。"; modelSummary.Text = "模型访问状态待验证；请连接账号并同步。"; return;
        }
        var stale = catalog.Stale || networkError != null; var available = 0; var shown = 0;
        var search = modelSearch.Text.Trim(); var filters = new[] { "", "available", "disabled", "unknown" }; var filter = filters[Math.Max(0, modelFilter.SelectedIndex)];
        var signature = catalog.AccountId + "|" + catalog.FetchedAt + "|" + stale + "|" + catalog.Error + "|" + filter + "|" + search;
        foreach (var item in catalog.Items) signature += "\n" + item.Id + "|" + item.Name + "|" + item.Status + "|" + item.Reason + "|" + item.Capabilities + "|" + item.Multiplier;
        if (signature == modelsSignature) return;
        modelsSignature = signature; modelsGrid.Rows.Clear(); overviewModels.Rows.Clear();
        foreach (var model in catalog.Items)
        {
            if (model.Status == "available") available++;
            if (overviewModels.Rows.Count < 4 && model.Status == "available") { var preview = overviewModels.Rows[overviewModels.Rows.Add(model.Name, NativeDisplay.ModelStatus(model, stale), model.Capabilities)]; preview.Tag = model; }
            if (filter.Length > 0 && model.Status != filter || search.Length > 0 && model.Name.IndexOf(search, StringComparison.OrdinalIgnoreCase) < 0 && model.Id.IndexOf(search, StringComparison.OrdinalIgnoreCase) < 0) continue;
            var row = modelsGrid.Rows[modelsGrid.Rows.Add(model.Name, NativeDisplay.ModelStatus(model, stale), model.Capabilities, model.Multiplier == null ? "未返回" : model.Multiplier + "×")]; row.Tag = model;
            row.Cells[1].Style.ForeColor = model.Status == "available" && !stale ? Accent : model.Status == "disabled" ? Muted : Color.FromArgb(145, 105, 41); shown++;
        }
        modelSummary.Text = (stale ? "上次目录返回 " : "目录返回 ") + available + " 个可用模型 · " + NativeDisplay.Time(catalog.FetchedAt);
        modelState.Text = (stale ? "旧目录快照 · " : "账户模型目录 · ") + NativeDisplay.Time(catalog.FetchedAt) + " · 共 " + catalog.Items.Count + " 个模型" + (shown == 0 ? "\n没有符合筛选条件的模型。" : "\n来源：Copilot CLI 的当前账户模型目录与策略。") + (String.IsNullOrEmpty(catalog.Error) ? "" : " " + catalog.Error);
        tips.SetToolTip(modelState, modelState.Text);
    }

    private void ResetRecords()
    {
        recordsGeneration++; recordsLoading = false; recordsLoaded = false; recordsCursor = null; recordsAccount = null; recordItems.Clear();
        if (recordsGrid != null) recordsGrid.Rows.Clear(); if (recordState != null) recordState.Text = "记录待同步。"; if (loadMore != null) loadMore.Enabled = false;
    }

    private async Task LoadRecordsAsync(bool append)
    {
        if (!CanRead || overview == null || busy || recordsLoading || append && recordsCursor == null) return;
        var current = ++recordsGeneration; var account = overview.ActiveId; var identity = service; var client = api;
        var period = recordMonth.Value.ToString("yyyy-MM", CultureInfo.InvariantCulture); var sort = recordSort.SelectedIndex == 1 ? "usage" : "recent";
        var cursor = append ? recordsCursor : null; recordsLoading = true; loadMore.Enabled = false; recordState.Text = "正在读取本机记录…";
        if (!append) { recordItems.Clear(); recordsGrid.Rows.Clear(); recordsCursor = null; }
        try
        {
            var path = "/api/desktop/records?period=" + period + "&sort=" + sort + (account == null ? "" : "&accountId=" + account) + (cursor == null ? "" : "&cursor=" + Uri.EscapeDataString(cursor));
            var result = NativeRecords.Read(await client.RequestAsync(path), identity, account, period);
            if (disposed || current != recordsGeneration || overview == null || overview.ActiveId != account) return;
            var ids = new HashSet<string>(); foreach (var row in recordItems) ids.Add(row.Id);
            foreach (var row in result.Items) if (ids.Add(row.Id)) recordItems.Add(row);
            recordsAccount = account; recordsCursor = result.NextCursor; recordsLoaded = true;
            recordScope.Text = result.Scope + "\n" + period + " · 本机部分覆盖，不等于账户或组织的总账单。";
            recordsGrid.Rows.Clear();
            foreach (var row in recordItems)
            {
                var index = recordsGrid.Rows.Add(NativeDisplay.Time(row.LastSeen), row.Models.Count == 0 ? "未记录模型" : String.Join(" / ", row.Models.ToArray()), row.UnitVerified && row.Credits != null ? NativeDisplay.Amount(row.Credits) + " AI Credits" : "单位待确认", row.KnownCalls + " 已知 / " + row.UnknownCalls + " 未知\n" + row.PendingCalls + " 等待结束"); recordsGrid.Rows[index].Tag = row;
            }
            recordState.Text = recordItems.Count == 0 ? "此月份尚无留存的会话记录；没有记录不代表没有账户用量。" : "已显示 " + recordItems.Count + " 条会话 · 双击或按 Enter 查看详情";
        }
        catch (Exception error) { if (!disposed && current == recordsGeneration) { recordState.Text = "读取失败 · " + NativeData.Error(error); tips.SetToolTip(recordState, recordState.Text); } }
        finally { if (!disposed && current == recordsGeneration) { recordsLoading = false; UpdateControls(); } }
    }

    private async Task SelectAccountAsync(string id)
    {
        if (overview == null || id == overview.ActiveId || busy) return;
        quotaKey = quotaAccount = null; await ChangeAsync("/api/auth/select", "POST", new Dictionary<string, object> { { "accountId", id } }, "正在切换账号…");
    }

    private async Task RemoveAsync()
    {
        if (overview == null || overview.Active == null || busy) return;
        var account = overview.Active;
        if (MessageBox.Show(this, "移除 " + account.Login + " 的登录连接？\n本机用量记录会保留。", "移除账号", MessageBoxButtons.OKCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.OK) return;
        quotaKey = quotaAccount = null; await ChangeAsync("/api/auth/accounts/" + account.Id, "DELETE", null, "正在移除账号…");
    }

    private async void OpenLogin(bool reauth)
    {
        if (api == null || service == null || overview == null || !overview.Enabled || busy || loginDialog != null) return;
        var identity = service; var expected = reauth ? overview.Active : null; var pending = overview.Login != null && overview.Login.Active ? overview.Login : null;
        generation++; loading = false; timer.Stop(); AccountMutationPending = true; PublishQuotaSelection(overview.ActiveId, null, true);
        try
        {
            using (var dialog = new NativeLoginDialog(identity, expected, pending))
            {
                loginDialog = dialog; UpdateControls(); dialog.ShowDialog(this); loginDialog = null;
                if (disposed) return;
                if (service == null || !service.SameAs(identity)) { UpdateControls(); UpdatePolling(); if (CanRead) await LoadAsync(true); return; }
                generation++; overview = null; quotaKey = quotaAccount = null; nextRefresh = DateTime.MinValue; ResetRecords();
                ClearQuota(dialog.Succeeded ? "登录成功，正在读取额度与模型权限…" : "正在读取当前账号…"); RenderModels();
                await LoadAsync(true); if (!disposed && !String.IsNullOrEmpty(dialog.Feedback)) feedback.Text = dialog.Feedback;
            }
        }
        finally { if (!disposed) { AccountMutationPending = false; PublishQuotaSelection(overview == null ? null : overview.ActiveId, quotaKey, true); } }
        UpdateControls(); UpdatePolling();
    }

    private void ShowQuotaDetails()
    {
        if (overview == null || !overview.CanDisplaySnapshot || overview.Primary == null) { ShowDetails("额度明细", "当前没有可展示的额度快照。请连接账号并同步。"); return; }
        var bucket = overview.Primary;
        var text = "账户：" + overview.Active.Login + "\r\n类别：" + bucket.Label + "\r\n单位：" + bucket.UnitLabel + "\r\n总额：" + (bucket.Unlimited ? "无固定上限" : NativeDisplay.Amount(bucket.Limit)) + "\r\n已用：" + NativeDisplay.Amount(bucket.Used) + "\r\n剩余：" + NativeDisplay.Amount(bucket.Remaining) + "\r\n已用比例：" + NativeDisplay.Percentage(bucket.Percentage) + "\r\n剩余比例：" + NativeDisplay.ExactPercentage(bucket.RemainingPercentageText) + "\r\n同步时间：" + NativeDisplay.Time(overview.FetchedAt) + "\r\n状态：" + (overview.Stale || networkError != null ? "旧快照，等待同步" : "已同步") + "\r\n\r\n" + bucket.Detail;
        if (bucket.Unit == "unspecified") text += "\r\n\r\n" + RawValues(bucket);
        text += "\r\n\r\n绝对剩余量仅由同一快照、同一额度池的精确数量相减得出，不由百分比倒推。组织付费不代表此值是整个组织的总额度。";
        ShowDetails("额度明细", text);
    }

    private void ShowModelFrom(DataGridView grid, int index)
    {
        if (index < 0 || index >= grid.Rows.Count || overview == null || overview.Models == null) return;
        var item = grid.Rows[index].Tag as NativeModel; if (item == null) return;
        ShowDetails(item.Name, "模型标识：" + item.Id + "\r\n当前账户：" + overview.Active.Login + "\r\n状态：" + NativeDisplay.ModelStatus(item, overview.Models.Stale || networkError != null) + "\r\n原因：" + item.Reason + "\r\n策略：" + (item.PolicyState ?? "未返回") + "\r\n能力：" + item.Capabilities + "\r\n计费倍率：" + (item.Multiplier == null ? "未返回" : item.Multiplier + "×") + "\r\n验证时间：" + NativeDisplay.Time(overview.Models.FetchedAt) + "\r\n来源：Copilot CLI 当前账户的 models.list\r\n\r\n模型共享当前账户额度，不分配虚构的独立模型余额。缺少明确授权时保持待验证；接口失败不会被解释为策略禁用，策略禁用也不被自动归因为组织设置。");
    }

    private void ShowRecord(int index)
    {
        if (index < 0 || index >= recordsGrid.Rows.Count) return; var row = recordsGrid.Rows[index].Tag as NativeUsageRecord; if (row == null) return;
        ShowDetails("本机会话详情", "会话标识：" + row.SessionId + "\r\n开始时间：" + NativeDisplay.Time(row.FirstSeen) + "\r\n最后活动：" + NativeDisplay.Time(row.LastSeen) + "\r\n观测模型：" + (row.Models.Count == 0 ? "未知" : String.Join(" / ", row.Models.ToArray())) + "\r\n本机消耗：" + (row.UnitVerified && row.Credits != null ? NativeDisplay.Amount(row.Credits) + " AI Credits" : "单位待确认") + "\r\n已知消耗调用：" + row.KnownCalls + "\r\n未知消耗调用：" + row.UnknownCalls + "\r\n等待结束调用：" + row.PendingCalls + "\r\n\r\n来源：本机 OTel 留存记录。只覆盖通过 PilotMeter 启动的会话，不包含其他设备和所有平台的用量，不能代替账户或组织账单。");
    }

    private void ShowDetails(string title, string description)
    {
        using (var dialog = new NativeDetailsDialog(title, description)) dialog.ShowDialog(this);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !disposed)
        {
            disposed = true; generation++; recordsGeneration++;
            if (timer != null) { timer.Stop(); timer.Dispose(); } if (accountMenu != null) accountMenu.Dispose(); tips.Dispose();
            if (petPreferences != null) petPreferences.Changed -= PetPreferencesChanged;
            if (petPreview != null && petPreview.Image != null) { petPreview.Image.Dispose(); petPreview.Image = null; }
            foreach (var image in petImages) image.Dispose(); petImages.Clear();
            if (loginDialog != null) loginDialog.Disconnect(); if (api != null) api.Dispose();
        }
        base.Dispose(disposing);
    }
}

internal sealed class NativeDetailsDialog : NativeForm
{
    internal NativeDetailsDialog(string title, string description)
    {
        Text = title + " · PilotMeter"; ShowInTaskbar = false; StartPosition = FormStartPosition.CenterParent; MinimizeBox = false;
        FormBorderStyle = FormBorderStyle.Sizable; ClientSize = new Size(620, 480); MinimumSize = new Size(440, 350);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(26), ColumnCount = 1, RowCount = 3 };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 45));
        var heading = LabelFor(title, Ink); heading.Font = Typeface(17, FontStyle.Bold); layout.Controls.Add(heading, 0, 0);
        var body = new TextBox { Text = description, AccessibleName = title + "详细信息", Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, BackColor = BackColor, ForeColor = Ink, BorderStyle = BorderStyle.None, Margin = new Padding(0, 8, 0, 12) };
        layout.Controls.Add(body, 0, 1); var close = ButtonFor("完成"); close.DialogResult = DialogResult.OK; close.Dock = DockStyle.Right; close.Width = 110; layout.Controls.Add(close, 0, 2);
        AcceptButton = close; CancelButton = close; Controls.Add(layout);
    }
}
