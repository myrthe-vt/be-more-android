from fastapi import FastAPI, Request, BackgroundTasks, UploadFile, File, Form, WebSocket, WebSocketDisconnect
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
import base64
import re

from core.logging_setup import configure_logging

# Configure BMO logging before importing the runtime modules so their
# log messages are also captured in the rotating file.
configure_logging()

# Import our new unified core modules
from core.llm import Brain, strip_prompt_leakage, extract_json_object, sanitize_messages
from core.tts import play_audio_on_hardware, generate_audio_file, add_pronunciation, load_pronunciations, clean_text_for_speech, remove_pronunciation
from core.stt import transcribe_audio
from core.config import LLM_URL, FAST_LLM_MODEL, WAKE_WORD_MODEL, WAKE_WORD_THRESHOLD
from core.timers import parse_timer_request, describe_duration
from core.search import search_web
from core.homelab_router import is_homelab_request, handle_homelab_request
from core.weather import (
    WeatherError,
    WeatherLocationNotFound,
    get_weather,
    get_weather_for_location,
    format_current_weather,
    format_today_forecast,
    format_tomorrow_forecast,
    format_rain_answer,
)
from core.calendar import (
    CalendarError,
    CalendarNotAuthorized,
    format_today as format_calendar_today,
    format_tomorrow as format_calendar_tomorrow,
    format_next_event as format_calendar_next_event,
    format_afternoon as format_calendar_afternoon,
)

from core.diagnostics import get_diagnostics

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
    oww_model = Model(
        wakeword_models=[WAKE_WORD_MODEL],
        inference_framework="onnx",
    )
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


@app.delete("/api/pronunciation/{word}")
def delete_pronunciation_rule(
    word: str
):
    """Delete one pronunciation override."""

    removed = remove_pronunciation(
        word
    )

    return {
        "status":
            "success"
            if removed
            else "not_found",
        "word": word.lower(),
    }


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


class DeviceBatteryRequest(BaseModel):
    message: str = ""
    battery_percent: int
    charging: bool

class DeviceNetworkRequest(BaseModel):
    message: str = ""
    connected: bool
    network_type: str = "none"


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
}

EXPRESSION_ALIASES = {
    "neutral": "idle",
    "normal": "idle",
    "default": "idle",
    "smile": "happy",
    "smiling": "happy",
    "excited": "happy",
    "cheerful": "happy",
    "cheery": "happy",
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
# Deterministic Spotify playback controls
# ---------------------------------------------------------------------------



def get_spotify_catalog_request(
    user_text: str,
):
    """
    Detect explicit artist and album playback requests.

    Track playback remains handled separately.
    """
    text = str(
        user_text or ""
    ).strip()

    if not text:
        return None

    text = text.strip(
        " \\t\\r\\n"
        "\"'“”‘’"
    )

    lower = (
        text
        .lower()
        .rstrip("?.!")
        .strip()
    )

    artist_prefixes = (
        "play the artist ",
        "play artist ",
        "play some ",
    )

    for prefix in artist_prefixes:
        if lower.startswith(
            prefix
        ):
            query = text[
                len(prefix):
            ].rstrip(
                "?.!"
            ).strip()

            if query:
                return {
                    "type": "artist",
                    "query": query,
                }

    album_prefixes = (
        "play the album ",
        "play album ",
    )

    for prefix in album_prefixes:
        if lower.startswith(
            prefix
        ):
            query = text[
                len(prefix):
            ].rstrip(
                "?.!"
            ).strip()

            if query:
                return {
                    "type": "album",
                    "query": query,
                }

    if (
        lower.startswith("play ")
        and lower.endswith(" album")
    ):
        query = text[
            len("play "):
            -len(" album")
        ].strip()

        if query:
            return {
                "type": "album",
                "query": query,
            }

    return None


def get_spotify_track_query(
    user_text: str,
):
    """
    Extract a requested Spotify track from an explicit play command.

    Transport commands such as "play the music again" are deliberately
    excluded and remain handled by get_spotify_control_action().
    """
    text = str(
        user_text or ""
    ).strip()

    if not text:
        return None

    text = text.strip(
        " \\t\\r\\n"
        "\"'“”‘’"
    )

    lower = text.lower().strip()

    excluded = {
        "play",
        "play music",
        "play the music",
        "play the music again",
        "play music again",
        "start the music",
        "start music",
        "keep playing",
        "continue playing",
    }

    if lower.rstrip("?.!") in excluded:
        return None

    prefixes = (
        "play spotify ",
        "play on spotify ",
        "play me ",
        "play ",
    )

    query = None

    for prefix in prefixes:
        if lower.startswith(
            prefix
        ):
            query = text[
                len(prefix):
            ].strip()

            break

    if not query:
        return None

    query = query.rstrip(
        "?.!"
    ).strip()

    if not query:
        return None

    return query


def get_spotify_control_action(
    user_text: str,
):
    """
    Recognize simple Spotify transport commands before the LLM.

    This deliberately handles only unambiguous playback controls.
    Searching for a requested song/artist/album is handled separately.
    """
    text = str(
        user_text or ""
    ).strip().lower()

    if not text:
        return None

    normalized = (
        text
        .replace("?", "")
        .replace("!", "")
        .replace(".", "")
        .strip()
    )

    pause_phrases = {
        "pause",
        "pause it",
        "pause music",
        "pause the music",
        "pause spotify",

        # Common speech-to-text variants of "pause".
        "paws",
        "paws it",
        "paws music",
        "paws the music",
        "paws spotify",
        "pose",
        "pose it",
        "pose music",
        "pose the music",
        "pose spotify",

        "stop the music",
        "stop music",
        "stop spotify",
        # BMO_SPOTIFY_TURN_MUSIC_OFF_V1
        "turn music off",
        "turn the music off",
    }

    resume_phrases = {
        "resume",
        "resume music",
        "resume the music",
        "resume spotify",
        "keep playing",
        "keep the music playing",
        "continue",
        "continue playing",
        "continue the music",
        "play the music again",
        "start the music again",
    }

    next_phrases = {
        "next",
        "next song",
        "next track",
        "skip",
        "skip this",
        "skip this song",
        "skip this track",
        "skip song",
        "skip track",
    }

    previous_phrases = {
        "previous",
        "previous song",
        "previous track",
        "go back",
        "go back a song",
        "go back one song",
        "go back a track",
        "play the previous song",
        "play the previous track",
        "play the last song",
        "last song",
    }

    if normalized in pause_phrases:
        return "spotify_pause"

    if normalized in resume_phrases:
        return "spotify_resume"

    if normalized in next_phrases:
        return "spotify_next"

    if normalized in previous_phrases:
        return "spotify_previous"

    return None


# ---------------------------------------------------------------------------
# Expression fallback inference
# ---------------------------------------------------------------------------
# Qwen does not always choose set_expression even when an emotional reaction
# is obvious. This lightweight fallback gives BMO a face on ordinary replies
# without requiring a second LLM call.
def infer_expression_from_text(
    user_text: str,
    assistant_text: str,
):
    """
    Lightweight contextual expression fallback.

    Explicit model-requested set_expression actions still take priority.
    This only adds personality when the model returned ordinary speech
    without choosing a face itself.
    """
    user = str(
        user_text or ""
    ).lower()

    assistant = str(
        assistant_text or ""
    ).lower()

    combined = (
        f"{user} {assistant}"
    )


    def contains_any(
        patterns,
    ):
        return any(
            pattern in combined
            for pattern in patterns
        )


    # ---------------------------------------------------------
    # Affection
    # ---------------------------------------------------------

    heart_patterns = (
        "i love you",
        "love you bmo",
        "i love bmo",
        "you're adorable",
        "you are adorable",
        "you're cute",
        "you are cute",
        "you're the best",
        "you are the best",
        "aww bmo",
        "aw bmo",
        "so sweet",
        "that's so sweet",
        "that is so sweet",
        "love that",
        "sending you a hug",
        "give you a hug",
        "hug you",
    )

    if contains_any(
        heart_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "heart",
            "duration_ms": 4000,
        }


    # ---------------------------------------------------------
    # Secrets / quiet
    # ---------------------------------------------------------

    shhh_patterns = (
        "shhh",
        "shh",
        "keep this secret",
        "keep it secret",
        "don't tell anyone",
        "do not tell anyone",
        "between you and me",
        "secret",
        "be quiet",
        "quiet please",
        "whisper",
    )

    if contains_any(
        shhh_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "shhh",
            "duration_ms": 3500,
        }


    # ---------------------------------------------------------
    # Music / dancing
    # ---------------------------------------------------------

    jamming_patterns = (
        "play some music",
        "play music",
        "sing a song",
        "sing something",
        "dance",
        "dancing",
        "jam",
        "jamming",
        "chiptune",
        "music time",
    )

    if contains_any(
        jamming_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "jamming",
            "duration_ms": 4000,
        }


    # ---------------------------------------------------------
    # Surprise / shock
    # ---------------------------------------------------------

    surprised_patterns = (
        "boo!",
        "what?!",
        "no way",
        "seriously?!",
        "surprise",
        "shocked",
        "unexpected",
        "wait, what",
        "wait what",
        "oh wow",
        "whoa",
        "woah",
    )

    if contains_any(
        surprised_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "surprised",
            "duration_ms": 3000,
        }


    # ---------------------------------------------------------
    # Confusion
    # ---------------------------------------------------------

    confused_patterns = (
        "i'm confused",
        "i am confused",
        "that makes no sense",
        "doesn't make sense",
        "does not make sense",
        "what do you mean",
        "huh?",
        "huh ",
        "wait a second",
        "i don't understand",
        "i do not understand",
        "contradiction",
        "contradictory",
        "confusing",
        "that's weird",
        "that is weird",
    )

    if contains_any(
        confused_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "confused",
            "duration_ms": 3500,
        }


    # ---------------------------------------------------------
    # Playful / cheeky
    # ---------------------------------------------------------

    cheeky_patterns = (
        "hehe",
        "heh heh",
        "wink",
        "sneaky",
        "mischief",
        "mischievous",
        "gotcha",
        "just kidding",
        "kidding!",
        "teasing",
        "cheeky",
        "smug",
    )

    if contains_any(
        cheeky_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "cheeky",
            "duration_ms": 3000,
        }


    # ---------------------------------------------------------
    # Anger
    # ---------------------------------------------------------

    angry_patterns = (
        "furious",
        "angry",
        "so annoying",
        "that's annoying",
        "that is annoying",
        "hate this",
        "ridiculous",
        "infuriating",
        "unacceptable",
        "mad at",
    )

    if contains_any(
        angry_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "angry",
            "duration_ms": 3000,
        }


    # ---------------------------------------------------------
    # Sadness
    # ---------------------------------------------------------

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
        "upset",
        "crying",
    )

    if contains_any(
        sad_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "sad",
            "duration_ms": 3200,
        }


    # ---------------------------------------------------------
    # Happiness
    # ---------------------------------------------------------

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
        "nice!",
        "excellent",
        "wonderful",
        "fantastic",
        "success",
    )

    if contains_any(
        happy_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "happy",
            "duration_ms": 3000,
        }


    # ---------------------------------------------------------
    # Sleepiness
    # ---------------------------------------------------------

    sleepy_patterns = (
        "sleepy",
        "tired",
        "exhausted",
        "going to bed",
        "good night",
        "goodnight",
        "need sleep",
        "bedtime",
    )

    if contains_any(
        sleepy_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "sleepy",
            "duration_ms": 3500,
        }


    # ---------------------------------------------------------
    # Dreaming / imagining
    # ---------------------------------------------------------

    daydream_patterns = (
        "imagine",
        "daydream",
        "what if",
        "dream about",
        "wonder what",
        "i wonder",
        "picture this",
    )

    if contains_any(
        daydream_patterns
    ):
        return {
            "type": "set_expression",
            "expression": "daydream",
            "duration_ms": 3500,
        }


    # ---------------------------------------------------------
    # Curiosity
    # ---------------------------------------------------------
    #
    # Do this fairly late so a question such as
    # "Are you angry?" does not automatically become curious if a more
    # meaningful emotion already matched above.
    #

    curiosity_patterns = (
        "i'm curious",
        "i am curious",
        "interesting",
        "that's interesting",
        "that is interesting",
        "tell me more",
        "how does",
        "how do",
        "why does",
        "why do",
        "what happens if",
        "what would happen",
    )

    looks_like_question = (
        "?" in user_text
        and len(
            str(
                user_text or ""
            )
        ) > 8
    )

    if (
        contains_any(
            curiosity_patterns
        )
        or looks_like_question
    ):
        return {
            "type": "set_expression",
            "expression": "curious",
            "duration_ms": 2800,
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
        "look": "capture_image",
        "see": "capture_image",
        "camera": "capture_image",
        "take_picture": "capture_image",
        "take_photo": "capture_image",
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

    if action == "capture_image":
        logger.info(
            "Vision action requested from Android body"
        )

        return {
            "handled": True,
            "action": action,
            "response": None,
            "client_action": {
                "type": "capture_image",
                "prompt": (
                    str(user_text).strip()
                    or "What are you looking at?"
                ),
            },
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


# ---------------------------------------------------------------------------
# Deterministic Android network-state routing
# ---------------------------------------------------------------------------

NETWORK_WIFI_PATTERNS = (
    "are you connected to wifi",
    "are you connected to wi-fi",
    "are you on wifi",
    "are you on wi-fi",
    "do you have wifi",
    "do you have wi-fi",
)

NETWORK_TYPE_PATTERNS = (
    "what network are you on",
    "what kind of network are you on",
    "what connection are you using",
    "are you using wifi",
    "are you using mobile data",
    "are you on mobile data",
)

NETWORK_CONNECTED_PATTERNS = (
    "are you connected",
    "do you have a network connection",
    "do you have network",
    "are you online",
)


def get_network_request_kind(text):
    normalized = (
        str(text or "")
        .strip()
        .lower()
    )

    if any(
        pattern in normalized
        for pattern in NETWORK_WIFI_PATTERNS
    ):
        return "wifi"

    if any(
        pattern in normalized
        for pattern in NETWORK_TYPE_PATTERNS
    ):
        return "type"

    if any(
        pattern in normalized
        for pattern in NETWORK_CONNECTED_PATTERNS
    ):
        return "connected"

    return None


def format_network_response(
    request_kind,
    connected,
    network_type,
):
    network_type = (
        str(network_type or "none")
        .strip()
        .lower()
    )

    if request_kind == "wifi":
        if (
            connected and
            network_type == "wifi"
        ):
            return (
                "Yep, I'm connected to Wi-Fi."
            )

        if connected:
            return (
                "Nope, I'm connected, but not through Wi-Fi."
            )

        return (
            "Nope, I don't have a network connection right now."
        )

    if request_kind == "type":
        if not connected:
            return (
                "I don't have a network connection right now."
            )

        names = {
            "wifi": "Wi-Fi",
            "mobile": "mobile data",
            "ethernet": "Ethernet",
            "other": "another kind of network",
        }

        readable = names.get(
            network_type,
            "another kind of network",
        )

        return (
            f"I'm connected through {readable}."
        )

    if connected:
        return (
            "Yep, I have a network connection."
        )

    return (
        "Nope, I don't have a network connection right now."
    )


# ---------------------------------------------------------------------------
# Deterministic Android device-state routing
# ---------------------------------------------------------------------------
# Device-awareness questions are decided by the Mac, but the actual state comes
# from the native Android body. Qwen never invents battery information.
BATTERY_PERCENT_PATTERNS = (
    "how much battery",
    "battery percentage",
    "battery percent",
    "battery level",
    "how full is your battery",
    "what's your battery at",
    "what is your battery at",
)

BATTERY_CHARGING_PATTERNS = (
    "are you charging",
    "are you plugged in",
    "are you plugged-in",
    "are you on charge",
    "are you connected to power",
    "are you connected to a charger",
    "are you charging right now",
)


def get_battery_request_kind(text):
    normalized = (
        str(text or "")
        .strip()
        .lower()
    )

    wants_percent = any(
        pattern in normalized
        for pattern in BATTERY_PERCENT_PATTERNS
    )

    wants_charging = any(
        pattern in normalized
        for pattern in BATTERY_CHARGING_PATTERNS
    )

    # A broad "battery status" question naturally asks for both.
    if (
        "battery status" in normalized
        or "how is your battery" in normalized
        or "how's your battery" in normalized
    ):
        wants_percent = True
        wants_charging = True

    if wants_percent and wants_charging:
        return "both"

    if wants_percent:
        return "percent"

    if wants_charging:
        return "charging"

    return None


def format_battery_response(
    request_kind: str,
    battery_percent: int,
    charging: bool,
):
    percent = max(
        0,
        min(
            100,
            int(
                battery_percent
            ),
        ),
    )

    if request_kind == "percent":
        if charging:
            return (
                f"I'm at {percent} percent, and I'm charging."
            )

        return (
            f"I'm at {percent} percent."
        )

    if request_kind == "charging":
        if charging:
            return (
                "Yep, I'm charging right now."
            )

        return (
            "Nope, I'm not charging right now."
        )

    if charging:
        return (
            f"I'm at {percent} percent, and I'm charging."
        )

    return (
        f"I'm at {percent} percent, and I'm not charging."
    )


VISION_REQUEST_PATTERNS = (
    "what are you looking at",
    "what do you see",
    "what can you see",
    "look at this",
    "look at that",
    "take a look",
    "use your camera",
    "take a picture",
    "take a photo",
    "what is in front of you",
    "what's in front of you",
)


def is_vision_request(text):
    normalized = (
        str(text or "")
        .strip()
        .lower()
    )

    return any(
        pattern in normalized
        for pattern in VISION_REQUEST_PATTERNS
    )


# ---------------------------------------------------------------------------
# BMO_CALENDAR_ROUTER_V1
# Deterministic read-only calendar routing
# ---------------------------------------------------------------------------

def get_calendar_intent(text):
    normalized = (
        str(text or "")
        .strip()
        .lower()
    )

    normalized = re.sub(
        r"[.!?]+$",
        "",
        normalized,
    ).strip()

    if not normalized:
        return None

    # Highly specific calendar/time questions should be recognized
    # before the generic calendar-keyword gate.
    if (
        "this afternoon" in normalized
        or re.search(
            r"\b(?:anything|something|plans?)\b.*\bafternoon\b",
            normalized,
        )
    ):
        return "afternoon"

    if (
        "next event" in normalized
        or "next appointment" in normalized
        or "next thing" in normalized
        or "what's next" in normalized
        or "what is next" in normalized
    ):
        return "next"

    tomorrow_patterns = (
        "tomorrow",
        "what do i have tomorrow",
        "what have i got tomorrow",
        "anything tomorrow",
        "what am i doing tomorrow",
    )

    if any(
        phrase in normalized
        for phrase in tomorrow_patterns
    ):
        return "tomorrow"

    today_patterns = (
        "today",
        "anything on today",
        "anything today",
        "what do i have today",
        "what have i got today",
        "what am i doing today",
    )

    if any(
        phrase in normalized
        for phrase in today_patterns
    ):
        return "today"

    calendar_words = (
        "calendar",
        "schedule",
        "event",
        "events",
        "appointment",
        "appointments",
        "what do i have",
        "what have i got",
        "anything on",
    )

    if any(
        phrase in normalized
        for phrase in calendar_words
    ):
        return "today"

    return None


def handle_calendar_request(calendar_intent):
    if calendar_intent == "next":
        return format_calendar_next_event()

    if calendar_intent == "tomorrow":
        return format_calendar_tomorrow()

    if calendar_intent == "afternoon":
        return format_calendar_afternoon()

    return format_calendar_today()


# ---------------------------------------------------------------------------
# BMO_WEATHER_ROUTER_V1
# Deterministic local and named-location weather routing
# ---------------------------------------------------------------------------

def get_weather_intent(text):
    normalized = (
        str(text or "")
        .strip()
        .lower()
    )

    normalized = re.sub(
        r"[.!?]+$",
        "",
        normalized,
    ).strip()

    if not normalized:
        return None

    weather_words = (
        "weather",
        "forecast",
        "rain",
        "raining",
        "umbrella",
        "temperature",
    )

    if not any(
        word in normalized
        for word in weather_words
    ):
        return None

    location = None

    location_match = re.search(
        r"\bin\s+(.+?)"
        r"(?:\s+(?:today|tomorrow))?$",
        normalized,
        re.IGNORECASE,
    )

    if location_match:
        location = (
            location_match
            .group(1)
            .strip(" ,")
        )

        if not location:
            location = None

    tomorrow = bool(
        re.search(
            r"\btomorrow\b",
            normalized,
        )
    )

    rain_request = bool(
        re.search(
            r"\b(?:rain|raining|umbrella)\b",
            normalized,
        )
    )

    if rain_request:
        intent = (
            "rain_tomorrow"
            if tomorrow
            else "rain_today"
        )

    elif tomorrow:
        intent = "tomorrow"

    elif (
        re.search(
            r"\btoday\b",
            normalized,
        )
        or "forecast" in normalized
    ):
        intent = "today"

    else:
        intent = "current"

    return {
        "intent": intent,
        "location": location,
    }


def handle_weather_request(
    weather_request
):
    intent = weather_request[
        "intent"
    ]

    location = weather_request.get(
        "location"
    )

    if location:
        weather = get_weather_for_location(
            location
        )
    else:
        weather = get_weather()

    if intent == "rain_tomorrow":
        return format_rain_answer(
            weather,
            tomorrow=True,
        )

    if intent == "rain_today":
        return format_rain_answer(
            weather,
            tomorrow=False,
        )

    if intent == "tomorrow":
        return format_tomorrow_forecast(
            weather
        )

    if intent == "today":
        return format_today_forecast(
            weather
        )

    return format_current_weather(
        weather
    )


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
    # Deterministic Spotify playback routing
    # ------------------------------------------------------------------
    spotify_action = get_spotify_control_action(
        user_text
    )

    if spotify_action:
        logger.info(
            "Deterministic Spotify control: %r -> %s",
            user_text,
            spotify_action,
        )

        response_history = save_android_memory(
            list(
                persistent_history
            ) + [
                {
                    "role": "user",
                    "content": user_text,
                },
                {
                    "role": "assistant",
                    "content": "",
                },
            ]
        )

        return {
            "response": "",
            "history": response_history,
            "audio_url": None,
            "action": {
                "type": spotify_action,
            },
        }

    # ------------------------------------------------------------------
    # Deterministic Spotify artist/album routing
    # ------------------------------------------------------------------
    spotify_catalog_request = (
        get_spotify_catalog_request(
            user_text
        )
    )

    if spotify_catalog_request:
        spotify_type = (
            spotify_catalog_request[
                "type"
            ]
        )

        spotify_query = (
            spotify_catalog_request[
                "query"
            ]
        )

        logger.info(
            "Deterministic Spotify %s request: %r -> %r",
            spotify_type,
            user_text,
            spotify_query,
        )

        try:
            from core.spotify import (
                find_album,
                find_artist,
            )

            if spotify_type == "artist":
                spotify_item = (
                    find_artist(
                        spotify_query
                    )
                )
            else:
                spotify_item = (
                    find_album(
                        spotify_query
                    )
                )

        except Exception:
            logger.exception(
                "Spotify %s search failed",
                spotify_type,
            )

            spotify_item = None

        if spotify_item:
            logger.info(
                "Spotify %s match: %s | %s",
                spotify_type,
                spotify_item.get(
                    "name"
                ),
                spotify_item.get(
                    "uri"
                ),
            )

            response_history = (
                save_android_memory(
                    list(
                        persistent_history
                    ) + [
                        {
                            "role": "user",
                            "content":
                                user_text,
                        },
                        {
                            "role":
                                "assistant",
                            "content":
                                (
                                    "Playing "
                                    f"{spotify_item.get('name')}."
                                ),
                        },
                    ]
                )
            )

            return {
                "response": "",
                "history":
                    response_history,
                "audio_url": None,
                "action": {
                    "type":
                        "spotify_play",

                    "uri":
                        spotify_item.get(
                            "uri"
                        ),

                    "track":
                        spotify_item.get(
                            "name"
                        ),

                    "spotify_type":
                        spotify_type,

                    "artist":
                        spotify_item.get(
                            "artist"
                        ),
                },
            }

        logger.info(
            "No Spotify %s match for %r",
            spotify_type,
            spotify_query,
        )

    # ------------------------------------------------------------------
    # Deterministic Spotify track search routing
    # ------------------------------------------------------------------
    spotify_query = get_spotify_track_query(
        user_text
    )

    if spotify_query:
        logger.info(
            "Deterministic Spotify track request: %r -> %r",
            user_text,
            spotify_query,
        )

        try:
            from core.spotify import (
                resolve_spotify_play_query,
            )

            spotify_track = (
                resolve_spotify_play_query(
                    spotify_query
                )
            )

        except Exception as exception:
            logger.exception(
                "Spotify track search failed"
            )

            spotify_track = None

        if spotify_track:
            logger.info(
                "Spotify match: %s | %s | %s",
                spotify_track.get(
                    "name"
                ),
                spotify_track.get(
                    "artist"
                ),
                spotify_track.get(
                    "uri"
                ),
            )

            response_history = save_android_memory(
                list(
                    persistent_history
                ) + [
                    {
                        "role": "user",
                        "content": user_text,
                    },
                    {
                        "role": "assistant",
                        "content": (
                            "Playing "
                            f"{spotify_track.get('name')} "
                            "by "
                            f"{spotify_track.get('artist')}."
                        ),
                    },
                ]
            )

            return {
                "response": "",
                "history": response_history,
                "audio_url": None,
                "action": {
                    "type":
                        "spotify_play",

                    "uri":
                        spotify_track.get(
                            "uri"
                        ),

                    "track":
                        spotify_track.get(
                            "name"
                        ),

                    "artist":
                        spotify_track.get(
                            "artist"
                        ),

                    "album":
                        spotify_track.get(
                            "album"
                        ),
                },
            }

        logger.info(
            "No Spotify track match for: %r",
            spotify_query,
        )

    # ------------------------------------------------------------------
    # Deterministic Android network-state routing
    # ------------------------------------------------------------------
    network_request_kind = get_network_request_kind(
        user_text
    )

    if network_request_kind:
        response_history = save_android_memory(
            list(
                persistent_history
            ) + [
                {
                    "role": "user",
                    "content": user_text,
                }
            ]
        )

        logger.info(
            "Deterministic Android network request: %r -> %s",
            user_text,
            network_request_kind,
        )

        return {
            "response": "",
            "history": response_history,
            "audio_url": None,
            "action": {
                "type": "get_device_network",
                "message": user_text,
                "request_kind": network_request_kind,
            },
        }

    # ------------------------------------------------------------------
    # Deterministic Android battery / charging routing
    # ------------------------------------------------------------------
    battery_request_kind = get_battery_request_kind(
        user_text
    )

    if battery_request_kind:
        response_history = save_android_memory(
            list(
                persistent_history
            ) + [
                {
                    "role": "user",
                    "content": user_text,
                }
            ]
        )

        logger.info(
            "Deterministic Android battery request: %r -> %s",
            user_text,
            battery_request_kind,
        )

        return {
            "response": "",
            "history": response_history,
            "audio_url": None,
            "action": {
                "type": "get_device_battery",
                "message": user_text,
                "request_kind": battery_request_kind,
            },
        }

    # ------------------------------------------------------------------
    # Deterministic Android camera / vision routing
    # ------------------------------------------------------------------
    if is_vision_request(
        user_text
    ):
        response_history = save_android_memory(
            list(
                persistent_history
            ) + [
                {
                    "role": "user",
                    "content": user_text,
                }
            ]
        )

        logger.info(
            "Deterministic vision request: %r",
            user_text,
        )

        return {
            "response": "",
            "history": response_history,
            "audio_url": None,
            "action": {
                "type": "capture_image",
                "prompt": user_text,
            },
        }

    # ------------------------------------------------------------------
    # BMO_CALENDAR_ROUTER_V1
    # Deterministic read-only calendar routing
    # ------------------------------------------------------------------
    calendar_intent = get_calendar_intent(
        user_text
    )

    if calendar_intent:
        logger.info(
            "Deterministic calendar request: %r -> %s",
            user_text,
            calendar_intent,
        )

        try:
            response_text = (
                handle_calendar_request(
                    calendar_intent
                )
            )

        except CalendarNotAuthorized:
            logger.warning(
                "Google Calendar is not authorized"
            )

            response_text = (
                "My calendar isn't connected yet."
            )

        except CalendarError:
            logger.exception(
                "Calendar provider failed"
            )

            response_text = (
                "I can't check your calendar right now."
            )

        except Exception:
            logger.exception(
                "Unexpected calendar request failure"
            )

            response_text = (
                "I can't check your calendar right now."
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
                "type": "calendar",
                "intent": calendar_intent,
            },
        }

    # ------------------------------------------------------------------
    # BMO_WEATHER_ROUTER_V1
    # Deterministic local and named-location weather routing
    # ------------------------------------------------------------------
    weather_request = get_weather_intent(
        user_text
    )

    if weather_request:
        weather_intent = (
            weather_request[
                "intent"
            ]
        )

        weather_location = (
            weather_request.get(
                "location"
            )
        )

        logger.info(
            "Deterministic weather request: "
            "%r -> %s location=%r",
            user_text,
            weather_intent,
            weather_location,
        )

        try:
            response_text = (
                handle_weather_request(
                    weather_request
                )
            )

        except WeatherLocationNotFound:
            logger.info(
                "Weather location not found: %r",
                weather_location,
            )

            response_text = (
                "I couldn't find that place."
            )

        except WeatherError:
            logger.exception(
                "Weather provider failed"
            )

            response_text = (
                "I can't check the weather right now."
            )

        except Exception:
            logger.exception(
                "Unexpected weather request failure"
            )

            response_text = (
                "I can't check the weather right now."
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
                f"response_"
                f"{uuid.uuid4().hex[:8]}.wav"
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
                "type": "weather",
                "intent": weather_intent,
                "location": weather_location,
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
    # Deterministic read-only homelab routing
    # ------------------------------------------------------------------
    # Keep homelab inspection deterministic and allow-listed. The LLM never
    # receives arbitrary shell access. core/homelab_router.py decides which
    # approved read-only helper to call.
    if is_homelab_request(
        user_text
    ):
        logger.info(
            "Pre-LLM homelab request matched: %r",
            user_text,
        )

        response_text = handle_homelab_request(
            user_text
        )

        # The router can return None if a phrase looked vaguely homelab-related
        # but did not match a supported read-only request. In that case, let the
        # normal BMO conversation path handle it instead of swallowing the turn.
        if response_text:
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
                    "type": "homelab_status",
                },
            }

    # ------------------------------------------------------------------
    # BMO_SPOTIFY_POLISH_ROUTER_V1
    # Deterministic Spotify polish controls
    # ------------------------------------------------------------------
    #
    # These deliberately bypass Qwen. They are hardware/media commands,
    # and Android remains the source of truth for actual Spotify state.

    spotify_command_text = (
        str(
            user_text
            or ""
        )
        .strip()
        .lower()
    )

    spotify_command_text = re.sub(
        r"[.!?]+$",
        "",
        spotify_command_text,
    ).strip()

    # "What's playing?"
    if re.fullmatch(
        r"(?:"
        r"what(?:'s| is) (?:currently )?playing|"
        r"what song is this|"
        r"what song is playing|"
        r"which song is this|"
        r"who is this by"
        r")",
        spotify_command_text,
        re.IGNORECASE,
    ):
        logger.info(
            "Deterministic Spotify now-playing request: %r",
            user_text,
        )

        return {
            "response": "",
            "history": persistent_history,
            "audio_url": None,
            "action": {
                "type": "spotify_now_playing",
            },
        }

    # Shuffle ON
    if re.fullmatch(
        r"(?:"
        r"shuffle|"
        r"shuffle the music|"
        r"shuffle music|"
        r"turn shuffle on|"
        r"turn on shuffle|"
        r"enable shuffle"
        r")",
        spotify_command_text,
        re.IGNORECASE,
    ):
        logger.info(
            "Deterministic Spotify shuffle ON: %r",
            user_text,
        )

        return {
            "response": "",
            "history": persistent_history,
            "audio_url": None,
            "action": {
                "type": "spotify_shuffle",
                "enabled": True,
            },
        }

    # Shuffle OFF
    if re.fullmatch(
        r"(?:"
        r"turn shuffle off|"
        r"turn off shuffle|"
        r"disable shuffle|"
        r"stop shuffling"
        r")",
        spotify_command_text,
        re.IGNORECASE,
    ):
        logger.info(
            "Deterministic Spotify shuffle OFF: %r",
            user_text,
        )

        return {
            "response": "",
            "history": persistent_history,
            "audio_url": None,
            "action": {
                "type": "spotify_shuffle",
                "enabled": False,
            },
        }

    # Repeat current song
    if re.fullmatch(
        r"(?:"
        r"repeat this song|"
        r"repeat this track|"
        r"repeat the song|"
        r"repeat the track|"
        r"repeat one"
        r")",
        spotify_command_text,
        re.IGNORECASE,
    ):
        logger.info(
            "Deterministic Spotify repeat ONE: %r",
            user_text,
        )

        return {
            "response": "",
            "history": persistent_history,
            "audio_url": None,
            "action": {
                "type": "spotify_repeat",
                "mode": "one",
            },
        }

    # Repeat context / playlist / album
    if re.fullmatch(
        r"(?:"
        r"repeat the music|"
        r"turn repeat on|"
        r"turn on repeat|"
        r"enable repeat|"
        r"repeat all|"
        r"repeat everything"
        r")",
        spotify_command_text,
        re.IGNORECASE,
    ):
        logger.info(
            "Deterministic Spotify repeat ALL: %r",
            user_text,
        )

        return {
            "response": "",
            "history": persistent_history,
            "audio_url": None,
            "action": {
                "type": "spotify_repeat",
                "mode": "all",
            },
        }

    # Repeat OFF
    if re.fullmatch(
        r"(?:"
        r"turn repeat off|"
        r"turn off repeat|"
        r"disable repeat|"
        r"stop repeating"
        r")",
        spotify_command_text,
        re.IGNORECASE,
    ):
        logger.info(
            "Deterministic Spotify repeat OFF: %r",
            user_text,
        )

        return {
            "response": "",
            "history": persistent_history,
            "audio_url": None,
            "action": {
                "type": "spotify_repeat",
                "mode": "off",
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

            # BMO_REJECT_HALLUCINATED_ACTION_SILENTLY_V1
            #
            # A false action sometimes arrives wrapped in confident filler
            # such as "On it!". Never speak that text unless the action is
            # something we deliberately still dispatch on the client.
            legacy_client_actions = {
                "display_image",
                "play_music",
            }

            action_name = str(
                action_result.get("action")
                or action_data.get("action")
                or ""
            ).lower().strip()

            if action_name in legacy_client_actions:
                if lead_in_text:
                    spoken_text = lead_in_text

                    logger.info(
                        "Validated legacy client action+lead-in: "
                        "TTS=%r action=%s",
                        spoken_text[:40],
                        action_name,
                    )
                else:
                    is_action = True

                    logger.info(
                        "Validated legacy client action: %s; "
                        "skipping TTS",
                        action_name,
                    )

            else:
                logger.warning(
                    "Rejected unsupported LLM action silently: %s",
                    action_name or "<missing>",
                )

                # Do not display or speak confident filler from a rejected
                # action. The raw JSON should not enter conversation memory.
                content = ""
                spoken_text = ""
                is_action = True

                if (
                    response_history and
                    isinstance(response_history[-1], dict) and
                    response_history[-1].get("role") == "assistant"
                ):
                    response_history.pop()
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


@app.post("/api/device-network")
def device_network(
    request: DeviceNetworkRequest,
    background_tasks: BackgroundTasks,
):
    user_text = str(
        request.message or ""
    ).strip()

    request_kind = (
        get_network_request_kind(
            user_text
        )
        or "connected"
    )

    response_text = format_network_response(
        request_kind,
        request.connected,
        request.network_type,
    )

    current_history = load_android_memory()

    updated_history = list(
        current_history
    )

    if not (
        updated_history
        and isinstance(
            updated_history[-1],
            dict,
        )
        and updated_history[-1].get("role") == "user"
        and str(
            updated_history[-1].get(
                "content",
                "",
            )
        ).strip() == user_text
    ):
        if user_text:
            updated_history.append(
                {
                    "role": "user",
                    "content": user_text,
                }
            )

    updated_history.append(
        {
            "role": "assistant",
            "content": response_text,
        }
    )

    updated_history = save_android_memory(
        updated_history
    )

    tts_content = (
        clean_text_for_speech(
            response_text
        )
        or response_text
    )

    background_tasks.add_task(
        _cleanup_old_audio
    )

    filename = (
        f"response_{uuid.uuid4().hex[:8]}.wav"
    )

    audio_url = generate_audio_file(
        tts_content,
        filename,
    )

    return {
        "response": response_text,
        "history": updated_history,
        "audio_url": audio_url,
        "action": None,
    }


@app.post("/api/device-battery")
def device_battery(
    request: DeviceBatteryRequest,
    background_tasks: BackgroundTasks,
):
    """
    Turn native Android battery state into a deterministic spoken BMO reply.

    /api/chat stores the user's device-state question before asking the client
    for native state. This endpoint appends only the assistant answer.
    """
    user_text = str(
        request.message or ""
    ).strip()

    request_kind = (
        get_battery_request_kind(
            user_text
        )
        or "both"
    )

    response_text = format_battery_response(
        request_kind,
        request.battery_percent,
        request.charging,
    )

    current_history = load_android_memory()

    updated_history = list(
        current_history
    )

    # The /api/chat battery route already appended the user question.
    # If this endpoint is called manually, keep memory coherent anyway.
    if not (
        updated_history
        and isinstance(
            updated_history[-1],
            dict,
        )
        and updated_history[-1].get("role") == "user"
        and str(
            updated_history[-1].get(
                "content",
                "",
            )
        ).strip() == user_text
    ):
        if user_text:
            updated_history.append(
                {
                    "role": "user",
                    "content": user_text,
                }
            )

    updated_history.append(
        {
            "role": "assistant",
            "content": response_text,
        }
    )

    updated_history = save_android_memory(
        updated_history
    )

    tts_content = (
        clean_text_for_speech(
            response_text
        )
        or response_text
    )

    background_tasks.add_task(
        _cleanup_old_audio
    )

    filename = (
        f"response_{uuid.uuid4().hex[:8]}.wav"
    )

    audio_url = generate_audio_file(
        tts_content,
        filename,
    )

    return {
        "response": response_text,
        "history": updated_history,
        "audio_url": audio_url,
        "action": None,
    }


@app.post("/api/vision")
def vision(
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
    prompt: str = Form("What are you looking at?"),
):
    """Analyze one still image captured by the Android BMO body."""
    try:
        image_bytes = image.file.read()

        if not image_bytes:
            return {
                "error": "No image data received."
            }

        logger.info(
            "Received Android camera image: %s bytes",
            len(image_bytes),
        )

        encoded_image = base64.b64encode(
            image_bytes
        ).decode(
            "ascii"
        )

        current_history = load_android_memory()

        brain = Brain(
            persist=False
        )

        brain.set_history(
            current_history
        )

        vision_prompt = (
            str(prompt or "")
            .strip()
            or "What are you looking at?"
        )

        content = brain.analyze_image(
            encoded_image,
            vision_prompt,
        )

        if not isinstance(
            content,
            str,
        ):
            content = str(
                content
            )

        content = content.strip()

        if not content:
            content = (
                "BMO looked very carefully, "
                "but couldn't figure out what was there."
            )

        if (
            content.startswith("Error:")
            or content.startswith("Could not connect")
            or content.startswith("I'm having trouble")
        ):
            return {
                "error": content,
                "history": current_history,
            }

        updated_history = list(
            current_history
        )

        # /api/chat already stores the camera-request user message.
        # Avoid duplicating it here before appending the vision answer.
        if not (
            updated_history
            and isinstance(
                updated_history[-1],
                dict,
            )
            and updated_history[-1].get("role") == "user"
            and str(
                updated_history[-1].get(
                    "content",
                    "",
                )
            ).strip() == vision_prompt
        ):
            updated_history.append(
                {
                    "role": "user",
                    "content": vision_prompt,
                }
            )

        updated_history.append(
            {
                "role": "assistant",
                "content": content,
            }
        )

        updated_history = save_android_memory(
            updated_history
        )

        tts_content = (
            clean_text_for_speech(
                content
            )
            or content
        )

        background_tasks.add_task(
            _cleanup_old_audio
        )

        filename = (
            f"response_{uuid.uuid4().hex[:8]}.wav"
        )

        audio_url = generate_audio_file(
            tts_content,
            filename,
        )

        client_action = infer_expression_from_text(
            vision_prompt,
            content,
        )

        return {
            "response": content,
            "history": updated_history,
            "audio_url": audio_url,
            "action": client_action,
        }

    except Exception as exception:
        logger.exception(
            "Vision endpoint failed"
        )

        return {
            "error": (
                "BMO's eyes had a little problem: "
                f"{exception}"
            )
        }



# BMO_SPOTIFY_UNAVAILABLE_TTS_V1
@app.post("/api/spotify-unavailable")
def spotify_unavailable(
    background_tasks: BackgroundTasks,
):
    """
    Generate BMO's deterministic Spotify-unavailable message.

    This deliberately bypasses the LLM. Android has already determined
    that Spotify/App Remote failed, so the frontend only needs a short,
    reliable spoken explanation.
    """
    response_text = (
        "Spotify isn't available right now."
    )

    tts_content = (
        clean_text_for_speech(
            response_text
        )
        or response_text
    )

    background_tasks.add_task(
        _cleanup_old_audio
    )

    filename = (
        f"response_{uuid.uuid4().hex[:8]}.wav"
    )

    audio_url = generate_audio_file(
        tts_content,
        filename,
    )

    return {
        "response": response_text,
        "audio_url": audio_url,
    }



# BMO_SPOTIFY_NOW_PLAYING_TTS_V1
@app.post("/api/spotify-now-playing")
def spotify_now_playing_tts(
    request: ChatRequest,
    background_tasks: BackgroundTasks,
):
    """
    Speak Android's current Spotify metadata using BMO's normal Piper voice.
    """
    response_text = (
        str(
            request.message
            or ""
        ).strip()
        or "Spotify isn't playing anything right now."
    )

    tts_content = (
        clean_text_for_speech(
            response_text
        )
        or response_text
    )

    background_tasks.add_task(
        _cleanup_old_audio
    )

    filename = (
        f"response_{uuid.uuid4().hex[:8]}.wav"
    )

    audio_url = generate_audio_file(
        tts_content,
        filename,
    )

    return {
        "response": response_text,
        "audio_url": audio_url,
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
        logger.debug("WebSocket disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Browser / Android client error reporting
# ---------------------------------------------------------------------------
#
# These reports are intentionally tiny and read-only from BMO's point of
# view. They give the Mac log and developer panel visibility into failures
# that would otherwise live only inside WebView / Logcat.
#
# Android forwarding is added separately. Supporting the "android" source
# here now means it can plug into the same path later without another API.

class ClientErrorReport(BaseModel):
    source: str = "frontend"
    message: str
    detail: str | None = None
    url: str | None = None
    line: int | None = None
    column: int | None = None


_client_error_lock = threading.Lock()

_last_client_errors = {
    "frontend": None,
    "android": None,
}


def _clean_client_error_text(
    value,
    limit,
):
    if value is None:
        return None

    text = str(value).strip()

    if not text:
        return None

    return text[:limit]


def _client_error_snapshot():
    with _client_error_lock:
        return {
            key: (
                dict(value)
                if isinstance(value, dict)
                else None
            )
            for key, value
            in _last_client_errors.items()
        }


@app.post("/api/client-error")
def report_client_error(
    report: ClientErrorReport
):
    source = (
        report.source or "frontend"
    ).strip().lower()

    if source not in {
        "frontend",
        "android",
    }:
        source = "frontend"

    message = (
        _clean_client_error_text(
            report.message,
            1000,
        )
        or "Unknown client error"
    )

    detail = _clean_client_error_text(
        report.detail,
        4000,
    )

    url = _clean_client_error_text(
        report.url,
        1000,
    )

    item = {
        "timestamp":
            datetime.datetime.now(
                datetime.timezone.utc
            ).isoformat(),
        "source": source,
        "message": message,
        "detail": detail,
        "url": url,
        "line": report.line,
        "column": report.column,
    }

    with _client_error_lock:
        _last_client_errors[source] = item

    location = ""

    if url:
        location = f" at {url}"

        if report.line is not None:
            location += (
                f":{report.line}"
            )

            if report.column is not None:
                location += (
                    f":{report.column}"
                )

    if detail:
        logger.error(
            "Client %s error: %s%s | %s",
            source,
            message,
            location,
            detail,
        )
    else:
        logger.error(
            "Client %s error: %s%s",
            source,
            message,
            location,
        )

    return {
        "status": "logged"
    }


@app.get("/api/diagnostics")
def diagnostics_status():
    """
    Return a read-only BMO diagnostics snapshot.

    This is deliberately separate from /api/status so the existing
    fast frontend heartbeat keeps its current semantics.
    """
    data = get_diagnostics()

    data["clients"] = (
        _client_error_snapshot()
    )

    return data


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

    def choose_idle_expression(
        topic_text,
        thought_text
    ):
        """
        Ask BMO's fast local model how the thing it just learned
        actually makes BMO feel.
        """
        valid_expressions = {
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
            "bored",
            "curious",
        }

        try:
            import requests as http_requests

            expression_messages = [
                {
                    "role": "system",
                    "content": (
                        "Choose BMO's facial expression for an idle "
                        "thought. Pick EXACTLY ONE from this list: "
                        "happy, sad, angry, surprised, sleepy, "
                        "daydream, dizzy, cheeky, heart, starry_eyed, "
                        "confused, shhh, jamming, football, detective, "
                        "sir_mano, bored, curious. "
                        "Base the choice on the meaning and emotional "
                        "tone of what BMO learned. Prefer curious for "
                        "ordinary interesting facts. Use strong "
                        "expressions only when clearly appropriate. "
                        "Reply ONLY with the expression name."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Topic: {topic_text or 'unknown'}\n"
                        f"Thought: {thought_text or ''}"
                    ),
                },
            ]

            payload = {
                "model": FAST_LLM_MODEL,
                "messages": sanitize_messages(
                    expression_messages
                ),
                "stream": False,
                "options": {
                    "temperature": 0.2,
                    "num_predict": 8,
                },
            }

            response = http_requests.post(
                LLM_URL,
                json=payload,
                timeout=10
            )

            if response.status_code == 200:
                expression = (
                    response
                    .json()
                    .get(
                        "message",
                        {}
                    )
                    .get(
                        "content",
                        ""
                    )
                    .strip()
                    .lower()
                    .replace(
                        "-",
                        "_"
                    )
                    .replace(
                        " ",
                        "_"
                    )
                )

                expression = re.sub(
                    r"[^a-z_]",
                    "",
                    expression
                )

                if expression in valid_expressions:
                    return expression

        except Exception as e:
            logger.warning(
                f"[SCREENSAVER-WEB] Expression classification failed: {e}"
            )

        return "curious"


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
    topic = None

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

    expression = choose_idle_expression(
        topic,
        phrase
    )

    logger.info(
        "[SCREENSAVER-WEB] "
        f"Topic={topic!r} "
        f"Expression={expression!r}"
    )

    return {
        "topic": topic,
        "thought": phrase,
        "expression": expression,
        "image_url": image_url,
    }

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

