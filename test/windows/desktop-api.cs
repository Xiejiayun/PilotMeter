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
            Check(DesktopJson.String(await api.RequestAsync("/api/desktop?quotaKey=premium_interactions&accountId=11111111-2222-4333-8444-555555555555"), "result", 20) == "read");
            Check(DesktopJson.String(await api.RequestAsync("/api/desktop/records?period=2026-09&sort=recent&accountId=11111111-2222-4333-8444-555555555555&cursor=abc_123"), "result", 20) == "read");
            Check(DesktopJson.String(await api.RequestAsync("/api/auth/select", "POST", new Dictionary<string, object> { { "accountId", "normal" } }), "result", 20) == "authorized");
            foreach (var bad in new[] { "https://example.com", "//example.com/api/auth/accounts", "/api/desktop?token=secret", "/api/stop", "/api/auth/run-context", "/api/auth/accounts/../select" })
                await Reject(async delegate { await api.RequestAsync(bad, "POST"); });
            foreach (var bad in new[] { "/api/desktop?quotaKey=chat&quotaKey=chat", "/api/desktop?accountId=unverified", "/api/desktop?token=secret", "/api/desktop/records", "/api/desktop/records?period=2026-13", "/api/desktop/records?period=2026-09&sort=secret", "/api/desktop/records?period=2026-09&cursor=../private", "/api/desktop/records?period=2026-09&accountId=%0a", "/api/desktop/records?period=2026-09#secret", "/api/desktop/records?period=2026-09&quotaKey=chat" })
                await Reject(async delegate { await api.RequestAsync(bad); });
            await api.RequestAsync("/api/auth/select", "POST", new Dictionary<string, object> { { "accountId", "medium" } });
            Check(DesktopJson.String(await api.RequestAsync("/api/auth/accounts"), "content", 70000).Length == 70000);
            foreach (var scenario in new[] { "redirect", "oversized", "error" })
            {
                await api.RequestAsync("/api/auth/select", "POST", new Dictionary<string, object> { { "accountId", scenario } });
                await Reject(async delegate { await api.RequestAsync("/api/auth/accounts"); });
            }
            foreach (var scenario in new[] { "foreign", "foreign-conflict" })
            {
                await api.RequestAsync("/api/auth/select", "POST", new Dictionary<string, object> { { "accountId", scenario } });
                var changed = false;
                try { await api.RequestAsync("/api/auth/accounts"); }
                catch (DesktopServiceChangedException) { changed = true; }
                Check(changed);
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
