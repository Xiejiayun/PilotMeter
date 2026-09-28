using System;
using System.Collections.Generic;
using System.IO;

internal static class NativeViewTests
{
    private static int checks;
    private const string AccountId = "11111111-2222-4333-8444-555555555555";
    private const string InstanceId = "aa159f20-b60d-4c08-9352-c3c7bce1ab76";

    private static void Check(bool value, string message)
    {
        if (!value) throw new Exception(message);
        checks++;
    }

    private static void Reject(Action operation, string message)
    {
        try { operation(); }
        catch (InvalidDataException) { checks++; return; }
        catch (ArgumentException) { checks++; return; }
        throw new Exception(message);
    }

    private static Dictionary<string, object> Bucket()
    {
        return new Dictionary<string, object> {
            { "key", "premium_interactions" }, { "label", "高级请求" }, { "value", "37.5%" }, { "detail", "数量单位未确认，仅展示已确认比例或额度状态。" },
            { "percentage", 37.5 }, { "nextResetAt", null }, { "unit", "unspecified" }, { "unitLabel", "单位未确认" },
            { "used", null }, { "limit", null }, { "unlimited", false }
        };
    }

    private static Dictionary<string, object> Profile()
    {
        return new Dictionary<string, object> { { "id", AccountId }, { "login", "sample-person" }, { "host", "https://github.com" }, { "status", "connected" } };
    }

    private static Dictionary<string, object> Overview()
    {
        return new Dictionary<string, object> {
            { "app", "pilotmeter" }, { "version", "1.2.3" }, { "instanceId", InstanceId },
            { "accounts", new object[] { Profile() } }, { "activeAccountId", AccountId }, { "enabled", true }, { "refreshing", false }, { "login", null },
            { "quota", new Dictionary<string, object> { { "accountId", AccountId }, { "state", "available" }, { "stale", false }, { "error", null } } },
            { "presentation", new Dictionary<string, object> {
                { "selection", "premium" }, { "primary", Bucket() }, { "buckets", new object[] { Bucket() } },
                { "fetchedAt", DateTime.UtcNow.ToString("o") }, { "stale", false }
            } }
        };
    }

    private static Dictionary<string, object> Login()
    {
        return new Dictionary<string, object> {
            { "id", AccountId }, { "host", "https://github.com" }, { "status", "pending" }, { "userCode", "ABCD-EFGH" },
            { "verificationUri", "https://github.com/login/device" }, { "expiresAt", DateTime.UtcNow.AddMinutes(5).ToString("o") }, { "error", null }
        };
    }

    private static Dictionary<string, object> Model(string status = "available", string policy = "enabled")
    {
        return new Dictionary<string, object> {
            { "id", "test-model" }, { "name", "Synthetic model" }, { "status", status }, { "policyState", policy },
            { "reason", "Synthetic explicit policy" }, { "vision", true }, { "reasoningEffort", null }, { "contextWindowTokens", 128000 }, { "multiplier", "1.5" }
        };
    }

    private static Dictionary<string, object> Models()
    {
        return new Dictionary<string, object> {
            { "accountId", AccountId }, { "state", "available" }, { "source", "copilot-cli-models.list" },
            { "fetchedAt", DateTime.UtcNow.ToString("o") }, { "stale", false }, { "refreshing", false }, { "error", null }, { "items", new object[] { Model() } }
        };
    }

    private static Dictionary<string, object> Local()
    {
        return new Dictionary<string, object> {
            { "accountId", AccountId }, { "period", "2026-09" }, { "source", "local-otel" }, { "scope", "Synthetic account · local sessions only" },
            { "coverage", "partial" }, { "nanoAiu", "123456789" }, { "credits", "0.123456789" }, { "unitVerified", true },
            { "knownCalls", 1 }, { "unknownCalls", 2 }, { "pendingCalls", 3 }, { "sessionCount", 4 }, { "retained", false }, { "updatedAt", DateTime.UtcNow.ToString("o") }
        };
    }

    private static Dictionary<string, object> Record()
    {
        return new Dictionary<string, object> {
            { "id", "local-record" }, { "sessionId", "synthetic-session" }, { "firstSeen", null }, { "lastSeen", DateTime.UtcNow.ToString("o") },
            { "nanoAiu", "123456789" }, { "credits", "0.123456789" }, { "unitVerified", true }, { "models", new object[] { "observed-model" } },
            { "knownCalls", 1 }, { "unknownCalls", 2 }, { "pendingCalls", 3 }
        };
    }

    private static Dictionary<string, object> Records()
    {
        return new Dictionary<string, object> {
            { "app", "pilotmeter" }, { "version", "1.2.3" }, { "instanceId", InstanceId }, { "accountId", AccountId }, { "period", "2026-09" },
            { "source", "local-otel" }, { "scope", "Synthetic account · local sessions only" }, { "coverage", "partial" },
            { "items", new object[] { Record() } }, { "nextCursor", "abc_123" }
        };
    }

    internal static int Run()
    {
        checks = 0;
        var identity = new DesktopInstance { Version = "1.2.3", InstanceId = InstanceId, Origin = new Uri("http://127.0.0.1:18181/") };
        var view = NativeOverview.Read(Overview(), identity);
        Check(view.CanDisplayQuota && view.Active.Login == "sample-person", "The native view must accept the selected account's verified presentation.");
        Check(view.Primary.Value == "37.5%" && view.Primary.Percentage == 37.5, "The native view must retain the shared projection's value and percentage.");
        Check(view.Primary.Label == "高级请求" && view.Buckets.Count == 1, "Category labels must come from the shared projection.");
        foreach (var field in new[] { "app", "version", "instanceId" })
        {
            var malformed = Overview(); malformed[field] = "different";
            Reject(delegate { NativeOverview.Read(malformed, identity); }, "A different daemon identity must never supply visible account values.");
        }
        var crossAccount = Overview(); NativeData.Map(crossAccount, "quota")["accountId"] = "99999999-2222-4333-8444-555555555555";
        Reject(delegate { NativeOverview.Read(crossAccount, identity); }, "Quota from another account must be rejected.");
        var missing = Overview(); missing["activeAccountId"] = "99999999-2222-4333-8444-555555555555";
        Reject(delegate { NativeOverview.Read(missing, identity); }, "A removed active account must be rejected.");
        var duplicate = Overview(); duplicate["accounts"] = new object[] { Profile(), Profile() };
        Reject(delegate { NativeOverview.Read(duplicate, identity); }, "Duplicate account identities must be rejected.");
        foreach (var status in new[] { "reauth-required", "error" })
        {
            var unavailable = Overview(); var profile = Profile(); profile["status"] = status; unavailable["accounts"] = new object[] { profile };
            Check(!NativeOverview.Read(unavailable, identity).CanDisplayQuota, "An invalid login must clear both the primary value and other quotas.");
        }
        foreach (var field in new[] { "quota", "presentation" })
        {
            var stale = Overview(); NativeData.Map(stale, field)["stale"] = true;
            Check(!NativeOverview.Read(stale, identity).CanDisplayQuota, "Stale quota must not be presented as current.");
        }
        foreach (var state in new[] { "error", "unavailable" })
        {
            var unavailable = Overview(); NativeData.Map(unavailable, "quota")["state"] = state;
            Check(!NativeOverview.Read(unavailable, identity).CanDisplayQuota, "Unavailable account quotas must not render a known percentage.");
        }
        var noAccount = Overview(); noAccount["accounts"] = new object[0]; noAccount["activeAccountId"] = null; noAccount["quota"] = null;
        var empty = NativeData.Map(noAccount, "presentation"); empty["selection"] = "none"; empty["primary"] = null; empty["buckets"] = new object[0]; empty["fetchedAt"] = null; empty["stale"] = true;
        Check(!NativeOverview.Read(noAccount, identity).CanDisplayQuota, "A new installation must remain unknown, not zero.");
        var badSelection = Overview(); NativeData.Map(badSelection, "presentation")["selection"] = "sum";
        Reject(delegate { NativeOverview.Read(badSelection, identity); }, "Unsupported aggregate presentation modes must be rejected.");
        foreach (var number in new object[] { -1, 100.1, Double.NaN, Double.PositiveInfinity, "37.5" })
        {
            var malformed = Bucket(); malformed["percentage"] = number;
            Reject(delegate { NativeBucket.Read(malformed); }, "Invalid percentages must not become progress values.");
        }
        foreach (var number in new object[] { 0, 100, null })
        {
            var valid = Bucket(); valid["percentage"] = number;
            Check(NativeBucket.Read(valid).Percentage == (number == null ? (double?)null : Convert.ToDouble(number)), "Known boundaries and unknown progress must stay distinct.");
        }
        var quantity = Bucket(); quantity["value"] = "3 / 10"; quantity["percentage"] = null; quantity["unit"] = "ai-credits"; quantity["unitLabel"] = "AI Credits";
        var creditView = NativeBucket.Read(quantity);
        Check(creditView.Value == "3 / 10" && creditView.UnitLabel == "AI Credits" && creditView.Unit == "ai-credits", "A quantity-only primary value must retain its explicitly known unit.");
        var invalidUnit = Bucket(); invalidUnit["unit"] = "inferred-from-category";
        Reject(delegate { NativeBucket.Read(invalidUnit); }, "Categories must never become inferred quantity units.");
        var exact = Bucket(); exact["unit"] = "ai-credits"; exact["unitLabel"] = "AI Credits"; exact["used"] = "0.000000001";
        exact["limit"] = "9007199254740993.000000001"; exact["remaining"] = "9007199254740993"; exact["remainingSource"] = "calculated"; exact["remainingPercentage"] = "99.999999999";
        var exactView = NativeBucket.Read(exact);
        Check(exactView.Remaining == "9007199254740993" && NativeDisplay.Amount(exactView.Limit) == "9,007,199,254,740,993.000000001", "Quota amounts must retain exact decimal strings beyond floating-point precision.");
        Check(NativeDisplay.Percentage(exactView.RemainingPercentage) == ">99.9%", "An almost-full ratio must not be rounded to a misleading 100%.");
        Check(NativeDisplay.ExactPercentage("99.99999999999999999999999999999") == ">99.9%", "An exact sub-100 percentage must not round up through a floating point conversion.");
        var excessivePercent = Bucket(); excessivePercent["remainingPercentage"] = "100.00000000000000000000000000001";
        Reject(delegate { NativeBucket.Read(excessivePercent); }, "A slightly out-of-range decimal percentage must be rejected exactly.");
        Check(NativeDisplay.Percentage(.00001) == "<0.1%" && NativeDisplay.Amount(null) == "—", "Small usage and missing values must remain distinguishable from zero.");
        Check(NativeDisplay.CompactAmount("0.000000001") == "1e-9" && NativeDisplay.CompactAmount("9007199254740993000000000000") == "≈9e27", "Small controls use explicit scientific notation; only inexact compact values get an approximation marker.");
        var rawQuota = Bucket(); rawQuota["raw"] = new Dictionary<string, object> { { "used", "17.25" }, { "limit", "20000" }, { "remainingPercentage", "62.4" }, { "token", "never-display-this" } };
        var rawView = NativeBucket.Read(rawQuota);
        Check(rawView.Used == null && rawView.Limit == null && rawView.Remaining == null && rawView.RawUsed == "17.25" && rawView.RawLimit == "20000", "Unknown units may expose only allowlisted raw quantities, never main amounts.");
        var invented = Bucket(); invented["remaining"] = "10";
        Reject(delegate { NativeBucket.Read(invented); }, "An unknown unit cannot contain a confirmed remaining quantity.");
        var infinite = Bucket(); infinite["unit"] = "ai-credits"; infinite["unlimited"] = true; infinite["limit"] = "100";
        Reject(delegate { NativeBucket.Read(infinite); }, "Unlimited quota cannot present a fixed total.");
        foreach (var malformed in new object[] { "-1", "1e6", "NaN", "1,000", "<script>", 42 })
        {
            var bad = Bucket(); bad["raw"] = new Dictionary<string, object> { { "used", malformed } };
            Reject(delegate { NativeBucket.Read(bad); }, "Raw numbers must never accept arbitrary content or lossy numbers.");
        }
        var retainedQuota = Overview(); NativeData.Map(retainedQuota, "quota")["state"] = "error"; NativeData.Map(retainedQuota, "presentation")["stale"] = true;
        var retainedView = NativeOverview.Read(retainedQuota, identity);
        Check(!retainedView.CanDisplayQuota && retainedView.CanDisplaySnapshot, "A same-account stale snapshot is displayable only with old-data status.");
        var catalog = NativeModels.Read(Models(), AccountId);
        Check(catalog.Items.Count == 1 && !catalog.Stale && catalog.Items[0].Multiplier == "1.5" && catalog.Items[0].Capabilities.Contains("128,000"), "Explicit model entitlement and safe capabilities must reach native views.");
        foreach (var state in new[] { "disabled", "unknown" })
        {
            var model = NativeModel.Read(Model(state, state == "disabled" ? "disabled" : null));
            Check(NativeDisplay.ModelStatus(model, false) == (state == "disabled" ? "已禁用" : "待验证"), "Model status must not invent an organization source or infer availability.");
        }
        Reject(delegate { NativeModel.Read(Model("available", null)); }, "Signed-in identity or missing policy cannot grant a model.");
        Reject(delegate { NativeModel.Read(Model("disabled", "unconfigured")); }, "A missing policy cannot be called disabled.");
        var invalidCatalog = Models(); invalidCatalog["accountId"] = "99999999-2222-4333-8444-555555555555";
        Reject(delegate { NativeModels.Read(invalidCatalog, AccountId); }, "Cross-account model caches must never render.");
        var builtIn = Models(); builtIn["source"] = "built-in-catalog";
        Reject(delegate { NativeModels.Read(builtIn, AccountId); }, "A built-in catalog must not impersonate entitlements.");
        var oldModels = Models(); oldModels["state"] = "error"; oldModels["stale"] = true;
        var oldCatalog = NativeModels.Read(oldModels, AccountId);
        Check(oldCatalog.Stale && NativeDisplay.ModelStatus(oldCatalog.Items[0], oldCatalog.Stale) == "上次可用", "Failed model refresh must retain explicit stale wording.");
        var duplicateModels = Models(); duplicateModels["items"] = new object[] { Model(), Model() };
        Reject(delegate { NativeModels.Read(duplicateModels, AccountId); }, "Duplicate model identities must be rejected.");
        var local = NativeLocalUsage.Read(Local(), AccountId);
        Check(local.Credits == "0.123456789" && local.UnknownCalls == 2 && local.PendingCalls == 3, "Local exact consumption, unknown calls, and pending calls stay independent.");
        Reject(delegate { NativeLocalUsage.Read(Local(), null); }, "Account-scoped local totals cannot cross into retained unscoped history.");
        var records = NativeRecords.Read(Records(), identity, AccountId, "2026-09");
        Check(records.Items.Count == 1 && records.Items[0].FirstSeen == null && records.Items[0].Models[0] == "observed-model" && records.NextCursor == "abc_123", "Partial local records retain unknown timestamps and observed-model history.");
        Reject(delegate { NativeRecords.Read(Records(), identity, AccountId, "2026-08"); }, "Record responses must match the requested month.");
        Reject(delegate { NativeRecords.Read(Records(), identity, null, "2026-09"); }, "Record responses must match the requested account.");
        var unsafeCursor = Records(); unsafeCursor["nextCursor"] = "../../private";
        Reject(delegate { NativeRecords.Read(unsafeCursor, identity, AccountId, "2026-09"); }, "Record cursors must be bounded opaque URL-safe tokens.");
        var duplicateRecords = Records(); duplicateRecords["items"] = new object[] { Record(), Record() };
        Reject(delegate { NativeRecords.Read(duplicateRecords, identity, AccountId, "2026-09"); }, "Duplicate paginated records must be rejected.");
        var hugeCalls = Record(); hugeCalls["knownCalls"] = Double.PositiveInfinity;
        Reject(delegate { NativeUsageRecord.Read(hugeCalls); }, "Invalid record counts must not reach native grids.");
        var login = NativeLogin.Read(Login());
        Check(login.Active && login.UserCode == "ABCD-EFGH", "The official pending device login must be supported.");
        foreach (var terminal in new[] { "complete", "failed", "expired", "cancelled" })
        {
            var state = Login(); state["status"] = terminal;
            Check(!NativeLogin.Read(state).Active, "Terminal logins must stop polling and exposing device codes.");
        }
        foreach (var invalidHost in new[] { "http://github.com", "https://github.com.evil", "https://user@github.com", "https://nested.tenant.ghe.com", "https://github.com/path" })
        {
            var malformed = Login(); malformed["host"] = invalidHost;
            Reject(delegate { NativeLogin.Read(malformed); }, "Unsupported device authorization hosts must be rejected.");
        }
        foreach (var invalidCode in new[] { "<script>", "ABCD EFGH", "A\r\nB", new string('A', 40) })
        {
            var malformed = Login(); malformed["userCode"] = invalidCode;
            Reject(delegate { NativeLogin.Read(malformed); }, "Malformed device codes must not reach the native clipboard action.");
        }
        Check(NativeData.Host("github.com") == "https://github.com" && NativeData.Host("https://work.ghe.com/") == "https://work.ghe.com", "Supported hosts must normalize for the device flow.");
        Check(NativeData.DevicePage("https://github.com", "https://github.com/login/device") != null, "The matching official device page must be allowed.");
        Check(NativeData.DevicePage("https://work.ghe.com", "https://work.ghe.com/login/device") != null, "The matching enterprise device page must be allowed.");
        foreach (var target in new[] { "https://other.ghe.com/login/device", "https://github.com/login/device?next=x", "https://github.com/login/device#x", "https://github.com:444/login/device", "http://github.com/login/device", "https://github.com/login/oauth", "file:///C:/secret", "javascript:alert(1)", null })
            Check(NativeData.DevicePage("https://github.com", target) == null, "Only the requested host's exact device page may open externally.");
        return checks;
    }
}
