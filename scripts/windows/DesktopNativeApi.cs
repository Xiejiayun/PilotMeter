using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// Native account controls use the same limited CSRF capability as the optional
// browser UI. No daemon management or collector token enters this client.
internal sealed class DesktopNativeApi : IDisposable
{
    private readonly DesktopInstance instance;
    private readonly HttpClient http;
    private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
    private bool disposed;

    internal DesktopNativeApi(DesktopInstance instance)
    {
        if (instance == null) throw new ArgumentNullException("instance");
        this.instance = instance;
        http = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false });
        http.Timeout = TimeSpan.FromSeconds(30);
    }

    internal static bool Allowed(string path, string method)
    {
        if (path == null || method == null) return false;
        if (method == "GET") return path == "/api/auth/accounts" || Regex.IsMatch(path, @"^/api/desktop(?:\?quotaKey=[a-zA-Z][a-zA-Z0-9_-]{0,63})?$")
            || Regex.IsMatch(path, @"^/api/auth/login/[a-f0-9-]{36}$");
        if (method == "POST") return path == "/api/auth/login" || path == "/api/auth/select" || path == "/api/auth/refresh"
            || Regex.IsMatch(path, @"^/api/auth/login/[a-f0-9-]{36}/cancel$");
        return method == "DELETE" && Regex.IsMatch(path, @"^/api/auth/accounts/[a-f0-9-]{36}$");
    }

    internal async Task<Dictionary<string, object>> RequestAsync(string path, string method = "GET", Dictionary<string, object> payload = null)
    {
        if (!Allowed(path, method)) throw new ArgumentException("不支持的桌面操作。");
        if (disposed) throw new ObjectDisposedException("DesktopNativeApi");
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
        {
            timeout.CancelAfter(30000);
            await VerifyAsync(timeout.Token);
            string csrf = null;
            if (method != "GET")
            {
                var session = await SendAsync("/api/session", "GET", null, null, timeout.Token);
                csrf = DesktopJson.String(session, "csrfToken", 64);
                if (!Regex.IsMatch(csrf, "^[a-f0-9]{64}$")) throw new InvalidDataException("本机授权状态无效，请重试。");
            }
            var result = await SendAsync(path, method, payload, csrf, timeout.Token);
            await VerifyAsync(timeout.Token);
            return result;
        }
    }

    private async Task VerifyAsync(CancellationToken cancellation)
    {
        var health = await SendAsync("/health", "GET", null, null, cancellation);
        if (!instance.Matches(health)) throw new InvalidDataException("本机服务已更换，请重新连接。");
    }

    private async Task<Dictionary<string, object>> SendAsync(string path, string method, Dictionary<string, object> payload, string csrf, CancellationToken cancellation)
    {
        using (var request = new HttpRequestMessage(new HttpMethod(method), new Uri(instance.Origin, path)))
        {
            request.Headers.Add("x-pilotmeter-instance", instance.InstanceId);
            if (csrf != null)
            {
                request.Headers.Add("Origin", instance.Origin.GetLeftPart(UriPartial.Authority));
                request.Headers.Add("x-pilotmeter-csrf", csrf);
            }
            if (method == "POST")
            {
                var serializer = new JavaScriptSerializer { MaxJsonLength = DesktopJson.MaxLength, RecursionLimit = 16 };
                request.Content = new StringContent(serializer.Serialize(payload ?? new Dictionary<string, object>()), Encoding.UTF8, "application/json");
            }
            using (var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation))
            using (cancellation.Register(response.Dispose))
            {
                if ((int)response.StatusCode >= 300 && (int)response.StatusCode < 400) throw new InvalidDataException("本机服务返回了不支持的重定向。");
                if (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value > DesktopJson.MaxLength)
                    throw new InvalidDataException("本机服务响应过大。");
                using (var input = await response.Content.ReadAsStreamAsync())
                using (var output = new MemoryStream())
                {
                    var buffer = new byte[4096];
                    int count;
                    while ((count = await input.ReadAsync(buffer, 0, buffer.Length, cancellation)) > 0)
                    {
                        if (output.Length + count > DesktopJson.MaxLength) throw new InvalidDataException("本机服务响应过大。");
                        output.Write(buffer, 0, count);
                    }
                    var result = DesktopJson.Parse(Encoding.UTF8.GetString(output.ToArray()));
                    if (!response.IsSuccessStatusCode)
                    {
                        object message;
                        var description = result.TryGetValue("error", out message) && message is string ? (string)message : "操作暂时无法完成，请重试。";
                        throw new InvalidOperationException(description.Length > 240 ? description.Substring(0, 240) : description);
                    }
                    return result;
                }
            }
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        lifetime.Cancel();
        http.Dispose();
        lifetime.Dispose();
    }
}

internal static class DesktopLinks
{
    internal static bool IsDeviceLogin(string target)
    {
        Uri url;
        return Uri.TryCreate(target, UriKind.Absolute, out url) && url.Scheme == "https" && url.IsDefaultPort
            && String.IsNullOrEmpty(url.UserInfo) && String.IsNullOrEmpty(url.Query) && String.IsNullOrEmpty(url.Fragment)
            && url.AbsolutePath == "/login/device"
            && Regex.IsMatch(url.Host, @"^(?:github\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com)$", RegexOptions.IgnoreCase);
    }
}
