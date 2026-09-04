"""Tests for OpenWakeWord model loading."""

from pathlib import Path

import pytest


MODEL_PATH = Path(__file__).parent.parent / "wakeword.onnx"


def test_wakeword_model_loads():
    """Verify that the OpenWakeWord model can be loaded."""
    try:
        from openwakeword.model import Model
    except ImportError:
        pytest.fail("openwakeword is not installed")

    if not MODEL_PATH.exists():
        pytest.fail(f"Wake word model not found: {MODEL_PATH}")

    try:
        model = Model(wakeword_models=[str(MODEL_PATH)])
    except Exception as exc:
        pytest.fail(f"Failed to load wake word model: {exc}")

    assert model is not None
