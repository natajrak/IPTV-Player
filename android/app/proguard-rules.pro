# Keep JavaScript-facing interfaces (none currently) and WebView plumbing intact.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
