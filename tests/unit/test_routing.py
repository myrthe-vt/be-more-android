import pytest

from web_app import (
    get_calendar_intent,
    get_spotify_catalog_request,
    get_spotify_control_action,
    get_spotify_track_query,
    get_weather_intent,
    is_vision_request,
)
from core.homelab_router import is_homelab_request


# ---------------------------------------------------------------------------
# Calendar
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "text,expected",
    [
        ("What's on my calendar today?", "today"),
        ("What do I have tomorrow?", "tomorrow"),
        ("Anything this afternoon?", "afternoon"),
        ("What's my next appointment?", "next"),
        ("Show me my schedule", "today"),
    ],
)
def test_calendar_positive_routes(text, expected):
    assert get_calendar_intent(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "I'm tired today.",
        "Maybe I'll clean tomorrow.",
        "I'm crafting this afternoon.",
        "What's next?",
        "That event was really fun.",
        "I bought a new calendar.",
        "Tell me something interesting.",
    ],
)
def test_calendar_does_not_hijack_normal_conversation(text):
    assert get_calendar_intent(text) is None


# ---------------------------------------------------------------------------
# Weather
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "text,expected",
    [
        (
            "What's the weather?",
            {
                "intent": "current",
                "location": None,
            },
        ),
        (
            "What's the weather in Rotterdam tomorrow?",
            {
                "intent": "tomorrow",
                "location": "rotterdam",
            },
        ),
        (
            "Will it rain tomorrow?",
            {
                "intent": "rain_tomorrow",
                "location": None,
            },
        ),
        (
            "Do I need an umbrella today?",
            {
                "intent": "rain_today",
                "location": None,
            },
        ),
    ],
)
def test_weather_routes(text, expected):
    assert get_weather_intent(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "I went outside today.",
        "Rotterdam is nice.",
        "Tell me something interesting.",
        "I like rainy music.",
    ],
)
def test_weather_does_not_hijack_normal_conversation(text):
    assert get_weather_intent(text) is None


# ---------------------------------------------------------------------------
# Vision
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "text",
    [
        "What do you see?",
        "What can you see?",
        "Look at this.",
        "Use your camera.",
        "Take a picture.",
    ],
)
def test_vision_positive_routes(text):
    assert is_vision_request(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "I see what you mean.",
        "I bought a camera.",
        "Look, that's funny.",
        "Tell me about cameras.",
    ],
)
def test_vision_does_not_hijack_normal_conversation(text):
    assert is_vision_request(text) is False


# ---------------------------------------------------------------------------
# Spotify transport controls
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "text,expected",
    [
        ("Pause the music", "spotify_pause"),
        ("Paws the music", "spotify_pause"),
        ("Resume Spotify", "spotify_resume"),
        ("Play the music again", "spotify_resume"),
        ("Skip this song", "spotify_next"),
        ("Next track", "spotify_next"),
        ("Previous song", "spotify_previous"),
        ("Go back a track", "spotify_previous"),
    ],
)
def test_spotify_transport_routes(text, expected):
    assert get_spotify_control_action(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "Play Minecraft",
        "I need to pause for a moment",
        "What should I do next?",
        "Go back to what you said earlier",
        "Tell me about Spotify",
    ],
)
def test_spotify_transport_does_not_hijack_normal_conversation(text):
    assert get_spotify_control_action(text) is None


# ---------------------------------------------------------------------------
# Spotify search/catalog routing
# ---------------------------------------------------------------------------

def test_spotify_artist_request():
    assert get_spotify_catalog_request(
        "Play the artist Chappell Roan"
    ) == {
        "type": "artist",
        "query": "Chappell Roan",
    }


def test_spotify_album_request():
    assert get_spotify_catalog_request(
        "Play the album Melodrama"
    ) == {
        "type": "album",
        "query": "Melodrama",
    }


def test_spotify_track_request():
    assert (
        get_spotify_track_query(
            "Play Pink Pony Club"
        )
        == "Pink Pony Club"
    )


def test_spotify_resume_is_not_track_search():
    assert (
        get_spotify_track_query(
            "Play the music again"
        )
        is None
    )


# ---------------------------------------------------------------------------
# Homelab
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "text",
    [
        "How is my homelab doing?",
        "Is Jellyfin running?",
        "Are my servers online?",
        "Check my homelab.",
    ],
)
def test_homelab_positive_routes(text):
    assert is_homelab_request(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "Tell me something interesting.",
        "How are you doing?",
        "What's a good movie tonight?",
        "I was reading about servers today.",
    ],
)
def test_homelab_does_not_hijack_normal_conversation(text):
    assert is_homelab_request(text) is False
