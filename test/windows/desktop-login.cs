using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

// Exercise the shipping button event and modal owner chain without requesting a
// device code, reading user account data, or displaying a visible test window.
internal static class DesktopLoginTests
{
    private static readonly List<string> failures = new List<string>();
    private static int checks;

    private static object Get(object target, string name)
    {
        return target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(target);
    }

    private static void Set(object target, string name, object value)
    {
        target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).SetValue(target, value);
    }

    private static void Call(object target, string name, params object[] values)
    {
        target.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic).Invoke(target, values);
    }

    private static void Check(bool condition, string description)
    {
        checks++;
        if (!condition) failures.Add(description);
    }

    private static void WaitFor(Func<bool> condition, string description)
    {
        var elapsed = Stopwatch.StartNew();
        while (!condition() && elapsed.ElapsedMilliseconds < 5000) { Application.DoEvents(); Thread.Sleep(10); }
        Check(condition(), description);
    }

    private sealed class DeferredContext : SynchronizationContext
    {
        private readonly SynchronizationContext inner;
        private readonly Queue<KeyValuePair<SendOrPostCallback, object>> callbacks = new Queue<KeyValuePair<SendOrPostCallback, object>>();
        private bool held;
        internal DeferredContext(SynchronizationContext inner) { this.inner = inner; }
        internal void Hold() { lock (callbacks) held = true; }
        internal void Release()
        {
            lock (callbacks)
            {
                held = false;
                while (callbacks.Count > 0) { var item = callbacks.Dequeue(); inner.Post(item.Key, item.Value); }
            }
        }
        public override void Post(SendOrPostCallback callback, object state)
        {
            lock (callbacks)
            {
                if (held) { callbacks.Enqueue(new KeyValuePair<SendOrPostCallback, object>(callback, state)); return; }
            }
            inner.Post(callback, state);
        }
        public override void Send(SendOrPostCallback callback, object state) { inner.Send(callback, state); }
        public override SynchronizationContext CreateCopy() { return this; }
    }

    // Only synthetic health/overview reads reach this ephemeral loopback server.
    // Holding the overview makes the old login continuation deterministic.
    private sealed class HeldOverviewServer : IDisposable
    {
        private readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
        private readonly Task worker;
        private volatile bool stopping;
        internal readonly ManualResetEventSlim Waiting = new ManualResetEventSlim();
        internal readonly ManualResetEventSlim Release = new ManualResetEventSlim();
        internal readonly DesktopInstance Service;
        internal bool UnexpectedRequest;

        internal HeldOverviewServer()
        {
            listener.Start();
            Service = new DesktopInstance { Version = "login-test", InstanceId = Guid.NewGuid().ToString(),
                Origin = new Uri("http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/") };
            worker = Task.Run(new Action(Serve));
        }

        private void Serve()
        {
            while (!stopping)
            {
                try
                {
                    using (var client = listener.AcceptTcpClient())
                    {
                        client.ReceiveTimeout = client.SendTimeout = 5000;
                        using (var stream = client.GetStream())
                        using (var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true))
                        {
                            var request = reader.ReadLine();
                            for (var count = 0; count < 100 && !String.IsNullOrEmpty(reader.ReadLine()); count++) { }
                            var health = request == "GET /health HTTP/1.1";
                            if (!health && request != "GET /api/desktop HTTP/1.1") UnexpectedRequest = true;
                            if (!health) { Waiting.Set(); Release.Wait(10000); }
                            var identity = "\"app\":\"pilotmeter\",\"version\":\"login-test\",\"instanceId\":\"" + Service.InstanceId + "\"";
                            var json = "{" + identity + (health ? "}" : ",\"accounts\":[],\"activeAccountId\":null,\"enabled\":true,\"refreshing\":false,\"login\":null,\"quota\":null,\"presentation\":{\"selection\":\"none\",\"primary\":null,\"buckets\":[],\"fetchedAt\":null,\"stale\":true}}" );
                            var body = Encoding.UTF8.GetBytes(json);
                            var header = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + body.Length + "\r\n\r\n");
                            stream.Write(header, 0, header.Length); stream.Write(body, 0, body.Length);
                        }
                    }
                }
                catch (IOException) { }
                catch (SocketException) { if (stopping) return; throw; }
                catch (ObjectDisposedException) { if (stopping) return; throw; }
            }
        }

        public void Dispose()
        {
            stopping = true; Release.Set(); listener.Stop(); worker.Wait(2000); Waiting.Dispose(); Release.Dispose();
        }
    }

    private sealed class HideDialogs : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct WindowMessage { internal IntPtr Data, Parameter; internal uint Message; internal IntPtr Window; }
        private delegate IntPtr Hook(int code, IntPtr parameter, IntPtr data);
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int id, Hook callback, IntPtr module, uint thread);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr parameter, IntPtr data);
        [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        private readonly Hook callback;
        private readonly IntPtr handle;
        internal HideDialogs()
        {
            callback = delegate(int code, IntPtr parameter, IntPtr data) {
                if (code >= 0)
                {
                    var message = (WindowMessage)Marshal.PtrToStructure(data, typeof(WindowMessage));
                    if (message.Message == 0x18 && message.Parameter != IntPtr.Zero)
                    {
                        var dialog = Control.FromHandle(message.Window) as NativeLoginDialog;
                        if (dialog != null)
                        {
                            dialog.Opacity = 0;
                            dialog.Shown += delegate { ((System.Windows.Forms.Timer)Get(dialog, "timer")).Stop(); };
                        }
                    }
                }
                return CallNextHookEx(handle, code, parameter, data);
            };
            handle = SetWindowsHookEx(4, callback, IntPtr.Zero, GetCurrentThreadId());
            if (handle == IntPtr.Zero) throw new Exception("Could not hide test dialogs on the test's own UI thread.");
        }
        public void Dispose() { UnhookWindowsHookEx(handle); GC.KeepAlive(callback); }
    }

    private sealed class Fixture : IDisposable
    {
        internal readonly DashboardWindow Form;
        internal readonly Button Add;
        internal readonly NativeOverview Overview = new NativeOverview { Enabled = true };
        private readonly DesktopNativeApi client;
        internal Fixture(string directory, DesktopInstance service = null)
        {
            Form = new DashboardWindow(directory, delegate { return Task.FromResult(0); });
            Form.Opacity = 0; Form.ShowInTaskbar = false; Form.StartPosition = FormStartPosition.Manual; Form.Location = new Point(-32000, -32000);
            Form.Show(); Application.DoEvents();
            ((System.Windows.Forms.Timer)Get(Form, "timer")).Stop();
            Call(Form, "Navigate", "accounts");
            if (service == null) service = new DesktopInstance { Version = "login-test", InstanceId = "11111111-1111-4111-8111-111111111111", Origin = new Uri("http://127.0.0.1:1/") };
            client = new DesktopNativeApi(service);
            Set(Form, "service", service); Set(Form, "api", client);
            Call(Form, "ApplyOverview", Overview);
            Add = (Button)Get(Form, "add");
        }

        internal bool ClickToModal(string scenario, bool resumed = false, bool closeWindow = false, Action<NativeLoginDialog> whileOpen = null)
        {
            var shown = false;
            NativeLoginDialog opened = null;
            if (!Form.Visible) Form.Show();
            ((System.Windows.Forms.Timer)Get(Form, "timer")).Stop();
            var elapsed = Stopwatch.StartNew();
            using (var observer = new System.Windows.Forms.Timer { Interval = 20 })
            using (var deadline = new System.Windows.Forms.Timer { Interval = 8000 })
            {
                deadline.Tick += delegate {
                    deadline.Stop(); observer.Stop();
                    Check(false, scenario + ": the test must close a modal within its bounded observation window.");
                    var dialogs = new List<NativeLoginDialog>();
                    foreach (Form candidate in Application.OpenForms)
                        if (candidate is NativeLoginDialog) dialogs.Add((NativeLoginDialog)candidate);
                    Form.Hide();
                    foreach (var dialog in dialogs) { dialog.Opacity = 0; dialog.Disconnect(); }
                };
                observer.Tick += delegate {
                    var dialog = Get(Form, "loginDialog") as NativeLoginDialog;
                    if (dialog == null)
                        foreach (Form candidate in Application.OpenForms)
                            if (candidate is NativeLoginDialog && candidate.Owner == Form) { dialog = (NativeLoginDialog)candidate; break; }
                    if (dialog == null) return;
                    if (!dialog.Visible && elapsed.ElapsedMilliseconds < 3000) return;
                    observer.Stop(); shown = true; opened = dialog;
                    Check(dialog.Visible && dialog.Modal && dialog.Owner == Form, scenario + ": the button must show a visible owned modal login window.");
                    Check(dialog.Opacity == 0, scenario + ": test dialogs must remain invisible to the user.");
                    Check(((Button)Get(dialog, "start")).Enabled == !resumed, scenario + ": the device-code action must match a fresh or resumed login.");
                    if (resumed) Check(((TextBox)Get(dialog, "code")).Text == "ABCD-EFGH", scenario + ": a pending login must retain its existing device code.");
                    if (whileOpen != null) whileOpen(dialog);
                    // Hiding the fixture prevents the post-dialog overview refresh;
                    // this regression never contacts even the dummy loopback port.
                    Form.Hide();
                    if (resumed) dialog.Disconnect();
                    else if (closeWindow) dialog.Close();
                    else ((Button)Get(dialog, "cancel")).PerformClick();
                    if (!resumed) Check(!(bool)Get(dialog, "disconnected"), scenario + ": normal close must not simulate a service disconnect.");
                };
                observer.Start(); deadline.Start();
                Add.PerformClick(); Application.DoEvents();
                observer.Stop(); deadline.Stop();
            }
            Check(shown, scenario + ": clicking the account button must visibly open the login dialog.");
            Check(Get(Form, "loginDialog") == null && !Form.AccountMutationPending, scenario + ": closing must release the dialog and account mutation state.");
            Check(opened == null || opened.IsDisposed, scenario + ": the closed modal must be disposed before another login.");
            Check(Add.Enabled, scenario + ": the account button must recover after closing the modal.");
            return shown;
        }

        internal void ClickWithoutModal(string scenario)
        {
            using (var observer = new System.Windows.Forms.Timer { Interval = 20 })
            {
                observer.Tick += delegate {
                    var dialog = Get(Form, "loginDialog") as NativeLoginDialog;
                    if (dialog == null || !dialog.Visible) return;
                    observer.Stop(); Check(false, scenario + ": an unavailable login must not open a modal.");
                    Form.Hide(); dialog.Disconnect(); dialog.Close();
                };
                observer.Start(); Add.PerformClick(); Application.DoEvents(); observer.Stop();
            }
        }

        public void Dispose() { Form.Dispose(); client.Dispose(); }
    }

    private static void Run(string directory)
    {
        using (var fixture = new Fixture(directory))
        {
            fixture.ClickToModal("ready-account-page");
            fixture.ClickToModal("same-owner-reopen-after-cancel", false, true);
            fixture.ClickToModal("same-owner-reopen-after-window-close");
        }
        using (var fixture = new Fixture(directory))
        {
            fixture.Overview.Login = new NativeLogin { Id = "22222222-2222-4222-8222-222222222222", Host = "https://github.com", Status = "pending",
                UserCode = "ABCD-EFGH", VerificationUri = "https://github.com/login/device", ExpiresAt = DateTime.UtcNow.AddMinutes(5).ToString("o") };
            Call(fixture.Form, "ApplyOverview", fixture.Overview);
            fixture.ClickToModal("resume-pending-login", true);
        }
        using (var fixture = new Fixture(directory))
        {
            Set(fixture.Form, "overview", null); Set(fixture.Form, "networkError", "Synthetic overview read failure");
            Call(fixture.Form, "UpdateControls");
            fixture.ClickToModal("overview-unavailable");
        }
        using (var fixture = new Fixture(directory))
        {
            Set(fixture.Form, "busy", true); Call(fixture.Form, "UpdateControls");
            fixture.ClickToModal("quota-refresh-in-progress");
            Check(!(bool)Get(fixture.Form, "busy"), "Opening login must release a superseded quota refresh's busy flag.");
        }
        using (var fixture = new Fixture(directory))
        {
            Set(fixture.Form, "api", null); Set(fixture.Form, "service", null); Call(fixture.Form, "UpdateControls");
            fixture.ClickWithoutModal("offline-service");
            Check(Get(fixture.Form, "loginDialog") == null, "An offline service cannot open a working login dialog.");
            Check(((Label)Get(fixture.Form, "accountHint")).Text.Contains("本机服务"), "Clicking login while offline must explain the missing service beside the button.");
        }
        using (var fixture = new Fixture(directory))
        {
            fixture.Overview.Enabled = false; Call(fixture.Form, "ApplyOverview", fixture.Overview);
            fixture.ClickWithoutModal("account-service-disabled");
            Check(Get(fixture.Form, "loginDialog") == null, "An explicitly disabled account service must not open login.");
            Check(((Label)Get(fixture.Form, "feedback")).Text.Contains("未启用"), "Clicking an unavailable login must give a specific visible explanation.");
        }
        using (var fixture = new Fixture(directory))
        {
            typeof(DashboardWindow).GetProperty("AccountMutationPending", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(fixture.Form, true, null);
            Call(fixture.Form, "UpdateControls"); fixture.ClickWithoutModal("account-mutation-in-progress");
            Check(Get(fixture.Form, "loginDialog") == null && ((Label)Get(fixture.Form, "accountHint")).Text.Contains("正在更新"),
                "An account mutation must block overlapping login while explaining why beside the button.");
            Check(!(bool)Get(fixture.Form, "busy") && !((Button)Get(fixture.Form, "refresh")).Enabled,
                "A pending account mutation must block refresh even after login supersedes the previous busy refresh.");
            Check(!((ComboBox)Get(fixture.Form, "bucketChoice")).Enabled && !((DataGridView)Get(fixture.Form, "accountsGrid")).Enabled,
                "A pending account mutation must keep category and account selection disabled until identity is confirmed.");
        }
        using (var fixture = new Fixture(directory))
        {
            var injected = false;
            fixture.Add.EnabledChanged += delegate {
                if (!injected && !fixture.Add.Enabled && Get(fixture.Form, "loginDialog") != null)
                {
                    injected = true;
                    throw new InvalidOperationException("Synthetic login window preparation failure");
                }
            };
            fixture.ClickWithoutModal("modal-preparation-failure");
            Check(injected, "The failure fixture must interrupt modal preparation after the dialog has been assigned.");
            Check(Get(fixture.Form, "loginDialog") == null && !fixture.Form.AccountMutationPending,
                "A modal preparation failure must release the login and mutation barriers.");
            Check(fixture.Add.Enabled && ((Label)Get(fixture.Form, "feedback")).Text.Contains("无法打开"),
                "A modal preparation failure must explain the error and permit another click.");
            fixture.ClickToModal("retry-after-modal-failure");
        }
        CheckLoginOwnership(directory, true);
        CheckLoginOwnership(directory, false);
    }

    private static void CheckLoginOwnership(string directory, bool replaceDuringModal)
    {
        var scenario = replaceDuringModal ? "service-replaced-during-modal" : "service-replaced-during-post-login-read";
        using (var held = new HeldOverviewServer())
        using (var replacement = new HeldOverviewServer())
        using (var fixture = new Fixture(directory, replaceDuringModal ? null : held.Service))
        {
            NativeLoginDialog oldDialog = null;
            var uiContext = SynchronizationContext.Current;
            var oldContext = new DeferredContext(uiContext);
            using (var observer = new System.Windows.Forms.Timer { Interval = 20 })
            {
                observer.Tick += delegate {
                    var dialog = Get(fixture.Form, "loginDialog") as NativeLoginDialog;
                    if (dialog == null || !dialog.Visible) return;
                    observer.Stop(); oldDialog = dialog;
                    Check(dialog.Opacity == 0, scenario + ": the previous modal must also remain invisible to the user.");
                    if (replaceDuringModal) fixture.Form.SetService(held.Service, "Synthetic service replacement");
                    else
                    {
                        dialog.Feedback = "Synthetic previous operation feedback";
                        ((Button)Get(dialog, "cancel")).PerformClick();
                    }
                };
                observer.Start();
                SynchronizationContext.SetSynchronizationContext(oldContext);
                try { fixture.Add.PerformClick(); }
                finally { SynchronizationContext.SetSynchronizationContext(uiContext); }
                Application.DoEvents(); observer.Stop();
            }
            ((System.Windows.Forms.Timer)Get(fixture.Form, "timer")).Stop();
            WaitFor(delegate { return held.Waiting.IsSet; }, scenario + ": the old login must be awaiting an actual isolated overview response.");
            Check(oldDialog != null && !oldDialog.IsDisposed, scenario + ": the old login continuation must still own its closed dialog before replacement login starts.");
            if (!replaceDuringModal)
            {
                // Service disposal may complete the old HTTP await inline on this
                // UI thread. Delay its continuation to exercise the other legal
                // ordering: the new modal opens before that completion is delivered.
                oldContext.Hold();
                fixture.Form.SetService(replacement.Service, "Synthetic service replacement during read");
            }
            ((Label)Get(fixture.Form, "feedback")).Text = "Synthetic current operation feedback";
            fixture.ClickToModal(scenario + "-new-login", false, false, delegate(NativeLoginDialog current) {
                held.Release.Set(); oldContext.Release();
                WaitFor(delegate { return oldDialog != null && oldDialog.IsDisposed; }, scenario + ": the previous login continuation must finish while the new modal is open.");
                Check(Object.ReferenceEquals(Get(fixture.Form, "loginDialog"), current), scenario + ": an old continuation must not clear the new modal reference.");
                Check(fixture.Form.AccountMutationPending && !fixture.Add.Enabled, scenario + ": an old continuation must not release the new login's account barrier.");
                Check(current.Visible && current.Modal && !current.IsDisposed, scenario + ": the newer owned modal must remain usable.");
                Check(((Label)Get(fixture.Form, "feedback")).Text == "Synthetic current operation feedback", scenario + ": old login feedback must not replace the new operation's feedback.");
            });
            oldContext.Release();
            Check(!held.UnexpectedRequest && !replacement.UnexpectedRequest, scenario + ": ownership regression tests must only read synthetic health and overview endpoints.");
        }
    }

    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs error) { failures.Add("Unhandled UI exception: " + error.Exception.Message); };
            Exception failed = null;
            using (var pump = new Form { Opacity = 0, ShowInTaskbar = false, StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000) })
            {
                pump.Shown += delegate {
                    try { using (var hidden = new HideDialogs()) Run(args[0]); }
                    catch (Exception error) { failed = error; }
                    finally { pump.Close(); }
                };
                Application.Run(pump);
            }
            if (failed != null) throw failed;
            Directory.CreateDirectory(args[0]); File.WriteAllLines(Path.Combine(args[0], "login-results.txt"), failures.ToArray());
            if (failures.Count > 0) throw new Exception(String.Join(Environment.NewLine, failures.ToArray()));
            Console.WriteLine("Desktop login: " + checks + " checks passed."); return 0;
        }
        catch (Exception error) { Console.Error.WriteLine("Desktop login failure: " + error.Message); return 1; }
    }
}
