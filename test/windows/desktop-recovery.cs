using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// Calls the shipping recovery methods with an isolated descriptor and transport.
// No Form is constructed and no real daemon or GitHub account is contacted.
internal static class DesktopRecoveryTests
{
    private const string OldVersion = "0.1.0-preview.7";
    private const string CurrentVersion = "0.1.0-preview.8";
    private const string OldId = "11111111-1111-4111-8111-111111111111";
    private const string NewId = "22222222-2222-4222-8222-222222222222";
    private static int checks;

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
        checks++;
    }

    private static void Set(object target, string name, object value)
    {
        target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).SetValue(target, value);
    }

    private static object Get(object target, string name)
    {
        return target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(target);
    }

    private static Task Call(DesktopContext context, string name, params object[] arguments)
    {
        return (Task)typeof(DesktopContext).GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic).Invoke(context, arguments);
    }

    private static Dictionary<string, object> Identity(string version, string id)
    {
        return new Dictionary<string, object> { { "app", "pilotmeter" }, { "version", version },
            { "instanceId", id }, { "url", "http://127.0.0.1:18181" } };
    }

    private static void WriteIdentity(string directory, string version, string id)
    {
        File.WriteAllText(Path.Combine(directory, "instance.json"), new JavaScriptSerializer().Serialize(Identity(version, id)));
    }

    private sealed class FixtureHandler : HttpMessageHandler
    {
        private readonly string directory;
        internal FixtureHandler(string directory) { this.directory = directory; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
        {
            cancellation.ThrowIfCancellationRequested();
            var identity = DesktopJson.ReadFile(Path.Combine(directory, "instance.json"));
            object body;
            switch (request.RequestUri.AbsolutePath)
            {
                case "/health": body = identity; break;
                case "/api/auth/accounts": body = new Dictionary<string, object> { { "enabled", true }, { "accounts", new object[0] }, { "activeAccountId", null } }; break;
                case "/api/widget":
                    identity.Add("state", "needs-login"); identity.Add("title", "PilotMeter"); identity.Add("value", "未登录");
                    identity.Add("detail", "Synthetic recovery fixture"); identity.Add("accountId", null); body = identity; break;
                default: throw new Exception("Recovery requested an unexpected endpoint.");
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(new JavaScriptSerializer().Serialize(body)) });
        }
    }

    private sealed class Fixture : IDisposable
    {
        internal readonly DesktopContext Context;
        internal readonly string DirectoryPath;
        internal readonly WidgetSnapshotGate Gate = new WidgetSnapshotGate();
        private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        private readonly HttpClient http;

        internal Fixture(string root, string scenario)
        {
            DirectoryPath = Path.Combine(root, scenario, "data 空格 & (x)");
            Directory.CreateDirectory(DirectoryPath);
            var runtime = Path.Combine(root, scenario, "runtime-root");
            Directory.CreateDirectory(Path.Combine(runtime, "runtime"));
            Directory.CreateDirectory(Path.Combine(runtime, "app", "bin"));
            File.Copy(Assembly.GetExecutingAssembly().Location, Path.Combine(runtime, "runtime", "node.exe"));
            File.WriteAllText(Path.Combine(runtime, "app", "bin", "pilotmeter.js"), "Synthetic command fixture");
            WriteIdentity(DirectoryPath, OldVersion, OldId);
            Directory.CreateDirectory(Path.Combine(DirectoryPath, "writer.lock"));
            File.WriteAllText(Path.Combine(DirectoryPath, "settings.json"), "synthetic settings retained");
            http = new HttpClient(new FixtureHandler(DirectoryPath));

            // Prevent widget dispatch; exercise context logic without constructing UI.
            var widget = (DesktopWidget)FormatterServices.GetUninitializedObject(typeof(DesktopWidget));
            Set(widget, "disposing", true);
            Context = (DesktopContext)FormatterServices.GetUninitializedObject(typeof(DesktopContext));
            Set(Context, "runtimeRoot", runtime); Set(Context, "launcher", Assembly.GetExecutingAssembly().Location);
            Set(Context, "directory", DirectoryPath); Set(Context, "version", CurrentVersion);
            Set(Context, "lifetime", lifetime); Set(Context, "http", http); Set(Context, "widget", widget); Set(Context, "snapshotGate", Gate);
        }

        internal string[] Commands()
        {
            var path = Path.Combine(DirectoryPath, "commands.txt");
            return File.Exists(path) ? File.ReadAllLines(path) : new string[0];
        }

        public void Dispose() { lifetime.Cancel(); http.Dispose(); lifetime.Dispose(); }
    }

    private static async Task WaitUntil(Func<bool> ready, string failure)
    {
        var elapsed = Stopwatch.StartNew();
        while (!ready())
        {
            if (elapsed.ElapsedMilliseconds > 5000) throw new Exception(failure);
            await Task.Delay(25);
        }
    }

    private static async Task Run(string root)
    {
        using (var fixture = new Fixture(root, "explicit"))
        {
            await Call(fixture.Context, "RefreshAsync", false);
            Check(fixture.Commands().Length == 0, "Timer refresh must not stop or start a mismatched live service.");
            await Call(fixture.Context, "RefreshAsync", true);
            Check(fixture.Commands().Length == 0, "Automatic startup must not replace a mismatched live service.");
            Check(((DesktopInstance)Get(fixture.Context, "recoveryInstance")).InstanceId == OldId, "The recovery action must capture the confirmed old identity.");

            var recovery = Call(fixture.Context, "RefreshRequestedAsync");
            await WaitUntil(delegate { return File.Exists(Path.Combine(fixture.DirectoryPath, "stop-requested")); }, "Explicit recovery did not request shutdown.");
            Check(fixture.Commands().Length == 1 && fixture.Commands()[0] == "stop " + OldId, "Shutdown must pass only the confirmed instance to the CLI guard.");
            await Task.Delay(250);
            Check(!recovery.IsCompleted && fixture.Commands().Length == 1, "Restart must wait while the old writer lock is held.");
            Check(!fixture.Gate.CanRead && (bool)Get(fixture.Context, "actionBusy"), "Recovery must block overlapping account reads and actions.");
            Directory.Delete(Path.Combine(fixture.DirectoryPath, "writer.lock"));
            await WaitUntil(delegate { return recovery.IsCompleted; }, "Recovery did not finish after the old writer released its lock.");
            await recovery;
            Check(fixture.Commands().Length == 2 && fixture.Commands()[1] == "start", "Releasing the writer lock must permit exactly one restart.");
            Check(((DesktopInstance)Get(fixture.Context, "instance")).InstanceId == NewId, "Recovery must connect to the newly verified service.");
            Check(fixture.Gate.CanRead && !(bool)Get(fixture.Context, "actionBusy"), "Recovery must release its read and action barriers.");
            Check(File.ReadAllText(Path.Combine(fixture.DirectoryPath, "settings.json")) == "synthetic settings retained", "Service recovery must retain the existing data directory.");
        }

        using (var fixture = new Fixture(root, "replaced"))
        {
            await Call(fixture.Context, "RefreshAsync", false);
            WriteIdentity(fixture.DirectoryPath, CurrentVersion, NewId);
            await Call(fixture.Context, "RefreshRequestedAsync");
            Check(fixture.Commands().Length == 0, "A service replaced since the warning must never receive a shutdown or restart command.");
            Check(((DesktopInstance)Get(fixture.Context, "instance")).InstanceId == NewId, "A healthy replacement must be adopted after re-probing.");
            Check(Directory.Exists(Path.Combine(fixture.DirectoryPath, "writer.lock")), "Recovery must not remove a replacement service's writer lock.");
        }

        using (var fixture = new Fixture(root, "disappeared"))
        {
            await Call(fixture.Context, "RefreshAsync", false);
            File.Delete(Path.Combine(fixture.DirectoryPath, "instance.json"));
            File.WriteAllText(Path.Combine(fixture.DirectoryPath, "startup-can-reclaim-lock"), "Synthetic stale owner");
            var recovery = Call(fixture.Context, "RefreshRequestedAsync");
            await WaitUntil(delegate { return recovery.IsCompleted; }, "A vanished service must delegate stale-lock recovery to startup without waiting for the lock.");
            await recovery;
            Check(fixture.Commands().Length == 1 && fixture.Commands()[0] == "start", "A vanished service must use normal startup without a shutdown command.");
            Check(!Directory.Exists(Path.Combine(fixture.DirectoryPath, "writer.lock")), "Normal startup must be allowed to reclaim a stale lock.");
            Check(((DesktopInstance)Get(fixture.Context, "instance")).InstanceId == NewId, "Recovery from a vanished service must reconnect to the new identity.");
        }
    }

    // The copied test executable stands in for packaged node.exe. It reports
    // commands and deliberately leaves shutdown's writer lock to the test.
    private static int Command(string[] args)
    {
        if (args.Length < 4 || args[1] != "--data-dir") throw new Exception("Malformed service command.");
        var directory = args[2];
        var log = Path.Combine(directory, "commands.txt");
        if (args[3] == "stop")
        {
            var current = DesktopJson.ReadFile(Path.Combine(directory, "instance.json"));
            if (args.Length != 6 || args[4] != "--if-instance" || args[5] != DesktopJson.String(current, "instanceId", 80)) return 2;
            File.AppendAllText(log, "stop " + args[5] + Environment.NewLine);
            File.WriteAllText(Path.Combine(directory, "stop-requested"), "acknowledged");
            return 0;
        }
        if (args[3] != "start" || args.Length != 5 || args[4] != "--background") return 3;
        if (Directory.Exists(Path.Combine(directory, "writer.lock")))
        {
            // Real owner-liveness reclamation is tested by the lock integration
            // suite. Here only this designated scenario models startup accepting it.
            if (File.Exists(Path.Combine(directory, "startup-can-reclaim-lock"))) Directory.Delete(Path.Combine(directory, "writer.lock"));
            else { File.AppendAllText(log, "start-before-unlock" + Environment.NewLine); return 4; }
        }
        File.AppendAllText(log, "start" + Environment.NewLine);
        WriteIdentity(directory, CurrentVersion, NewId);
        return 0;
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length > 0 && args[0].EndsWith("pilotmeter.js", StringComparison.Ordinal)) return Command(args);
            if (args.Length != 1 || !Path.IsPathRooted(args[0])) throw new Exception("The runner must supply an isolated absolute recovery directory.");
            Run(args[0]).GetAwaiter().GetResult();
            Console.WriteLine("Desktop recovery checks passed: " + checks); return 0;
        }
        catch (Exception error) { Console.Error.WriteLine("Desktop recovery failure: " + error.Message); return 1; }
    }
}
