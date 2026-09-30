using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

// Focused, windowless tests against the shipping context. A held loopback
// failure exercises the actual async native action without starting a daemon.
internal static class DesktopNativeNoticeTests
{
    private const string Account = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static int checks;
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); checks++; }
    private static void Set(object target, string field, object value) { target.GetType().GetField(field, BindingFlags.Instance | BindingFlags.NonPublic).SetValue(target, value); }
    private static object Get(object target, string field) { return target.GetType().GetField(field, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(target); }
    private static bool Flag(object target, string property) { return (bool)target.GetType().GetProperty(property, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(target, null); }
    private static object Call(object target, string method, params object[] args) { return target.GetType().GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic).Invoke(target, args); }

    private static void PetMotionPreference()
    {
        string directory = Path.Combine(Path.GetTempPath(), "pilotmeter-pet-motion-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var widget = (DesktopWidget)FormatterServices.GetUninitializedObject(typeof(DesktopWidget));
        var clock = Stopwatch.StartNew();
        var synchronizationContext = System.Threading.SynchronizationContext.Current;
        using (var menu = new ContextMenuStrip())
        try
        {
            // Supply the managed handle owner that Control normally creates;
            // it starts with IntPtr.Zero and never calls CreateHandle here.
            Type windowType = typeof(Control).GetNestedType("ControlNativeWindow", BindingFlags.NonPublic);
            object window = Activator.CreateInstance(windowType, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null, new object[] { widget }, null);
            foreach (var field in typeof(Control).GetFields(BindingFlags.Instance | BindingFlags.NonPublic))
                if (field.FieldType == windowType) field.SetValue(widget, window);
            var preferences = new DesktopPetPreferences(directory);
            var reaction = new WidgetUpdateMotion();
            Set(widget, "preferences", preferences); Set(widget, "clock", clock);
            Set(widget, "updateMotion", reaction); Set(widget, "menu", menu);
            // Set the managed visibility bit without invoking Form.Show or
            // creating a native window. Notify runs its real dispatch and
            // motion gates; RenderFrame exits at its uninitialized guard.
            var visible = typeof(Control).GetMethod("SetState", BindingFlags.Instance | BindingFlags.NonPublic);
            visible.Invoke(widget, new object[] { 0x00000002, true });
            Check(widget.Visible && !widget.IsHandleCreated, "The motion fixture must be visible only in managed state, without any desktop window.");
            Check(Flag(widget, "MotionAllowed") && Flag(widget, "CanAnimate"), "The explicit PET animation preference must work even when Windows menu or client-area animations are disabled.");
            widget.Notify(DesktopPetReactionKind.Message, "motion-enabled", "同步已完成");
            Check(reaction.Kind(clock.ElapsedMilliseconds) == DesktopPetReactionKind.Message && reaction.Caption(clock.ElapsedMilliseconds) == "同步已完成", "An enabled PET must accept a real notification through the shipping widget gate.");

            preferences.SetMotion(false);
            Check(!Flag(widget, "MotionAllowed") && !Flag(widget, "CanAnimate"), "Turning off PET animation must disable idle and reaction rendering.");
            widget.Notify(DesktopPetReactionKind.Attention, "motion-disabled", "不应接收");
            Check(reaction.Kind(clock.ElapsedMilliseconds) == DesktopPetReactionKind.Message, "A disabled PET must reject new notifications instead of promoting a queued reaction.");

            // The queue tests cover clearing an active reaction; reset the
            // isolated queue here before exercising the visibility gate.
            reaction.Clear(); preferences.SetMotion(true);
            visible.Invoke(widget, new object[] { 0x00000002, false });
            Check(!Flag(widget, "CanAnimate"), "A hidden PET must pause its animation timer work.");
            widget.Notify(DesktopPetReactionKind.Message, "motion-hidden", "隐藏时不应接收");
            Check(reaction.Kind(clock.ElapsedMilliseconds) == DesktopPetReactionKind.None, "A hidden PET must not queue a notice to replay after it is shown.");
            visible.Invoke(widget, new object[] { 0x00000002, true });
            widget.Notify(DesktopPetReactionKind.Attention, "motion-restored", "有一件事需要留意");
            Check(Flag(widget, "CanAnimate") && reaction.Kind(clock.ElapsedMilliseconds) == DesktopPetReactionKind.Attention, "Showing the PET with its animation preference enabled must restore notification motion.");
            Set(widget, "dragging", true);
            Check(!Flag(widget, "CanAnimate"), "Dragging must pause PET animation even when its preference is enabled.");
            Check(!widget.IsHandleCreated, "Notification checks must never create a visible or hidden native widget window.");
        }
        finally
        {
            Set(widget, "disposing", true); clock.Stop(); Directory.Delete(directory, true);
            // ContextMenuStrip may install a Forms context, but these tests
            // have no message loop and subsequent async checks must stay free.
            System.Threading.SynchronizationContext.SetSynchronizationContext(synchronizationContext);
        }
    }

    private static WidgetAccountSet Accounts(string status = "connected", string id = Account)
    {
        var accounts = new WidgetAccountSet { ActiveId = id, Enabled = true };
        if (id != null) accounts.Accounts.Add(new WidgetAccount { Id = id, Status = status });
        return accounts;
    }
    private static Dictionary<string, object> Source(string fetched = "2026-09-29T01:00:00Z")
    {
        return new Dictionary<string, object> {
            { "quota", new Dictionary<string, object> { { "accountId", Account }, { "fetchedAt", fetched }, { "error", null } } },
            { "models", new Dictionary<string, object> { { "error", null } } }
        };
    }
    private static void Outcomes()
    {
        var accounts = Accounts(); var source = Source();
        Check(!DesktopContext.NativeSyncFailed(accounts, source, "ready"), "A confirmed fetched quota can report completion.");
        Check(!DesktopContext.NativeSyncFailed(accounts, source, "waiting"), "A fetched but stale quota reports read completion without claiming freshness.");
        Check(DesktopContext.NativeSyncFailed(accounts, Source(null), "waiting"), "No quota snapshot cannot report a successful account sync.");
        Check(DesktopContext.NativeSyncFailed(accounts, Source("not-a-date"), "waiting"), "An invalid fetched time cannot establish a quota snapshot.");
        Check(DesktopContext.NativeSyncFailed(accounts, source, "needs-login"), "The actual backend needs-login state is a failure for a selected account.");
        Check(DesktopContext.NativeSyncFailed(Accounts("reauth-required"), Source(null), "needs-login"), "Persisted reauthentication state is an error even before quota errors exist.");
        Check(DesktopContext.NativeSyncFailed(Accounts("error"), source, "waiting"), "An errored profile cannot report success.");
        ((Dictionary<string, object>)source["models"])["error"] = new Dictionary<string, object> { { "message", "synthetic model error" } };
        Check(DesktopContext.NativeSyncFailed(accounts, source, "ready"), "A model refresh failure matters even when quota succeeds.");
        source = Source(); ((Dictionary<string, object>)source["quota"])["error"] = new Dictionary<string, object>();
        Check(DesktopContext.NativeSyncFailed(accounts, source, "waiting"), "An old fetched quota does not hide a refresh error.");
        source = Source(); ((Dictionary<string, object>)source["quota"])["accountId"] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        Check(DesktopContext.NativeSyncFailed(accounts, source, "ready"), "A quota for another account is not a successful snapshot.");
        Check(!DesktopContext.NativeSyncFailed(Accounts("connected", null), new Dictionary<string, object>(), "needs-login"), "With no selected account, a local reread does not require a quota.");
    }
    private static DesktopContext Context(int port)
    {
        var widget = (DesktopWidget)FormatterServices.GetUninitializedObject(typeof(DesktopWidget));
        Set(widget, "disposing", true);
        var context = (DesktopContext)FormatterServices.GetUninitializedObject(typeof(DesktopContext));
        Set(context, "widget", widget); Set(context, "snapshotGate", new WidgetSnapshotGate());
        Set(context, "selectedQuotaAccountId", Account);
        Set(context, "instance", new DesktopInstance { InstanceId = "11111111-1111-4111-8111-111111111111", Version = "notice-test", Origin = new Uri("http://127.0.0.1:" + port + "/") });
        Seed(context);
        return context;
    }
    private static void Seed(DesktopContext context)
    {
        Set(context, "nativeSyncEvent", "older-native-sync"); Set(context, "nativeSyncAccount", Account);
        Set(context, "nativeSyncInstance", "11111111-1111-4111-8111-111111111111");
    }
    private static bool Cleared(DesktopContext context)
    {
        return Get(context, "nativeSyncEvent") == null && Get(context, "nativeSyncAccount") == null && Get(context, "nativeSyncInstance") == null;
    }
    private static async Task Actions()
    {
        var disconnected = Context(1);
        Call(disconnected, "Disconnect", "offline", "Synthetic read timeout");
        Check(Cleared(disconnected), "Disconnect must retire a pending sync instead of reviving it after reconnect.");

        foreach (var account in new string[] { null, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })
        {
            var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
            try
            {
                var context = Context(((IPEndPoint)listener.LocalEndpoint).Port);
                var accepted = listener.AcceptTcpClientAsync();
                var action = (Task)Call(context, "ChangeAccountAsync", new object[] { account });
                using (var client = await accepted)
                using (var stream = client.GetStream())
                using (var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true))
                {
                    string line; do { line = await reader.ReadLineAsync(); } while (!String.IsNullOrEmpty(line));
                    Check(Cleared(context), "Beginning a new native action must cancel the previous sync notice.");
                    // A terminal request failure must also retire any outstanding
                    // notice; exit prevents follow-up polling in this fixture.
                    Seed(context); Set(context, "exiting", true);
                    var response = Encoding.ASCII.GetBytes("HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
                    await stream.WriteAsync(response, 0, response.Length); await stream.FlushAsync();
                }
                await action;
                Check(Cleared(context), "A rejected native request must leave no future success notice.");
                Check(!(bool)Get(context, "actionBusy") && ((WidgetSnapshotGate)Get(context, "snapshotGate")).CanRead, "Failure must release action/read barriers.");
            }
            finally { listener.Stop(); }
        }
    }
    public static int Main()
    {
        try { Outcomes(); PetMotionPreference(); Actions().GetAwaiter().GetResult(); Console.WriteLine("Native notification checks passed: " + checks); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
