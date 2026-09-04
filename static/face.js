const screen = document.getElementById("bmo-screen");
const faceCanvas = document.getElementById("bmo-face-canvas");
const statusMessage = document.getElementById("status-message");
const transcriptElement = document.getElementById("transcript");

const pageParams = new URLSearchParams(window.location.search);
const nativeShellRequested = pageParams.get("native") === "1";

function getNativeBridge() {
    try {
        if (typeof window.AndroidBMO !== "undefined" && window.AndroidBMO) {
            return window.AndroidBMO;
        }
    } catch (error) {
        console.error("Android bridge unavailable:", error);
    }

    return null;
}


class BMOFaceRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");

        this.width = canvas.width;
        this.height = canvas.height;

        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = "high";

        this.colors = {
            bg: "#bdffcb",
            line: "#000000",
            mouthDark: "#298339",
            tongue: "#70c370",
            teeth: "#ffffff",
        };

        this.eyeY = 195;
        this.leftEyeX = 217;
        this.rightEyeX = 581;
        this.eyeR = 18;

        this.mouthY = 302;
        this.mouthW = 97;

        this.state = "idle";
        this.frame = 0;
        this.blink = 0;

        this.eyeOffsetX = 0;
        this.eyeOffsetY = 0;
        this.eyePulseR = 0;
        this.mouthOpen = 0;
    }

    clear() {
        this.ctx.fillStyle = this.colors.bg;
        this.ctx.fillRect(0, 0, this.width, this.height);
    }

    drawArc(cx, cy, r, start, end, width = 12) {
        this.ctx.beginPath();
        this.ctx.arc(cx, cy, r, start, end);

        this.ctx.strokeStyle = this.colors.line;
        this.ctx.lineWidth = width;
        this.ctx.lineCap = "round";
        this.ctx.stroke();
    }

    drawCircle(cx, cy, r, filled = true) {
        this.ctx.beginPath();
        this.ctx.arc(cx, cy, r, 0, Math.PI * 2);

        if (filled) {
            this.ctx.fillStyle = this.colors.line;
            this.ctx.fill();
        } else {
            this.ctx.strokeStyle = this.colors.line;
            this.ctx.lineWidth = 12;
            this.ctx.stroke();
        }
    }

    drawLine(x1, y1, x2, y2, width = 12) {
        this.ctx.beginPath();
        this.ctx.moveTo(x1, y1);
        this.ctx.lineTo(x2, y2);

        this.ctx.strokeStyle = this.colors.line;
        this.ctx.lineWidth = width;
        this.ctx.lineCap = "round";
        this.ctx.stroke();
    }

    drawMouth(type, height = 0, width = this.mouthW) {
        const centerX = this.width / 2;
        const centerY = this.mouthY;
        const halfWidth = width / 2;

        this.ctx.lineWidth = 12;
        this.ctx.strokeStyle = this.colors.line;
        this.ctx.lineCap = "round";

        if (
            type === "straight" ||
            (type === "speaking" && height === 0)
        ) {
            this.drawLine(
                centerX - halfWidth,
                centerY,
                centerX + halfWidth,
                centerY
            );
            return;
        }

        if (type === "smile") {
            this.ctx.beginPath();
            this.ctx.arc(
                centerX,
                centerY - 25,
                halfWidth,
                Math.PI * 0.15,
                Math.PI * 0.85
            );
            this.ctx.stroke();
            return;
        }

        if (type === "frown") {
            this.ctx.beginPath();
            this.ctx.arc(
                centerX,
                centerY + 15,
                halfWidth,
                Math.PI * 1.15,
                Math.PI * 1.85
            );
            this.ctx.stroke();
            return;
        }

        if (type === "speaking") {
            const radius = height / 2;

            this.ctx.beginPath();
            this.ctx.roundRect(
                centerX - halfWidth,
                centerY - radius,
                width,
                height,
                radius
            );

            this.ctx.fillStyle = this.colors.mouthDark;
            this.ctx.fill();
            this.ctx.stroke();

            if (height > 25) {
                this.ctx.fillStyle = this.colors.teeth;

                this.ctx.beginPath();
                this.ctx.roundRect(
                    centerX - halfWidth + 10,
                    centerY - radius + 5,
                    width - 20,
                    height / 4,
                    4
                );
                this.ctx.fill();
            }

            if (height > 40) {
                this.ctx.fillStyle = this.colors.tongue;

                this.ctx.beginPath();
                this.ctx.ellipse(
                    centerX,
                    centerY + radius - 8,
                    halfWidth - 15,
                    height / 4,
                    0,
                    0,
                    Math.PI * 2
                );
                this.ctx.fill();
            }
        }
    }

    render() {
        this.clear();

        const frame = this.frame++;

        let eyeType = "regular";
        let mouthType = "straight";
        let currentHeight = 0;
        let currentWidth = this.mouthW;

        if (!["sleepy", "thinking", "listening"].includes(this.state)) {
            const blinkFrame = frame % 170;

            if (blinkFrame < 5) {
                this.blink = 1;
            } else if (blinkFrame < 8) {
                this.blink = 0.5;
            } else {
                this.blink = 0;
            }
        } else if (this.state === "sleepy") {
            this.blink = 1;
        }

        if (this.state === "idle") {
            const movement = frame % 360;

            if (movement < 60) {
                this.eyeOffsetX = -10;
            } else if (movement < 120) {
                this.eyeOffsetX = 0;
            } else if (movement < 180) {
                this.eyeOffsetX = 10;
            } else {
                this.eyeOffsetX = 0;
            }
        }

        if (this.state === "thinking") {
            this.eyeOffsetX = Math.sin(frame * 0.18) * 15;
        }

        if (this.state === "listening") {
            this.eyePulseR = Math.sin(frame * 0.2) * 2;
            eyeType = "circle";
        }

        if (this.state === "speaking") {
            eyeType = "circle";
            mouthType = "speaking";

            if (this.mouthOpen > 0.5) {
                currentHeight = Math.min(
                    65,
                    this.mouthOpen * 1.5
                );

                currentWidth = Math.min(
                    105,
                    80 + this.mouthOpen * 0.5
                );
            } else {
                currentHeight = 0;
                currentWidth = this.mouthW;
            }
        }

        switch (this.state) {
            case "happy":
                eyeType = "happy";
                mouthType = "smile";
                break;

            case "sad":
            case "error":
                eyeType = "sad";
                mouthType = "frown";
                break;

            case "angry":
                eyeType = "angry";
                mouthType = "straight";
                break;

            case "surprised":
                eyeType = "circle";
                mouthType = "speaking";
                currentHeight = 40;
                currentWidth = 60;
                break;

            case "sleepy":
                eyeType = "closed";
                break;

            case "daydream":
                eyeType = "regular";
                this.eyeOffsetY = -10;
                break;
        }

        const drawEye = (x, y) => {
            let radius = this.eyeR;

            if (this.state === "listening") {
                radius += this.eyePulseR;
            }

            if (this.blink >= 0.9 || eyeType === "closed") {
                this.drawLine(
                    x - radius,
                    y,
                    x + radius,
                    y
                );
            } else if (this.blink > 0) {
                this.drawArc(
                    x,
                    y,
                    radius,
                    -0.2,
                    Math.PI + 0.2
                );
            } else if (eyeType === "happy") {
                this.drawArc(
                    x,
                    y + 10,
                    radius,
                    Math.PI,
                    Math.PI * 2
                );
            } else if (eyeType === "circle") {
                this.drawCircle(
                    x,
                    y,
                    radius - 2
                );
            } else if (eyeType === "sad") {
                this.drawLine(
                    x - 15,
                    y + 10,
                    x + 15,
                    y - 5
                );
            } else if (eyeType === "angry") {
                this.drawLine(
                    x - 15,
                    y - 5,
                    x + 15,
                    y + 10
                );
            } else {
                this.drawArc(
                    x,
                    y,
                    radius,
                    -0.4,
                    Math.PI + 0.4
                );
            }
        };

        drawEye(
            this.leftEyeX + this.eyeOffsetX,
            this.eyeY + this.eyeOffsetY
        );

        drawEye(
            this.rightEyeX + this.eyeOffsetX,
            this.eyeY + this.eyeOffsetY
        );

        this.drawMouth(
            mouthType,
            currentHeight,
            currentWidth
        );

        requestAnimationFrame(() => this.render());
    }
}


const bmoRenderer =
    new BMOFaceRenderer(faceCanvas);

bmoRenderer.render();


let conversationHistory = [];

let mediaRecorder = null;
let microphoneStream = null;
let audioChunks = [];

let isRecording = false;

let currentAudio = null;

let statusTimer = null;
let transcriptTimer = null;

let audioContext = null;
let analyser = null;
let dataArray = null;

let wakeLock = null;


/*
 * State helpers
 */

function setFaceState(state) {
    bmoRenderer.state = state;

    if (state !== "speaking") {
        bmoRenderer.mouthOpen = 0;
    }

    bmoRenderer.eyeOffsetY = 0;
}


function showStatus(text, duration = 1800) {
    clearTimeout(statusTimer);

    statusMessage.textContent = text;
    statusMessage.classList.remove("hidden");

    if (duration > 0) {
        statusTimer = setTimeout(
            () => {
                statusMessage.classList.add("hidden");
            },
            duration
        );
    }
}


function showTranscript(text, duration = 2500) {
    clearTimeout(transcriptTimer);

    transcriptElement.textContent = text;
    transcriptElement.classList.add("visible");

    transcriptTimer = setTimeout(
        () => {
            transcriptElement.classList.remove("visible");
        },
        duration
    );
}


/*
 * Keep BMO awake where supported.
 */

async function requestWakeLock() {
    if (!("wakeLock" in navigator) || wakeLock) {
        return;
    }

    try {
        wakeLock =
            await navigator.wakeLock.request("screen");

        wakeLock.addEventListener(
            "release",
            () => {
                wakeLock = null;
            }
        );
    } catch (error) {
        console.debug(
            "Wake lock unavailable:",
            error
        );
    }
}


/*
 * Pick the best audio format the browser supports.
 */

function getRecorderOptions() {
    const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
    ];

    for (const mimeType of candidates) {
        if (
            window.MediaRecorder &&
            MediaRecorder.isTypeSupported(mimeType)
        ) {
            return {
                mimeType: mimeType,
            };
        }
    }

    return {};
}


/*
 * Recording
 */

async function startRecording() {
    if (isRecording) {
        return;
    }

    const nativeBridge =
        getNativeBridge();

    if (nativeBridge) {
        try {
            nativeBridge.startRecording();
            return;
        } catch (error) {
            console.error(
                "Native microphone bridge failed:",
                error
            );

            setFaceState("error");

            showStatus(
                "Microphone connection failed",
                2500
            );

            setTimeout(
                () => setFaceState("idle"),
                1500
            );

            return;
        }
    }

    /*
     * If this page is inside the Android app, never silently fall back
     * to browser getUserMedia(). The native bridge is the microphone path.
     */
    if (nativeShellRequested) {
        console.error(
            "Android microphone bridge is missing."
        );

        setFaceState("error");

        showStatus(
            "Microphone connection failed",
            2500
        );

        setTimeout(
            () => setFaceState("idle"),
            1500
        );

        return;
    }

    /*
     * Browser fallback for desktop/mobile browsers.
     */
    try {
        await requestWakeLock();

        if (
            !navigator.mediaDevices ||
            !navigator.mediaDevices.getUserMedia
        ) {
            throw new Error(
                "getUserMedia is unavailable"
            );
        }

        microphoneStream =
            await navigator.mediaDevices.getUserMedia(
                {
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                    },
                }
            );

        mediaRecorder =
            new MediaRecorder(
                microphoneStream,
                getRecorderOptions()
            );

        audioChunks = [];

        mediaRecorder.addEventListener(
            "dataavailable",
            (event) => {
                if (event.data.size > 0) {
                    audioChunks.push(event.data);
                }
            }
        );

        mediaRecorder.addEventListener(
            "stop",
            async () => {
                const mimeType =
                    mediaRecorder.mimeType ||
                    "audio/webm";

                const blob =
                    new Blob(
                        audioChunks,
                        {
                            type: mimeType,
                        }
                    );

                if (microphoneStream) {
                    for (
                        const track
                        of microphoneStream.getTracks()
                    ) {
                        track.stop();
                    }

                    microphoneStream = null;
                }

                await sendAudioToBMO(blob);
            }
        );

        mediaRecorder.start();

        isRecording = true;

        setFaceState("listening");

        showStatus(
            "Listening...",
            0
        );

        if ("vibrate" in navigator) {
            navigator.vibrate(30);
        }
    } catch (error) {
        console.error(
            "Browser microphone error:",
            error
        );

        setFaceState("error");

        showStatus(
            "Microphone unavailable",
            3000
        );

        setTimeout(
            () => setFaceState("idle"),
            1500
        );
    }
}


function stopRecording() {
    const nativeBridge =
        getNativeBridge();

    if (nativeBridge) {
        try {
            nativeBridge.stopRecording();
        } catch (error) {
            console.error(
                "Native microphone stop failed:",
                error
            );

            setFaceState("error");

            showStatus(
                "Microphone connection failed",
                2500
            );
        }

        return;
    }

    if (nativeShellRequested) {
        return;
    }

    if (!mediaRecorder || !isRecording) {
        return;
    }

    isRecording = false;

    setFaceState("thinking");

    showStatus(
        "Thinking...",
        0
    );

    mediaRecorder.stop();

    if ("vibrate" in navigator) {
        navigator.vibrate(20);
    }
}


/*
 * STT
 */

async function sendAudioToBMO(blob) {
    const formData =
        new FormData();

    let extension = "webm";

    if (blob.type.includes("mp4")) {
        extension = "mp4";
    }

    formData.append(
        "audio",
        blob,
        `bmo-recording.${extension}`
    );

    try {
        const response =
            await fetch(
                "/api/transcribe",
                {
                    method: "POST",
                    body: formData,
                }
            );

        if (!response.ok) {
            throw new Error(
                `Transcription HTTP ${response.status}`
            );
        }

        const data =
            await response.json();

        if (!data.text) {
            setFaceState("idle");

            showStatus(
                "I didn't catch that",
                1800
            );

            return;
        }

        showTranscript(data.text);

        await sendMessage(data.text);
    } catch (error) {
        console.error(
            "Transcription error:",
            error
        );

        setFaceState("error");

        showStatus(
            "I couldn't hear that",
            2500
        );

        setTimeout(
            () => setFaceState("idle"),
            1500
        );
    }
}


/*
 * Chat
 */

async function sendMessage(text) {
    setFaceState("thinking");

    showStatus(
        "Thinking...",
        0
    );

    try {
        const response =
            await fetch(
                "/api/chat",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",
                    },

                    body: JSON.stringify(
                        {
                            message: text,
                            history:
                                conversationHistory,
                            play_on_hardware:
                                false,
                        }
                    ),
                }
            );

        if (!response.ok) {
            throw new Error(
                `Chat HTTP ${response.status}`
            );
        }

        const data =
            await response.json();

        if (data.history) {
            conversationHistory =
                data.history;
        }

        if (data.audio_url) {
            await playBMOAudio(
                data.audio_url
            );

            return;
        }

        setFaceState("idle");

        showStatus(
            "Ready",
            1200
        );
    } catch (error) {
        console.error(
            "Chat error:",
            error
        );

        setFaceState("error");

        showStatus(
            "BMO brain connection failed",
            2500
        );

        setTimeout(
            () => {
                setFaceState("idle");
            },
            1500
        );
    }
}


/*
 * Audio playback and mouth sync
 */

async function playBMOAudio(audioUrl) {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }

    currentAudio =
        new Audio(audioUrl);

    setFaceState("speaking");

    showStatus(
        "Speaking...",
        1200
    );

    setupVisualizer(currentAudio);

    currentAudio.addEventListener(
        "ended",
        () => {
            setFaceState("idle");

            showStatus(
                "Hold to talk",
                1200
            );
        }
    );

    currentAudio.addEventListener(
        "error",
        (error) => {
            console.error(
                "Audio playback error:",
                error
            );

            setFaceState("error");

            showStatus(
                "Audio playback failed",
                2200
            );
        }
    );

    try {
        await currentAudio.play();
    } catch (error) {
        console.error(
            "Audio autoplay error:",
            error
        );

        setFaceState("idle");

        showStatus(
            "Tap once, then try again",
            2500
        );
    }
}


function setupVisualizer(audioElement) {
    if (!audioContext) {
        audioContext =
            new (
                window.AudioContext ||
                window.webkitAudioContext
            )();
    }

    const source =
        audioContext.createMediaElementSource(
            audioElement
        );

    analyser =
        audioContext.createAnalyser();

    analyser.fftSize = 256;

    source.connect(analyser);
    analyser.connect(
        audioContext.destination
    );

    dataArray =
        new Uint8Array(
            analyser.frequencyBinCount
        );

    function syncMouth() {
        if (
            bmoRenderer.state !== "speaking" ||
            audioElement.paused ||
            audioElement.ended
        ) {
            bmoRenderer.mouthOpen = 0;
            return;
        }

        analyser.getByteTimeDomainData(
            dataArray
        );

        let sum = 0;

        for (
            let index = 0;
            index < dataArray.length;
            index++
        ) {
            sum += Math.abs(
                dataArray[index] - 128
            );
        }

        bmoRenderer.mouthOpen =
            (sum / dataArray.length) * 4;

        requestAnimationFrame(
            syncMouth
        );
    }

    syncMouth();
}


/*
 * Touch / mouse controls
 *
 * Press and hold anywhere on BMO's screen.
 */

screen.addEventListener(
    "pointerdown",
    async (event) => {
        event.preventDefault();

        if (
            bmoRenderer.state === "speaking"
        ) {
            return;
        }

        if (screen.setPointerCapture) {
            try {
                screen.setPointerCapture(
                    event.pointerId
                );
            } catch (_) {
            }
        }

        await startRecording();
    }
);


screen.addEventListener(
    "pointerup",
    (event) => {
        event.preventDefault();

        stopRecording();
    }
);


screen.addEventListener(
    "pointercancel",
    () => {
        stopRecording();
    }
);


window.addEventListener(
    "blur",
    () => {
        if (isRecording) {
            stopRecording();
        }
    }
);


/*
 * Keep BMO awake.
 */

document.addEventListener(
    "visibilitychange",
    async () => {
        if (
            document.visibilityState ===
            "visible"
        ) {
            await requestWakeLock();
        }
    }
);


document.addEventListener(
    "pointerdown",
    () => {
        requestWakeLock();
    },
    {
        once: true,
    }
);


/*
 * Browser/PWA support.
 *
 * The native Android shell does not need a service worker, so avoid
 * registering one there.
 */

if (
    "serviceWorker" in navigator &&
    !nativeShellRequested
) {
    window.addEventListener(
        "load",
        async () => {
            try {
                await navigator.serviceWorker.register(
                    "/static/sw.js",
                    {
                        scope: "/static/",
                    }
                );

                console.log(
                    "BMO service worker ready"
                );
            } catch (error) {
                console.warn(
                    "BMO service worker failed:",
                    error
                );
            }
        }
    );
}


/*
 * Native Android microphone callbacks
 */

window.onNativeRecordingStarted =
    function () {
        isRecording = true;

        setFaceState("listening");

        showStatus(
            "Listening...",
            0
        );

        if ("vibrate" in navigator) {
            navigator.vibrate(30);
        }
    };


window.onNativeRecordingStopped =
    function () {
        isRecording = false;

        setFaceState("thinking");

        showStatus(
            "Thinking...",
            0
        );

        if ("vibrate" in navigator) {
            navigator.vibrate(20);
        }
    };


window.onNativeTranscript =
    async function (text) {
        isRecording = false;

        const cleanedText =
            String(text || "").trim();

        if (!cleanedText) {
            setFaceState("idle");

            showStatus(
                "I didn't catch that",
                1800
            );

            return;
        }

        showTranscript(cleanedText);

        await sendMessage(cleanedText);
    };


window.onNativeNoSpeech =
    function () {
        isRecording = false;

        setFaceState("idle");

        showStatus(
            "I didn't catch that",
            1800
        );
    };


window.onNativeMicError =
    function (message) {
        isRecording = false;

        console.error(
            "Native microphone error:",
            message
        );

        setFaceState("error");

        showStatus(
            message || "Microphone error",
            2500
        );

        setTimeout(
            () => {
                setFaceState("idle");
            },
            1800
        );
    };


/*
 * Initial state
 */

setFaceState("idle");

showStatus(
    "Hold anywhere to talk",
    3500
);
