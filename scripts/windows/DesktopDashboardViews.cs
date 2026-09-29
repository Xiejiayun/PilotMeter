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
        // Two bounded source decimals can produce a longer exact difference
        // when one has many integer digits and the other many fraction digits.
        var value = NativeData.Text(source, key, 512, true);
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

    internal static string ExactPercentage(string value)
    {
        return value == null ? "—" : value + "%";
    }

    internal static string UsageSource(NativeBucket bucket)
    {
        return bucket.UsageSource == "remaining" ? "按总额减剩余量计算" : "GitHub 返回值，精度依上游";
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
    internal Color BorderColor = Color.FromArgb(225, 231, 234);
    internal int Radius = 12;
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
        using (var path = Rounded(new RectangleF(.5F, .5F, Width - 1, Height - 1), Radius * e.Graphics.DpiX / 96F))
        using (var fill = new SolidBrush(SurfaceColor))
        using (var edge = new Pen(BorderColor)) { e.Graphics.FillPath(fill, path); e.Graphics.DrawPath(edge, path); }
    }
}

// Retain Button's keyboard, accessibility and click behavior while drawing a
// consistent rounded surface. Image buttons keep the platform's image layout.
internal sealed class NativeActionButton : Button
{
    private bool hovered, mousePressed, keyPressed;
    internal string NavigationIcon;
    internal NativeActionButton() { DoubleBuffered = true; }
    protected override void OnMouseEnter(EventArgs e) { hovered = Enabled; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hovered = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (Enabled && e.Button == MouseButtons.Left) { mousePressed = true; hovered = ClientRectangle.Contains(e.Location); }
        Invalidate(); base.OnMouseDown(e);
    }
    protected override void OnMouseUp(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left) mousePressed = false;
        Invalidate(); base.OnMouseUp(e);
    }
    protected override void OnMouseCaptureChanged(EventArgs e)
    {
        if (!Capture) mousePressed = false;
        Invalidate(); base.OnMouseCaptureChanged(e);
    }
    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (Enabled && e.KeyData == Keys.Space) keyPressed = true;
        Invalidate(); base.OnKeyDown(e);
        if (e.SuppressKeyPress) { keyPressed = false; Invalidate(); }
    }
    protected override void OnKeyUp(KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Space) keyPressed = false;
        Invalidate(); base.OnKeyUp(e);
    }
    protected override void OnLostFocus(EventArgs e)
    {
        mousePressed = keyPressed = false;
        Invalidate(); base.OnLostFocus(e);
    }
    protected override void OnEnabledChanged(EventArgs e)
    {
        if (!Enabled) hovered = mousePressed = keyPressed = false;
        Invalidate(); base.OnEnabledChanged(e);
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        if (Image != null) { base.OnPaint(e); return; }
        var scale = e.Graphics.DpiX / 96F;
        var primary = BackColor.GetBrightness() < .45F;
        var pressed = keyPressed || mousePressed && hovered;
        var background = !Enabled ? Color.FromArgb(241, 244, 246) : pressed ? (primary ? ControlPaint.Dark(BackColor, .08F) : Color.FromArgb(222, 235, 230)) : hovered ? (primary ? ControlPaint.Light(BackColor, .08F) : FlatAppearance.MouseOverBackColor) : BackColor;
        var backdrop = Color.White;
        for (var parent = Parent; parent != null; parent = parent.Parent)
        {
            var surface = parent as NativeSurface;
            if (surface != null) { backdrop = surface.SurfaceColor; break; }
            if (parent.BackColor.A == 255) { backdrop = parent.BackColor; break; }
        }
        e.Graphics.Clear(backdrop);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (var path = NativeSurface.Rounded(new RectangleF(.5F, .5F, Width - 1, Height - 1), 7 * scale))
        {
            using (var brush = new SolidBrush(background)) e.Graphics.FillPath(brush, path);
            if (FlatAppearance.BorderSize > 0 && !primary)
                using (var pen = new Pen(FlatAppearance.BorderColor)) e.Graphics.DrawPath(pen, path);
        }
        var color = Enabled ? ForeColor : Color.FromArgb(139, 150, 157);
        var bounds = new Rectangle(Padding.Left, Padding.Top, Width - Padding.Horizontal, Height - Padding.Vertical);
        if (NavigationIcon != null)
        {
            var box = new RectangleF(16 * scale, (Height - 16 * scale) / 2, 16 * scale, 16 * scale);
            using (var pen = new Pen(color, 1.4F * scale))
            {
                if (NavigationIcon == "overview") {
                    var step = 9 * scale; var side = 6 * scale;
                    for (var row = 0; row < 2; row++) for (var col = 0; col < 2; col++) e.Graphics.DrawRectangle(pen, box.X + col * step, box.Y + row * step, side, side);
                } else if (NavigationIcon == "models") {
                    e.Graphics.DrawEllipse(pen, box.X + 4 * scale, box.Y, 8 * scale, 8 * scale);
                    e.Graphics.DrawEllipse(pen, box.X, box.Y + 7 * scale, 8 * scale, 8 * scale);
                    e.Graphics.DrawEllipse(pen, box.X + 8 * scale, box.Y + 7 * scale, 8 * scale, 8 * scale);
                } else if (NavigationIcon == "records") {
                    for (var bar = 0; bar < 3; bar++) e.Graphics.DrawLine(pen, box.X + bar * 6 * scale, box.Bottom, box.X + bar * 6 * scale, box.Bottom - (6 + bar * 4) * scale);
                } else {
                    e.Graphics.DrawEllipse(pen, box.X + 5 * scale, box.Y, 6 * scale, 6 * scale);
                    e.Graphics.DrawArc(pen, box.X + scale, box.Y + 8 * scale, 14 * scale, 12 * scale, 180, 180);
                }
            }
            bounds.X = (int)(44 * scale); bounds.Width = Width - bounds.X - (int)(8 * scale);
        }
        var flags = TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix;
        flags |= TextAlign == ContentAlignment.MiddleLeft ? TextFormatFlags.Left : TextFormatFlags.HorizontalCenter;
        TextRenderer.DrawText(e.Graphics, Text, Font, bounds, color, flags);
        if (Focused && ShowFocusCues) ControlPaint.DrawFocusRectangle(e.Graphics, Rectangle.Inflate(ClientRectangle, -(int)(4 * scale), -(int)(4 * scale)), color, background);
    }
}

// Preserve exact text. Amount rows keep numbers intact in a scrolling viewport;
// explanatory text can wrap without changing the text used by accessibility.
internal sealed class NativeExactLabel : Label
{
    internal bool KeepOnOneLine;
    private const TextFormatFlags Flags = TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding;
    private List<string> Lines(int width)
    {
        if (KeepOnOneLine) return new List<string> { Text };
        var lines = new List<string>();
        foreach (var paragraph in Text.Replace("\r", "").Split('\n'))
        {
            if (paragraph.Length == 0) { lines.Add(""); continue; }
            for (var start = 0; start < paragraph.Length; )
            {
                var length = 1;
                while (start + length < paragraph.Length && TextRenderer.MeasureText(paragraph.Substring(start, length + 1), Font, Size.Empty, Flags).Width <= width) length++;
                lines.Add(paragraph.Substring(start, length)); start += length;
            }
        }
        return lines;
    }

    public override Size GetPreferredSize(Size proposedSize)
    {
        var width = Math.Max(1, proposedSize.Width - Padding.Horizontal);
        var height = TextRenderer.MeasureText("0", Font, Size.Empty, Flags).Height;
        var lines = Lines(width); var measuredWidth = 0;
        foreach (var line in lines) measuredWidth = Math.Max(measuredWidth, TextRenderer.MeasureText(line, Font, Size.Empty, Flags).Width);
        return new Size(measuredWidth + Padding.Horizontal, lines.Count * height + Padding.Vertical);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var lines = Lines(Math.Max(1, ClientSize.Width - Padding.Horizontal));
        var height = TextRenderer.MeasureText("0", Font, Size.Empty, Flags).Height;
        var top = Padding.Top + Math.Max(0, (ClientSize.Height - Padding.Vertical - lines.Count * height) / 2);
        foreach (var line in lines)
        {
            TextRenderer.DrawText(e.Graphics, line, Font, new Point(Padding.Left, top), ForeColor, Flags);
            top += height;
        }
    }
}

internal sealed class NativeUsageBar : Control
{
    private double? percentage;
    internal double? Percentage { get { return percentage; } set { percentage = value; AccessibleDescription = "比例未知"; Invalidate(); } }
    internal NativeUsageBar() { DoubleBuffered = true; SetStyle(ControlStyles.ResizeRedraw, true); Height = 8; AccessibleRole = AccessibleRole.ProgressBar; AccessibleName = "当前类别已用额度"; }
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (Width < 2 || Height < 2) return;
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (var track = NativeSurface.Rounded(new RectangleF(0, 0, Width, Height), Height / 2F))
        using (var brush = new SolidBrush(Color.FromArgb(232, 239, 236))) e.Graphics.FillPath(brush, track);
        if (!percentage.HasValue || percentage <= 0) return;
        using (var bar = NativeSurface.Rounded(new RectangleF(0, 0, Math.Max(2, (float)(Width * Math.Min(100, percentage.Value) / 100)), Height), Height / 2F))
        using (var brush = new SolidBrush(Color.FromArgb(31, 111, 87))) e.Graphics.FillPath(brush, bar);
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
    private readonly List<Action> fitTextRows = new List<Action>();
    private readonly ToolTip tips = new ToolTip { AutoPopDelay = 15000 };
    private readonly System.Windows.Forms.Timer timer;
    private readonly ContextMenuStrip accountMenu;
    private readonly ToolStripMenuItem reauthenticate, remove;
    private Panel pageHost;
    private ComboBox accounts, bucketChoice, modelFilter, recordSort;
    private Button add, refresh, accountSettings, accountReauth, accountRemove, loadMore;
    private Label pageTitle, pageSubtitle, breadcrumb, accountStatus, feedback, synced, category, quotaCaption, quotaValue, quotaUsed, quotaTotal, quotaRatios, quotaDetail, reset, localSummary, modelSummary, modelState, recordScope, recordState, accountHint, petHint, petSizeLabel;
    private Label sidebarAccountLogin, sidebarAccountHost, sidebarAccountState;
    private LinkLabel other, raw;
    private NativeSurface otherPanel, rawPanel;
    private TextBox rawText, modelSearch;
    private NativeUsageBar progress;
    private DataGridView modelsGrid, overviewModels, recordsGrid, accountsGrid;
    private DateTimePicker recordMonth;
    private TrackBar petSize;
    private CheckBox petMotion, petTop;
    private DesktopPetPreferences petPreferences;
    private DesktopInstance service;
    private DesktopNativeApi api;
    private NativeOverview overview;
    private NativeLoginDialog loginDialog;
    private string currentPage = "overview", quotaKey, quotaAccount, accountSignature, accountsGridSignature, modelsSignature, recordsAccount, recordsCursor, networkError, publishedAccount, publishedKey;
    private int generation, recordsGeneration, loginOperation;
    private bool suppress, suppressPets, loading, busy, expanded, rawExpanded, disposed, recordsLoading, recordsLoaded, serviceRecoveryAvailable, serviceRecoveryWorking, layoutReady;
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
        var sidebarScroll = new Panel { Name = "SidebarScroll", Dock = DockStyle.Fill, AutoScroll = true, Margin = Padding.Empty, BackColor = Color.White };
        var sidebar = Rows(42, 38, 46, 46, 46, 46, -1, 126, 34);
        sidebar.Name = "SidebarContent"; sidebar.Dock = DockStyle.Top; sidebar.MinimumSize = new Size(0, 486);
        sidebar.Padding = new Padding(14, 24, 14, 14); sidebar.BackColor = sidebarScroll.BackColor;
        Action fitSidebar = delegate {
            if (!LayoutStable) return;
            var height = Math.Max(sidebar.MinimumSize.Height, sidebarScroll.ClientSize.Height);
            if (sidebar.Height != height) sidebar.Height = height;
        };
        sidebarScroll.SizeChanged += delegate { fitSidebar(); }; sidebarScroll.Layout += delegate { fitSidebar(); };
        var brand = LabelFor("PilotMeter", Ink); brand.Font = Typeface(16, FontStyle.Bold); brand.Padding = new Padding(12, 0, 0, 0); sidebar.Controls.Add(brand, 0, 0);
        var edition = LabelFor("COPILOT 用量助手", Muted); edition.Font = Typeface(7.4F, FontStyle.Regular); edition.Padding = new Padding(12, 0, 0, 12); sidebar.Controls.Add(edition, 0, 1);
        var names = new[] { "总览", "可用模型", "用量记录", "账户" }; var keys = new[] { "overview", "models", "records", "accounts" };
        for (var index = 0; index < keys.Length; index++)
        {
            var key = keys[index]; var navigationIndex = index; var button = ButtonFor(names[index]);
            button.Name = "Navigate" + key; button.TextAlign = ContentAlignment.MiddleLeft; button.Padding = new Padding(16, 0, 0, 0);
            button.Margin = new Padding(0, 3, 0, 3); button.FlatAppearance.BorderSize = 0;
            ((NativeActionButton)button).NavigationIcon = key;
            button.Click += delegate { Navigate(key); }; navigation.Add(key, button); sidebar.Controls.Add(button, 0, index + 2);
            button.KeyDown += delegate(object sender, KeyEventArgs e) {
                if (e.KeyCode != Keys.Up && e.KeyCode != Keys.Down) return;
                var next = (navigationIndex + (e.KeyCode == Keys.Down ? 1 : 3)) % 4; navigation[keys[next]].Focus(); Navigate(keys[next]); e.Handled = true;
            };
        }
        var identity = Rows(25, 21, 24, 34); identity.Name = "SidebarAccount"; identity.Padding = new Padding(10); identity.BackColor = Color.FromArgb(245, 248, 247);
        sidebarAccountLogin = LabelFor("未登录 GitHub", Ink); sidebarAccountLogin.Name = "SidebarAccountLogin"; sidebarAccountLogin.Font = Typeface(9.5F, FontStyle.Bold);
        sidebarAccountHost = Caption("个人或工作账号"); sidebarAccountHost.Name = "SidebarAccountHost";
        sidebarAccountState = Caption("正在连接本机服务…"); sidebarAccountState.Name = "SidebarAccountState";
        identity.Controls.Add(sidebarAccountLogin, 0, 0); identity.Controls.Add(sidebarAccountHost, 0, 1); identity.Controls.Add(sidebarAccountState, 0, 2);
        var manageAccount = ButtonFor("账号管理"); manageAccount.Name = "ManageSidebarAccount"; manageAccount.Click += delegate { Navigate("accounts"); }; identity.Controls.Add(manageAccount, 0, 3);
        sidebar.Controls.Add(identity, 0, 7);
        var bottom = LabelFor("关闭窗口后，后台继续运行。", Muted); bottom.Name = "SidebarFooter"; bottom.Font = Typeface(7.6F, FontStyle.Regular); sidebar.Controls.Add(bottom, 0, 8);
        sidebarScroll.Controls.Add(sidebar); shell.Controls.Add(sidebarScroll, 0, 0);

        var content = Rows(48, 80, -1, 32); content.Padding = new Padding(30, 16, 26, 6);
        var topbar = Columns(-1, 260, 42, 136);
        accountStatus = Caption("正在连接本机服务…"); topbar.Controls.Add(accountStatus, 0, 0);
        accounts = new ComboBox { Name = "AccountSelector", AccessibleName = "当前 GitHub 账号", Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList, IntegralHeight = false, DropDownHeight = 250, Margin = new Padding(10, 9, 8, 0) };
        accountSettings = ButtonFor("···"); accountSettings.AccessibleName = "当前账号操作"; accountSettings.Margin = new Padding(0, 4, 6, 8);
        refresh = ButtonFor("刷新数据"); refresh.Name = "RefreshQuota"; refresh.Margin = new Padding(5, 4, 0, 8);
        topbar.Controls.Add(accounts, 1, 0); topbar.Controls.Add(accountSettings, 2, 0); topbar.Controls.Add(refresh, 3, 0); content.Controls.Add(topbar, 0, 0);
        var heading = Rows(0, 42, 30); breadcrumb = LabelFor("", Muted); breadcrumb.Visible = false;
        pageTitle = LabelFor("用量概览", Ink); pageTitle.Font = Typeface(21, FontStyle.Bold);
        pageSubtitle = Caption("了解当前额度，找到适合下一项任务的模型。");
        heading.Controls.Add(breadcrumb, 0, 0); heading.Controls.Add(pageTitle, 0, 1); heading.Controls.Add(pageSubtitle, 0, 2); content.Controls.Add(heading, 0, 1);
        pageHost = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty }; content.Controls.Add(pageHost, 0, 2);
        var footer = Columns(-1, 190); feedback = LabelFor("", Muted); feedback.Font = Typeface(8, FontStyle.Regular); synced = LabelFor("尚未同步", Muted); synced.TextAlign = ContentAlignment.MiddleRight; synced.Font = Typeface(8, FontStyle.Regular);
        footer.Controls.Add(feedback, 0, 0); footer.Controls.Add(synced, 1, 0); content.Controls.Add(footer, 0, 3);
        FitTextRow(content, feedback, 3, null);
        shell.Controls.Add(content, 1, 0); Controls.Add(shell);

        BuildOverview(); BuildModels(); BuildRecords(); BuildAccounts();
        FollowTextDescription(localSummary); FollowTextDescription(modelState); FollowTextDescription(feedback); FollowTextDescription(recordState);
        FollowTextDescription(sidebarAccountLogin); FollowTextDescription(sidebarAccountHost); FollowTextDescription(sidebarAccountState);
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
        ResumeLayout(true);
        layoutReady = true; fitSidebar(); RefreshAdaptiveLayout();
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

    private void SizeCards(FlowLayoutPanel page)
    {
        if (!LayoutStable) return;
        foreach (Control control in page.Controls) control.Width = Math.Max(180, page.ClientSize.Width - SystemInformation.VerticalScrollBarWidth - 2);
    }

    private bool LayoutStable { get { return layoutReady && (AutoScaleMode != AutoScaleMode.Dpi || Math.Abs(AutoScaleDimensions.Width - CurrentAutoScaleDimensions.Width) < .5F); } }

    private float LayoutScale(Control control, float initialFontSize)
    {
        var dpi = CurrentAutoScaleDimensions.Width;
        if (dpi < 48) { using (var graphics = control.CreateGraphics()) dpi = graphics.DpiY; }
        return control.Font.Size / initialFontSize * dpi / 96F;
    }

    private void RefreshAdaptiveLayout()
    {
        if (!LayoutStable) return;
        foreach (var page in pages.Values) SizeCards((FlowLayoutPanel)page);
        foreach (var fit in fitTextRows) fit();
    }

    private NativeSurface Card(FlowLayoutPanel page, int height)
    {
        var card = new NativeSurface { Height = height, Padding = new Padding(22), Margin = new Padding(0, 0, 0, 14) }; page.Controls.Add(card); return card;
    }

    private Label Caption(string text) { var label = LabelFor(text, Muted); label.Font = Typeface(8, FontStyle.Regular); return label; }
    private Label Title(string text) { var label = LabelFor(text, Ink); label.Font = Typeface(11, FontStyle.Bold); return label; }
    private LinkLabel Link(string text)
    {
        return new LinkLabel { Text = text, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, LinkColor = Accent, ActiveLinkColor = Accent, VisitedLinkColor = Accent, LinkBehavior = LinkBehavior.HoverUnderline, Font = Typeface(8.5F, FontStyle.Regular), Margin = Padding.Empty, AutoEllipsis = true };
    }

    private DataGridView Grid(params string[] columns)
    {
        var grid = new DataGridView { Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false, AllowUserToDeleteRows = false, AllowUserToResizeRows = false,
            RowHeadersVisible = false, BackgroundColor = Color.White, BorderStyle = BorderStyle.None, CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal,
            GridColor = Color.FromArgb(235, 239, 242), SelectionMode = DataGridViewSelectionMode.FullRowSelect, MultiSelect = false,
            AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells,
            ColumnHeadersHeight = 38, ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing, EnableHeadersVisualStyles = false };
        grid.DefaultCellStyle = new DataGridViewCellStyle { BackColor = Color.White, ForeColor = Ink, SelectionBackColor = Color.FromArgb(236, 245, 241), SelectionForeColor = Ink, Padding = new Padding(8, 9, 8, 9), WrapMode = DataGridViewTriState.True, Font = Typeface(8.5F, FontStyle.Regular) };
        grid.ColumnHeadersDefaultCellStyle = new DataGridViewCellStyle { BackColor = Color.FromArgb(246, 248, 249), ForeColor = Muted, SelectionBackColor = Color.FromArgb(246, 248, 249), Padding = new Padding(8, 0, 8, 0), Font = Typeface(8, FontStyle.Regular) };
        foreach (var name in columns) grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = name, Name = name, SortMode = DataGridViewColumnSortMode.NotSortable });
        return grid;
    }

    private Label Metric(TableLayoutPanel container, int row, string caption, float size)
    {
        var metric = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty, BackColor = Color.Transparent };
        var title = Caption(caption); title.Name = "MetricCaption" + row; title.Dock = DockStyle.None; metric.Controls.Add(title);
        var viewport = new Panel { Name = "ExactMetricViewport" + row, AutoScroll = true, Margin = Padding.Empty, BackColor = Color.Transparent };
        var amount = new NativeExactLabel { KeepOnOneLine = true, Text = "—", ForeColor = Ink, BackColor = Color.Transparent, Margin = Padding.Empty, Font = Typeface(size, row == 0 ? FontStyle.Bold : FontStyle.Regular, "Segoe UI") };
        viewport.Controls.Add(amount); metric.Controls.Add(viewport); container.Controls.Add(metric, 0, row);
        if (row == 2) quotaCaption = title;
        amount.TextChanged += delegate { tips.SetToolTip(amount, amount.Text); amount.AccessibleDescription = amount.Text; };
        return amount;
    }

    private void FollowTextDescription(Control control)
    {
        control.TextChanged += delegate { tips.SetToolTip(control, control.Text); control.AccessibleDescription = control.Text; };
        tips.SetToolTip(control, control.Text); control.AccessibleDescription = control.Text;
    }

    // Text can change after a sync, and a narrow window or larger system font
    // can need more lines. Grow the row and its scrolling card together so the
    // next section never paints over the message. Reclaim that space on resize.
    private static void FitAbsoluteCard(TableLayoutPanel layout, NativeSurface card)
    {
        // Scale rounds each row and each padding edge independently. Recompute
        // their sum instead of preserving a fractional-DPI shortfall or drift.
        var height = card.Padding.Vertical + layout.Margin.Vertical + layout.Padding.Vertical;
        foreach (RowStyle style in layout.RowStyles) height += (int)Math.Ceiling(style.Height);
        if (card.Height != height) card.Height = height;
    }

    private void FitTextRow(TableLayoutPanel layout, Label label, int row, NativeSurface card, bool fitCardHeight = false)
    {
        var minimum = layout.RowStyles[row].Height;
        var initialFontSize = label.Font.Size;
        var fitting = false;
        Action fit = delegate {
            if (!LayoutStable || fitting || label.Width < 100 || disposed) return;
            fitting = true;
            try
            {
                var scale = LayoutScale(label, initialFontSize);
                var measured = label is NativeExactLabel ? label.GetPreferredSize(new Size(label.ClientSize.Width, Int32.MaxValue))
                    : TextRenderer.MeasureText(label.Text, label.Font, new Size(label.ClientSize.Width, Int32.MaxValue), TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix);
                var height = Math.Max((int)Math.Ceiling(minimum * scale), measured.Height + (int)Math.Ceiling(4 * scale));
                var difference = height - (int)Math.Round(layout.RowStyles[row].Height);
                if (difference == 0 && !fitCardHeight) return;
                layout.RowStyles[row].SizeType = SizeType.Absolute; layout.RowStyles[row].Height = height;
                if (card != null) { if (fitCardHeight) FitAbsoluteCard(layout, card); else card.Height += difference; }
            }
            finally { fitting = false; }
        };
        label.AutoEllipsis = false;
        fitTextRows.Add(fit);
        label.TextChanged += delegate { fit(); }; label.SizeChanged += delegate { fit(); }; label.FontChanged += delegate { fit(); };
    }

    private void FitContentGrid(TableLayoutPanel layout, DataGridView grid, int row, NativeSurface card)
    {
        var initialFontSize = grid.Font.Size; var fitting = false;
        Action fit = delegate {
            if (!LayoutStable || fitting || disposed) return;
            fitting = true;
            try
            {
                var scale = LayoutScale(grid, initialFontSize);
                var rowsHeight = 0;
                foreach (DataGridViewRow item in grid.Rows) rowsHeight += item.Height;
                var height = Math.Min((int)(280 * scale), Math.Max((int)(78 * scale), grid.ColumnHeadersHeight + rowsHeight + grid.Margin.Vertical + 2));
                var total = card.Padding.Vertical + height;
                for (var index = 0; index < layout.RowCount; index++) if (index != row) total += (int)Math.Ceiling(layout.RowStyles[index].Height);
                layout.RowStyles[row].SizeType = SizeType.Absolute; layout.RowStyles[row].Height = height;
                if (card.Height != total) card.Height = total;
            }
            finally { fitting = false; }
        };
        fitTextRows.Add(fit);
        grid.RowsAdded += delegate { fit(); }; grid.RowsRemoved += delegate { fit(); };
        grid.RowHeightChanged += delegate { fit(); }; grid.SizeChanged += delegate { fit(); };
    }

    private void FitMetrics(TableLayoutPanel layout, TableLayoutPanel metrics, NativeSurface card)
    {
        var initialFontSize = quotaUsed.Font.Size;
        var fitting = false;
        Action fit = delegate {
            if (!LayoutStable || fitting || metrics.Width < 100 || disposed) return;
            fitting = true;
            try
            {
                var scale = LayoutScale(quotaUsed, initialFontSize);
                var values = new[] { quotaUsed, quotaTotal, quotaValue };
                var horizontal = metrics.Width >= 600 * scale;
                foreach (var label in values)
                    horizontal &= label.GetPreferredSize(new Size(Int32.MaxValue, Int32.MaxValue)).Width + 24 * scale <= metrics.Width / 3;
                var columns = horizontal ? 3 : 1;
                if (metrics.ColumnCount != columns)
                {
                    metrics.SuspendLayout();
                    var groups = new Control[values.Length];
                    for (var index = 0; index < values.Length; index++) groups[index] = values[index].Parent.Parent;
                    metrics.Controls.Clear();
                    metrics.ColumnStyles.Clear(); metrics.RowStyles.Clear();
                    metrics.ColumnCount = columns; metrics.RowCount = horizontal ? 1 : 3;
                    for (var col = 0; col < columns; col++) metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F / columns));
                    for (var row = 0; row < metrics.RowCount; row++) metrics.RowStyles.Add(new RowStyle(SizeType.Absolute, 1));
                    for (var index = 0; index < values.Length; index++) metrics.Controls.Add(groups[index], horizontal ? index : 0, horizontal ? 0 : index);
                    metrics.ResumeLayout(true);
                }
                var height = 0; var indexOf = 0;
                foreach (var label in values)
                {
                    var viewport = (Panel)label.Parent;
                    var group = viewport.Parent;
                    var caption = group.Controls[0];
                    var left = horizontal ? (indexOf == 0 ? 0 : (int)(20 * scale)) : (int)(80 * scale);
                    var top = horizontal ? (int)(28 * scale) : 0;
                    var width = Math.Max(1, group.ClientSize.Width - left);
                    var measured = label.GetPreferredSize(new Size(Int32.MaxValue, Int32.MaxValue));
                    var lineHeight = measured.Height + (int)Math.Ceiling(4 * scale);
                    var needsScroll = measured.Width + 4 * scale > width;
                    var rowHeight = Math.Max((int)Math.Ceiling((horizontal ? 86 : indexOf == 0 ? 60 : 50) * scale), top + lineHeight + (needsScroll ? SystemInformation.HorizontalScrollBarHeight : 0) + (int)Math.Ceiling(8 * scale));
                    if (horizontal) { height = Math.Max(height, rowHeight); metrics.RowStyles[0].Height = height; }
                    else { metrics.RowStyles[indexOf].Height = rowHeight; height += rowHeight; }
                    caption.SetBounds(horizontal ? left : 0, 0, horizontal ? width : left, horizontal ? top : rowHeight);
                    viewport.SetBounds(left, top, width, rowHeight - top);
                    indexOf++;
                    var availableHeight = rowHeight - top;
                    label.SetBounds(viewport.AutoScrollPosition.X, Math.Max(0, (availableHeight - (needsScroll ? SystemInformation.HorizontalScrollBarHeight : 0) - lineHeight) / 2), Math.Max(viewport.ClientSize.Width, measured.Width + (int)Math.Ceiling(4 * scale)), lineHeight);
                }
                layout.RowStyles[1].Height = height;
                FitAbsoluteCard(layout, card);
            }
            finally { fitting = false; }
        };
        fitTextRows.Add(fit);
        foreach (var label in new[] { quotaValue, quotaUsed, quotaTotal })
        {
            label.TextChanged += delegate { ((Panel)label.Parent).AutoScrollPosition = Point.Empty; fit(); };
            label.Parent.SizeChanged += delegate { fit(); }; label.FontChanged += delegate { fit(); };
        }
        metrics.SizeChanged += delegate { fit(); };
    }

    private void BuildOverview()
    {
        var page = Page("overview");
        var quota = Card(page, 284); quota.Name = "PrimaryQuotaCard";
        var layout = Rows(30, 148, 12, 26, 24); var top = Columns(-1, 100);
        category = Title("当前账户额度"); top.Controls.Add(category, 0, 0);
        var details = Link("额度明细  →"); details.LinkClicked += delegate { ShowQuotaDetails(); }; top.Controls.Add(details, 1, 0); layout.Controls.Add(top, 0, 0);
        var metrics = Rows(56, 46, 46);
        quotaUsed = Metric(metrics, 0, "已用", 30); quotaUsed.Name = "QuotaUsed"; quotaUsed.ForeColor = Accent;
        quotaTotal = Metric(metrics, 1, "总额", 22); quotaTotal.Name = "QuotaTotal";
        quotaValue = Metric(metrics, 2, "剩余", 22); quotaValue.Name = "QuotaValue";
        layout.Controls.Add(metrics, 0, 1);
        progress = new NativeUsageBar { Name = "QuotaProgress", Dock = DockStyle.Fill, Margin = new Padding(0, 8, 0, 0) }; layout.Controls.Add(progress, 0, 2);
        quotaRatios = new NativeExactLabel { Text = "额度比例待同步", ForeColor = Muted, BackColor = Color.Transparent, Dock = DockStyle.Fill, Margin = Padding.Empty, Font = Typeface(8, FontStyle.Regular) }; layout.Controls.Add(quotaRatios, 0, 3);
        var metadata = Columns(-1, 180);
        quotaDetail = new NativeExactLabel { ForeColor = Muted, BackColor = Color.Transparent, Dock = DockStyle.Fill, Margin = Padding.Empty, Font = Typeface(8, FontStyle.Regular) }; metadata.Controls.Add(quotaDetail, 0, 0);
        reset = Caption(""); reset.TextAlign = ContentAlignment.MiddleRight; metadata.Controls.Add(reset, 1, 0); layout.Controls.Add(metadata, 0, 4); quota.Controls.Add(layout);
        FitMetrics(layout, metrics, quota);
        FitTextRow(layout, quotaRatios, 3, quota, true);
        FitTextRow(layout, quotaDetail, 4, quota, true);

        var expanders = new Panel { Height = 28, Margin = new Padding(3, 0, 0, 8) }; var expandRow = Columns(-1, -1);
        other = Link("其他额度 ▸"); raw = Link("查看额度数值 ▸"); raw.TextAlign = ContentAlignment.MiddleRight;
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
        rawText = new TextBox { Name = "RawQuotaFields", AccessibleName = "允许展示的额度数值", Multiline = true, ReadOnly = true, BorderStyle = BorderStyle.None, BackColor = rawPanel.SurfaceColor, ForeColor = Ink, Dock = DockStyle.Fill, ScrollBars = ScrollBars.Vertical };
        rawPanel.Controls.Add(rawText); rawPanel.Visible = false;
        var local = Card(page, 112); var localLayout = Rows(29, 39);
        var localHeader = Columns(-1, 110); localHeader.Controls.Add(Title("本机用量"), 0, 0); var history = Link("查看记录  →"); history.LinkClicked += delegate { Navigate("records"); }; localHeader.Controls.Add(history, 1, 0);
        localSummary = Caption("尚未读取本机会话。"); localSummary.AutoEllipsis = false; localLayout.Controls.Add(localHeader, 0, 0); localLayout.Controls.Add(localSummary, 0, 1); local.Controls.Add(localLayout);
        FitTextRow(localLayout, localSummary, 1, local);
        var modelCard = Card(page, 270); var modelsLayout = Rows(28, 28, -1);
        var modelHeader = Columns(-1, 110); modelHeader.Controls.Add(Title("账户可用模型"), 0, 0); var all = Link("查看全部  →"); all.LinkClicked += delegate { Navigate("models"); }; modelHeader.Controls.Add(all, 1, 0);
        modelSummary = Caption("模型权限待验证；登录成功不会自动授予模型权限。"); overviewModels = Grid("模型", "访问状态", "能力"); overviewModels.Name = "OverviewModels";
        overviewModels.CellDoubleClick += delegate(object sender, DataGridViewCellEventArgs e) { ShowModelFrom(overviewModels, e.RowIndex); };
        modelsLayout.Controls.Add(modelHeader, 0, 0); modelsLayout.Controls.Add(modelSummary, 0, 1); modelsLayout.Controls.Add(overviewModels, 0, 2); modelCard.Controls.Add(modelsLayout);
        FitContentGrid(modelsLayout, overviewModels, 2, modelCard);
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
        FitTextRow(layout, modelState, 1, card);
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
        FitTextRow(layout, recordScope, 1, card); FitTextRow(layout, recordState, 3, card);
        loadMore.Click += async delegate { await LoadRecordsAsync(true); };
        recordMonth.ValueChanged += async delegate { ResetRecords(); await LoadRecordsAsync(false); };
        recordSort.SelectedIndexChanged += async delegate { ResetRecords(); await LoadRecordsAsync(false); };
        var note = Caption("记录中的模型是实际观测到的使用历史，不构成当前可用模型授权。没有验证计量单位的记录不会显示成 AI Credits。\n尚未归属或仍在等待结束的调用会保留状态，不按零消耗处理。");
        note.Dock = DockStyle.None; note.Height = 62; note.AutoEllipsis = false; page.Controls.Add(note);
    }

    private void BuildAccounts()
    {
        var page = Page("accounts"); var card = Card(page, 330); var layout = Rows(35, 50, -1, 42);
        var titleRow = Columns(-1, 118); titleRow.Controls.Add(Title("已连接的 GitHub 账号"), 0, 0); add = ButtonFor("添加账号"); add.Name = "AddAccount"; add.BackColor = Accent; add.ForeColor = Color.White; add.Click += delegate { OpenLogin(false); }; titleRow.Controls.Add(add, 1, 0); layout.Controls.Add(titleRow, 0, 0);
        accountHint = LabelFor("连接个人或工作账号。身份、额度和模型权限分别验证。", Muted); accountHint.AutoEllipsis = false; layout.Controls.Add(accountHint, 0, 1);
        accountsGrid = Grid("账号", "连接状态", "当前账户"); accountsGrid.Name = "ConnectedAccounts"; accountsGrid.Columns[0].FillWeight = 170;
        accountsGrid.CellDoubleClick += async delegate(object sender, DataGridViewCellEventArgs e) { if (e.RowIndex >= 0 && accountsGrid.Rows[e.RowIndex].Tag is NativeAccount) await SelectAccountAsync(((NativeAccount)accountsGrid.Rows[e.RowIndex].Tag).Id); };
        accountsGrid.KeyDown += async delegate(object sender, KeyEventArgs e) { if (e.KeyCode == Keys.Enter && accountsGrid.CurrentRow != null) { e.Handled = true; var selected = accountsGrid.CurrentRow.Tag as NativeAccount; if (selected != null) await SelectAccountAsync(selected.Id); } };
        layout.Controls.Add(accountsGrid, 0, 2); var actions = Columns(-1, 142, 12, 142);
        actions.Controls.Add(Caption("双击账号或按 Enter 切换"), 0, 0); accountReauth = ButtonFor("重新登录当前账号"); accountRemove = ButtonFor("移除当前账号…");
        accountReauth.Click += delegate { OpenLogin(true); }; accountRemove.Click += async delegate { await RemoveAsync(); };
        actions.Controls.Add(accountReauth, 1, 0); actions.Controls.Add(accountRemove, 3, 0); layout.Controls.Add(actions, 0, 3); card.Controls.Add(layout);
        FitTextRow(layout, accountHint, 1, card);
        FitContentGrid(layout, accountsGrid, 2, card);

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
        FitTextRow(petLayout, petHint, 1, pets);
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
        }
        finally { suppressPets = false; }
    }

    private async void Navigate(string page)
    {
        if (disposed || !pages.ContainsKey(page)) return;
        currentPage = page;
        foreach (var item in pages) item.Value.Visible = item.Key == page;
        foreach (var item in navigation) { item.Value.BackColor = item.Key == page ? Color.FromArgb(232, 242, 237) : Color.White; item.Value.ForeColor = item.Key == page ? Accent : Muted; }
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
        RenderSidebarAccount(null, instance == null ? "本机服务未连接" : "正在读取账号…");
        nextRefresh = DateTime.MinValue;
        if (instance != null) api = new DesktopNativeApi(instance);
        UpdateControls(); UpdatePolling();
        if (CanRead) BeginInvoke(new Action(async delegate { await LoadAsync(true); }));
    }

    internal void SetServiceRecovery(bool available, bool working)
    {
        serviceRecoveryAvailable = available; serviceRecoveryWorking = working;
        UpdateControls();
    }

    private void ClearQuota(string description)
    {
        category.Text = "当前账户额度"; quotaCaption.Text = "剩余"; quotaValue.Text = quotaUsed.Text = quotaTotal.Text = "—";
        progress.Percentage = null; quotaRatios.Text = "额度比例待同步"; quotaDetail.Text = NativeData.Clean(description, 400); reset.Text = "";
        tips.SetToolTip(quotaDetail, quotaDetail.Text); rawText.Text = ""; raw.Visible = other.Visible = false;
        ExpandRaw(false); ExpandOther(false);
        suppress = true; bucketChoice.Items.Clear(); suppress = false;
    }

    private void ClearAccountPresentation(string description)
    {
        ClearQuota(description); ResetRecords(); modelsSignature = null; modelsGrid.Rows.Clear(); overviewModels.Rows.Clear();
        RenderSidebarAccount(null, "正在更新账号…");
        modelState.Text = modelSummary.Text = localSummary.Text = description;
    }

    private void UpdateControls()
    {
        if (disposed || add == null) return;
        var ready = api != null && overview != null && overview.Enabled && !busy && !AccountMutationPending && loginDialog == null;
        accounts.Enabled = ready && overview.Accounts.Count > 0;
        // The login entry remains responsive when the first overview fails or a
        // quota refresh is running. OpenLogin explains unavailable service states.
        add.Enabled = loginDialog == null;
        add.Text = overview != null && overview.Login != null && overview.Login.Active ? "继续登录" : overview != null && overview.Accounts.Count == 0 ? "登录 GitHub" : "添加账号";
        var selected = ready && overview.Active != null;
        accountSettings.Enabled = selected; accountReauth.Enabled = selected && !(overview.Login != null && overview.Login.Active); accountRemove.Enabled = selected;
        if (reauthenticate != null) { reauthenticate.Enabled = accountReauth.Enabled; remove.Enabled = selected; }
        refresh.Enabled = !busy && !loading && !AccountMutationPending && !serviceRecoveryWorking && loginDialog == null;
        refresh.Text = api == null ? serviceRecoveryWorking ? "正在重连…" : serviceRecoveryAvailable ? "重启本机服务" : "重试连接" : busy ? "同步中…" : "刷新数据";
        bucketChoice.Enabled = !busy && !loading && !AccountMutationPending && loginDialog == null; accountsGrid.Enabled = ready;
        loadMore.Enabled = !busy && !AccountMutationPending && loginDialog == null && !recordsLoading && recordsCursor != null && api != null;
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
            ClearAccountPresentation(description);
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
            else { overview = null; ClearQuota("操作尚未确认，请刷新后重试。"); RenderModels(); RenderSidebarAccount(null, "账号状态待确认"); }
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
        RenderSidebarAccount(active, !result.Enabled ? "账号功能未启用" : networkError != null ? "同步失败" : null);
        accountStatus.Text = active == null ? "尚未连接账号" : active.Status == "reauth-required" ? "需要重新登录" : active.Status == "error" ? "账号连接异常" : "账号已连接";
        tips.SetToolTip(accountStatus, active == null ? "请到账户页登录 GitHub。" : "当前账号：" + active.Login);
        synced.Text = "上次同步  " + NativeDisplay.Time(result.FetchedAt);
        feedback.Text = networkError != null ? "同步失败 · 当前展示上次读取的数据" : result.Refreshing ? "正在同步额度与模型权限…" : result.Stale ? "旧快照 · 等待最新数据" : "";
        accountHint.Text = !result.Enabled ? "当前服务未启用真实账号操作。" : active == null ? "连接 GitHub 后分别验证身份、额度和模型权限。" : "切换账号后，额度、模型与记录同步切换。";
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

    private void RenderSidebarAccount(NativeAccount account, string state = null)
    {
        sidebarAccountLogin.Text = account == null ? "未登录 GitHub" : "@" + account.Login;
        sidebarAccountHost.Text = account == null ? "个人或工作账号" : new Uri(account.Host).Host;
        sidebarAccountState.Text = state ?? (account == null ? "到账户页连接账号" : account.Status == "connected" ? "已连接" : account.Status == "reauth-required" ? "需要重新登录" : "连接异常");
        sidebarAccountState.ForeColor = state == null && account != null && account.Status == "connected" ? Accent : Muted;
    }

    private void RenderQuota(NativeOverview result)
    {
        var bucket = result.Primary;
        if (bucket == null) { ClearQuota("请选择要查看的额度类别。各类别独立计量。"); }
        else
        {
            category.Text = bucket.Label;
            quotaCaption.Text = bucket.Unlimited ? "额度" : bucket.Remaining != null ? "剩余" : bucket.RemainingPercentage.HasValue ? "剩余比例" : "已用比例";
            quotaValue.Text = bucket.Unlimited ? "无固定上限" : bucket.Remaining != null ? NativeDisplay.Amount(bucket.Remaining) : bucket.RemainingPercentageText != null ? NativeDisplay.ExactPercentage(bucket.RemainingPercentageText) : NativeDisplay.ExactPercentage(bucket.UsedPercentageText);
            quotaUsed.Text = NativeDisplay.Amount(bucket.Used ?? bucket.RawUsed); quotaTotal.Text = bucket.Unlimited ? "无固定上限" : NativeDisplay.Amount(bucket.Limit ?? bucket.RawLimit);
            progress.Percentage = bucket.Percentage;
            progress.AccessibleDescription = bucket.UsedPercentageText == null ? "比例未知" : "已用 " + NativeDisplay.ExactPercentage(bucket.UsedPercentageText);
            quotaRatios.Text = bucket.Unlimited ? "无固定上限" : "已用比例  " + NativeDisplay.ExactPercentage(bucket.UsedPercentageText) + (bucket.UsedPercentageText != null ? " · GitHub 比例可能已舍入" : "");
            var stale = result.Stale || networkError != null;
            quotaDetail.Text = (stale ? "旧快照 · " + NativeDisplay.Time(result.FetchedAt) + " · " : "") + (bucket.Unit == "unspecified" ? "额度数值 · 单位未确认" : bucket.Overage != null && bucket.Overage != "0" ? "已超出固定额度 " + NativeDisplay.Amount(bucket.Overage) + " " + bucket.UnitLabel : "计量单位 · " + bucket.UnitLabel) + " · " + NativeDisplay.UsageSource(bucket);
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
        return "单位待确认 · 仅展示允许公开的数值字段\r\n已用数值 (used)：" + NativeDisplay.Amount(bucket.RawUsed) + "\r\n总额数值 (limit)：" + NativeDisplay.Amount(bucket.RawLimit) + "\r\n用量来源：" + NativeDisplay.UsageSource(bucket) + "\r\nGitHub 剩余比例 (remainingPercentage)：" + (bucket.RawRemainingPercentage ?? "—") + "\r\nGitHub 比例可能已舍入，不一定与数量计算的比例一致。\r\n这些额度数值不能标作 AI Credits 或请求次数。";
    }

    private void ExpandOther(bool show) { expanded = show; otherPanel.Visible = show; other.Text = (overview != null && overview.Primary == null ? "选择额度类别" : "其他额度") + (show ? " ▾" : " ▸"); }
    private void ExpandRaw(bool show) { rawExpanded = show; rawPanel.Visible = show; raw.Text = "查看额度数值" + (show ? " ▾" : " ▸"); }

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
        if (disposed) return;
        if (loginDialog != null) { loginDialog.Activate(); return; }
        if (api == null || service == null || serviceRecoveryWorking)
        {
            LoginFeedback(serviceRecoveryWorking ? "本机服务正在重连，完成后请再次点击登录。" : "本机服务尚未连接。请先点击右上角“重试连接”或“重启本机服务”，再登录 GitHub。");
            return;
        }
        if (overview != null && !overview.Enabled) { LoginFeedback("当前服务未启用账号登录，请连接已启用账号功能的本机服务后重试。"); return; }
        if (AccountMutationPending) { LoginFeedback("正在更新当前账号，请等待操作完成后再添加账号。"); return; }
        if (reauth && (overview == null || overview.Active == null)) { LoginFeedback("请先选择需要重新登录的账号。"); return; }
        var operation = ++loginOperation;
        var identity = service; var expected = reauth ? overview.Active : null;
        var pending = overview != null && overview.Login != null && overview.Login.Active ? overview.Login : null;
        try
        {
            // Supersede read/refresh UI work without waiting for quota retrieval.
            generation++; loading = busy = false; timer.Stop(); AccountMutationPending = true;
            PublishQuotaSelection(overview == null ? null : overview.ActiveId, null, true);
            using (var dialog = new NativeLoginDialog(identity, expected, pending))
            {
                loginDialog = dialog; UpdateControls(); dialog.ShowDialog(this);
                if (disposed || operation != loginOperation) return;
                if (Object.ReferenceEquals(loginDialog, dialog)) loginDialog = null;
                if (service == null || !service.SameAs(identity)) { UpdateControls(); UpdatePolling(); if (CanRead) await LoadAsync(true); return; }
                generation++; overview = null; quotaKey = quotaAccount = null; nextRefresh = DateTime.MinValue;
                ClearAccountPresentation(dialog.Succeeded ? "登录成功，正在读取额度与模型权限…" : "正在读取当前账号…"); RenderModels();
                await LoadAsync(true); if (!disposed && operation == loginOperation && !String.IsNullOrEmpty(dialog.Feedback)) feedback.Text = dialog.Feedback;
            }
        }
        catch (Exception error)
        {
            if (!disposed && operation == loginOperation) LoginFeedback("无法打开登录窗口：" + NativeData.Error(error) + " 请再次点击登录重试。");
        }
        finally
        {
            // Service replacement can allow a new login while this operation's
            // final overview read is still pending. Only its owner may release it.
            if (operation == loginOperation)
            {
                loginDialog = null;
                if (!disposed)
                {
                    AccountMutationPending = false;
                    UpdateControls(); UpdatePolling();
                    PublishQuotaSelection(overview == null ? null : overview.ActiveId, quotaKey, true);
                }
            }
        }
    }

    private void LoginFeedback(string message)
    {
        accountHint.Text = feedback.Text = message;
        tips.SetToolTip(accountHint, message); tips.SetToolTip(feedback, message);
    }

    private void ShowQuotaDetails()
    {
        if (overview == null || !overview.CanDisplaySnapshot || overview.Primary == null) { ShowDetails("额度明细", "当前没有可展示的额度快照。请连接账号并同步。"); return; }
        var bucket = overview.Primary;
        var text = "账户：" + overview.Active.Login + "\r\n类别：" + bucket.Label + "\r\n单位：" + bucket.UnitLabel + "\r\n总额：" + (bucket.Unlimited ? "无固定上限" : NativeDisplay.Amount(bucket.Limit ?? bucket.RawLimit)) + "\r\n已用：" + NativeDisplay.Amount(bucket.Used ?? bucket.RawUsed) + "\r\n剩余：" + NativeDisplay.Amount(bucket.Remaining) + "\r\n已用比例：" + NativeDisplay.ExactPercentage(bucket.UsedPercentageText) + "\r\n剩余比例：" + NativeDisplay.ExactPercentage(bucket.RemainingPercentageText) + "\r\n同步时间：" + NativeDisplay.Time(overview.FetchedAt) + "\r\n状态：" + (overview.Stale || networkError != null ? "旧快照，等待同步" : "已同步") + "\r\n\r\n" + bucket.Detail;
        text += "\r\n用量来源：" + NativeDisplay.UsageSource(bucket) + "\r\nGitHub 比例可能已舍入，不一定与数量计算的比例一致。";
        if (bucket.Unit == "unspecified") text += "\r\n\r\n" + RawValues(bucket);
        text += "\r\n\r\n绝对剩余量仅由同一快照、同一额度池的数量相减得出，精度依用量来源。组织付费不代表此值是整个组织的总额度。";
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
        ResumeLayout(true);
    }
}
