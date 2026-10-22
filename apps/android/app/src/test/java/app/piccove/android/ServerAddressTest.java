package app.piccove.android;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.IOException;
public class ServerAddressTest {
    @Test public void acceptsOnlyExplicitOrigins() {
        assertEquals("https://photos.example.com", ServerAddress.parse(" https://photos.example.com/ ", false));
        assertEquals("http://127.0.0.1:8080", ServerAddress.parse("http://127.0.0.1:8080", true));
        for (String bad : new String[]{"http://photos.example.com", "https://u:p@photos.example.com", "https://photos.example.com/api", "https://photos.example.com?x=1", "https://photos.example.com:99999", "https://photos.example.com#x", "file:///tmp/a"})
            assertThrows(IllegalArgumentException.class, () -> ServerAddress.parse(bad, true));
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.parse("http://127.0.0.1", false));
    }
    @Test public void boundedReadsRejectOverflow() throws Exception {
        assertArrayEquals(new byte[]{1,2}, ApiClient.readLimited(new ByteArrayInputStream(new byte[]{1,2}), 2));
        assertThrows(IOException.class, () -> ApiClient.readLimited(new ByteArrayInputStream(new byte[]{1,2,3}), 2));
    }
}
