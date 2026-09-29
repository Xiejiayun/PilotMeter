using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

internal sealed class WidgetSnapshot
{
    public string State, Title, Value, Detail, AccountLogin, UpdatedAt, UnitLabel;
    public bool UnitUnspecified;
    public double? Percentage;
}

internal sealed class WidgetAccount
{
    internal string Id, Login, Host, Status;
}

// UI-thread-owned read barrier shared by account mutations and category changes.
internal sealed class WidgetSnapshotGate
{
    private long revision;
    private int mutations;
    internal bool CanRead { get { return mutations == 0; } }
    internal long Capture() { return revision; }
    internal void Invalidate() { revision++; }
    internal void BeginMutation() { mutations++; revision++; }
    internal void EndMutation()
    {
        if (mutations == 0) throw new InvalidOperationException("No account operation is pending.");
        mutations--; revision++;
    }
    internal bool Accepts(long captured) { return mutations == 0 && captured == revision; }
}

internal sealed class WidgetAccountSet
{
    internal readonly List<WidgetAccount> Accounts = new List<WidgetAccount>();
    internal string ActiveId;
    internal bool Enabled;
    internal static WidgetAccountSet Read(Dictionary<string, object> source)
    {
        object raw;
        var result = new WidgetAccountSet { ActiveId = DesktopJson.OptionalString(source, "activeAccountId", 36) };
        if (!source.TryGetValue("enabled", out raw) || !(raw is bool)) throw new InvalidDataException("账号状态无效。");
        result.Enabled = (bool)raw;
        if (!source.TryGetValue("accounts", out raw) || !(raw is object[]) || ((object[])raw).Length > 20) throw new InvalidDataException("账号列表无效。");
        var ids = new HashSet<string>();
        foreach (object entry in (object[])raw)
        {
            var value = entry as Dictionary<string, object>;
            if (value == null) throw new InvalidDataException("账号列表无效。");
            var account = new WidgetAccount { Id = DesktopJson.String(value, "id", 36), Login = DesktopJson.String(value, "login", 128), Host = DesktopJson.String(value, "host", 256), Status = DesktopJson.String(value, "status", 32) };
            Guid id;
            if (!Guid.TryParse(account.Id, out id) || id.ToString("D") != account.Id || !ids.Add(account.Id)
                || !Regex.IsMatch(account.Host, @"^https://(?:github\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com)$")
                || !new HashSet<string>(new[] { "connected", "reauth-required", "error" }).Contains(account.Status)) throw new InvalidDataException("账号列表无效。");
            result.Accounts.Add(account);
        }
        if (result.ActiveId != null && !ids.Contains(result.ActiveId)) throw new InvalidDataException("当前账号已更换。");
        return result;
    }
    internal void VerifySnapshot(Dictionary<string, object> source)
    {
        object raw;
        if (!source.TryGetValue("accountId", out raw) || (raw != null && !(raw is string)) || (string)raw != ActiveId) throw new InvalidDataException("账号已更换，正在重新读取用量。");
    }
}

// A per-pixel alpha window: transparent pixels do not intercept desktop clicks.
internal sealed class DesktopWidget : Form
{
    private readonly DesktopPetPreferences preferences;
    private readonly Action openMain, exitApplication;
    private readonly Action<string> selectAccount;
    private readonly Action refresh;
    private readonly ToolTip tooltip;
    private readonly NotifyIcon tray;
    private readonly Icon trayIcon;
    private readonly ContextMenuStrip menu;
    private readonly ToolStripMenuItem restoreItem, hideItem, pinItem, motionItem, accountMenu, refreshItem, petMenu, sizeMenu;
    private readonly Timer animation;
    private readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
    private WidgetSnapshot snapshot = CopySnapshot(null);
    private Bitmap pet;
    private string renderedPet;
    private IList<WidgetAccount> accounts = new List<WidgetAccount>();
    private string activeAccountId;
    private bool accountsEnabled, actionBusy, initialized, disposing, exiting, pressed, dragging, hovered, hideExplained;
    private Point pressScreen, pressLocation, lastMouseScreen;
    private float scale = 1, renderScale = 1;
    private long lastOpen = -1000;

    internal DesktopWidget(DesktopPetPreferences preferences, Action openMain, Action exitApplication, Action<string> selectAccount, Action refresh)
    {
        if (preferences == null || openMain == null || exitApplication == null || selectAccount == null || refresh == null) throw new ArgumentNullException();
        this.preferences = preferences; this.openMain = openMain; this.exitApplication = exitApplication; this.selectAccount = selectAccount; this.refresh = refresh;
        FormBorderStyle = FormBorderStyle.None; StartPosition = FormStartPosition.Manual; AutoScaleMode = AutoScaleMode.None;
        ShowInTaskbar = false; MaximizeBox = MinimizeBox = false; Text = "PilotMeter 桌面宠物"; Cursor = Cursors.Hand; AccessibleRole = AccessibleRole.PushButton;
        menu = new ContextMenuStrip { AccessibleName = "PilotMeter 宠物菜单" };
        restoreItem = new ToolStripMenuItem("显示宠物", null, delegate { ShowWidget(); }); menu.Items.Add(restoreItem);
        menu.Items.Add(new ToolStripMenuItem("打开主窗口", null, delegate { OpenMain(); }));
        petMenu = new ToolStripMenuItem("切换宠物");
        foreach (var definition in DesktopPetCatalog.All)
        {
            string id = definition.Id;
            var item = new ToolStripMenuItem(definition.Id + "  " + definition.Name + " · " + definition.Description, null, delegate { preferences.SelectPet(id); });
            item.Tag = id; petMenu.DropDownItems.Add(item);
        }
        menu.Items.Add(petMenu);
        accountMenu = new ToolStripMenuItem("切换账号"); menu.Items.Add(accountMenu);
        refreshItem = new ToolStripMenuItem("刷新用量", null, delegate { refresh(); }); menu.Items.Add(refreshItem);
        menu.Items.Add(new ToolStripSeparator());
        sizeMenu = new ToolStripMenuItem("宠物大小");
        foreach (int value in new[] { 64, 80, 96, 128, 160 })
        {
            int pixels = value;
            var item = new ToolStripMenuItem(pixels + " px", null, delegate { preferences.SetSize(pixels); }); item.Tag = pixels; sizeMenu.DropDownItems.Add(item);
        }
        menu.Items.Add(sizeMenu);
        motionItem = new ToolStripMenuItem("轻动效", null, delegate { preferences.SetMotion(!preferences.MotionEnabled); }); menu.Items.Add(motionItem);
        pinItem = new ToolStripMenuItem("始终置顶", null, delegate { preferences.SetAlwaysOnTop(!preferences.AlwaysOnTop); }); menu.Items.Add(pinItem);
        hideItem = new ToolStripMenuItem("隐藏到托盘", null, delegate { HideToTray(); }); menu.Items.Add(hideItem);
        menu.Items.Add(new ToolStripSeparator()); menu.Items.Add(new ToolStripMenuItem("退出桌面宠物（后台继续运行）", null, delegate { RequestExit(); }));
        menu.Opening += delegate { UpdateMenu(); }; menu.Closed += delegate { RenderFrame(); }; ContextMenuStrip = menu;
        tooltip = new ToolTip { InitialDelay = 400, ReshowDelay = 120, AutoPopDelay = 15000, ShowAlways = true };
        trayIcon = DesktopBrand.CreateIcon(); tray = new NotifyIcon { Icon = trayIcon, Text = "PilotMeter", ContextMenuStrip = menu };
        tray.MouseClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) ShowWidget(); };
        tray.DoubleClick += delegate { OpenMain(); }; tray.BalloonTipClicked += delegate { ShowWidget(); };
        animation = new Timer { Interval = 80 }; animation.Tick += delegate { if (CanAnimate) RenderFrame(); };
        preferences.Changed += PreferencesChanged;
        pet = DesktopPetCatalog.CreateBitmap(preferences.PetId); renderedPet = preferences.PetId;
        IntPtr unused = Handle;
        using (var graphics = CreateGraphics()) scale = Math.Max(.75f, Math.Min(4, graphics.DpiX / 96f));
        Rectangle area = Screen.PrimaryScreen.WorkingArea; ConfigureSize(area);
        Location = preferences.Location ?? new Point(area.Right - Width - 16, area.Bottom - Height - 16);
        TopMost = preferences.AlwaysOnTop; EnsureVisible(); initialized = true; UpdateDescriptions(); tray.Visible = true;
    }
    private bool CanAnimate { get { return preferences.MotionEnabled && Visible && !dragging && !menu.Visible && !SystemInformation.HighContrast && SystemInformation.IsMenuAnimationEnabled; } }
    protected override CreateParams CreateParams { get { var value = base.CreateParams; value.ExStyle |= 0x00080000 | 0x80; return value; } }
    internal void ApplySnapshot(WidgetSnapshot value)
    {
        WidgetSnapshot copy = CopySnapshot(value); Dispatch(delegate { snapshot = copy; UpdateDescriptions(); RenderFrame(); });
    }
    internal void SetAccounts(IList<WidgetAccount> value, string active, bool enabled)
    {
        var copy = new List<WidgetAccount>();
        if (value != null) foreach (var account in value) copy.Add(new WidgetAccount { Id = account.Id, Login = Clean(account.Login, 120), Host = Clean(account.Host, 250), Status = account.Status });
        Dispatch(delegate { accounts = copy; activeAccountId = active; accountsEnabled = enabled; });
    }
    internal void SetActionBusy(bool busy)
    {
        Dispatch(delegate {
            actionBusy = busy;
            // A click can still be dispatching from this menu. Do not dispose its sender mid-event.
            refreshItem.Enabled = !busy; accountMenu.Enabled = !busy; refreshItem.Text = busy ? "正在同步…" : "刷新用量";
        });
    }
    internal void ShowNotice(string text) { Dispatch(delegate { tray.ShowBalloonTip(4500, "PilotMeter", Clean(text, 240), ToolTipIcon.Info); }); }
    internal void ShowWidget()
    {
        Dispatch(delegate { EnsureVisible(); if (!Visible) Show(); WindowState = FormWindowState.Normal; Activate(); Focus(); animation.Start(); RenderFrame(); });
    }
    private void Dispatch(Action action)
    {
        if (disposing || IsDisposed) return;
        try { if (InvokeRequired) BeginInvoke(new Action(delegate { if (!disposing && !IsDisposed) action(); })); else action(); } catch (InvalidOperationException) { }
    }
    private void PreferencesChanged(object sender, EventArgs e)
    {
        Dispatch(delegate {
            if (renderedPet != preferences.PetId)
            {
                Bitmap replacement = DesktopPetCatalog.CreateBitmap(preferences.PetId); pet.Dispose(); pet = replacement; renderedPet = preferences.PetId;
            }
            ConfigureSize(Screen.FromRectangle(Bounds).WorkingArea); TopMost = preferences.AlwaysOnTop; EnsureVisible(); SavePosition(); UpdateDescriptions(); RenderFrame();
        });
    }
    private void UpdateMenu()
    {
        restoreItem.Visible = !Visible; hideItem.Visible = Visible; pinItem.Checked = preferences.AlwaysOnTop; motionItem.Checked = preferences.MotionEnabled;
        foreach (ToolStripMenuItem item in petMenu.DropDownItems) item.Checked = (string)item.Tag == preferences.PetId;
        foreach (ToolStripMenuItem item in sizeMenu.DropDownItems) item.Checked = (int)item.Tag == preferences.SizePixels;
        refreshItem.Enabled = !actionBusy; refreshItem.Text = actionBusy ? "正在同步…" : "刷新用量";
        // Clear removes menu items without disposing them; explicitly release their click handlers.
        while (accountMenu.DropDownItems.Count > 0) { var item = accountMenu.DropDownItems[0]; accountMenu.DropDownItems.RemoveAt(0); item.Dispose(); }
        accountMenu.Enabled = !actionBusy;
        foreach (var account in accounts)
        {
            string id = account.Id;
            var item = new ToolStripMenuItem(account.Login + " · " + account.Host.Replace("https://", "") + (account.Status == "reauth-required" ? "（需重新登录）" : account.Status == "error" ? "（待同步）" : ""), null, delegate { selectAccount(id); });
            item.Checked = id == activeAccountId; item.Enabled = accountsEnabled && !actionBusy; accountMenu.DropDownItems.Add(item);
        }
        if (accounts.Count == 0) accountMenu.DropDownItems.Add(new ToolStripMenuItem("尚无已连接账号") { Enabled = false });
        accountMenu.DropDownItems.Add(new ToolStripSeparator()); accountMenu.DropDownItems.Add(new ToolStripMenuItem("管理账号…", null, delegate { OpenMain(); }));
    }
    internal static string Clean(string value, int maximum)
    {
        if (String.IsNullOrEmpty(value)) return String.Empty;
        var result = new StringBuilder(Math.Min(value.Length, maximum));
        foreach (char character in value) { if (result.Length >= maximum) break; result.Append(Char.IsControl(character) ? ' ' : character); }
        if (result.Length > 0 && Char.IsHighSurrogate(result[result.Length - 1])) result.Length--; return result.ToString().Trim();
    }
    internal static WidgetSnapshot CopySnapshot(WidgetSnapshot value)
    {
        if (value == null) return new WidgetSnapshot { State = "loading", Title = "PilotMeter", Value = "正在连接", Detail = "等待本地服务快照。" };
        string state = Clean(value.State, 32).ToLowerInvariant();
        if (!new HashSet<string>(new[] { "ready", "needs-login", "reauth", "loading", "waiting", "offline", "stale", "empty", "error" }).Contains(state)) state = "waiting";
        double? percentage = value.Percentage;
        if (state != "ready" || percentage.HasValue && (Double.IsNaN(percentage.Value) || Double.IsInfinity(percentage.Value) || percentage.Value < 0 || percentage.Value > 100)) percentage = null;
        string unit = value.UnitLabel == "AI Credits" || value.UnitLabel == "Premium Requests" ? value.UnitLabel : null;
        return new WidgetSnapshot { State = state, Title = Clean(value.Title, 120), Value = Clean(value.Value, 180), Detail = Clean(value.Detail, 1100), AccountLogin = Clean(value.AccountLogin, 120), UpdatedAt = Clean(value.UpdatedAt, 100), Percentage = percentage, UnitLabel = unit, UnitUnspecified = value.UnitUnspecified };
    }
    internal static string Caption(WidgetSnapshot value)
    {
        if (value.State == "needs-login" || value.State == "reauth") return "点击连接 GitHub";
        if (value.State == "offline") return "服务离线 · 点击重试";
        if (value.State == "error") return "同步失败 · 点击查看";
        if (value.State == "stale") return "快照过期 · 等待同步";
        return String.IsNullOrEmpty(value.Value) ? "点击查看用量" : value.Value;
    }
    internal static string CaptionUnit(WidgetSnapshot value) { return value.State == "ready" ? value.UnitUnspecified ? "单位未确认" : value.UnitLabel : null; }
    private void UpdateDescriptions()
    {
        string detail = snapshot.Title + " · " + snapshot.Value + Environment.NewLine + snapshot.Detail + Environment.NewLine;
        detail += String.IsNullOrEmpty(snapshot.AccountLogin) ? "GitHub 账户尚未连接" : "GitHub: " + snapshot.AccountLogin;
        if (!String.IsNullOrEmpty(snapshot.UpdatedAt)) detail += Environment.NewLine + "数据时间：" + snapshot.UpdatedAt;
        if (preferences.PersistenceWarning != null) detail += Environment.NewLine + preferences.PersistenceWarning;
        tooltip.SetToolTip(this, detail + Environment.NewLine + "单击打开主窗口 · 拖动移动 · 右键切换宠物和账号");
        tray.Text = Clean("PilotMeter · " + Caption(snapshot), 63);
        AccessibleName = "PilotMeter · " + DesktopPetCatalog.Find(preferences.PetId).Name + " · " + Caption(snapshot);
        AccessibleDescription = detail + "。Enter 或空格打开主窗口；拖动移动；Esc 隐藏到托盘。"; AccessibilityNotifyClients(AccessibleEvents.NameChange, -1);
    }
    private void OpenMain()
    {
        if (exiting || clock.ElapsedMilliseconds - lastOpen < 350) return; lastOpen = clock.ElapsedMilliseconds; tooltip.Hide(this); openMain();
    }
    private void HideToTray()
    {
        SavePosition(); animation.Stop(); tooltip.Hide(this); Hide();
        if (!hideExplained) { hideExplained = true; ShowNotice("桌面宠物已隐藏。单击托盘图标可恢复，后台服务继续运行。"); }
    }
    private void RequestExit() { if (exiting) return; exiting = true; SavePosition(); exitApplication(); }
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!disposing && !exiting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; HideToTray(); } else SavePosition(); base.OnFormClosing(e);
    }
    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e); using (var graphics = CreateGraphics()) scale = Math.Max(.75f, Math.Min(4, graphics.DpiX / 96f));
        ConfigureSize(Screen.FromRectangle(Bounds).WorkingArea); EnsureVisible(); SavePosition(); animation.Start(); RenderFrame();
    }
    protected override void OnVisibleChanged(EventArgs e) { if (animation != null) { if (Visible) animation.Start(); else animation.Stop(); } base.OnVisibleChanged(e); }
    protected override void OnMouseEnter(EventArgs e) { hovered = true; RenderFrame(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hovered = false; RenderFrame(); base.OnMouseLeave(e); }
    protected override void OnGotFocus(EventArgs e) { RenderFrame(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { RenderFrame(); base.OnLostFocus(e); }
    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left) { pressed = true; dragging = false; pressScreen = lastMouseScreen = PointToScreen(e.Location); pressLocation = Location; Capture = true; Focus(); } base.OnMouseDown(e);
    }
    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (pressed)
        {
            Point point = lastMouseScreen = PointToScreen(e.Location); int dx = point.X - pressScreen.X, dy = point.Y - pressScreen.Y; Size threshold = SystemInformation.DragSize;
            if (!dragging && (Math.Abs(dx) >= Math.Max(3, threshold.Width / 2) || Math.Abs(dy) >= Math.Max(3, threshold.Height / 2))) { dragging = true; tooltip.Hide(this); }
            if (dragging) { Location = DesktopPetRenderer.KeepVisible(new Point(pressLocation.X + dx, pressLocation.Y + dy), Size, Screen.FromPoint(point).WorkingArea); RenderFrame(); }
        }
        base.OnMouseMove(e);
    }
    protected override void OnMouseUp(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left && pressed)
        {
            bool moved = dragging; pressed = dragging = false; Capture = false;
            if (moved) SavePosition(); else if (ClientRectangle.Contains(e.Location)) OpenMain(); RenderFrame();
        }
        base.OnMouseUp(e);
    }
    protected override void OnMouseCaptureChanged(EventArgs e)
    {
        if (pressed && !Capture) { if (dragging) SavePosition(); pressed = dragging = false; RenderFrame(); } base.OnMouseCaptureChanged(e);
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
    private void ConfigureSize(Rectangle area)
    {
        Size logical = DesktopPetRenderer.LogicalSize(preferences.SizePixels);
        float actual = Math.Min(scale, Math.Min(area.Width / (float)logical.Width, area.Height / (float)logical.Height));
        renderScale = actual;
        ClientSize = new Size(Math.Max(1, (int)Math.Round(logical.Width * actual)), Math.Max(1, (int)Math.Round(logical.Height * actual)));
    }
    private void EnsureVisible() { Rectangle area = Screen.FromRectangle(Bounds).WorkingArea; ConfigureSize(area); Location = DesktopPetRenderer.KeepVisible(Location, Size, area); }
    private void SavePosition() { if (initialized && !disposing) { preferences.SetPosition(Location); UpdateDescriptions(); } }

    [StructLayout(LayoutKind.Sequential)] private struct NativePoint { internal int X, Y; internal NativePoint(int x, int y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)] private struct NativeSize { internal int Width, Height; internal NativeSize(int width, int height) { Width = width; Height = height; } }
    [StructLayout(LayoutKind.Sequential)] private struct NativeRect { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] private struct Blend { internal byte Operation, Flags, Alpha, Format; }
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UpdateLayeredWindow(IntPtr window, IntPtr destination, ref NativePoint position, ref NativeSize size, IntPtr source, ref NativePoint origin, int color, ref Blend blend, int flags);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr context);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr context);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr context);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr context, IntPtr value);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
    private void RenderFrame()
    {
        if (!initialized || disposing || !IsHandleCreated || pet == null || !Visible) return;
        using (var bitmap = DesktopPetRenderer.Render(pet, preferences.SizePixels, renderScale, CanAnimate ? clock.ElapsedMilliseconds / 850.0 : 0, Caption(snapshot), hovered || ContainsFocus, preferences.PetId == "10", CaptionUnit(snapshot)))
        {
            IntPtr screen = GetDC(IntPtr.Zero), memory = IntPtr.Zero, nativeBitmap = IntPtr.Zero, previous = IntPtr.Zero;
            try
            {
                memory = CreateCompatibleDC(screen); nativeBitmap = bitmap.GetHbitmap(Color.FromArgb(0)); previous = SelectObject(memory, nativeBitmap);
                var destination = new NativePoint(Left, Top); var origin = new NativePoint(0, 0); var size = new NativeSize(bitmap.Width, bitmap.Height); var blend = new Blend { Alpha = 255, Format = 1 };
                if (!UpdateLayeredWindow(Handle, screen, ref destination, ref size, memory, ref origin, 0, ref blend, 2)) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            finally
            {
                if (previous != IntPtr.Zero && memory != IntPtr.Zero) SelectObject(memory, previous); if (nativeBitmap != IntPtr.Zero) DeleteObject(nativeBitmap);
                if (memory != IntPtr.Zero) DeleteDC(memory); if (screen != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screen);
            }
        }
    }
    protected override void WndProc(ref Message message)
    {
        if (initialized && message.Msg == 0x02E0)
        {
            scale = Math.Max(.75f, Math.Min(4, (int)(message.WParam.ToInt64() & 0xffff) / 96f));
            var suggested = (NativeRect)Marshal.PtrToStructure(message.LParam, typeof(NativeRect)); var point = new Point(suggested.Left, suggested.Top); Rectangle area = Screen.FromPoint(point).WorkingArea;
            ConfigureSize(area); Location = DesktopPetRenderer.KeepVisible(point, Size, area);
            if (pressed) { pressScreen = lastMouseScreen; pressLocation = Location; }
            if (!dragging) SavePosition(); RenderFrame(); message.Result = IntPtr.Zero; return;
        }
        base.WndProc(ref message);
        if (initialized && !disposing && (message.Msg == 0x007E || message.Msg == 0x001A)) { EnsureVisible(); SavePosition(); RenderFrame(); }
    }
    protected override void Dispose(bool disposeResources)
    {
        if (disposeResources && !disposing)
        {
            SavePosition(); disposing = true; preferences.Changed -= PreferencesChanged;
            animation.Stop(); animation.Dispose(); tray.Visible = false; tray.Dispose(); tooltip.Dispose(); menu.Dispose(); trayIcon.Dispose(); if (pet != null) pet.Dispose(); clock.Stop();
        }
        base.Dispose(disposeResources);
    }
}
