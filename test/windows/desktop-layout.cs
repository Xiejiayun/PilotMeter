using System;
using System.Collections.Generic;
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
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        using (var form = new DashboardWindow(output, delegate { return Task.FromResult(0); }))
        {
            form.SetPetPreferences(new DesktopPetPreferences(output));
            metrics.Add("Before showing: " + DpiMetrics(form));
            form.Opacity = 0; form.ShowInTaskbar = false; form.StartPosition = FormStartPosition.Manual; form.Location = new Point(-32000, -32000);
            ShowAndDrain(form); Layout(form); Layout(form);
            metrics.Add("After showing: " + DpiMetrics(form));
            Verify(form, "actual-monitor-first-show");
            Save(form, output, "actual-monitor-first-show");
            form.Hide();
        }
        foreach (var factor in new[] { 1F, 1.25F, 1.5F, 2F })
        foreach (var size in new[] { new Size(864, 601), new Size(1280, 850) })
        {
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
                form.Hide();
            }
            foreach (var font in fonts) font.Dispose();
        }
        CheckShortSidebar(output);
        foreach (var factor in new[] { 1F, 1.5F, 2F })
        foreach (var state in new[] { "initial", "starting", "pending", "failed", "expired" })
        {
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
                Verify(form, scenario); Save(form, output, scenario); form.Hide();
                if (state == "pending")
                {
                    Call(form, "ServiceChanged");
                    Check(((TextBox)Field(form, "code")).Text == "" && ((TextBox)Field(form, "address")).Text == "", "Service replacement must clear the old device code and address.");
                    Check(!((Button)Field(form, "start")).Enabled && !((Button)Field(form, "open")).Enabled && !((Button)Field(form, "copy")).Enabled && ((Button)Field(form, "cancel")).Enabled, "Service replacement must leave only the close action available.");
                }
            }
            foreach (var font in fonts) font.Dispose();
        }
        File.WriteAllLines(Path.Combine(output, "layout-results.txt"), failures.ToArray());
        File.WriteAllLines(Path.Combine(output, "dpi-metrics.txt"), metrics.ToArray());
        if (failures.Count > 0) throw new Exception("Native layout failed: " + failures.Count + " clipping/overlap issues. " + failures[0] + ". Full report: " + Path.Combine(output, "layout-results.txt"));
        return assertions;
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
            Primary = new NativeBucket { Key = "premium_interactions", Label = "高级请求", Unit = "ai-credits", UnitLabel = "AI Credits", Remaining = "999999.99", Used = "123456.78", Limit = "1123456.77", Percentage = 11, UsedPercentageText = "11", RemainingPercentage = 89, RemainingPercentageText = "89" },
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
