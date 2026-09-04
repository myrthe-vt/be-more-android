package com.sapphi.bmo

import android.Manifest
import android.content.pm.PackageManager
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
import org.json.JSONObject
import java.io.BufferedReader
import java.io.DataOutputStream
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

class MainActivity : AppCompatActivity() {

    companion object {
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
    }

    private lateinit var webView: WebView

    private val mainHandler =
        Handler(
            Looper.getMainLooper()
        )

    private var recorder: MediaRecorder? =
        null

    private var recordingFile: File? =
        null

    private var isRecording =
        false

    private var startAfterPermission =
        false

    private var showingBmoPage =
        false

    private var backendCheckRunning =
        false


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
         * Do NOT restore an old WebView state here.
         *
         * BMO's UI comes from the Mac backend, so Android should
         * verify that the backend is really alive on every launch.
         */
        showConnectingPage()

        checkBackendAndUpdateUi()
    }


    private fun setupWebView() {
        WebView.setWebContentsDebuggingEnabled(
            true
        )

        webView.webViewClient =
            WebViewClient()

        webView.settings.apply {
            javaScriptEnabled =
                true

            domStorageEnabled =
                true

            mediaPlaybackRequiresUserGesture =
                false

            /*
             * Normal caching is okay once the backend has been
             * confirmed alive. We no longer rely on WebView load
             * failures for health detection.
             */
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
     * -------------------------------------------------------------------------
     * Backend startup / reconnect logic
     * -------------------------------------------------------------------------
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

        /*
         * Avoid repeatedly reloading the real BMO page if it is
         * already open.
         */
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

        webView.loadUrl(
            BMO_URL
        )
    }


    private fun showConnectingPage() {
        showingBmoPage =
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
        showingBmoPage =
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
     * -------------------------------------------------------------------------
     * JavaScript bridge
     * -------------------------------------------------------------------------
     */

    inner class BMOBridge {

        @JavascriptInterface
        fun startRecording() {
            runOnUiThread {
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
     * -------------------------------------------------------------------------
     * Native microphone
     * -------------------------------------------------------------------------
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
            exception:
            RuntimeException
        ) {
            exception.printStackTrace()

            recordingFile
                ?.delete()

            cleanupRecorder()

            notifyJavascriptError(
                "Recording was too short"
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
     * -------------------------------------------------------------------------
     * Native recording upload
     * -------------------------------------------------------------------------
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
                    }

                    return@Thread
                }

                runOnUiThread {
                    notifyJavascriptTranscript(
                        transcript
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
     * -------------------------------------------------------------------------
     * JavaScript callbacks
     * -------------------------------------------------------------------------
     */

    private fun notifyJavascriptRecordingStarted() {
        evaluateJavascript(
            """
            if (window.onNativeRecordingStarted) {
                window.onNativeRecordingStarted();
            }
            """.trimIndent()
        )
    }


    private fun notifyJavascriptThinking() {
        evaluateJavascript(
            """
            if (window.onNativeRecordingStopped) {
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
            if (window.onNativeTranscript) {
                window.onNativeTranscript($quotedTranscript);
            }
            """.trimIndent()
        )
    }


    private fun notifyJavascriptNoSpeech() {
        evaluateJavascript(
            """
            if (window.onNativeNoSpeech) {
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
            if (window.onNativeMicError) {
                window.onNativeMicError($quotedMessage);
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
     * -------------------------------------------------------------------------
     * Permissions
     * -------------------------------------------------------------------------
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
        }
    }


    /*
     * -------------------------------------------------------------------------
     * Immersive UI
     * -------------------------------------------------------------------------
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

        /*
         * Re-check every time BMO returns to the foreground.
         */
        checkBackendAndUpdateUi()
    }


    override fun onDestroy() {
        mainHandler.removeCallbacks(
            retryRunnable
        )

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

        super.onDestroy()
    }
}