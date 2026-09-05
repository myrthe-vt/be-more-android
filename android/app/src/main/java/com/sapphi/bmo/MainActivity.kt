package com.sapphi.bmo

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
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


class MainActivity : AppCompatActivity() {

    companion object {

        private const val WAKE_LOG =
            "BMO_WAKE"
        private const val AUDIO_PERMISSION_REQUEST =
            1001

        private const val RETRY_DELAY_MS =
            4000L

        private const val BMO_BASE_URL =
            "http://bmo-backend.example:8000"

        private const val BMO_URL =
            "$BMO_BASE_URL/static/face.html?native=1"

        private const val STATUS_URL =
            "$BMO_BASE_URL/api/status"

        private const val TRANSCRIBE_URL =
            "$BMO_BASE_URL/api/transcribe"

        private const val WAKEWORD_URL =
            "ws://bmo-backend.example:8000/api/wakeword"

        /*
         * OpenWakeWord expects 16 kHz mono 16-bit PCM.
         *
         * Your Mac-side code works with 1280-sample chunks,
         * which represent 80 ms of audio at 16 kHz.
         */
        private const val WAKE_SAMPLE_RATE =
            16000

        private const val WAKE_CHUNK_SAMPLES =
            1280

        /*
         * After "Hey BMO" is detected, switch from the passive
         * AudioRecord wake-word stream to the normal MediaRecorder
         * command microphone. Record for this long, then submit the
         * captured audio through the existing transcription/chat/TTS
         * pipeline exactly like releasing push-to-talk.
         */
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
     * Backend / page state
     */

    private var showingBmoPage =
        false

    private var backendCheckRunning =
        false

    private var bmoPageReady =
        false


    /*
     * Wake-word audio state
     */

    private var wakeAudioRecord: AudioRecord? =
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

        /*
         * Always verify the Mac before loading the remote BMO page.
         */
        showConnectingPage()

        checkBackendAndUpdateUi()
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

                    /*
                     * LG's older Android WebView does not reliably report
                     * onPageFinished() for the remote BMO page. Keep this
                     * callback for diagnostics only. Wake-word startup is
                     * now driven by the successful backend health check in
                     * showBmoPage(), so it cannot get stuck behind this
                     * callback.
                     */
                    if (
                        url?.startsWith(
                            BMO_BASE_URL
                        ) == true
                    ) {
                        Log.i(
                            WAKE_LOG,
                            "Remote BMO page reported finished"
                        )
                    }
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
                WebSettings.LOAD_DEFAULT

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
            return
        }

        showingBmoPage =
            true

        /*
         * The backend health check already succeeded, so the native
         * wake-word system is allowed to start independently from
         * WebView.onPageFinished().
         *
         * This matters on the LG G7 / Android 8 WebView, where the
         * remote page can load successfully without us receiving the
         * expected onPageFinished() callback.
         */
        bmoPageReady =
            true

        Log.i(
            WAKE_LOG,
            "Backend online; loading BMO page"
        )

        webView.loadUrl(
            BMO_URL
        )

        /*
         * Give the WebView a short head start for the visible face and
         * JavaScript bridge, but do not make wake-word startup depend on
         * the page-finished callback.
         */
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
                        • _ •
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
                        • _ •
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
            /*
             * Push-to-talk will still ask for permission normally.
             * We don't trigger a surprise permission dialog solely
             * because the page loaded.
             */
            return
        }

        wakeWordTriggered =
            false

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
                        handleWakeSocketMessage(
                            text
                        )
                    }


                    override fun onClosing(
                        webSocket: WebSocket,
                        code: Int,
                        reason: String
                    ) {
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
                        wakeSocketConnected =
                            false

                        wakeWebSocket =
                            null
                    }


                    override fun onFailure(
                        webSocket: WebSocket,
                        throwable: Throwable,
                        response: Response?
                    ) {
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
                            bmoPageReady &&
                            !isRecording
                        ) {
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

        /*
         * Use several chunks of buffering so old Android audio
         * hardware has some breathing room.
         */
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
                    MediaRecorder.AudioSource.MIC,
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
            exception.printStackTrace()

            stopWakeAudioCapture()
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

            /*
             * OpenWakeWord expects a fixed-size 1280-sample
             * chunk. If Android returns less than that, pad the
             * remainder with silence.
             */
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
            exception.printStackTrace()
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

        /*
         * The passive wake-word listener owns the microphone through
         * AudioRecord. Release it before the normal MediaRecorder
         * command capture takes over.
         */
        stopWakeWordSystem()

        runOnUiThread {
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

            /*
             * Use the exact same recording pipeline as push-to-talk.
             * Once this recorder stops, stopNativeRecording() uploads
             * the file to /api/transcribe and face.js receives the
             * transcript through window.onNativeTranscript().
             */
            Log.i(
                WAKE_LOG,
                "Starting automatic command recording"
            )

            startNativeRecording()

            /*
             * MediaRecorder needs a moment after the passive
             * AudioRecord is released. startNativeRecording() is
             * synchronous here, so if it succeeded isRecording will
             * already be true.
             */
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
        /*
         * One single place owns the transition back to passive
         * wake-word listening after command capture, errors, or
         * no-speech results.
         *
         * Resetting wakeWordTriggered here is critical. Without it,
         * a second detection can be ignored until the Activity is
         * recreated.
         */
        wakeWordTriggered =
            false

        Log.i(
            WAKE_LOG,
            "Scheduling wake-word rearm in ${delayMs}ms"
        )

        mainHandler.postDelayed(
            {
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
            },
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

        wakeAudioRecord =
            null

        wakeAudioThread =
            null
    }


    private fun stopWakeWordSystem() {
        stopWakeAudioCapture()

        wakeSocketConnected =
            false

        try {
            wakeWebSocket
                ?.close(
                    1000,
                    "Wake listener stopping"
                )

        } catch (
            _: Exception
        ) {
        }

        wakeWebSocket =
            null
    }


    /*
     * =====================================================================
     * JavaScript bridge
     * =====================================================================
     */

    inner class BMOBridge {

        @JavascriptInterface
        fun startRecording() {
            runOnUiThread {
                /*
                 * Push-to-talk always gets priority over passive
                 * wake listening.
                 */
                stopWakeWordSystem()

                startNativeRecording()
            }
        }


        @JavascriptInterface
        fun stopRecording() {
            runOnUiThread {
                stopNativeRecording()
            }
        }
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
            exception.printStackTrace()

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
            exception.printStackTrace()

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

                    /*
                     * Successful transcription used to be the one path
                     * that did not explicitly rearm passive wake listening.
                     * Re-arm here after handing the transcript to face.js.
                     */
                    rearmWakeWord(
                        1500L
                    )
                }

            } catch (
                exception: Exception
            ) {
                exception.printStackTrace()

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

            /*
             * If the user just granted mic access through PTT,
             * wake-word listening becomes available too.
             */
            if (
                granted &&
                !isRecording
            ) {
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

        super.onPause()
    }


    override fun onDestroy() {
        mainHandler.removeCallbacks(
            retryRunnable
        )

        stopWakeWordSystem()

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