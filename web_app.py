from fastapi import FastAPI, Request, BackgroundTasks, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
import logging
import os
import json
import uuid
import requests
import shutil
import numpy as np
import psutil
import subprocess
import datetime
import threading
import queue
import re

# Import our new unified core modules
from core.llm import Brain, strip_prompt_leakage, extract_json_object, sanitize_messages
from core.tts import play_audio_on_hardware, generate_audio_file, add_pronunciation, load_pronunciations, clean_text_for_speech
from core.stt import transcribe_audio
from core.config import LLM_URL, FAST_LLM_MODEL, WAKE_WORD_MODEL, WAKE_WORD_THRESHOLD
from core.timers import parse_timer_request, describe_duration
from core.search import search_web

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Android BMO persistent conversation memory
# ---------------------------------------------------------------------------
# Keep this separate from the legacy desktop agent's memory.json. Android BMO
# owns this file and persists a small rolling conversation window across
# WebView/app/backend restarts.
ANDROID_MEMORY_FILE = "memory_android.json"
ANDROID_MEMORY_MAX_MESSAGES = 20
_android_memory_lock = threading.Lock()

_MEMORY_RESET_PHRASES = {
    "forget everything",
    "forget our conversation",
    "reset memory",
    "clear memory",
    "clear your memory",
    "wipe memory",
    "wipe your memory",
}


def _normalize_memory(history):
    """Keep only safe role/content chat messages and cap the rolling window."""
    cleaned = []

    for item in history or []:
        if not isinstance(item, dict):
            continue

        role = item.get("role")
        content = item.get("content")

        if role not in {"user", "assistant"}:
            continue

        if not isinstance(content, str):
            continue

        content = content.strip()

        if not content:
            continue

        cleaned.append(
            {
                "role": role,
                "content": content,
            }
        )

    return cleaned[-ANDROID_MEMORY_MAX_MESSAGES:]


def load_android_memory():
    with _android_memory_lock:
        if not os.path.exists(
            ANDROID_MEMORY_FILE
        ):
            return []

        try:
            with open(
                ANDROID_MEMORY_FILE,
                "r",
                encoding="utf-8",
            ) as handle:
                data = json.load(
                    handle
                )

            return _normalize_memory(
                data
            )

        except Exception:
            logger.exception(
                "Could not load Android BMO memory"
            )

            return []


def save_android_memory(history):
    cleaned = _normalize_memory(
        history
    )

    temporary_file = (
        ANDROID_MEMORY_FILE +
        ".tmp"
    )

    with _android_memory_lock:
        try:
            with open(
                temporary_file,
                "w",
                encoding="utf-8",
            ) as handle:
                json.dump(
                    cleaned,
                    handle,
                    ensure_ascii=False,
                    indent=2,
                )

            os.replace(
                temporary_file,
                ANDROID_MEMORY_FILE,
            )

        except Exception:
            logger.exception(
                "Could not save Android BMO memory"
            )

            try:
                if os.path.exists(
                    temporary_file
                ):
                    os.remove(
                        temporary_file
                    )
            except Exception:
                pass

    return cleaned


def clear_android_memory():
    return save_android_memory(
        []
    )


def get_android_memory_for_request(client_history=None):
    """
    Disk is the source of truth after persistence begins.

    If no memory file exists yet, seed it once from the WebView's current
    conversation history so enabling this feature does not erase the user's
    already-active conversation.
    """
    if os.path.exists(
        ANDROID_MEMORY_FILE
    ):
        return load_android_memory()

    seeded = _normalize_memory(
        client_history or []
    )

    if seeded:
        save_android_memory(
            seeded
        )

    return seeded


def is_memory_reset_request(text):
    normalized = (
        str(text or "")
        .strip()
        .lower()
        .rstrip(".!?")
    )

    return normalized in _MEMORY_RESET_PHRASES


def append_memory_turn(history, user_text, assistant_text):
    updated = list(
        history or []
    )

    updated.append(
        {
            "role": "user",
            "content": str(
                user_text
            ).strip(),
        }
    )

    updated.append(
        {
            "role": "assistant",
            "content": str(
                assistant_text
            ).strip(),
        }
    )

    return save_android_memory(
        updated
    )


# ---------------------------------------------------------------------------
# Server-side timers
# ---------------------------------------------------------------------------
# Timers belong to BMO's Mac brain.  We use threading.Timer because /api/chat
# is intentionally a synchronous FastAPI handler running in a thread pool.
#
# When a timer expires the Mac generates the spoken WAV immediately, then
# places a small event in this thread-safe queue.  The Android/WebView client
# can poll /api/timer-events and play it.
_timer_events = queue.Queue()
_active_timers = set()
_timer_lock = threading.Lock()


def _timer_finished(timer_id: str, message: str):
    logger.info(
        "Timer expired: id=%s message=%r",
        timer_id,
        message,
    )

    audio_url = None

    try:
        spoken = clean_text_for_speech(message) or message
        filename = f"response_timer_{uuid.uuid4().hex[:8]}.wav"
        audio_url = generate_audio_file(
            spoken,
            filename,
        )
    except Exception:
        logger.exception(
            "Failed to generate timer-expiry TTS"
        )

    _timer_events.put(
        {
            "event": "timer_finished",
            "timer_id": timer_id,
            "message": message,
            "audio_url": audio_url,
        }
    )

    with _timer_lock:
        finished = [
            timer
            for timer in _active_timers
            if getattr(timer, "bmo_timer_id", None) == timer_id
        ]

        for timer in finished:
            _active_timers.discard(timer)


def _schedule_server_timer(minutes: float, message: str) -> str:
    timer_id = uuid.uuid4().hex[:10]
    seconds = max(0.0, float(minutes) * 60.0)

    timer = threading.Timer(
        seconds,
        _timer_finished,
        args=(
            timer_id,
            message,
        ),
    )

    timer.daemon = True
    timer.bmo_timer_id = timer_id

    with _timer_lock:
        _active_timers.add(timer)

    timer.start()

    logger.info(
        "Timer started: id=%s duration=%.4f minutes message=%r",
        timer_id,
        minutes,
        message,
    )

    return timer_id


# Try to load openwakeword for web streaming
try:
    from openwakeword.model import Model
    # Initialize the model once for the web app
    oww_model = Model(wakeword_model_paths=[WAKE_WORD_MODEL])
    logger.info(f"Loaded OpenWakeWord model: {WAKE_WORD_MODEL}")
except Exception as e:
    logger.warning(f"Could not load OpenWakeWord for web app: {e}")
    oww_model = None

app = FastAPI(title="BMO Web UI")

# Ensure audio directory exists
os.makedirs("static/audio", exist_ok=True)

import time as _time
from collections import deque
recent_thoughts = deque(maxlen=20) # Cache last 20 thoughts to avoid repeats

AUDIO_DIR = os.path.join("static", "audio")
AUDIO_MAX_AGE_SECONDS = 300  # 5 minutes

def _cleanup_old_audio():
    """Remove generated audio files older than AUDIO_MAX_AGE_SECONDS."""
    try:
        now = _time.time()
        for f in os.listdir(AUDIO_DIR):
            if not f.startswith("response_"):
                continue
            fpath = os.path.join(AUDIO_DIR, f)
            if now - os.path.getmtime(fpath) > AUDIO_MAX_AGE_SECONDS:
                os.remove(fpath)
    except Exception as e:
        logger.warning(f"Audio cleanup error: {e}")

@app.on_event("startup")
async def startup_cleanup():
    _cleanup_old_audio()

# Mount static files (for CSS, JS, images, and audio)
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/faces", StaticFiles(directory="faces"), name="faces")
app.mount("/sounds", StaticFiles(directory="sounds"), name="sounds")

# Setup templates
templates = Jinja2Templates(directory="templates")

class ChatRequest(BaseModel):
    message: str
    history: list = []
    play_on_hardware: bool = False
    image: str = None # Optional base64 image for vision tasks

class PronunciationRequest(BaseModel):
    word: str
    phonetic: str


# ---------------------------------------------------------------------------
# Deterministic web-search routing
# ---------------------------------------------------------------------------
# Current/fresh information should not depend on Qwen deciding to call a tool.
# These patterns intentionally cover explicit search requests and obviously
# time-sensitive questions. Ordinary evergreen questions still go to Qwen.
_EXPLICIT_SEARCH_RE = re.compile(
    r"^\s*(?:"
    r"search(?:\s+(?:the\s+)?web)?(?:\s+for)?|"
    r"google|"
    r"look\s+up|"
    r"find\s+(?:online|on\s+the\s+web)"
    r")\s+(?P<query>.+?)\s*$",
    re.IGNORECASE,
)

_FRESH_INFO_RE = re.compile(
    r"\b(?:"
    r"latest|"
    r"current|"
    r"currently|"
    r"today(?:'s)?|"
    r"right\s+now|"
    r"recent|"
    r"newest|"
    r"breaking|"
    r"news|"
    r"this\s+week|"
    r"this\s+month"
    r")\b",
    re.IGNORECASE,
)

_FRESH_QUESTION_RE = re.compile(
    r"^\s*(?:"
    r"what(?:'s|\s+is)|"
    r"what\s+happened|"
    r"tell\s+me|"
    r"give\s+me|"
    r"do\s+you\s+know"
    r")\b",
    re.IGNORECASE,
)


def get_pre_llm_search_query(text: str):
    """
    Return a search query when the utterance clearly asks for web/current info.

    Explicit search commands always route to search. Freshness words route only
    when the utterance looks like an information request, which reduces false
    positives such as "my newest project is working".
    """
    if not text:
        return None

    stripped = text.strip()

    explicit = _EXPLICIT_SEARCH_RE.match(
        stripped
    )

    if explicit:
        query = (
            explicit.group("query")
            or ""
        ).strip()

        return query or None

    if (
        _FRESH_INFO_RE.search(stripped)
        and _FRESH_QUESTION_RE.search(stripped)
    ):
        return stripped

    return None


def perform_web_search_answer(query: str, user_text: str) -> str:
    """
    Search using core.search and turn the result into a concise spoken answer.
    """
    logger.info(
        "Searching web for: %r",
        query,
    )

    try:
        search_result = search_web(
            query
        )

        if (
            not search_result
            or search_result == "SEARCH_EMPTY"
        ):
            return (
                "I searched, but I couldn't find anything useful about that."
            )

        if search_result == "SEARCH_ERROR":
            return (
                "I can't reach the internet right now."
            )

        logger.info(
            "Web search succeeded for %r",
            query,
        )

        try:
            summary = _summarize_search_result(
                search_result,
                user_text or query,
            )

            if summary:
                return summary

        except Exception:
            logger.exception(
                "Search result summarization failed"
            )

        return (
            "I found something, but I had trouble summarizing it."
        )

    except Exception:
        logger.exception(
            "Web search failed for %r",
            query,
        )

        return (
            "I can't reach the internet right now."
        )


def _summarize_search_result(search_result: str, user_text: str) -> str:
    """
    Turn raw search output into a short spoken BMO answer.

    The original desktop agent searches first, then asks the LLM to summarize
    the real-world result. Keep the same pattern here so Android never has to
    understand raw search payloads.
    """
    messages = [
        {
            "role": "system",
            "content": (
                "You are BMO, a cute helpful robot assistant. "
                "Answer the user's question using ONLY the supplied web search "
                "result. Be concise and natural, usually two to four short "
                "sentences. Always finish your final sentence. If the result "
                "does not contain enough information, say that instead of "
                "inventing facts."
            ),
        },
        {
            "role": "user",
            "content": (
                f"USER QUESTION:\n{user_text}\n\n"
                f"WEB SEARCH RESULT:\n{search_result}"
            ),
        },
    ]

    payload = {
        "model": FAST_LLM_MODEL,
        "messages": sanitize_messages(messages),
        "stream": False,
        "options": {
            "temperature": 0.3,
            "num_predict": 300,
        },
    }

    response = requests.post(
        LLM_URL,
        json=payload,
        timeout=60,
    )

    response.raise_for_status()

    content = (
        response.json()
        .get("message", {})
        .get("content", "")
        .strip()
    )

    return strip_prompt_leakage(content).strip()



# ---------------------------------------------------------------------------
# Facial expressions
# ---------------------------------------------------------------------------
VALID_EXPRESSIONS = {
    "idle",
    "happy",
    "sad",
    "angry",
    "surprised",
    "sleepy",
    "daydream",
}

EXPRESSION_ALIASES = {
    "neutral": "idle",
    "normal": "idle",
    "default": "idle",
    "smile": "happy",
    "smiling": "happy",
    "excited": "happy",
    "joy": "happy",
    "joyful": "happy",
    "concerned": "sad",
    "worried": "sad",
    "upset": "sad",
    "mad": "angry",
    "annoyed": "angry",
    "shock": "surprised",
    "shocked": "surprised",
    "surprise": "surprised",
    "tired": "sleepy",
    "sleeping": "sleepy",
    "dreamy": "daydream",
    "pondering": "daydream",
}


def normalize_expression(value):
    raw = str(value or "").lower().strip()

    normalized = EXPRESSION_ALIASES.get(
        raw,
        raw,
    )

    if normalized in VALID_EXPRESSIONS:
        return normalized

    return None


def normalize_expression_duration(action_data):
    raw = (
        action_data.get("duration_ms")
        or action_data.get("duration")
        or 3000
    )

    try:
        duration = float(raw)
    except (TypeError, ValueError):
        duration = 3000.0

    # If the model supplied a small number, it probably meant seconds.
    if 0 < duration <= 20:
        duration *= 1000.0

    return int(
        max(
            1000,
            min(
                6000,
                duration,
            ),
        )
    )



# ---------------------------------------------------------------------------
# Expression fallback inference
# ---------------------------------------------------------------------------
# Qwen does not always choose set_expression even when an emotional reaction
# is obvious. This lightweight fallback gives BMO a face on ordinary replies
# without requiring a second LLM call.
def infer_expression_from_text(user_text: str, assistant_text: str):
    combined = (
        f"{user_text} {assistant_text}"
        .lower()
    )

    happy_patterns = (
        "awesome",
        "amazing",
        "great news",
        "good news",
        "yay",
        "woohoo",
        "congrats",
        "congratulations",
        "fixed it",
        "it works",
        "worked!",
        "love that",
        "nice!",
    )

    sad_patterns = (
        "dropped my sandwich",
        "lost my",
        "broke my",
        "that sucks",
        "that is sad",
        "that's sad",
        "sorry",
        "oh no",
        "unfortunately",
        "bad news",
        "died",
        "failed",
        "hurt",
    )

    surprised_patterns = (
        "boo!",
        "what?!",
        "no way",
        "seriously?!",
        "surprise",
        "shocked",
        "unexpected",
    )

    angry_patterns = (
        "furious",
        "angry",
        "so annoying",
        "hate this",
        "ridiculous",
        "infuriating",
    )

    sleepy_patterns = (
        "sleepy",
        "tired",
        "exhausted",
        "going to bed",
        "good night",
        "goodnight",
    )

    daydream_patterns = (
        "wonder",
        "imagine",
        "daydream",
        "what if",
        "dream about",
    )

    if any(
        pattern in combined
        for pattern in surprised_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "surprised",
            "duration_ms": 3000,
        }

    if any(
        pattern in combined
        for pattern in angry_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "angry",
            "duration_ms": 3000,
        }

    if any(
        pattern in combined
        for pattern in sad_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "sad",
            "duration_ms": 3000,
        }

    if any(
        pattern in combined
        for pattern in happy_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "happy",
            "duration_ms": 3000,
        }

    if any(
        pattern in combined
        for pattern in sleepy_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "sleepy",
            "duration_ms": 3000,
        }

    if any(
        pattern in combined
        for pattern in daydream_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "daydream",
            "duration_ms": 3000,
        }

    return None


def execute_server_action(action_data, user_text=""):
    """
    Execute actions that belong on BMO's Mac brain.

    Android remains a thin body. Tools that need the Mac, internet, local
    services, or future homelab access should execute here.
    """
    raw_action = str(
        action_data.get(
            "action",
            "",
        )
    ).lower().strip()

    value = (
        action_data.get("value")
        or action_data.get("query")
        or action_data.get("expression")
        or action_data.get("state")
        or ""
    )

    aliases = {
        "check_time": "get_time",
        "time": "get_time",
        "google": "search_web",
        "browser": "search_web",
        "news": "search_web",
        "search_news": "search_web",
        "web_search": "search_web",
        "expression": "set_expression",
        "face": "set_expression",
        "set_face": "set_expression",
        "show_expression": "set_expression",
    }

    action = aliases.get(
        raw_action,
        raw_action,
    )

    logger.info(
        "Server action requested: %s -> %s",
        raw_action,
        action,
    )

    if action == "get_time":
        now = datetime.datetime.now().strftime(
            "%I:%M %p"
        )

        return {
            "handled": True,
            "action": action,
            "response": (
                f"The current time is {now}."
            ),
        }

    if action == "search_web":
        query = str(value).strip()

        if not query:
            logger.warning(
                "search_web requested without a query"
            )

            return {
                "handled": True,
                "action": action,
                "response": (
                    "What would you like me to search for?"
                ),
            }

        return {
            "handled": True,
            "action": action,
            "response": perform_web_search_answer(
                query,
                user_text or query,
            ),
        }

    if action == "set_expression":
        expression = normalize_expression(
            value
        )

        if not expression:
            logger.warning(
                "Ignoring unsupported expression: %r",
                value,
            )

            return {
                "handled": False,
                "action": action,
                "response": None,
            }

        duration_ms = normalize_expression_duration(
            action_data
        )

        logger.info(
            "Expression action: %s for %sms",
            expression,
            duration_ms,
        )

        return {
            "handled": True,
            "action": action,
            "response": None,
            "client_action": {
                "type": "set_expression",
                "expression": expression,
                "duration_ms": duration_ms,
            },
        }

    # Do not silently swallow tools we have not migrated yet.
    return {
        "handled": False,
        "action": action,
        "response": None,
    }

@app.get("/")
async def read_root(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"request": request},
    )

@app.get("/favicon.png")
async def get_favicon():
    return FileResponse("favicon.png")

@app.post("/api/pronunciation")
async def add_pronunciation_rule(request: PronunciationRequest):
    """Add a new pronunciation rule."""
    add_pronunciation(request.word, request.phonetic)
    return {"status": "success", "word": request.word, "phonetic": request.phonetic}

@app.get("/api/pronunciation")
async def get_pronunciations():
    """Get all pronunciation rules."""
    return load_pronunciations()

@app.get("/api/debug")
async def get_debug_info():
    """Get system diagnostics and Hailo status."""
    info = {
        "status": "online",
        "system": {
            "cpu_percent": psutil.cpu_percent(interval=0.1),
            "memory_percent": psutil.virtual_memory().percent
        },
        "hailo": {
            "status": "unknown",
            "error": None
        },
        "logs": []
    }

    # Check Hailo/Ollama status
    try:
        # Extract base URL from LLM_URL (e.g., http://127.0.0.1:8000)
        base_url = LLM_URL.split("/api/")[0]
        response = requests.get(f"{base_url}/api/tags", timeout=2)
        if response.status_code == 200:
            info["hailo"]["status"] = "online"
        else:
            info["hailo"]["status"] = f"error ({response.status_code})"
    except Exception as e:
        info["hailo"]["status"] = "offline"
        info["hailo"]["error"] = str(e)

    # Get recent logs from journalctl
    try:
        result = subprocess.run(
            ["journalctl", "-u", "bmo-web", "-n", "10", "--no-pager"],
            capture_output=True, text=True, timeout=2
        )
        info["logs"] = result.stdout.splitlines()
    except Exception as e:
        info["logs"] = [f"Could not fetch logs: {e}"]

    return info


@app.get("/api/timer-events")
def get_timer_events():
    """
    Return timer expirations waiting for the BMO UI.

    Non-blocking by design. The Android/WebView side can poll this endpoint
    alongside its existing backend health checks.
    """
    events = []

    while True:
        try:
            events.append(
                _timer_events.get_nowait()
            )
        except queue.Empty:
            break

    return {
        "events": events,
    }


@app.post("/api/chat")
# Sync def on purpose: brain.think() blocks for tens of seconds on the NPU.
# As `async def` it would block uvicorn's event loop, freezing /api/status, the
# wakeword WebSocket and every other route.  FastAPI runs sync handlers in a
# threadpool, so slow turns no longer wedge the UI.
def chat(request: ChatRequest, background_tasks: BackgroundTasks):
    """
    Send text to local LLM (Hailo/Ollama) and get response.
    """
    user_text = request.message
    play_on_hardware = request.play_on_hardware

    persistent_history = get_android_memory_for_request(
        request.history
    )

    # Memory reset is deterministic and scoped only to Android BMO.
    if is_memory_reset_request(
        user_text
    ):
        clear_android_memory()

        response_text = (
            "Okay. I forgot our conversation history."
        )

        logger.info(
            "Android BMO memory cleared by voice request"
        )

        audio_url = None
        tts_content = (
            clean_text_for_speech(
                response_text
            )
            or response_text
        )

        background_tasks.add_task(
            _cleanup_old_audio
        )

        if play_on_hardware:
            background_tasks.add_task(
                play_audio_on_hardware,
                tts_content,
            )
        else:
            filename = (
                f"response_{uuid.uuid4().hex[:8]}.wav"
            )

            audio_url = generate_audio_file(
                tts_content,
                filename,
            )

        return {
            "response": response_text,
            "history": [],
            "audio_url": audio_url,
            "action": {
                "type": "memory_cleared",
            },
        }

    # ------------------------------------------------------------------
    # Deterministic timer/reminder routing
    # ------------------------------------------------------------------
    # Do this BEFORE Qwen. core/timers.py deliberately owns duration parsing
    # so "30 seconds" can never become "30 minutes" because of model output.
    timer_request = parse_timer_request(
        user_text
    )

    if timer_request:
        minutes = timer_request["minutes"]
        timer_message = timer_request["message"]

        timer_id = _schedule_server_timer(
            minutes,
            timer_message,
        )

        duration_text = describe_duration(
            minutes
        )

        response_text = (
            f"Okay! Timer set for {duration_text}."
        )

        logger.info(
            "Timer request handled before LLM: %r -> %s (%s)",
            user_text,
            duration_text,
            timer_id,
        )

        # Keep browser/Android conversation history coherent even though the
        # LLM was intentionally skipped for this turn.
        response_history = append_memory_turn(
            persistent_history,
            user_text,
            response_text,
        )

        audio_url = None
        tts_content = (
            clean_text_for_speech(
                response_text
            )
            or response_text
        )

        background_tasks.add_task(
            _cleanup_old_audio
        )

        if play_on_hardware:
            background_tasks.add_task(
                play_audio_on_hardware,
                tts_content,
            )
        else:
            filename = (
                f"response_{uuid.uuid4().hex[:8]}.wav"
            )

            audio_url = generate_audio_file(
                tts_content,
                filename,
            )

        return {
            "response": response_text,
            "history": response_history,
            "audio_url": audio_url,
            "action": {
                "type": "timer_set",
                "timer_id": timer_id,
                "minutes": minutes,
                "message": timer_message,
            },
        }

    # ------------------------------------------------------------------
    # Deterministic current-info / explicit web-search routing
    # ------------------------------------------------------------------
    # Do this before Qwen so fresh-information requests cannot be answered
    # from stale model knowledge merely because the model chose a different
    # action such as set_expression.
    search_query = get_pre_llm_search_query(
        user_text
    )

    if search_query:
        logger.info(
            "Pre-LLM web search matched: %r -> %r",
            user_text,
            search_query,
        )

        response_text = perform_web_search_answer(
            search_query,
            user_text,
        )

        response_history = append_memory_turn(
            persistent_history,
            user_text,
            response_text,
        )

        audio_url = None
        tts_content = (
            clean_text_for_speech(
                response_text
            )
            or response_text
        )

        background_tasks.add_task(
            _cleanup_old_audio
        )

        if play_on_hardware:
            background_tasks.add_task(
                play_audio_on_hardware,
                tts_content,
            )
        else:
            filename = (
                f"response_{uuid.uuid4().hex[:8]}.wav"
            )

            audio_url = generate_audio_file(
                tts_content,
                filename,
            )

        return {
            "response": response_text,
            "history": response_history,
            "audio_url": audio_url,
            "action": {
                "type": "web_search",
                "query": search_query,
            },
        }

    # Initialize a non-persistent Brain because Android BMO now owns its own
    # persistence layer in memory_android.json. This avoids touching the legacy
    # desktop agent's memory.json while still preserving context across restarts.
    brain = Brain(persist=False)
    brain.set_history(
        persistent_history
    )

    # If an image is provided, use the vision model
    if request.image:
        logger.info("Received image for vision analysis.")
        content = brain.analyze_image(request.image, user_text)
    else:
        # Get response from LLM (includes keyword-triggered search and camera detection)
        content = brain.think(user_text)

    # Check if there was an error
    if content.startswith("Error:") or content.startswith("Could not connect") or content.startswith("I'm having trouble"):
        return {
            "error": content,
            "history": persistent_history,
        }

    # Action detection.
    #
    # Historically the web endpoint returned action JSON to the client and
    # expected the browser/desktop UI to execute it. Android should stay a
    # thin BMO body, so Mac-side tools are now executed here instead.
    #
    # For this first bridge only get_time is migrated. Unknown/unmigrated
    # actions retain the old client-dispatch behaviour.
    is_action = False
    spoken_text = content
    client_action = None
    action_data, span = extract_json_object(content)

    if action_data and "action" in action_data:
        lead_in_text = (
            content[:span[0]] +
            content[span[1]:]
        ).strip()

        action_result = execute_server_action(
            action_data,
            user_text=user_text,
        )

        if action_result["handled"]:
            client_action = action_result.get(
                "client_action"
            )

            action_response = action_result.get(
                "response"
            )

            # UI-only actions such as set_expression often accompany a spoken
            # lead-in. Preserve that natural text. Pure JSON expression actions
            # stay silent while still reaching the Android/Web face.
            if action_response is None:
                content = lead_in_text
                spoken_text = lead_in_text
                is_action = not bool(
                    lead_in_text
                )
            else:
                content = action_response
                spoken_text = content
                is_action = False

            logger.info(
                "Server action completed: %s -> %r",
                action_result["action"],
                content,
            )

            # brain.think() already recorded the model's raw action JSON.
            # Replace or remove that raw JSON so persistent memory remains
            # conversational instead of filling up with internal tool payloads.
            response_history = brain.get_history()
            if (
                response_history and
                isinstance(response_history[-1], dict) and
                response_history[-1].get("role") == "assistant"
            ):
                if content:
                    response_history[-1] = {
                        "role": "assistant",
                        "content": content,
                    }
                else:
                    response_history.pop()
        else:
            response_history = brain.get_history()

            if lead_in_text:
                # Existing behaviour for tools not migrated yet:
                # speak the lead-in but leave the action JSON in the response
                # so older clients can still dispatch it.
                spoken_text = lead_in_text

                logger.info(
                    "Unmigrated action+lead-in: TTS=%r action=%s",
                    spoken_text[:40],
                    action_data.get("action"),
                )
            else:
                # Pure JSON response for an unmigrated action.
                is_action = True

                logger.info(
                    "Unmigrated action response detected: %s; skipping TTS",
                    action_data.get("action"),
                )
    else:
        response_history = brain.get_history()

    audio_url = None

    if not is_action:
        # Clean text for TTS (applies pronunciation replacements like BMO->beemo).
        # Keep the original content for display so the user sees "BMO" not "beemo".
        tts_content = clean_text_for_speech(spoken_text)
        if not tts_content:
            tts_content = spoken_text  # fallback to raw if cleaning strips everything

        # Periodically clean up old audio files
        background_tasks.add_task(_cleanup_old_audio)

        if play_on_hardware:
            # Play on Pi speakers in the background so we don't block the UI response
            background_tasks.add_task(play_audio_on_hardware, tts_content)
        else:
            # Generate a WAV file for the browser to play
            filename = f"response_{uuid.uuid4().hex[:8]}.wav"
            audio_url = generate_audio_file(tts_content, filename)

    response_history = save_android_memory(
        response_history
    )

    if client_action is None:
        client_action = infer_expression_from_text(
            user_text,
            content,
        )

        if client_action is not None:
            logger.info(
                "Expression fallback inferred: %s",
                client_action.get("expression"),
            )

    response_payload = {
        "response": content,
        "history": response_history,
        "audio_url": audio_url,
    }

    if client_action is not None:
        response_payload["action"] = client_action

    return response_payload


@app.get("/api/memory")
def get_android_memory_status():
    """Small diagnostics endpoint for Android BMO's rolling memory."""
    history = load_android_memory()

    return {
        "messages": len(history),
        "max_messages": ANDROID_MEMORY_MAX_MESSAGES,
        "file": ANDROID_MEMORY_FILE,
    }


@app.post("/api/memory/clear")
def clear_android_memory_endpoint():
    """Explicit API reset for diagnostics / future settings UI."""
    clear_android_memory()

    return {
        "status": "cleared",
    }


@app.post("/api/transcribe")
# Sync def: whisper.cpp blocks for seconds (see chat() above).
def transcribe(audio: UploadFile = File(...)):
    """
    Receive an audio file from the browser, save it temporarily,
    and transcribe it using whisper.cpp.
    """
    temp_filename = f"temp_{uuid.uuid4().hex}.webm"
    temp_filepath = os.path.join("static", "audio", temp_filename)

    try:
        # Save the uploaded file
        with open(temp_filepath, "wb") as buffer:
            shutil.copyfileobj(audio.file, buffer)

        # Transcribe it
        text = transcribe_audio(temp_filepath)

        return {"text": text}
    except Exception as e:
        logger.error(f"Transcription endpoint error: {e}")
        return {"error": str(e)}
    finally:
        # Clean up the original uploaded file
        if os.path.exists(temp_filepath):
            try:
                os.remove(temp_filepath)
            except Exception as e:
                logger.warning(f"Could not remove temp file {temp_filepath}: {e}")

@app.websocket("/api/wakeword")
async def websocket_wakeword(websocket: WebSocket):
    """
    WebSocket endpoint for continuous audio streaming from the browser.
    Expects 16kHz 16-bit PCM audio chunks.
    """
    await websocket.accept()
    if oww_model is None:
        await websocket.send_json({"error": "Wake word model not loaded on server."})
        await websocket.close()
        return

    try:
        while True:
            # Receive binary audio data (Int16 PCM)
            data = await websocket.receive_bytes()

            # Convert bytes to numpy array
            audio_chunk = np.frombuffer(data, dtype=np.int16)

            # Feed to openwakeword
            oww_model.predict(audio_chunk)

            # Check predictions
            for key in oww_model.prediction_buffer.keys():
                if oww_model.prediction_buffer[key][-1] > WAKE_WORD_THRESHOLD:
                    logger.info(f"Web Wake Word Detected: {key}")
                    await websocket.send_json({"event": "wakeword_detected", "model": key})
                    oww_model.reset()
                    break # Only trigger once per chunk

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.close()
        except Exception:
            pass

@app.get("/api/status")
async def get_status():
    """Check if the Hailo LLM server is reachable."""
    try:
        # Check the base Ollama URL (e.g., http://127.0.0.1:8000)
        base_url = LLM_URL.replace("/api/chat", "")
        response = requests.get(base_url, timeout=2)
        if response.status_code == 200:
            return {"status": "online"}
    except Exception:
        pass
    return {"status": "offline"}

@app.get("/api/faces/{state}")
async def get_face(state: str):
    """
    Returns a list of image paths for a given state (idle, thinking, speaking, etc.)
    """
    # Prevent path traversal by rejecting any path separators
    if "/" in state or "\\" in state or ".." in state:
        return {"images": []}
    face_dir = os.path.join("faces", state)
    if not os.path.exists(face_dir) or not os.path.isdir(face_dir):
        return {"images": []}

    images = [f"/faces/{state}/{img}" for img in os.listdir(face_dir) if img.endswith(('.png', '.jpg', '.jpeg'))]
    return {"images": sorted(images)}

@app.get("/api/sounds/{category}")
async def get_sounds(category: str):
    """
    Returns a list of sound paths for a given category (greeting_sounds, ack_sounds, thinking_sounds)
    """
    # Prevent path traversal by rejecting any path separators
    if "/" in category or "\\" in category or ".." in category:
        return {"sounds": []}
    sound_dir = os.path.join("sounds", category)
    if not os.path.exists(sound_dir) or not os.path.isdir(sound_dir):
        return {"sounds": []}

    sounds = [f"/sounds/{category}/{s}" for s in os.listdir(sound_dir) if s.endswith('.wav')]
    return {"sounds": sorted(sounds)}

@app.get("/api/screensaver-thought")
# Sync def: web search + LLM can block for a minute (see chat() above).
def get_screensaver_thought():
    """Generate a random BMO thought for the web screensaver.
    Uses web search + local LLM."""
    import random
    import re
    from core.search import search_web, search_images
    from core.config import LLM_URL, FAST_LLM_MODEL

    fallback_phrases = [
        "I wonder what Finn and Jake are doing right now.",
        "Does anyone want to play a video game? No? ...Okay.",
        "La la la la la... BMO is the best!",
        "Sometimes BMO just likes to hum a little tune.",
        "Football... is a tough little guy.",
        "Is it time for a video game yet? I have a new one!",
        "I hope everyone is having a wonderful day. Especially you!",
        "Sometimes I like to just sit and think about... well, everything!",
        "Being a robot is pretty cool, but being BMO is even better!",
    ]

    phrase = None
    image_url = None

    try:
        # 1. Ask the LLM for a random, weird, or interesting topic to search for
        # This ensures the thoughts are always fresh and diverse.
        topic = None
        try:
            topic_messages = [
                {"role": "system", "content": "You are BMO's brain. Suggest one very specific, random, and interesting topic for BMO to learn about today. Examples: 'history of the first toaster', 'why do wombats have square poop', 'the mystery of the Voynich manuscript'. Keep it under 10 words. Provide ONLY the topic, no quotes or preamble."},
                {"role": "user", "content": "Give me a random topic."}
            ]
            topic_payload = {
                "model": FAST_LLM_MODEL,
                "messages": sanitize_messages(topic_messages),
                "stream": False,
                "options": {"temperature": 1.0, "num_predict": 20}
            }
            import requests as http_requests
            topic_resp = http_requests.post(LLM_URL, json=topic_payload, timeout=10)
            if topic_resp.status_code == 200:
                topic = topic_resp.json().get("message", {}).get("content", "").strip().strip('"').strip("'")
                # Remove any BMO tags or prefix if the LLM leaked them
                topic = re.sub(r'^Topic:|^BMO topic:|^I want to learn about: ', '', topic, flags=re.IGNORECASE)
        except Exception as e:
            logger.warning(f"[SCREENSAVER-WEB] LLM topic generation failed: {e}")

        # Fallback to a fixed list if LLM fails
        if not topic or len(topic) < 3:
            search_topics = [
                "interesting fun fact of the day",
                "weather forecast today in Brantford, Ontario",
                "this day in history",
                "cool science discovery this week",
                "funny animal fact",
                "Adventure Time lore or trivia",
                "latest space news from NASA",
                "strange laws in Canada",
                "history of robots",
                "cool deep sea creatures",
                "unusual world records",
                "mysteries of the pyramids",
                "evolution of video game consoles",
                "fun facts about penguins",
            ]
            topic = random.choice(search_topics)
            # Avoid picking the same topic too often
            for _ in range(3):
                if topic in recent_thoughts:
                    topic = random.choice(search_topics)
                else:
                    break

        logger.info(f"[SCREENSAVER-WEB] Pondering about: {topic}")
        search_result = search_web(topic)

        if search_result and search_result not in ("SEARCH_EMPTY", "SEARCH_ERROR"):
            thought_prompt = (
                "Read this real-world info, then share a short charming musing "
                "as BMO (under 50 words, finish the thought). "
                "Wrap your final reply between [BMO] and [/BMO] markers — only "
                "what's between the markers will be spoken. "
                "If the topic is visual, include ONE JSON action AFTER [/BMO]: "
                '{"action": "display_image", "subject": "<short visual phrase>"} '
                f"Topic: {topic} "
                f"Info: {search_result[:1500]}"
            )
            messages = [
                {"role": "system", "content":
                 "You are BMO, a cute robot musing to yourself. Always wrap your "
                 "spoken reply in [BMO]...[/BMO] tags. Be concise and specific."},
                {"role": "user", "content": thought_prompt},
            ]

            # Try local LLM
            try:
                payload = {
                    "model": FAST_LLM_MODEL,
                    "messages": sanitize_messages(messages),
                    "stream": False,
                    "options": {"temperature": 0.8, "num_predict": 256}
                }
                resp = http_requests.post(LLM_URL, json=payload, timeout=60)
                if resp.status_code == 200:
                    content = resp.json().get("message", {}).get("content", "").strip()
                    if content and "connect" not in content.lower() and "error" not in content.lower():
                        # Strip leakage and reasoning
                        phrase = strip_prompt_leakage(content)
                        if phrase:
                            recent_thoughts.append(topic)
            except Exception as e:
                logger.warning(f"[SCREENSAVER-WEB] Local LLM failed: {e}")

            # Extract image URL if present (brace-balanced; handles nesting)
            if phrase:
                while True:
                    action_data, span = extract_json_object(phrase)
                    if action_data is None:
                        break
                    if action_data.get("action") == "display_image":
                        subject = action_data.get("subject") or action_data.get("image_url")
                        if subject:
                            if "://" in subject:
                                image_url = subject
                            else:
                                image_url = search_images(subject)
                        phrase = (phrase[:span[0]] + phrase[span[1]:]).strip()
                        break  # Only one image
                    elif "action" in action_data:
                        # Other action — strip it and keep scanning
                        phrase = (phrase[:span[0]] + phrase[span[1]:]).strip()
                    else:
                        # Bare {} or non-action JSON — stop the loop
                        break
                # Final cleanup of the phrase
                phrase = strip_prompt_leakage(phrase)
    except Exception as e:
        logger.error(f"[SCREENSAVER-WEB] Thought generation failed: {e}")

    if not phrase:
        phrase = random.choice(fallback_phrases)

    return {"thought": phrase, "image_url": image_url}

if __name__ == "__main__":
    import uvicorn
    import glob

    # Check for Tailscale SSL certificates (*.ts.net.crt / *.ts.net.key)
    cert_files = glob.glob("*.ts.net.crt")
    key_files = glob.glob("*.ts.net.key")

    if cert_files and key_files:
        cert_file = cert_files[0]
        key_file = key_files[0]
        logger.info(f"Found SSL certificates ({cert_file}). Starting securely on HTTPS...")
        uvicorn.run("web_app:app", host="0.0.0.0", port=8080, ssl_certfile=cert_file, ssl_keyfile=key_file, workers=2)
    else:
        logger.info("No SSL certificates found. Starting on HTTP...")
        # Run on all interfaces (0.0.0.0) so it can be accessed from other machines on the network
        uvicorn.run("web_app:app", host="0.0.0.0", port=8080, workers=2)

