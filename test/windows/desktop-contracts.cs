using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

// Compiled with the shipping desktop sources, but this entry point never
// constructs a Form, starts a daemon, or contacts GitHub.
internal static class DesktopContractTests
{
    private static int assertions;

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    private static void Check(bool condition, string description)
    {
        if (!condition) throw new Exception(description);
        assertions++;
    }

    private static void Reject(Action operation, string description)
    {
        try { operation(); }
        catch (ArgumentException) { assertions++; return; }
        catch (InvalidDataException) { assertions++; return; }
        catch (InvalidOperationException) { assertions++; return; }
        throw new Exception(description);
    }

    private static Dictionary<string, object> Descriptor()
    {
        return new Dictionary<string, object> {
            { "app", "pilotmeter" }, { "version", "1.2.3-preview.4" },
            { "instanceId", "aa159f20-b60d-4c08-9352-c3c7bce1ab76" },
            { "url", "http://127.0.0.1:18181" }
        };
    }

    private static void ArgumentRoundTrip(string value)
    {
        int count;
        var arguments = CommandLineToArgvW("test.exe " + DesktopApp.Quote(value) + " sentinel", out count);
        if (arguments == IntPtr.Zero) throw new Exception("Windows could not parse a quoted argument.");
        try
        {
            Check(count == 3, "Quoting must preserve exactly one argument.");
            Check(Marshal.PtrToStringUni(Marshal.ReadIntPtr(arguments, IntPtr.Size)) == value, "Windows must recover the original argument.");
            Check(Marshal.PtrToStringUni(Marshal.ReadIntPtr(arguments, IntPtr.Size * 2)) == "sentinel", "Quoting must not absorb the following argument.");
        }
        finally { LocalFree(arguments); }
    }

    public static int Main(string[] args)
    {
        try
        {
            Check(args.Length == 3, "The runner must provide isolated physical and junction directories.");
            foreach (var path in new[] { "C:relative", "relative", "..\\relative", "\\root-relative", "/root-relative", "", null })
                Reject(delegate { DesktopApp.AbsolutePath(path); }, "Relative or missing startup paths must be rejected.");
            Check(DesktopApp.AbsolutePath(args[0]) == Path.GetFullPath(args[0]), "Absolute paths must retain their full location.");
            var physical = DesktopApp.CanonicalDirectory(args[0]);
            var alias = DesktopApp.CanonicalDirectory(args[1]);
            Check(String.Equals(physical, alias, StringComparison.OrdinalIgnoreCase), "Junction aliases must identify the same data directory.");
            Check(DesktopApp.DirectoryKey(physical) == DesktopApp.DirectoryKey(alias.ToUpperInvariant()), "Aliases and case changes must use one desktop instance key.");
            Check(DesktopApp.CanonicalDirectory(args[0] + "\\") == physical, "A trailing separator must not create a second instance.");
            var driveRoot = Path.GetPathRoot(physical);
            Check(DesktopApp.CanonicalDirectory(driveRoot) == driveRoot, "A drive root must not become a drive-relative path.");
            Check(DesktopApp.DirectoryKey(physical + "-other") != DesktopApp.DirectoryKey(physical), "Separate data directories need separate desktop instances.");

            var requiredArguments = new[] { "--runtime-root", args[0], "--launcher", Path.Combine(args[0], "PilotMeter.exe"), "--data-dir", args[0] };
            var options = DesktopOptions.Parse(requiredArguments);
            Check(!options.OpenMain, "The default desktop launch must only restore the widget.");
            Check(options.RuntimeRoot == Path.GetFullPath(args[0]) && options.DataDirectory == Path.GetFullPath(args[0]), "Required startup paths must remain absolute.");
            var explicitOpen = new List<string>(requiredArguments); explicitOpen.Add("--open-main");
            Check(DesktopOptions.Parse(explicitOpen.ToArray()).OpenMain, "The explicit final flag must request the independent main window.");
            var reordered = new[] { "--data-dir", Path.Combine(args[0], "child", ".."), "--launcher", Path.Combine(args[0], "PilotMeter.exe"), "--runtime-root", args[0], "--open-main" };
            var normalized = DesktopOptions.Parse(reordered);
            Check(normalized.OpenMain && normalized.DataDirectory == Path.GetFullPath(args[0]), "Flag order and equivalent absolute paths must preserve the open request and data directory.");
            foreach (var malformed in new[] {
                new string[0], new[] { "--open-main" },
                new[] { "--runtime-root", args[0], "--launcher", Path.Combine(args[0], "PilotMeter.exe") },
                new[] { "--runtime-root", args[0], "--launcher", Path.Combine(args[0], "PilotMeter.exe"), "--data-dir" },
                new[] { "--open-main", "--runtime-root", args[0], "--launcher", Path.Combine(args[0], "PilotMeter.exe"), "--data-dir", args[0] },
                new[] { "--runtime-root", args[0], "--launcher", Path.Combine(args[0], "PilotMeter.exe"), "--data-dir", "relative" },
                new[] { "--runtime-root", args[0], "--launcher", Path.Combine(args[0], "PilotMeter.exe"), "--data-dir", args[0], "--open-main", "true" },
                new[] { "--runtime-root", args[0], "--launcher", Path.Combine(args[0], "PilotMeter.exe"), "--data-dir", args[0], "--open-main", "--open-main" },
                new[] { "--runtime-root", args[0], "--launcher", Path.Combine(args[0], "PilotMeter.exe"), "--data-dir", args[0], "--runtime-root", args[0] },
                new[] { "--runtime-root", args[0], "--launcher", Path.Combine(args[0], "PilotMeter.exe"), "--data-dir", args[0], "--unknown" }
            }) Reject(delegate { DesktopOptions.Parse(malformed); }, "Unknown, duplicate, misplaced, incomplete or relative startup arguments must be rejected.");

            // Use Windows' parser as the oracle, not a second copy of Quote.
            foreach (var argument in new[] { "", "plain", "two words", "中文 目录", "C:\\space folder\\", "a\"b", "a\\\"b", "a\\\\\"b", "\"", "\\", "line\r\nnext", "& | %PATH% ! $ ( ) ` '" })
                ArgumentRoundTrip(argument);

            foreach (var path in new[] { "/api/desktop", "/api/desktop?quotaKey=premium_interactions", "/api/auth/accounts", "/api/auth/login/11111111-1111-4111-8111-111111111111" })
                Check(DesktopNativeApi.Allowed(path, "GET"), "Native reads must use explicit local routes.");
            foreach (var path in new[] { "https://example.com", "/api/shutdown", "//example.com", "/api/desktop?quotaKey=../../secret", "/api/desktop?quotaKey=chat&token=secret", "/api/auth/run-context" })
                Check(!DesktopNativeApi.Allowed(path, "GET") && !DesktopNativeApi.Allowed(path, "POST"), "Unsupported capabilities must be rejected.");
            foreach (var target in new[] { "https://github.com/login/device", "https://example.ghe.com/login/device", "https://a.ghe.com/login/device" })
                Check(DesktopLinks.IsDeviceLogin(target), "Official device login pages must be supported.");
            foreach (var target in new[] { "http://github.com/login/device", "https://github.com.evil/login/device", "https://evil.com/login/device", "https://github.com/login/oauth", "https://github.com:444/login/device", "https://u@github.com/login/device", "https://github.com/login/device?next=evil", "https://github.com/login/device#x", "https://nested.example.ghe.com/login/device", "https://-tenant.ghe.com/login/device", "https://tenant-.ghe.com/login/device", "https://github.com./login/device", "file:///login/device", "", null })
                Check(!DesktopLinks.IsDeviceLogin(target), "Nonofficial or ambiguous authorization links must be rejected.");

            var descriptor = Descriptor();
            var instance = DesktopInstance.FromDescriptor(descriptor);
            Check(instance.Matches(Descriptor()), "Matching daemon identity must be accepted.");
            Check(instance.SameAs(DesktopInstance.FromDescriptor(Descriptor())), "Repeated reads of one daemon must preserve its identity.");
            foreach (var field in new[] { "app", "version", "instanceId" })
            {
                var changed = Descriptor();
                changed[field] = "different";
                Check(!instance.Matches(changed), "Health and widget responses must match every daemon identity field.");
                changed.Remove(field);
                Reject(delegate { instance.Matches(changed); }, "Missing identity fields must be rejected.");
            }
            foreach (var url in new[] { "http://localhost:18181", "http://2130706433:18181", "https://127.0.0.1:18181", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:18181/path", "http://127.0.0.1:18181?query", "http://127.0.0.1:18181#fragment", "http://user@127.0.0.1:18181", "file:///C:/secret" })
            {
                var changed = Descriptor(); changed["url"] = url;
                Reject(delegate { DesktopInstance.FromDescriptor(changed); }, "Descriptors must use a literal loopback HTTP origin.");
            }
            foreach (var field in new[] { "app", "instanceId" })
            {
                var changed = Descriptor(); changed[field] = "invalid";
                Reject(delegate { DesktopInstance.FromDescriptor(changed); }, "Invalid daemon types or instance IDs must be rejected.");
            }
            var restarted = Descriptor(); restarted["instanceId"] = "ee159f20-b60d-4c08-9352-c3c7bce1ab76";
            Check(!instance.SameAs(DesktopInstance.FromDescriptor(restarted)), "A restarted daemon must invalidate the previous native session.");
            var moved = Descriptor(); moved["url"] = "http://127.0.0.1:18182";
            Check(!instance.SameAs(DesktopInstance.FromDescriptor(moved)), "A port change must invalidate the previous native session.");
            var upgraded = Descriptor(); upgraded["version"] = "2.0.0";
            Check(!instance.SameAs(DesktopInstance.FromDescriptor(upgraded)), "A version change must invalidate the previous native session.");
            Check(!instance.SameAs(null), "An absent daemon cannot preserve a session.");

            foreach (var json in new[] { "[]", "null", "{", "{\"x\":" + new string('[', 20) + "0" + new string(']', 20) + "}", new string('x', DesktopJson.MaxLength + 1) })
                Reject(delegate { DesktopJson.Parse(json); }, "Malformed, nonobject, deep or oversized JSON must be rejected.");
            var values = DesktopJson.Parse("{\"missingValue\":null,\"name\":\"abc\",\"numeric\":10}");
            Check(DesktopJson.OptionalString(values, "missingValue", 20) == null, "Unavailable account data must stay absent.");
            Check(DesktopJson.OptionalString(values, "absent", 20) == null, "Omitted optional text must stay absent.");
            Check(DesktopJson.String(values, "name", 3) == "abc", "Text exactly at its bound must remain usable.");
            Reject(delegate { DesktopJson.String(values, "name", 2); }, "Oversized text must be rejected.");
            Reject(delegate { DesktopJson.String(values, "numeric", 20); }, "Numeric data must not silently become account text.");
            Reject(delegate { DesktopJson.String(values, "absent", 20); }, "Required fields cannot be omitted.");
            Reject(delegate { DesktopJson.String(values, "missingValue", 20); }, "Required fields cannot be null.");
            assertions += DesktopApiTests.Run(args[2]).GetAwaiter().GetResult();
            assertions += NativeViewTests.Run();
            assertions += DesktopPetTests.Run(args[0]);
            Console.WriteLine("Desktop contracts passed: " + assertions);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Desktop contract failure: " + error.Message);
            return 1;
        }
    }
}
