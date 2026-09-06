using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal sealed class TransportRequest
{
    public int id { get; set; }
    public string api { get; set; }
    public string bodyText { get; set; }
    public string h5st { get; set; }
    public string dsmEid { get; set; }
    public string userAgent { get; set; }
    public string cookie { get; set; }
    public int timeoutMs { get; set; }
}

internal sealed class TransportResponse
{
    public int id { get; set; }
    public bool ok { get; set; }
    public int status { get; set; }
    public string location { get; set; }
    public string body { get; set; }
    public string errorCode { get; set; }
    public string message { get; set; }
}

internal static class ShopSffTransport
{
    private const int MaxInputCharacters = 32 * 1024 * 1024;
    private const int MaxResponseBytes = 20 * 1024 * 1024;
    private const string SffAppId = "3MC69M4R3HFKCQ4S01DN";
    private const string ProductListApi = "dsm.product.manage.ProductInfoReadViewService.queryValidProductList";
    private const string SkuListApi = "dsm.product.manage.SkuInfoReadViewService.querySkuList";
    private const string SelfTestUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer { MaxJsonLength = MaxInputCharacters };

    private static bool IsAllowedApi(string api)
    {
        return String.Equals(api, ProductListApi, StringComparison.Ordinal) ||
               String.Equals(api, SkuListApi, StringComparison.Ordinal);
    }

    private static bool IsAllowedUserAgent(string userAgent)
    {
        if (String.IsNullOrEmpty(userAgent) || userAgent.Length < 32 || userAgent.Length > 512)
            return false;
        if (userAgent.IndexOf('\r') >= 0 || userAgent.IndexOf('\n') >= 0)
            return false;
        if (!userAgent.StartsWith("Mozilla/5.0", StringComparison.Ordinal) ||
            userAgent.IndexOf(" Chrome/", StringComparison.Ordinal) < 0 ||
            userAgent.IndexOf(" Safari/537.36", StringComparison.Ordinal) < 0)
            return false;
        if (userAgent.IndexOf("Electron/", StringComparison.OrdinalIgnoreCase) >= 0 ||
            userAgent.IndexOf("cloud-warehouse-assistant/", StringComparison.OrdinalIgnoreCase) >= 0 ||
            userAgent.IndexOf("ychelper/", StringComparison.OrdinalIgnoreCase) >= 0)
            return false;
        return true;
    }

    private static int NormalizeTimeout(int timeoutMs)
    {
        if (timeoutMs < 1000) return 1000;
        if (timeoutMs > 60000) return 60000;
        return timeoutMs;
    }

    private static byte[] ReadResponseBytes(Stream stream)
    {
        using (var output = new MemoryStream())
        {
            var buffer = new byte[16 * 1024];
            while (true)
            {
                var read = stream.Read(buffer, 0, buffer.Length);
                if (read <= 0) break;
                if (output.Length + read > MaxResponseBytes)
                    throw new InvalidDataException("response_too_large");
                output.Write(buffer, 0, read);
            }
            return output.ToArray();
        }
    }

    private static TransportResponse ReadHttpResponse(int id, HttpWebResponse response)
    {
        using (response)
        using (var stream = response.GetResponseStream())
        {
            var bytes = stream == null ? new byte[0] : ReadResponseBytes(stream);
            return new TransportResponse
            {
                id = id,
                ok = true,
                status = (int)response.StatusCode,
                location = response.Headers[HttpResponseHeader.Location] ?? String.Empty,
                body = Encoding.UTF8.GetString(bytes),
                errorCode = String.Empty,
                message = String.Empty
            };
        }
    }

    private static TransportResponse Execute(TransportRequest input)
    {
        if (input == null || input.id <= 0) throw new InvalidDataException("invalid_request_id");
        if (!IsAllowedApi(input.api)) throw new InvalidDataException("api_not_allowed");
        if (String.IsNullOrEmpty(input.bodyText)) throw new InvalidDataException("body_required");
        if (String.IsNullOrEmpty(input.h5st)) throw new InvalidDataException("h5st_required");
        if (String.IsNullOrEmpty(input.dsmEid)) throw new InvalidDataException("dsm_eid_required");
        if (!IsAllowedUserAgent(input.userAgent)) throw new InvalidDataException("user_agent_required");
        if (String.IsNullOrEmpty(input.cookie) || input.cookie.IndexOf("thor=", StringComparison.Ordinal) < 0)
            throw new InvalidDataException("cookie_required");

        var timeout = NormalizeTimeout(input.timeoutMs);
        var requestUrl = "https://sff.jd.com/api?v=1.0&appId=" +
            Uri.EscapeDataString(SffAppId) + "&api=" + Uri.EscapeDataString(input.api);
        var bodyBytes = Encoding.UTF8.GetBytes(input.bodyText);
        var request = (HttpWebRequest)WebRequest.Create(requestUrl);
        request.Method = "POST";
        request.ProtocolVersion = HttpVersion.Version10;
        request.KeepAlive = true;
        request.Pipelined = false;
        request.Timeout = timeout;
        request.ReadWriteTimeout = timeout;
        request.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8";
        request.UserAgent = input.userAgent;
        request.Headers[HttpRequestHeader.Cookie] = input.cookie;
        request.ContentType = "application/json;charset=UTF-8";
        request.Headers["dsm-platform"] = "pc";
        request.Headers["h5st"] = input.h5st;
        request.Headers["dsm-eid"] = input.dsmEid;
        request.ContentLength = bodyBytes.Length;
        request.ServicePoint.ConnectionLimit = 1;
        request.ServicePoint.MaxIdleTime = 120000;

        try
        {
            using (var requestStream = request.GetRequestStream())
                requestStream.Write(bodyBytes, 0, bodyBytes.Length);
            return ReadHttpResponse(input.id, (HttpWebResponse)request.GetResponse());
        }
        catch (WebException error)
        {
            var httpResponse = error.Response as HttpWebResponse;
            if (httpResponse != null) return ReadHttpResponse(input.id, httpResponse);
            var timeoutFailure = error.Status == WebExceptionStatus.Timeout;
            return new TransportResponse
            {
                id = input.id,
                ok = false,
                status = 0,
                location = String.Empty,
                body = String.Empty,
                errorCode = timeoutFailure ? "request_timeout" : "transport_error",
                message = timeoutFailure ? "shop request timed out" : "shop transport failed"
            };
        }
        catch (InvalidDataException error)
        {
            return new TransportResponse
            {
                id = input.id,
                ok = false,
                status = 0,
                location = String.Empty,
                body = String.Empty,
                errorCode = error.Message == "response_too_large" ? "response_too_large" : "invalid_request",
                message = error.Message == "response_too_large" ? "shop response is too large" : "invalid shop request"
            };
        }
    }

    private static void WriteResponse(TransportResponse response)
    {
        Console.Out.WriteLine(Serializer.Serialize(response));
        Console.Out.Flush();
    }

    private static int RunWorker()
    {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        ServicePointManager.Expect100Continue = false;
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            if (line.Length > MaxInputCharacters)
            {
                WriteResponse(new TransportResponse { id = 0, ok = false, errorCode = "input_too_large", message = "transport input is too large" });
                continue;
            }
            TransportRequest input = null;
            try
            {
                input = Serializer.Deserialize<TransportRequest>(line);
                WriteResponse(Execute(input));
            }
            catch
            {
                WriteResponse(new TransportResponse
                {
                    id = input == null ? 0 : input.id,
                    ok = false,
                    errorCode = "invalid_request",
                    message = "invalid shop request"
                });
            }
        }
        return 0;
    }

    private static string ReadProbeHeaders(NetworkStream stream)
    {
        using (var output = new MemoryStream())
        {
            var matched = 0;
            while (output.Length < 64 * 1024)
            {
                var value = stream.ReadByte();
                if (value < 0) break;
                output.WriteByte((byte)value);
                matched = matched == 0 && value == '\r' ? 1
                    : matched == 1 && value == '\n' ? 2
                    : matched == 2 && value == '\r' ? 3
                    : matched == 3 && value == '\n' ? 4
                    : value == '\r' ? 1 : 0;
                if (matched == 4) break;
            }
            return Encoding.ASCII.GetString(output.ToArray());
        }
    }

    private static int RunSelfTest()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        string rawHeaders = null;
        Exception serverError = null;
        var server = new Thread(delegate()
        {
            try
            {
                using (var client = listener.AcceptTcpClient())
                using (var stream = client.GetStream())
                {
                    rawHeaders = ReadProbeHeaders(stream);
                    var bytes = Encoding.ASCII.GetBytes("HTTP/1.0 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
                    stream.Write(bytes, 0, bytes.Length);
                }
            }
            catch (Exception error) { serverError = error; }
        });
        server.IsBackground = true;
        server.Start();

        var body = Encoding.UTF8.GetBytes("{\"probe\":true}");
        var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api?v=1.0");
        request.Method = "POST";
        request.ProtocolVersion = HttpVersion.Version10;
        request.KeepAlive = true;
        request.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8";
        request.UserAgent = SelfTestUserAgent;
        request.Headers[HttpRequestHeader.Cookie] = "thor=probe; flash=probe";
        request.ContentType = "application/json;charset=UTF-8";
        request.Headers["dsm-platform"] = "pc";
        request.Headers["h5st"] = "probe-signature";
        request.Headers["dsm-eid"] = "probe-eid";
        request.ContentLength = body.Length;
        using (var requestStream = request.GetRequestStream()) requestStream.Write(body, 0, body.Length);
        using (var response = (HttpWebResponse)request.GetResponse()) { }

        server.Join(5000);
        listener.Stop();
        if (serverError != null) throw serverError;
        Console.Out.Write(rawHeaders ?? "NO_REQUEST");
        return 0;
    }

    public static int Main(string[] args)
    {
        return args != null && args.Length == 1 && args[0] == "--self-test" ? RunSelfTest() : RunWorker();
    }
}
