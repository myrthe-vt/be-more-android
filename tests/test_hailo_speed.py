import pytest

from test_hailo import MODEL_NAME, chat


@pytest.mark.parametrize(
    "prompt",
    [
        "What is the capital of France?",
        "What is self-hosting?",
    ],
)
def test_hailo_response_speed(prompt):
    """Measure that the model produces a response within a generous limit."""
    try:
        data, elapsed = chat(MODEL_NAME, prompt)
    except Exception as exc:
        pytest.skip(f"Chat API is not available: {exc}")

    assert "message" in data, f"Response missing 'message': {data}"
    assert data["message"].get("content", "").strip(), "Empty model response"

    print(f"\nModel: {MODEL_NAME}")
    print(f"Prompt: {prompt}")
    print(f"Time: {elapsed:.2f} seconds")

    # This is deliberately generous. We're measuring rather than
    # making the test unnecessarily flaky.
    assert elapsed < 120, f"Model took too long: {elapsed:.2f}s"
