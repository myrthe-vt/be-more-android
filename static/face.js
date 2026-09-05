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
const CHARGER_REACTION_COOLDOWN_MS = 10000;

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

                /*
                 * Idle BMO occasionally wanders into little critter
                 * animations and odd moods.
                 *
                 * Repeated entries act as simple weighting so the
                 * stranger states stay delightful rather than constant.
                 */
                /*
                 * Passive idle motion should stay emotionally neutral.
                 *
                 * Strong expressions are now driven by whatever BMO is
                 * actually thinking about rather than appearing randomly.
                 *
                 * Critters are also removed from the full-screen idle
                 * rotation for now. Their assets remain available for a
                 * future overlay system.
                 */
                const moods = [
                    "daydream",
                    "daydream",
                    "daydream",

                    "idle",
                    "idle",

                    "sleepy",
                    "bored",
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


/*
 * Idle-thought expressions
 *
 * BMO's stronger facial expressions should have a reason.
 * Instead of choosing them randomly, infer a suitable expression
 * from the actual thought BMO is currently displaying.
 *
 * This is deliberately conservative. If nothing clearly matches,
 * BMO simply looks curious.
 */

function inferDaydreamThoughtExpression(
    thought
) {
    const text =
        String(
            thought ||
            ""
        ).toLowerCase();


    /*
     * Affection, sweetness, animals doing adorable things, etc.
     */
    if (
        /\b(love|lovely|adorable|cute|heartwarming|sweet|affection|cuddle|hug|holding hands)\b/.test(
            text
        )
    ) {
        return "heart";
    }


    /*
     * Space gets its own slightly awestruck look.
     */
    if (
        /\b(space|planet|moon|star|stars|galaxy|galaxies|nebula|universe|astronom|cosmic|saturn|jupiter|mars|venus)\b/.test(
            text
        )
    ) {
        return "starry_eyed";
    }


    /*
     * Music-related discoveries.
     */
    if (
        /\b(music|song|album|singer|band|concert|melody|musician|dance|dancing)\b/.test(
            text
        )
    ) {
        return "jamming";
    }


    /*
     * Clearly sad or worrying subjects.
     */
    if (
        /\b(sad|died|death|dead|loss|lost|extinct|endangered|decline|disaster|tragedy|tragic|destroyed|suffering)\b/.test(
            text
        )
    ) {
        return "sad";
    }


    /*
     * Things that are genuinely infuriating rather than merely negative.
     */
    if (
        /\b(outrage|outrageous|cruel|cruelty|abuse|poaching|deliberately destroyed)\b/.test(
            text
        )
    ) {
        return "angry";
    }


    /*
     * Unexpected discoveries and record-breaking oddities.
     */
    if (
        /\b(surpris|unexpected|astonish|amazing|incredible|record-breaking|record breaking|first ever|never before|discovered|discovery)\b/.test(
            text
        )
    ) {
        return "surprised";
    }


    /*
     * Weird mysteries and things that do not make immediate sense.
     */
    if (
        /\b(mystery|mysterious|unknown|unexplained|puzzling|baffling|strange|weird|odd|why does|nobody knows)\b/.test(
            text
        )
    ) {
        return "confused";
    }


    /*
     * Sleep-related thoughts can make BMO look appropriately sleepy.
     */
    if (
        /\b(sleep|sleeping|dream|dreaming|nap|napping|bedtime)\b/.test(
            text
        )
    ) {
        return "sleepy";
    }


    /*
     * Positive discoveries without a stronger matching emotion.
     */
    if (
        /\b(good news|success|successful|recovered|restored|rescued|saved|thriving|celebrat|wonderful|delightful)\b/.test(
            text
        )
    ) {
        return "happy";
    }


    /*
     * Most idle research is fundamentally BMO going:
     * "Huh! What's this?"
     */
    return "curious";
}


function showDaydreamThoughtExpression(
    thought
) {
    if (
        !daydreamActive ||
        !canDaydream()
    ) {
        return;
    }

    const expression =
        inferDaydreamThoughtExpression(
            thought
        );

    /*
     * Don't let the ordinary idle mood timer replace the expression
     * halfway through BMO's thought.
     */
    clearTimeout(
        daydreamMoodTimer
    );

    daydreamMoodTimer =
        null;

    setFaceState(
        expression
    );

    console.log(
        "BMO idle thought expression:",
        expression,
        "for:",
        thought
    );

    /*
     * Keep the expression visible alongside the thought, then drift
     * naturally back into daydream mode.
     */
    daydreamMoodTimer =
        setTimeout(
            () => {
                daydreamMoodTimer =
                    null;

                if (
                    !daydreamActive ||
                    !canDaydream()
                ) {
                    return;
                }

                setFaceState(
                    "daydream"
                );

                scheduleDaydreamMood();
            },
            12000
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

        const thought =
            String(
                data.thought ||
                ""
            ).trim();

        if (
            thought
        ) {
            daydreamThoughtVisible =
                true;

            showDaydreamThoughtExpression(
                thought
            );

            showTranscript(
                thought,
                12000
            );

            setTimeout(
                () => {
                    daydreamThoughtVisible =
                        false;
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
