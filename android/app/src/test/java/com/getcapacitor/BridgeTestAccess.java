package com.getcapacitor;

import java.util.List;

/**
 * Test-only accessor for {@link Bridge#getWebViewListeners()}, which is package-private in
 * com.getcapacitor. Lives in that package (test source set only) so a test can reach the
 * listener MainActivity actually registered, rather than re-implementing the call site.
 */
public final class BridgeTestAccess {

    private BridgeTestAccess() {}

    public static List<WebViewListener> webViewListeners(Bridge bridge) {
        return bridge.getWebViewListeners();
    }
}
