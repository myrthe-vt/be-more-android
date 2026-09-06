

/*
 * =====================================================================
 * BMO CLIENT ERROR REPORTING
 * =====================================================================
 *
 * Keep this deliberately small:
 * - uncaught JavaScript errors
 * - unhandled Promise rejections
 *
 * Existing targeted console.error() calls remain untouched.
 */

function bmoErrorText(
    value
) {
    if (
        value === null ||
        value === undefined
    ) {
        return "";
    }

    if (
        value instanceof Error
    ) {
        return (
            value.stack ||
            value.message ||
            String(value)
        );
    }

    if (
        typeof value ===
        "string"
    ) {
        return value;
    }

    try {
        return JSON.stringify(
            value
        );
    } catch (
        error
    ) {
        return String(
            value
        );
    }
}


function reportBmoClientError(
    message,
    detail = "",
    location = {}
) {
    const payload = {
        source:
            "frontend",

        message:
            String(
                message ||
                "Unknown frontend error"
            ).slice(
                0,
                1000
            ),

        detail:
            String(
                detail || ""
            ).slice(
                0,
                4000
            ),

        url:
            location.url ||
            window.location.href,

        line:
            Number.isFinite(
                location.line
            )
                ? location.line
                : null,

        column:
            Number.isFinite(
                location.column
            )
                ? location.column
                : null,
    };

    /*
     * Never allow diagnostics reporting itself to create a new
     * unhandled rejection.
     */
    fetch(
        "/api/client-error",
        {
            method:
                "POST",

            headers: {
                "Content-Type":
                    "application/json",
            },

            body:
                JSON.stringify(
                    payload
                ),

            cache:
                "no-store",
        }
    ).catch(
        () => {
            // Backend may itself be offline.
        }
    );
}


window.addEventListener(
    "error",
    (
        event
    ) => {
        const errorDetail =
            bmoErrorText(
                event.error
            );

        reportBmoClientError(
            event.message ||
                "Uncaught JavaScript error",

            errorDetail,

            {
                url:
                    event.filename ||
                    window.location.href,

                line:
                    Number(
                        event.lineno
                    ),

                column:
                    Number(
                        event.colno
                    ),
            }
        );
    }
);


window.addEventListener(
    "unhandledrejection",
    (
        event
    ) => {
        const detail =
            bmoErrorText(
                event.reason
            );

        let message =
            "Unhandled Promise rejection";

        if (
            event.reason instanceof
            Error &&
            event.reason.message
        ) {
            message =
                event.reason.message;

        } else if (
            typeof event.reason ===
            "string" &&
            event.reason
        ) {
            message =
                event.reason;
        }

        reportBmoClientError(
            message,
            detail,
            {
                url:
                    window.location.href,
            }
        );
    }
);



const screen = document.getElementById("bmo-screen");
const faceCanvas = document.getElementById("bmo-face-canvas");
const statusMessage = document.getElementById("status-message");
const transcriptElement = document.getElementById("transcript");

const pageParams = new URLSearchParams(window.location.search);
const nativeShellRequested = pageParams.get("native") === "1";

const HOLD_START_DELAY_MS = 120;
const BACKEND_CHECK_INTERVAL_MS = 5000;
const BACKEND_CHECK_TIMEOUT_MS = 3000;

const BACKEND_RECOVERY_RELOAD_AFTER_MS = 15000;
const BACKEND_RECOVERY_RETRY_MS = 2000;
const BACKEND_RECOVERY_MAX_WAIT_MS = 30000;

const TIMER_EVENT_CHECK_INTERVAL_MS = 1000;
const DEVICE_STATE_CHECK_INTERVAL_MS = 3000;
const CHARGER_REACTION_DURATION_MS = 3200;
const CHARGER_REACTION_COOLDOWN_MS = 1500;

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
        this.canvas =
            canvas;

        this.ctx =
            canvas.getContext(
                "2d"
            );

        this.width =
            canvas.width;

        this.height =
            canvas.height;

        this.ctx.imageSmoothingEnabled =
            true;

        this.ctx.imageSmoothingQuality =
            "high";

        this.backgroundColor =
            "#c9e4c3";

        this.state =
            "idle";

        /*
         * Kept for compatibility with the existing audio visualizer.
         *
         * setupVisualizer() already writes bmoRenderer.mouthOpen.
         * Instead of stretching a procedural mouth, we now map that
         * value onto BMO's real artist-drawn speaking viseme frames.
         */
        this.mouthOpen =
            0;

        this.frames =
            new Map();

        this.loadingStates =
            new Set();

        this.failedStates =
            new Set();

        this.playOnceStates =
            new Set(
                [
                    "warmup",
                ]
            );

        this.lastState =
            null;

        this.frameIndex =
            0;

        this.lastFrameAt =
            0;

        this.lastSpeakingFrame =
            0;

        /*
         * Startup deliberately loads warmup first so the animation
         * cannot disappear behind the idle fallback while assets load.
         */
    }


    get knownStates() {
        return [
            "idle",
            "listening",
            "thinking",
            "speaking",
            "happy",
            "sad",
            "angry",
            "surprised",
            "sleepy",
            "daydream",
            "dizzy",
            "cheeky",
            "heart",
            "starry_eyed",
            "confused",
            "shhh",
            "jamming",
            "football",
            "detective",
            "sir_mano",
            "low_battery",
            "bee",
            "ladybug",
            "worm",
            "bored",
            "curious",
            "error",
            "capturing",
            "warmup",
        ];
    }


    getFrameDelay(
        state
    ) {
        switch (
            state
        ) {
            case "idle":
                /*
                 * The idle set contains its own long blink cycle.
                 */
                return 120;

            case "listening":
                return 120;

            case "thinking":
                return 130;

            case "daydream":
                return 160;

            case "sleepy":
                return 220;

            case "bee":
            case "ladybug":
            case "worm":
                return 110;

            case "jamming":
                return 90;

            case "dizzy":
                return 130;

            case "warmup":
                return 260;

            default:
                return 140;
        }
    }


    async preloadStates() {
        for (
            const state
            of this.knownStates
        ) {
            this.loadState(
                state
            );
        }
    }


    async loadState(
        state
    ) {
        if (
            this.frames.has(
                state
            ) ||
            this.loadingStates.has(
                state
            ) ||
            this.failedStates.has(
                state
            )
        ) {
            return;
        }

        this.loadingStates.add(
            state
        );

        try {
            const response =
                await fetch(
                    `/api/faces/${encodeURIComponent(state)}`,
                    {
                        cache:
                            "no-store",
                    }
                );

            if (
                !response.ok
            ) {
                throw new Error(
                    `Face list HTTP ${response.status}`
                );
            }

            const data =
                await response.json();

            let paths =
                Array.isArray(
                    data.images
                )
                    ? data.images
                    : [];

            /*
             * Some folders contain old duplicate files such as:
             *
             *     speaking 01.png
             *     speaking_01.png
             *
             * Prefer the generated underscore naming convention whenever
             * it exists.
             */
            const cleanPaths =
                paths.filter(
                    (imagePath) => {
                        const filename =
                            String(
                                imagePath
                            )
                                .split("/")
                                .pop();

                        return filename
                            .startsWith(
                                `${state}_`
                            );
                    }
                );

            if (
                cleanPaths.length >
                0
            ) {
                paths =
                    cleanPaths;
            }

            if (
                paths.length ===
                0
            ) {
                throw new Error(
                    `No frames found for ${state}`
                );
            }

            const images =
                await Promise.all(
                    paths.map(
                        (imagePath) =>
                            new Promise(
                                (
                                    resolve,
                                    reject
                                ) => {
                                    const image =
                                        new Image();

                                    image.onload =
                                        () => {
                                            resolve(
                                                image
                                            );
                                        };

                                    image.onerror =
                                        () => {
                                            reject(
                                                new Error(
                                                    `Could not load ${imagePath}`
                                                )
                                            );
                                        };

                                    image.src =
                                        `${imagePath}?v=2`;
                                }
                            )
                    )
                );

            this.frames.set(
                state,
                images
            );

            console.log(
                `Loaded ${images.length} BMO face frames for ${state}`
            );

        } catch (error) {
            console.warn(
                `Could not load BMO face state ${state}:`,
                error
            );

            this.failedStates.add(
                state
            );

        } finally {
            this.loadingStates.delete(
                state
            );
        }
    }


    isPlayOnceState(
        state
    ) {
        return this.playOnceStates.has(
            state
        );
    }


    clear() {
        this.ctx.fillStyle =
            this.backgroundColor;

        this.ctx.fillRect(
            0,
            0,
            this.width,
            this.height
        );
    }


    drawImageFrame(
        image
    ) {
        this.clear();

        if (
            !image
        ) {
            return;
        }

        /*
         * Generated face PNGs are 800x480, but draw them against the
         * actual canvas dimensions anyway so this remains future-proof.
         */
        this.ctx.drawImage(
            image,
            0,
            0,
            this.width,
            this.height
        );
    }


    getSpeakingFrameIndex(
        frameCount
    ) {
        if (
            frameCount <=
            1
        ) {
            return 0;
        }

        /*
         * mouthOpen is now normalized by setupVisualizer():
         *
         *     0.0 = silence / closed mouth
         *     1.0 = strong speech / widest mouth
         *
         * Spread that smoothly across however many artist-drawn
         * viseme frames are available.
         */
        const level =
            Math.max(
                0,
                Math.min(
                    1,
                    Number(
                        this.mouthOpen
                    ) || 0
                )
            );

        let target =
            Math.round(
                level *
                (
                    frameCount -
                    1
                )
            );

        /*
         * Speech looks much more natural if the mouth does not jump
         * directly from fully open to fully closed.
         */
        if (
            target >
            this.lastSpeakingFrame +
                1
        ) {
            target =
                this.lastSpeakingFrame +
                1;
        }

        if (
            target <
            this.lastSpeakingFrame -
                1
        ) {
            target =
                this.lastSpeakingFrame -
                1;
        }

        target =
            Math.max(
                0,
                Math.min(
                    frameCount - 1,
                    target
                )
            );

        this.lastSpeakingFrame =
            target;

        return target;
    }

    render() {
        const now =
            performance.now();

        const state =
            this.frames.has(
                this.state
            )
                ? this.state
                : "idle";

        if (
            !this.frames.has(
                this.state
            ) &&
            !this.loadingStates.has(
                this.state
            ) &&
            !this.failedStates.has(
                this.state
            )
        ) {
            this.loadState(
                this.state
            );
        }

        if (
            state !==
            this.lastState
        ) {
            this.lastState =
                state;

            this.frameIndex =
                0;

            this.lastFrameAt =
                now;

            if (
                state !==
                "speaking"
            ) {
                this.lastSpeakingFrame =
                    0;
            }
        }

        const stateFrames =
            this.frames.get(
                state
            );

        if (
            stateFrames &&
            stateFrames.length >
                0
        ) {
            if (
                state ===
                "speaking"
            ) {
                const index =
                    this.getSpeakingFrameIndex(
                        stateFrames.length
                    );

                this.drawImageFrame(
                    stateFrames[
                        index
                    ]
                );

            } else {
                const delay =
                    this.getFrameDelay(
                        state
                    );

                if (
                    now -
                    this.lastFrameAt >=
                    delay
                ) {
                    if (
                        this.isPlayOnceState(
                            state
                        )
                    ) {
                        this.frameIndex =
                            Math.min(
                                this.frameIndex +
                                    1,
                                stateFrames.length -
                                    1
                            );

                    } else {
                        this.frameIndex =
                            (
                                this.frameIndex +
                                1
                            ) %
                            stateFrames.length;
                    }

                    this.lastFrameAt =
                        now;
                }

                this.drawImageFrame(
                    stateFrames[
                        this.frameIndex
                    ]
                );
            }

        } else {
            this.clear();
        }

        requestAnimationFrame(
            () => {
                this.render();
            }
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

// BMO_VOICE_DUCKING_V1
let voiceInteractionDuckingActive = false;

let holdStartTimer = null;
let activePointerId = null;

let backendOnline = true;
let backendCheckTimer = null;

let backendOfflineSince = null;
let backendRecoveryTimer = null;
let backendRecoveryStartedAt = null;

let timerEventCheckTimer = null;
let pendingTimerEvents = [];
let processingTimerEvent = false;

let deviceStateCheckTimer = null;
let automaticLowBatteryActive = false;

let lastBatteryChargingState = null;
let lastChargerReactionAt = 0;
let chargerReactionTimer = null;

let currentAudio = null;

let statusTimer = null;
let transcriptTimer = null;

let audioContext = null;
let analyser = null;
let dataArray = null;

let wakeLock = null;

let pendingExpression = null;
let expressionTimer = null;

let pendingCaptureAction = null;
let pendingDeviceAction = null;

let daydreamTimer = null;
let daydreamThoughtTimer = null;
let daydreamMoodTimer = null;

let daydreamActive = false;
let daydreamThoughtInFlight = false;
let daydreamThoughtVisible = false;


/*
 * Face state / expressions
 */

function setFaceState(
    state
) {
    bmoRenderer.state =
        state;

    maybeEndVoiceInteractionDucking(
        state
    );

    if (
        state !==
        "speaking"
    ) {
        bmoRenderer.mouthOpen =
            0;
    }

    bmoRenderer.eyeOffsetY =
        0;
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
            "dizzy",
            "cheeky",
            "heart",
            "starry_eyed",
            "confused",
            "shhh",
            "jamming",
            "football",
            "detective",
            "sir_mano",
            "low_battery",
            "bee",
            "ladybug",
            "worm",
            "bored",
            "curious",
            "error",
            "capturing",
            "warmup",
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

    pendingExpression =
        null;

    setFaceState(
        expression
    );

    expressionTimer =
        setTimeout(
            () => {
                expressionTimer =
                    null;

                if (
                    !isRecording &&
                    !recordingStartPending &&
                    !currentAudio &&
                    bmoRenderer.state ===
                        expression
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


/*
 * Native vision
 */

function startNativeVisionCapture(
    prompt
) {
    const nativeBridge =
        getNativeBridge();

    if (
        !nativeBridge
    ) {
        console.error(
            "Native Android bridge unavailable"
        );

        setFaceState(
            "error"
        );

        showStatus(
            "Camera unavailable",
            2500
        );

        setTimeout(
            () => {
                setFaceState(
                    "idle"
                );

                resetDaydreamTimer();
            },
            1800
        );

        return;
    }

    stopDaydream(
        false
    );

    clearTimeout(
        daydreamTimer
    );

    daydreamTimer =
        null;

    setFaceState(
        "thinking"
    );

    showStatus(
        "Looking...",
        0
    );

    try {
        console.log(
            "Calling AndroidBMO.captureImage()"
        );

        nativeBridge.captureImage(
            String(
                prompt ||
                "What are you looking at?"
            )
        );

    } catch (error) {
        console.error(
            "AndroidBMO.captureImage failed:",
            error
        );

        setFaceState(
            "error"
        );

        showStatus(
            "Camera bridge failed",
            2500
        );

        resetDaydreamTimer();
    }

}


function runPendingCaptureAction() {
    if (
        !pendingCaptureAction
    ) {
        return false;
    }

    const action =
        pendingCaptureAction;

    pendingCaptureAction =
        null;

    startNativeVisionCapture(
        action.prompt
    );

    return true;
}


/*
 * Native Android device state
 */

function readNativeBatteryState() {
    const nativeBridge =
        getNativeBridge();

    if (
        !nativeBridge
    ) {
        throw new Error(
            "Native Android bridge unavailable"
        );
    }

    const rawState =
        nativeBridge.getBatteryState();

    const state =
        JSON.parse(
            String(
                rawState ||
                "{}"
            )
        );

    if (
        !state ||
        state.available !==
            true
    ) {
        throw new Error(
            "Battery state unavailable"
        );
    }

    return state;
}


async function sendNativeBatteryState(
    action
) {
    stopDaydream(
        false
    );

    clearTimeout(
        daydreamTimer
    );

    daydreamTimer =
        null;

    setFaceState(
        "thinking"
    );

    showStatus(
        "Checking battery...",
        0
    );

    try {
        const batteryState =
            readNativeBatteryState();

        const batteryPercent =
            Number(
                batteryState.battery_percent
            );

        const charging =
            Boolean(
                batteryState.charging
            );

        if (
            Number.isFinite(
                batteryPercent
            ) &&
            batteryPercent <= 15 &&
            !charging
        ) {
            setFaceState(
                "low_battery"
            );

        } else {
            setFaceState(
                "thinking"
            );
        }

        const response =
            await fetch(
                "/api/device-battery",
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
                                    String(
                                        action.message ||
                                        ""
                                    ),

                                battery_percent:
                                    batteryState.battery_percent,

                                charging:
                                    Boolean(
                                        batteryState.charging
                                    ),
                            }
                        ),
                }
            );

        if (
            !response.ok
        ) {
            throw new Error(
                `Device battery HTTP ${response.status}`
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

        if (
            data.response
        ) {
            showTranscript(
                data.response,
                3500
            );
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

        resetDaydreamTimer();

    } catch (error) {
        console.error(
            "Android battery state failed:",
            error
        );

        setFaceState(
            "error"
        );

        showStatus(
            "Battery status unavailable",
            2500
        );

        setTimeout(
            () => {
                setFaceState(
                    "idle"
                );

                resetDaydreamTimer();
            },
            1800
        );
    }
}


function runPendingDeviceAction() {
    if (
        !pendingDeviceAction
    ) {
        return false;
    }

    const action =
        pendingDeviceAction;

    pendingDeviceAction =
        null;

    sendNativeBatteryState(
        action
    );

    return true;
}


/*
 * Native Android network state
 */

function readNativeNetworkState() {
    const nativeBridge =
        getNativeBridge();

    if (
        !nativeBridge
    ) {
        throw new Error(
            "Native Android bridge unavailable"
        );
    }

    const rawState =
        nativeBridge.getNetworkState();

    const state =
        JSON.parse(
            String(
                rawState ||
                "{}"
            )
        );

    if (
        !state ||
        state.available !==
            true
    ) {
        throw new Error(
            "Network state unavailable"
        );
    }

    return state;
}


async function sendNativeNetworkState(
    action
) {
    stopDaydream(
        false
    );

    setFaceState(
        "thinking"
    );

    showStatus(
        "Checking connection...",
        0
    );

    try {
        const networkState =
            readNativeNetworkState();

        const response =
            await fetch(
                "/api/device-network",
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
                                    String(
                                        action.message ||
                                        ""
                                    ),

                                connected:
                                    Boolean(
                                        networkState.connected
                                    ),

                                network_type:
                                    String(
                                        networkState.network_type ||
                                        "none"
                                    ),
                            }
                        ),
                }
            );

        if (
            !response.ok
        ) {
            throw new Error(
                `Device network HTTP ${response.status}`
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

        if (
            data.response
        ) {
            showTranscript(
                data.response,
                3500
            );
        }

        if (
            data.audio_url
        ) {
            await playBMOAudio(
                data.audio_url
            );

            return;
        }

        setFaceState(
            "idle"
        );

        resetDaydreamTimer();

    } catch (error) {
        console.error(
            "Android network state failed:",
            error
        );

        setFaceState(
            "error"
        );

        showStatus(
            "Network status unavailable",
            2500
        );

        setTimeout(
            () => {
                setFaceState(
                    "idle"
                );

                resetDaydreamTimer();
            },
            1800
        );
    }
}


/*
 * Automatic Android battery monitoring
 */

function canShowDeviceReaction() {
    return (
        backendOnline &&
        !isRecording &&
        !recordingStartPending &&
        !currentAudio &&
        !processingTimerEvent &&
        pendingTimerEvents.length ===
            0 &&
        !pendingCaptureAction &&
        !pendingDeviceAction &&
        ![
            "listening",
            "thinking",
            "speaking",
            "capturing",
            "warmup",
        ].includes(
            bmoRenderer.state
        )
    );
}


function showChargerReaction(
    charging,
    batteryPercent
) {
    if (
        !canShowDeviceReaction()
    ) {
        return;
    }

    const now =
        Date.now();

    if (
        now -
            lastChargerReactionAt <
        CHARGER_REACTION_COOLDOWN_MS
    ) {
        return;
    }

    lastChargerReactionAt =
        now;

    clearTimeout(
        chargerReactionTimer
    );

    stopDaydream(
        false
    );

    clearTimeout(
        daydreamTimer
    );

    daydreamTimer =
        null;

    if (
        charging
    ) {
        setFaceState(
            "heart"
        );

        showStatus(
            "Yay, power!",
            2200
        );

    } else {
        setFaceState(
            "curious"
        );

        showStatus(
            "Running on battery",
            1800
        );
    }

    chargerReactionTimer =
        setTimeout(
            () => {
                chargerReactionTimer =
                    null;

                if (
                    !canShowDeviceReaction()
                ) {
                    return;
                }

                if (
                    !charging &&
                    Number.isFinite(
                        batteryPercent
                    ) &&
                    batteryPercent <=
                        15
                ) {
                    setFaceState(
                        "low_battery"
                    );

                } else {
                    setFaceState(
                        "idle"
                    );
                }

                resetDaydreamTimer();
            },
            CHARGER_REACTION_DURATION_MS
        );
}


function canShowAutomaticLowBattery() {
    return (
        !isRecording &&
        !recordingStartPending &&
        !currentAudio &&
        !processingTimerEvent &&
        pendingTimerEvents.length ===
            0 &&
        !pendingCaptureAction &&
        !pendingDeviceAction &&
        (
            bmoRenderer.state ===
                "idle" ||
            bmoRenderer.state ===
                "daydream" ||
            bmoRenderer.state ===
                "sleepy" ||
            bmoRenderer.state ===
                "bored" ||
            bmoRenderer.state ===
                "low_battery"
        )
    );
}


function updateAutomaticBatteryFace() {
    const nativeBridge =
        getNativeBridge();

    if (
        !nativeBridge
    ) {
        return;
    }

    try {
        const batteryState =
            readNativeBatteryState();

        const batteryPercent =
            Number(
                batteryState.battery_percent
            );

        const charging =
            Boolean(
                batteryState.charging
            );

        console.log(
            "BMO battery poll:",
            batteryPercent + "%",
            "charging:",
            charging,
            "previous:",
            lastBatteryChargingState
        );

        if (
            lastBatteryChargingState ===
            null
        ) {
            lastBatteryChargingState =
                charging;

        } else if (
            charging !==
            lastBatteryChargingState
        ) {
            const previousChargingState =
                lastBatteryChargingState;

            lastBatteryChargingState =
                charging;

            console.log(
                "BMO charger state changed:",
                previousChargingState,
                "->",
                charging
            );

            showChargerReaction(
                charging,
                batteryPercent
            );
        }

        const shouldUseLowBattery =
            Number.isFinite(
                batteryPercent
            ) &&
            batteryPercent <= 15 &&
            !charging;

        if (
            shouldUseLowBattery
        ) {
            automaticLowBatteryActive =
                true;

            if (
                chargerReactionTimer ===
                    null &&
                canShowAutomaticLowBattery()
            ) {
                stopDaydream(
                    false
                );

                setFaceState(
                    "low_battery"
                );
            }

            return;
        }

        if (
            chargerReactionTimer ===
                null &&
            automaticLowBatteryActive
        ) {
            automaticLowBatteryActive =
                false;

            if (
                bmoRenderer.state ===
                    "low_battery"
            ) {
                setFaceState(
                    "idle"
                );

                resetDaydreamTimer();
            }
        }

    } catch (error) {
        console.debug(
            "Automatic battery check failed:",
            error
        );
    }
}


function scheduleDeviceStateChecks() {
    if (
        deviceStateCheckTimer
    ) {
        clearInterval(
            deviceStateCheckTimer
        );
    }

    updateAutomaticBatteryFace();

    deviceStateCheckTimer =
        setInterval(
            updateAutomaticBatteryFace,
            DEVICE_STATE_CHECK_INTERVAL_MS
        );
}


/*
 * Server actions
 */

function handleServerAction(
    action,
    deferUntilAfterAudio = false
) {
    if (
        !action ||
        typeof action !==
            "object"
    ) {
        return false;
    }

    if (
        action.type ===
            "get_device_network"
    ) {
        sendNativeNetworkState(
            {
                message:
                    String(
                        action.message ||
                        ""
                    ),
            }
        );

        return true;
    }

    if (
        action.type ===
            "get_device_battery"
    ) {
        const batteryAction = {
            message:
                String(
                    action.message ||
                    ""
                ),
        };

        if (
            deferUntilAfterAudio ||
            currentAudio ||
            bmoRenderer.state ===
                "speaking"
        ) {
            pendingDeviceAction =
                batteryAction;

        } else {
            sendNativeBatteryState(
                batteryAction
            );
        }

        return true;
    }

    if (
        action.type ===
            "capture_image"
    ) {
        const captureAction = {
            prompt:
                String(
                    action.prompt ||
                    "What are you looking at?"
                ),
        };

        if (
            deferUntilAfterAudio ||
            currentAudio ||
            bmoRenderer.state ===
                "speaking"
        ) {
            pendingCaptureAction =
                captureAction;

        } else {
            startNativeVisionCapture(
                captureAction.prompt
            );
        }

        return true;
    }

    if (
        action.type ===
            "spotify_now_playing"
    ) {
        handleBMOSpotifyNowPlayingRequest();

        return true;
    }


    if (
        action.type ===
            "spotify_shuffle" ||
        action.type ===
            "spotify_repeat"
    ) {
        const nativeBridge =
            getNativeBridge();

        if (
            !nativeBridge
        ) {
            console.error(
                "Spotify polish action requested without Android bridge:",
                action.type
            );

            if (
                window.onSpotifyUnavailable
            ) {
                window.onSpotifyUnavailable();
            }

            return true;
        }

        try {
            if (
                action.type ===
                    "spotify_shuffle"
            ) {
                nativeBridge.spotifySetShuffle(
                    Boolean(
                        action.enabled
                    )
                );

                showStatus(
                    action.enabled
                        ? "Shuffle on"
                        : "Shuffle off",
                    1600
                );

            } else {
                const repeatMode =
                    String(
                        action.mode ||
                        "all"
                    );

                nativeBridge.spotifySetRepeat(
                    repeatMode
                );

                if (
                    repeatMode ===
                        "one"
                ) {
                    showStatus(
                        "Repeating this song",
                        1600
                    );

                } else if (
                    repeatMode ===
                        "off"
                ) {
                    showStatus(
                        "Repeat off",
                        1600
                    );

                } else {
                    showStatus(
                        "Repeat on",
                        1600
                    );
                }
            }

        } catch (
            error
        ) {
            console.error(
                "Spotify polish action failed:",
                action.type,
                error
            );

            if (
                window.onSpotifyUnavailable
            ) {
                window.onSpotifyUnavailable();
            }
        }

        if (
            !isRecording &&
            !currentAudio
        ) {
            setFaceState(
                "idle"
            );

            resetDaydreamTimer();
        }

        return true;
    }


    if (
        action.type ===
            "spotify_play" ||
        action.type ===
            "spotify_pause" ||
        action.type ===
            "spotify_resume" ||
        action.type ===
            "spotify_next" ||
        action.type ===
            "spotify_previous"
    ) {
        const nativeBridge =
            getNativeBridge();

        if (
            !nativeBridge
        ) {
            console.error(
                "Spotify action requested without Android bridge:",
                action.type
            );

            showStatus(
                "Spotify controls unavailable",
                1800
            );

            return true;
        }

        try {
            /*
             * A Spotify command completes the current voice interaction
             * immediately. There is no TTS response afterward, so clean up
             * the thinking state here instead of leaving BMO waiting forever.
             */
            clearTimeout(
                bmoThinkingSoundTimer
            );

            bmoThinkingSoundTimer =
                null;

            stopBmoPersonalitySound();

            switch (
                action.type
            ) {
                case "spotify_play":
                    if (
                        !action.uri
                    ) {
                        console.error(
                            "spotify_play missing URI"
                        );

                        showStatus(
                            "Spotify track unavailable",
                            1800
                        );

                        break;
                    }

                    nativeBridge.spotifyPlay(
                        String(
                            action.uri
                        )
                    );

                    showStatus(
                        action.track
                            ? `Playing ${action.track}`
                            : "Playing...",
                        1800
                    );
                    break;

                case "spotify_pause":
                    nativeBridge
                        .spotifyPause();

                    showStatus(
                        "Music paused",
                        1400
                    );
                    break;

                case "spotify_resume":
                    nativeBridge
                        .spotifyResume();

                    showStatus(
                        "Music resumed",
                        1400
                    );
                    break;

                case "spotify_next":
                    nativeBridge
                        .spotifyNext();

                    showStatus(
                        "Skipping...",
                        1400
                    );
                    break;

                case "spotify_previous":
                    nativeBridge
                        .spotifyPrevious();

                    showStatus(
                        "Going back...",
                        1400
                    );
                    break;
            }

        } catch (
            error
        ) {
            console.error(
                "Spotify native action failed:",
                action.type,
                error
            );

            showStatus(
                "Spotify command failed",
                1800
            );
        }

        /*
         * handleServerAction() returns early for client-side actions,
         * so restore BMO's normal face explicitly after Spotify control.
         */
        if (
            !isRecording &&
            !currentAudio
        ) {
            setFaceState(
                "idle"
            );

            resetDaydreamTimer();
        }

        return true;
    }

    if (
        action.type ===
            "set_expression"
    ) {
        const expression =
            String(
                action.expression ||
                ""
            ).toLowerCase();

        const durationMs =
            Number(
                action.duration_ms ||
                3000
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
            bmoRenderer.state ===
                "speaking"
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

    pendingExpression =
        null;

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
        pendingTimerEvents.length ===
            0
    );
}


function clearDaydreamThought() {
    if (
        daydreamThoughtVisible
    ) {
        clearTimeout(
            transcriptTimer
        );

        transcriptElement
            .classList
            .remove(
                "visible"
            );

        daydreamThoughtVisible =
            false;
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

    daydreamThoughtTimer =
        null;

    daydreamMoodTimer =
        null;

    daydreamActive =
        false;

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

    daydreamTimer =
        null;

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
    /*
     * Old versions of BMO randomly cycled through emotional faces
     * while idle.
     *
     * That made BMO sometimes look sad/angry/etc. for no actual
     * reason.
     *
     * New rule:
     *
     *     normal idle -> idle
     *     passive daydream -> daydream
     *     actual fetched thought -> semantic expression
     *
     * There is deliberately no random emotion timer anymore.
     */

    clearTimeout(
        daydreamMoodTimer
    );

    daydreamMoodTimer =
        null;

    if (
        !daydreamActive ||
        !canDaydream()
    ) {
        return;
    }

    if (
        !daydreamThoughtVisible
    ) {
        setFaceState(
            "daydream"
        );
    }
}

async function fetchDaydreamThought() {
    if (
        !daydreamActive ||
        daydreamThoughtInFlight ||
        !canDaydream()
    ) {
        return;
    }

    daydreamThoughtInFlight =
        true;

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

        const topic =
            String(
                data.topic ||
                ""
            ).trim();

        const thought =
            String(
                data.thought ||
                ""
            ).trim();

        const backendExpression =
            String(
                data.expression ||
                ""
            )
                .trim()
                .toLowerCase();

        if (
            !thought
        ) {
            return;
        }

        daydreamThoughtVisible =
            true;

        /*
         * The backend understands the actual thought meaning.
         * Use its expression when valid.
         */
        const expression =
            VALID_EXPRESSIONS.has(
                backendExpression
            )
                ? backendExpression
                : "curious";

        setFaceState(
            expression
        );

        showTranscript(
            thought,
            12000
        );

        if (
            topic
        ) {
            showStatus(
                `Thinking about: ${topic}`,
                12000
            );

        } else {
            showStatus(
                "BMO is pondering...",
                12000
            );
        }

        console.log(
            "BMO idle thought:",
            {
                topic:
                    topic,

                expression:
                    expression,

                thought:
                    thought,
            }
        );

        /*
         * When the thought finishes, return to the calm daydream
         * face rather than selecting another random mood.
         */
        setTimeout(
            () => {
                daydreamThoughtVisible =
                    false;

                if (
                    daydreamActive &&
                    canDaydream()
                ) {
                    setFaceState(
                        "daydream"
                    );
                }
            },
            12100
        );

    } catch (error) {
        console.debug(
            "Daydream thought failed:",
            error
        );

    } finally {
        daydreamThoughtInFlight =
            false;
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
    daydreamTimer =
        null;

    if (
        !canDaydream()
    ) {
        resetDaydreamTimer();

        return;
    }

    daydreamActive =
        true;

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

    statusMessage.textContent =
        text;

    statusMessage.classList.remove(
        "hidden"
    );

    if (
        duration > 0
    ) {
        statusTimer =
            setTimeout(
                () => {
                    statusMessage
                        .classList
                        .add(
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

    transcriptElement.textContent =
        text;

    transcriptElement
        .classList
        .add(
            "visible"
        );

    transcriptTimer =
        setTimeout(
            () => {
                transcriptElement
                    .classList
                    .remove(
                        "visible"
                    );
            },
            duration
        );
}


/*
 * Backend reconnect recovery
 */

function canSafelyReloadAfterBackendRecovery() {
    return (
        !isRecording &&
        !recordingStartPending &&
        !currentAudio &&
        !processingTimerEvent &&
        pendingTimerEvents.length ===
            0 &&
        !pendingCaptureAction &&
        !pendingDeviceAction &&
        (
            bmoRenderer.state ===
                "idle" ||
            bmoRenderer.state ===
                "daydream" ||
            bmoRenderer.state ===
                "sleepy" ||
            bmoRenderer.state ===
                "bored" ||
            bmoRenderer.state ===
                "error" ||
            bmoRenderer.state ===
                "low_battery"
        )
    );
}


function cancelBackendRecoveryReload() {
    if (
        backendRecoveryTimer
    ) {
        clearTimeout(
            backendRecoveryTimer
        );

        backendRecoveryTimer =
            null;
    }

    backendRecoveryStartedAt =
        null;
}


function scheduleBackendRecoveryReload() {
    if (
        backendRecoveryTimer
    ) {
        return;
    }

    if (
        backendRecoveryStartedAt ===
        null
    ) {
        backendRecoveryStartedAt =
            Date.now();
    }

    backendRecoveryTimer =
        setTimeout(
            () => {
                backendRecoveryTimer =
                    null;

                if (
                    !backendOnline
                ) {
                    cancelBackendRecoveryReload();

                    return;
                }

                const waitedMs =
                    Date.now() -
                    backendRecoveryStartedAt;

                if (
                    !canSafelyReloadAfterBackendRecovery()
                ) {
                    if (
                        waitedMs <
                        BACKEND_RECOVERY_MAX_WAIT_MS
                    ) {
                        scheduleBackendRecoveryReload();
                    } else {
                        console.log(
                            "BMO recovery reload skipped because interaction stayed busy"
                        );

                        cancelBackendRecoveryReload();
                    }

                    return;
                }

                console.log(
                    "BMO backend recovered after a long outage. Reloading WebView."
                );

                showStatus(
                    "BMO brain recovered",
                    900
                );

                setTimeout(
                    () => {
                        window.location.reload();
                    },
                    700
                );
            },
            BACKEND_RECOVERY_RETRY_MS
        );
}


function softRecoverAfterBackendReconnect() {
    /*
     * Clear stale temporary state left behind by a backend outage.
     * Do not interrupt a live interaction.
     */

    if (
        isRecording ||
        recordingStartPending ||
        currentAudio
    ) {
        return;
    }

    pendingExpression =
        null;

    pendingCaptureAction =
        null;

    pendingDeviceAction =
        null;

    clearTimeout(
        expressionTimer
    );

    expressionTimer =
        null;

    bmoRenderer.mouthOpen =
        0;

    if (
        automaticLowBatteryActive
    ) {
        setFaceState(
            "low_battery"
        );

    } else {
        setFaceState(
            "idle"
        );
    }

    resetDaydreamTimer();

    processPendingTimerEvents();

    console.log(
        "BMO soft reconnect recovery complete"
    );
}


/*
 * Backend health
 */

function setBackendOnline(
    online
) {
    const changed =
        backendOnline !==
        online;

    backendOnline =
        online;

    if (
        !changed
    ) {
        return;
    }

    if (
        online
    ) {
        const outageDuration =
            backendOfflineSince !==
                null
                ? Date.now() -
                    backendOfflineSince
                : 0;

        backendOfflineSince =
            null;

        console.log(
            "BMO backend reconnected after",
            outageDuration,
            "ms"
        );

        softRecoverAfterBackendReconnect();

        showStatus(
            "BMO brain reconnected",
            1800
        );

        /*
         * Tiny network hiccups do not justify reloading the whole UI.
         *
         * A longer outage does. Once BMO is idle, reload the page so
         * the WebView, JS state, bridge state, and passive listeners all
         * get a clean start.
         */
        if (
            outageDuration >=
            BACKEND_RECOVERY_RELOAD_AFTER_MS
        ) {
            scheduleBackendRecoveryReload();

        } else {
            cancelBackendRecoveryReload();
        }

    } else {
        backendOfflineSince =
            Date.now();

        cancelBackendRecoveryReload();

        stopDaydream(
            false
        );

        clearTimeout(
            daydreamTimer
        );

        daydreamTimer =
            null;

        if (
            !isRecording &&
            bmoRenderer.state !==
                "speaking"
        ) {
            setFaceState(
                "sleepy"
            );

            showStatus(
                "BMO brain offline - reconnecting...",
                0
            );
        }

        console.log(
            "BMO backend connection lost"
        );
    }
}


async function checkBackendHealth() {
    let timeoutId =
        null;

    try {
        const controller =
            new AbortController();

        timeoutId =
            setTimeout(
                () => {
                    controller.abort();
                },
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

        timeoutId =
            null;

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
 * Timer events
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
            data.events.length >
                0
        ) {
            for (
                const event
                of data.events
            ) {
                if (
                    event &&
                    event.event ===
                        "timer_finished"
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
        pendingTimerEvents.length >
        0
    ) {
        stopDaydream(
            false
        );

        clearTimeout(
            daydreamTimer
        );

        daydreamTimer =
            null;
    }

    if (
        processingTimerEvent ||
        pendingTimerEvents.length ===
            0
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
        bmoRenderer.state ===
            "speaking"
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

    processingTimerEvent =
        true;

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
        "vibrate" in
        navigator
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

            processingTimerEvent =
                false;

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

    processingTimerEvent =
        false;

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
 * Stop current audio
 */

function stopCurrentAudio() {
    if (
        !currentAudio
    ) {
        return;
    }

    try {
        currentAudio.pause();

        currentAudio.currentTime =
            0;

    } catch (_) {
    }

    currentAudio =
        null;

    pendingExpression =
        null;

    pendingCaptureAction =
        null;

    bmoRenderer.mouthOpen =
        0;
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
            await navigator
                .wakeLock
                .request(
                    "screen"
                );

        wakeLock.addEventListener(
            "release",
            () => {
                wakeLock =
                    null;
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
 * Browser recorder
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


// BMO voice-interaction audio ducking
//
// Android owns the actual media volume. The WebView only marks
// the beginning and end of a voice interaction.
function beginVoiceInteractionDucking() {
    if (
        voiceInteractionDuckingActive
    ) {
        return;
    }

    const nativeBridge =
        getNativeBridge();

    if (
        !nativeBridge ||
        typeof nativeBridge.beginVoiceInteraction !==
            "function"
    ) {
        return;
    }

    try {
        nativeBridge.beginVoiceInteraction();

        voiceInteractionDuckingActive =
            true;

        console.debug(
            "BMO voice interaction: media duck requested"
        );

    } catch (error) {
        console.error(
            "Could not duck Android media volume:",
            error
        );
    }
}


function endVoiceInteractionDucking() {
    if (
        !voiceInteractionDuckingActive
    ) {
        return;
    }

    const nativeBridge =
        getNativeBridge();

    /*
     * Clear our local state even if the bridge disappeared.
     * This prevents a stale frontend flag from poisoning the
     * next interaction.
     */
    voiceInteractionDuckingActive =
        false;

    if (
        !nativeBridge ||
        typeof nativeBridge.endVoiceInteraction !==
            "function"
    ) {
        return;
    }

    try {
        nativeBridge.endVoiceInteraction();

        console.debug(
            "BMO voice interaction: media restore requested"
        );

    } catch (error) {
        console.error(
            "Could not restore Android media volume:",
            error
        );
    }
}


function maybeEndVoiceInteractionDucking(
    state
) {
    if (
        !voiceInteractionDuckingActive
    ) {
        return;
    }

    /*
     * These are the three states belonging to a normal voice
     * interaction. Keep Spotify ducked throughout all of them.
     */
    if (
        [
            "listening",
            "thinking",
            "speaking",
        ].includes(
            state
        )
    ) {
        return;
    }

    /*
     * Do not restore while recording/audio is still genuinely
     * active, even if some temporary face state changes.
     */
    if (
        isRecording ||
        recordingStartPending ||
        currentAudio
    ) {
        return;
    }

    endVoiceInteractionDucking();
}


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
        bmoRenderer.state ===
            "speaking" ||
        currentAudio
    ) {
        stopCurrentAudio();
    }

    recordingStartPending =
        true;

    beginVoiceInteractionDucking();

    const nativeBridge =
        getNativeBridge();

    if (
        nativeBridge
    ) {
        try {
            nativeBridge.startRecording();

            return;

        } catch (error) {
            recordingStartPending =
                false;

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
                () => {
                    setFaceState(
                        "idle"
                    );
                },
                1500
            );

            return;
        }
    }

    if (
        nativeShellRequested
    ) {
        recordingStartPending =
            false;

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
            () => {
                setFaceState(
                    "idle"
                );
            },
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
            await navigator
                .mediaDevices
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
                    event.data.size >
                    0
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

                    microphoneStream =
                        null;
                }

                await sendAudioToBMO(
                    blob
                );
            }
        );

        mediaRecorder.start();

        recordingStartPending =
            false;

        isRecording =
            true;

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
        recordingStartPending =
            false;

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
            () => {
                setFaceState(
                    "idle"
                );
            },
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

    isRecording =
        false;

    recordingStartPending =
        false;

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

        holdStartTimer =
            null;
    }
}


function beginHold(
    event
) {
    resetDaydreamTimer();

    if (
        activePointerId !==
        null
    ) {
        return;
    }

    activePointerId =
        event.pointerId;

    if (
        bmoRenderer.state ===
            "speaking" ||
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
                holdStartTimer =
                    null;

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
        activePointerId !==
            null &&
        event.pointerId !==
            activePointerId
    ) {
        return;
    }

    const timerWasPending =
        holdStartTimer !==
        null;

    cancelPendingHold();

    activePointerId =
        null;

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
        extension =
            "mp4";
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

    daydreamTimer =
        null;

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
                currentAudio !==
                thisAudio
            ) {
                return;
            }

            currentAudio =
                null;

            if (
                processingTimerEvent
            ) {
                processingTimerEvent =
                    false;
            }

            const deviceActionStarted =
                runPendingDeviceAction();

            if (
                deviceActionStarted
            ) {
                return;
            }

            const captureStarted =
                runPendingCaptureAction();

            if (
                captureStarted
            ) {
                return;
            }

            const expressionApplied =
                applyPendingExpression();

            if (
                !expressionApplied
            ) {
                if (
                    automaticLowBatteryActive
                ) {
                    setFaceState(
                        "low_battery"
                    );

                } else {
                    setFaceState(
                        "idle"
                    );
                }
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
                currentAudio !==
                thisAudio
            ) {
                return;
            }

            console.error(
                "Audio playback error:",
                error
            );

            currentAudio =
                null;

            if (
                processingTimerEvent
            ) {
                processingTimerEvent =
                    false;
            }

            setFaceState(
                "error"
            );

            showStatus(
                "Audio playback failed",
                2200
            );

            setTimeout(
                () => {
                    setFaceState(
                        "idle"
                    );
                },
                1500
            );
        }
    );

    try {
        await thisAudio.play();

    } catch (error) {
        if (
            currentAudio !==
                thisAudio
        ) {
            return;
        }

        console.error(
            "Audio autoplay error:",
            error
        );

        currentAudio =
            null;

        if (
            processingTimerEvent
        ) {
            processingTimerEvent =
                false;
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

    analyser.fftSize =
        256;

    analyser.smoothingTimeConstant =
        0.35;

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

    let smoothedLevel =
        0;


    function syncMouth() {
        /*
         * setupVisualizer() is called just BEFORE audioElement.play().
         *
         * On the first animation frame the audio may therefore still be
         * paused. Do not kill the lip-sync loop in that tiny window.
         */
        if (
            audioElement.ended
        ) {
            bmoRenderer.mouthOpen =
                0;

            return;
        }

        if (
            bmoRenderer.state !==
                "speaking"
        ) {
            bmoRenderer.mouthOpen =
                0;

            return;
        }

        if (
            audioElement.paused
        ) {
            bmoRenderer.mouthOpen =
                0;

            requestAnimationFrame(
                syncMouth
            );

            return;
        }

        analyser.getByteTimeDomainData(
            dataArray
        );

        /*
         * Calculate RMS audio amplitude around WebAudio's midpoint.
         */
        let sumSquares =
            0;

        for (
            let index = 0;
            index <
                dataArray.length;
            index++
        ) {
            const sample =
                (
                    dataArray[index] -
                    128
                ) /
                128;

            sumSquares +=
                sample *
                sample;
        }

        const rms =
            Math.sqrt(
                sumSquares /
                dataArray.length
            );

        /*
         * Piper speech occupies a fairly small normalized amplitude
         * range, so expand it into a useful 0.0 -> 1.0 mouth level.
         */
        let level =
            (
                rms -
                0.008
            ) *
            12;

        level =
            Math.max(
                0,
                Math.min(
                    1,
                    level
                )
            );

        /*
         * Open quickly on speech, relax more slowly between sounds.
         */
        if (
            level >
            smoothedLevel
        ) {
            smoothedLevel =
                (
                    smoothedLevel *
                    0.25
                ) +
                (
                    level *
                    0.75
                );

        } else {
            smoothedLevel =
                (
                    smoothedLevel *
                    0.72
                ) +
                (
                    level *
                    0.28
                );
        }

        bmoRenderer.mouthOpen =
            smoothedLevel;

        requestAnimationFrame(
            syncMouth
        );
    }


    /*
     * Start the loop immediately. If audio playback has not begun yet,
     * syncMouth() now waits rather than terminating permanently.
     */
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

        activePointerId =
            null;

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
            document.visibilityState ===
                "visible"
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
 * Android microphone callbacks
 */

window.onNativeRecordingStarted =
    function () {
        resetDaydreamTimer();

        recordingStartPending =
            false;

        isRecording =
            true;

        setFaceState(
            "listening"
        );

        showStatus(
            "Listening...",
            0
        );

        if (
            "vibrate" in
            navigator
        ) {
            navigator.vibrate(
                30
            );
        }
    };


window.onNativeRecordingStopped =
    function () {
        // BMO_RESTORE_AFTER_LISTENING_V1
        //
        // Microphone capture is finished now, so Spotify no longer
        // needs to stay ducked. Keep the wider voice interaction alive
        // for the later Spotify audio-focus resume handling.
        const nativeBridge =
            getNativeBridge();

        if (
            nativeBridge &&
            typeof nativeBridge.restoreVoiceInteractionVolume ===
                "function"
        ) {
            try {
                nativeBridge.restoreVoiceInteractionVolume();

            } catch (error) {
                console.error(
                    "Could not restore Android media volume after listening:",
                    error
                );
            }
        }

        recordingStartPending =
            false;

        isRecording =
            false;

        setFaceState(
            "thinking"
        );

        showStatus(
            "Thinking...",
            0
        );

        /*
         * Recording is finished now, so it is safe for BMO to
         * make a little acknowledgement without feeding itself
         * into the microphone.
         */
        playBmoPersonalitySound(
            "ack_sounds",
            BMO_SOUND_CONFIG
                .acknowledgementVolume,
            () => {
                clearTimeout(
                    bmoThinkingSoundTimer
                );

                bmoThinkingSoundTimer =
                    setTimeout(
                        () => {
                            /*
                             * Only make a thinking noise if we're
                             * genuinely still waiting for the answer.
                             */
                            if (
                                !isRecording &&
                                !currentAudio &&
                                bmoRenderer.state ===
                                    "thinking"
                            ) {
                                playBmoPersonalitySound(
                                    "thinking_sounds",
                                    BMO_SOUND_CONFIG
                                        .thinkingVolume
                                );
                            }
                        },
                        BMO_SOUND_CONFIG
                            .thinkingDelayMs
                    );
            }
        );

        if (
            "vibrate" in
            navigator
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

        recordingStartPending =
            false;

        isRecording =
            false;

        setBackendOnline(
            true
        );

        const cleanedText =
            String(
                text ||
                ""
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

        recordingStartPending =
            false;

        isRecording =
            false;

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
        recordingStartPending =
            false;

        isRecording =
            false;

        const errorText =
            String(
                message ||
                ""
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

        playBmoPersonalitySound(
            "error_sounds",
            BMO_SOUND_CONFIG
                .errorVolume
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
 * Android charger callbacks
 */

window.onNativePowerStateChanged =
    function (
        state
    ) {
        try {
            const charging =
                Boolean(
                    state &&
                    state.charging
                );

            const batteryPercent =
                Number(
                    state &&
                    state.battery_percent
                );

            console.log(
                "Native Android power event:",
                {
                    charging:
                        charging,

                    battery_percent:
                        batteryPercent,
                }
            );

            /*
             * Keep the polling state synchronized so the next
             * battery poll does not interpret the same transition
             * as a second charger event.
             */
            lastBatteryChargingState =
                charging;

            showChargerReaction(
                charging,
                batteryPercent
            );

        } catch (
            error
        ) {
            console.error(
                "Native Android power event failed:",
                error
            );
        }
    };

/*
 * Android vision callbacks
 */

window.onNativeVisionStarted =
    function () {
        stopDaydream(
            false
        );

        clearTimeout(
            daydreamTimer
        );

        daydreamTimer =
            null;

        setFaceState(
            "capturing"
        );

        showStatus(
            "Looking...",
            0
        );
    };


window.onNativeVisionResponse =
    async function (
        responseText
    ) {
        try {
            const data =
                JSON.parse(
                    String(
                        responseText ||
                        "{}"
                    )
                );

            if (
                data.error
            ) {
                throw new Error(
                    data.error
                );
            }

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
                data.response
            ) {
                showTranscript(
                    data.response,
                    4500
                );
            }

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

            resetDaydreamTimer();

        } catch (error) {
            console.error(
                "Vision response error:",
                error
            );

            setFaceState(
                "error"
            );

            showStatus(
                "BMO couldn't see that",
                2500
            );

            setTimeout(
                () => {
                    setFaceState(
                        "idle"
                    );

                    resetDaydreamTimer();
                },
                1800
            );
        }
    };


window.onNativeVisionError =
    function (
        message
    ) {
        console.error(
            "Native camera error:",
            message
        );

        setFaceState(
            "error"
        );

        showStatus(
            String(
                message ||
                    "Camera failed"
            ),
            2500
        );

        setTimeout(
            () => {
                setFaceState(
                    "idle"
                );

                resetDaydreamTimer();
            },
            1800
        );
    };



/*
 * BMO_SPOTIFY_UNAVAILABLE_UI_V1
 *
 * Android calls this only after Spotify genuinely failed. A merely closed
 * Spotify app gets a reconnect attempt first, so successful resurrection
 * stays silent.
 */
window.onSpotifyUnavailable =
    async function () {
        const message =
            "Spotify isn't available right now.";

        console.error(
            "BMO Spotify unavailable"
        );

        showTranscript(
            message,
            4500
        );

        showStatus(
            "Spotify unavailable",
            2500
        );

        setFaceState(
            "confused"
        );

        try {
            const response =
                await fetch(
                    "/api/spotify-unavailable",
                    {
                        method:
                            "POST",
                    }
                );

            if (
                !response.ok
            ) {
                throw new Error(
                    `Spotify fallback HTTP ${response.status}`
                );
            }

            const data =
                await response.json();

            setBackendOnline(
                true
            );

            if (
                data.audio_url
            ) {
                await playBMOAudio(
                    data.audio_url
                );

                return;
            }

        } catch (
            error
        ) {
            console.error(
                "Could not play Spotify unavailable message:",
                error
            );
        }

        /*
         * Even if Piper/backend speech fails, do not leave BMO stuck in
         * confused/thinking mode. The visible message above is still useful.
         */
        if (
            !isRecording &&
            !currentAudio
        ) {
            setFaceState(
                "idle"
            );

            resetDaydreamTimer();
        }
    };


/*
 * Startup
 */

async function startBMOFace() {
    showStatus(
        "Waking up...",
        0
    );

    /*
     * Load the startup animation before selecting it.
     * Otherwise the renderer temporarily falls back to idle while the
     * warmup PNGs are still arriving from the backend.
     */
    await bmoRenderer.loadState(
        "warmup"
    );

    setFaceState(
        "warmup"
    );

    const warmupFrames =
        bmoRenderer.frames.get(
            "warmup"
        ) || [];

    const warmupDelay =
        bmoRenderer.getFrameDelay(
            "warmup"
        );

    /*
     * Play the warmup animation exactly once.
     * Example: 5 frames × 260 ms = 1300 ms.
     */
    const warmupDuration =
        Math.max(
            900,
            warmupFrames.length *
                warmupDelay
        );

    await new Promise(
        (resolve) => {
            setTimeout(
                resolve,
                warmupDuration
            );
        }
    );

    if (
        !isRecording &&
        !recordingStartPending &&
        !currentAudio
    ) {
        setFaceState(
            "idle"
        );

        showStatus(
            "Hold anywhere to talk",
            2500
        );
    }

    /*
     * Once the important startup faces are ready, load everything else.
     */
    bmoRenderer.preloadStates();
}


scheduleBackendChecks();
scheduleTimerEventChecks();
scheduleDeviceStateChecks();
resetDaydreamTimer();

startBMOFace();



// ============================================================================
// BMO PERSONALITY SOUNDS
// ============================================================================

const BMO_SOUND_CONFIG = {
    enabled:
        true,

    greetingVolume:
        0.65,

    acknowledgementVolume:
        0.55,

    thinkingVolume:
        0.32,

    errorVolume:
        0.55,

    thinkingDelayMs:
        900,

    stateCooldownMs:
        700
};


const bmoPersonalitySounds = {
    greeting_sounds:
        [],

    ack_sounds:
        [],

    thinking_sounds:
        [],

    error_sounds:
        []
};


let bmoPersonalityAudio =
    null;

let bmoSoundLastState =
    null;

let bmoSoundLastStateAt =
    0;

let bmoThinkingSoundTimer =
    null;


async function loadBmoSoundCategory(
    category
) {
    try {
        const response =
            await fetch(
                `/api/sounds/${category}`,
                {
                    cache:
                        "no-store"
                }
            );

        if (
            !response.ok
        ) {
            return;
        }

        const data =
            await response.json();

        const sounds =
            Array.isArray(
                data.sounds
            )
                ? data.sounds
                : [];

        bmoPersonalitySounds[
            category
        ] =
            sounds;

        console.log(
            `BMO loaded ${sounds.length} ${category}`
        );

    } catch (
        error
    ) {
        console.warn(
            `Could not load ${category}:`,
            error
        );
    }
}


async function loadBmoPersonalitySounds() {
    await Promise.all(
        Object.keys(
            bmoPersonalitySounds
        ).map(
            loadBmoSoundCategory
        )
    );
}


function chooseRandomBmoSound(
    category
) {
    const sounds =
        bmoPersonalitySounds[
            category
        ] ||
        [];

    if (
        sounds.length ===
        0
    ) {
        return null;
    }

    return sounds[
        Math.floor(
            Math.random() *
            sounds.length
        )
    ];
}


function stopBmoPersonalitySound() {
    if (
        bmoPersonalityAudio
    ) {
        try {
            bmoPersonalityAudio.pause();

            bmoPersonalityAudio.currentTime =
                0;

        } catch (
            error
        ) {
        }
    }

    bmoPersonalityAudio =
        null;
}


function playBmoPersonalitySound(
    category,
    volume = 0.5,
    onEnded = null
) {
    if (
        !BMO_SOUND_CONFIG.enabled
    ) {
        return;
    }

    const soundUrl =
        chooseRandomBmoSound(
            category
        );

    console.log(
        "BMO sound requested:",
        category,
        soundUrl ||
            "(no sound available)"
    );

    if (
        !soundUrl
    ) {
        if (
            typeof onEnded ===
            "function"
        ) {
            onEnded();
        }

        return;
    }

    stopBmoPersonalitySound();

    const audio =
        new Audio(
            soundUrl
        );

    audio.volume =
        Math.max(
            0,
            Math.min(
                1,
                volume
            )
        );

    bmoPersonalityAudio =
        audio;

    audio.onended =
        () => {
            if (
                bmoPersonalityAudio ===
                audio
            ) {
                bmoPersonalityAudio =
                    null;
            }

            if (
                typeof onEnded ===
                "function"
            ) {
                onEnded();
            }
        };

    audio.onerror =
        () => {
            if (
                bmoPersonalityAudio ===
                audio
            ) {
                bmoPersonalityAudio =
                    null;
            }

            console.warn(
                "BMO personality sound failed:",
                soundUrl
            );

            if (
                typeof onEnded ===
                "function"
            ) {
                onEnded();
            }
        };

    console.log(
        "BMO attempting sound playback:",
        soundUrl
    );

    audio.play()
        .then(
            () => {
                console.log(
                    "BMO sound playback started:",
                    soundUrl
                );
            }
        )
        .catch(
            error => {
                console.warn(
                    "BMO personality sound playback failed:",
                    soundUrl,
                    error
                );

                if (
                    typeof onEnded ===
                    "function"
                ) {
                    onEnded();
                }
            }
        );
}


function scheduleBmoThinkingSound() {
    clearTimeout(
        bmoThinkingSoundTimer
    );

    bmoThinkingSoundTimer =
        setTimeout(
            () => {
                bmoThinkingSoundTimer =
                    null;

                /*
                 * Only play if BMO really is still thinking.
                 */
                if (
                    bmoSoundLastState !==
                    "thinking"
                ) {
                    return;
                }

                playBmoPersonalitySound(
                    "thinking_sounds",
                    BMO_SOUND_CONFIG
                        .thinkingVolume
                );
            },
            BMO_SOUND_CONFIG
                .thinkingDelayMs
        );
}


function handleBmoPersonalityState(
    state
) {
    const now =
        Date.now();

    if (
        state ===
        bmoSoundLastState &&
        (
            now -
            bmoSoundLastStateAt
        ) <
        BMO_SOUND_CONFIG
            .stateCooldownMs
    ) {
        return;
    }

    bmoSoundLastState =
        state;

    bmoSoundLastStateAt =
        now;

    if (
        state !==
        "thinking"
    ) {
        clearTimeout(
            bmoThinkingSoundTimer
        );

        bmoThinkingSoundTimer =
            null;
    }

    switch (
        state
    ) {
        case "thinking":

            /*
             * We deliberately acknowledge AFTER recording has
             * finished so BMO's own speaker does not feed into
             * the microphone.
             */
            playBmoPersonalitySound(
                "ack_sounds",
                BMO_SOUND_CONFIG
                    .acknowledgementVolume,
                () => {
                    scheduleBmoThinkingSound();
                }
            );

            break;


        case "error":

            playBmoPersonalitySound(
                "error_sounds",
                BMO_SOUND_CONFIG
                    .errorVolume
            );

            break;
    }
}


/*
 * Keep the existing face-state implementation intact.
 * This wrapper simply observes state changes.
 */

/* Sound state hooks are now explicit in Android callbacks. */

loadBmoPersonalitySounds()
    .then(
        () => {
            /*
             * Android WebView allows media playback without
             * a user gesture, so this can act as BMO's little
             * startup hello.
             */
            setTimeout(
                () => {
                    playBmoPersonalitySound(
                        "greeting_sounds",
                        BMO_SOUND_CONFIG
                            .greetingVolume
                    );
                },
                900
            );
        }
    );


// ============================================================================
// END BMO PERSONALITY SOUNDS
// ============================================================================

// ============================================================================
// BMO HIDDEN DEVELOPER PANEL
// ============================================================================

const BMO_DEBUG_CONFIG = {
    cornerSizePx:
        90,

    requiredTaps:
        5,

    tapWindowMs:
        2600,

    refreshIntervalMs:
        1000
};


let bmoDebugTapTimes =
    [];

let bmoDebugPanelOpen =
    false;

let bmoDebugRefreshTimer =
    null;


function createBmoDebugPanel() {
    if (
        document.getElementById(
            "bmo-debug-overlay"
        )
    ) {
        return;
    }

    const style =
        document.createElement(
            "style"
        );

    style.id =
        "bmo-debug-style";

    style.textContent =
        `
        #bmo-debug-overlay {
            position: fixed;
            inset: 0;
            z-index: 999999;
            display: none;
            align-items: center;
            justify-content: center;
            padding: 22px;
            box-sizing: border-box;
            background: rgba(0, 0, 0, 0.58);
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        #bmo-debug-overlay.open {
            display: flex;
        }

        #bmo-debug-panel {
            width: min(760px, 96vw);
            height: 88vh;
            max-height: 88vh;
            overflow-y: scroll;
            overflow-x: hidden;
            -webkit-overflow-scrolling: touch;
            touch-action: pan-y;
            overscroll-behavior: contain;
            box-sizing: border-box;
            padding: 22px;
            border: 4px solid #111;
            border-radius: 18px;
            background: #c9e4c3;
            color: #111;
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
        }

        #bmo-debug-panel * {
            box-sizing: border-box;
        }

        .bmo-debug-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 18px;
        }

        .bmo-debug-title {
            margin: 0;
            font-size: 30px;
            line-height: 1;
        }

        .bmo-debug-close {
            border: 3px solid #111;
            border-radius: 12px;
            padding: 8px 14px;
            background: #fff;
            color: #111;
            font-size: 20px;
            font-weight: 800;
        }

        .bmo-debug-status-grid {
            display: grid;
            grid-template-columns: minmax(120px, 0.8fr) minmax(180px, 1.2fr);
            gap: 8px 14px;
            margin-bottom: 20px;
            padding: 14px;
            border: 3px solid #111;
            border-radius: 14px;
            background: rgba(255, 255, 255, 0.5);
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 16px;
        }

        .bmo-debug-label {
            font-weight: 800;
        }

        .bmo-debug-value {
            overflow-wrap: anywhere;
        }

        .bmo-debug-section-title {
            margin: 18px 0 10px;
            font-size: 18px;
            font-weight: 900;
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }

        .bmo-debug-buttons {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 10px;
        }

        .bmo-debug-button {
            border: 3px solid #111;
            border-radius: 12px;
            min-height: 48px;
            padding: 8px 10px;
            background: #fff;
            color: #111;
            font-size: 16px;
            font-weight: 800;
        }

        .bmo-debug-button:active {
            transform: translateY(1px);
        }

        .bmo-debug-hint {
            margin-top: 18px;
            opacity: 0.75;
            font-size: 14px;
            text-align: center;
        }
        `;

    document.head.appendChild(
        style
    );


    const overlay =
        document.createElement(
            "div"
        );

    overlay.id =
        "bmo-debug-overlay";

    overlay.innerHTML =
        `
        <div id="bmo-debug-panel">
            <div class="bmo-debug-header">
                <h2 class="bmo-debug-title">
                    BMO DEBUG
                </h2>

                <button
                    type="button"
                    id="bmo-debug-close"
                    class="bmo-debug-close"
                >
                    Close
                </button>
            </div>

            <div class="bmo-debug-status-grid">
                <div class="bmo-debug-label">Backend</div>
                <div class="bmo-debug-value" id="bmo-debug-backend">...</div>

                <div class="bmo-debug-label">Android bridge</div>
                <div class="bmo-debug-value" id="bmo-debug-bridge">...</div>

                <div class="bmo-debug-label">Wake listener</div>
                <div class="bmo-debug-value" id="bmo-debug-wake">...</div>

                <div class="bmo-debug-label">Network</div>
                <div class="bmo-debug-value" id="bmo-debug-network">...</div>

                <div class="bmo-debug-label">Battery</div>
                <div class="bmo-debug-value" id="bmo-debug-battery">...</div>

                <div class="bmo-debug-label">Face</div>
                <div class="bmo-debug-value" id="bmo-debug-face">...</div>

                <div class="bmo-debug-label">Recording</div>
                <div class="bmo-debug-value" id="bmo-debug-recording">...</div>

                <div class="bmo-debug-label">BMO audio</div>
                <div class="bmo-debug-value" id="bmo-debug-audio">...</div>

                <div class="bmo-debug-label">Mac diagnostics</div>
                <div class="bmo-debug-value" id="bmo-debug-mac-diagnostics">...</div>

                <div class="bmo-debug-label">Last frontend error</div>
                <div class="bmo-debug-value" id="bmo-debug-frontend-error">...</div>

                <div class="bmo-debug-label">Last Android error</div>
                <div class="bmo-debug-value" id="bmo-debug-android-error">...</div>
            </div>

            <div class="bmo-debug-section-title">
                Face tests
            </div>

            <div
                class="bmo-debug-buttons"
                id="bmo-debug-face-buttons"
            ></div>

            <div class="bmo-debug-section-title">
                Personality sounds
            </div>

            <div class="bmo-debug-buttons">
                <button
                    type="button"
                    class="bmo-debug-button"
                    data-bmo-sound="greeting_sounds"
                >
                    Greeting
                </button>

                <button
                    type="button"
                    class="bmo-debug-button"
                    data-bmo-sound="ack_sounds"
                >
                    Ack
                </button>

                <button
                    type="button"
                    class="bmo-debug-button"
                    data-bmo-sound="thinking_sounds"
                >
                    Thinking
                </button>

                <button
                    type="button"
                    class="bmo-debug-button"
                    data-bmo-sound="error_sounds"
                >
                    Error
                </button>
            </div>

            <div class="bmo-debug-section-title">
                Utilities
            </div>

            <div class="bmo-debug-buttons">
                <button
                    type="button"
                    class="bmo-debug-button"
                    id="bmo-debug-refresh"
                >
                    Refresh status
                </button>

                <button
                    type="button"
                    class="bmo-debug-button"
                    id="bmo-debug-stop-sound"
                >
                    Stop personality sound
                </button>

                <button
                    type="button"
                    class="bmo-debug-button"
                    id="bmo-debug-return-idle"
                >
                    Return to idle
                </button>
            </div>

            <div class="bmo-debug-hint">
                Secret entrance: tap the top-right corner 5 times.
            </div>
        </div>
        `;

    document.body.appendChild(
        overlay
    );


    const faceButtons =
        document.getElementById(
            "bmo-debug-face-buttons"
        );

    const debugExpressions = [
        "idle",
        "happy",
        "sad",
        "angry",
        "surprised",
        "curious",
        "heart",
        "starry_eyed",
        "confused",
        "sleepy",
        "daydream",
        "dizzy",
        "cheeky",
        "shhh",
        "jamming",
        "low_battery",
        "bee",
        "ladybug",
        "worm",
        "error",
    ];

    for (
        const expression
        of debugExpressions
    ) {
        const button =
            document.createElement(
                "button"
            );

        button.type =
            "button";

        button.className =
            "bmo-debug-button";

        button.textContent =
            expression.replace(
                /_/g,
                " "
            );

        button.addEventListener(
            "click",
            () => {
                stopDaydream(
                    false
                );

                setFaceState(
                    expression
                );

                refreshBmoDebugStatus();
            }
        );

        faceButtons.appendChild(
            button
        );
    }


    overlay.addEventListener(
        "pointerdown",
        (event) => {
            event.stopPropagation();
        },
        false
    );

    overlay.addEventListener(
        "pointerup",
        (event) => {
            event.stopPropagation();
        },
        false
    );

    overlay.addEventListener(
        "touchmove",
        (event) => {
            /*
             * Intentionally do not preventDefault().
             * The debug panel needs native WebView touch scrolling.
             */
            event.stopPropagation();
        },
        {
            passive: true
        }
    );


    /*
     * Android 8-era WebViews can be unreliable with nested
     * overflow scrolling inside a fullscreen touch interface.
     *
     * Give the debug panel its own simple finger-drag scrolling
     * so it works regardless of WebView native scroll behaviour.
     */
    const debugPanel =
        document.getElementById(
            "bmo-debug-panel"
        );

    let debugTouchLastY =
        null;

    let debugTouchMoved =
        false;


    debugPanel.addEventListener(
        "touchstart",
        (event) => {
            if (
                !event.touches ||
                event.touches.length !==
                    1
            ) {
                return;
            }

            debugTouchLastY =
                event.touches[0]
                    .clientY;

            debugTouchMoved =
                false;
        },
        {
            passive:
                true
        }
    );


    debugPanel.addEventListener(
        "touchmove",
        (event) => {
            if (
                debugTouchLastY ===
                    null ||
                !event.touches ||
                event.touches.length !==
                    1
            ) {
                return;
            }

            const currentY =
                event.touches[0]
                    .clientY;

            const deltaY =
                debugTouchLastY -
                currentY;

            if (
                Math.abs(
                    deltaY
                ) >
                1
            ) {
                debugTouchMoved =
                    true;
            }

            debugPanel.scrollTop +=
                deltaY;

            debugTouchLastY =
                currentY;

            /*
             * Prevent the fullscreen BMO interface from treating
             * this drag as a gesture intended for the face.
             */
            event.preventDefault();

            event.stopPropagation();
        },
        {
            passive:
                false
        }
    );


    debugPanel.addEventListener(
        "touchend",
        () => {
            debugTouchLastY =
                null;

            /*
             * Clear this shortly after the gesture so normal
             * button taps continue to work.
             */
            setTimeout(
                () => {
                    debugTouchMoved =
                        false;
                },
                100
            );
        },
        {
            passive:
                true
        }
    );


    document.getElementById(
        "bmo-debug-close"
    ).addEventListener(
        "click",
        closeBmoDebugPanel
    );


    document.getElementById(
        "bmo-debug-refresh"
    ).addEventListener(
        "click",
        refreshBmoDebugStatus
    );


    document.getElementById(
        "bmo-debug-stop-sound"
    ).addEventListener(
        "click",
        () => {
            stopBmoPersonalitySound();

            refreshBmoDebugStatus();
        }
    );


    document.getElementById(
        "bmo-debug-return-idle"
    ).addEventListener(
        "click",
        () => {
            stopDaydream(
                false
            );

            setFaceState(
                "idle"
            );

            showStatus(
                "Debug: idle",
                900
            );

            refreshBmoDebugStatus();
        }
    );


    for (
        const button
        of overlay.querySelectorAll(
            "[data-bmo-sound]"
        )
    ) {
        button.addEventListener(
            "click",
            () => {
                const category =
                    button.getAttribute(
                        "data-bmo-sound"
                    );

                const volume =
                    category ===
                        "greeting_sounds"
                        ? BMO_SOUND_CONFIG
                            .greetingVolume
                        : category ===
                            "thinking_sounds"
                            ? BMO_SOUND_CONFIG
                                .thinkingVolume
                            : category ===
                                "error_sounds"
                                ? BMO_SOUND_CONFIG
                                    .errorVolume
                                : BMO_SOUND_CONFIG
                                    .acknowledgementVolume;

                playBmoPersonalitySound(
                    category,
                    volume
                );
            }
        );
    }
}


function formatBmoClientErrorForDebug(
    item
) {
    if (
        !item ||
        !item.message
    ) {
        return "none";
    }

    const message =
        String(
            item.message
        );

    if (
        message.length <=
        90
    ) {
        return message;
    }

    return (
        message.slice(
            0,
            87
        ) +
        "..."
    );
}


async function refreshBmoClientDiagnostics() {
    const setValue =
        (
            id,
            value
        ) => {
            const element =
                document.getElementById(
                    id
                );

            if (
                element
            ) {
                element.textContent =
                    String(
                        value
                    );
            }
        };

    try {
        const controller =
            new AbortController();

        const timeoutId =
            setTimeout(
                () => {
                    controller.abort();
                },
                2500
            );

        const response =
            await fetch(
                "/api/diagnostics",
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

        if (
            !response.ok
        ) {
            throw new Error(
                `Diagnostics HTTP ${response.status}`
            );
        }

        const data =
            await response.json();

        const diskDetail =
            data &&
            data.core &&
            data.core.disk
                ? data.core.disk.detail
                : "";

        const overall =
            data &&
            data.status
                ? data.status
                : "unknown";

        setValue(
            "bmo-debug-mac-diagnostics",
            diskDetail
                ? `${overall} · ${diskDetail}`
                : overall
        );

        const clients =
            (
                data &&
                data.clients
            ) ||
            {};

        setValue(
            "bmo-debug-frontend-error",
            formatBmoClientErrorForDebug(
                clients.frontend
            )
        );

        setValue(
            "bmo-debug-android-error",
            formatBmoClientErrorForDebug(
                clients.android
            )
        );

    } catch (
        error
    ) {
        /*
         * Diagnostics must never interfere with the normal debug panel.
         * In particular, do not report this failure through
         * /api/client-error, because a backend outage would otherwise
         * create pointless recursive diagnostics noise.
         */
        setValue(
            "bmo-debug-mac-diagnostics",
            "unavailable"
        );

        setValue(
            "bmo-debug-frontend-error",
            "unavailable"
        );

        setValue(
            "bmo-debug-android-error",
            "unavailable"
        );
    }
}



function refreshBmoDebugStatus() {
    const setValue =
        (
            id,
            value
        ) => {
            const element =
                document.getElementById(
                    id
                );

            if (
                element
            ) {
                element.textContent =
                    String(
                        value
                    );
            }
        };


    setValue(
        "bmo-debug-backend",
        backendOnline
            ? "✓ online"
            : "✗ offline"
    );


    const nativeBridge =
        getNativeBridge();

    setValue(
        "bmo-debug-bridge",
        nativeBridge
            ? "✓ available"
            : "✗ unavailable"
    );


    setValue(
        "bmo-debug-wake",
        nativeBridge
            ? "Android-managed"
            : "browser / unavailable"
    );


    setValue(
        "bmo-debug-face",
        bmoRenderer.state
    );


    setValue(
        "bmo-debug-recording",
        isRecording
            ? "● recording"
            : recordingStartPending
                ? "starting..."
                : "idle"
    );


    setValue(
        "bmo-debug-audio",
        currentAudio
            ? "playing"
            : "idle"
    );


    if (
        nativeBridge
    ) {
        try {
            const battery =
                readNativeBatteryState();

            const percent =
                Number(
                    battery.battery_percent
                );

            const charging =
                Boolean(
                    battery.charging
                );

            setValue(
                "bmo-debug-battery",
                Number.isFinite(
                    percent
                )
                    ? `${percent}% ${charging ? "charging" : "battery"}`
                    : "unknown"
            );

        } catch (
            error
        ) {
            setValue(
                "bmo-debug-battery",
                "unavailable"
            );
        }


        try {
            const network =
                readNativeNetworkState();

            if (
                network.connected
            ) {
                setValue(
                    "bmo-debug-network",
                    `✓ ${network.network_type || "connected"}`
                );

            } else {
                setValue(
                    "bmo-debug-network",
                    "✗ disconnected"
                );
            }

        } catch (
            error
        ) {
            setValue(
                "bmo-debug-network",
                "unavailable"
            );
        }

    } else {
        setValue(
            "bmo-debug-battery",
            "native only"
        );

        setValue(
            "bmo-debug-network",
            navigator.onLine
                ? "browser online"
                : "browser offline"
        );
    }

    refreshBmoClientDiagnostics();
}


function openBmoDebugPanel() {
    createBmoDebugPanel();

    const overlay =
        document.getElementById(
            "bmo-debug-overlay"
        );

    if (
        !overlay
    ) {
        return;
    }

    bmoDebugPanelOpen =
        true;

    overlay.classList.add(
        "open"
    );

    stopDaydream(
        false
    );

    clearTimeout(
        daydreamTimer
    );

    daydreamTimer =
        null;

    refreshBmoDebugStatus();

    clearInterval(
        bmoDebugRefreshTimer
    );

    bmoDebugRefreshTimer =
        setInterval(
            refreshBmoDebugStatus,
            BMO_DEBUG_CONFIG
                .refreshIntervalMs
        );

    console.log(
        "BMO debug panel opened"
    );
}


function closeBmoDebugPanel() {
    const overlay =
        document.getElementById(
            "bmo-debug-overlay"
        );

    if (
        overlay
    ) {
        overlay.classList.remove(
            "open"
        );
    }

    bmoDebugPanelOpen =
        false;

    clearInterval(
        bmoDebugRefreshTimer
    );

    bmoDebugRefreshTimer =
        null;

    resetDaydreamTimer();

    console.log(
        "BMO debug panel closed"
    );
}


function registerBmoDebugCornerTap(
    event
) {
    if (
        bmoDebugPanelOpen
    ) {
        return;
    }

    const cornerSize =
        BMO_DEBUG_CONFIG
            .cornerSizePx;

    const isTopRight =
        event.clientX >=
            window.innerWidth -
                cornerSize &&
        event.clientY <=
            cornerSize;

    if (
        !isTopRight
    ) {
        return;
    }

    event.preventDefault();

    event.stopPropagation();

    if (
        typeof event.stopImmediatePropagation ===
        "function"
    ) {
        event.stopImmediatePropagation();
    }


    const now =
        Date.now();

    bmoDebugTapTimes =
        bmoDebugTapTimes
            .filter(
                (time) =>
                    now -
                        time <=
                    BMO_DEBUG_CONFIG
                        .tapWindowMs
            );

    bmoDebugTapTimes.push(
        now
    );

    console.log(
        "BMO debug corner tap:",
        bmoDebugTapTimes.length
    );

    if (
        bmoDebugTapTimes.length >=
        BMO_DEBUG_CONFIG
            .requiredTaps
    ) {
        bmoDebugTapTimes = [];

        openBmoDebugPanel();
    }
}


document.addEventListener(
    "pointerdown",
    registerBmoDebugCornerTap,
    true
);


console.log(
    "BMO hidden developer panel ready"
);


// ============================================================================
// END BMO HIDDEN DEVELOPER PANEL
// ============================================================================



/* === BMO CRITTER OVERLAY SYSTEM === */

/*
 * BMO Critter Overlay
 *
 * Critters are independent decorations layered over BMO's normal face.
 *
 * Movement uses "structured randomness":
 *
 *   - each critter has several recognizable path archetypes
 *   - an archetype is selected using weighted randomness
 *   - each path receives small random variations
 *   - speed, rotation and scale vary each appearance
 *   - some paths contain deliberate pauses
 *
 * This keeps them unpredictable without turning them into random
 * screensaver objects.
 */

class BMOCritterOverlay {
    constructor() {
        this.layer = null;
        this.active = new Set();
        this.counter = 0;

        this.assets = {
            bee: "/static/critter_assets/bee.svg",
            ladybug: "/static/critter_assets/ladybug.svg",
            worm: "/static/critter_assets/worm.svg",
        };

        this.ensureLayer();

        window.addEventListener("resize", () => {
            this.clear();
        });
    }

    ensureLayer() {
        if (
            this.layer &&
            document.body.contains(this.layer)
        ) {
            return this.layer;
        }

        let layer =
            document.getElementById(
                "bmo-critter-layer"
            );

        if (!layer) {
            layer =
                document.createElement(
                    "div"
                );

            layer.id =
                "bmo-critter-layer";

            Object.assign(
                layer.style,
                {
                    position: "fixed",
                    inset: "0",
                    width: "100vw",
                    height: "100vh",
                    overflow: "hidden",
                    pointerEvents: "none",
                    zIndex: "20",
                    contain: "layout paint",
                }
            );

            document.body.appendChild(
                layer
            );
        }

        this.layer = layer;

        return layer;
    }

    viewport() {
        const vv =
            window.visualViewport;

        return {
            width:
                vv?.width ||
                window.innerWidth,

            height:
                vv?.height ||
                window.innerHeight,
        };
    }

    random(min, max) {
        return (
            min +
            Math.random() *
                (max - min)
        );
    }

    randomInt(min, max) {
        return Math.floor(
            this.random(
                min,
                max + 1
            )
        );
    }

    chance(probability) {
        return (
            Math.random() <
            probability
        );
    }

    clamp(value, min, max) {
        return Math.max(
            min,
            Math.min(
                max,
                value
            )
        );
    }

    weightedChoice(options) {
        /*
         * Example:
         *
         * [
         *   ["normal", 60],
         *   ["dramatic", 10],
         * ]
         */

        const total =
            options.reduce(
                (sum, option) =>
                    sum +
                    option[1],
                0
            );

        let pick =
            Math.random() *
            total;

        for (
            const [value, weight]
            of options
        ) {
            pick -= weight;

            if (pick <= 0) {
                return value;
            }
        }

        return options[
            options.length - 1
        ][0];
    }

    point(
        viewport,
        xRatio,
        yRatio
    ) {
        return {
            x:
                viewport.width *
                xRatio,

            y:
                viewport.height *
                yRatio,
        };
    }

    async spawn(type) {
        type =
            String(type || "")
                .toLowerCase();

        if (
            !this.assets[type]
        ) {
            console.warn(
                "Unknown BMO critter:",
                type
            );

            return null;
        }

        this.ensureLayer();

        const img =
            document.createElement(
                "img"
            );

        img.src =
            this.assets[type];

        img.alt = "";

        img.setAttribute(
            "aria-hidden",
            "true"
        );

        img.dataset.critterType =
            type;

        img.dataset.critterId =
            `${type}-${++this.counter}`;

        Object.assign(
            img.style,
            {
                position: "absolute",
                left: "0",
                top: "0",
                display: "block",
                height: "auto",
                pointerEvents: "none",
                userSelect: "none",
                WebkitUserDrag:
                    "none",
                transformOrigin:
                    "50% 50%",
                willChange:
                    "transform, opacity",
            }
        );

        switch (type) {
            case "bee":
                img.style.width =
                    "min(31vh, 28vw)";
                break;

            case "ladybug":
                img.style.width =
                    "min(26vh, 23vw)";
                break;

            case "worm":
                img.style.width =
                    "min(36vh, 32vw)";
                break;
        }

        this.layer.appendChild(
            img
        );

        this.active.add(img);

        await this.waitForImage(
            img
        );

        if (
            !document.body.contains(
                img
            )
        ) {
            return null;
        }

        this.animate(
            img,
            type
        );

        return img;
    }

    waitForImage(img) {
        if (img.complete) {
            return Promise.resolve();
        }

        return new Promise(
            (resolve) => {
                const done =
                    () => resolve();

                img.addEventListener(
                    "load",
                    done,
                    {
                        once: true,
                    }
                );

                img.addEventListener(
                    "error",
                    done,
                    {
                        once: true,
                    }
                );
            }
        );
    }

    animate(img, type) {
        switch (type) {
            case "bee":
                this.animateBee(
                    img
                );
                break;

            case "ladybug":
                this.animateLadybug(
                    img
                );
                break;

            case "worm":
                this.animateWorm(
                    img
                );
                break;
        }
    }

    /* --------------------------------------------------------
     * BEE
     * --------------------------------------------------------
     *
     * Bee personalities:
     *
     * normalSweep    45%
     * shallowDip     23%
     * hoverBuzz      17%
     * dramaticSwoop  10%
     * chaosBuzz       5%
     */

    animateBee(img) {
        const v =
            this.viewport();

        const rect =
            img.getBoundingClientRect();

        const w =
            rect.width || 120;

        const h =
            rect.height || 120;

        const direction =
            this.chance(0.5)
                ? 1
                : -1;

        const archetype =
            this.weightedChoice([
                [
                    "normalSweep",
                    45,
                ],
                [
                    "shallowDip",
                    23,
                ],
                [
                    "hoverBuzz",
                    17,
                ],
                [
                    "dramaticSwoop",
                    10,
                ],
                [
                    "chaosBuzz",
                    5,
                ],
            ]);

        let points =
            [];

        switch (archetype) {
            case "normalSweep":
                points =
                    this.beeNormalSweep(
                        v,
                        w,
                        h
                    );
                break;

            case "shallowDip":
                points =
                    this.beeShallowDip(
                        v,
                        w,
                        h
                    );
                break;

            case "hoverBuzz":
                points =
                    this.beeHoverBuzz(
                        v,
                        w,
                        h
                    );
                break;

            case "dramaticSwoop":
                points =
                    this.beeDramaticSwoop(
                        v,
                        w,
                        h
                    );
                break;

            case "chaosBuzz":
                points =
                    this.beeChaosBuzz(
                        v,
                        w,
                        h
                    );
                break;
        }

        if (
            direction === -1
        ) {
            /*
             * Mirror the bee path horizontally rather than reversing
             * the keyframe array.
             *
             * Every bee point already contains an explicit animation
             * offset from 0 -> 1. Reversing the array also reversed
             * those offsets to 1 -> 0, which causes Web Animations to
             * reject/freeze the animation in some WebViews.
             */
            for (
                const p
                of points
            ) {
                p.x =
                    v.width -
                    p.x -
                    w * 0.05;
            }
        }

        const duration =
            archetype ===
            "chaosBuzz"
                ? this.random(
                    6500,
                    8000
                )
                : this.random(
                    8000,
                    11000
                );

        const frames =
            [];

        for (
            let i = 0;
            i < points.length;
            i++
        ) {
            const p =
                points[i];

            const rotation =
                this.random(
                    -13,
                    13
                );

            const scale =
                this.random(
                    0.95,
                    1.07
                );

            frames.push({
                offset:
                    p.offset,

                transform:
                    `translate3d(${p.x}px, ${p.y}px, 0) ` +
                    `rotate(${rotation}deg) ` +
                    `scale(${scale})`,

                opacity:
                    p.opacity ??
                    1,
            });
        }

        const animation =
            img.animate(
                frames,
                {
                    duration,
                    easing:
                        "cubic-bezier(.42,.02,.58,.98)",
                    fill:
                        "forwards",
                }
            );

        console.log(
            "BMO bee path:",
            archetype
        );

        this.finishAfter(
            img,
            animation
        );
    }

    beeNormalSweep(
        v,
        w,
        h
    ) {
        const count =
            this.randomInt(
                6,
                8
            );

        const points =
            [];

        for (
            let i = 0;
            i < count;
            i++
        ) {
            const t =
                i /
                (count - 1);

            let x =
                -w * 0.65 +
                (
                    v.width +
                    w * 1.05
                ) *
                    t;

            let y =
                -h *
                    this.random(
                        0.30,
                        0.10
                    ) +
                Math.sin(
                    t *
                        Math.PI *
                        this.random(
                            2.5,
                            4
                        )
                ) *
                    v.height *
                    this.random(
                        0.04,
                        0.09
                    );

            y +=
                this.random(
                    -12,
                    12
                );

            points.push({
                x,
                y,
                offset: t,
                opacity:
                    i === 0 ||
                    i === count - 1
                        ? 0
                        : 1,
            });
        }

        return points;
    }

    beeShallowDip(
        v,
        w,
        h
    ) {
        const dip =
            this.random(
                0.18,
                0.32
            );

        return [
            {
                x:
                    -w *
                    0.65,

                y:
                    -h *
                    0.32,

                offset: 0,
                opacity: 0,
            },

            {
                x:
                    v.width *
                    0.16,

                y:
                    -h *
                    0.12,

                offset: 0.16,
            },

            {
                x:
                    v.width *
                    0.32,

                y:
                    v.height *
                    this.random(
                        0.03,
                        0.10
                    ),

                offset: 0.32,
            },

            {
                x:
                    v.width *
                    0.50,

                y:
                    v.height *
                    dip,

                offset: 0.50,
            },

            {
                x:
                    v.width *
                    0.67,

                y:
                    v.height *
                    this.random(
                        0.04,
                        0.11
                    ),

                offset: 0.70,
            },

            {
                x:
                    v.width *
                    0.84,

                y:
                    -h *
                    0.10,

                offset: 0.86,
            },

            {
                x:
                    v.width +
                    w *
                    0.30,

                y:
                    -h *
                    0.30,

                offset: 1,
                opacity: 0,
            },
        ];
    }

    beeHoverBuzz(
        v,
        w,
        h
    ) {
        const hoverX =
            v.width *
            this.random(
                0.25,
                0.72
            );

        const hoverY =
            this.random(
                -h * 0.12,
                v.height *
                    0.06
            );

        return [
            {
                x:
                    -w *
                    0.60,

                y:
                    -h *
                    0.25,

                offset: 0,
                opacity: 0,
            },

            {
                x:
                    hoverX -
                    v.width *
                    0.18,

                y:
                    hoverY +
                    15,

                offset: 0.20,
            },

            {
                x:
                    hoverX -
                    15,

                y:
                    hoverY -
                    8,

                offset: 0.35,
            },

            {
                x:
                    hoverX +
                    12,

                y:
                    hoverY +
                    10,

                offset: 0.44,
            },

            {
                x:
                    hoverX -
                    10,

                y:
                    hoverY -
                    6,

                offset: 0.53,
            },

            {
                x:
                    hoverX +
                    8,

                y:
                    hoverY +
                    5,

                offset: 0.62,
            },

            {
                x:
                    hoverX +
                    v.width *
                    0.20,

                y:
                    hoverY -
                    20,

                offset: 0.78,
            },

            {
                x:
                    v.width +
                    w *
                    0.35,

                y:
                    -h *
                    0.25,

                offset: 1,
                opacity: 0,
            },
        ];
    }

    beeDramaticSwoop(
        v,
        w,
        h
    ) {
        return [
            {
                x:
                    -w *
                    0.70,

                y:
                    -h *
                    0.40,

                offset: 0,
                opacity: 0,
            },

            {
                x:
                    v.width *
                    0.15,

                y:
                    -h *
                    0.08,

                offset: 0.16,
            },

            {
                x:
                    v.width *
                    0.34,

                y:
                    v.height *
                    0.12,

                offset: 0.30,
            },

            {
                x:
                    v.width *
                    0.48,

                y:
                    v.height *
                    this.random(
                        0.30,
                        0.42
                    ),

                offset: 0.48,
            },

            {
                x:
                    v.width *
                    0.61,

                y:
                    v.height *
                    0.17,

                offset: 0.66,
            },

            {
                x:
                    v.width *
                    0.79,

                y:
                    -h *
                    0.03,

                offset: 0.83,
            },

            {
                x:
                    v.width +
                    w *
                    0.35,

                y:
                    -h *
                    0.35,

                offset: 1,
                opacity: 0,
            },
        ];
    }

    beeChaosBuzz(
        v,
        w,
        h
    ) {
        const points =
            [];

        const count =
            this.randomInt(
                9,
                12
            );

        for (
            let i = 0;
            i < count;
            i++
        ) {
            const t =
                i /
                (count - 1);

            points.push({
                x:
                    -w *
                        0.60 +
                    (
                        v.width +
                        w
                    ) *
                        t +
                    this.random(
                        -35,
                        35
                    ),

                y:
                    this.random(
                        -h *
                            0.30,
                        v.height *
                            0.20
                    ),

                offset: t,

                opacity:
                    i === 0 ||
                    i === count - 1
                        ? 0
                        : 1,
            });
        }

        return points;
    }

    /* --------------------------------------------------------
     * LADYBUG
     * --------------------------------------------------------
     *
     * Ladybug behavior:
     *
     * straightCrawl  50%
     * pauseAndGo     25%
     * littleClimb    15%
     * changeMind     10%
     */

    animateLadybug(img) {
        const v =
            this.viewport();

        const rect =
            img.getBoundingClientRect();

        const w =
            rect.width || 100;

        const h =
            rect.height || 100;

        const direction =
            this.chance(0.5)
                ? 1
                : -1;

        const archetype =
            this.weightedChoice([
                [
                    "straightCrawl",
                    50,
                ],
                [
                    "pauseAndGo",
                    25,
                ],
                [
                    "littleClimb",
                    15,
                ],
                [
                    "changeMind",
                    10,
                ],
            ]);

        /*
         * Keep the ladybug near the lower edge, but slightly more visible.
         */
        const baseY =
            v.height -
            h *
                this.random(
                    0.68,
                    0.84
                );

        let points;

        switch (archetype) {
            case "pauseAndGo":
                points =
                    this.ladybugPause(
                        v,
                        w,
                        h,
                        baseY
                    );
                break;

            case "littleClimb":
                points =
                    this.ladybugClimb(
                        v,
                        w,
                        h,
                        baseY
                    );
                break;

            case "changeMind":
                points =
                    this.ladybugChangeMind(
                        v,
                        w,
                        h,
                        baseY
                    );
                break;

            default:
                points =
                    this.ladybugStraight(
                        v,
                        w,
                        h,
                        baseY
                    );
        }

        if (
            direction === -1
        ) {
            for (
                const p
                of points
            ) {
                p.x =
                    v.width -
                    p.x -
                    w *
                        0.05;
            }
        }

        const frames =
            points.map(
                (p, index) => ({
                    offset:
                        p.offset,

                    transform:
                        `translate3d(${p.x}px, ${p.y}px, 0) ` +
                        `rotate(${p.rotation ?? this.random(-5, 5)}deg) ` +
                        `scale(${p.scale ?? this.random(0.98, 1.03)})`,

                    opacity:
                        p.opacity ??
                        1,
                })
            );

        const animation =
            img.animate(
                frames,
                {
                    /*
                     * Ladybugs are deliberate little walkers.
                     * Keep them noticeably slower than the bee.
                     */
                    duration:
                        this.random(
                            14000,
                            20000
                        ),

                    easing:
                        "ease-in-out",

                    fill:
                        "forwards",
                }
            );

        console.log(
            "BMO ladybug path:",
            archetype
        );

        this.finishAfter(
            img,
            animation
        );
    }

    ladybugStraight(
        v,
        w,
        h,
        y
    ) {
        /*
         * The common ladybug path is deliberately quite busy.
         *
         * Instead of gliding through a handful of large waypoints,
         * she crawls through lots of short uneven steps.
         *
         * Small backwards movements and vertical wandering make the
         * movement feel exploratory rather than mechanically linear.
         */

        const points = [];

        const count =
            this.randomInt(
                11,
                15
            );

        let previousY = y;

        for (
            let i = 0;
            i < count;
            i++
        ) {
            const t =
                i /
                (count - 1);

            let x =
                -w * 0.60 +
                (
                    v.width +
                    w * 0.95
                ) *
                    t;

            /*
             * Occasionally hesitate or take a tiny backwards step.
             */
            if (
                i > 1 &&
                i < count - 2 &&
                this.chance(0.20)
            ) {
                x -=
                    this.random(
                        12,
                        38
                    );
            }

            /*
             * Wander around the lower part of the screen rather than
             * staying on one perfectly horizontal rail.
             */
            previousY +=
                this.random(
                    -14,
                    14
                );

            const minY =
                y -
                h * 0.32;

            const maxY =
                y +
                h * 0.15;

            previousY =
                this.clamp(
                    previousY,
                    minY,
                    maxY
                );

            /*
             * Occasionally climb noticeably farther upwards.
             */
            if (
                i > 1 &&
                i < count - 2 &&
                this.chance(0.13)
            ) {
                previousY -=
                    h *
                    this.random(
                        0.08,
                        0.18
                    );
            }

            points.push({
                x,
                y: previousY,
                offset: t,

                rotation:
                    this.random(
                        -8,
                        8
                    ),

                scale:
                    this.random(
                        0.97,
                        1.035
                    ),

                opacity:
                    i === 0 ||
                    i === count - 1
                        ? 0
                        : 1,
            });
        }

        return points;
    }

    ladybugPause(
        v,
        w,
        h,
        y
    ) {
        /*
         * Crawl in lots of small movements, then stop and inspect the
         * world for a moment before continuing.
         */

        const points = [];

        const count =
            this.randomInt(
                11,
                14
            );

        const pauseIndex =
            this.randomInt(
                4,
                count - 5
            );

        let currentY = y;

        for (
            let i = 0;
            i < count;
            i++
        ) {
            const t =
                i /
                (count - 1);

            let x =
                -w * 0.60 +
                (
                    v.width +
                    w * 0.95
                ) *
                    t;

            currentY +=
                this.random(
                    -13,
                    13
                );

            currentY =
                this.clamp(
                    currentY,
                    y - h * 0.30,
                    y + h * 0.14
                );

            /*
             * Tiny backwards movements are allowed during normal crawl.
             */
            if (
                i > 1 &&
                i < count - 2 &&
                this.chance(0.16)
            ) {
                x -=
                    this.random(
                        10,
                        30
                    );
            }

            /*
             * When we reach the chosen pause point, insert several
             * almost-identical keyframes. This creates a real pause,
             * but with a tiny amount of curious body movement.
             */
            if (
                i === pauseIndex
            ) {
                const beforeOffset =
                    Math.max(
                        0,
                        t - 0.015
                    );

                const afterOffset =
                    Math.min(
                        1,
                        t + 0.13
                    );

                points.push({
                    x,
                    y: currentY,
                    offset:
                        beforeOffset,
                    rotation:
                        -2,
                });

                points.push({
                    x: x + 1,
                    y:
                        currentY -
                        2,
                    offset:
                        t + 0.04,
                    rotation:
                        3,
                    scale:
                        1.015,
                });

                points.push({
                    x: x - 1,
                    y:
                        currentY +
                        1,
                    offset:
                        afterOffset,
                    rotation:
                        -1,
                });

                continue;
            }

            points.push({
                x,
                y: currentY,
                offset: t,

                rotation:
                    this.random(
                        -7,
                        7
                    ),

                scale:
                    this.random(
                        0.975,
                        1.03
                    ),

                opacity:
                    i === 0 ||
                    i === count - 1
                        ? 0
                        : 1,
            });
        }

        /*
         * Sort because the inserted pause keyframes use slightly
         * adjusted offsets.
         */
        points.sort(
            (a, b) =>
                a.offset -
                b.offset
        );

        return points;
    }

    ladybugClimb(
        v,
        w,
        h,
        y
    ) {
        return [
            {
                x: -w * 0.6,
                y,
                offset: 0,
                opacity: 0,
            },
            {
                x: v.width * 0.18,
                y: y - 5,
                offset: 0.20,
            },
            {
                x: v.width * 0.37,
                y:
                    y -
                    h * 0.20,
                offset: 0.38,
                rotation: -9,
            },
            {
                x: v.width * 0.52,
                y:
                    y -
                    h * 0.35,
                offset: 0.55,
                rotation: -13,
            },
            {
                x: v.width * 0.67,
                y:
                    y -
                    h * 0.18,
                offset: 0.71,
                rotation: 9,
            },
            {
                x: v.width * 0.84,
                y,
                offset: 0.87,
            },
            {
                x:
                    v.width +
                    w * 0.3,
                y,
                offset: 1,
                opacity: 0,
            },
        ];
    }

    ladybugChangeMind(
        v,
        w,
        h,
        y
    ) {
        return [
            {
                x: -w * 0.6,
                y,
                offset: 0,
                opacity: 0,
            },
            {
                x: v.width * 0.20,
                y,
                offset: 0.20,
            },
            {
                x: v.width * 0.43,
                y: y - 7,
                offset: 0.42,
            },
            {
                x: v.width * 0.34,
                y: y + 2,
                offset: 0.55,
                rotation: 8,
            },
            {
                x: v.width * 0.48,
                y: y - 3,
                offset: 0.68,
            },
            {
                x: v.width * 0.78,
                y,
                offset: 0.86,
            },
            {
                x:
                    v.width +
                    w * 0.3,
                y,
                offset: 1,
                opacity: 0,
            },
        ];
    }

    /* --------------------------------------------------------
     * WORM
     * --------------------------------------------------------
     *
     * Worm:
     *
     * normalWiggle  55%
     * peek          25%
     * deepDip       12%
     * suspicious     8%
     */

    animateWorm(img) {
        const v =
            this.viewport();

        const rect =
            img.getBoundingClientRect();

        const w =
            rect.width || 130;

        const h =
            rect.height || 110;

        const direction =
            this.chance(0.5)
                ? 1
                : -1;

        const archetype =
            this.weightedChoice([
                [
                    "normalWiggle",
                    55,
                ],
                [
                    "peek",
                    25,
                ],
                [
                    "deepDip",
                    12,
                ],
                [
                    "suspicious",
                    8,
                ],
            ]);

        /*
         * Lift the worm higher so its face is less often cut off.
         * It should still feel like it lives along the bottom edge.
         */
        const baseY =
            v.height -
            h *
                this.random(
                    0.58,
                    0.72
                );

        let points;

        switch (archetype) {
            case "peek":
                points =
                    this.wormPeek(
                        v,
                        w,
                        h,
                        baseY
                    );
                break;

            case "deepDip":
                points =
                    this.wormDeepDip(
                        v,
                        w,
                        h,
                        baseY
                    );
                break;

            case "suspicious":
                points =
                    this.wormSuspicious(
                        v,
                        w,
                        h,
                        baseY
                    );
                break;

            default:
                points =
                    this.wormNormal(
                        v,
                        w,
                        h,
                        baseY
                    );
        }

        if (
            direction === -1
        ) {
            for (
                const p
                of points
            ) {
                p.x =
                    v.width -
                    p.x -
                    w *
                        0.05;
            }
        }

        const frames =
            points.map(
                (p, index) => ({
                    offset:
                        p.offset,

                    transform:
                        `translate3d(${p.x}px, ${p.y}px, 0) ` +
                        `rotate(${p.rotation ?? (index % 2 ? 7 : -7)}deg) ` +
                        `scaleX(${p.scaleX ?? (index % 2 ? 0.94 : 1.06)}) ` +
                        `scaleY(${p.scaleY ?? 1})`,

                    opacity:
                        p.opacity ??
                        1,
                })
            );

        const animation =
            img.animate(
                frames,
                {
                    /*
                     * Worm is our slowest visitor.
                     * The longer duration makes the wiggles and pauses
                     * read as crawling rather than sliding.
                     */
                    duration:
                        this.random(
                            16000,
                            23000
                        ),

                    easing:
                        "ease-in-out",

                    fill:
                        "forwards",
                }
            );

        console.log(
            "BMO worm path:",
            archetype
        );

        this.finishAfter(
            img,
            animation
        );
    }

    wormNormal(
        v,
        w,
        h,
        y
    ) {
        /*
         * Worm movement is a sequence of tiny stretches and compressions
         * rather than a single smooth slide.
         *
         * The route wanders vertically while remaining predominantly
         * along BMO's lower edge.
         */

        const points = [];

        const count =
            this.randomInt(
                13,
                17
            );

        let currentY = y;

        for (
            let i = 0;
            i < count;
            i++
        ) {
            const t =
                i /
                (count - 1);

            let x =
                -w * 0.65 +
                (
                    v.width +
                    w
                ) *
                    t;

            /*
             * A worm doesn't maintain constant forward velocity.
             * Sometimes it compresses and gains almost no ground.
             */
            if (
                i > 1 &&
                i < count - 2
            ) {
                if (
                    this.chance(
                        0.22
                    )
                ) {
                    x -=
                        this.random(
                            8,
                            28
                        );
                }
            }

            /*
             * Normal sinusoidal crawling plus imperfect little changes
             * in terrain.
             */
            currentY +=
                Math.sin(
                    t *
                    Math.PI *
                    this.random(
                        5.5,
                        8
                    )
                ) *
                    h *
                    0.025;

            currentY +=
                this.random(
                    -8,
                    8
                );

            /*
             * Occasional small upward exploration.
             */
            if (
                i > 1 &&
                i < count - 2 &&
                this.chance(0.15)
            ) {
                currentY -=
                    h *
                    this.random(
                        0.08,
                        0.17
                    );
            }

            currentY =
                this.clamp(
                    currentY,
                    y - h * 0.28,
                    y + h * 0.10
                );

            const compressed =
                i % 2 === 0;

            points.push({
                x,
                y: currentY,
                offset: t,

                rotation:
                    this.random(
                        -8,
                        8
                    ),

                scaleX:
                    compressed
                        ? this.random(
                            1.05,
                            1.11
                        )
                        : this.random(
                            0.90,
                            0.97
                        ),

                scaleY:
                    compressed
                        ? this.random(
                            0.94,
                            0.99
                        )
                        : this.random(
                            1.02,
                            1.07
                        ),

                opacity:
                    i === 0 ||
                    i === count - 1
                        ? 0
                        : 1,
            });
        }

        return points;
    }

    wormPeek(
        v,
        w,
        h,
        y
    ) {
        /*
         * The peek route now crawls toward the peek rather than simply
         * sliding there, investigates for a moment, and then wiggles
         * away again.
         */

        const peekX =
            v.width *
            this.random(
                0.38,
                0.62
            );

        const peekY =
            y -
            h *
            this.random(
                0.28,
                0.42
            );

        return [
            {
                x:
                    -w *
                    0.65,
                y:
                    y +
                    h *
                    0.04,
                offset: 0,
                opacity: 0,
                scaleX: 1.08,
                scaleY: 0.96,
            },

            {
                x:
                    v.width *
                    0.10,
                y:
                    y -
                    h *
                    0.02,
                offset: 0.10,
                rotation: -5,
                scaleX: 0.93,
                scaleY: 1.04,
            },

            {
                x:
                    v.width *
                    0.18,
                y:
                    y +
                    h *
                    0.03,
                offset: 0.18,
                rotation: 6,
                scaleX: 1.08,
                scaleY: 0.95,
            },

            {
                x:
                    v.width *
                    0.28,
                y:
                    y -
                    h *
                    0.08,
                offset: 0.27,
                rotation: -7,
                scaleX: 0.92,
                scaleY: 1.05,
            },

            {
                x:
                    peekX -
                    v.width *
                    0.07,
                y:
                    peekY +
                    h *
                    0.10,
                offset: 0.36,
                rotation: 6,
                scaleX: 1.07,
                scaleY: 0.96,
            },

            {
                x:
                    peekX,
                y:
                    peekY,
                offset: 0.44,
                rotation: -2,
                scaleX: 0.94,
                scaleY: 1.07,
            },

            /*
             * Little suspicious peek / pause.
             */
            {
                x:
                    peekX +
                    2,
                y:
                    peekY -
                    3,
                offset: 0.53,
                rotation: 3,
                scaleX: 0.98,
                scaleY: 1.08,
            },

            {
                x:
                    peekX -
                    2,
                y:
                    peekY +
                    1,
                offset: 0.61,
                rotation: -4,
                scaleX: 1.02,
                scaleY: 1.04,
            },

            {
                x:
                    peekX +
                    v.width *
                    0.10,
                y:
                    y -
                    h *
                    0.14,
                offset: 0.69,
                rotation: 7,
                scaleX: 0.92,
                scaleY: 1.06,
            },

            {
                x:
                    v.width *
                    0.72,
                y:
                    y +
                    h *
                    0.02,
                offset: 0.80,
                rotation: -6,
                scaleX: 1.08,
                scaleY: 0.95,
            },

            {
                x:
                    v.width *
                    0.86,
                y:
                    y -
                    h *
                    0.05,
                offset: 0.90,
                rotation: 5,
                scaleX: 0.93,
                scaleY: 1.05,
            },

            {
                x:
                    v.width +
                    w *
                    0.30,
                y:
                    y +
                    h *
                    0.03,
                offset: 1,
                opacity: 0,
                scaleX: 1.06,
                scaleY: 0.97,
            },
        ];
    }

    wormDeepDip(
        v,
        w,
        h,
        y
    ) {
        return [
            {
                x: -w * 0.65,
                y,
                offset: 0,
                opacity: 0,
            },
            {
                x: v.width * 0.20,
                y:
                    y -
                    h * 0.05,
                offset: 0.22,
            },
            {
                x: v.width * 0.40,
                y:
                    y +
                    h * 0.12,
                offset: 0.42,
            },
            {
                x: v.width * 0.55,
                y:
                    y +
                    h * 0.16,
                offset: 0.57,
            },
            {
                x: v.width * 0.72,
                y:
                    y -
                    h * 0.08,
                offset: 0.77,
            },
            {
                x:
                    v.width +
                    w * 0.30,
                y,
                offset: 1,
                opacity: 0,
            },
        ];
    }

    wormSuspicious(
        v,
        w,
        h,
        y
    ) {
        const stopX =
            v.width *
            this.random(
                0.38,
                0.62
            );

        return [
            {
                x: -w * 0.65,
                y,
                offset: 0,
                opacity: 0,
            },
            {
                x: v.width * 0.18,
                y,
                offset: 0.18,
            },
            {
                x: stopX,
                y:
                    y -
                    h * 0.18,
                offset: 0.40,
            },

            {
                x: stopX + 3,
                y:
                    y -
                    h * 0.20,
                offset: 0.55,
                rotation: -4,
            },

            {
                x: stopX - 2,
                y:
                    y -
                    h * 0.19,
                offset: 0.65,
                rotation: 5,
            },

            {
                x: v.width * 0.78,
                y,
                offset: 0.86,
            },

            {
                x:
                    v.width +
                    w * 0.30,
                y,
                offset: 1,
                opacity: 0,
            },
        ];
    }

    finishAfter(
        img,
        animation
    ) {
        const cleanup =
            () => {
                this.active.delete(
                    img
                );

                img?.remove();
            };

        animation.onfinish =
            cleanup;

        animation.oncancel =
            cleanup;
    }

    clear() {
        for (
            const img
            of Array.from(
                this.active
            )
        ) {
            try {
                for (
                    const animation
                    of img.getAnimations()
                ) {
                    animation.cancel();
                }
            } catch (_) {
                img.remove();
            }

            this.active.delete(
                img
            );
        }

        if (this.layer) {
            this.layer.innerHTML =
                "";
        }
    }
}

const bmoCritters =
    new BMOCritterOverlay();

window.bmoCritters =
    bmoCritters;

window.showBMOCritter =
    function(type) {
        return bmoCritters.spawn(
            type
        );
    };

window.clearBMOCritters =
    function() {
        bmoCritters.clear();
    };

/*
 * Compatibility:
 *
 * Old callers can still request "bee", "ladybug" or "worm"
 * through setFaceState(), but they become overlays instead.
 */
const bmoOriginalSetFaceState =
    setFaceState;

setFaceState =
    function(
        state,
        ...args
    ) {
        const normalized =
            String(
                state || ""
            ).toLowerCase();

        if (
            normalized ===
                "bee" ||
            normalized ===
                "ladybug" ||
            normalized ===
                "worm"
        ) {
            bmoCritters.spawn(
                normalized
            );

            console.log(
                "BMO critter overlay:",
                normalized
            );

            return;
        }

        return bmoOriginalSetFaceState(
            state,
            ...args
        );
    };

function installBMOCritterDebugButton() {
    const faceButtons =
        document.getElementById(
            "bmo-debug-face-buttons"
        );

    if (!faceButtons) {
        return false;
    }

    if (
        document.getElementById(
            "bmo-debug-clear-critters"
        )
    ) {
        return true;
    }

    const button =
        document.createElement(
            "button"
        );

    button.id =
        "bmo-debug-clear-critters";

    button.type =
        "button";

    button.textContent =
        "Clear critters";

    button.addEventListener(
        "click",
        (event) => {
            event.preventDefault();
            event.stopPropagation();

            bmoCritters.clear();
        }
    );

    faceButtons.appendChild(
        button
    );

    return true;
}

if (
    !installBMOCritterDebugButton()
) {
    const observer =
        new MutationObserver(
            () => {
                if (
                    installBMOCritterDebugButton()
                ) {
                    observer.disconnect();
                }
            }
        );

    observer.observe(
        document.body,
        {
            childList: true,
            subtree: true,
        }
    );

    setTimeout(
        () =>
            observer.disconnect(),
        15000
    );
}

console.log(
    "BMO structured-random critter system ready"
);

/* === END BMO CRITTER OVERLAY SYSTEM === */


/* === BMO DEBUG VOLUME CONTROL === */

/*
 * Native Android media-volume control.
 *
 * This controls AudioManager.STREAM_MUSIC on the LG itself, rather than
 * merely adjusting the volume property of individual HTML Audio objects.
 */

function readBMONativeVolume() {
    const bridge =
        getNativeBridge();

    if (!bridge) {
        return null;
    }

    try {
        /*
         * Android 8 JavascriptInterface objects should be called directly.
         * Do not rely on typeof bridge.getMediaVolume === "function".
         */
        const value =
            Number(
                bridge.getMediaVolume()
            );

        if (
            Number.isFinite(value)
        ) {
            return Math.max(
                0,
                Math.min(
                    100,
                    Math.round(value)
                )
            );
        }

    } catch (error) {
        console.warn(
            "Could not read Android media volume:",
            error
        );
    }

    return null;
}


function setBMONativeVolume(
    percent
) {
    const bridge =
        getNativeBridge();

    if (!bridge) {
        return false;
    }

    const safePercent =
        Math.max(
            0,
            Math.min(
                100,
                Math.round(
                    Number(percent) || 0
                )
            )
        );

    try {
        bridge.setMediaVolume(
            safePercent
        );

        return true;

    } catch (error) {
        console.warn(
            "Could not set Android media volume:",
            error
        );

        return false;
    }
}


function installBMODebugVolumeControl() {
    if (
        document.getElementById(
            "bmo-debug-volume-control"
        )
    ) {
        return true;
    }

    /*
     * The expression button container is already part of the debug panel.
     * Insert the volume section immediately before it.
     */
    const faceButtons =
        document.getElementById(
            "bmo-debug-face-buttons"
        );

    if (!faceButtons) {
        return false;
    }

    const section =
        document.createElement(
            "div"
        );

    section.id =
        "bmo-debug-volume-control";

    Object.assign(
        section.style,
        {
            marginTop: "18px",
            marginBottom: "18px",
            paddingTop: "14px",
            paddingBottom: "14px",
            borderTop:
                "1px solid rgba(0,0,0,0.18)",
            borderBottom:
                "1px solid rgba(0,0,0,0.18)",
        }
    );

    const heading =
        document.createElement(
            "div"
        );

    heading.textContent =
        "BMO volume";

    Object.assign(
        heading.style,
        {
            fontWeight: "700",
            marginBottom: "10px",
        }
    );

    const row =
        document.createElement(
            "div"
        );

    Object.assign(
        row.style,
        {
            display: "flex",
            alignItems: "center",
            gap: "12px",
            width: "100%",
        }
    );

    const low =
        document.createElement(
            "span"
        );

    low.textContent =
        "🔈";

    const high =
        document.createElement(
            "span"
        );

    high.textContent =
        "🔊";

    const slider =
        document.createElement(
            "input"
        );

    slider.type =
        "range";

    slider.min =
        "0";

    slider.max =
        "100";

    slider.step =
        "1";

    slider.id =
        "bmo-debug-volume-slider";

    Object.assign(
        slider.style,
        {
            flex: "1",
            width: "100%",
            minWidth: "0",
            height: "34px",
            touchAction: "none",
        }
    );

    const value =
        document.createElement(
            "span"
        );

    value.id =
        "bmo-debug-volume-value";

    value.textContent =
        "--%";

    Object.assign(
        value.style,
        {
            minWidth: "48px",
            textAlign: "right",
            fontVariantNumeric:
                "tabular-nums",
        }
    );

    const current =
        readBMONativeVolume();

    if (current !== null) {
        slider.value =
            String(current);

        value.textContent =
            `${current}%`;

    } else {
        slider.value =
            "50";

        slider.disabled =
            true;

        value.textContent =
            "N/A";
    }

    /*
     * Update continuously while dragging.
     *
     * AudioManager has relatively few discrete volume steps, so Android
     * will naturally snap our 0–100 UI percentage to the nearest real
     * hardware level.
     */
    slider.addEventListener(
        "input",
        (event) => {
            event.stopPropagation();

            const newValue =
                Number(
                    slider.value
                );

            value.textContent =
                `${Math.round(newValue)}%`;

            setBMONativeVolume(
                newValue
            );
        }
    );

    /*
     * Prevent the debug slider drag from falling through into BMO's
     * hold-to-talk gesture handling.
     */
    for (
        const eventName
        of [
            "pointerdown",
            "pointermove",
            "pointerup",
            "touchstart",
            "touchmove",
            "touchend",
            "mousedown",
            "mousemove",
            "mouseup",
        ]
    ) {
        slider.addEventListener(
            eventName,
            (event) => {
                event.stopPropagation();
            },
            {
                passive: false,
            }
        );
    }

    row.appendChild(
        low
    );

    row.appendChild(
        slider
    );

    row.appendChild(
        high
    );

    row.appendChild(
        value
    );

    section.appendChild(
        heading
    );

    section.appendChild(
        row
    );

    faceButtons.parentNode.insertBefore(
        section,
        faceButtons
    );

    return true;
}


/*
 * The developer screen is created dynamically, so install immediately
 * when possible and otherwise wait for it to appear.
 */
if (
    !installBMODebugVolumeControl()
) {
    const bmoVolumeObserver =
        new MutationObserver(
            () => {
                if (
                    installBMODebugVolumeControl()
                ) {
                    bmoVolumeObserver.disconnect();
                }
            }
        );

    bmoVolumeObserver.observe(
        document.body,
        {
            childList: true,
            subtree: true,
        }
    );
}


/*
 * Refresh the slider whenever the debug overlay is opened or touched.
 * This matters if the physical Android volume buttons were used since
 * the previous opening.
 */
function refreshBMODebugVolumeControl() {
    const slider =
        document.getElementById(
            "bmo-debug-volume-slider"
        );

    const value =
        document.getElementById(
            "bmo-debug-volume-value"
        );

    if (
        !slider ||
        !value
    ) {
        return;
    }

    const current =
        readBMONativeVolume();

    if (current === null) {
        slider.disabled =
            true;

        value.textContent =
            "N/A";

        return;
    }

    slider.disabled =
        false;

    slider.value =
        String(current);

    value.textContent =
        `${current}%`;
}


document.addEventListener(
    "pointerup",
    () => {
        if (
            document.getElementById(
                "bmo-debug-volume-slider"
            )
        ) {
            setTimeout(
                refreshBMODebugVolumeControl,
                50
            );
        }
    }
);

console.log(
    "BMO debug native volume control ready"
);

/* === END BMO DEBUG VOLUME CONTROL === */


/* === BMO PRONUNCIATION DEBUG EDITOR === */

const bmoPronunciationEditor = {
    rules: {},

    async load() {
        const list =
            document.getElementById(
                "bmo-pronunciation-list"
            );

        if (!list) {
            return;
        }

        list.textContent =
            "Loading...";

        try {
            const response =
                await fetch(
                    "/api/pronunciation",
                    {
                        cache: "no-store",
                    }
                );

            if (!response.ok) {
                throw new Error(
                    `HTTP ${response.status}`
                );
            }

            const data =
                await response.json();

            this.rules =
                data &&
                typeof data === "object"
                    ? data
                    : {};

            this.render();

        } catch (error) {
            console.warn(
                "Could not load pronunciations:",
                error
            );

            list.textContent =
                "Could not load pronunciation rules.";
        }
    },


    render() {
        const list =
            document.getElementById(
                "bmo-pronunciation-list"
            );

        if (!list) {
            return;
        }

        list.innerHTML = "";

        const entries =
            Object.entries(
                this.rules
            ).sort(
                ([a], [b]) =>
                    a.localeCompare(b)
            );

        if (!entries.length) {
            const empty =
                document.createElement(
                    "div"
                );

            empty.textContent =
                "No pronunciation overrides yet.";

            empty.style.opacity =
                "0.65";

            empty.style.padding =
                "8px 0";

            list.appendChild(
                empty
            );

            return;
        }

        for (
            const [
                word,
                phonetic,
            ]
            of entries
        ) {
            const row =
                document.createElement(
                    "div"
                );

            Object.assign(
                row.style,
                {
                    display: "grid",
                    gridTemplateColumns:
                        "minmax(0,1fr) auto",
                    gap: "8px",
                    padding: "9px 0",
                    borderBottom:
                        "1px solid rgba(0,0,0,0.12)",
                    alignItems: "center",
                }
            );

            const text =
                document.createElement(
                    "div"
                );

            Object.assign(
                text.style,
                {
                    minWidth: "0",
                    overflowWrap:
                        "anywhere",
                    lineHeight: "1.3",
                }
            );

            const original =
                document.createElement(
                    "strong"
                );

            original.textContent =
                word;

            const arrow =
                document.createTextNode(
                    "  →  "
                );

            const replacement =
                document.createElement(
                    "span"
                );

            replacement.textContent =
                phonetic;

            text.appendChild(
                original
            );

            text.appendChild(
                arrow
            );

            text.appendChild(
                replacement
            );


            const buttons =
                document.createElement(
                    "div"
                );

            Object.assign(
                buttons.style,
                {
                    display: "flex",
                    gap: "5px",
                    flexShrink: "0",
                }
            );


            const edit =
                this.makeButton(
                    "Edit"
                );

            edit.addEventListener(
                "click",
                (event) => {
                    event.stopPropagation();

                    const wordInput =
                        document.getElementById(
                            "bmo-pronunciation-word"
                        );

                    const phoneticInput =
                        document.getElementById(
                            "bmo-pronunciation-phonetic"
                        );

                    if (
                        !wordInput ||
                        !phoneticInput
                    ) {
                        return;
                    }

                    wordInput.value =
                        word;

                    phoneticInput.value =
                        phonetic;

                    wordInput.dataset.editingWord =
                        word;

                    wordInput.focus();
                }
            );


            const remove =
                this.makeButton(
                    "Delete"
                );

            let deleteArmed =
                false;

            let deleteTimer =
                null;

            remove.addEventListener(
                "click",
                async (event) => {
                    event.stopPropagation();

                    if (!deleteArmed) {
                        deleteArmed =
                            true;

                        remove.textContent =
                            "Delete?";

                        remove.style.background =
                            "rgba(255, 170, 170, 0.65)";

                        this.setStatus(
                            `Tap Delete? again to remove "${word}".`
                        );

                        deleteTimer =
                            setTimeout(
                                () => {
                                    deleteArmed =
                                        false;

                                    remove.textContent =
                                        "Delete";

                                    remove.style.background =
                                        "rgba(255,255,255,0.45)";
                                },
                                4000
                            );

                        return;
                    }

                    if (deleteTimer) {
                        clearTimeout(
                            deleteTimer
                        );
                    }

                    remove.disabled =
                        true;

                    remove.textContent =
                        "Deleting...";

                    await this.remove(
                        word
                    );
                }
            );

            buttons.appendChild(
                edit
            );

            buttons.appendChild(
                remove
            );

            row.appendChild(
                text
            );

            row.appendChild(
                buttons
            );

            list.appendChild(
                row
            );
        }
    },


    makeButton(label) {
        const button =
            document.createElement(
                "button"
            );

        button.type =
            "button";

        button.textContent =
            label;

        Object.assign(
            button.style,
            {
                padding: "7px 9px",
                borderRadius: "7px",
                border:
                    "1px solid rgba(0,0,0,0.35)",
                background:
                    "rgba(255,255,255,0.45)",
                color: "#14351e",
                fontWeight: "700",
                fontSize: "12px",
            }
        );

        return button;
    },


    setStatus(
        message,
        isError = false
    ) {
        const status =
            document.getElementById(
                "bmo-pronunciation-status"
            );

        if (!status) {
            return;
        }

        status.textContent =
            message;

        status.style.color =
            isError
                ? "#8c1c1c"
                : "#245b32";
    },


    async save() {
        const wordInput =
            document.getElementById(
                "bmo-pronunciation-word"
            );

        const phoneticInput =
            document.getElementById(
                "bmo-pronunciation-phonetic"
            );

        if (
            !wordInput ||
            !phoneticInput
        ) {
            return;
        }

        const word =
            wordInput.value.trim();

        const phonetic =
            phoneticInput.value.trim();

        if (
            !word ||
            !phonetic
        ) {
            this.setStatus(
                "Enter both a word and how BMO should say it.",
                true
            );

            return;
        }

        this.setStatus(
            "Saving..."
        );

        try {
            /*
             * If we're editing a rule and changed the actual
             * spelling of the word, remove the old key first.
             */
            const previousWord =
                wordInput.dataset.editingWord;

            if (
                previousWord &&
                previousWord.toLowerCase() !==
                    word.toLowerCase()
            ) {
                await fetch(
                    `/api/pronunciation/${encodeURIComponent(previousWord)}`,
                    {
                        method: "DELETE",
                    }
                );
            }

            const response =
                await fetch(
                    "/api/pronunciation",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json",
                        },
                        body: JSON.stringify({
                            word,
                            phonetic,
                        }),
                    }
                );

            if (!response.ok) {
                throw new Error(
                    `HTTP ${response.status}`
                );
            }

            const data =
                await response.json();

            if (
                data.status ===
                "error"
            ) {
                throw new Error(
                    data.error ||
                    "save failed"
                );
            }

            wordInput.value =
                "";

            phoneticInput.value =
                "";

            delete wordInput.dataset
                .editingWord;

            this.setStatus(
                `Saved "${word}".`
            );

            await this.load();

        } catch (error) {
            console.warn(
                "Pronunciation save failed:",
                error
            );

            this.setStatus(
                "Could not save pronunciation.",
                true
            );
        }
    },


    async remove(word) {
        this.setStatus(
            `Deleting "${word}"...`
        );

        try {
            const response =
                await fetch(
                    `/api/pronunciation/${encodeURIComponent(word)}`,
                    {
                        method: "DELETE",
                    }
                );

            if (!response.ok) {
                throw new Error(
                    `HTTP ${response.status}`
                );
            }

            this.setStatus(
                `Deleted "${word}".`
            );

            await this.load();

        } catch (error) {
            console.warn(
                "Pronunciation delete failed:",
                error
            );

            this.setStatus(
                "Could not delete pronunciation.",
                true
            );
        }
    },
};


function stopBMOInputPropagation(
    element
) {
    if (!element) {
        return;
    }

    /*
     * Keep typing and touching controls in the debug screen
     * from triggering BMO's push-to-talk / secret-tap logic.
     */
    const events = [
        "pointerdown",
        "pointerup",
        "pointermove",
        "touchstart",
        "touchmove",
        "touchend",
        "mousedown",
        "mouseup",
        "click",
        "keydown",
        "keyup",
    ];

    for (
        const eventName
        of events
    ) {
        element.addEventListener(
            eventName,
            (event) => {
                event.stopPropagation();
            },
            {
                passive: false,
            }
        );
    }
}


function installBMOPronunciationEditor() {
    if (
        document.getElementById(
            "bmo-pronunciation-editor"
        )
    ) {
        return true;
    }

    const faceButtons =
        document.getElementById(
            "bmo-debug-face-buttons"
        );

    if (!faceButtons) {
        return false;
    }

    const section =
        document.createElement(
            "div"
        );

    section.id =
        "bmo-pronunciation-editor";

    Object.assign(
        section.style,
        {
            marginTop: "18px",
            marginBottom: "18px",
            paddingTop: "15px",
            paddingBottom: "15px",
            borderTop:
                "1px solid rgba(0,0,0,0.20)",
            borderBottom:
                "1px solid rgba(0,0,0,0.20)",
        }
    );


    const heading =
        document.createElement(
            "div"
        );

    heading.textContent =
        "Pronunciations";

    Object.assign(
        heading.style,
        {
            fontWeight: "800",
            fontSize: "16px",
            marginBottom: "4px",
        }
    );


    const help =
        document.createElement(
            "div"
        );

    help.textContent =
        "Tell BMO how specific words should sound.";

    Object.assign(
        help.style,
        {
            fontSize: "12px",
            opacity: "0.68",
            marginBottom: "12px",
        }
    );


    const fields =
        document.createElement(
            "div"
        );

    Object.assign(
        fields.style,
        {
            display: "grid",
            gridTemplateColumns:
                "1fr 1fr",
            gap: "8px",
            width: "100%",
        }
    );


    const word =
        document.createElement(
            "input"
        );

    word.id =
        "bmo-pronunciation-word";

    word.type =
        "text";

    word.placeholder =
        "Word";

    word.autocomplete =
        "off";

    word.autocapitalize =
        "none";

    word.spellcheck =
        false;


    const phonetic =
        document.createElement(
            "input"
        );

    phonetic.id =
        "bmo-pronunciation-phonetic";

    phonetic.type =
        "text";

    phonetic.placeholder =
        "Say as";

    phonetic.autocomplete =
        "off";

    phonetic.autocapitalize =
        "none";

    phonetic.spellcheck =
        false;


    for (
        const input
        of [
            word,
            phonetic,
        ]
    ) {
        Object.assign(
            input.style,
            {
                boxSizing:
                    "border-box",
                minWidth: "0",
                width: "100%",
                padding:
                    "11px 9px",
                borderRadius:
                    "7px",
                border:
                    "1px solid rgba(0,0,0,0.35)",
                background:
                    "rgba(255,255,255,0.58)",
                color:
                    "#14351e",
                fontSize:
                    "14px",
                outline:
                    "none",
            }
        );

        stopBMOInputPropagation(
            input
        );
    }


    const save =
        document.createElement(
            "button"
        );

    save.type =
        "button";

    save.textContent =
        "Add / update";

    Object.assign(
        save.style,
        {
            width: "100%",
            marginTop: "8px",
            padding: "10px",
            borderRadius: "7px",
            border:
                "1px solid rgba(0,0,0,0.35)",
            background:
                "rgba(255,255,255,0.48)",
            color: "#14351e",
            fontWeight: "800",
            fontSize: "13px",
        }
    );

    stopBMOInputPropagation(
        save
    );

    save.addEventListener(
        "click",
        () => {
            bmoPronunciationEditor
                .save();
        }
    );


    const enterSave =
        (event) => {
            if (
                event.key ===
                "Enter"
            ) {
                event.preventDefault();

                bmoPronunciationEditor
                    .save();
            }
        };

    word.addEventListener(
        "keydown",
        enterSave
    );

    phonetic.addEventListener(
        "keydown",
        enterSave
    );


    const status =
        document.createElement(
            "div"
        );

    status.id =
        "bmo-pronunciation-status";

    Object.assign(
        status.style,
        {
            minHeight: "18px",
            marginTop: "6px",
            fontSize: "12px",
        }
    );


    const subheading =
        document.createElement(
            "div"
        );

    subheading.textContent =
        "Existing rules";

    Object.assign(
        subheading.style,
        {
            marginTop: "9px",
            marginBottom: "2px",
            fontWeight: "700",
            fontSize: "13px",
        }
    );


    const list =
        document.createElement(
            "div"
        );

    list.id =
        "bmo-pronunciation-list";


    fields.appendChild(
        word
    );

    fields.appendChild(
        phonetic
    );

    section.appendChild(
        heading
    );

    section.appendChild(
        help
    );

    section.appendChild(
        fields
    );

    section.appendChild(
        save
    );

    section.appendChild(
        status
    );

    section.appendChild(
        subheading
    );

    section.appendChild(
        list
    );


    faceButtons.parentNode.insertBefore(
        section,
        faceButtons
    );

    bmoPronunciationEditor.load();

    return true;
}


if (
    !installBMOPronunciationEditor()
) {
    const bmoPronunciationObserver =
        new MutationObserver(
            () => {
                if (
                    installBMOPronunciationEditor()
                ) {
                    bmoPronunciationObserver
                        .disconnect();
                }
            }
        );

    bmoPronunciationObserver.observe(
        document.body,
        {
            childList: true,
            subtree: true,
        }
    );
}


window.bmoPronunciationEditor =
    bmoPronunciationEditor;

console.log(
    "BMO pronunciation debug editor ready"
);

/* === END BMO PRONUNCIATION DEBUG EDITOR === */


/* BMO_SPOTIFY_POLISH_FRONTEND_V1 */


async function handleBMOSpotifyNowPlayingRequest() {
    let state;

    try {
        state =
            readBMONativeSpotifyState();

    } catch (
        error
    ) {
        console.error(
            "Could not read Spotify for now-playing request:",
            error
        );

        if (
            window.onSpotifyUnavailable
        ) {
            window.onSpotifyUnavailable();
        }

        return;
    }

    if (
        !state ||
        !state.available ||
        !state.connected
    ) {
        if (
            window.onSpotifyUnavailable
        ) {
            window.onSpotifyUnavailable();
        }

        return;
    }

    const track =
        String(
            state.track ||
            ""
        ).trim();

    const artist =
        String(
            state.artist ||
            ""
        ).trim();

    let message;

    if (
        !track
    ) {
        message =
            "Spotify isn't playing anything right now.";

    } else if (
        artist
    ) {
        message =
            `This is ${track} by ${artist}.`;

    } else {
        message =
            `This is ${track}.`;
    }

    showTranscript(
        message,
        4500
    );

    try {
        const response =
            await fetch(
                "/api/spotify-now-playing",
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
                                    message,

                                history:
                                    [],

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
                `Spotify now-playing HTTP ${response.status}`
            );
        }

        const data =
            await response.json();

        if (
            data.audio_url
        ) {
            await playBMOAudio(
                data.audio_url
            );

            return;
        }

    } catch (
        error
    ) {
        console.error(
            "Spotify now-playing speech failed:",
            error
        );
    }

    if (
        !isRecording &&
        !currentAudio
    ) {
        setFaceState(
            "idle"
        );

        resetDaydreamTimer();
    }
}


/* === BMO SPOTIFY DEBUG CONTROLS === */

const BMO_SPOTIFY_TEST_URI =
    "spotify:track:1eivMnftGIAIeTDUfTssVX";


function readBMONativeSpotifyState() {
    const bridge =
        getNativeBridge();

    if (!bridge) {
        return {
            connected: false,
            available: false,
        };
    }

    try {
        /*
         * Android 8 JavascriptInterface methods should be called
         * directly rather than inspected with typeof.
         */
        const raw =
            bridge.getSpotifyState();

        const parsed =
            JSON.parse(
                String(
                    raw ||
                    "{}"
                )
            );

        return {
            available: true,
            connected:
                Boolean(
                    parsed.connected
                ),

            localAudioActive:
                Boolean(
                    parsed.local_audio_active
                ),

            playing:
                Boolean(
                    parsed.playing
                ),

            paused:
                Boolean(
                    parsed.paused
                ),

            track:
                parsed.track ||
                null,

            artist:
                parsed.artist ||
                null,

            album:
                parsed.album ||
                null,

            uri:
                parsed.uri ||
                null,

            positionMs:
                parsed.position_ms === null ||
                parsed.position_ms === undefined
                    ? null
                    : Number(
                        parsed.position_ms
                    ),

            durationMs:
                parsed.duration_ms === null ||
                parsed.duration_ms === undefined
                    ? null
                    : Number(
                        parsed.duration_ms
                    ),
        };

    } catch (error) {
        console.warn(
            "Could not read Spotify state:",
            error
        );

        return {
            connected: false,
            available: true,
            error:
                String(
                    error
                ),
        };
    }
}


function callBMONativeSpotify(
    action,
    argument = null
) {
    const bridge =
        getNativeBridge();

    if (!bridge) {
        showStatus(
            "Spotify bridge unavailable",
            1800
        );

        return false;
    }

    try {
        switch (
            action
        ) {
            case "play":
                bridge.spotifyPlay(
                    String(
                        argument ||
                        ""
                    )
                );
                break;

            case "pause":
                bridge.spotifyPause();
                break;

            case "resume":
                bridge.spotifyResume();
                break;

            case "next":
                bridge.spotifyNext();
                break;

            case "previous":
                bridge.spotifyPrevious();
                break;

            case "connect":
                bridge.spotifyConnect();
                break;

            default:
                return false;
        }

        return true;

    } catch (error) {
        console.error(
            `Spotify action failed: ${action}`,
            error
        );

        showStatus(
            "Spotify command failed",
            1800
        );

        return false;
    }
}


function refreshBMOSpotifyDebug() {
    const section =
        document.getElementById(
            "bmo-debug-spotify"
        );

    if (!section) {
        return;
    }

    const state =
        readBMONativeSpotifyState();

    const setText =
        (
            id,
            value
        ) => {
            const element =
                document.getElementById(
                    id
                );

            if (element) {
                element.textContent =
                    String(
                        value
                    );
            }
        };

    if (
        !state.available
    ) {
        setText(
            "bmo-debug-spotify-connection",
            "native bridge unavailable"
        );

        setText(
            "bmo-debug-spotify-playback",
            "unknown"
        );

        setText(
            "bmo-debug-spotify-track",
            "—"
        );

        setText(
            "bmo-debug-spotify-artist",
            "—"
        );

        setText(
            "bmo-debug-spotify-album",
            "—"
        );

        setText(
            "bmo-debug-spotify-uri",
            "—"
        );

        return;
    }

    setText(
        "bmo-debug-spotify-connection",
        state.connected
            ? "✓ connected"
            : "✗ disconnected"
    );

    setText(
        "bmo-debug-spotify-playback",
        state.connected
            ? state.playing
                ? "▶ playing"
                : state.paused
                    ? "⏸ paused"
                    : "idle"
            : "unavailable"
    );

    setText(
        "bmo-debug-spotify-track",
        state.track ||
            "—"
    );

    setText(
        "bmo-debug-spotify-artist",
        state.artist ||
            "—"
    );

    setText(
        "bmo-debug-spotify-album",
        state.album ||
            "—"
    );

    setText(
        "bmo-debug-spotify-uri",
        state.uri ||
            "—"
    );
}


function installBMOSpotifyDebugControls() {
    if (
        document.getElementById(
            "bmo-debug-spotify"
        )
    ) {
        refreshBMOSpotifyDebug();

        return true;
    }

    const faceButtons =
        document.getElementById(
            "bmo-debug-face-buttons"
        );

    if (!faceButtons) {
        return false;
    }

    const section =
        document.createElement(
            "div"
        );

    section.id =
        "bmo-debug-spotify";

    Object.assign(
        section.style,
        {
            marginTop:
                "18px",

            marginBottom:
                "18px",

            paddingTop:
                "15px",

            paddingBottom:
                "15px",

            borderTop:
                "1px solid rgba(0,0,0,0.20)",

            borderBottom:
                "1px solid rgba(0,0,0,0.20)",
        }
    );


    const heading =
        document.createElement(
            "div"
        );

    heading.textContent =
        "Spotify";

    Object.assign(
        heading.style,
        {
            fontWeight:
                "900",

            fontSize:
                "18px",

            marginBottom:
                "10px",
        }
    );

    section.appendChild(
        heading
    );


    const stateGrid =
        document.createElement(
            "div"
        );

    Object.assign(
        stateGrid.style,
        {
            display:
                "grid",

            gridTemplateColumns:
                "100px minmax(0, 1fr)",

            gap:
                "6px 10px",

            marginBottom:
                "12px",

            padding:
                "10px",

            border:
                "2px solid #111",

            borderRadius:
                "10px",

            background:
                "rgba(255,255,255,0.45)",

            fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",

            fontSize:
                "13px",
        }
    );

    const rows = [
        [
            "Status",
            "bmo-debug-spotify-connection",
        ],
        [
            "Playback",
            "bmo-debug-spotify-playback",
        ],
        [
            "Track",
            "bmo-debug-spotify-track",
        ],
        [
            "Artist",
            "bmo-debug-spotify-artist",
        ],
        [
            "Album",
            "bmo-debug-spotify-album",
        ],
        [
            "URI",
            "bmo-debug-spotify-uri",
        ],
    ];

    for (
        const [
            labelText,
            valueId,
        ]
        of rows
    ) {
        const label =
            document.createElement(
                "div"
            );

        label.textContent =
            labelText;

        label.style.fontWeight =
            "800";

        const value =
            document.createElement(
                "div"
            );

        value.id =
            valueId;

        value.textContent =
            "...";

        value.style.overflowWrap =
            "anywhere";

        stateGrid.appendChild(
            label
        );

        stateGrid.appendChild(
            value
        );
    }

    section.appendChild(
        stateGrid
    );


    const controls =
        document.createElement(
            "div"
        );

    controls.className =
        "bmo-debug-buttons";


    const buttons = [
        {
            label:
                "Play DCC",

            action:
                "play",

            argument:
                BMO_SPOTIFY_TEST_URI,
        },
        {
            label:
                "Pause",

            action:
                "pause",
        },
        {
            label:
                "Resume",

            action:
                "resume",
        },
        {
            label:
                "Previous",

            action:
                "previous",
        },
        {
            label:
                "Next",

            action:
                "next",
        },
        {
            label:
                "Reconnect",

            action:
                "connect",
        },
    ];


    for (
        const config
        of buttons
    ) {
        const button =
            document.createElement(
                "button"
            );

        button.type =
            "button";

        button.className =
            "bmo-debug-button";

        button.textContent =
            config.label;

        button.addEventListener(
            "click",
            (event) => {
                event.preventDefault();
                event.stopPropagation();

                callBMONativeSpotify(
                    config.action,
                    config.argument ||
                        null
                );

                setTimeout(
                    refreshBMOSpotifyDebug,
                    250
                );

                setTimeout(
                    refreshBMOSpotifyDebug,
                    900
                );
            }
        );

        controls.appendChild(
            button
        );
    }

    section.appendChild(
        controls
    );


    /*
     * Put Spotify directly before the expression test buttons.
     * This works with the existing modular debug extensions.
     */
    faceButtons.parentNode.insertBefore(
        section,
        faceButtons
    );

    refreshBMOSpotifyDebug();

    return true;
}


if (
    !installBMOSpotifyDebugControls()
) {
    const bmoSpotifyDebugObserver =
        new MutationObserver(
            () => {
                if (
                    installBMOSpotifyDebugControls()
                ) {
                    bmoSpotifyDebugObserver
                        .disconnect();
                }
            }
        );

    bmoSpotifyDebugObserver.observe(
        document.body,
        {
            childList:
                true,

            subtree:
                true,
        }
    );

    setTimeout(
        () => {
            bmoSpotifyDebugObserver
                .disconnect();
        },
        15000
    );
}


/*
 * The native player-state subscription updates independently.
 * Refresh the visible debug values once per second.
 */
setInterval(
    () => {
        if (
            document.getElementById(
                "bmo-debug-spotify"
            )
        ) {
            refreshBMOSpotifyDebug();
        }
    },
    1000
);


console.log(
    "BMO Spotify debug controls ready"
);

/* === END BMO SPOTIFY DEBUG CONTROLS === */



/* === BMO SPOTIFY MUSIC MODE === */

const BMO_SPOTIFY_MUSIC_MODE_INTERVAL_MS =
    1000;

let bmoSpotifyMusicModeTimer =
    null;

let bmoSpotifyNowPlayingElement =
    null;


// BMO_SPOTIFY_PROGRESS_UI_V1

let bmoSpotifyNowPlayingLabelElement =
    null;

let bmoSpotifyProgressRowElement =
    null;

let bmoSpotifyProgressFillElement =
    null;

let bmoSpotifyProgressTimeElement =
    null;


/*
 * Spotify's App Remote state does not need to update every second.
 *
 * Keep the latest native playback position as an anchor and advance
 * it locally while Spotify is playing. Whenever Android supplies a
 * different position, URI, or playback state, re-anchor immediately.
 */
let bmoSpotifyProgressAnchorPositionMs =
    null;

let bmoSpotifyProgressAnchorTimeMs =
    null;

let bmoSpotifyProgressLastNativePositionMs =
    null;

let bmoSpotifyProgressLastUri =
    null;

let bmoSpotifyProgressLastPlaying =
    null;


function resetBMOSpotifyProgressAnchor() {
    bmoSpotifyProgressAnchorPositionMs =
        null;

    bmoSpotifyProgressAnchorTimeMs =
        null;

    bmoSpotifyProgressLastNativePositionMs =
        null;

    bmoSpotifyProgressLastUri =
        null;

    bmoSpotifyProgressLastPlaying =
        null;
}


function formatBMOSpotifyTime(
    milliseconds
) {
    const totalSeconds =
        Math.max(
            0,
            Math.floor(
                Number(
                    milliseconds
                ) /
                1000
            )
        );

    const hours =
        Math.floor(
            totalSeconds /
            3600
        );

    const minutes =
        Math.floor(
            (
                totalSeconds %
                3600
            ) /
            60
        );

    const seconds =
        totalSeconds %
        60;

    if (
        hours >
        0
    ) {
        return (
            `${hours}:` +
            `${String(minutes).padStart(2, "0")}:` +
            `${String(seconds).padStart(2, "0")}`
        );
    }

    return (
        `${minutes}:` +
        `${String(seconds).padStart(2, "0")}`
    );
}


function getBMOSpotifyDisplayPosition(
    state
) {
    if (
        !state
    ) {
        return null;
    }

    const nativePosition =
        Number(
            state.positionMs
        );

    const duration =
        Number(
            state.durationMs
        );

    if (
        !Number.isFinite(
            nativePosition
        ) ||
        !Number.isFinite(
            duration
        ) ||
        duration <=
            0
    ) {
        return null;
    }

    const uri =
        String(
            state.uri ||
            ""
        );

    const playing =
        Boolean(
            state.playing
        );

    const now =
        Date.now();

    const nativeStateChanged =
        bmoSpotifyProgressAnchorPositionMs ===
            null ||
        bmoSpotifyProgressAnchorTimeMs ===
            null ||
        bmoSpotifyProgressLastUri !==
            uri ||
        bmoSpotifyProgressLastNativePositionMs !==
            nativePosition ||
        bmoSpotifyProgressLastPlaying !==
            playing;

    if (
        nativeStateChanged
    ) {
        bmoSpotifyProgressAnchorPositionMs =
            nativePosition;

        bmoSpotifyProgressAnchorTimeMs =
            now;

        bmoSpotifyProgressLastNativePositionMs =
            nativePosition;

        bmoSpotifyProgressLastUri =
            uri;

        bmoSpotifyProgressLastPlaying =
            playing;
    }

    let position =
        bmoSpotifyProgressAnchorPositionMs;

    if (
        playing
    ) {
        position +=
            now -
            bmoSpotifyProgressAnchorTimeMs;
    }

    return Math.max(
        0,
        Math.min(
            position,
            duration
        )
    );
}


function createBMOSpotifyNowPlaying() {
    if (
        bmoSpotifyNowPlayingElement
    ) {
        return (
            bmoSpotifyNowPlayingElement
        );
    }

    const element =
        document.createElement(
            "div"
        );

    element.id =
        "bmo-spotify-now-playing";

    /*
     * Still deliberately compact and bottom-left.
     *
     * pointer-events:none keeps it completely out of the way of
     * BMO's hold-to-talk interaction.
     */
    Object.assign(
        element.style,
        {
            position:
                "fixed",

            left:
                "12px",

            bottom:
                "12px",

            width:
                "220px",

            maxWidth:
                "46vw",

            padding:
                "6px 8px",

            borderRadius:
                "14px",

            background:
                "rgba(0, 0, 0, 0.58)",

            color:
                "white",

            fontFamily:
                "sans-serif",

            fontSize:
                "11px",

            fontWeight:
                "600",

            textAlign:
                "left",

            pointerEvents:
                "none",

            zIndex:
                "9000",

            opacity:
                "0",

            transition:
                "opacity 180ms ease",

            boxSizing:
                "border-box",
        }
    );

    const label =
        document.createElement(
            "div"
        );

    Object.assign(
        label.style,
        {
            whiteSpace:
                "nowrap",

            overflow:
                "hidden",

            textOverflow:
                "ellipsis",

            textAlign:
                "center",
        }
    );

    const progressRow =
        document.createElement(
            "div"
        );

    Object.assign(
        progressRow.style,
        {
            display:
                "none",

            alignItems:
                "center",

            gap:
                "6px",

            marginTop:
                "4px",
        }
    );

    const progressTrack =
        document.createElement(
            "div"
        );

    Object.assign(
        progressTrack.style,
        {
            flex:
                "1",

            height:
                "3px",

            borderRadius:
                "999px",

            overflow:
                "hidden",

            background:
                "rgba(255, 255, 255, 0.28)",
        }
    );

    const progressFill =
        document.createElement(
            "div"
        );

    Object.assign(
        progressFill.style,
        {
            width:
                "0%",

            height:
                "100%",

            borderRadius:
                "999px",

            background:
                "currentColor",

            transition:
                "width 900ms linear",
        }
    );

    const progressTime =
        document.createElement(
            "div"
        );

    Object.assign(
        progressTime.style,
        {
            flexShrink:
                "0",

            fontSize:
                "9px",

            fontWeight:
                "500",

            opacity:
                "0.82",

            whiteSpace:
                "nowrap",

            fontVariantNumeric:
                "tabular-nums",
        }
    );

    progressTrack.appendChild(
        progressFill
    );

    progressRow.appendChild(
        progressTrack
    );

    progressRow.appendChild(
        progressTime
    );

    element.appendChild(
        label
    );

    element.appendChild(
        progressRow
    );

    document.body.appendChild(
        element
    );

    bmoSpotifyNowPlayingElement =
        element;

    bmoSpotifyNowPlayingLabelElement =
        label;

    bmoSpotifyProgressRowElement =
        progressRow;

    bmoSpotifyProgressFillElement =
        progressFill;

    bmoSpotifyProgressTimeElement =
        progressTime;

    return element;
}


function updateBMOSpotifyNowPlaying(
    state
) {
    const element =
        createBMOSpotifyNowPlaying();

    if (
        window.bmoSpotifyNowPlayingEnabled ===
            false
    ) {
        element.style.opacity =
            "0";

        resetBMOSpotifyProgressAnchor();

        return;
    }

    if (
        !state ||
        !state.available ||
        !state.connected ||
        !state.track
    ) {
        element.style.opacity =
            "0";

        resetBMOSpotifyProgressAnchor();

        return;
    }

    const track =
        String(
            state.track ||
            ""
        ).trim();

    const artist =
        String(
            state.artist ||
            ""
        ).trim();

    const prefix =
        state.playing
            ? "♫"
            : "⏸";

    bmoSpotifyNowPlayingLabelElement.textContent =
        artist
            ? `${prefix} ${track} · ${artist}`
            : `${prefix} ${track}`;

    const duration =
        Number(
            state.durationMs
        );

    const position =
        getBMOSpotifyDisplayPosition(
            state
        );

    if (
        position !==
            null &&
        Number.isFinite(
            duration
        ) &&
        duration >
            0
    ) {
        const progress =
            Math.max(
                0,
                Math.min(
                    100,
                    (
                        position /
                        duration
                    ) *
                    100
                )
            );

        bmoSpotifyProgressFillElement.style.width =
            `${progress}%`;

        bmoSpotifyProgressTimeElement.textContent =
            `${formatBMOSpotifyTime(position)} / ` +
            `${formatBMOSpotifyTime(duration)}`;

        bmoSpotifyProgressRowElement.style.display =
            "flex";

    } else {
        bmoSpotifyProgressRowElement.style.display =
            "none";
    }

    element.style.opacity =
        "1";
}


function canBMOSpotifyUseJammingFace() {
    if (
        isRecording ||
        recordingStartPending ||
        currentAudio ||
        processingTimerEvent
    ) {
        return false;
    }

    /*
     * Spotify may occupy only idle-ish faces.
     *
     * Do not override listening, thinking, speaking, errors,
     * timers, camera expressions, or temporary emotional faces.
     */
    return (
        bmoRenderer.state ===
            "idle" ||
        bmoRenderer.state ===
            "jamming" ||
        bmoRenderer.state ===
            "daydream" ||
        bmoRenderer.state ===
            "bored" ||
        bmoRenderer.state ===
            "curious"
    );
}


function applyBMOSpotifyMusicMode(
    state
) {
    updateBMOSpotifyNowPlaying(
        state
    );

    if (
        !state ||
        !state.available ||
        !state.connected
    ) {
        if (
            bmoRenderer.state ===
                "jamming"
        ) {
            setFaceState(
                "idle"
            );

            resetDaydreamTimer();
        }

        return;
    }

    // BMO_SPOTIFY_LOCAL_JAMMING_V1
    //
    // Spotify App Remote can report the account-wide Spotify Connect
    // session even when another device is actually producing the audio.
    //
    // BMO should only visually jam when Spotify says it is playing AND
    // Android confirms media audio is active on this LG.
    if (
        state.playing &&
        state.localAudioActive
    ) {
        if (
            canBMOSpotifyUseJammingFace() &&
            bmoRenderer.state !==
                "jamming"
        ) {
            stopDaydream(
                false
            );

            setFaceState(
                "jamming"
            );
        }

        return;
    }

    /*
     * Pausing Spotify releases only the jamming face.
     * If BMO is currently doing anything else, leave that alone.
     */
    if (
        bmoRenderer.state ===
            "jamming"
    ) {
        setFaceState(
            "idle"
        );

        resetDaydreamTimer();
    }
}


function refreshBMOSpotifyMusicMode() {
    try {
        const state =
            readBMONativeSpotifyState();

        applyBMOSpotifyMusicMode(
            state
        );

    } catch (
        error
    ) {
        console.debug(
            "Spotify music mode refresh failed:",
            error
        );
    }
}


function startBMOSpotifyMusicMode() {
    if (
        bmoSpotifyMusicModeTimer
    ) {
        clearInterval(
            bmoSpotifyMusicModeTimer
        );
    }

    refreshBMOSpotifyMusicMode();

    bmoSpotifyMusicModeTimer =
        setInterval(
            refreshBMOSpotifyMusicMode,
            BMO_SPOTIFY_MUSIC_MODE_INTERVAL_MS
        );
}


startBMOSpotifyMusicMode();



/* === BMO NOW PLAYING DEBUG TOGGLE === */

const BMO_NOW_PLAYING_STORAGE_KEY =
    "bmo-now-playing-enabled";

window.bmoSpotifyNowPlayingEnabled =
    localStorage.getItem(
        BMO_NOW_PLAYING_STORAGE_KEY
    ) !== "false";


function updateBMONowPlayingToggleButton() {
    const button =
        document.getElementById(
            "bmo-debug-now-playing-toggle"
        );

    if (!button) {
        return;
    }

    button.textContent =
        window.bmoSpotifyNowPlayingEnabled
            ? "Now playing: ON"
            : "Now playing: OFF";
}


function setBMONowPlayingEnabled(
    enabled
) {
    window.bmoSpotifyNowPlayingEnabled =
        Boolean(
            enabled
        );

    localStorage.setItem(
        BMO_NOW_PLAYING_STORAGE_KEY,
        window.bmoSpotifyNowPlayingEnabled
            ? "true"
            : "false"
    );

    updateBMONowPlayingToggleButton();

    if (
        !window.bmoSpotifyNowPlayingEnabled &&
        bmoSpotifyNowPlayingElement
    ) {
        bmoSpotifyNowPlayingElement.style.opacity =
            "0";
    } else {
        refreshBMOSpotifyMusicMode();
    }
}


function installBMONowPlayingDebugToggle() {
    const buttons =
        document.getElementById(
            "bmo-debug-face-buttons"
        );

    if (!buttons) {
        return false;
    }

    if (
        document.getElementById(
            "bmo-debug-now-playing-toggle"
        )
    ) {
        return true;
    }

    const button =
        document.createElement(
            "button"
        );

    button.id =
        "bmo-debug-now-playing-toggle";

    button.type =
        "button";

    button.addEventListener(
        "click",
        (event) => {
            event.preventDefault();
            event.stopPropagation();

            setBMONowPlayingEnabled(
                !window.bmoSpotifyNowPlayingEnabled
            );
        }
    );

    buttons.appendChild(
        button
    );

    updateBMONowPlayingToggleButton();

    return true;
}


if (
    !installBMONowPlayingDebugToggle()
) {
    const observer =
        new MutationObserver(
            () => {
                if (
                    installBMONowPlayingDebugToggle()
                ) {
                    observer.disconnect();
                }
            }
        );

    observer.observe(
        document.body,
        {
            childList: true,
            subtree: true,
        }
    );

    setTimeout(
        () =>
            observer.disconnect(),
        15000
    );
}




// BMO_NATIVE_VISION_PREVIEW_V1
//
// Android sends a small in-memory JPEG immediately after the front
// camera captures a frame.
//
// This layer is presentation-only:
// - the preview is never written to disk
// - the original full-resolution JPEG still goes to /api/vision
// - existing vision response/error handlers remain authoritative
// - a safety timeout prevents a stuck photo if something goes wrong

(() => {
    let previewOverlay = null;
    let previewTimeout = null;

    function hideNativeVisionPreview() {
        if (previewTimeout !== null) {
            clearTimeout(
                previewTimeout
            );

            previewTimeout = null;
        }

        if (previewOverlay !== null) {
            previewOverlay.remove();

            previewOverlay = null;
        }
    }

    function showNativeVisionPreview(
        dataUrl
    ) {
        hideNativeVisionPreview();

        if (
            typeof dataUrl !== "string" ||
            !dataUrl.startsWith(
                "data:image/"
            )
        ) {
            console.warn(
                "BMO vision preview received invalid image data"
            );

            return;
        }

        const overlay =
            document.createElement(
                "div"
            );

        overlay.id =
            "bmo-native-vision-preview";

        Object.assign(
            overlay.style,
            {
                position: "fixed",
                inset: "0",
                zIndex: "9998",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "20px",
                boxSizing: "border-box",
                background:
                    "rgba(20, 63, 54, 0.92)",
                pointerEvents: "none",
                opacity: "0",
                transition:
                    "opacity 140ms ease-out"
            }
        );

        const card =
            document.createElement(
                "div"
            );

        Object.assign(
            card.style,
            {
                position: "relative",
                maxWidth: "92vw",
                maxHeight: "88vh",
                padding: "10px",
                borderRadius: "20px",
                background: "#bdf5cb",
                boxShadow:
                    "0 10px 34px rgba(0, 0, 0, 0.38)",
                overflow: "hidden"
            }
        );

        const image =
            document.createElement(
                "img"
            );

        image.src =
            dataUrl;

        image.alt =
            "What BMO sees";

        Object.assign(
            image.style,
            {
                display: "block",
                maxWidth: "88vw",
                maxHeight: "80vh",
                width: "auto",
                height: "auto",
                objectFit: "contain",
                borderRadius: "12px"
            }
        );

        const label =
            document.createElement(
                "div"
            );

        label.textContent =
            "BMO VISION";

        Object.assign(
            label.style,
            {
                position: "absolute",
                left: "18px",
                bottom: "18px",
                padding: "5px 9px",
                borderRadius: "8px",
                background:
                    "rgba(189, 245, 203, 0.88)",
                color: "#174c3d",
                fontFamily:
                    "monospace",
                fontSize: "12px",
                fontWeight: "bold",
                letterSpacing: "1px"
            }
        );

        card.appendChild(
            image
        );

        card.appendChild(
            label
        );

        overlay.appendChild(
            card
        );

        document.body.appendChild(
            overlay
        );

        previewOverlay =
            overlay;

        requestAnimationFrame(
            () => {
                if (
                    previewOverlay ===
                    overlay
                ) {
                    overlay.style.opacity =
                        "1";
                }
            }
        );

        /*
         * This should normally be removed by the vision response/error
         * callbacks below. This is only a fail-safe.
         */
        previewTimeout =
            setTimeout(
                hideNativeVisionPreview,
                30000
            );

        console.log(
            "BMO front-camera preview displayed"
        );
    }

    /*
     * Android calls this immediately after Camera.takePicture().
     */
    window.onNativeVisionCaptured =
        function (
            dataUrl
        ) {
            try {
                showNativeVisionPreview(
                    dataUrl
                );
            } catch (
                error
            ) {
                console.error(
                    "Could not display BMO vision preview:",
                    error
                );

                hideNativeVisionPreview();
            }
        };

    /*
     * Preserve the existing response handler exactly as-is.
     * We simply hide the captured photo before handing control back.
     */
    const existingVisionResponse =
        window.onNativeVisionResponse;

    if (
        typeof existingVisionResponse ===
        "function"
    ) {
        window.onNativeVisionResponse =
            async function (
                ...args
            ) {
                hideNativeVisionPreview();

                return await existingVisionResponse.apply(
                    this,
                    args
                );
            };
    }

    /*
     * Same treatment for camera/backend failures.
     */
    const existingVisionError =
        window.onNativeVisionError;

    if (
        typeof existingVisionError ===
        "function"
    ) {
        window.onNativeVisionError =
            function (
                ...args
            ) {
                hideNativeVisionPreview();

                return existingVisionError.apply(
                    this,
                    args
                );
            };
    }

    /*
     * Expose this only for internal cleanup/debugging.
     */
    window.hideNativeVisionPreview =
        hideNativeVisionPreview;

    console.log(
        "BMO native vision preview layer ready"
    );
})();
