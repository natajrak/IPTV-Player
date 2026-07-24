package com.bkl.play;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * BKL Play — single-activity WebView shell that hosts the bundled web player
 * (file:///android_asset/web/index.html).
 *
 * D-pad arrows / center / Enter are delivered into the WebView as normal keydown
 * events, so the web player's existing spatial-focus navigation handles them.
 * The one thing the WebView cannot do on its own is the hardware BACK key, which
 * fires at the Activity level — {@link #onBackPressed()} bridges it into the
 * player's own {@code window.__nativeBack()} (handleTVBack) so BACK closes the
 * player / search / steps up one breadcrumb, and only exits the app at the root.
 */
public class MainActivity extends Activity {

    private WebView webView;

    private FullscreenChromeClient chromeClient;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        setContentView(root);

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF000000);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient());
        chromeClient = new FullscreenChromeClient(this, root, webView);
        webView.setWebChromeClient(chromeClient);

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl("file:///android_asset/web/index.html?app=1");
        }

        // Guarantee D-pad keydowns reach the web player's spatial navigation from a
        // cold start — some TV launchers otherwise leave focus on the root layout.
        webView.setFocusableInTouchMode(true);
        webView.requestFocus();
    }

    @Override
    public void onBackPressed() {
        if (chromeClient != null && chromeClient.isInCustomView()) {
            chromeClient.hideCustomView();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return (window.__nativeBack && window.__nativeBack()) ? '1' : '0';}catch(e){return '0';}})();",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        boolean handled = value != null && value.contains("1");
                        if (!handled) {
                            finish();
                        }
                    }
                });
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.onPause();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            ((ViewGroup) webView.getParent()).removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /**
     * Bridges HTML5 fullscreen video (the player's fullscreen button) to a native
     * full-window view so it fills the screen on TV, and lets BACK exit fullscreen.
     */
    static class FullscreenChromeClient extends WebChromeClient {

        private final Activity activity;
        private final FrameLayout root;
        private final WebView webView;

        private View customView;
        private CustomViewCallback callback;

        FullscreenChromeClient(Activity activity, FrameLayout root, WebView webView) {
            this.activity = activity;
            this.root = root;
            this.webView = webView;
        }

        boolean isInCustomView() {
            return customView != null;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback cb) {
            if (customView != null) {
                cb.onCustomViewHidden();
                return;
            }
            customView = view;
            callback = cb;
            webView.setVisibility(View.GONE);
            root.addView(customView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));
            activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        }

        @Override
        public void onHideCustomView() {
            hideCustomView();
        }

        void hideCustomView() {
            if (customView == null) {
                return;
            }
            root.removeView(customView);
            customView = null;
            webView.setVisibility(View.VISIBLE);
            activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            if (callback != null) {
                callback.onCustomViewHidden();
                callback = null;
            }
        }
    }
}
