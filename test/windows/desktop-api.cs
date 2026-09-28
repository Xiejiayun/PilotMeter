using System;
using System.Collections.Generic;
using System.Threading.Tasks;

// Executes against the runner's isolated loopback fixture; never signs in.
internal static class DesktopApiTests
{
    private static int checks;
    private static void Check(bool value) { if (!value) throw new Exception("Native API contract failed."); checks++; }
    private static async Task Reject(Func<Task> request)
    {
        try { await request(); } catch { checks++; return; }
        throw new Exception("Unsafe native API response was accepted.");
    }
    internal static async Task<int> Run(string origin)
    {
        var instance = DesktopInstance.FromDescriptor(new Dictionary<string, object> {
            { "app", "pilotmeter" }, { "version", "contract" }, { "instanceId", "11111111-1111-4111-8111-111111111111" }, { "url", origin }
        });
        using (var api = new DesktopNativeApi(instance))
        {
            Check(DesktopJson.String(await api.RequestAsync("/api/desktop"), "result", 20) == "read");
            Check(DesktopJson.String(await api.RequestAsync("/api/auth/select", "POST", new Dictionary<string, object> { { "accountId", "normal" } }), "result", 20) == "authorized");
            foreach (var bad in new[] { "https://example.com", "//example.com/api/auth/accounts", "/api/desktop?token=secret", "/api/stop", "/api/auth/run-context", "/api/auth/accounts/../select" })
                await Reject(async delegate { await api.RequestAsync(bad, "POST"); });
            foreach (var scenario in new[] { "redirect", "oversized", "error", "foreign" })
            {
                await api.RequestAsync("/api/auth/select", "POST", new Dictionary<string, object> { { "accountId", scenario } });
                await Reject(async delegate { await api.RequestAsync("/api/auth/accounts"); });
            }
            await api.RequestAsync("/api/auth/select", "POST", new Dictionary<string, object> { { "accountId", "pending" } });
            var pending = api.RequestAsync("/api/auth/accounts");
            await Task.Delay(100);
            api.Dispose();
            await Reject(async delegate { await pending; });
        }
        return checks;
    }
}
