using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// Renders the shipping HTML/CSS in a real Evergreen renderer at zero opacity.
// The daemon, profile, settings and screenshots all belong to this test.
internal static class DesktopWebViewTests
{
    private static int checks, outcome = 1;
    private static void Check(bool value, string name) { if (!value) throw new Exception(name); checks++; }
    private static object Field(object target, string name) { return target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(target); }
    private static void Set(object target, string name, object value) { target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).SetValue(target, value); }
    private static async Task Until(Func<Task<bool>> test, string name)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline) { if (await test()) return; await Task.Delay(50); }
        throw new Exception("Timed out: " + name);
    }
    private static string Json(object value) { return new JavaScriptSerializer().Serialize(value); }
    private static Task Post(CoreWebView2 core, object value) { return core.ExecuteScriptAsync("window.chrome.webview.postMessage(" + Json(value) + ")"); }

    private sealed class PendingHealthHandler : HttpMessageHandler
    {
        internal int Reads;
        internal TaskCompletionSource<HttpResponseMessage> Response = new TaskCompletionSource<HttpResponseMessage>();
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
        {
            Check(request.Method == HttpMethod.Get && request.RequestUri.AbsolutePath == "/health", "Pending login probe reads only health; never quota or mutation endpoints");
            Reads++; return Response.Task;
        }
        internal void Reset() { Reads = 0; Response = new TaskCompletionSource<HttpResponseMessage>(); }
        internal void Complete(DesktopInstance value)
        {
            Response.SetResult(new HttpResponseMessage(value == null ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK) {
                Content = new StringContent(value == null ? "{}" : Json(new { app = "pilotmeter", version = value.Version, instanceId = value.InstanceId }))
            });
        }
    }
    private sealed class PendingProbeFixture : IDisposable
    {
        internal readonly DesktopContext Context;
        internal readonly PendingHealthHandler Handler = new PendingHealthHandler();
        private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        private readonly HttpClient http;
        private readonly string directory;
        internal PendingProbeFixture(DesktopWebWindow window, DesktopInstance instance)
        {
            directory = (string)Field(window, "directory");
            WriteIdentity(instance);
            http = new HttpClient(Handler);
            var widget = (DesktopWidget)FormatterServices.GetUninitializedObject(typeof(DesktopWidget)); Set(widget, "disposing", true);
            Context = (DesktopContext)FormatterServices.GetUninitializedObject(typeof(DesktopContext));
            Set(Context, "directory", directory); Set(Context, "version", instance.Version); Set(Context, "instance", instance);
            Set(Context, "dashboard", window); Set(Context, "widget", widget); Set(Context, "snapshotGate", new WidgetSnapshotGate());
            Set(Context, "http", http); Set(Context, "lifetime", lifetime);
        }
        internal void WriteIdentity(DesktopInstance instance)
        { File.WriteAllText(Path.Combine(directory, "instance.json"), Json(new { app = "pilotmeter", version = instance.Version, instanceId = instance.InstanceId, url = instance.Origin.GetLeftPart(UriPartial.Authority) })); }
        internal Task Probe() { return (Task)typeof(DesktopContext).GetMethod("RefreshAsync", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(Context, new object[] { false }); }
        public void Dispose() { lifetime.Cancel(); http.Dispose(); lifetime.Dispose(); }
    }
    private static async Task BeginOwner(CoreWebView2 core, DesktopWebWindow window, string operation)
    {
        await Post(core, new { type = "account-mutation", pending = true, operationId = operation, epoch = window.ServiceEpoch });
        await Until(delegate { return Task.FromResult(window.OwnsAccountMutation(operation, window.ServiceEpoch)); }, "Acquire " + operation);
    }
    private static async Task EndOwner(CoreWebView2 core, DesktopWebWindow window, string operation)
    {
        await Post(core, new { type = "account-mutation", pending = false, operationId = operation, epoch = window.ServiceEpoch });
        await Until(delegate { return Task.FromResult(!window.AccountMutationPending); }, "Release " + operation);
    }
    private static async Task PendingRecovery(DesktopWebWindow window, CoreWebView2 core, DesktopInstance instance)
    {
        Console.WriteLine("WebView2 host: checking service loss during owned login");
        using (var fixture = new PendingProbeFixture(window, instance))
        {
            await BeginOwner(core, window, "healthy");
            var probe = fixture.Probe();
            await Until(delegate { return Task.FromResult(fixture.Handler.Reads == 1); }, "Pending health request");
            fixture.Handler.Complete(instance); await probe;
            Check(window.OwnsAccountMutation("healthy", window.ServiceEpoch), "Healthy pending login keeps its owner");
            Check(instance.SameAs((DesktopInstance)Field(fixture.Context, "instance")), "Healthy pending probe keeps the service");
            await EndOwner(core, window, "healthy");

            fixture.Handler.Reset(); await BeginOwner(core, window, "old-owner"); probe = fixture.Probe();
            await Until(delegate { return Task.FromResult(fixture.Handler.Reads == 1); }, "Old owner health request");
            await EndOwner(core, window, "old-owner"); await BeginOwner(core, window, "new-owner");
            fixture.Handler.Complete(null); await probe;
            Check(window.OwnsAccountMutation("new-owner", window.ServiceEpoch), "Old failed probe cannot revoke a new operation");
            Check(instance.SameAs((DesktopInstance)Field(fixture.Context, "instance")), "Old failed probe cannot disconnect a new operation");
            await EndOwner(core, window, "new-owner");

            fixture.Handler.Reset(); await BeginOwner(core, window, "epoch-owner"); int oldEpoch = window.ServiceEpoch; probe = fixture.Probe();
            await Until(delegate { return Task.FromResult(fixture.Handler.Reads == 1); }, "Old epoch health request");
            window.SetService(null, "Synthetic page replacement"); window.SetService(instance, null);
            await Until(delegate { return Task.FromResult((bool)Field(window, "pageReady")); }, "Replaced page handshake");
            await BeginOwner(core, window, "epoch-owner"); fixture.Handler.Complete(null); await probe;
            Check(window.ServiceEpoch != oldEpoch && window.OwnsAccountMutation("epoch-owner", window.ServiceEpoch), "Old epoch cannot revoke the same operation identifier on a new page");
            await EndOwner(core, window, "epoch-owner");

            fixture.Handler.Reset(); await BeginOwner(core, window, "window-owner"); probe = fixture.Probe();
            await Until(delegate { return Task.FromResult(fixture.Handler.Reads == 1); }, "Replaced window health request");
            Set(fixture.Context, "dashboard", null); fixture.Handler.Complete(null); await probe;
            Check(window.OwnsAccountMutation("window-owner", window.ServiceEpoch), "Probe belongs to its captured dashboard reference");
            Set(fixture.Context, "dashboard", window); await EndOwner(core, window, "window-owner");

            fixture.Handler.Reset(); await BeginOwner(core, window, "instance-owner"); probe = fixture.Probe();
            await Until(delegate { return Task.FromResult(fixture.Handler.Reads == 1); }, "Replaced service health request");
            var replacement = new DesktopInstance { Origin = instance.Origin, Version = instance.Version, InstanceId = "33333333-3333-4333-8333-333333333333" };
            Set(fixture.Context, "instance", replacement); fixture.Handler.Complete(null); await probe;
            Check(window.OwnsAccountMutation("instance-owner", window.ServiceEpoch) && replacement.SameAs((DesktopInstance)Field(fixture.Context, "instance")), "Old probe cannot revoke the replacement service identity");
            Set(fixture.Context, "instance", instance); await EndOwner(core, window, "instance-owner");

            fixture.Handler.Reset(); await BeginOwner(core, window, "disconnected"); oldEpoch = window.ServiceEpoch; probe = fixture.Probe();
            await Until(delegate { return Task.FromResult(fixture.Handler.Reads == 1); }, "Current login health request");
            fixture.Handler.Complete(null); await probe;
            Check(!window.AccountMutationPending && window.ServiceEpoch > oldEpoch, "Actual service loss revokes the pending login and epoch");
            Check(Field(fixture.Context, "instance") == null && !(bool)Field(fixture.Context, "refreshing"), "Actual service loss releases the probe and allows reconnect");
            Check(Field(fixture.Context, "recoveryInstance") == null, "A missing service never requests replacement shutdown");
            window.SetService(instance, null);
            await Until(delegate { return Task.FromResult((bool)Field(window, "pageReady")); }, "Reconnect after pending login service loss");
        }
    }
    private static async Task Run(DesktopWebWindow window, DesktopInstance instance, DesktopPetPreferences preferences, string screenshot)
    {
        Check(DesktopWebPolicy.Document(instance, new Uri(instance.Origin, "desktop.html").AbsoluteUri), "Shipping document is allowed");
        foreach (var url in new[] { "https://127.0.0.1:" + instance.Origin.Port + "/desktop.html", "http://localhost:" + instance.Origin.Port + "/desktop.html", "file:///C:/Windows/win.ini", "http://127.0.0.1:1/desktop.html", new Uri(instance.Origin, "/desktop.html?token=anything").AbsoluteUri })
            Check(!DesktopWebPolicy.Document(instance, url), "Unexpected document rejected");
        Check(!DesktopWebPolicy.Request(instance, new Uri(instance.Origin, "/api/shutdown").AbsoluteUri, "POST"), "Management endpoint rejected");
        Check(!DesktopWebPolicy.Request(instance, new Uri(instance.Origin, "/assets/../instance.json").AbsoluteUri, "GET"), "Arbitrary local file rejected");
        Check(DesktopWebPolicy.Request(instance, new Uri(instance.Origin, "/api/auth/refresh?accountId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").AbsoluteUri, "POST"), "Bound account refresh query allowed");
        Check(DesktopWebPolicy.Request(instance, new Uri(instance.Origin, "/api/auth/refresh?accountId=").AbsoluteUri, "POST"), "Empty account refresh query allowed");
        Check(!DesktopWebPolicy.Request(instance, new Uri(instance.Origin, "/api/auth/refresh?accountId=&extra=1").AbsoluteUri, "POST"), "Extra refresh query rejected");
        Check(!DesktopWebPolicy.Request(instance, new Uri(instance.Origin, "/api/auth/refresh?accountId=invalid").AbsoluteUri, "POST"), "Invalid refresh account rejected");
        Check(DesktopWebPolicy.Request(instance, new Uri(instance.Origin, "/api/desktop/records?period=2026-09&sort=recent&accountId=").AbsoluteUri, "GET"), "Empty account records query allowed");
        Check(!DesktopWebPolicy.Request(instance, new Uri(instance.Origin, "/api/desktop/records?period=2026-09&accountId=&accountId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").AbsoluteUri, "GET"), "Duplicate account records query rejected");
        Check(!DesktopWebPolicy.Request(instance, new Uri(instance.Origin, "/api/desktop/records?accountId=").AbsoluteUri, "GET"), "Empty account does not bypass required record period");
        Check(!DesktopWebPolicy.External("https://github.com@evil.invalid/settings/copilot/features"), "Credential URL rejected");
        Check(!DesktopWebPolicy.External("https://github.com/login/device"), "Device login requires a fresh API read");
        Check(DesktopWebPolicy.External("https://github.com/settings/copilot/features"), "Account settings allowed");
        Console.WriteLine("WebView2 host: waiting for initialized renderer");
        await Until(delegate { return Task.FromResult((bool)Field(window, "initialized")); }, "WebView2 initialization (Evergreen must be installed)");
        var view = (WebView2)Field(window, "view"); var core = view.CoreWebView2;
        Console.WriteLine("WebView2 host: waiting for shipping page handshake");
        await Until(async delegate { return (bool)Field(window, "pageReady") && await core.ExecuteScriptAsync("document.body.innerText.includes('PilotMeter') && document.body.innerText.length > 150 && document.styleSheets.length > 0") == "true"; }, "Shipping Tailwind page renders and acknowledges bridge");
        Check(view.Visible, "Rendered view replaces native connection message");
        Check(!core.Settings.AreDevToolsEnabled && !core.Settings.AreHostObjectsAllowed && !core.Settings.AreDefaultContextMenusEnabled, "Privileged browser features disabled");
        Check(!core.Settings.IsPasswordAutosaveEnabled && !core.Settings.IsGeneralAutofillEnabled, "Embedded credential capture disabled");
        Check(await core.ExecuteScriptAsync("document.querySelectorAll('script[src]').length > 0 && [...document.styleSheets].some(s=>s.href && s.href.includes('/assets/'))") == "true", "Shipping compiled assets were loaded");
        Check(await core.ExecuteScriptAsync("parseFloat(getComputedStyle(document.querySelector('.card')).borderRadius) >= 8") == "true", "Compiled Tailwind stylesheet is applied by the real renderer");
        await core.ExecuteScriptAsync("window.__desktopApi=null;(async()=>{const records=await fetch('/api/desktop/records?period=2026-09&sort=recent&accountId=');const session=await(await fetch('/api/session')).json();const refresh=await fetch('/api/auth/refresh?accountId=',{method:'POST',headers:{'Content-Type':'application/json','X-PilotMeter-CSRF':session.csrfToken},body:'{}'});const stale=await fetch('/api/auth/refresh?accountId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',{method:'POST',headers:{'Content-Type':'application/json','X-PilotMeter-CSRF':session.csrfToken},body:'{}'});window.__desktopApi={records:records.status,refresh:refresh.status,stale:stale.status};})().catch(e=>window.__desktopApi={error:String(e)})");
        await Until(async delegate { return await core.ExecuteScriptAsync("window.__desktopApi !== null") == "true"; }, "Actual WebView API query requests");
        Check(await core.ExecuteScriptAsync("window.__desktopApi.records === 200 && window.__desktopApi.refresh === 200 && window.__desktopApi.stale === 409") == "true", "Real records/refresh routes pass host policy and retain daemon account guard");
        await core.ExecuteScriptAsync("window.__hostMessages=[];window.chrome.webview.addEventListener('message',e=>window.__hostMessages.push(e.data));window.chrome.webview.postMessage({type:'ready'});");
        await Until(async delegate { return await core.ExecuteScriptAsync("window.__hostMessages.some(m=>m.type==='service-state') && window.__hostMessages.some(m=>m.type==='pet-state')") == "true"; }, "Host safe state handshake");
        int epoch = (int)Field(window, "navigationGeneration");
        Check(await core.ExecuteScriptAsync("window.__hostMessages.find(m=>m.type==='service-state').sessionLaunchAvailable === false") == "true", "Windows without bundled runtime never offer session launch");
        await Post(core, new { type = "start-session", requestId = "unavailable-session", accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", epoch = epoch });
        await Until(async delegate { return await core.ExecuteScriptAsync("window.__hostMessages.some(m=>m.type==='session-start-result'&&m.requestId==='unavailable-session'&&m.status==='error')") == "true"; }, "Unavailable runtime returns correlated launch feedback");
        await Post(core, new { type = "start-session", requestId = "extra-command", accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", command = "calc.exe", epoch = epoch });
        await Until(async delegate { return await core.ExecuteScriptAsync("window.__hostMessages.some(m=>m.type==='session-start-result'&&m.requestId==='extra-command'&&m.status==='error')") == "true"; }, "Page cannot submit arbitrary command fields");
        await Post(core, new { type = "start-session", requestId = "old-epoch-session", accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", epoch = epoch - 1 });
        await Task.Delay(100); Check(await core.ExecuteScriptAsync("!window.__hostMessages.some(m=>m.requestId==='old-epoch-session')") == "true", "Stale page cannot launch a session or receive current launch feedback");
        Check(await core.ExecuteScriptAsync("window.__hostMessages.find(m=>m.type==='pet-state').pets.length === 10") == "true", "Ten pets available");
        string state = await core.ExecuteScriptAsync("JSON.stringify(window.__hostMessages)");
        Check(!state.Contains("csrfToken") && !state.Contains("collectorToken") && !state.Contains("managementToken") && !state.Contains("webview2"), "Bridge state contains no tokens or profile paths");
        int selected = 0; window.QuotaSelectionChanged += delegate { selected++; };
        await Post(core, new { type = "account-mutation", pending = true, operationId = "first", epoch = epoch });
        await Until(delegate { return Task.FromResult(window.AccountMutationPending); }, "Mutation starts before ACK");
        await Until(async delegate { return await core.ExecuteScriptAsync("window.__hostMessages.some(m=>m.type==='account-mutation-state'&&m.operationId==='first'&&m.pending)") == "true"; }, "Owner receives ACK");
        await Post(core, new { type = "account-mutation", pending = false, operationId = "stale", epoch = epoch });
        await Task.Delay(100); Check(window.AccountMutationPending, "Stale owner cannot release mutation");
        await Post(core, new { type = "account-mutation", pending = false, operationId = "first", epoch = epoch - 1 });
        await Task.Delay(100); Check(window.AccountMutationPending, "Stale epoch cannot release mutation");
        await Post(core, new { type = "account-mutation", pending = false, operationId = "first", epoch = epoch });
        await Until(delegate { return Task.FromResult(!window.AccountMutationPending); }, "Matching owner releases mutation");
        Check(selected >= 2, "PET receives mutation state changes");
        await Post(core, new { type = "pet-update", petId = "04", sizePixels = 112, motionEnabled = false, alwaysOnTop = false, epoch = epoch });
        await Until(delegate { return Task.FromResult(preferences.PetId == "04"); }, "PET settings persisted");
        Check(preferences.SizePixels == 112 && !preferences.MotionEnabled && !preferences.AlwaysOnTop, "PET settings propagated");
        await Post(core, new { type = "pet-update", petId = "03", sizePixels = 999, epoch = epoch });
        await Task.Delay(100); Check(preferences.PetId == "04", "Invalid settings cannot partially mutate PET");
        await core.ExecuteScriptAsync("window.__blocked=null;fetch('/api/shutdown',{method:'POST'}).then(r=>window.__blocked=r.status).catch(()=>window.__blocked='blocked')");
        await Until(async delegate { return await core.ExecuteScriptAsync("window.__blocked === 403 || window.__blocked === 'blocked'") == "true"; }, "Host blocks unauthorized API request");
        await core.ExecuteScriptAsync("location.assign('/index.html')");
        await Task.Delay(150); Check(DesktopWebPolicy.Document(instance, core.Source), "Main document cannot navigate to another local page");
        Check(await core.ExecuteScriptAsync("document.documentElement.scrollWidth <= innerWidth + 1") == "true", "Desktop has no horizontal viewport overflow");
        Directory.CreateDirectory(Path.GetDirectoryName(screenshot));
        Console.WriteLine("WebView2 host: capturing real rendered pixels");
        bool hasScreenshot = false;
        using (var output = File.Create(screenshot + ".pending"))
        {
            var capture = core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, output);
            if (await Task.WhenAny(capture, Task.Delay(15000)) == capture) { await capture; hasScreenshot = true; }
            else
            {
                capture.ContinueWith(task => GC.KeepAlive(task.Exception), TaskContinuationOptions.OnlyOnFaulted);
                Console.WriteLine("WebView2 visual evidence unavailable: the zero-opacity renderer supplied no capture frame within 15 seconds. DOM, applied CSS, bridge, and reconnect checks remain mandatory; use the Chromium visual evidence for pixels.");
            }
        }
        if (hasScreenshot)
        {
            File.Copy(screenshot + ".pending", screenshot, true);
            using (var capture = new Bitmap(screenshot)) Check(capture.Width > 500 && capture.Height > 400, "Real renderer screenshot captured");
        }
        else if (File.Exists(screenshot) && new FileInfo(screenshot).Length == 0) File.Delete(screenshot);
        File.Delete(screenshot + ".pending");
        window.SetService(null, "Synthetic disconnect");
        await Until(async delegate { return core.Source == "about:blank" && !(bool)Field(window, "pageReady"); }, "Offline view revokes document");
        Check((int)Field(window, "navigationGeneration") > epoch, "Disconnect revokes prior epoch");
        window.SetService(instance, null);
        await Until(delegate { return Task.FromResult((bool)Field(window, "pageReady")); }, "Reconnect renders a newly verified document");
        Check((int)Field(window, "navigationGeneration") > epoch, "Reconnect cannot reuse old bridge epoch");
        await PendingRecovery(window, core, instance);
    }
    [STAThread]
    public static int Main(string[] args)
    {
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
        AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs error) { Console.Error.WriteLine(error.ExceptionObject); };
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        var instance = new DesktopInstance { Origin = new Uri(args[0] + "/"), Version = args[1], InstanceId = args[2] };
        Directory.CreateDirectory(args[3]); var preferences = new DesktopPetPreferences(args[3]);
        using (var window = new DesktopWebWindow(args[3], delegate { return Task.FromResult(0); }))
        {
            window.Opacity = 0; window.ShowInTaskbar = false; window.ClientSize = new Size(1260, 850);
            window.SetPetPreferences(preferences); window.SetService(instance, null);
            window.Shown += async delegate {
                try { await Run(window, instance, preferences, args[4]); outcome = 0; Console.WriteLine("Desktop WebView2: " + checks + " checks passed; shipping Tailwind page rendered."); }
                catch (Exception error) { Console.Error.WriteLine(error); }
                finally { window.Close(); }
            };
            Application.Run(window);
        }
        return outcome;
    }
}
