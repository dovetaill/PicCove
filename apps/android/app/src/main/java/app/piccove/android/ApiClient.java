package app.piccove.android;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;

final class ApiClient {
    static final int MAX_IMAGE = 10 * 1024 * 1024;
    final String origin;
    private final CookieManager cookies = new CookieManager(null, CookiePolicy.ACCEPT_ORIGINAL_SERVER);
    ApiClient(String server) { origin = ServerAddress.parse(server, BuildConfig.DEBUG); }

    JSONObject json(String method, String path, JSONObject body) throws Exception {
        byte[] bytes = exchange(method, "/api/v1" + path,
                body == null ? null : body.toString().getBytes(StandardCharsets.UTF_8), "application/json", 2 * 1024 * 1024);
        return bytes.length == 0 ? new JSONObject() : new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    }
    org.json.JSONArray albums() throws Exception {
        return new org.json.JSONArray(new String(exchange("GET", "/api/v1/albums", null, null, 2 * 1024 * 1024), StandardCharsets.UTF_8));
    }
    byte[] image(String id) throws Exception {
        return exchange("GET", "/i/" + UUID.fromString(id), null, null, MAX_IMAGE);
    }
    JSONObject upload(String filename, byte[] image) throws Exception {
        String boundary = "piccove-" + UUID.randomUUID();
        String safe = filename.replaceAll("[\\r\\n\"\\\\]", "_");
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        body.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + safe
                + "\"\r\nContent-Type: application/octet-stream\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        body.write(image);
        body.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        JSONObject result = new JSONObject(new String(exchange("POST", "/api/v1/images?private=true", body.toByteArray(),
                "multipart/form-data; boundary=" + boundary, 2 * 1024 * 1024), StandardCharsets.UTF_8));
        if (!result.has("is_public") || result.getBoolean("is_public")) throw new IOException("服务端未按私有图片保存，请停止上传并检查服务端版本");
        return result;
    }
    void clear() { cookies.getCookieStore().removeAll(); }

    private byte[] exchange(String method, String path, byte[] body, String type, int limit) throws Exception {
        URI uri = URI.create(origin + path);
        HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Origin", origin);
        connection.setRequestProperty("Accept-Encoding", "identity");
        synchronized (cookies) {
            for (Map.Entry<String, List<String>> entry : cookies.get(uri, java.util.Collections.emptyMap()).entrySet())
                connection.setRequestProperty(entry.getKey(), String.join("; ", entry.getValue()));
        }
        try {
            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", type);
                connection.setFixedLengthStreamingMode(body.length);
                try (var stream = connection.getOutputStream()) { stream.write(body); }
            }
            int status = connection.getResponseCode();
            synchronized (cookies) {
                cookies.put(uri, connection.getHeaderFields());
                // Axum uses browser-style cookies; Java's version-1 quoting changes the token.
                for (java.net.HttpCookie cookie : cookies.getCookieStore().getCookies()) cookie.setVersion(0);
            }
            if (status >= 300 && status < 400) throw new IOException("服务端发生跳转，请填写最终 HTTPS 网站地址");
            byte[] result;
            try (InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                result = stream == null ? new byte[0] : readLimited(stream, status >= 400 ? 65536 : limit);
            }
            if (status >= 400) {
                String message = "请求失败（" + status + "）";
                try { message = new JSONObject(new String(result, StandardCharsets.UTF_8)).optString("error", message); }
                catch (Exception ignored) { }
                throw new ApiException(status, message);
            }
            return result;
        } finally { connection.disconnect(); }
    }
    static byte[] readLimited(InputStream stream, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = stream.read(buffer)) != -1) {
            if (output.size() > limit - count) throw new IOException("文件或响应过大；图片最大 10 MiB");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }
    static final class ApiException extends IOException {
        final int status;
        ApiException(int code, String message) { super(message); status = code; }
    }
}
