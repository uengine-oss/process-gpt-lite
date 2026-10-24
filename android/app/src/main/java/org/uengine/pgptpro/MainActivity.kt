package org.uengine.pgptpro

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.webkit.CookieManager
import android.webkit.HttpAuthHandler
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

/**
 * pgpt pro's mobile web, full screen, from the server the user chose. The app adds what a browser
 * tab lacks: file upload, mic/camera for voice input, the back button walking the web history,
 * pull to refresh, the server's basic-auth gate answered from settings, and window.AndroidBridge
 * (process-gpt's frontend already asks it for a push token).
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var prefs: Prefs
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermission: PermissionRequest? = null

    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCallback = null
    }
    private val askRuntime = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        val req = pendingPermission ?: return@registerForActivityResult
        pendingPermission = null
        val ok = req.resources.filter { res ->
            when (res) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> granted[Manifest.permission.RECORD_AUDIO] == true || has(Manifest.permission.RECORD_AUDIO)
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> granted[Manifest.permission.CAMERA] == true || has(Manifest.permission.CAMERA)
                else -> false
            }
        }
        if (ok.isEmpty()) req.deny() else req.grant(ok.toTypedArray())
    }

    private fun has(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        if (prefs.serverUrl.isEmpty()) {
            startActivity(Intent(this, SetupActivity::class.java)); finish(); return
        }
        WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            loadWithOverviewMode = true
            useWideViewPort = true
            userAgentString = "$userAgentString pgpt-pro-android/${BuildConfigLite.VERSION}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.addJavascriptInterface(Bridge(), "AndroidBridge")
        web.webViewClient = Client()
        web.webChromeClient = Chrome()

        swipe = SwipeRefreshLayout(this).apply {
            addView(web)
            setOnRefreshListener { web.reload() }
            // only pull to refresh from the very top, so scrolling chat lists still works
            setOnChildScrollUpCallback { _, _ -> web.scrollY > 0 }
        }
        setContentView(swipe)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (web.canGoBack()) web.goBack() else finish() }
        })
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(prefs.serverUrl + "/chat")
    }

    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); if (::web.isInitialized) web.saveState(outState) }
    override fun onPause() { super.onPause(); CookieManager.getInstance().flush() }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val target = request.url
            val home = Uri.parse(prefs.serverUrl)
            // links to other sites (a document link, a YouTube video) open in the browser
            if (target.host != null && target.host != home.host && (target.scheme == "http" || target.scheme == "https")) {
                startActivity(Intent(Intent.ACTION_VIEW, target)); return true
            }
            return false
        }
        override fun onPageFinished(view: WebView, url: String) { swipe.isRefreshing = false }
        override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String, realm: String) {
            if (prefs.authUser.isNotEmpty()) handler.proceed(prefs.authUser, prefs.authPass) else { handler.cancel(); showError("접근 암호가 필요해요. 서버 설정에서 아이디와 암호를 넣어 주세요.") }
        }
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showError("서버에 연결하지 못했어요.\n(${error.description})")
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try { pickFiles.launch(params.createIntent()); true } catch (e: Exception) { fileCallback = null; false }
        }
        override fun onPermissionRequest(request: PermissionRequest) {
            val need = request.resources.mapNotNull {
                when (it) {
                    PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
                    PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
                    else -> null
                }
            }
            runOnUiThread {
                if (need.all { has(it) }) request.grant(request.resources)
                else { pendingPermission = request; askRuntime.launch(need.toTypedArray()) }
            }
        }
    }

    /** window.AndroidBridge — what the web app can ask the app. */
    private inner class Bridge {
        @JavascriptInterface fun getAppVersion(): String = BuildConfigLite.VERSION
        @JavascriptInterface fun getServerUrl(): String = prefs.serverUrl
        /** process-gpt's frontend asks for a push token; empty until FCM is wired in. */
        @JavascriptInterface fun getFcmToken(): String = ""
        @JavascriptInterface fun openSettings() { runOnUiThread { startActivity(Intent(this@MainActivity, SetupActivity::class.java)) } }
    }

    private fun showError(text: String) {
        val dp = resources.displayMetrics.density
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding((28 * dp).toInt(), 0, (28 * dp).toInt(), 0)
            setBackgroundColor(Color.parseColor("#F4F4F1"))
            addView(TextView(context).apply { this.text = text; textSize = 16f; gravity = Gravity.CENTER; setTextColor(Color.parseColor("#3D3D3A")) })
            addView(Button(context).apply { this.text = "다시 시도"; isAllCaps = false; setOnClickListener { setContentView(swipe); web.loadUrl(prefs.serverUrl + "/chat") } })
            addView(Button(context).apply { this.text = getString(R.string.change_server); isAllCaps = false; setOnClickListener { startActivity(Intent(this@MainActivity, SetupActivity::class.java)) } })
        }
        (swipe.parent as? FrameLayout)?.removeView(swipe)
        setContentView(box)
    }
}

/** Version string without enabling the BuildConfig feature. */
object BuildConfigLite { const val VERSION = "0.1.0" }
