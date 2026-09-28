using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class WidgetSnapshot
{
    public string State, Title, Value, Detail, AccountLogin, UpdatedAt;
    public double? Percentage;
}

/// <summary>A local, read-only companion. Closing hides it; its explicit exit action belongs to the host.</summary>
internal sealed class DesktopWidget : Form
{
    private const int LogicalWidth = 220, LogicalHeight = 76;
    private readonly string settingsPath;
    private readonly Action openMain, exitApplication;
    private readonly ToolTip tooltip;
    private readonly NotifyIcon tray;
    private readonly Icon trayIcon;
    private readonly ContextMenuStrip menu;
    private readonly ToolStripMenuItem restoreItem, pinItem, hideItem;
    private readonly Timer animation;
    private readonly Painter painter;
    private readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
    private readonly Random random = new Random();
    private WidgetSnapshot snapshot;
    private float scale = 1;
    private bool initialized, disposing, pressed, dragging, hovered, exiting, hideExplained;
    private Point pressScreen, pressLocation;
    private long nextBlink, blinkUntil, lastOpen = -1000;
    private string persistenceWarning;

    public DesktopWidget(string dataDirectory, Action openMain, Action exitApplication)
    {
        if (String.IsNullOrWhiteSpace(dataDirectory)) throw new ArgumentException("A data directory is required.", "dataDirectory");
        if (openMain == null) throw new ArgumentNullException("openMain");
        if (exitApplication == null) throw new ArgumentNullException("exitApplication");
        settingsPath = Path.Combine(Path.GetFullPath(dataDirectory), "desktop-ui.json");
        this.openMain = openMain;
        this.exitApplication = exitApplication;
        snapshot = CopySnapshot(null);
        painter = new Painter();
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        ShowInTaskbar = false;
        MaximizeBox = MinimizeBox = false;
        Text = "PilotMeter 桌面挂件";
        AccessibleRole = AccessibleRole.PushButton;
        AccessibleName = "PilotMeter 用量挂件";
        AccessibleDescription = "单击或按 Enter、空格打开主程序。拖动移动位置；右键打开菜单；Esc 或 Alt+F4 隐藏到托盘。";
        BackColor = Painter.Background;
        Cursor = Cursors.Hand;
        DoubleBuffered = true;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);

        menu = new ContextMenuStrip();
        menu.AccessibleName = "PilotMeter 挂件菜单";
        restoreItem = new ToolStripMenuItem("显示挂件", null, delegate { ShowWidget(); });
        menu.Items.Add(restoreItem);
        menu.Items.Add(new ToolStripMenuItem("打开主程序", null, delegate { OpenMain(); }));
        pinItem = new ToolStripMenuItem("始终置顶");
        pinItem.CheckOnClick = true;
        pinItem.Click += delegate { TopMost = pinItem.Checked; SaveSettings(); };
        menu.Items.Add(pinItem);
        hideItem = new ToolStripMenuItem("隐藏到托盘", null, delegate { HideToTray(); });
        menu.Items.Add(hideItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("退出挂件（后台服务继续运行）", null, delegate { RequestExit(); }));
        menu.Opening += delegate
        {
            restoreItem.Visible = !Visible;
            hideItem.Visible = Visible;
            pinItem.Checked = TopMost;
        };
        ContextMenuStrip = menu;
        tooltip = new ToolTip { InitialDelay = 450, ReshowDelay = 120, AutoPopDelay = 15000, ShowAlways = true };
        trayIcon = DesktopBrand.CreateIcon();
        tray = new NotifyIcon { Icon = trayIcon, Text = "PilotMeter", ContextMenuStrip = menu };
        tray.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) ShowWidget(); };
        tray.DoubleClick += delegate { OpenMain(); };
        tray.BalloonTipClicked += delegate { ShowWidget(); };

        // Create a hidden handle on the owning STA thread so early background snapshots can marshal safely.
        IntPtr unused = Handle;
        float initialDpi;
        using (Graphics graphics = CreateGraphics()) initialDpi = graphics.DpiX / 96f;
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        ConfigureScale(initialDpi, area);
        Location = new Point(area.Right - Width - ScalePixels(16), area.Bottom - Height - ScalePixels(16));
        TopMost = true;
        ReadSettings();
        EnsureVisible();
        initialized = true;
        UpdateDescriptions();
        tray.Visible = true;

        animation = new Timer { Interval = 125 };
        nextBlink = random.Next(4500, 8500);
        animation.Tick += delegate
        {
            if (!Visible || dragging || menu.Visible || SystemInformation.HighContrast || !SystemInformation.IsMenuAnimationEnabled) return;
            long now = clock.ElapsedMilliseconds;
            if (now >= nextBlink) { blinkUntil = now + 210; nextBlink = now + random.Next(4500, 8500); }
            // A quiet idle gesture, independent of network requests or model activity.
            Invalidate(new Rectangle(ScalePixels(5), ScalePixels(5), ScalePixels(60), ScalePixels(66)));
        };
    }

    protected override CreateParams CreateParams
    {
        get { CreateParams value = base.CreateParams; value.ExStyle |= 0x80; return value; } // WS_EX_TOOLWINDOW
    }

    public void ApplySnapshot(WidgetSnapshot value)
    {
        WidgetSnapshot copy = CopySnapshot(value);
        Dispatch(delegate
        {
            snapshot = copy;
            UpdateDescriptions();
            Invalidate();
        });
    }

    public void ShowWidget()
    {
        Dispatch(delegate
        {
            EnsureVisible();
            if (!Visible) Show();
            WindowState = FormWindowState.Normal;
            Activate();
            Focus();
            if (animation != null) animation.Start();
        });
    }

    private void Dispatch(Action action)
    {
        if (disposing || IsDisposed) return;
        try
        {
            if (InvokeRequired) BeginInvoke(new Action(delegate { if (!disposing && !IsDisposed) action(); }));
            else action();
        }
        catch (InvalidOperationException) { /* The application may be closing while a snapshot completes. */ }
    }

    private static string Clean(string value, int maximum)
    {
        if (String.IsNullOrEmpty(value)) return String.Empty;
        StringBuilder result = new StringBuilder(Math.Min(value.Length, maximum));
        foreach (char character in value)
        {
            if (result.Length >= maximum) break;
            result.Append(Char.IsControl(character) ? ' ' : character);
        }
        if (result.Length > 0 && Char.IsHighSurrogate(result[result.Length - 1])) result.Length--;
        return result.ToString().Trim();
    }

    private static WidgetSnapshot CopySnapshot(WidgetSnapshot value)
    {
        if (value == null) return new WidgetSnapshot { State = "loading", Title = "PilotMeter", Value = "正在连接", Detail = "等待本地服务快照；尚无可显示的已知用量。" };
        double? percentage = value.Percentage;
        if (percentage.HasValue && (Double.IsNaN(percentage.Value) || Double.IsInfinity(percentage.Value) || percentage.Value < 0 || percentage.Value > 100)) percentage = null;
        string state = Clean(value.State, 32).ToLowerInvariant();
        if (state != "ready" && state != "needs-login" && state != "reauth" && state != "loading" && state != "waiting" && state != "offline" && state != "stale" && state != "empty" && state != "error") state = "waiting";
        return new WidgetSnapshot
        {
            State = state,
            Title = Clean(value.Title, 120),
            Value = Clean(value.Value, 180),
            Detail = Clean(value.Detail, 1100),
            AccountLogin = Clean(value.AccountLogin, 120),
            UpdatedAt = Clean(value.UpdatedAt, 100),
            Percentage = state == "ready" ? percentage : null
        };
    }

    private void UpdateDescriptions()
    {
        string title = Painter.Title(snapshot);
        string value = Painter.Value(snapshot);
        string account = String.IsNullOrEmpty(snapshot.AccountLogin) ? "GitHub 账户尚未连接" : "GitHub: " + snapshot.AccountLogin;
        string detail = title + " · " + value + Environment.NewLine + snapshot.Detail + Environment.NewLine + account;
        if (!String.IsNullOrEmpty(snapshot.UpdatedAt)) detail += Environment.NewLine + "快照：" + snapshot.UpdatedAt;
        if (!String.IsNullOrEmpty(persistenceWarning)) detail += Environment.NewLine + persistenceWarning;
        tooltip.SetToolTip(this, detail + Environment.NewLine + "单击打开主程序 · 拖动移动 · 右键菜单");
        tray.Text = Clean("PilotMeter · " + title + " · " + value, 63);
        AccessibleName = "PilotMeter · " + title + " · " + value;
        AccessibleDescription = detail + "。单击或按 Enter、空格打开主程序。拖动移动；Esc 或 Alt+F4 隐藏到托盘。";
        AccessibilityNotifyClients(AccessibleEvents.NameChange, -1);
    }

    private void OpenMain()
    {
        if (exiting || clock.ElapsedMilliseconds - lastOpen < 350) return;
        lastOpen = clock.ElapsedMilliseconds;
        tooltip.Hide(this);
        try { openMain(); }
        catch (Exception) { tooltip.Show("主程序暂时无法打开，请稍后重试。", this, Width / 2, Height, 5000); }
    }

    private void HideToTray()
    {
        SaveSettings();
        if (animation != null) animation.Stop();
        tooltip.Hide(this);
        Hide();
        if (!hideExplained)
        {
            hideExplained = true;
            tray.ShowBalloonTip(3500, "PilotMeter 已隐藏到托盘", "单击托盘图标恢复挂件；右键可打开主程序或退出。后台服务继续运行。", ToolTipIcon.Info);
        }
    }

    private void RequestExit()
    {
        if (exiting) return;
        exiting = true;
        SaveSettings();
        try { exitApplication(); }
        catch (Exception)
        {
            exiting = false;
            tooltip.Show("暂时无法退出挂件，请重试。", this, Width / 2, Height, 4000);
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!disposing && !exiting && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            HideToTray();
        }
        else SaveSettings();
        base.OnFormClosing(e);
    }

    protected override void OnVisibleChanged(EventArgs e)
    {
        if (animation != null) { if (Visible) animation.Start(); else animation.Stop(); }
        base.OnVisibleChanged(e);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        // A saved secondary-monitor position may have changed DPI before initialization completed.
        using (Graphics graphics = CreateGraphics()) ConfigureScale(graphics.DpiX / 96f, Screen.FromRectangle(Bounds).WorkingArea);
        EnsureVisible();
        SaveSettings();
    }

    protected override void OnMouseEnter(EventArgs e) { hovered = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hovered = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left)
        {
            pressed = true;
            dragging = false;
            pressScreen = Cursor.Position;
            pressLocation = Location;
            Capture = true;
            Focus();
        }
        base.OnMouseDown(e);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (pressed)
        {
            Point point = Cursor.Position;
            int dx = point.X - pressScreen.X, dy = point.Y - pressScreen.Y;
            Size threshold = SystemInformation.DragSize;
            if (!dragging && (Math.Abs(dx) >= Math.Max(3, threshold.Width / 2) || Math.Abs(dy) >= Math.Max(3, threshold.Height / 2)))
            {
                dragging = true;
                tooltip.Hide(this);
            }
            if (dragging)
            {
                Rectangle area = Screen.FromPoint(point).WorkingArea;
                Location = KeepVisible(new Point(pressLocation.X + dx, pressLocation.Y + dy), Size, area);
            }
        }
        base.OnMouseMove(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left && pressed)
        {
            bool wasDragging = dragging;
            pressed = dragging = false;
            Capture = false;
            if (wasDragging) SaveSettings();
            else if (ClientRectangle.Contains(e.Location)) OpenMain();
            Invalidate();
        }
        base.OnMouseUp(e);
    }

    protected override void OnMouseCaptureChanged(EventArgs e)
    {
        if (pressed && !Capture)
        {
            if (dragging) SaveSettings();
            pressed = dragging = false;
            Invalidate();
        }
        base.OnMouseCaptureChanged(e);
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (!menu.Visible)
        {
            if (keyData == Keys.Enter || keyData == Keys.Space) { OpenMain(); return true; }
            if (keyData == Keys.Escape) { HideToTray(); return true; }
            if (keyData == Keys.Apps || keyData == (Keys.Shift | Keys.F10)) { menu.Show(this, new Point(Width / 2, Height / 2)); return true; }
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        bool animate = !SystemInformation.HighContrast && SystemInformation.IsMenuAnimationEnabled && !dragging && !menu.Visible;
        float bob = animate ? (float)Math.Sin(clock.ElapsedMilliseconds / 1500.0) * 0.65f : 0;
        e.Graphics.ScaleTransform(scale, scale);
        painter.Draw(e.Graphics, snapshot, hovered || ContainsFocus, animate && clock.ElapsedMilliseconds < blinkUntil, bob);
    }

    private int ScalePixels(int value) { return (int)Math.Round(value * scale); }

    private void ConfigureScale(float desiredScale, Rectangle area)
    {
        if (Single.IsNaN(desiredScale) || Single.IsInfinity(desiredScale)) desiredScale = 1;
        scale = Math.Min(Math.Max(0.75f, Math.Min(4f, desiredScale)), Math.Min(area.Width / (float)LogicalWidth, area.Height / (float)LogicalHeight));
        if (scale <= 0) scale = 1;
        ClientSize = new Size(Math.Max(1, ScalePixels(LogicalWidth)), Math.Max(1, ScalePixels(LogicalHeight)));
        using (GraphicsPath path = Painter.Rounded(new RectangleF(0, 0, Width, Height), ScalePixels(18)))
        {
            Region previous = Region;
            Region = new Region(path);
            if (previous != null) previous.Dispose();
        }
    }

    private static Point KeepVisible(Point point, Size size, Rectangle area)
    {
        return new Point(Math.Max(area.Left, Math.Min(point.X, area.Right - size.Width)), Math.Max(area.Top, Math.Min(point.Y, area.Bottom - size.Height)));
    }

    private void EnsureVisible()
    {
        Rectangle area = Screen.FromRectangle(Bounds).WorkingArea;
        if (Width > area.Width || Height > area.Height) ConfigureScale(scale, area);
        Location = KeepVisible(Location, Size, area);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect { public int Left, Top, Right, Bottom; }

    protected override void WndProc(ref Message m)
    {
        const int DpiChanged = 0x02E0, DisplayChanged = 0x007E, SettingChanged = 0x001A;
        if (initialized && m.Msg == DpiChanged)
        {
            int dpi = (int)(m.WParam.ToInt64() & 0xffff);
            NativeRect suggested = (NativeRect)Marshal.PtrToStructure(m.LParam, typeof(NativeRect));
            Point point = new Point(suggested.Left, suggested.Top);
            Rectangle area = Screen.FromPoint(point).WorkingArea;
            ConfigureScale(dpi / 96f, area);
            Location = KeepVisible(point, Size, area);
            if (pressed) { pressScreen = Cursor.Position; pressLocation = Location; }
            if (!dragging) SaveSettings();
            Invalidate();
            m.Result = IntPtr.Zero;
            return;
        }
        base.WndProc(ref m);
        if (initialized && !disposing && (m.Msg == DisplayChanged || m.Msg == SettingChanged))
        {
            EnsureVisible();
            SaveSettings();
            Invalidate();
        }
    }

    private static bool Integer(Dictionary<string, object> values, string key, int minimum, int maximum, out int result)
    {
        object value;
        result = 0;
        if (!values.TryGetValue(key, out value) || !(value is int)) return false;
        result = (int)value;
        return result >= minimum && result <= maximum;
    }

    private void ReadSettings()
    {
        try
        {
            if (!File.Exists(settingsPath)) return;
            string json;
            using (FileStream stream = new FileStream(settingsPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                if (stream.Length > 8192) throw new InvalidDataException();
                byte[] bytes = new byte[8193];
                int read, count = 0;
                while (count < bytes.Length && (read = stream.Read(bytes, count, bytes.Length - count)) != 0) count += read;
                if (count > 8192) throw new InvalidDataException();
                json = Encoding.UTF8.GetString(bytes, 0, count).TrimStart('\uFEFF');
            }
            var serializer = new JavaScriptSerializer { MaxJsonLength = 8192, RecursionLimit = 8 };
            var values = serializer.Deserialize<Dictionary<string, object>>(json);
            int version, x, y, width, height;
            object topmost;
            if (values == null || !Integer(values, "version", 1, 1, out version) || !Integer(values, "x", -100000, 100000, out x) || !Integer(values, "y", -100000, 100000, out y) || !Integer(values, "width", 100, 2000, out width) || !Integer(values, "height", 30, 1000, out height) || !values.TryGetValue("topmost", out topmost) || !(topmost is bool)) throw new InvalidDataException();
            Rectangle area = Screen.FromRectangle(new Rectangle(x, y, width, height)).WorkingArea;
            Location = KeepVisible(new Point(x, y), Size, area);
            TopMost = (bool)topmost;
        }
        catch (Exception error)
        {
            if (!(error is IOException) && !(error is UnauthorizedAccessException) && !(error is ArgumentException) && !(error is InvalidOperationException)) throw;
            persistenceWarning = "窗口位置配置暂不可用，使用可见的默认位置。";
        }
    }

    private void SaveSettings()
    {
        if (!initialized || disposing) return;
        string temporary = settingsPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(settingsPath));
            var values = new Dictionary<string, object> { { "version", 1 }, { "x", Left }, { "y", Top }, { "width", Width }, { "height", Height }, { "topmost", TopMost } };
            byte[] bytes = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(values));
            using (FileStream file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                file.Write(bytes, 0, bytes.Length);
                file.Flush(true);
            }
            if (File.Exists(settingsPath)) File.Replace(temporary, settingsPath, null);
            else File.Move(temporary, settingsPath);
            persistenceWarning = null;
        }
        catch (IOException) { persistenceWarning = "窗口位置未能保存；挂件仍可使用。"; }
        catch (UnauthorizedAccessException) { persistenceWarning = "窗口位置未能保存；挂件仍可使用。"; }
        finally
        {
            try { if (File.Exists(temporary)) File.Delete(temporary); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        UpdateDescriptions();
    }

    /// <summary>In-memory paint hook for packaging tests; the caller owns the returned bitmap. Never creates a window or writes a file.</summary>
    internal static Bitmap RenderPreview(WidgetSnapshot value, bool blink, float scale)
    {
        if (Single.IsNaN(scale) || Single.IsInfinity(scale) || scale < 0.75f || scale > 4f) throw new ArgumentOutOfRangeException("scale");
        Bitmap bitmap = new Bitmap((int)Math.Ceiling(LogicalWidth * scale), (int)Math.Ceiling(LogicalHeight * scale));
        try
        {
            using (Graphics graphics = Graphics.FromImage(bitmap))
            using (Painter renderer = new Painter())
            {
                graphics.Clear(Color.Transparent);
                graphics.ScaleTransform(scale, scale);
                renderer.Draw(graphics, CopySnapshot(value), false, blink, 0);
            }
            return bitmap;
        }
        catch { bitmap.Dispose(); throw; }
    }

    protected override void Dispose(bool disposingResources)
    {
        if (disposingResources && !disposing)
        {
            SaveSettings();
            disposing = true;
            if (animation != null) { animation.Stop(); animation.Dispose(); }
            if (tray != null) { tray.Visible = false; tray.Dispose(); }
            if (tooltip != null) tooltip.Dispose();
            if (menu != null) menu.Dispose();
            if (trayIcon != null) trayIcon.Dispose();
            if (painter != null) painter.Dispose();
            Region region = Region;
            Region = null;
            if (region != null) region.Dispose();
            clock.Stop();
        }
        base.Dispose(disposingResources);
    }

    private sealed class Painter : IDisposable
    {
        internal static readonly Color Background = Color.FromArgb(249, 251, 254);
        private readonly Font title, value, compactValue, caption;

        internal Painter()
        {
            using (Font systemFont = SystemFonts.MessageBoxFont)
            {
                title = new Font(systemFont.FontFamily, 10.5f, FontStyle.Regular, GraphicsUnit.Pixel);
                value = new Font(systemFont.FontFamily, 19, FontStyle.Bold, GraphicsUnit.Pixel);
                compactValue = new Font(systemFont.FontFamily, 14, FontStyle.Bold, GraphicsUnit.Pixel);
                caption = new Font(systemFont.FontFamily, 9.5f, FontStyle.Regular, GraphicsUnit.Pixel);
            }
        }

        internal static string Title(WidgetSnapshot snapshot)
        {
            if (!String.IsNullOrEmpty(snapshot.Title)) return snapshot.Title;
            if (snapshot.State == "needs-login" || snapshot.State == "reauth") return "连接 GitHub";
            if (snapshot.State == "offline") return "本地服务离线";
            if (snapshot.State == "error") return "快照暂不可用";
            if (snapshot.State == "ready") return "本机已记录";
            return "等待用量快照";
        }

        internal static string Value(WidgetSnapshot snapshot)
        {
            if (!String.IsNullOrEmpty(snapshot.Value)) return snapshot.Value;
            return snapshot.State == "needs-login" || snapshot.State == "reauth" ? "登录 GitHub" : "—";
        }

        internal static GraphicsPath Rounded(RectangleF rectangle, float radius)
        {
            GraphicsPath path = new GraphicsPath();
            float diameter = Math.Max(1, Math.Min(radius * 2, Math.Min(rectangle.Width, rectangle.Height)));
            path.AddArc(rectangle.Left, rectangle.Top, diameter, diameter, 180, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Top, diameter, diameter, 270, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rectangle.Left, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        internal void Draw(Graphics graphics, WidgetSnapshot snapshot, bool focused, bool blink, float bob)
        {
            bool highContrast = SystemInformation.HighContrast;
            Color ink = highContrast ? SystemColors.WindowText : Color.FromArgb(35, 57, 81);
            Color muted = highContrast ? SystemColors.WindowText : Color.FromArgb(112, 130, 149);
            Color accent = snapshot.State == "ready" ? Color.FromArgb(47, 137, 117) : snapshot.State == "needs-login" || snapshot.State == "reauth" ? Color.FromArgb(190, 137, 52) : snapshot.State == "error" ? Color.FromArgb(178, 89, 76) : Color.FromArgb(103, 133, 165);
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            using (GraphicsPath outline = Rounded(new RectangleF(0.7f, 0.7f, LogicalWidth - 1.4f, LogicalHeight - 1.4f), 17.5f))
            using (Brush background = new SolidBrush(highContrast ? SystemColors.Window : Background))
            using (Pen border = new Pen(highContrast ? SystemColors.WindowText : focused ? Color.FromArgb(131, 165, 196) : Color.FromArgb(212, 223, 234), focused ? 1.4f : 1))
            {
                graphics.FillPath(background, outline);
                graphics.DrawPath(border, outline);
            }
            DrawPilot(graphics, blink, bob, accent, snapshot.Percentage);
            using (Pen separator = new Pen(highContrast ? SystemColors.WindowText : Color.FromArgb(227, 234, 241))) graphics.DrawLine(separator, 66, 18, 66, 58);
            Text(graphics, Title(snapshot), title, muted, new RectangleF(77, 10, 132, 16));
            string amount = Value(snapshot);
            Text(graphics, amount, amount.Length > 12 ? compactValue : value, ink, new RectangleF(76, 27, 133, 27));
            string hint = String.IsNullOrEmpty(snapshot.AccountLogin) ? "点击打开主程序" : "@" + snapshot.AccountLogin;
            if (snapshot.State == "needs-login" || snapshot.State == "reauth") hint = "点击连接账户";
            else if (snapshot.State == "waiting") hint = "待同步 · 点击查看";
            else if (snapshot.State == "error") hint = "同步失败 · 点击查看";
            else if (snapshot.State == "stale") hint = "旧快照 · 待同步";
            else if (snapshot.State == "offline") hint = "服务离线 · 点击查看";
            Text(graphics, hint, caption, muted, new RectangleF(77, 55, 123, 14));
            using (Brush dot = new SolidBrush(accent)) graphics.FillEllipse(dot, 202, 60, 4, 4);
        }

        private static void Text(Graphics graphics, string text, Font font, Color color, RectangleF bounds)
        {
            using (Brush brush = new SolidBrush(color))
            using (StringFormat format = new StringFormat(StringFormatFlags.NoWrap))
            {
                format.Trimming = StringTrimming.EllipsisCharacter;
                format.LineAlignment = StringAlignment.Center;
                graphics.DrawString(text, font, brush, bounds, format);
            }
        }

        internal static void DrawPilot(Graphics graphics, bool blink, float bob, Color accent, double? percentage)
        {
            using (Brush halo = new SolidBrush(Color.FromArgb(234, 241, 248))) graphics.FillEllipse(halo, 9, 11, 50, 50);
            // An unknown denominator has no progress track or empty 0% gauge.
            if (percentage.HasValue)
            {
                using (Pen track = new Pen(Color.FromArgb(209, 224, 234), 2.5f)) graphics.DrawArc(track, 9, 11, 50, 50, -90, 360);
                if (percentage.Value > 0)
                    using (Pen fill = new Pen(accent, 2.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round }) graphics.DrawArc(fill, 9, 11, 50, 50, -90, (float)(percentage.Value * 3.6));
            }
            GraphicsState state = graphics.Save();
            try
            {
                graphics.TranslateTransform(0, bob);
                using (Brush shadow = new SolidBrush(Color.FromArgb(213, 226, 237))) graphics.FillEllipse(shadow, 20, 56, 29, 5);
                using (Brush jacket = new SolidBrush(Color.FromArgb(69, 105, 138)))
                using (GraphicsPath shoulders = Rounded(new RectangleF(20, 46, 29, 13), 6)) graphics.FillPath(jacket, shoulders);
                using (Brush scarf = new SolidBrush(Color.FromArgb(225, 153, 87)))
                {
                    graphics.FillPolygon(scarf, new[] { new PointF(37, 48), new PointF(51, 51), new PointF(43, 55), new PointF(35, 51) });
                    graphics.FillRectangle(scarf, 26, 46, 15, 4);
                }
                using (Brush helmet = new SolidBrush(Color.FromArgb(60, 85, 112))) graphics.FillEllipse(helmet, 19, 18, 31, 33);
                using (Brush face = new SolidBrush(Color.FromArgb(252, 225, 187))) graphics.FillEllipse(face, 23, 25, 23, 24);
                using (Brush strap = new SolidBrush(Color.FromArgb(41, 62, 88))) graphics.FillRectangle(strap, 19, 26, 31, 6);
                using (Brush goggles = new SolidBrush(Color.FromArgb(150, 187, 211)))
                using (Pen rim = new Pen(Color.FromArgb(224, 233, 238), 1.2f))
                using (GraphicsPath left = Rounded(new RectangleF(22, 23, 11, 9), 3))
                using (GraphicsPath right = Rounded(new RectangleF(35, 23, 11, 9), 3))
                {
                    graphics.FillPath(goggles, left); graphics.FillPath(goggles, right);
                    graphics.DrawPath(rim, left); graphics.DrawPath(rim, right);
                }
                using (Pen features = new Pen(Color.FromArgb(48, 57, 65), 1.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                using (Brush eye = new SolidBrush(Color.FromArgb(48, 57, 65)))
                {
                    if (blink) { graphics.DrawLine(features, 28, 37, 31, 37); graphics.DrawLine(features, 38, 37, 41, 37); }
                    else { graphics.FillEllipse(eye, 28.5f, 35, 2.5f, 3.5f); graphics.FillEllipse(eye, 38, 35, 2.5f, 3.5f); }
                    graphics.DrawArc(features, 31, 39, 7, 4, 10, 160);
                }
            }
            finally { graphics.Restore(state); }
        }

        public void Dispose() { title.Dispose(); value.Dispose(); compactValue.Dispose(); caption.Dispose(); }
    }
}
