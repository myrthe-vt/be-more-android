const screen = document.getElementById("bmo-screen");
const faceCanvas = document.getElementById("bmo-face-canvas");
const statusMessage = document.getElementById("status-message");
const transcriptElement = document.getElementById("transcript");

const pageParams = new URLSearchParams(window.location.search);
const nativeShellRequested = pageParams.get("native") === "1";

const HOLD_START_DELAY_MS = 120;
const BACKEND_CHECK_INTERVAL_MS = 5000;
const BACKEND_CHECK_TIMEOUT_MS = 3000;
const TIMER_EVENT_CHECK_INTERVAL_MS = 1000;

const DAYDREAM_IDLE_MS = 90000;
const DAYDREAM_THOUGHT_INTERVAL_MS = 120000;
const DAYDREAM_MOOD_MIN_MS = 7000;
const DAYDREAM_MOOD_MAX_MS = 12000;


function getNativeBridge() {
    try {
        if (
            typeof window.AndroidBMO !== "undefined" &&
            window.AndroidBMO
        ) {
            return window.AndroidBMO;
        }
    } catch (error) {
        console.error(
            "Android bridge unavailable:",
            error
        );
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

        this.ctx.fillRect(
            0,
            0,
            this.width,
            this.height
        );
    }


    drawArc(
        cx,
        cy,
        r,
        start,
        end,
        width = 12
    ) {
        this.ctx.beginPath();

        this.ctx.arc(
            cx,
            cy,
            r,
            start,
            end
        );

        this.ctx.strokeStyle = this.colors.line;
        this.ctx.lineWidth = width;
        this.ctx.lineCap = "round";

        this.ctx.stroke();
    }


    drawCircle(
        cx,
        cy,
        r,
        filled = true
    ) {
        this.ctx.beginPath();

        this.ctx.arc(
            cx,
            cy,
            r,
            0,
            Math.PI * 2
        );

        if (filled) {
            this.ctx.fillStyle = this.colors.line;
            this.ctx.fill();

        } else {
            this.ctx.strokeStyle = this.colors.line;
            this.ctx.lineWidth = 12;
            this.ctx.stroke();
        }
    }


    drawLine(
        x1,
        y1,
        x2,
        y2,
        width = 12
    ) {
        this.ctx.beginPath();

        this.ctx.moveTo(
            x1,
            y1
        );

        this.ctx.lineTo(
            x2,
            y2
        );

        this.ctx.strokeStyle = this.colors.line;
        this.ctx.lineWidth = width;
        this.ctx.lineCap = "round";

        this.ctx.stroke();
    }


    drawMouth(
        type,
        height = 0,
        width = this.mouthW
    ) {
        const centerX = this.width / 2;
        const centerY = this.mouthY;
        const halfWidth = width / 2;

        this.ctx.lineWidth = 12;
        this.ctx.strokeStyle = this.colors.line;
        this.ctx.lineCap = "round";

        if (
            type === "straight" ||
            (
                type === "speaking" &&
                height === 0
            )
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

        if (
            ![
                "sleepy",
                "thinking",
                "listening",
            ].includes(this.state)
        ) {
            const blinkFrame = frame % 170;

            if (blinkFrame < 5) {
                this.blink = 1;

            } else if (blinkFrame < 8) {
                this.blink = 0.5;

            } else {
                this.blink = 0;
            }

        } else if (
            this.state === "sleepy"
        ) {
            this.blink = 1;
        }

        if (
            this.state === "idle"
        ) {
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

        if (
            this.state === "thinking"
        ) {
            this.eyeOffsetX =
                Math.sin(
                    frame * 0.18
                ) * 15;
        }

        if (
            this.state === "listening"
        ) {
            this.eyePulseR =
                Math.sin(
                    frame * 0.2
                ) * 2;

            eyeType = "circle";
        }

        if (
            this.state === "speaking"
        ) {
            eyeType = "circle";
            mouthType = "speaking";

            if (
                this.mouthOpen > 0.5
            ) {
                currentHeight =
                    Math.min(
                        65,
                        this.mouthOpen * 1.5
                    );

                currentWidth =
                    Math.min(
                        105,
                        80 +
                        this.mouthOpen * 0.5
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

        const drawEye =
            (x, y) => {
                let radius = this.eyeR;

                if (
                    this.state === "listening"
                ) {
                    radius += this.eyePulseR;
                }

                if (
                    this.blink >= 0.9 ||
                    eyeType === "closed"
                ) {
                    this.drawLine(
                        x - radius,
                        y,
                        x + radius,
                        y
                    );

                } else if (
                    this.blink > 0
                ) {
                    this.drawArc(
                        x,
                        y,
                        radius,
                        -0.2,
                        Math.PI + 0.2
                    );

                } else if (
                    eyeType === "happy"
                ) {
                    this.drawArc(
                        x,
                        y + 10,
                        radius,
                        Math.PI,
                        Math.PI * 2
                    );

                } else if (
                    eyeType === "circle"
                ) {
                    this.drawCircle(
                        x,
                        y,
                        radius - 2
                    );

                } else if (
                    eyeType === "sad"
                ) {
                    this.drawLine(
                        x - 15,
                        y + 10,
                        x + 15,
                        y - 5
                    );

                } else if (
                    eyeType === "angry"
                ) {
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
            this.leftEyeX +
                this.eyeOffsetX,
            this.eyeY +
                this.eyeOffsetY
        );

        drawEye(
            this.rightEyeX +
                this.eyeOffsetX,
            this.eyeY +
                this.eyeOffsetY
        );

        this.drawMouth(
            mouthType,
            currentHeight,
            currentWidth
        );

        requestAnimationFrame(
            () =>
                this.render()
        );
    }
}


const bmoRenderer =
    new BMOFaceRenderer(
        faceCanvas
    );

bmoRenderer.render();


let conversationHistory = [];

let mediaRecorder = null;
let microphoneStream = null;

let audioChunks = [];

let isRecording = false;
let recordingStartPending = false;

let holdStartTimer = null;
let activePointerId = null;

let backendOnline = true;
let backendCheckTimer = null;

let timerEventCheckTimer = null;
let pendingTimerEvents = [];
let processingTimerEvent = false;

let currentAudio = null;

let statusTimer = null;
let transcriptTimer = null;

let audioContext = null;
let analyser = null;
let dataArray = null;

let wakeLock = null;

let pendingExpression = null;
let expressionTimer = null;

let daydreamTimer = null;
let daydreamThoughtTimer = null;
let daydreamMoodTimer = null;

let daydreamActive = false;
let daydreamThoughtInFlight = false;
let daydreamThoughtVisible = false;


/*
 * State helpers
 */

function setFaceState(state) {
    bmoRenderer.state = state;

    if (
        state !== "speaking"
    ) {
        bmoRenderer.mouthOpen = 0;
    }

    bmoRenderer.eyeOffsetY = 0;
}


const VALID_EXPRESSIONS =
    new Set(
        [
            "idle",
            "happy",
            "sad",
            "angry",
            "surprised",
            "sleepy",
            "daydream",
        ]
    );


function applyTemporaryExpression(
    expression,
    durationMs = 3000
) {
    if (
        !VALID_EXPRESSIONS.has(
            expression
        )
    ) {
        console.warn(
            "Ignoring unknown expression:",
            expression
        );

        return;
    }

    clearTimeout(
        expressionTimer
    );

    pendingExpression = null;

    setFaceState(
        expression
    );

    expressionTimer =
        setTimeout(
            () => {
                expressionTimer = null;

                if (
                    !isRecording &&
                    !recordingStartPending &&
                    !currentAudio &&
                    bmoRenderer.state === expression
                ) {
                    setFaceState(
                        "idle"
                    );
                }
            },
            Math.max(
                1000,
                Math.min(
                    6000,
                    Number(
                        durationMs
                    ) || 3000
                )
            )
        );
}


function handleServerAction(
    action,
    deferUntilAfterAudio = false
) {
    if (
        !action ||
        typeof action !== "object"
    ) {
        return false;
    }

    if (
        action.type === "set_expression"
    ) {
        const expression =
            String(
                action.expression || ""
            ).toLowerCase();

        const durationMs =
            Number(
                action.duration_ms || 3000
            );

        if (
            !VALID_EXPRESSIONS.has(
                expression
            )
        ) {
            return false;
        }

        if (
            deferUntilAfterAudio ||
            currentAudio ||
            bmoRenderer.state === "speaking"
        ) {
            pendingExpression = {
                expression:
                    expression,

                durationMs:
                    durationMs,
            };

        } else {
            applyTemporaryExpression(
                expression,
                durationMs
            );
        }

        return true;
    }

    return false;
}


function applyPendingExpression() {
    if (
        !pendingExpression
    ) {
        return false;
    }

    const expression =
        pendingExpression;

    pendingExpression = null;

    applyTemporaryExpression(
        expression.expression,
        expression.durationMs
    );

    return true;
}


/*
 * Daydream behaviour
 */

function canDaydream() {
    return (
        backendOnline &&
        !isRecording &&
        !recordingStartPending &&
        !currentAudio &&
        !processingTimerEvent &&
        pendingTimerEvents.length === 0
    );
}


function clearDaydreamThought() {
    if (
        daydreamThoughtVisible
    ) {
        clearTimeout(
            transcriptTimer
        );

        transcriptElement.classList.remove(
            "visible"
        );

        daydreamThoughtVisible = false;
    }
}


function stopDaydream(
    returnToIdle = true
) {
    clearTimeout(
        daydreamThoughtTimer
    );

    clearTimeout(
        daydreamMoodTimer
    );

    daydreamThoughtTimer = null;
    daydreamMoodTimer = null;

    daydreamActive = false;

    clearDaydreamThought();

    if (
        returnToIdle &&
        !isRecording &&
        !recordingStartPending &&
        !currentAudio &&
        backendOnline
    ) {
        setFaceState(
            "idle"
        );
    }
}


function resetDaydreamTimer() {
    clearTimeout(
        daydreamTimer
    );

    daydreamTimer = null;

    if (
        daydreamActive
    ) {
        stopDaydream(
            true
        );
    }

    daydreamTimer =
        setTimeout(
            startDaydream,
            DAYDREAM_IDLE_MS
        );
}


function scheduleDaydreamMood() {
    if (
        !daydreamActive
    ) {
        return;
    }

    const delay =
        DAYDREAM_MOOD_MIN_MS +
        Math.random() *
        (
            DAYDREAM_MOOD_MAX_MS -
            DAYDREAM_MOOD_MIN_MS
        );

    daydreamMoodTimer =
        setTimeout(
            () => {
                if (
                    !daydreamActive
                ) {
                    return;
                }

                if (
                    !canDaydream()
                ) {
                    resetDaydreamTimer();
                    return;
                }

                const moods = [
                    "daydream",
                    "daydream",
                    "sleepy",
                    "idle",
                    "happy",
                ];

                const nextMood =
                    moods[
                        Math.floor(
                            Math.random() *
                            moods.length
                        )
                    ];

                setFaceState(
                    nextMood
                );

                scheduleDaydreamMood();
            },
            delay
        );
}


async function fetchDaydreamThought() {
    if (
        !daydreamActive ||
        daydreamThoughtInFlight ||
        !canDaydream()
    ) {
        return;
    }

    daydreamThoughtInFlight = true;

    try {
        const response =
            await fetch(
                "/api/screensaver-thought",
                {
                    method:
                        "GET",

                    cache:
                        "no-store",
                }
            );

        if (
            !response.ok
        ) {
            throw new Error(
                `Daydream thought HTTP ${response.status}`
            );
        }

        const data =
            await response.json();

        if (
            !daydreamActive ||
            !canDaydream()
        ) {
            return;
        }

        const thought =
            String(
                data.thought || ""
            ).trim();

        if (
            thought
        ) {
            daydreamThoughtVisible = true;

            showTranscript(
                thought,
                12000
            );

            setTimeout(
                () => {
                    daydreamThoughtVisible = false;
                },
                12100
            );
        }

    } catch (error) {
        console.debug(
            "Daydream thought failed:",
            error
        );

    } finally {
        daydreamThoughtInFlight = false;
    }
}


function scheduleDaydreamThought() {
    if (
        !daydreamActive
    ) {
        return;
    }

    daydreamThoughtTimer =
        setTimeout(
            async () => {
                if (
                    !daydreamActive
                ) {
                    return;
                }

                await fetchDaydreamThought();

                scheduleDaydreamThought();
            },
            DAYDREAM_THOUGHT_INTERVAL_MS
        );
}


function startDaydream() {
    daydreamTimer = null;

    if (
        !canDaydream()
    ) {
        resetDaydreamTimer();
        return;
    }

    daydreamActive = true;

    setFaceState(
        "daydream"
    );

    showStatus(
        "BMO is daydreaming...",
        2200
    );

    scheduleDaydreamMood();

    daydreamThoughtTimer =
        setTimeout(
            async () => {
                if (
                    !daydreamActive
                ) {
                    return;
                }

                await fetchDaydreamThought();

                scheduleDaydreamThought();
            },
            5000
        );
}


/*
 * Status / transcript
 */

function showStatus(
    text,
    duration = 1800
) {
    clearTimeout(
        statusTimer
    );

    statusMessage.textContent = text;

    statusMessage.classList.remove(
        "hidden"
    );

    if (
        duration > 0
    ) {
        statusTimer =
            setTimeout(
                () => {
                    statusMessage.classList.add(
                        "hidden"
                    );
                },
                duration
            );
    }
}


function showTranscript(
    text,
    duration = 2500
) {
    clearTimeout(
        transcriptTimer
    );

    transcriptElement.textContent = text;

    transcriptElement.classList.add(
        "visible"
    );

    transcriptTimer =
        setTimeout(
            () => {
                transcriptElement.classList.remove(
                    "visible"
                );
            },
            duration
        );
}


/*
 * Backend health / reconnect
 */

function setBackendOnline(
    online
) {
    const changed =
        backendOnline !== online;

    backendOnline = online;

    if (
        !changed
    ) {
        return;
    }

    if (
        online
    ) {
        if (
            !isRecording &&
            bmoRenderer.state !== "speaking"
        ) {
            setFaceState(
                "idle"
            );

            showStatus(
                "BMO brain reconnected",
                1800
            );

            resetDaydreamTimer();
        }

    } else {
        stopDaydream(
            false
        );

        clearTimeout(
            daydreamTimer
        );

        daydreamTimer = null;

        if (
            !isRecording &&
            bmoRenderer.state !== "speaking"
        ) {
            setFaceState(
                "sleepy"
            );

            showStatus(
                "BMO brain offline - reconnecting...",
                0
            );
        }
    }
}


async function checkBackendHealth() {
    let timeoutId = null;

    try {
        const controller =
            new AbortController();

        timeoutId =
            setTimeout(
                () =>
                    controller.abort(),
                BACKEND_CHECK_TIMEOUT_MS
            );

        const response =
            await fetch(
                "/api/status",
                {
                    method:
                        "GET",

                    cache:
                        "no-store",

                    signal:
                        controller.signal,
                }
            );

        clearTimeout(
            timeoutId
        );

        timeoutId = null;

        setBackendOnline(
            response.ok
        );

    } catch (error) {
        if (
            timeoutId
        ) {
            clearTimeout(
                timeoutId
            );
        }

        setBackendOnline(
            false
        );
    }
}


function scheduleBackendChecks() {
    if (
        backendCheckTimer
    ) {
        clearInterval(
            backendCheckTimer
        );
    }

    checkBackendHealth();

    backendCheckTimer =
        setInterval(
            checkBackendHealth,
            BACKEND_CHECK_INTERVAL_MS
        );
}


/*
 * Timer expiry events
 */

async function checkTimerEvents() {
    if (
        !backendOnline
    ) {
        return;
    }

    try {
        const response =
            await fetch(
                "/api/timer-events",
                {
                    method:
                        "GET",

                    cache:
                        "no-store",
                }
            );

        if (
            !response.ok
        ) {
            throw new Error(
                `Timer events HTTP ${response.status}`
            );
        }

        const data =
            await response.json();

        if (
            Array.isArray(
                data.events
            ) &&
            data.events.length > 0
        ) {
            for (
                const event
                of data.events
            ) {
                if (
                    event &&
                    event.event === "timer_finished"
                ) {
                    pendingTimerEvents.push(
                        event
                    );
                }
            }

            processPendingTimerEvents();
        }

    } catch (error) {
        console.debug(
            "Timer event check failed:",
            error
        );
    }
}


async function processPendingTimerEvents() {
    if (
        pendingTimerEvents.length > 0
    ) {
        stopDaydream(
            false
        );

        clearTimeout(
            daydreamTimer
        );

        daydreamTimer = null;
    }

    if (
        processingTimerEvent ||
        pendingTimerEvents.length === 0
    ) {
        return;
    }

    if (
        isRecording ||
        recordingStartPending
    ) {
        return;
    }

    if (
        currentAudio ||
        bmoRenderer.state === "speaking"
    ) {
        return;
    }

    const event =
        pendingTimerEvents.shift();

    if (
        !event
    ) {
        return;
    }

    processingTimerEvent = true;

    const message =
        String(
            event.message ||
            "Timer is up!"
        );

    showTranscript(
        message,
        3500
    );

    if (
        "vibrate" in navigator
    ) {
        navigator.vibrate(
            [
                120,
                80,
                120,
            ]
        );
    }

    if (
        event.audio_url
    ) {
        try {
            await playBMOAudio(
                event.audio_url
            );

        } catch (error) {
            console.error(
                "Timer audio playback failed:",
                error
            );

            processingTimerEvent = false;

            setFaceState(
                "idle"
            );

            showStatus(
                message,
                3000
            );

            processPendingTimerEvents();
        }

        return;
    }

    processingTimerEvent = false;

    setFaceState(
        "surprised"
    );

    showStatus(
        message,
        3000
    );

    setTimeout(
        () => {
            if (
                !isRecording &&
                !currentAudio
            ) {
                setFaceState(
                    "idle"
                );
            }

            processPendingTimerEvents();
        },
        3000
    );
}


function scheduleTimerEventChecks() {
    if (
        timerEventCheckTimer
    ) {
        clearInterval(
            timerEventCheckTimer
        );
    }

    checkTimerEvents();

    timerEventCheckTimer =
        setInterval(
            checkTimerEvents,
            TIMER_EVENT_CHECK_INTERVAL_MS
        );
}


/*
 * Stop current BMO speech
 */

function stopCurrentAudio() {
    if (
        !currentAudio
    ) {
        return;
    }

    try {
        currentAudio.pause();
        currentAudio.currentTime = 0;

    } catch (_) {
    }

    currentAudio = null;
    pendingExpression = null;

    bmoRenderer.mouthOpen = 0;
}


/*
 * Wake lock
 */

async function requestWakeLock() {
    if (
        !(
            "wakeLock" in navigator
        ) ||
        wakeLock
    ) {
        return;
    }

    try {
        wakeLock =
            await navigator.wakeLock.request(
                "screen"
            );

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
 * Browser recorder format
 */

function getRecorderOptions() {
    const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
    ];

    for (
        const mimeType
        of candidates
    ) {
        if (
            window.MediaRecorder &&
            MediaRecorder.isTypeSupported(
                mimeType
            )
        ) {
            return {
                mimeType:
                    mimeType,
            };
        }
    }

    return {};
}


/*
 * Recording
 */

async function startRecording() {
    resetDaydreamTimer();

    if (
        isRecording ||
        recordingStartPending
    ) {
        return;
    }

    if (
        !backendOnline
    ) {
        setFaceState(
            "sleepy"
        );

        showStatus(
            "BMO brain offline - reconnecting...",
            0
        );

        checkBackendHealth();

        return;
    }

    if (
        bmoRenderer.state === "speaking" ||
        currentAudio
    ) {
        stopCurrentAudio();
    }

    recordingStartPending = true;

    const nativeBridge =
        getNativeBridge();

    if (
        nativeBridge
    ) {
        try {
            nativeBridge.startRecording();

            return;

        } catch (error) {
            recordingStartPending = false;

            console.error(
                "Native microphone bridge failed:",
                error
            );

            setFaceState(
                "error"
            );

            showStatus(
                "Microphone connection failed",
                2500
            );

            setTimeout(
                () =>
                    setFaceState(
                        "idle"
                    ),
                1500
            );

            return;
        }
    }

    if (
        nativeShellRequested
    ) {
        recordingStartPending = false;

        console.error(
            "Android microphone bridge is missing."
        );

        setFaceState(
            "error"
        );

        showStatus(
            "Microphone connection failed",
            2500
        );

        setTimeout(
            () =>
                setFaceState(
                    "idle"
                ),
            1500
        );

        return;
    }

    try {
        await requestWakeLock();

        if (
            !navigator.mediaDevices ||
            !navigator.mediaDevices
                .getUserMedia
        ) {
            throw new Error(
                "getUserMedia is unavailable"
            );
        }

        microphoneStream =
            await navigator.mediaDevices
                .getUserMedia(
                    {
                        audio: {
                            echoCancellation:
                                true,

                            noiseSuppression:
                                true,

                            autoGainControl:
                                true,
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
                if (
                    event.data.size > 0
                ) {
                    audioChunks.push(
                        event.data
                    );
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
                            type:
                                mimeType,
                        }
                    );

                if (
                    microphoneStream
                ) {
                    for (
                        const track
                        of microphoneStream
                            .getTracks()
                    ) {
                        track.stop();
                    }

                    microphoneStream = null;
                }

                await sendAudioToBMO(
                    blob
                );
            }
        );

        mediaRecorder.start();

        recordingStartPending = false;
        isRecording = true;

        setFaceState(
            "listening"
        );

        showStatus(
            "Listening...",
            0
        );

        if (
            "vibrate" in navigator
        ) {
            navigator.vibrate(
                30
            );
        }

    } catch (error) {
        recordingStartPending = false;

        console.error(
            "Browser microphone error:",
            error
        );

        setFaceState(
            "error"
        );

        showStatus(
            "Microphone unavailable",
            3000
        );

        setTimeout(
            () =>
                setFaceState(
                    "idle"
                ),
            1500
        );
    }
}


function stopRecording() {
    if (
        recordingStartPending &&
        !isRecording
    ) {
        return;
    }

    const nativeBridge =
        getNativeBridge();

    if (
        nativeBridge
    ) {
        if (
            !isRecording
        ) {
            return;
        }

        try {
            nativeBridge.stopRecording();

        } catch (error) {
            console.error(
                "Native microphone stop failed:",
                error
            );

            setFaceState(
                "error"
            );

            showStatus(
                "Microphone connection failed",
                2500
            );
        }

        return;
    }

    if (
        nativeShellRequested
    ) {
        return;
    }

    if (
        !mediaRecorder ||
        !isRecording
    ) {
        return;
    }

    isRecording = false;
    recordingStartPending = false;

    setFaceState(
        "thinking"
    );

    showStatus(
        "Thinking...",
        0
    );

    mediaRecorder.stop();

    if (
        "vibrate" in navigator
    ) {
        navigator.vibrate(
            20
        );
    }
}


/*
 * Hold interaction
 */

function cancelPendingHold() {
    if (
        holdStartTimer
    ) {
        clearTimeout(
            holdStartTimer
        );

        holdStartTimer = null;
    }
}


function beginHold(event) {
    resetDaydreamTimer();

    if (
        activePointerId !== null
    ) {
        return;
    }

    activePointerId =
        event.pointerId;

    if (
        bmoRenderer.state === "speaking" ||
        currentAudio
    ) {
        stopCurrentAudio();

        setFaceState(
            "idle"
        );

        showStatus(
            "Hold to talk",
            0
        );
    }

    if (
        screen.setPointerCapture
    ) {
        try {
            screen.setPointerCapture(
                event.pointerId
            );

        } catch (_) {
        }
    }

    holdStartTimer =
        setTimeout(
            async () => {
                holdStartTimer = null;

                await startRecording();
            },
            HOLD_START_DELAY_MS
        );
}


function endHold(
    event = null
) {
    if (
        event &&
        activePointerId !== null &&
        event.pointerId !== activePointerId
    ) {
        return;
    }

    const timerWasPending =
        holdStartTimer !== null;

    cancelPendingHold();

    activePointerId = null;

    if (
        timerWasPending
    ) {
        if (
            backendOnline
        ) {
            setFaceState(
                "idle"
            );

            showStatus(
                "Hold to talk",
                1000
            );
        }

        return;
    }

    if (
        isRecording
    ) {
        stopRecording();
    }
}


/*
 * STT
 */

async function sendAudioToBMO(
    blob
) {
    const formData =
        new FormData();

    let extension =
        "webm";

    if (
        blob.type.includes(
            "mp4"
        )
    ) {
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
                    method:
                        "POST",

                    body:
                        formData,
                }
            );

        if (
            !response.ok
        ) {
            throw new Error(
                `Transcription HTTP ${response.status}`
            );
        }

        const data =
            await response.json();

        setBackendOnline(
            true
        );

        if (
            !data.text
        ) {
            setFaceState(
                "idle"
            );

            showStatus(
                "I didn't catch that",
                1800
            );

            return;
        }

        showTranscript(
            data.text
        );

        await sendMessage(
            data.text
        );

    } catch (error) {
        setBackendOnline(
            false
        );

        console.error(
            "Transcription error:",
            error
        );

        setFaceState(
            "sleepy"
        );

        showStatus(
            "BMO brain offline - reconnecting...",
            0
        );
    }
}


/*
 * Chat
 */

async function sendMessage(
    text
) {
    setFaceState(
        "thinking"
    );

    showStatus(
        "Thinking...",
        0
    );

    try {
        const response =
            await fetch(
                "/api/chat",
                {
                    method:
                        "POST",

                    headers: {
                        "Content-Type":
                            "application/json",
                    },

                    body:
                        JSON.stringify(
                            {
                                message:
                                    text,

                                history:
                                    conversationHistory,

                                play_on_hardware:
                                    false,
                            }
                        ),
                }
            );

        if (
            !response.ok
        ) {
            throw new Error(
                `Chat HTTP ${response.status}`
            );
        }

        const data =
            await response.json();

        setBackendOnline(
            true
        );

        if (
            data.history
        ) {
            conversationHistory =
                data.history;
        }

        const handledServerAction =
            handleServerAction(
                data.action,
                Boolean(
                    data.audio_url
                )
            );

        if (
            data.audio_url
        ) {
            await playBMOAudio(
                data.audio_url
            );

            return;
        }

        if (
            handledServerAction
        ) {
            return;
        }

        setFaceState(
            "idle"
        );

        showStatus(
            "Ready",
            1200
        );

    } catch (error) {
        setBackendOnline(
            false
        );

        console.error(
            "Chat error:",
            error
        );

        setFaceState(
            "sleepy"
        );

        showStatus(
            "BMO brain offline - reconnecting...",
            0
        );
    }
}


/*
 * Audio playback
 */

async function playBMOAudio(
    audioUrl
) {
    stopDaydream(
        false
    );

    clearTimeout(
        daydreamTimer
    );

    daydreamTimer = null;

    stopCurrentAudio();

    currentAudio =
        new Audio(
            audioUrl
        );

    const thisAudio =
        currentAudio;

    setFaceState(
        "speaking"
    );

    showStatus(
        "Speaking...",
        1200
    );

    setupVisualizer(
        thisAudio
    );

    thisAudio.addEventListener(
        "ended",
        () => {
            if (
                currentAudio !== thisAudio
            ) {
                return;
            }

            currentAudio = null;

            if (
                processingTimerEvent
            ) {
                processingTimerEvent = false;
            }

            const expressionApplied =
                applyPendingExpression();

            if (
                !expressionApplied
            ) {
                setFaceState(
                    "idle"
                );
            }

            showStatus(
                "Hold to talk",
                1200
            );

            processPendingTimerEvents();
            resetDaydreamTimer();
        }
    );

    thisAudio.addEventListener(
        "error",
        (error) => {
            if (
                currentAudio !== thisAudio
            ) {
                return;
            }

            console.error(
                "Audio playback error:",
                error
            );

            currentAudio = null;

            if (
                processingTimerEvent
            ) {
                processingTimerEvent = false;
            }

            setFaceState(
                "error"
            );

            showStatus(
                "Audio playback failed",
                2200
            );

            setTimeout(
                () =>
                    setFaceState(
                        "idle"
                    ),
                1500
            );
        }
    );

    try {
        await thisAudio.play();

    } catch (error) {
        if (
            currentAudio !== thisAudio
        ) {
            return;
        }

        console.error(
            "Audio autoplay error:",
            error
        );

        currentAudio = null;

        if (
            processingTimerEvent
        ) {
            processingTimerEvent = false;
        }

        setFaceState(
            "idle"
        );

        processPendingTimerEvents();

        showStatus(
            "Tap once, then try again",
            2500
        );
    }
}


/*
 * Lip sync
 */

function setupVisualizer(
    audioElement
) {
    if (
        !audioContext
    ) {
        audioContext =
            new (
                window.AudioContext ||
                window.webkitAudioContext
            )();
    }

    const source =
        audioContext
            .createMediaElementSource(
                audioElement
            );

    analyser =
        audioContext
            .createAnalyser();

    analyser.fftSize = 256;

    source.connect(
        analyser
    );

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
            sum +=
                Math.abs(
                    dataArray[index] - 128
                );
        }

        bmoRenderer.mouthOpen =
            (
                sum /
                dataArray.length
            ) * 4;

        requestAnimationFrame(
            syncMouth
        );
    }

    syncMouth();
}


/*
 * Touch controls
 */

screen.addEventListener(
    "pointerdown",
    (event) => {
        event.preventDefault();

        beginHold(
            event
        );
    }
);


screen.addEventListener(
    "pointerup",
    (event) => {
        event.preventDefault();

        endHold(
            event
        );
    }
);


screen.addEventListener(
    "pointercancel",
    (event) => {
        endHold(
            event
        );
    }
);


window.addEventListener(
    "blur",
    () => {
        cancelPendingHold();

        activePointerId = null;

        if (
            isRecording
        ) {
            stopRecording();
        }
    }
);


/*
 * Wake lock
 */

document.addEventListener(
    "visibilitychange",
    async () => {
        if (
            document.visibilityState === "visible"
        ) {
            await requestWakeLock();

            checkBackendHealth();
        }
    }
);


document.addEventListener(
    "pointerdown",
    () => {
        requestWakeLock();
    },
    {
        once:
            true,
    }
);


/*
 * Browser/PWA support
 */

if (
    "serviceWorker" in navigator &&
    !nativeShellRequested
) {
    window.addEventListener(
        "load",
        async () => {
            try {
                await navigator
                    .serviceWorker
                    .register(
                        "/static/sw.js",
                        {
                            scope:
                                "/static/",
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
 * Native Android callbacks
 */

window.onNativeRecordingStarted =
    function () {
        resetDaydreamTimer();

        recordingStartPending = false;
        isRecording = true;

        setFaceState(
            "listening"
        );

        showStatus(
            "Listening...",
            0
        );

        if (
            "vibrate" in navigator
        ) {
            navigator.vibrate(
                30
            );
        }
    };


window.onNativeRecordingStopped =
    function () {
        recordingStartPending = false;
        isRecording = false;

        setFaceState(
            "thinking"
        );

        showStatus(
            "Thinking...",
            0
        );

        if (
            "vibrate" in navigator
        ) {
            navigator.vibrate(
                20
            );
        }

        processPendingTimerEvents();
    };


window.onNativeTranscript =
    async function (
        text
    ) {
        resetDaydreamTimer();

        recordingStartPending = false;
        isRecording = false;

        setBackendOnline(
            true
        );

        const cleanedText =
            String(
                text || ""
            ).trim();

        if (
            !cleanedText
        ) {
            setFaceState(
                "idle"
            );

            showStatus(
                "I didn't catch that",
                1800
            );

            return;
        }

        showTranscript(
            cleanedText
        );

        await sendMessage(
            cleanedText
        );
    };


window.onNativeNoSpeech =
    function () {
        resetDaydreamTimer();

        recordingStartPending = false;
        isRecording = false;

        setBackendOnline(
            true
        );

        setFaceState(
            "idle"
        );

        showStatus(
            "I didn't catch that",
            1800
        );

        processPendingTimerEvents();
    };


window.onNativeMicError =
    function (
        message
    ) {
        recordingStartPending = false;
        isRecording = false;

        const errorText =
            String(
                message || ""
            );

        console.error(
            "Native microphone error:",
            errorText
        );

        if (
            errorText
                .toLowerCase()
                .includes(
                    "transcription"
                )
        ) {
            setBackendOnline(
                false
            );

            setFaceState(
                "sleepy"
            );

            showStatus(
                "BMO brain offline - reconnecting...",
                0
            );

            return;
        }

        setFaceState(
            "error"
        );

        showStatus(
            errorText ||
                "Microphone error",
            2500
        );

        setTimeout(
            () => {
                setFaceState(
                    "idle"
                );
            },
            1800
        );
    };


/*
 * Initial state
 */

setFaceState(
    "idle"
);

showStatus(
    "Hold anywhere to talk",
    3500
);

scheduleBackendChecks();
scheduleTimerEventChecks();
resetDaydreamTimer();
