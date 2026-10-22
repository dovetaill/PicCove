package app.piccove.android;

import java.net.URI;

final class ServerAddress {
    static String parse(String text, boolean debug) {
        try {
            URI uri = new URI(text.trim());
            String host = uri.getHost();
            boolean local = "127.0.0.1".equals(host) || "localhost".equals(host) || "10.0.2.2".equals(host);
            if (host == null || uri.getUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || !(uri.getPath().isEmpty() || "/".equals(uri.getPath()))
                    || uri.getPort() < -1 || uri.getPort() == 0 || uri.getPort() > 65535
                    || !("https".equals(uri.getScheme()) || (debug && local && "http".equals(uri.getScheme())))) {
                throw new IllegalArgumentException();
            }
            return uri.getScheme() + "://" + uri.getRawAuthority();
        } catch (Exception e) {
            throw new IllegalArgumentException("请输入 HTTPS 网站地址，不含路径、账号或参数");
        }
    }
}
