using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;

// Exercise the actual shipping control tree without displaying any user window.
internal static class DesktopLayoutTests
{
    private static readonly List<string> failures = new List<string>();
    private static int assertions;
    private static readonly List<string> metrics = new List<string>();

    private static object Field(object target, string name)
    {
        return target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(target);
    }

    private static void Call(object target, string name, params object[] arguments)
    {
        target.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic).Invoke(target, arguments);
    }

    private static void Check(bool condition, string description)
    {
        assertions++;
        if (!condition) failures.Add(description);
    }

    private static string Name(Control control)
    {
        return control.GetType().Name + " " + (String.IsNullOrEmpty(control.Name) ? control.Text.Replace("\r", " ").Replace("\n", " ") : control.Name);
    }

    private static void Collect(Control parent, List<Control> controls)
    {
        controls.Add(parent);
        foreach (Control child in parent.Controls) Collect(child, controls);
    }

    private static void Layout(Control parent)
    {
        parent.PerformLayout();
        foreach (Control child in parent.Controls) Layout(child);
    }

    private static void ShowAndDrain(Form form)
    {
        var shown = false;
        EventHandler onShown = delegate {
            shown = true;
            // A pending login starts its poll timer in the shipping Shown handler.
            // Stop it in the same event before pumping another message, keeping
            // this render fixture entirely local and deterministic.
            if (form is NativeLoginDialog) ((System.Windows.Forms.Timer)Field(form, "timer")).Stop();
        };
        form.Shown += onShown;
        try
        {
            form.Show(); Application.DoEvents(); Application.DoEvents();
            Check(shown, form.Name + ": the shipping Shown lifecycle must run before layout verification.");
        }
        finally { form.Shown -= onShown; }
    }

    private static void Scale(Form form, float factor, Size size, List<Font> fonts)
    {
        if (form is DashboardWindow) form.GetType().GetField("layoutReady", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(form, false);
        var nativeScale = form.AutoScaleDimensions.Width / 96F;
        if (nativeScale < .5F) nativeScale = 1;
        var relativeScale = factor / nativeScale;
        form.AutoScaleMode = AutoScaleMode.None;
        var controls = new List<Control>(); Collect(form, controls);
        var original = new List<Font>(); foreach (var control in controls) original.Add(control.Font);
        form.SuspendLayout();
        form.Scale(new SizeF(relativeScale, relativeScale));
        for (var index = 0; index < controls.Count; index++)
        {
            var font = new Font(original[index].FontFamily, original[index].Size * relativeScale, original[index].Style);
            fonts.Add(font); controls[index].Font = font;
        }
        form.MinimumSize = Size.Empty;
        form.ClientSize = new Size((int)Math.Round(size.Width * factor), (int)Math.Round(size.Height * factor));
        form.ResumeLayout(true);
        if (form is DashboardWindow)
        {
            form.GetType().GetField("layoutReady", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(form, true);
            Call(form, "RefreshAdaptiveLayout");
        }
        Layout(form); Layout(form);
    }

    private static void Verify(Control parent, string scenario)
    {
        if (!parent.Visible) return;
        var children = new List<Control>();
        foreach (Control child in parent.Controls)
        {
            if (!child.Visible) continue;
            children.Add(child);
            if (!(parent is ScrollableControl && ((ScrollableControl)parent).AutoScroll) && !(parent is DataGridView))
                Check(child.Left >= -1 && child.Top >= -1 && child.Right <= parent.ClientSize.Width + 1 && child.Bottom <= parent.ClientSize.Height + 1,
                    scenario + ": control outside parent: " + Name(child) + " " + child.Bounds + " in " + Name(parent) + " " + parent.ClientSize);
            var label = child as Label;
            if (label != null && !String.IsNullOrEmpty(label.Text))
            {
                var proposed = new Size(Math.Max(1, label.ClientSize.Width), Int32.MaxValue);
                // Account identifiers intentionally use one compact line with an
                // ellipsis; their full value is retained in the tooltip and accessibility text.
                var compactIdentity = label.Name == "SidebarAccountLogin" || label.Name == "SidebarAccountHost";
                var measured = label is NativeExactLabel ? label.GetPreferredSize(proposed) : TextRenderer.MeasureText(label.Text, label.Font, proposed, (compactIdentity ? TextFormatFlags.SingleLine : TextFormatFlags.WordBreak) | TextFormatFlags.NoPrefix);
                Check(measured.Height <= label.ClientSize.Height + 1 && (compactIdentity && label.AutoEllipsis || measured.Width <= label.ClientSize.Width + 1),
                    scenario + ": clipped label: " + Name(label) + " needs " + measured.Height + ", has " + label.ClientSize);
            }
            Verify(child, scenario);
        }
        if (!(parent is DataGridView))
            for (var first = 0; first < children.Count; first++)
                for (var second = first + 1; second < children.Count; second++)
                {
                    var intersection = Rectangle.Intersect(children[first].Bounds, children[second].Bounds);
                    Check(intersection.Width <= 1 || intersection.Height <= 1,
                        scenario + ": overlapping siblings: " + Name(children[first]) + " and " + Name(children[second]));
                }
    }

    internal static int Run(string output)
    {
        Directory.CreateDirectory(output);
        File.WriteAllText(Path.Combine(output, "dpi-metrics.txt"), "");
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        var stageTimer = Stopwatch.StartNew();
        CheckButtonInteraction();
        RecordMetric(output, "Button interaction completed in " + stageTimer.ElapsedMilliseconds + " ms");
        stageTimer.Restart();
        using (var form = new DashboardWindow(output, delegate { return Task.FromResult(0); }))
        {
            form.SetPetPreferences(new DesktopPetPreferences(output));
            RecordMetric(output, "Before showing: " + DpiMetrics(form));
            form.Opacity = 0; form.ShowInTaskbar = false; form.StartPosition = FormStartPosition.Manual; form.Location = new Point(-32000, -32000);
            ShowAndDrain(form); Layout(form); Layout(form);
            RecordMetric(output, "After showing: " + DpiMetrics(form));
            Verify(form, "actual-monitor-first-show");
            Save(form, output, "actual-monitor-first-show");
            form.Hide();
        }
        RecordMetric(output, "Actual monitor first show completed in " + stageTimer.ElapsedMilliseconds + " ms");
        foreach (var factor in new[] { 1F, 1.25F, 1.5F, 2F })
        foreach (var size in new[] { new Size(864, 601), new Size(1280, 850) })
        {
            var elapsed = Stopwatch.StartNew();
            var matrix = size.Width + "px at " + (factor * 100).ToString("0") + "%";
            Console.WriteLine("Layout matrix starting: " + matrix);
            var fonts = new List<Font>();
            using (var form = new DashboardWindow(output, delegate { return Task.FromResult(0); }))
            {
                form.SetPetPreferences(new DesktopPetPreferences(output));
                form.Opacity = 0; form.ShowInTaskbar = false; form.StartPosition = FormStartPosition.Manual; form.Location = new Point(-32000, -32000);
                ShowAndDrain(form);
                Scale(form, factor, size, fonts);
                Verify(form, "empty-overview-" + size.Width + "-" + (factor * 100).ToString("0"));
                Call(form, "ApplyOverview", Populated());
                foreach (var page in new[] { "overview", "models", "records", "accounts" })
                {
                    Call(form, "Navigate", page); Layout(form); Layout(form);
                    var scenario = page + "-" + size.Width + "-" + (factor * 100).ToString("0");
                    Verify(form, scenario);
                    Save(form, output, scenario);
                }
                Call(form, "Navigate", "overview");
                var unlimited = Populated(); unlimited.Primary.Unlimited = true; unlimited.Primary.Remaining = unlimited.Primary.Limit = null;
                Call(form, "ApplyOverview", unlimited); Layout(form);
                Verify(form, "unlimited-overview-" + size.Width + "-" + (factor * 100).ToString("0"));
                ((Label)Field(form, "quotaDetail")).Text = "本机服务与桌面版本不一致。请点击右上角“重启本机服务”，恢复后再连接 GitHub 账号。";
                Layout(form); Verify(form, "service-recovery-" + size.Width + "-" + (factor * 100).ToString("0"));
                CheckExactQuantities(form, output, size, factor);
                if (size.Width == 1280) CheckResponsiveMetrics(form, output, factor);
                form.Hide();
            }
            foreach (var font in fonts) font.Dispose();
            var timing = "Layout matrix completed: " + matrix + " in " + elapsed.ElapsedMilliseconds + " ms";
            RecordMetric(output, timing);
        }
        stageTimer.Restart();
        CheckShortSidebar(output);
        RecordMetric(output, "Short sidebar completed in " + stageTimer.ElapsedMilliseconds + " ms");
        foreach (var factor in new[] { 1F, 1.5F, 2F })
        foreach (var state in new[] { "initial", "starting", "pending", "failed", "expired" })
        {
            stageTimer.Restart();
            var fonts = new List<Font>();
            var login = state == "initial" ? null : new NativeLogin { Id = "11111111-1111-4111-8111-111111111111", Host = "https://github.com", Status = state,
                UserCode = state == "pending" ? "ABCD-EFGH" : null, VerificationUri = "https://github.com/login/device", ExpiresAt = DateTime.UtcNow.AddMinutes(5).ToString("o"),
                Error = "无法连接 GitHub。请检查网络或代理设置后重试；如果已在网页授权，请确认使用的 GitHub 账号正确。" };
            var service = new DesktopInstance { Version = "layout-test", InstanceId = "11111111-1111-4111-8111-111111111111", Origin = new Uri("http://127.0.0.1:1/") };
            using (var form = new NativeLoginDialog(service, null, login))
            {
                form.Opacity = 0; form.ShowInTaskbar = false; form.StartPosition = FormStartPosition.Manual; form.Location = new Point(-32000, -32000);
                ShowAndDrain(form); Scale(form, factor, new Size(484, 451), fonts);
                Call(form, "Render"); Layout(form); Layout(form);
                var scenario = "login-" + state + "-" + (factor * 100).ToString("0");
                CheckLoginStatusVisible(form, scenario);
                Verify(form, scenario); Save(form, output, scenario); form.Hide();
                if (state == "pending")
                {
                    Call(form, "ServiceChanged");
                    Check(((TextBox)Field(form, "code")).Text == "" && ((TextBox)Field(form, "address")).Text == "", "Service replacement must clear the old device code and address.");
                    Check(!((Button)Field(form, "start")).Enabled && !((Button)Field(form, "open")).Enabled && !((Button)Field(form, "copy")).Enabled && ((Button)Field(form, "cancel")).Enabled, "Service replacement must leave only the close action available.");
                }
            }
            foreach (var font in fonts) font.Dispose();
            RecordMetric(output, "Login " + state + " at " + (factor * 100).ToString("0") + "% completed in " + stageTimer.ElapsedMilliseconds + " ms");
        }
        File.WriteAllLines(Path.Combine(output, "layout-results.txt"), failures.ToArray());
        File.WriteAllLines(Path.Combine(output, "dpi-metrics.txt"), metrics.ToArray());
        if (failures.Count > 0) throw new Exception("Native layout failed: " + failures.Count + " clipping/overlap issues. " + failures[0] + ". Full report: " + Path.Combine(output, "layout-results.txt"));
        return assertions;
    }

    private static void CheckLoginStatusVisible(NativeLoginDialog form, string scenario)
    {
        var viewport = (ScrollableControl)form.Controls.Find("LoginInstructions", true)[0];
        var status = (Label)Field(form, "status");
        var bounds = viewport.RectangleToClient(status.RectangleToScreen(status.ClientRectangle));
        Check(viewport.AutoScrollPosition == Point.Empty, scenario + ": login feedback must start at the top of the instructions, without automatic scrolling.");
        Check(status.Visible && !String.IsNullOrEmpty(status.Text), scenario + ": the current login status must be rendered.");
        Check(bounds.Left >= 0 && bounds.Top >= 0 && bounds.Right <= viewport.ClientSize.Width && bounds.Bottom <= viewport.ClientSize.Height,
            scenario + ": login progress or failure feedback must be fully visible in the initial minimum-size viewport: " + bounds + " in " + viewport.ClientSize);
    }

    private static void RecordMetric(string output, string value)
    {
        metrics.Add(value);
        Console.WriteLine(value);
        File.AppendAllText(Path.Combine(output, "dpi-metrics.txt"), value + Environment.NewLine);
    }

    private static Color ButtonPixel(Button button)
    {
        using (var bitmap = new Bitmap(button.Width, button.Height))
        using (var graphics = Graphics.FromImage(bitmap))
        {
            Call(button, "OnPaint", new PaintEventArgs(graphics, button.ClientRectangle));
            return bitmap.GetPixel(button.Width / 2, button.Height / 2);
        }
    }

    private static void CheckButtonInteraction()
    {
        using (var form = new Form { Name = "NativeButtonFixture", Opacity = 0, ShowInTaskbar = false, StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), ClientSize = new Size(420, 80) })
        using (var button = new NativeActionButton { Size = new Size(180, 44), BackColor = Color.White, ForeColor = Color.Black, FlatStyle = FlatStyle.Flat, TabIndex = 0 })
        using (var standard = new Button { Location = new Point(200, 0), Size = new Size(180, 44), FlatStyle = FlatStyle.Flat, TabIndex = 1 })
        {
            button.FlatAppearance.MouseOverBackColor = Color.FromArgb(237, 244, 241);
            form.Controls.Add(button); form.Controls.Add(standard); form.AcceptButton = button;
            ShowAndDrain(form);
            var clicks = 0; var standardClicks = 0;
            button.Click += delegate { clicks++; }; standard.Click += delegate { standardClicks++; };
            var normal = ButtonPixel(button);
            Call(button, "OnKeyDown", new KeyEventArgs(Keys.Space));
            var pressed = ButtonPixel(button);
            Check(pressed != normal, "Space must visibly depress the custom button.");
            Call(button, "OnMouseLeave", EventArgs.Empty);
            Check(ButtonPixel(button) == pressed, "Mouse leave must not clear a held Space key's visual state.");
            Call(button, "OnKeyDown", new KeyEventArgs(Keys.Space));
            Call(button, "OnKeyUp", new KeyEventArgs(Keys.Space));
            Call(standard, "OnKeyDown", new KeyEventArgs(Keys.Space)); Call(standard, "OnKeyUp", new KeyEventArgs(Keys.Space));
            Check(clicks == 1 && clicks == standardClicks && ButtonPixel(button) == normal, "Space repeat/release must click once and restore the normal surface like a standard Button.");
            form.ActiveControl = button;
            Call(form, "ProcessDialogKey", Keys.Enter);
            Check(clicks == 2 && ButtonPixel(button) == normal, "The form's Enter/default-button route must click once without a stuck pressed surface.");
            form.ActiveControl = button;
            Check(form.SelectNextControl(button, true, true, true, true) && form.ActiveControl == standard,
                "Tab navigation must retain the next native button as a selectable control.");

            Call(button, "OnMouseEnter", EventArgs.Empty); var hover = ButtonPixel(button);
            Call(button, "OnMouseDown", new MouseEventArgs(MouseButtons.Right, 1, 10, 10, 0));
            Check(ButtonPixel(button) == hover, "A secondary mouse button must not depress a primary action.");
            Call(button, "OnMouseUp", new MouseEventArgs(MouseButtons.Right, 1, 10, 10, 0));
            Call(button, "OnMouseDown", new MouseEventArgs(MouseButtons.Left, 1, 10, 10, 0));
            Check(ButtonPixel(button) == pressed, "Left mouse down must visibly depress the action.");
            Call(button, "OnMouseLeave", EventArgs.Empty);
            Check(ButtonPixel(button) == normal, "Dragging outside must remove the mouse pressed surface.");
            Call(button, "OnMouseEnter", EventArgs.Empty);
            Check(ButtonPixel(button) == pressed, "Dragging back inside while armed must restore the pressed surface.");
            button.Capture = false; Call(button, "OnMouseCaptureChanged", EventArgs.Empty);
            Check(ButtonPixel(button) == hover, "Losing mouse capture must release the pressed surface.");
            Call(button, "OnKeyDown", new KeyEventArgs(Keys.Space)); Call(button, "OnLostFocus", EventArgs.Empty);
            Check(ButtonPixel(button) == hover, "Losing keyboard focus must release the Space visual state.");
            Call(button, "OnKeyDown", new KeyEventArgs(Keys.Space)); button.Enabled = false;
            var disabled = ButtonPixel(button); var beforeDisabledClick = clicks;
            button.PerformClick();
            Check(clicks == beforeDisabledClick && disabled != pressed, "Disabled actions must neither activate nor keep their pressed surface.");
            button.Enabled = true;
            Check(ButtonPixel(button) == normal, "Re-enabling an action must not restore an old keyboard or mouse press.");
            KeyEventHandler suppress = delegate(object sender, KeyEventArgs e) { e.SuppressKeyPress = true; };
            button.KeyDown += suppress; Call(button, "OnKeyDown", new KeyEventArgs(Keys.Space)); button.KeyDown -= suppress;
            Check(ButtonPixel(button) == normal, "Suppressing Space must not wait for a KeyUp that the handler suppresses.");
            form.Hide();
        }
    }

    private static void CheckResponsiveMetrics(DashboardWindow form, string output, float factor)
    {
        var originalSize = form.ClientSize;
        var suffix = (factor * 100).ToString("0");
        var card = form.Controls.Find("PrimaryQuotaCard", true)[0];
        var label = (Label)Field(form, "quotaTotal");
        var metricsTable = (TableLayoutPanel)label.Parent.Parent.Parent;
        var shortValues = Populated();
        shortValues.Primary.Used = "12"; shortValues.Primary.Limit = "100"; shortValues.Primary.Remaining = "88";
        shortValues.Primary.Percentage = 12; shortValues.Primary.UsedPercentageText = "12";
        shortValues.Primary.RemainingPercentage = 88; shortValues.Primary.RemainingPercentageText = "88";
        try
        {
            form.ClientSize = new Size((int)(1280 * factor), (int)(850 * factor));
            Call(form, "ApplyOverview", shortValues); Layout(form); Layout(form);
            Check(metricsTable.ColumnCount == 3, "Wide short values must use three columns: " + suffix);
            var wideHeight = card.Height;
            // Repeat the fractional-DPI case to catch accumulated rounding;
            // the other scales each exercise the complete mode round trip.
            for (var cycle = 0; cycle < (factor == 1.25F ? 2 : 1); cycle++)
            {
                form.ClientSize = new Size((int)(864 * factor), (int)(601 * factor)); Layout(form); Layout(form);
                Check(metricsTable.ColumnCount == 1, "Narrow values must use vertical rows: " + suffix);
                Verify(card, "responsive-narrow-" + suffix);
                var longValues = Populated();
                longValues.Primary.Used = "0";
                longValues.Primary.Limit = longValues.Primary.Remaining = "1" + new String('2', 254) + "9";
                longValues.Primary.Percentage = 0; longValues.Primary.UsedPercentageText = "0";
                longValues.Primary.RemainingPercentage = 100; longValues.Primary.RemainingPercentageText = "100";
                Call(form, "ApplyOverview", longValues); Layout(form); Layout(form);
                var viewport = (Panel)label.Parent;
                viewport.AutoScrollPosition = new Point(viewport.DisplayRectangle.Width, 0); Layout(form);
                Check(label.Left == viewport.AutoScrollPosition.X && label.Left < 0 && label.Right <= viewport.ClientSize.Width,
                    "The last digit must remain reachable after switching to vertical rows: " + suffix);
                if (cycle == 0) Save(form, output, "responsive-long-864-" + suffix);
                form.ClientSize = new Size((int)(1280 * factor), (int)(850 * factor)); Layout(form); Layout(form);
                Check(metricsTable.ColumnCount == 1, "A wide window must keep a 256-digit value in vertical rows: " + suffix);
                Call(form, "ApplyOverview", shortValues); Layout(form); Layout(form);
                Check(metricsTable.ColumnCount == 3 && card.Height == wideHeight,
                    "Returning to short wide values must restore the original column layout and card height: " + suffix);
                foreach (var name in new[] { "quotaUsed", "quotaTotal", "quotaValue" })
                {
                    var value = (Label)Field(form, name); var view = (Panel)value.Parent;
                    Check(view.AutoScrollPosition == Point.Empty && !view.HorizontalScroll.Visible && value.Left == 0,
                        "Short values must clear old scroll positions and ranges after a mode change: " + name + "-" + suffix);
                }
                Verify(card, "responsive-restored-" + suffix);
            }
            Save(form, output, "responsive-wide-1280-" + suffix);
        }
        finally { form.ClientSize = originalSize; Layout(form); Layout(form); }
    }

    private static void CheckShortSidebar(string output)
    {
        var fonts = new List<Font>();
        using (var form = new DashboardWindow(output, delegate { return Task.FromResult(0); }))
        {
            form.SetPetPreferences(new DesktopPetPreferences(output));
            form.Opacity = 0; form.ShowInTaskbar = false; form.StartPosition = FormStartPosition.Manual; form.Location = new Point(-32000, -32000);
            ShowAndDrain(form);
            // A 920px client fits a 1080p working area at 200% scaling, while
            // the sidebar's complete content needs 972px and must scroll.
            Scale(form, 2F, new Size(864, 460), fonts);
            CheckSidebarAccounts(form);
            var scroll = (Panel)form.Controls.Find("SidebarScroll", true)[0];
            var content = form.Controls.Find("SidebarContent", true)[0];
            var manageAccount = form.Controls.Find("ManageSidebarAccount", true)[0];
            var footer = form.Controls.Find("SidebarFooter", true)[0];
            Check(content.MinimumSize.Height > scroll.ClientSize.Height && content.Height >= content.MinimumSize.Height,
                "Short windows must preserve the sidebar's full content height instead of compressing fixed rows.");
            Check(scroll.AutoScroll && scroll.VerticalScroll.Visible && !scroll.HorizontalScroll.Visible,
                "The short sidebar needs a vertical scrollbar without horizontal overflow.");
            Verify(form, "short-sidebar-200-top"); Save(form, output, "short-sidebar-200-top");
            scroll.AutoScrollPosition = new Point(0, scroll.DisplayRectangle.Height);
            Layout(form); Application.DoEvents();
            foreach (var control in new[] { manageAccount, footer })
            {
                var bounds = scroll.RectangleToClient(control.RectangleToScreen(control.ClientRectangle));
                Check(bounds.Top >= 0 && bounds.Bottom <= scroll.ClientSize.Height,
                    "The account management button and footer must remain reachable by scrolling: " + control.Name);
            }
            Verify(form, "short-sidebar-200-bottom"); Save(form, output, "short-sidebar-200-bottom");
            scroll.AutoScrollPosition = Point.Empty; Layout(form);
            var navigation = form.Controls.Find("Navigateoverview", true)[0];
            var navigationBounds = scroll.RectangleToClient(navigation.RectangleToScreen(navigation.ClientRectangle));
            Check(navigationBounds.Top >= 0 && navigationBounds.Bottom <= scroll.ClientSize.Height,
                "Scrolling back must restore access to the overview navigation.");
            form.Hide();
        }
        foreach (var font in fonts) font.Dispose();
    }

    private static void CheckSidebarAccounts(DashboardWindow form)
    {
        var login = (Label)form.Controls.Find("SidebarAccountLogin", true)[0];
        var host = (Label)form.Controls.Find("SidebarAccountHost", true)[0];
        var state = (Label)form.Controls.Find("SidebarAccountState", true)[0];
        var sidebar = form.Controls.Find("SidebarAccount", true)[0];
        var sidebarControls = new List<Control>(); Collect(sidebar, sidebarControls);
        Check(!sidebarControls.Exists(delegate(Control control) { return control is PictureBox; }), "The lower sidebar must display account information without a pet preview.");
        Check(form.Controls.Find("PetSelector", true).Length == 1, "Pet preferences must remain available on the account page.");

        var first = Populated(); Call(form, "ApplyOverview", first); Layout(form);
        Check(login.Text == "@" + first.Active.Login && host.Text == "github.com" && state.Text == "已连接", "The sidebar must show the active account, host, and connection state.");
        var tooltip = (ToolTip)Field(form, "tips");
        Check(tooltip.GetToolTip(login) == login.Text && login.AccessibleDescription == login.Text && tooltip.GetToolTip(host) == host.Text,
            "Ellipsized account identifiers must retain their complete tooltip and accessible text.");

        var second = Populated(); second.ActiveId = second.Accounts[0].Id = "22222222-2222-4222-8222-222222222222";
        second.Accounts[0].Login = "work-profile"; second.Accounts[0].Host = "https://example.ghe.com"; second.Accounts[0].Status = "reauth-required";
        second.Local.AccountId = second.Models.AccountId = second.ActiveId;
        Call(form, "ApplyOverview", second); Layout(form);
        Check(login.Text == "@work-profile" && host.Text == "example.ghe.com" && state.Text == "需要重新登录", "Switching accounts must replace every sidebar identity field and authentication state.");
        Check(tooltip.GetToolTip(login) == "@work-profile" && tooltip.GetToolTip(host) == "example.ghe.com", "Switching accounts must also replace the previous identity tooltips.");

        Call(form, "ClearAccountPresentation", "正在切换账号…");
        Check(login.Text == "未登录 GitHub" && state.Text == "正在更新账号…", "An unfinished account change must clear the previous account from the sidebar.");
        Call(form, "ApplyOverview", new NativeOverview { Enabled = true }); Layout(form);
        Check(login.Text == "未登录 GitHub" && host.Text == "个人或工作账号" && state.Text == "到账户页连接账号", "Signing out must restore the sidebar's account connection prompt.");
        Check(tooltip.GetToolTip(login) == login.Text && login.AccessibleDescription == login.Text, "Signing out must clear stale identity metadata.");
        ((Button)form.Controls.Find("ManageSidebarAccount", true)[0]).PerformClick();
        Check(((Label)Field(form, "pageTitle")).Text == "我的账号", "The sidebar account button must open account management.");
        Call(form, "Navigate", "overview"); Call(form, "ApplyOverview", first); Layout(form);
    }

    private static NativeOverview Populated()
    {
        const string id = "11111111-1111-4111-8111-111111111111";
        var result = new NativeOverview { ActiveId = id, Enabled = true, QuotaAvailable = true, QuotaHasSnapshot = true, FetchedAt = DateTime.UtcNow.ToString("o"),
            Primary = new NativeBucket { Key = "premium_interactions", Label = "高级请求", Unit = "ai-credits", UnitLabel = "AI Credits", Remaining = "1938000", Used = "62000", Limit = "2000000", Percentage = 3.1, UsedPercentageText = "3.1", RemainingPercentage = 96.9, RemainingPercentageText = "96.9" },
            Local = new NativeLocalUsage { AccountId = id, Scope = "当前账号 · 仅包含通过 PilotMeter 启动的本机会话", Period = "2026-09", Credits = "1234.56789", UnitVerified = true, SessionCount = 123, UnknownCalls = 12, PendingCalls = 3 },
            Models = new NativeModels { AccountId = id, State = "available", FetchedAt = DateTime.UtcNow.ToString("o") }
        };
        result.Accounts.Add(new NativeAccount { Id = id, Login = "personal-and-work-account-example", Host = "https://github.com", Status = "connected" });
        result.Buckets.Add(result.Primary);
        result.Models.Items.Add(new NativeModel { Id = "example-reasoning-model", Name = "Example Reasoning Model", Status = "available", PolicyState = "enabled", Vision = true, ReasoningEffort = true, ContextWindowTokens = 128000, Multiplier = "1.5" });
        return result;
    }

    private static void CheckExactQuantities(DashboardWindow form, string output, Size size, float factor)
    {
        var suffix = "-" + size.Width + "-" + (factor * 100).ToString("0");
        var raw = Populated();
        raw.Primary.Unit = "unspecified"; raw.Primary.UnitLabel = "单位未确认";
        raw.Primary.Used = raw.Primary.Limit = raw.Primary.Remaining = null;
        raw.Primary.RawUsed = "62000"; raw.Primary.RawLimit = "2000000";
        raw.Primary.Percentage = 3.1; raw.Primary.UsedPercentageText = "3.1";
        raw.Primary.RemainingPercentage = 96.9; raw.Primary.RemainingPercentageText = raw.Primary.RawRemainingPercentage = "96.9";
        Call(form, "ApplyOverview", raw); Layout(form); Layout(form);
        CheckExactMetric(form, "quotaUsed", "62,000", "raw-quantities" + suffix);
        CheckExactMetric(form, "quotaTotal", "2,000,000", "raw-quantities" + suffix);
        CheckExactMetric(form, "quotaValue", "96.9%", "raw-quantities" + suffix);
        var unitText = ((Label)Field(form, "quotaDetail")).Text;
        Check(unitText.Contains("未确认") || unitText.Contains("待确认"), "Raw quantities must keep their shared unconfirmed unit visible: " + suffix);
        Verify(form, "raw-quantities" + suffix); Save(form, output, "raw-quantities" + suffix);

        var precise = Populated();
        precise.Primary.Used = "9007199254740993.000000001";
        precise.Primary.Limit = "18014398509481986.000000004";
        precise.Primary.Remaining = "9007199254740993.000000003";
        precise.Primary.Percentage = precise.Primary.RemainingPercentage = 50;
        precise.Primary.UsedPercentageText = "49.999999999999999999999";
        precise.Primary.RemainingPercentageText = "50.000000000000000000001";
        Call(form, "ApplyOverview", precise); Layout(form); Layout(form);
        CheckExactMetric(form, "quotaUsed", "9,007,199,254,740,993.000000001", "precise-quantities" + suffix);
        CheckExactMetric(form, "quotaTotal", "18,014,398,509,481,986.000000004", "precise-quantities" + suffix);
        CheckExactMetric(form, "quotaValue", "9,007,199,254,740,993.000000003", "precise-quantities" + suffix);
        CheckExactRatios(form, precise.Primary, "precise-quantities" + suffix);
        Verify(form, "precise-quantities" + suffix); Save(form, output, "precise-quantities" + suffix);

        raw.Primary.Percentage = 1e-21; raw.Primary.RemainingPercentage = 100;
        raw.Primary.UsedPercentageText = "0.000000000000000000001";
        raw.Primary.RemainingPercentageText = raw.Primary.RawRemainingPercentage = "99.999999999999999999999";
        Call(form, "ApplyOverview", raw); Layout(form); Layout(form);
        CheckExactMetric(form, "quotaValue", "99.999999999999999999999%", "boundary-percentages" + suffix);
        CheckExactRatios(form, raw.Primary, "boundary-percentages" + suffix);
        Verify(form, "boundary-percentages" + suffix);
        CheckExactTotalScrolling(form, suffix);
    }

    private static void CheckExactTotalScrolling(DashboardWindow form, string suffix)
    {
        var scenario = "extreme-total-scroll" + suffix;
        var overview = Populated();
        overview.Primary.Limit = "1" + new String('2', 254) + "9";
        var expected = NativeDisplay.Amount(overview.Primary.Limit);
        Call(form, "ApplyOverview", overview); Layout(form); Layout(form);
        CheckExactMetric(form, "quotaTotal", expected, scenario);
        var label = (Label)Field(form, "quotaTotal");
        var viewport = (Panel)label.Parent;
        var extent = viewport.DisplayRectangle.Width;
        Check(viewport.HorizontalScroll.Visible && extent > viewport.ClientSize.Width,
            scenario + ": a 256-digit total must expose a horizontal scrollbar.");
        viewport.AutoScrollPosition = new Point(extent, 0); Layout(form); Application.DoEvents();
        Check(label.Left == viewport.AutoScrollPosition.X && label.Left < 0 && label.Right > 0 && label.Right <= viewport.ClientSize.Width,
            scenario + ": scrolling to the far right must reveal the complete last digit.");
        var scrolledX = viewport.AutoScrollPosition.X;
        var originalSize = form.ClientSize;
        try
        {
            // Changing a sibling metric reruns FitMetrics for this already-scrolled
            // total. Its virtual origin and extent must survive every relayout.
            for (var update = 0; update < 3; update++)
            {
                overview.Primary.Used = (update + 2).ToString();
                Call(form, "ApplyOverview", overview); Layout(form); Layout(form);
                Check(viewport.AutoScrollPosition.X == scrolledX && label.Left == scrolledX,
                    scenario + ": updating used must preserve the total's scrolled position (update " + update + ").");
                Check(viewport.DisplayRectangle.Width == extent,
                    scenario + ": updating used must not grow the total's scroll range (update " + update + ").");
            }
            form.ClientSize = new Size(originalSize.Width - Math.Max(24, originalSize.Width / 16), originalSize.Height);
            Layout(form); Layout(form); Application.DoEvents();
            Check(label.Left == viewport.AutoScrollPosition.X && label.Left < 0,
                scenario + ": narrowing the window must retain the total's virtual origin without resetting its label X.");
            Check(viewport.DisplayRectangle.Width == extent,
                scenario + ": narrowing the viewport must not grow the total's content extent.");
            viewport.AutoScrollPosition = new Point(extent, 0); Layout(form); Application.DoEvents();
            Check(label.Right > 0 && label.Right <= viewport.ClientSize.Width && label.Left == viewport.AutoScrollPosition.X,
                scenario + ": the complete last digit must remain reachable after narrowing the window.");
            viewport.AutoScrollPosition = Point.Empty; Layout(form); Application.DoEvents();
            Check(viewport.AutoScrollPosition.X == 0 && label.Left == 0 && label.Text == expected,
                scenario + ": returning to the left must reveal the original prefix without changing any digits.");
            Check(viewport.DisplayRectangle.Width == extent,
                scenario + ": returning to the left must not leave a growing blank scroll range.");
            CheckExactMetric(form, "quotaTotal", expected, scenario + "-narrow");
        }
        finally { form.ClientSize = originalSize; Layout(form); Layout(form); }
    }

    private static void CheckExactMetric(DashboardWindow form, string name, string expected, string scenario)
    {
        var label = (Label)Field(form, name);
        Check(label.Visible && label.Text == expected, scenario + ": " + name + " must visibly retain every original digit; got " + label.Text);
        Check(!label.AutoEllipsis && label is NativeExactLabel && ((NativeExactLabel)label).KeepOnOneLine,
            scenario + ": " + name + " must keep its full number on one line without an ellipsis.");
        var preferred = label.GetPreferredSize(new Size(label.ClientSize.Width, Int32.MaxValue));
        var lineHeight = TextRenderer.MeasureText("0", label.Font, Size.Empty, TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding).Height + label.Padding.Vertical;
        Check(preferred.Height == lineHeight, scenario + ": " + name + " must not split exact digits into multiple lines.");
        var viewport = label.Parent as Panel;
        Check(viewport != null && viewport.AutoScroll && !viewport.VerticalScroll.Visible,
            scenario + ": " + name + " needs a single-line viewport with horizontal overflow support.");
        if (viewport != null && preferred.Width > viewport.ClientSize.Width)
            Check(viewport.HorizontalScroll.Visible, scenario + ": the end of " + name + " must remain reachable with a horizontal scrollbar.");
    }

    private static void CheckExactRatios(DashboardWindow form, NativeBucket bucket, string scenario)
    {
        var ratios = (Label)Field(form, "quotaRatios");
        Check(ratios.Text.Contains(bucket.UsedPercentageText + "%"),
            scenario + ": the used percentage must retain every digit without rounding or threshold substitutes; got " + ratios.Text);
    }

    private static string DpiMetrics(Form form)
    {
        var current = typeof(ContainerControl).GetProperty("CurrentAutoScaleDimensions", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).GetValue(form, null);
        return "Mode=" + form.AutoScaleMode + "; AutoScaleDimensions=" + form.AutoScaleDimensions + "; Current=" + current + "; Client=" + form.ClientSize + "; Font=" + form.Font.Size + "; sidebar=" + form.Controls[0].Controls[0].Width;
    }

    private static void Save(Form form, string output, string name)
    {
        using (var bitmap = new Bitmap(form.Width, form.Height))
        {
            form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
            bitmap.Save(Path.Combine(output, name + ".png"), ImageFormat.Png);
        }
    }

    [STAThread]
    public static int Main(string[] args)
    {
        try { Console.WriteLine("Native layout: " + Run(args[0]) + " checks passed."); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
