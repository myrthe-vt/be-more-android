import json
import time
import urllib.error
import urllib.request

import pytest


API_URL = "http://localhost:8000/api/chat"
MODEL_NAME = "qwen2.5-instruct:1.5b"


def chat(model_name: str, prompt: str) -> tuple[dict, float]:
    """Send a non-streaming chat request and return (response, elapsed_seconds)."""
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(
            {
                "model": model_name,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    start = time.perf_counter()

    with urllib.request.urlopen(req, timeout=120) as response:
        elapsed = time.perf_counter() - start
        raw_data = response.read().decode("utf-8")

    return json.loads(raw_data), elapsed


def test_hailo_chat():
    """Verify that the Hailo/OpenWebUI chat endpoint returns a response."""
    try:
        data, elapsed = chat(
            MODEL_NAME,
            "What is self-hosting?",
        )
    except urllib.error.URLError as exc:
        pytest.skip(f"Chat API is not available at {API_URL}: {exc}")

    assert "message" in data, f"Response missing 'message': {data}"
    assert "content" in data["message"], f"Response missing content: {data}"
    assert data["message"]["content"].strip(), "Model returned an empty response"

    print(f"\nModel: {MODEL_NAME}")
    print(f"Response: {data['message']['content'][:200]}...")
    print(f"Time: {elapsed:.2f} seconds")
