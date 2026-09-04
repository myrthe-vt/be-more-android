import pytest

from test_hailo import MODEL_NAME, chat


def test_hailo_1b_capital_of_france():
    """Verify that the 1.5B model can answer a simple factual question."""
    try:
        data, elapsed = chat(
            MODEL_NAME,
            "What is the capital of France?",
        )
    except Exception as exc:
        pytest.skip(f"Chat API is not available: {exc}")

    assert "message" in data, f"Response missing 'message': {data}"
    assert "content" in data["message"], f"Response missing content: {data}"

    content = data["message"]["content"].strip()

    assert content, "Model returned an empty response"
    assert "paris" in content.lower(), (
        f"Expected the answer to mention Paris, got: {content}"
    )

    print(f"\nModel: {MODEL_NAME}")
    print(f"Response: {content[:200]}...")
    print(f"Time: {elapsed:.2f} seconds")
