package com.sapphi.bmo

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.SurfaceTexture
import android.hardware.Camera
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.ConnectivityManager 
import android.os.BatteryManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Surface
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.io.BufferedReader
import java.io.DataOutputStream
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import java.util.concurrent.TimeUnit
import android.util.Log
import android.media.AudioManager
import com.spotify.android.appremote.api.ConnectionParams
import com.spotify.android.appremote.api.Connector
import com.spotify.android.appremote.api.SpotifyAppRemote


class MainActivity : AppCompatActivity() {

    companion object {

        private const val WAKE_LOG =
            "BMO_WAKE"
        private const val SPOTIFY_LOG =
            "BMO_SPOTIFY"

        private const val SPOTIFY_CLIENT_ID =
            "0791743ce8d541c98ec7f6d5b8629485"

        private const val SPOTIFY_REDIRECT_URI =
            "https://com.sapphi.bmo/callback"

        private const val AUDIO_PERMISSION_REQUEST =
            1001

        private const val CAMERA_PERMISSION_REQUEST =
            1002

        private const val RETRY_DELAY_MS =
            4000L

        private const val WEBVIEW_WATCHDOG_INTERVAL_MS =
            15000L

        private const val WEBVIEW_RECOVERY_COOLDOWN_MS =
            20000L

        private const val BMO_BASE_URL =
            "http://bmo-backend.example:8000"

        private const val BMO_URL =
            "$BMO_BASE_URL/static/face.html?native=1"

        private const val STATUS_URL =
            "$BMO_BASE_URL/api/status"

        private const val CLIENT_ERROR_URL =
            "$BMO_BASE_URL/api/client-error"

        private const val TRANSCRIBE_URL =
            "$BMO_BASE_URL/api/transcribe"

        private const val WAKEWORD_URL =
            "ws://bmo-backend.example:8000/api/wakeword"

        private const val WAKE_SAMPLE_RATE =
            16000

        private const val WAKE_CHUNK_SAMPLES =
            1280

        private const val WAKE_COMMAND_RECORD_MS =
            6000L
    }


    private lateinit var webView: WebView

    private val mainHandler =
        Handler(
            Looper.getMainLooper()
        )


    /*
     * Normal command recording
     */

    private var recorder: MediaRecorder? =
        null

    private var recordingFile: File? =
        null

    private var isRecording =
        false

    private var startAfterPermission =
        false


    /*
     * Native camera / vision state
     */

    private var visionCamera: Camera? =
        null

    private var visionPreviewTexture: SurfaceTexture? =
        null

    private var visionInProgress =
        false

    private var pendingVisionPrompt: String? =
        null


    /*
     * Backend / page state
     */

    private var showingBmoPage =
        false

    private var backendCheckRunning =
        false

    private var bmoPageReady =
        false

    private var lastWebViewRecoveryAt =
        0L


    /*
     * Wake-word audio state
     */

    private var wakeAudioRecord: AudioRecord? =
        null

    // BMO_WAKE_AUDIO_EFFECTS_V2
    private var wakeAcousticEchoCanceler:
        android.media.audiofx.AcousticEchoCanceler? =
        null

    private var wakeNoiseSuppressor:
        android.media.audiofx.NoiseSuppressor? =
        null

    private var wakeAudioThread: Thread? =
        null

    @Volatile
    private var wakeAudioRunning =
        false

    @Volatile
    private var wakeWordTriggered =
        false


    /*
     * Wake-word WebSocket
     */

    private var wakeWebSocket: WebSocket? =
        null

    private var wakeSocketConnected =
        false

    @Volatile
    private var wakeAutoReconnectEnabled =
        false

    private var wakeRearmRunnable: Runnable? =
        null
    /*
     * Spotify App Remote
     */

    private var spotifyAppRemote: SpotifyAppRemote? =
        null

    // BMO_SPOTIFY_LAST_STATE_OUTER_V1
    // Updated by the live App Remote player-state subscription.
    private var spotifyLastKnownPaused:
        Boolean? =
        null

    @Volatile
    private var spotifyConnectInProgress =
        false

    @Volatile
    private var spotifyStateJson =
        JSONObject()
            .put(
                "connected",
                false
            )
            .put(
                "playing",
                false
            )
            .put(
                "paused",
                true
            )
            .put(
                "track",
                JSONObject.NULL
            )
            .put(
                "artist",
                JSONObject.NULL
            )
            .put(
                "album",
                JSONObject.NULL
            )
            .put(
                "uri",
                JSONObject.NULL
            )
            .toString()




    private val wakeHttpClient =
        OkHttpClient
            .Builder()
            .connectTimeout(
                5,
                TimeUnit.SECONDS
            )
            .readTimeout(
                0,
                TimeUnit.MILLISECONDS
            )
            .build()


    private val retryRunnable =
        object : Runnable {

            override fun run() {
                checkBackendAndUpdateUi()
            }
        }


    private val webViewWatchdogRunnable =
        object : Runnable {

            override fun run() {
                runWebViewWatchdog()

                mainHandler.postDelayed(
                    this,
                    WEBVIEW_WATCHDOG_INTERVAL_MS
                )
            }
        }


    private val connectivityReceiver =
        object : BroadcastReceiver() {

            override fun onReceive(
                context: Context?,
                intent: Intent?
            ) {
                Log.i(
                    WAKE_LOG,
                    "Android connectivity changed"
                )

                if (
                    isNetworkConnected()
                ) {
                    Log.i(
                        WAKE_LOG,
                        "Network available; checking BMO backend"
                    )

                    checkBackendAndUpdateUi()

                    if (
                        bmoPageReady &&
                        !isRecording
                    ) {
                        rearmWakeWord(
                            1500L
                        )
                    }

                } else {
                    Log.i(
                        WAKE_LOG,
                        "Network unavailable"
                    )

                    stopWakeWordSystem()
                }
            }
        }

    private val powerReceiver =
        object : BroadcastReceiver() {

            override fun onReceive(
                context: Context?,
                intent: Intent?
            ) {
                val action =
                    intent?.action
                        ?: return

                val charging =
                    when (action) {
                        Intent.ACTION_POWER_CONNECTED ->
                            true

                        Intent.ACTION_POWER_DISCONNECTED ->
                            false

                        else ->
                            return
                    }

                Log.i(
                    WAKE_LOG,
                    "BMO power state changed: charging=$charging"
                )

                notifyJavascriptPowerStateChanged(
                    charging
                )
            }
        }

    override fun onCreate(
        savedInstanceState: Bundle?
    ) {
        super.onCreate(
            savedInstanceState
        )

        Log.i(
            WAKE_LOG,
            "MainActivity onCreate"
        )

        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        )

        hideSystemUI()

        setContentView(
            R.layout.activity_main
        )

        webView =
            findViewById(
                R.id.webView
            )

        setupWebView()

        webView.clearCache(
            true
        )

        showConnectingPage()

        checkBackendAndUpdateUi()

        mainHandler.removeCallbacks(
            webViewWatchdogRunnable
        )

        mainHandler.postDelayed(
            webViewWatchdogRunnable,
            WEBVIEW_WATCHDOG_INTERVAL_MS
        )
    }
    /*
     * =====================================================================
     * Diagnostics error forwarding
     * =====================================================================
     *
     * Logcat remains Android's complete native log.
     *
     * Only important failures are forwarded to the Mac so the rotating
     * BMO log and hidden developer panel can show them too.
     *
     * Reporting is deliberately fire-and-forget. Diagnostics must never
     * make the Android app depend on the Mac being reachable.
     */

    private fun reportAndroidError(
        message: String,
        detail: String? = null,
        url: String? = null
    ) {
        Thread {
            var connection:
                HttpURLConnection? =
                null

            try {
                connection =
                    URL(
                        CLIENT_ERROR_URL
                    ).openConnection()
                        as HttpURLConnection

                connection.requestMethod =
                    "POST"

                connection.connectTimeout =
                    2000

                connection.readTimeout =
                    2000

                connection.doOutput =
                    true

                connection.setRequestProperty(
                    "Content-Type",
                    "application/json"
                )

                val payload =
                    JSONObject().apply {
                        put(
                            "source",
                            "android"
                        )

                        put(
                            "message",
                            message.take(
                                1000
                            )
                        )

                        if (
                            !detail.isNullOrBlank()
                        ) {
                            put(
                                "detail",
                                detail.take(
                                    4000
                                )
                            )
                        }

                        if (
                            !url.isNullOrBlank()
                        ) {
                            put(
                                "url",
                                url.take(
                                    1000
                                )
                            )
                        }
                    }

                connection.outputStream.use {
                    output ->
                    output.write(
                        payload
                            .toString()
                            .toByteArray(
                                Charsets.UTF_8
                            )
                    )
                }

                connection.responseCode

            } catch (
                exception: Exception
            ) {
                Log.d(
                    WAKE_LOG,
                    "Could not forward Android error: " +
                        exception.message
                )

            } finally {
                connection?.disconnect()
            }
        }.start()
    }

    private fun setupWebView() {
        WebView.setWebContentsDebuggingEnabled(
            true
        )

        webView.webViewClient =
            object : WebViewClient() {

                override fun onPageFinished(
                    view: WebView?,
                    url: String?
                ) {
                    super.onPageFinished(
                        view,
                        url
                    )

                    Log.i(
                        WAKE_LOG,
                        "WebView finished: $url"
                    )

                    if (
                        url?.startsWith(
                            BMO_BASE_URL
                        ) == true
                    ) {
                        showingBmoPage =
                            true

                        bmoPageReady =
                            true

                        Log.i(
                            WAKE_LOG,
                            "Remote BMO page reported finished"
                        )
}
                }


                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?
                ) {
                    super.onReceivedError(
                        view,
                        request,
                        error
                    )

                    if (
                        request?.isForMainFrame ==
                        true
                    ) {
                        Log.e(
                            WAKE_LOG,
                            "Main WebView load failed: ${error?.description}"
                        )

                        
                        reportAndroidError(
                            message =
                                "Main WebView load failed",

                            detail =
                                error
                                    ?.description
                                    ?.toString(),

                            url =
                                request
                                    ?.url
                                    ?.toString()
                        )
showingBmoPage =
                            false

                        bmoPageReady =
                            false

                        checkBackendAndUpdateUi()
                    }
                }


                override fun onReceivedHttpError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    errorResponse:
                        android.webkit.WebResourceResponse?
                ) {
                    super.onReceivedHttpError(
                        view,
                        request,
                        errorResponse
                    )

                    if (
                        request?.isForMainFrame ==
                        true
                    ) {
                        val statusCode =
                            errorResponse
                                ?.statusCode

                        val reason =
                            errorResponse
                                ?.reasonPhrase

                        val detail =
                            buildString {
                                append(
                                    "HTTP "
                                )

                                append(
                                    statusCode
                                        ?: "unknown"
                                )

                                if (
                                    !reason.isNullOrBlank()
                                ) {
                                    append(
                                        " "
                                    )

                                    append(
                                        reason
                                    )
                                }
                            }

                        Log.e(
                            WAKE_LOG,
                            "Main WebView HTTP failure: $detail"
                        )

                        reportAndroidError(
                            message =
                                "Main WebView HTTP failure",

                            detail =
                                detail,

                            url =
                                request
                                    ?.url
                                    ?.toString()
                        )

                        showingBmoPage =
                            false

                        bmoPageReady =
                            false

                        checkBackendAndUpdateUi()
                    }
                }


                override fun onRenderProcessGone(
                    view: WebView?,
                    detail:
                        android.webkit.RenderProcessGoneDetail?
                ): Boolean {
                    val crashed =
                        detail?.didCrash()
                            ?: false

                    val message =
                        if (
                            crashed
                        ) {
                            "WebView renderer crashed"
                        } else {
                            "WebView renderer terminated"
                        }

                    Log.e(
                        WAKE_LOG,
                        message
                    )

                    reportAndroidError(
                        message =
                            message,

                        detail =
                            "didCrash=$crashed",

                        url =
                            view?.url
                    )

                    showingBmoPage =
                        false

                    bmoPageReady =
                        false

                    /*
                     * The old WebView renderer is dead and cannot safely
                     * continue. Recreating the Activity gives BMO a fresh
                     * WebView while keeping recovery inside the app.
                     */
                    mainHandler.post {
                        try {
                            recreate()

                        } catch (
                            exception: Exception
                        ) {
                            Log.e(
                                WAKE_LOG,
                                "Could not recreate Activity after renderer loss",
                                exception
                            )

                            reportAndroidError(
                                message =
                                    "Renderer recovery failed",

                                detail =
                                    exception
                                        .stackTraceToString()
                            )
                        }
                    }

                    /*
                     * We handled the lost renderer ourselves.
                     */
                    return true
                }



            }

        webView.settings.apply {
            javaScriptEnabled =
                true

            domStorageEnabled =
                true

            mediaPlaybackRequiresUserGesture =
                false

            cacheMode =
                WebSettings.LOAD_NO_CACHE

            useWideViewPort =
                true

            loadWithOverviewMode =
                true

            allowFileAccess =
                false

            allowContentAccess =
                true

            setSupportZoom(
                false
            )

            builtInZoomControls =
                false

            displayZoomControls =
                false
        }

        webView.setBackgroundColor(
            android.graphics.Color.rgb(
                189,
                255,
                203
            )
        )

        webView.addJavascriptInterface(
            BMOBridge(),
            "AndroidBMO"
        )
    }


    /*
     * =====================================================================
     * Backend startup / reconnect
     * =====================================================================
     */

    private fun checkBackendAndUpdateUi() {
        if (
            backendCheckRunning
        ) {
            return
        }

        backendCheckRunning =
            true

        mainHandler.removeCallbacks(
            retryRunnable
        )

        Thread {
            val online =
                isBackendOnline()

            runOnUiThread {
                backendCheckRunning =
                    false

                if (
                    online
                ) {
                    showBmoPage()

                } else {
                    stopWakeWordSystem()

                    showOfflinePage()

                    mainHandler.postDelayed(
                        retryRunnable,
                        RETRY_DELAY_MS
                    )
                }
            }
        }.start()
    }


    private fun isBackendOnline(): Boolean {
        var connection:
                HttpURLConnection? =
            null

        return try {
            connection =
                URL(
                    STATUS_URL
                ).openConnection()
                        as HttpURLConnection

            connection.requestMethod =
                "GET"

            connection.connectTimeout =
                2500

            connection.readTimeout =
                2500

            connection.useCaches =
                false

            connection.setRequestProperty(
                "Cache-Control",
                "no-cache"
            )

            val responseCode =
                connection.responseCode

            responseCode in
                    200..299

        } catch (
            _: Exception
        ) {
            false

        } finally {
            connection
                ?.disconnect()
        }
    }


    private fun showBmoPage() {
        mainHandler.removeCallbacks(
            retryRunnable
        )

        if (
            showingBmoPage &&
            webView.url
                ?.startsWith(
                    BMO_BASE_URL
                ) == true
        ) {
            if (
                !wakeAudioRunning &&
                !isRecording
            ) {
                rearmWakeWord(
                    750L
                )
            }

            return
        }

        showingBmoPage =
            true

        bmoPageReady =
            true

        Log.i(
            WAKE_LOG,
            "Backend online; loading BMO page"
        )

        webView.loadUrl(
            BMO_URL
        )

        mainHandler.postDelayed(
            {
                Log.i(
                    WAKE_LOG,
                    "Starting wake system after backend check"
                )

                startWakeWordSystem()
            },
            750L
        )
    }


    private fun forceReloadBmoPage(
        reason: String
    ) {
        val now =
            System.currentTimeMillis()

        if (
            now -
            lastWebViewRecoveryAt <
            WEBVIEW_RECOVERY_COOLDOWN_MS
        ) {
            return
        }

        lastWebViewRecoveryAt =
            now

        Log.w(
            WAKE_LOG,
            "Reloading BMO WebView: $reason"
        )

        stopWakeWordSystem()

        showingBmoPage =
            true

        bmoPageReady =
            true

        webView.stopLoading()

        webView.clearCache(
            true
        )

        webView.loadUrl(
            "$BMO_URL&recovery=$now"
        )

        mainHandler.postDelayed(
            {
                if (
                    bmoPageReady &&
                    !isRecording
                ) {
                    rearmWakeWord(
                        500L
                    )
                }
            },
            1500L
        )
    }


    private fun runWebViewWatchdog() {
        if (
            isRecording ||
            visionInProgress
        ) {
            return
        }

        Thread {
            val backendOnline =
                isBackendOnline()

            runOnUiThread {
                if (
                    !backendOnline
                ) {
                    return@runOnUiThread
                }

                val currentUrl =
                    webView.url
                        ?: ""

                if (
                    !showingBmoPage ||
                    !bmoPageReady ||
                    !currentUrl.startsWith(
                        BMO_BASE_URL
                    )
                ) {
                    forceReloadBmoPage(
                        "watchdog found stale/non-BMO page"
                    )
                }
            }
        }.start()
    }


    private fun showConnectingPage() {
        stopWakeWordSystem()

        showingBmoPage =
            false

        bmoPageReady =
            false

        val html =
            """
            <!doctype html>
            <html>
            <head>
                <meta
                    name="viewport"
                    content="width=device-width, initial-scale=1"
                >
                <style>
                    html,
                    body {
                        width: 100%;
                        height: 100%;
                        margin: 0;
                        overflow: hidden;
                        background: #bdffcb;
                        color: #000000;
                        font-family: sans-serif;
                    }

                    body {
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        text-align: center;
                    }

                    .face {
                        font-family: monospace;
                        font-size: 72px;
                        margin-bottom: 22px;
                    }

                    .message {
                        font-size: 28px;
                        font-weight: 600;
                    }
                </style>
            </head>

            <body>
                <div>
                    <div class="face">
                        â€¢ _ â€¢
                    </div>

                    <div class="message">
                        Waking up BMO...
                    </div>
                </div>
            </body>
            </html>
            """.trimIndent()

        webView.loadDataWithBaseURL(
            null,
            html,
            "text/html",
            "UTF-8",
            null
        )
    }


    private fun showOfflinePage() {
        stopWakeWordSystem()

        showingBmoPage =
            false

        bmoPageReady =
            false

        val html =
            """
            <!doctype html>
            <html>
            <head>
                <meta
                    name="viewport"
                    content="width=device-width, initial-scale=1"
                >
                <style>
                    html,
                    body {
                        width: 100%;
                        height: 100%;
                        margin: 0;
                        overflow: hidden;
                        background: #bdffcb;
                        color: #000000;
                        font-family: sans-serif;
                    }

                    body {
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        text-align: center;
                    }

                    .face {
                        font-family: monospace;
                        font-size: 72px;
                        margin-bottom: 22px;
                    }

                    .message {
                        font-size: 28px;
                        font-weight: 600;
                    }

                    .small {
                        margin-top: 12px;
                        font-size: 18px;
                        opacity: 0.7;
                    }
                </style>
            </head>

            <body>
                <div>
                    <div class="face">
                        â€¢ _ â€¢
                    </div>

                    <div class="message">
                        BMO's brain is offline
                    </div>

                    <div class="small">
                        Trying to reconnect...
                    </div>
                </div>
            </body>
            </html>
            """.trimIndent()

        webView.loadDataWithBaseURL(
            null,
            html,
            "text/html",
            "UTF-8",
            null
        )
    }


    /*
     * =====================================================================
     * Wake word
     * =====================================================================
     */

    private fun startWakeWordSystem() {
        Log.i(
            WAKE_LOG,
            "startWakeWordSystem called: pageReady=$bmoPageReady isRecording=$isRecording wakeAudioRunning=$wakeAudioRunning"
        )

        if (
            !bmoPageReady ||
            isRecording ||
            wakeAudioRunning
        ) {
            Log.i(
                WAKE_LOG,
                "Wake system not started because state is not ready"
            )
            return
        }

        if (
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.RECORD_AUDIO
            ) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            Log.i(
                WAKE_LOG,
                "Microphone permission missing"
            )

            return
        }

        wakeWordTriggered =
            false

        wakeAutoReconnectEnabled =
            true

        Log.i(
            WAKE_LOG,
            "Starting websocket connection"
        )

        connectWakeWebSocket()
    }


    private fun connectWakeWebSocket() {
        Log.i(
            WAKE_LOG,
            "connectWakeWebSocket called"
        )

        if (
            wakeWebSocket != null
        ) {
            return
        }

        Log.i(
            WAKE_LOG,
            "Connecting to $WAKEWORD_URL"
        )

        val request =
            Request
                .Builder()
                .url(
                    WAKEWORD_URL
                )
                .build()

        wakeWebSocket =
            wakeHttpClient.newWebSocket(
                request,
                object :
                    WebSocketListener() {

                    override fun onOpen(
                        webSocket: WebSocket,
                        response: Response
                    ) {
                        if (
                            wakeWebSocket !==
                            webSocket
                        ) {
                            return
                        }

                        Log.i(
                            WAKE_LOG,
                            "WebSocket OPEN"
                        )

                        wakeSocketConnected =
                            true

                        runOnUiThread {
                            startWakeAudioCapture()
                        }
                    }


                    override fun onMessage(
                        webSocket: WebSocket,
                        text: String
                    ) {
                        if (
                            wakeWebSocket ===
                            webSocket
                        ) {
                            handleWakeSocketMessage(
                                text
                            )
                        }
                    }


                    override fun onClosing(
                        webSocket: WebSocket,
                        code: Int,
                        reason: String
                    ) {
                        if (
                            wakeWebSocket !==
                            webSocket
                        ) {
                            return
                        }

                        wakeSocketConnected =
                            false

                        webSocket.close(
                            code,
                            reason
                        )
                    }


                    override fun onClosed(
                        webSocket: WebSocket,
                        code: Int,
                        reason: String
                    ) {
                        if (
                            wakeWebSocket !==
                            webSocket
                        ) {
                            return
                        }

                        Log.i(
                            WAKE_LOG,
                            "WebSocket CLOSED: code=$code reason=$reason"
                        )

                        wakeSocketConnected =
                            false

                        wakeWebSocket =
                            null

                        stopWakeAudioCapture()

                        if (
                            wakeAutoReconnectEnabled &&
                            bmoPageReady &&
                            !isRecording
                        ) {
                            Log.i(
                                WAKE_LOG,
                                "Wake socket closed unexpectedly; scheduling reconnect"
                            )

                            rearmWakeWord(
                                3000L
                            )
                        }
                    }


                    override fun onFailure(
                        webSocket: WebSocket,
                        throwable: Throwable,
                        response: Response?
                    ) {
                        if (
                            wakeWebSocket !==
                            webSocket
                        ) {
                            return
                        }

                        Log.e(
                            WAKE_LOG,
                            "WebSocket FAILED",
                            throwable
                        )

                        wakeSocketConnected =
                            false

                        wakeWebSocket =
                            null

                        stopWakeAudioCapture()

                        if (
                            wakeAutoReconnectEnabled &&
                            bmoPageReady &&
                            !isRecording
                        ) {
                            Log.i(
                                WAKE_LOG,
                                "Wake socket failure; scheduling reconnect"
                            )

                            rearmWakeWord(
                                3000L
                            )
                        }
                    }
                }
            )
    }


    private fun startWakeAudioCapture() {
        Log.i(
            WAKE_LOG,
            "startWakeAudioCapture called"
        )

        if (
            wakeAudioRunning ||
            isRecording ||
            !wakeSocketConnected
        ) {
            return
        }

        if (
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.RECORD_AUDIO
            ) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }

        val minimumBuffer =
            AudioRecord.getMinBufferSize(
                WAKE_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )

        if (
            minimumBuffer <= 0
        ) {
            return
        }

        val bufferBytes =
            maxOf(
                minimumBuffer,
                WAKE_CHUNK_SAMPLES *
                        2 *
                        4
            )

        try {
            @Suppress(
                "MissingPermission"
            )
            wakeAudioRecord =
                AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    WAKE_SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufferBytes
                )

            if (
                wakeAudioRecord
                    ?.state !=
                AudioRecord.STATE_INITIALIZED
            ) {
                Log.e(
                    WAKE_LOG,
                    "AudioRecord failed to initialize"
                )

                stopWakeAudioCapture()

                return
            }

            Log.i(
                WAKE_LOG,
                "AudioRecord initialized"
            )

            
            val wakeAudioSessionId =
                wakeAudioRecord
                    ?.audioSessionId

            Log.i(
                WAKE_LOG,
                "Wake audio session ID: $wakeAudioSessionId"
            )

            Log.i(
                WAKE_LOG,
                "Acoustic echo cancellation available: " +
                    android.media.audiofx.AcousticEchoCanceler.isAvailable()
            )

            if (
                wakeAudioSessionId != null &&
                android.media.audiofx.AcousticEchoCanceler.isAvailable()
            ) {
                try {
                    wakeAcousticEchoCanceler =
                        android.media.audiofx.AcousticEchoCanceler.create(
                            wakeAudioSessionId
                        )

                    if (
                        wakeAcousticEchoCanceler != null
                    ) {
                        wakeAcousticEchoCanceler
                            ?.enabled =
                            true

                        Log.i(
                            WAKE_LOG,
                            "AEC created; enabled=" +
                                wakeAcousticEchoCanceler?.enabled
                        )
                    } else {
                        Log.w(
                            WAKE_LOG,
                            "AEC reported available but create() returned null"
                        )
                    }

                } catch (
                    exception: Exception
                ) {
                    Log.e(
                        WAKE_LOG,
                        "Failed to enable acoustic echo cancellation",
                        exception
                    )
                }
            }

            Log.i(
                WAKE_LOG,
                "Noise suppression available: " +
                    android.media.audiofx.NoiseSuppressor.isAvailable()
            )

            if (
                wakeAudioSessionId != null &&
                android.media.audiofx.NoiseSuppressor.isAvailable()
            ) {
                try {
                    wakeNoiseSuppressor =
                        android.media.audiofx.NoiseSuppressor.create(
                            wakeAudioSessionId
                        )

                    if (
                        wakeNoiseSuppressor != null
                    ) {
                        wakeNoiseSuppressor
                            ?.enabled =
                            true

                        Log.i(
                            WAKE_LOG,
                            "Noise suppressor created; enabled=" +
                                wakeNoiseSuppressor?.enabled
                        )
                    } else {
                        Log.w(
                            WAKE_LOG,
                            "Noise suppression reported available but create() returned null"
                        )
                    }

                } catch (
                    exception: Exception
                ) {
                    Log.e(
                        WAKE_LOG,
                        "Failed to enable noise suppression",
                        exception
                    )
                }
            }

            wakeAudioRecord
                ?.startRecording()

            Log.i(
                WAKE_LOG,
                "AudioRecord started"
            )

            wakeAudioRunning =
                true

            wakeAudioThread =
                Thread {
                    wakeAudioLoop()
                }.apply {
                    name =
                        "BMO-WakeWord-Audio"

                    start()
                }

        } catch (
            exception: Exception
        ) {
            Log.e(
                WAKE_LOG,
                "AudioRecord startup failed",
                exception
            )

            stopWakeAudioCapture()

            rearmWakeWord(
                2000L
            )
        }
    }


    private fun wakeAudioLoop() {
        Log.i(
            WAKE_LOG,
            "Wake audio loop started"
        )

        var firstChunkLogged =
            false

        val samples =
            ShortArray(
                WAKE_CHUNK_SAMPLES
            )

        while (
            wakeAudioRunning
        ) {
            val audioRecord =
                wakeAudioRecord
                    ?: break

            val samplesRead =
                try {
                    audioRecord.read(
                        samples,
                        0,
                        samples.size
                    )

                } catch (
                    _: Exception
                ) {
                    break
                }

            if (
                samplesRead <= 0
            ) {
                continue
            }

            if (
                !firstChunkLogged
            ) {
                firstChunkLogged =
                    true

                Log.i(
                    WAKE_LOG,
                    "First PCM chunk captured: $samplesRead samples"
                )
            }

            val bytes =
                ByteBuffer
                    .allocate(
                        WAKE_CHUNK_SAMPLES *
                                2
                    )
                    .order(
                        ByteOrder.LITTLE_ENDIAN
                    )

            for (
            index in
            0 until
                    WAKE_CHUNK_SAMPLES
            ) {
                val sample =
                    if (
                        index <
                        samplesRead
                    ) {
                        samples[index]

                    } else {
                        0
                    }

                bytes.putShort(
                    sample
                )
            }

            val socket =
                wakeWebSocket

            if (
                socket == null ||
                !wakeSocketConnected
            ) {
                break
            }

            val sent =
                socket.send(
                    ByteString.of(
                        *bytes.array()
                    )
                )

            if (
                !sent
            ) {
                break
            }
        }

        wakeAudioRunning =
            false
    }


    private fun handleWakeSocketMessage(
        message: String
    ) {
        try {
            val json =
                JSONObject(
                    message
                )

            if (
                json.optString(
                    "event"
                ) ==
                "wakeword_detected"
            ) {
                handleWakeWordDetected(
                    json.optString(
                        "model"
                    )
                )
            }

        } catch (
            exception: Exception
        ) {
            Log.e(
                WAKE_LOG,
                "Wake socket message parse failed",
                exception
            )
        }
    }


    private fun handleWakeWordDetected(
        model: String
    ) {
        if (
            wakeWordTriggered
        ) {
            Log.i(
                WAKE_LOG,
                "Wake detection ignored because previous wake is still active"
            )

            return
        }

        wakeWordTriggered =
            true

        Log.i(
            WAKE_LOG,
            "Wake word detected on Android: $model"
        )

        stopWakeWordSystem()

        runOnUiThread {
            // BMO_WAKE_EARLY_DUCK_V1
            /*
             * Automatic wake-word recording bypasses face.js startRecording(),
             * so request media ducking here before command recording begins.
             */
            evaluateJavascript(
                """
                if (
                    typeof beginVoiceInteractionDucking ===
                    "function"
                ) {
                    beginVoiceInteractionDucking();
                }
                """.trimIndent()
            )

            Log.i(
                "BMO_AUDIO",
                "Requested early media duck after wake detection"
            )
            val modelText =
                JSONObject.quote(
                    model
                )

            evaluateJavascript(
                """
                console.log(
                    "Wake word detected: " +
                    $modelText
                );

                if (
                    typeof setFaceState ===
                    "function"
                ) {
                    setFaceState(
                        "listening"
                    );
                }

                if (
                    typeof showStatus ===
                    "function"
                ) {
                    showStatus(
                        "Listening...",
                        0
                    );
                }
                """.trimIndent()
            )

            Log.i(
                WAKE_LOG,
                "Starting automatic command recording"
            )

            startNativeRecording()

            if (
                !isRecording
            ) {
                Log.e(
                    WAKE_LOG,
                    "Automatic command recording failed to start"
                )

                rearmWakeWord(
                    1000L
                )

                return@runOnUiThread
            }

            mainHandler.postDelayed(
                {
                    if (
                        isRecording
                    ) {
                        Log.i(
                            WAKE_LOG,
                            "Automatic command recording complete; submitting"
                        )

                        stopNativeRecording()
                    }
                },
                WAKE_COMMAND_RECORD_MS
            )
        }
    }


    private fun rearmWakeWord(
        delayMs: Long = 1000L
    ) {
        wakeWordTriggered =
            false

        wakeRearmRunnable
            ?.let {
                mainHandler.removeCallbacks(
                    it
                )
            }

        val runnable =
            Runnable {
                wakeRearmRunnable =
                    null

                if (
                    bmoPageReady &&
                    !isRecording
                ) {
                    Log.i(
                        WAKE_LOG,
                        "Rearming wake word listener"
                    )

                    startWakeWordSystem()

                } else {
                    Log.i(
                        WAKE_LOG,
                        "Wake rearm skipped: pageReady=$bmoPageReady isRecording=$isRecording"
                    )
                }
            }

        wakeRearmRunnable =
            runnable

        Log.i(
            WAKE_LOG,
            "Scheduling wake-word rearm in ${delayMs}ms"
        )

        mainHandler.postDelayed(
            runnable,
            delayMs
        )
    }


    private fun stopWakeAudioCapture() {
        wakeAudioRunning =
            false

        try {
            wakeAudioRecord
                ?.stop()

        } catch (
            _: Exception
        ) {
        }

        try {
            wakeAudioRecord
                ?.release()

        } catch (
            _: Exception
        ) {
        }

        
        try {
            wakeAcousticEchoCanceler
                ?.release()
        } catch (
            _: Exception
        ) {
        }

        wakeAcousticEchoCanceler =
            null

        try {
            wakeNoiseSuppressor
                ?.release()
        } catch (
            _: Exception
        ) {
        }

        wakeNoiseSuppressor =
            null

        wakeAudioRecord =
            null

        wakeAudioThread =
            null
    }


    private fun stopWakeWordSystem() {
        wakeAutoReconnectEnabled =
            false

        wakeRearmRunnable
            ?.let {
                mainHandler.removeCallbacks(
                    it
                )
            }

        wakeRearmRunnable =
            null

        stopWakeAudioCapture()

        wakeSocketConnected =
            false

        val socket =
            wakeWebSocket

        wakeWebSocket =
            null

        try {
            socket?.close(
                1000,
                "Wake listener stopping"
            )

        } catch (
            _: Exception
        ) {
        }
    }


    /*
     * =====================================================================
     * Native Android device state
     * =====================================================================
     */

    private fun getBatteryStateJson(): String {
        val batteryIntent =
            registerReceiver(
                null,
                IntentFilter(
                    Intent.ACTION_BATTERY_CHANGED
                )
            )

        if (
            batteryIntent == null
        ) {
            return JSONObject()
                .put(
                    "available",
                    false
                )
                .put(
                    "battery_percent",
                    JSONObject.NULL
                )
                .put(
                    "charging",
                    JSONObject.NULL
                )
                .toString()
        }

        val level =
            batteryIntent.getIntExtra(
                BatteryManager.EXTRA_LEVEL,
                -1
            )

        val scale =
            batteryIntent.getIntExtra(
                BatteryManager.EXTRA_SCALE,
                -1
            )

        val status =
            batteryIntent.getIntExtra(
                BatteryManager.EXTRA_STATUS,
                BatteryManager.BATTERY_STATUS_UNKNOWN
            )

        val batteryPercent =
            if (
                level >= 0 &&
                scale > 0
            ) {
                (
                        level *
                                100f /
                                scale
                        ).toInt()

            } else {
                -1
            }

        val charging =
            status ==
                    BatteryManager.BATTERY_STATUS_CHARGING ||
                    status ==
                    BatteryManager.BATTERY_STATUS_FULL

        return JSONObject()
            .put(
                "available",
                batteryPercent >= 0
            )
            .put(
                "battery_percent",
                if (
                    batteryPercent >= 0
                ) {
                    batteryPercent
                } else {
                    JSONObject.NULL
                }
            )
            .put(
                "charging",
                charging
            )
            .toString()
    }


    private fun isNetworkConnected(): Boolean {
        val connectivityManager =
            getSystemService(
                CONNECTIVITY_SERVICE
            ) as ConnectivityManager

        @Suppress(
            "DEPRECATION"
        )
        val networkInfo =
            connectivityManager.activeNetworkInfo

        return networkInfo !=
                null &&
                networkInfo.isConnected
    }


    private fun getNetworkStateJson(): String {
        val connectivityManager =
            getSystemService(
                CONNECTIVITY_SERVICE
            ) as ConnectivityManager

        @Suppress(
            "DEPRECATION"
        )
        val networkInfo =
            connectivityManager.activeNetworkInfo

        if (
            networkInfo == null ||
            !networkInfo.isConnected
        ) {
            return JSONObject()
                .put(
                    "available",
                    true
                )
                .put(
                    "connected",
                    false
                )
                .put(
                    "network_type",
                    "none"
                )
                .toString()
        }

        @Suppress(
            "DEPRECATION"
        )
        val networkType =
            when (
                networkInfo.type
            ) {
                ConnectivityManager.TYPE_WIFI ->
                    "wifi"

                ConnectivityManager.TYPE_MOBILE ->
                    "mobile"

                ConnectivityManager.TYPE_ETHERNET ->
                    "ethernet"

                else ->
                    "other"
            }

        return JSONObject()
            .put(
                "available",
                true
            )
            .put(
                "connected",
                true
            )
            .put(
                "network_type",
                networkType
            )
            .toString()
    }


    /*
     * =====================================================================
     * JavaScript bridge
     * =====================================================================
     */
    /*
     * =====================================================================
     * Spotify App Remote
     * =====================================================================
     */
    // BMO_SPOTIFY_FALLBACK_V1
    //
    // Disconnected is its own state. Do not preserve stale "playing"
    // information after App Remote disappears.
    //
    // A play request made while disconnected can be retried once after
    // a successful App Remote reconnection.
    private var pendingSpotifyPlayUri: String? = null

    private fun markSpotifyDisconnectedState() {
        spotifyLastKnownPaused =
            null

        spotifyStateJson =
            JSONObject()
                .put(
                    "connected",
                    false
                )
                .put(
                    "playing",
                    false
                )
                .put(
                    "paused",
                    false
                )
                .put(
                    "track",
                    JSONObject.NULL
                )
                .put(
                    "artist",
                    JSONObject.NULL
                )
                .put(
                    "album",
                    JSONObject.NULL
                )
                .put(
                    "uri",
                    JSONObject.NULL
                )                // BMO_SPOTIFY_PROGRESS_V1
                .put(
                    "position_ms",
                    JSONObject.NULL
                )
                .put(
                    "duration_ms",
                    JSONObject.NULL
                )
                .toString()

        Log.i(
            SPOTIFY_LOG,
            "Spotify state marked disconnected"
        )
    }

    private fun playSpotifyUri(
        appRemote: SpotifyAppRemote,
        uri: String
    ) {
        Log.i(
            SPOTIFY_LOG,
            "Play requested: $uri"
        )

        appRemote
            .playerApi
            .play(
                uri
            )
            .setResultCallback {
                Log.i(
                    SPOTIFY_LOG,
                    "Play command accepted: $uri"
                )
            }
            .setErrorCallback { throwable ->
                Log.e(
                    SPOTIFY_LOG,
                    "Play command failed: ${throwable.message}",
                    throwable
                )

                notifyJavascriptSpotifyUnavailable()
            }
    }


    private fun subscribeToSpotifyPlayerState(
        appRemote: SpotifyAppRemote
    ) {
        Log.i(
            SPOTIFY_LOG,
            "Subscribing to Spotify player state"
        )

        appRemote
            .playerApi
            .subscribeToPlayerState()
            .setEventCallback { playerState ->

                val track =
                    playerState.track

                val playing =
                    !playerState.isPaused

                spotifyStateJson =
                    JSONObject()
                        .put(
                            "connected",
                            true
                        )
                        .put(
                            "playing",
                            playing
                        )
                        .put(
                            "paused",
                            playerState.isPaused
                        )
                        .put(
                            "track",
                            track.name
                        )
                        .put(
                            "artist",
                            track.artist.name
                        )
                        .put(
                            "album",
                            track.album.name
                        )
                        .put(
                            "uri",
                            track.uri
                        )                        .put(
                            "position_ms",
                            playerState.playbackPosition
                        )
                        .put(
                            "duration_ms",
                            track.duration
                        )
                        .toString()

                spotifyLastKnownPaused =
                    playerState.isPaused
                Log.i(
                    SPOTIFY_LOG,
                    "Player state: " +
                            "${track.name} | " +
                            "${track.artist.name} | " +
                            "paused=${playerState.isPaused} | " +
                            "${track.uri}"
                )
            }
            .setErrorCallback { throwable ->
                Log.e(
                    SPOTIFY_LOG,
                    "Player-state subscription failed: ${throwable.message}",
                    throwable
                )

                spotifyAppRemote =
                    null

                spotifyConnectInProgress =
                    false

                markSpotifyDisconnectedState()
            }
    }


    private fun connectSpotify() {
        if (
            spotifyAppRemote != null
        ) {
            Log.i(
                SPOTIFY_LOG,
                "Already connected"
            )

            return
        }

        if (
            spotifyConnectInProgress
        ) {
            Log.i(
                SPOTIFY_LOG,
                "Connection already in progress"
            )

            return
        }

        val connectionParams =
            ConnectionParams
                .Builder(
                    SPOTIFY_CLIENT_ID
                )
                .setRedirectUri(
                    SPOTIFY_REDIRECT_URI
                )
                .showAuthView(
                    true
                )
                .build()

        spotifyConnectInProgress =
            true

        Log.i(
            SPOTIFY_LOG,
            "Connecting to Spotify App Remote"
        )

        SpotifyAppRemote.connect(
            this,
            connectionParams,
            object :
                Connector.ConnectionListener {

                override fun onConnected(
                    appRemote: SpotifyAppRemote
                ) {
                    spotifyConnectInProgress =
                        false

                    spotifyAppRemote =
                        appRemote

                    subscribeToSpotifyPlayerState(
                        appRemote
                    )

                    Log.i(
                        SPOTIFY_LOG,
                        "Connected"
                    )

                    val pendingUri =
                        pendingSpotifyPlayUri

                    pendingSpotifyPlayUri =
                        null

                    if (
                        pendingUri != null
                    ) {
                        Log.i(
                            SPOTIFY_LOG,
                            "Retrying pending play request after reconnect: $pendingUri"
                        )

                        playSpotifyUri(
                            appRemote,
                            pendingUri
                        )
                    }
                }


                override fun onFailure(
                    throwable: Throwable
                ) {
                    spotifyConnectInProgress =
                        false

                    spotifyAppRemote =
                        null

                    pendingSpotifyPlayUri =
                        null

                    markSpotifyDisconnectedState()

                    Log.e(
                        SPOTIFY_LOG,
                        "Connection failed: ${throwable.javaClass.simpleName}: ${throwable.message}",
                        throwable
                    )

                    notifyJavascriptSpotifyUnavailable()
                }
            }
        )
    }


    private fun disconnectSpotify() {
        pendingSpotifyPlayUri =
            null

        markSpotifyDisconnectedState()

        val appRemote =
            spotifyAppRemote
                ?: return

        spotifyAppRemote =
            null

        spotifyConnectInProgress =
            false

        try {
            SpotifyAppRemote.disconnect(
                appRemote
            )

            Log.i(
                SPOTIFY_LOG,
                "Disconnected"
            )

        } catch (
            exception: Exception
        ) {
            Log.e(
                SPOTIFY_LOG,
                "Disconnect failed",
                exception
            )
        }
    }
    inner class BMOBridge {

        /*
         * Harmless diagnostics test hook.
         *
         * This performs no device action. It only verifies the
         * Android -> Mac diagnostics pipeline.
         */
        @JavascriptInterface
        fun reportDiagnosticTest(
            message: String
        ) {
            reportAndroidError(
                message =
                    "Android diagnostics test",

                detail =
                    message
            )
        }

        @JavascriptInterface
        fun spotifyConnect() {
            runOnUiThread {
                connectSpotify()
            }
        }


        @JavascriptInterface
        fun spotifyDisconnect() {
            runOnUiThread {
                disconnectSpotify()
            }

        @JavascriptInterface
        fun spotifyTestPlay() {
            runOnUiThread {
                val appRemote =
                    spotifyAppRemote

                if (
                    appRemote == null
                ) {
                    Log.e(
                        SPOTIFY_LOG,
                        "Cannot play test track: Spotify is not connected"
                    )

                    connectSpotify()

                    return@runOnUiThread
                }
            }
        }
        }


    // BMO_VOICE_DUCKING_V1
    //
    // Android owns media-volume ducking because Android owns the speaker.
    // The WebView only tells us when a voice interaction starts and ends.
    //
    // If the user manually changes media volume while BMO is ducking it,
    // we deliberately do NOT restore the previous volume afterward.
    private var voiceInteractionOriginalMusicVolume: Int? = null
    private var voiceInteractionDuckedMusicVolume: Int? = null

    // BMO_SPOTIFY_VOICE_RESUME_V1
    //
// Snapshot taken when a BMO voice interaction begins.
    private var voiceInteractionSpotifyWasPlaying =
        false

    // True when BMO itself receives an explicit Spotify pause command.
    private var voiceInteractionSpotifyExplicitPause =
        false

    @android.webkit.JavascriptInterface
    fun beginVoiceInteraction() {
        runOnUiThread {
            if (voiceInteractionOriginalMusicVolume != null) {
                android.util.Log.d(
                    "BMO_AUDIO",
                    "Voice interaction already ducked; ignoring duplicate begin"
                )
                return@runOnUiThread
            }

            voiceInteractionSpotifyWasPlaying =
                spotifyAppRemote != null &&
                    spotifyLastKnownPaused == false

            voiceInteractionSpotifyExplicitPause =
                false

            Log.i(
                "BMO_AUDIO",
                "Spotify before voice interaction: " +
                    "wasPlaying=$voiceInteractionSpotifyWasPlaying " +
                    "lastKnownPaused=$spotifyLastKnownPaused"
            )
            val audioManager =
                getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager

            val stream = android.media.AudioManager.STREAM_MUSIC
            val currentVolume = audioManager.getStreamVolume(stream)

            val minimumVolume =
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                    audioManager.getStreamMinVolume(stream)
                } else {
                    0
                }

            val duckedVolume =
                if (currentVolume <= minimumVolume) {
                    currentVolume
                } else {
                    val calculated = (currentVolume * 0.25f).toInt()
                    calculated.coerceIn(
                        (minimumVolume + 1).coerceAtMost(currentVolume),
                        currentVolume
                    )
                }

            voiceInteractionOriginalMusicVolume = currentVolume
            voiceInteractionDuckedMusicVolume = duckedVolume

            if (duckedVolume != currentVolume) {
                audioManager.setStreamVolume(
                    stream,
                    duckedVolume,
                    0
                )
            }

            android.util.Log.i(
                "BMO_AUDIO",
                "Voice interaction began: media volume $currentVolume -> $duckedVolume"
            )
        }
    }

        private fun finishSpotifyVoiceInteraction() {
        val shouldResumeSpotify =
            voiceInteractionSpotifyWasPlaying &&
                !voiceInteractionSpotifyExplicitPause

        Log.i(
            "BMO_AUDIO",
            "Spotify voice interaction ending: " +
                "wasPlaying=$voiceInteractionSpotifyWasPlaying " +
                "explicitPause=$voiceInteractionSpotifyExplicitPause " +
                "lastKnownPaused=$spotifyLastKnownPaused " +
                "shouldResume=$shouldResumeSpotify"
        )

        voiceInteractionSpotifyWasPlaying =
            false

        voiceInteractionSpotifyExplicitPause =
            false

        if (
            !shouldResumeSpotify
        ) {
            return
        }

        /*
         * Chromium may still own audio focus for a moment after its
         * speech Audio element ends. Give Android time to return that
         * focus before asking Spotify to resume.
         */
        mainHandler.postDelayed(
            {
                val appRemote =
                    spotifyAppRemote

                if (
                    appRemote == null
                ) {
                    Log.i(
                        "BMO_AUDIO",
                        "Spotify not resumed after voice interaction: disconnected"
                    )

                    return@postDelayed
                }

                if (
                    spotifyLastKnownPaused != true
                ) {
                    Log.i(
                        "BMO_AUDIO",
                        "Spotify resume not needed after voice interaction; " +
                            "player is already playing"
                    )

                    return@postDelayed
                }

                Log.i(
                    "BMO_AUDIO",
                    "Resuming Spotify after BMO released audio focus"
                )

                try {
                    appRemote
                        .playerApi
                        .resume()

                } catch (
                    exception: Exception
                ) {
                    Log.e(
                        "BMO_AUDIO",
                        "Could not resume Spotify after voice interaction",
                        exception
                    )
                }
            },
            500L
        )
    }

    // BMO_RESTORE_AFTER_LISTENING_V1
    //
    // Restore normal media volume after microphone capture finishes,
    // but keep the overall voice interaction alive so Spotify's
    // post-speech resume logic still runs later.
    @android.webkit.JavascriptInterface
    fun restoreVoiceInteractionVolume() {
        runOnUiThread {
            val originalVolume =
                voiceInteractionOriginalMusicVolume
                    ?: return@runOnUiThread

            val duckedVolume =
                voiceInteractionDuckedMusicVolume
                    ?: return@runOnUiThread

            val audioManager =
                getSystemService(
                    android.content.Context.AUDIO_SERVICE
                ) as android.media.AudioManager

            val stream =
                android.media.AudioManager.STREAM_MUSIC

            val currentVolume =
                audioManager.getStreamVolume(
                    stream
                )

            if (
                currentVolume == duckedVolume
            ) {
                audioManager.setStreamVolume(
                    stream,
                    originalVolume,
                    0
                )

                Log.i(
                    "BMO_AUDIO",
                    "Listening finished: media volume $currentVolume -> $originalVolume"
                )
            } else {
                Log.i(
                    "BMO_AUDIO",
                    "Listening finished, but media volume changed manually; leaving it untouched"
                )
            }

            /*
             * Deliberately do NOT clear the saved interaction state.
             * endVoiceInteraction() still needs it later for Spotify
             * pause/resume handling.
             */
        }
    }

@android.webkit.JavascriptInterface
    fun endVoiceInteraction() {
        runOnUiThread {
            val originalVolume = voiceInteractionOriginalMusicVolume
                ?: run {
                    android.util.Log.d(
                        "BMO_AUDIO",
                        "Voice interaction was not ducked; ignoring end"
                    )
                    return@runOnUiThread
                }

            val duckedVolume = voiceInteractionDuckedMusicVolume

            val audioManager =
                getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager

            val stream = android.media.AudioManager.STREAM_MUSIC
            val currentVolume = audioManager.getStreamVolume(stream)

            if (duckedVolume != null && currentVolume == duckedVolume) {
                audioManager.setStreamVolume(
                    stream,
                    originalVolume,
                    0
                )

                android.util.Log.i(
                    "BMO_AUDIO",
                    "Voice interaction ended: media volume $currentVolume -> $originalVolume"
                )
            } else {
                android.util.Log.i(
                    "BMO_AUDIO",
                    "Media volume changed during interaction ($duckedVolume -> $currentVolume); " +
                        "leaving user's current volume untouched"
                )
            }

            finishSpotifyVoiceInteraction()
            voiceInteractionOriginalMusicVolume = null
            voiceInteractionDuckedMusicVolume = null
        }
    }
        @JavascriptInterface
        fun isSpotifyConnected(): Boolean {
            return spotifyAppRemote != null
        }
        @JavascriptInterface
        fun spotifyPlay(
            uri: String
        ) {
            runOnUiThread {
                val appRemote =
                    spotifyAppRemote

                if (
                    appRemote == null
                ) {
                    Log.i(
                        SPOTIFY_LOG,
                        "Play requested while Spotify is disconnected; reconnecting"
                    )

                    pendingSpotifyPlayUri =
                        uri

                    markSpotifyDisconnectedState()

                    connectSpotify()

                    return@runOnUiThread
                }

                playSpotifyUri(
                    appRemote,
                    uri
                )
            }
        }


        // BMO_SPOTIFY_POLISH_V1
        @JavascriptInterface
        fun spotifySetShuffle(
            enabled: Boolean
        ) {
            runOnUiThread {
                val appRemote =
                    spotifyAppRemote

                if (
                    appRemote == null
                ) {
                    Log.e(
                        SPOTIFY_LOG,
                        "Shuffle requested while Spotify is disconnected"
                    )

                    notifyJavascriptSpotifyUnavailable()

                    return@runOnUiThread
                }

                Log.i(
                    SPOTIFY_LOG,
                    "Setting Spotify shuffle: $enabled"
                )

                appRemote
                    .playerApi
                    .setShuffle(
                        enabled
                    )
                    .setResultCallback {
                        Log.i(
                            SPOTIFY_LOG,
                            "Spotify shuffle set: $enabled"
                        )
                    }
                    .setErrorCallback { throwable ->
                        Log.e(
                            SPOTIFY_LOG,
                            "Spotify shuffle failed: ${throwable.message}",
                            throwable
                        )

                        notifyJavascriptSpotifyUnavailable()
                    }
            }
        }


        @JavascriptInterface
        fun spotifySetRepeat(
            mode: String
        ) {
            runOnUiThread {
                val appRemote =
                    spotifyAppRemote

                if (
                    appRemote == null
                ) {
                    Log.e(
                        SPOTIFY_LOG,
                        "Repeat requested while Spotify is disconnected"
                    )

                    notifyJavascriptSpotifyUnavailable()

                    return@runOnUiThread
                }

                val repeatMode =
                    when (
                        mode
                            .trim()
                            .lowercase()
                    ) {
                        "off" ->
                            com.spotify.protocol.types.Repeat.OFF

                        "one" ->
                            com.spotify.protocol.types.Repeat.ONE

                        else ->
                            com.spotify.protocol.types.Repeat.ALL
                    }

                Log.i(
                    SPOTIFY_LOG,
                    "Setting Spotify repeat: $mode ($repeatMode)"
                )

                appRemote
                    .playerApi
                    .setRepeat(
                        repeatMode
                    )
                    .setResultCallback {
                        Log.i(
                            SPOTIFY_LOG,
                            "Spotify repeat set: $mode"
                        )
                    }
                    .setErrorCallback { throwable ->
                        Log.e(
                            SPOTIFY_LOG,
                            "Spotify repeat failed: ${throwable.message}",
                            throwable
                        )

                        notifyJavascriptSpotifyUnavailable()
                    }
            }
        }

        @JavascriptInterface
        fun spotifyPause() {
            runOnUiThread {
                if (
                    voiceInteractionOriginalMusicVolume != null
                ) {
                    voiceInteractionSpotifyExplicitPause =
                        true

                    Log.i(
                        "BMO_AUDIO",
                        "Spotify pause marked explicit during voice interaction"
                    )
                }

                val appRemote =
                    spotifyAppRemote

                if (
                    appRemote == null
                ) {
                    Log.e(
                        SPOTIFY_LOG,
                        "Pause requested while Spotify is disconnected"
                    )

                    return@runOnUiThread
                }

                appRemote
                    .playerApi
                    .pause()
                    .setResultCallback {
                        Log.i(
                            SPOTIFY_LOG,
                            "Pause command accepted"
                        )
                    }
                    .setErrorCallback { throwable ->
                        Log.e(
                            SPOTIFY_LOG,
                            "Pause command failed: ${throwable.message}",
                            throwable
                        )
                    }
            }
        }


        @JavascriptInterface
        fun spotifyResume() {
            runOnUiThread {
                val appRemote =
                    spotifyAppRemote

                if (
                    appRemote == null
                ) {
                    Log.e(
                        SPOTIFY_LOG,
                        "Resume requested while Spotify is disconnected"
                    )

                    return@runOnUiThread
                }

                appRemote
                    .playerApi
                    .resume()
                    .setResultCallback {
                        Log.i(
                            SPOTIFY_LOG,
                            "Resume command accepted"
                        )
                    }
                    .setErrorCallback { throwable ->
                        Log.e(
                            SPOTIFY_LOG,
                            "Resume command failed: ${throwable.message}",
                            throwable
                        )
                    }
            }
        }


        @JavascriptInterface
        fun spotifyNext() {
            runOnUiThread {
                val appRemote =
                    spotifyAppRemote

                if (
                    appRemote == null
                ) {
                    Log.e(
                        SPOTIFY_LOG,
                        "Next requested while Spotify is disconnected"
                    )

                    return@runOnUiThread
                }

                appRemote
                    .playerApi
                    .skipNext()
                    .setResultCallback {
                        Log.i(
                            SPOTIFY_LOG,
                            "Next command accepted"
                        )
                    }
                    .setErrorCallback { throwable ->
                        Log.e(
                            SPOTIFY_LOG,
                            "Next command failed: ${throwable.message}",
                            throwable
                        )
                    }
            }
        }


        @JavascriptInterface
        fun spotifyPrevious() {
            runOnUiThread {
                val appRemote =
                    spotifyAppRemote

                if (
                    appRemote == null
                ) {
                    Log.e(
                        SPOTIFY_LOG,
                        "Previous requested while Spotify is disconnected"
                    )

                    return@runOnUiThread
                }

                appRemote
                    .playerApi
                    .skipPrevious()
                    .setResultCallback {
                        Log.i(
                            SPOTIFY_LOG,
                            "Previous command accepted"
                        )
                    }
                    .setErrorCallback { throwable ->
                        Log.e(
                            SPOTIFY_LOG,
                            "Previous command failed: ${throwable.message}",
                            throwable
                        )
                    }
            }
        }
        @JavascriptInterface
        fun getSpotifyState(): String {
            val audioManager =
                getSystemService(
                    Context.AUDIO_SERVICE
                ) as AudioManager

            val localAudioActive =
                audioManager.isMusicActive

            return try {
                JSONObject(
                    spotifyStateJson
                )
                    .put(
                        "local_audio_active",
                        localAudioActive
                    )
                    .toString()

            } catch (
                exception: Exception
            ) {
                Log.w(
                    SPOTIFY_LOG,
                    "Could not add local audio state to Spotify snapshot",
                    exception
                )

                spotifyStateJson
            }
        }




        @JavascriptInterface
        fun startRecording() {
            runOnUiThread {
                stopWakeWordSystem()

                startNativeRecording()
            }
        }

        @JavascriptInterface
        fun getMediaVolume(): Int {
            val audioManager =
                getSystemService(
                    Context.AUDIO_SERVICE
                ) as AudioManager

            val current =
                audioManager.getStreamVolume(
                    AudioManager.STREAM_MUSIC
                )

            val max =
                audioManager.getStreamMaxVolume(
                    AudioManager.STREAM_MUSIC
                )

            if (max <= 0) {
                return 0
            }

            return (
                    current *
                            100f /
                            max
                    ).toInt()
        }


        @JavascriptInterface
        fun setMediaVolume(
            percent: Int
        ) {
            val audioManager =
                getSystemService(
                    Context.AUDIO_SERVICE
                ) as AudioManager

            val max =
                audioManager.getStreamMaxVolume(
                    AudioManager.STREAM_MUSIC
                )

            val safePercent =
                percent.coerceIn(
                    0,
                    100
                )

            val targetVolume =
                (
                        max *
                                (
                                        safePercent /
                                                100f
                                        )
                        ).toInt()

            runOnUiThread {
                audioManager.setStreamVolume(
                    AudioManager.STREAM_MUSIC,
                    targetVolume,
                    0
                )
            }

            Log.i(
                WAKE_LOG,
                "BMO media volume set to $safePercent%"
            )
        }

        @JavascriptInterface
        fun stopRecording() {
            runOnUiThread {
                stopNativeRecording()
            }
        }


        @JavascriptInterface
        fun getBatteryState(): String {
            return getBatteryStateJson()
        }


        @JavascriptInterface
        fun getNetworkState(): String {
            return getNetworkStateJson()
        }


        @JavascriptInterface
        fun captureImage(
            prompt: String
        ) {
            runOnUiThread {
                startNativeVisionCapture(
                    prompt
                )
            }
        }
    }


    /*
     * =====================================================================
     * Native front camera / vision
     * =====================================================================
     */

    private fun getFrontCameraId(): Int {
        val info =
            Camera.CameraInfo()

        for (
        cameraId in
        0 until Camera.getNumberOfCameras()
        ) {
            Camera.getCameraInfo(
                cameraId,
                info
            )

            if (
                info.facing ==
                Camera.CameraInfo.CAMERA_FACING_FRONT
            ) {
                return cameraId
            }
        }

        return 0
    }


    private fun getCameraJpegRotation(
        cameraId: Int
    ): Int {
        val info =
            Camera.CameraInfo()

        Camera.getCameraInfo(
            cameraId,
            info
        )

        @Suppress(
            "DEPRECATION"
        )
        val displayRotation =
            windowManager
                .defaultDisplay
                .rotation

        val degrees =
            when (
                displayRotation
            ) {
                Surface.ROTATION_90 ->
                    90

                Surface.ROTATION_180 ->
                    180

                Surface.ROTATION_270 ->
                    270

                else ->
                    0
            }

        return (
                info.orientation -
                        degrees +
                        360
                ) % 360
    }


    private fun startNativeVisionCapture(
        prompt: String
    ) {
        if (
            visionInProgress
        ) {
            return
        }

        if (
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.CAMERA
            ) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            pendingVisionPrompt =
                prompt

            ActivityCompat.requestPermissions(
                this,
                arrayOf(
                    Manifest.permission.CAMERA
                ),
                CAMERA_PERMISSION_REQUEST
            )

            return
        }

        visionInProgress =
            true

        pendingVisionPrompt =
            null

        stopWakeWordSystem()

        notifyJavascriptVisionStarted()

        Log.i(
            WAKE_LOG,
            "Opening front camera for BMO vision"
        )

        try {
            val cameraId =
                getFrontCameraId()

            val camera =
                Camera.open(
                    cameraId
                )

            visionCamera =
                camera

            val parameters =
                camera.parameters

            val sizes =
                parameters.supportedPictureSizes

            val preferredSize =
                sizes
                    ?.filter {
                        it.width <= 1920 &&
                                it.height <= 1440
                    }
                    ?.maxByOrNull {
                        it.width * it.height
                    }
                    ?: sizes
                        ?.maxByOrNull {
                            it.width * it.height
                        }

            if (
                preferredSize != null
            ) {
                parameters.setPictureSize(
                    preferredSize.width,
                    preferredSize.height
                )
            }

            parameters.jpegQuality =
                85

            parameters.setRotation(
                getCameraJpegRotation(
                    cameraId
                )
            )

            camera.parameters =
                parameters

            visionPreviewTexture =
                SurfaceTexture(
                    10
                )

            camera.setPreviewTexture(
                visionPreviewTexture
            )

            camera.startPreview()

            mainHandler.postDelayed(
                {
                    val activeCamera =
                        visionCamera

                    if (
                        activeCamera == null ||
                        !visionInProgress
                    ) {
                        return@postDelayed
                    }

                    try {
                        activeCamera.autoFocus {
                                _,
                                focusedCamera ->

                            takeVisionPicture(
                                focusedCamera,
                                prompt
                            )
                        }

                    } catch (
                        _: Exception
                    ) {
                        takeVisionPicture(
                            activeCamera,
                            prompt
                        )
                    }
                },
                700L
            )

        } catch (
            exception: Exception
        ) {
            Log.e(
                WAKE_LOG,
                "Camera capture failed to start",
                exception
            )

            releaseVisionCamera()

            visionInProgress =
                false

            notifyJavascriptVisionError(
                "Camera failed to start"
            )

            rearmWakeWord(
                1500L
            )
        }
    }


    private fun takeVisionPicture(
        camera: Camera,
        prompt: String
    ) {
        try {
            camera.takePicture(
                null,
                null,
                Camera.PictureCallback {
                        data,
                        _ ->

                    Log.i(
                        WAKE_LOG,
                        "Camera image captured: ${data.size} bytes"
                    )
                    notifyJavascriptVisionCaptured(
                        data
                    )

                    releaseVisionCamera()

                    uploadVisionImage(
                        data,
                        prompt
                    )
                }
            )

        } catch (
            exception: Exception
        ) {
            Log.e(
                WAKE_LOG,
                "takePicture failed",
                exception
            )

            releaseVisionCamera()

            visionInProgress =
                false

            notifyJavascriptVisionError(
                "Camera capture failed"
            )

            rearmWakeWord(
                1500L
            )
        }
    }


    private fun releaseVisionCamera() {
        try {
            visionCamera
                ?.stopPreview()

        } catch (
            _: Exception
        ) {
        }

        try {
            visionCamera
                ?.release()

        } catch (
            _: Exception
        ) {
        }

        visionCamera =
            null

        try {
            visionPreviewTexture
                ?.release()

        } catch (
            _: Exception
        ) {
        }

        visionPreviewTexture =
            null
    }


    private fun uploadVisionImage(
        jpegData: ByteArray,
        prompt: String
    ) {
        Thread {
            try {
                val responseText =
                    postImageForVision(
                        jpegData,
                        prompt
                    )

                runOnUiThread {
                    visionInProgress =
                        false

                    notifyJavascriptVisionResponse(
                        responseText
                    )

                    rearmWakeWord(
                        1500L
                    )
                }

            } catch (
                exception: Exception
            ) {
                Log.e(
                    WAKE_LOG,
                    "Vision upload failed",
                    exception
                )

                runOnUiThread {
                    visionInProgress =
                        false

                    notifyJavascriptVisionError(
                        "Vision analysis failed"
                    )

                    rearmWakeWord(
                        2000L
                    )
                }
            }
        }.start()
    }


    private fun postImageForVision(
        jpegData: ByteArray,
        prompt: String
    ): String {
        val boundary =
            "----BMOVision${UUID.randomUUID()}"

        val connection =
            URL(
                "$BMO_BASE_URL/api/vision"
            ).openConnection()
                    as HttpURLConnection

        connection.requestMethod =
            "POST"

        connection.doInput =
            true

        connection.doOutput =
            true

        connection.connectTimeout =
            30000

        connection.readTimeout =
            180000

        connection.setRequestProperty(
            "Content-Type",
            "multipart/form-data; boundary=$boundary"
        )

        DataOutputStream(
            connection.outputStream
        ).use { output ->
            output.writeBytes(
                "--$boundary\r\n"
            )

            output.writeBytes(
                "Content-Disposition: form-data; " +
                        "name=\"prompt\"\r\n\r\n"
            )

            output.write(
                prompt.toByteArray(
                    Charsets.UTF_8
                )
            )

            output.writeBytes(
                "\r\n"
            )

            output.writeBytes(
                "--$boundary\r\n"
            )

            output.writeBytes(
                "Content-Disposition: form-data; " +
                        "name=\"image\"; " +
                        "filename=\"bmo-camera.jpg\"\r\n"
            )

            output.writeBytes(
                "Content-Type: image/jpeg\r\n\r\n"
            )

            output.write(
                jpegData
            )

            output.writeBytes(
                "\r\n--$boundary--\r\n"
            )

            output.flush()
        }

        val responseCode =
            connection.responseCode

        val responseStream =
            if (
                responseCode in 200..299
            ) {
                connection.inputStream

            } else {
                connection.errorStream
            }

        val responseText =
            BufferedReader(
                InputStreamReader(
                    responseStream
                )
            ).use { reader ->
                reader.readText()
            }

        connection.disconnect()

        if (
            responseCode !in 200..299
        ) {
            throw RuntimeException(
                "Vision HTTP " +
                        "$responseCode: " +
                        responseText
            )
        }

        return responseText
    }


    /*
     * =====================================================================
     * Normal command microphone
     * =====================================================================
     */

    private fun startNativeRecording() {
        if (
            isRecording
        ) {
            return
        }

        val microphoneGranted =
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.RECORD_AUDIO
            ) ==
                    PackageManager.PERMISSION_GRANTED

        if (
            !microphoneGranted
        ) {
            startAfterPermission =
                true

            ActivityCompat.requestPermissions(
                this,
                arrayOf(
                    Manifest.permission.RECORD_AUDIO
                ),
                AUDIO_PERMISSION_REQUEST
            )

            return
        }

        try {
            recordingFile =
                File.createTempFile(
                    "bmo_recording_",
                    ".m4a",
                    cacheDir
                )

            @Suppress(
                "DEPRECATION"
            )
            recorder =
                MediaRecorder().apply {

                    setAudioSource(
                        MediaRecorder.AudioSource.MIC
                    )

                    setOutputFormat(
                        MediaRecorder.OutputFormat.MPEG_4
                    )

                    setAudioEncoder(
                        MediaRecorder.AudioEncoder.AAC
                    )

                    setAudioEncodingBitRate(
                        128000
                    )

                    setAudioSamplingRate(
                        44100
                    )

                    setOutputFile(
                        recordingFile!!
                            .absolutePath
                    )

                    prepare()

                    start()
                }

            isRecording =
                true

            notifyJavascriptRecordingStarted()

        } catch (
            exception: Exception
        ) {
            Log.e(
                WAKE_LOG,
                "Microphone failed to start",
                exception
            )

            cleanupRecorder()

            notifyJavascriptError(
                "Microphone failed to start"
            )

            rearmWakeWord(
                1000L
            )
        }
    }


    private fun stopNativeRecording() {
        if (
            !isRecording
        ) {
            return
        }

        isRecording =
            false

        try {
            recorder
                ?.stop()

        } catch (
            exception: RuntimeException
        ) {
            Log.e(
                WAKE_LOG,
                "Recording was too short",
                exception
            )

            recordingFile
                ?.delete()

            cleanupRecorder()

            notifyJavascriptError(
                "Recording was too short"
            )

            rearmWakeWord(
                1000L
            )

            return
        }

        cleanupRecorder()

        val file =
            recordingFile

        if (
            file == null ||
            !file.exists() ||
            file.length() == 0L
        ) {
            notifyJavascriptError(
                "No microphone audio was recorded"
            )

            rearmWakeWord(
                1000L
            )

            return
        }

        notifyJavascriptThinking()

        uploadRecording(
            file
        )
    }


    private fun cleanupRecorder() {
        try {
            recorder
                ?.reset()

        } catch (
            _: Exception
        ) {
        }

        try {
            recorder
                ?.release()

        } catch (
            _: Exception
        ) {
        }

        recorder =
            null
    }


    /*
     * =====================================================================
     * STT upload
     * =====================================================================
     */

    private fun uploadRecording(
        file: File
    ) {
        Thread {
            try {
                val transcript =
                    postAudioForTranscription(
                        file
                    )

                file.delete()

                if (
                    transcript.isBlank()
                ) {
                    runOnUiThread {
                        notifyJavascriptNoSpeech()

                        rearmWakeWord(
                            1000L
                        )
                    }

                    return@Thread
                }

                runOnUiThread {
                    notifyJavascriptTranscript(
                        transcript
                    )

                    rearmWakeWord(
                        1500L
                    )
                }

            } catch (
                exception: Exception
            ) {
                Log.e(
                    WAKE_LOG,
                    "Transcription failed",
                    exception
                )

                file.delete()

                runOnUiThread {
                    notifyJavascriptError(
                        "Transcription failed"
                    )

                    rearmWakeWord(
                        2000L
                    )
                }
            }
        }.start()
    }


    private fun postAudioForTranscription(
        file: File
    ): String {

        val boundary =
            "----BMO${UUID.randomUUID()}"

        val connection =
            URL(
                TRANSCRIBE_URL
            ).openConnection()
                    as HttpURLConnection

        connection.requestMethod =
            "POST"

        connection.doInput =
            true

        connection.doOutput =
            true

        connection.connectTimeout =
            30000

        connection.readTimeout =
            120000

        connection.setRequestProperty(
            "Content-Type",
            "multipart/form-data; boundary=$boundary"
        )

        DataOutputStream(
            connection.outputStream
        ).use { output ->

            output.writeBytes(
                "--$boundary\r\n"
            )

            output.writeBytes(
                "Content-Disposition: form-data; " +
                        "name=\"audio\"; " +
                        "filename=\"bmo-recording.m4a\"\r\n"
            )

            output.writeBytes(
                "Content-Type: audio/mp4\r\n\r\n"
            )

            file.inputStream()
                .use { input ->

                    val buffer =
                        ByteArray(
                            8192
                        )

                    while (
                        true
                    ) {
                        val bytesRead =
                            input.read(
                                buffer
                            )

                        if (
                            bytesRead ==
                            -1
                        ) {
                            break
                        }

                        output.write(
                            buffer,
                            0,
                            bytesRead
                        )
                    }
                }

            output.writeBytes(
                "\r\n--$boundary--\r\n"
            )

            output.flush()
        }

        val responseCode =
            connection.responseCode

        val responseStream =
            if (
                responseCode in
                200..299
            ) {
                connection.inputStream

            } else {
                connection.errorStream
            }

        val responseText =
            BufferedReader(
                InputStreamReader(
                    responseStream
                )
            ).use { reader ->
                reader.readText()
            }

        connection.disconnect()

        if (
            responseCode !in
            200..299
        ) {
            throw RuntimeException(
                "Transcription HTTP " +
                        "$responseCode: " +
                        responseText
            )
        }

        val json =
            JSONObject(
                responseText
            )

        return json.optString(
            "text",
            ""
        )
    }


    /*
     * =====================================================================
     * JavaScript callbacks
     * =====================================================================
     */

    private fun notifyJavascriptRecordingStarted() {
        evaluateJavascript(
            """
            if (
                window.onNativeRecordingStarted
            ) {
                window.onNativeRecordingStarted();
            }
            """.trimIndent()
        )
    }


    private fun notifyJavascriptThinking() {
        evaluateJavascript(
            """
            if (
                window.onNativeRecordingStopped
            ) {
                window.onNativeRecordingStopped();
            }
            """.trimIndent()
        )
    }


    private fun notifyJavascriptTranscript(
        transcript: String
    ) {
        val quotedTranscript =
            JSONObject.quote(
                transcript
            )

        evaluateJavascript(
            """
            if (
                window.onNativeTranscript
            ) {
                window.onNativeTranscript(
                    $quotedTranscript
                );
            }
            """.trimIndent()
        )
    }


    private fun notifyJavascriptNoSpeech() {
        evaluateJavascript(
            """
            if (
                window.onNativeNoSpeech
            ) {
                window.onNativeNoSpeech();
            }
            """.trimIndent()
        )
    }


    private fun notifyJavascriptError(
        message: String
    ) {
        val quotedMessage =
            JSONObject.quote(
                message
            )

        evaluateJavascript(
            """
            if (
                window.onNativeMicError
            ) {
                window.onNativeMicError(
                    $quotedMessage
                );
            }
            """.trimIndent()
        )
    }

    private fun notifyJavascriptPowerStateChanged(
        charging: Boolean
    ) {
        val batteryState =
            try {
                JSONObject(
                    getBatteryStateJson()
                )
            } catch (
                _: Exception
            ) {
                JSONObject()
            }

        val batteryPercent =
            if (
                batteryState.has(
                    "battery_percent"
                ) &&
                !batteryState.isNull(
                    "battery_percent"
                )
            ) {
                batteryState.optInt(
                    "battery_percent",
                    -1
                )

            } else {
                -1
            }

        Log.i(
            WAKE_LOG,
            "Sending power event to WebView: charging=$charging battery=$batteryPercent"
        )

        evaluateJavascript(
            """
        if (
            window.onNativePowerStateChanged
        ) {
            window.onNativePowerStateChanged(
                {
                    charging:
                        $charging,

                    battery_percent:
                        $batteryPercent
                }
            );
        }
        """.trimIndent()
        )
    }

    // BMO_SPOTIFY_UNAVAILABLE_CALLBACK_V1
    private fun notifyJavascriptSpotifyUnavailable() {
        Log.i(
            SPOTIFY_LOG,
            "Notifying WebView that Spotify is unavailable"
        )

        evaluateJavascript(
            """
            if (
                window.onSpotifyUnavailable
            ) {
                window.onSpotifyUnavailable();
            }
            """.trimIndent()
        )
    }


    private fun evaluateJavascript(
        javascript: String
    ) {
        webView.evaluateJavascript(
            javascript,
            null
        )
    }


    /*
     * =====================================================================
     * Vision JavaScript callbacks
     * =====================================================================
     */

    private fun notifyJavascriptVisionStarted() {
        evaluateJavascript(
            """
        if (
            window.onNativeVisionStarted
        ) {
            window.onNativeVisionStarted();
        }
        """.trimIndent()
        )
    }


    private fun notifyJavascriptVisionCaptured(
        jpegData: ByteArray
    ) {
        try {
            val originalBitmap =
                android.graphics.BitmapFactory.decodeByteArray(
                    jpegData,
                    0,
                    jpegData.size
                )
                    ?: return

            val maxDimension =
                720

            val width =
                originalBitmap.width

            val height =
                originalBitmap.height

            val scale =
                if (
                    width > maxDimension ||
                    height > maxDimension
                ) {
                    minOf(
                        maxDimension.toFloat() /
                                width.toFloat(),
                        maxDimension.toFloat() /
                                height.toFloat()
                    )
                } else {
                    1.0f
                }

            val previewWidth =
                (width * scale)
                    .toInt()
                    .coerceAtLeast(
                        1
                    )

            val previewHeight =
                (height * scale)
                    .toInt()
                    .coerceAtLeast(
                        1
                    )

            val previewBitmap =
                if (
                    previewWidth != width ||
                    previewHeight != height
                ) {
                    android.graphics.Bitmap.createScaledBitmap(
                        originalBitmap,
                        previewWidth,
                        previewHeight,
                        true
                    )
                } else {
                    originalBitmap
                }

            val output =
                java.io.ByteArrayOutputStream()

            previewBitmap.compress(
                android.graphics.Bitmap.CompressFormat.JPEG,
                72,
                output
            )

            val encoded =
                android.util.Base64.encodeToString(
                    output.toByteArray(),
                    android.util.Base64.NO_WRAP
                )

            val dataUrl =
                "data:image/jpeg;base64,$encoded"

            val quotedDataUrl =
                JSONObject.quote(
                    dataUrl
                )

            evaluateJavascript(
                """
                if (
                    window.onNativeVisionCaptured
                ) {
                    window.onNativeVisionCaptured(
                        $quotedDataUrl
                    );
                }
                """.trimIndent()
            )

            if (
                previewBitmap !== originalBitmap
            ) {
                previewBitmap.recycle()
            }

            originalBitmap.recycle()

            output.close()

        } catch (
            exception: Exception
        ) {
            Log.w(
                WAKE_LOG,
                "Could not prepare vision preview",
                exception
            )
        }
    }

    private fun notifyJavascriptVisionResponse(
        responseText: String
    ) {
        val quotedResponse =
            JSONObject.quote(
                responseText
            )

        evaluateJavascript(
            """
        if (
            window.onNativeVisionResponse
        ) {
            window.onNativeVisionResponse(
                $quotedResponse
            );
        }
        """.trimIndent()
        )
    }


    private fun notifyJavascriptVisionError(
        message: String
    ) {
        val quotedMessage =
            JSONObject.quote(
                message
            )

        evaluateJavascript(
            """
        if (
            window.onNativeVisionError
        ) {
            window.onNativeVisionError(
                $quotedMessage
            );
        }
        """.trimIndent()
        )
    }


    /*
     * =====================================================================
     * Permissions
     * =====================================================================
     */

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions:
        Array<out String>,
        grantResults:
        IntArray
    ) {
        super.onRequestPermissionsResult(
            requestCode,
            permissions,
            grantResults
        )

        if (
            requestCode ==
            AUDIO_PERMISSION_REQUEST
        ) {
            val granted =
                grantResults.isNotEmpty() &&
                        grantResults[0] ==
                        PackageManager.PERMISSION_GRANTED

            if (
                granted &&
                startAfterPermission
            ) {
                startAfterPermission =
                    false

                startNativeRecording()

            } else {
                startAfterPermission =
                    false

                notifyJavascriptError(
                    "Microphone permission denied"
                )
            }

            if (
                granted &&
                !isRecording
            ) {
                rearmWakeWord(
                    1000L
                )
            }
        }

        if (
            requestCode ==
            CAMERA_PERMISSION_REQUEST
        ) {
            val granted =
                grantResults.isNotEmpty() &&
                        grantResults[0] ==
                        PackageManager.PERMISSION_GRANTED

            val prompt =
                pendingVisionPrompt

            pendingVisionPrompt =
                null

            if (
                granted &&
                prompt != null
            ) {
                startNativeVisionCapture(
                    prompt
                )

            } else {
                visionInProgress =
                    false

                notifyJavascriptVisionError(
                    "Camera permission denied"
                )

                rearmWakeWord(
                    1000L
                )
            }
        }
    }


    /*
     * =====================================================================
     * Appliance UI
     * =====================================================================
     */

    private fun hideSystemUI() {
        @Suppress(
            "DEPRECATION"
        )
        window.decorView.systemUiVisibility =
            (
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                            View.SYSTEM_UI_FLAG_FULLSCREEN or
                            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    )
    }


    @Suppress(
        "DEPRECATION"
    )
    override fun onBackPressed() {
        /*
         * BMO is an appliance-style interface.
         * Ignore Back and immediately restore immersive mode.
         */
        hideSystemUI()
    }


    override fun onWindowFocusChanged(
        hasFocus: Boolean
    ) {
        super.onWindowFocusChanged(
            hasFocus
        )

        if (
            hasFocus
        ) {
            hideSystemUI()
        }
    }


    override fun onStart() {
        super.onStart()

        connectSpotify()

        @Suppress(
            "DEPRECATION"
        )
        registerReceiver(
            connectivityReceiver,
            IntentFilter(
                ConnectivityManager.CONNECTIVITY_ACTION
            )
        )
        registerReceiver(
            powerReceiver,
            IntentFilter().apply {
                addAction(
                    Intent.ACTION_POWER_CONNECTED
                )

                addAction(
                    Intent.ACTION_POWER_DISCONNECTED
                )
            }
        )
    }


    override fun onStop() {
        try {
            unregisterReceiver(
                connectivityReceiver
            )

        } catch (
            _: Exception
        ) {
        }

        try {
            unregisterReceiver(
                powerReceiver
            )

        } catch (
            _: Exception
        ) {
        }

        disconnectSpotify()

        super.onStop()
    }


    override fun onResume() {
        super.onResume()

        hideSystemUI()

        checkBackendAndUpdateUi()

        if (
            bmoPageReady &&
            !isRecording
        ) {
            rearmWakeWord(
                1000L
            )
        }
    }


    override fun onPause() {
        stopWakeWordSystem()

        if (
            visionInProgress
        ) {
            releaseVisionCamera()

            visionInProgress =
                false
        }

        super.onPause()
    }


    override fun onDestroy() {
        mainHandler.removeCallbacks(
            retryRunnable
        )

        mainHandler.removeCallbacks(
            webViewWatchdogRunnable
        )

        wakeRearmRunnable
            ?.let {
                mainHandler.removeCallbacks(
                    it
                )
            }

        stopWakeWordSystem()

        releaseVisionCamera()

        if (
            isRecording
        ) {
            try {
                recorder
                    ?.stop()

            } catch (
                _: Exception
            ) {
            }
        }

        cleanupRecorder()

        wakeHttpClient
            .dispatcher
            .executorService
            .shutdown()

        super.onDestroy()
    }
}






























