import logging
import os
import re
import subprocess
import tempfile
import threading
import wave

import numpy as np
import soundfile as sf

from .config import (
    BMO_NPU_STT,
    WHISPER_CMD,
    WHISPER_HEF_PATH,
    WHISPER_MODEL,
    WHISPER_NPU_TIMEOUT_MS,
    WHISPER_THREADS,
)

logger = logging.getLogger(__name__)

# ─── NPU Speech2Text singleton ────────────────────────────────────────────────
# OFF by default (BMO_NPU_STT=1 to enable). The Hailo-10H is single-tenant, and
# this Speech2Text instance holds its VDevice for the life of the process, so
# the first transcription would take the NPU away from hailo-ollama for good,
# leaving BMO able to hear but unable to think. See core/config.py.

_s2t_lock = threading.Lock()
_s2t = None
_s2t_vdevice = None
_s2t_tried = False


def _init_npu_stt():
    """Try to create the Hailo Speech2Text singleton. Called once, under lock."""
    global _s2t, _s2t_vdevice, _s2t_tried

    _s2t_tried = True

    if not BMO_NPU_STT:
        logger.info(
            "NPU Speech2Text disabled (BMO_NPU_STT != 1) "
            "— using CPU whisper.cpp so hailo-ollama keeps the NPU for the LLM"
        )
        return

    hef = WHISPER_HEF_PATH

    if not os.path.exists(hef):
        logger.info(
            f"Whisper HEF not found at {hef} — using CPU whisper.cpp"
        )
        return

    try:
        from hailo_platform import VDevice
        from hailo_platform.genai import Speech2Text

        vdev = VDevice()

        try:
            instance = Speech2Text(vdev, hef)
        except Exception:
            try:
                vdev.release()
            except Exception:
                pass

            del vdev
            raise

        _s2t_vdevice = vdev
        _s2t = instance

        logger.info(f"NPU Speech2Text ready — {hef}")

    except Exception as exc:
        logger.warning(
            f"NPU Speech2Text init failed ({exc}) "
            "— falling back to CPU whisper.cpp"
        )


def _get_s2t():
    """Return the Speech2Text singleton, initialising it on first call."""
    with _s2t_lock:
        if not _s2t_tried:
            _init_npu_stt()

        return _s2t


# ─── Shared output cleaning ───────────────────────────────────────────────────

def _clean_transcript(text: str) -> str:
    """Remove timestamps, fix BMO spelling, and filter hallucinations."""
    text = re.sub(r"\[.*?\]", "", text).strip()

    # Whisper renders BMO's name a dozen ways. Normalise them so the agent's
    # name-detection and the transcript shown to the user agree.
    text = re.sub(
        r"\b(?:bemo|beemo|beamo|pmo|b\.?\s?m\.?\s?o\.?)\b",
        "BMO",
        text,
        flags=re.IGNORECASE,
    )

    lowered = text.lower()

    hallucinations = [
        "[silence]",
        "(silence)",
        "you",
        "thanks for watching!",
        "[blank_audio]",
        "thank you.",
        "thank you",
        "thanks.",
    ]

    is_parenthetical = bool(
        re.match(r"^\s*[\(\[].*[\)\]]\s*$", text.strip())
    )

    if (
        is_parenthetical
        or lowered in hallucinations
        or not re.search(r"[a-zA-Z0-9]", lowered)
    ):
        logger.info(
            f"Whisper hallucination filtered: {repr(text)}"
        )
        return ""

    return text


# ─── Audio normalisation ──────────────────────────────────────────────────────

def _is_whisper_ready_wav(audio_filepath: str) -> bool:
    """
    Return True if the input is already a 16 kHz, mono, 16-bit PCM WAV.

    whisper.cpp is happiest with this format. Browser recordings such as
    Android Chrome's WebM/Opus uploads are converted before transcription.
    """
    try:
        with wave.open(audio_filepath, "rb") as wav:
            return (
                wav.getnchannels() == 1
                and wav.getframerate() == 16000
                and wav.getsampwidth() == 2
                and wav.getcomptype() == "NONE"
            )
    except (wave.Error, EOFError):
        return False


def _normalise_audio_for_whisper(audio_filepath: str) -> tuple[str, bool]:
    """
    Convert arbitrary audio to 16 kHz mono 16-bit PCM WAV using ffmpeg.

    Returns:
        (path, is_temporary)

    If the input already matches Whisper's preferred WAV format, the original
    path is returned and is_temporary is False.
    """
    if _is_whisper_ready_wav(audio_filepath):
        logger.info(
            f"Audio already Whisper-ready: {audio_filepath}"
        )
        return audio_filepath, False

    fd, converted_path = tempfile.mkstemp(
        prefix="bmo_whisper_",
        suffix=".wav",
    )

    os.close(fd)

    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        audio_filepath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        converted_path,
    ]

    logger.info(
        f"Converting audio for Whisper: "
        f"{audio_filepath} -> {converted_path}"
    )

    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=60,
        )

    except FileNotFoundError:
        try:
            os.unlink(converted_path)
        except OSError:
            pass

        raise RuntimeError(
            "ffmpeg is not installed or is not available in PATH"
        )

    except subprocess.TimeoutExpired:
        try:
            os.unlink(converted_path)
        except OSError:
            pass

        raise RuntimeError(
            "ffmpeg audio conversion timed out"
        )

    if result.returncode != 0:
        try:
            os.unlink(converted_path)
        except OSError:
            pass

        error_text = result.stderr.strip()

        raise RuntimeError(
            f"ffmpeg failed to convert audio "
            f"(exit {result.returncode}): {error_text}"
        )

    if not os.path.exists(converted_path):
        raise RuntimeError(
            "ffmpeg reported success but produced no output file"
        )

    if os.path.getsize(converted_path) <= 44:
        try:
            os.unlink(converted_path)
        except OSError:
            pass

        raise RuntimeError(
            "ffmpeg produced an empty WAV file"
        )

    return converted_path, True


# ─── NPU transcription ────────────────────────────────────────────────────────

def _transcribe_npu(audio_filepath: str) -> str | None:
    """Run Whisper-Small on the Hailo NPU. Returns None on any error."""
    s2t = _get_s2t()

    if s2t is None:
        return None

    try:
        audio, sr = sf.read(
            audio_filepath,
            dtype="float32",
            always_2d=False,
        )

        if audio.ndim > 1:
            audio = audio[:, 0]

        if sr != 16000:
            from math import gcd
            from scipy.signal import resample_poly

            g = gcd(16000, sr)

            audio = resample_poly(
                audio,
                16000 // g,
                sr // g,
            ).astype(np.float32)

        from hailo_platform.genai import Speech2TextTask

        logger.info(
            "Running NPU Speech2Text (Whisper-Small)..."
        )

        with _s2t_lock:
            result = s2t.generate_all_text(
                audio_data=audio,
                task=Speech2TextTask.TRANSCRIBE,
                language="en",
                timeout_ms=WHISPER_NPU_TIMEOUT_MS,
            )

        return _clean_transcript(result or "")

    except Exception as exc:
        logger.warning(
            f"NPU Speech2Text inference failed ({exc}) "
            "— falling back to CPU"
        )

        return None


# ─── CPU transcription ────────────────────────────────────────────────────────

def _transcribe_cpu(audio_filepath: str) -> str:
    """Run whisper.cpp on the CPU."""
    try:
        cmd = [
            WHISPER_CMD,
            "-m",
            WHISPER_MODEL,
            "-f",
            audio_filepath,
            "-nt",
            "-t",
            str(WHISPER_THREADS),
            "-l",
            "en",
        ]

        logger.info(
            f"Running CPU whisper.cpp... CMD: {' '.join(cmd)}"
        )

        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
        )

        if result.returncode != 0:
            logger.error(
                f"Whisper CPU process failed "
                f"(exit {result.returncode})"
            )

            if result.stderr.strip():
                logger.error(
                    f"Whisper stderr: {result.stderr.strip()}"
                )

            return ""

        return _clean_transcript(
            result.stdout.strip()
        )

    except subprocess.TimeoutExpired:
        logger.error(
            "Whisper CPU timed out after 120 s"
        )
        return ""

    except Exception as exc:
        logger.error(
            f"Whisper CPU error: {exc}"
        )
        return ""


# ─── Public entry point ────────────────────────────────────────────────────────

def transcribe_audio(audio_filepath: str) -> str:
    """
    Transcribe an audio file.

    Browser uploads such as WebM/Opus are automatically converted to
    16 kHz mono 16-bit PCM WAV before transcription.

    Tries Whisper-Small on the Hailo-10H NPU first, then falls back to
    whisper.cpp on the CPU when the NPU is disabled or unavailable.
    """
    if not os.path.exists(audio_filepath):
        logger.error(
            f"Audio file not found: {audio_filepath}"
        )
        return ""

    whisper_audio = None
    temporary_audio = False

    try:
        whisper_audio, temporary_audio = _normalise_audio_for_whisper(
            audio_filepath
        )

        result = _transcribe_npu(
            whisper_audio
        )

        if result is not None:
            return result

        return _transcribe_cpu(
            whisper_audio
        )

    except Exception as exc:
        logger.error(
            f"Audio preparation/transcription error: {exc}"
        )
        return ""

    finally:
        if (
            temporary_audio
            and whisper_audio
            and os.path.exists(whisper_audio)
        ):
            try:
                os.unlink(whisper_audio)
            except OSError as exc:
                logger.warning(
                    f"Could not remove temporary audio "
                    f"{whisper_audio}: {exc}"
                )
