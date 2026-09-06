import os
import time
import logging

import requests


logger = logging.getLogger(__name__)


SPOTIFY_TOKEN_URL = (
    "https://accounts.spotify.com/api/token"
)

SPOTIFY_SEARCH_URL = (
    "https://api.spotify.com/v1/search"
)


_token_cache = {
    "access_token": None,
    "expires_at": 0.0,
}


def _credentials():
    client_id = str(
        os.environ.get(
            "SPOTIFY_CLIENT_ID",
            "",
        )
    ).strip()

    client_secret = str(
        os.environ.get(
            "SPOTIFY_CLIENT_SECRET",
            "",
        )
    ).strip()

    if not client_id:
        raise RuntimeError(
            "SPOTIFY_CLIENT_ID is not configured"
        )

    if not client_secret:
        raise RuntimeError(
            "SPOTIFY_CLIENT_SECRET is not configured"
        )

    return (
        client_id,
        client_secret,
    )


def get_access_token():
    """
    Get and cache a Spotify Client Credentials token.

    The token is application-level only. It does not represent
    the Spotify user logged into the Android device.
    """
    now = time.time()

    cached_token = (
        _token_cache[
            "access_token"
        ]
    )

    if (
        cached_token
        and now
        < _token_cache[
            "expires_at"
        ]
    ):
        return cached_token

    client_id, client_secret = (
        _credentials()
    )

    response = requests.post(
        SPOTIFY_TOKEN_URL,
        data={
            "grant_type":
                "client_credentials",

            "client_id":
                client_id,

            "client_secret":
                client_secret,
        },
        timeout=10,
    )

    if not response.ok:
        raise RuntimeError(
            "Spotify token request failed "
            f"({response.status_code}): "
            f"{response.text[:300]}"
        )

    data = response.json()

    access_token = str(
        data.get(
            "access_token",
            "",
        )
    ).strip()

    if not access_token:
        raise RuntimeError(
            "Spotify returned no access token"
        )

    expires_in = int(
        data.get(
            "expires_in",
            3600,
        )
    )

    # Refresh a minute early rather than discovering expiry
    # in the middle of a voice command.
    _token_cache[
        "access_token"
    ] = access_token

    _token_cache[
        "expires_at"
    ] = (
        now
        + max(
            60,
            expires_in - 60,
        )
    )

    return access_token


def search_tracks(
    query: str,
    limit: int = 5,
):
    """
    Search Spotify's public catalog for tracks.

    Returns a small deterministic list. Nothing here is sent
    through the language model.
    """
    query = str(
        query or ""
    ).strip()

    if not query:
        return []

    limit = max(
        1,
        min(
            10,
            int(limit),
        ),
    )

    token = get_access_token()

    response = requests.get(
        SPOTIFY_SEARCH_URL,
        headers={
            "Authorization":
                f"Bearer {token}",
        },
        params={
            "q":
                query,

            "type":
                "track",

            "limit":
                limit,
        },
        timeout=10,
    )

    if not response.ok:
        raise RuntimeError(
            "Spotify search failed "
            f"({response.status_code}): "
            f"{response.text[:300]}"
        )

    data = response.json()

    tracks = (
        data
        .get(
            "tracks",
            {},
        )
        .get(
            "items",
            [],
        )
    )

    results = []

    for track in tracks:
        artists = [
            str(
                artist.get(
                    "name",
                    "",
                )
            ).strip()
            for artist
            in track.get(
                "artists",
                [],
            )
            if artist.get(
                "name"
            )
        ]

        album = (
            track.get(
                "album",
                {},
            )
            or {}
        )

        results.append(
            {
                "name":
                    track.get(
                        "name"
                    ),

                "artists":
                    artists,

                "artist":
                    artists[0]
                    if artists
                    else None,

                "album":
                    album.get(
                        "name"
                    ),

                "uri":
                    track.get(
                        "uri"
                    ),

                "id":
                    track.get(
                        "id"
                    ),
            }
        )

    return results


def find_track(
    query: str,
):
    """
    Return Spotify's first track search result.
    """
    results = search_tracks(
        query,
        limit=5,
    )

    if not results:
        return None

    return results[0]


if __name__ == "__main__":
    import json
    import sys

    query = " ".join(
        sys.argv[1:]
    ).strip()

    if not query:
        query = (
            "Welcome to the DCC "
            "Nothing But Thieves"
        )

    print(
        json.dumps(
            search_tracks(
                query
            ),
            indent=2,
            ensure_ascii=False,
        )
    )


def search_spotify(
    query: str,
    item_type: str,
    limit: int = 5,
):
    """
    Search Spotify catalog for one supported entity type.
    """
    query = str(query or "").strip()
    item_type = str(item_type or "").strip().lower()

    if item_type not in {
        "track",
        "artist",
        "album",
    }:
        raise ValueError(
            f"Unsupported Spotify type: {item_type}"
        )

    if not query:
        return []

    limit = max(
        1,
        min(
            10,
            int(limit),
        ),
    )

    token = get_access_token()

    response = requests.get(
        SPOTIFY_SEARCH_URL,
        headers={
            "Authorization":
                f"Bearer {token}",
        },
        params={
            "q": query,
            "type": item_type,
            "limit": limit,
        },
        timeout=10,
    )

    if not response.ok:
        raise RuntimeError(
            "Spotify search failed "
            f"({response.status_code}): "
            f"{response.text[:300]}"
        )

    payload = response.json()

    container_name = {
        "track": "tracks",
        "artist": "artists",
        "album": "albums",
    }[item_type]

    return (
        payload
        .get(
            container_name,
            {},
        )
        .get(
            "items",
            [],
        )
    )


def find_artist(
    query: str,
):
    items = search_spotify(
        query,
        "artist",
        limit=5,
    )

    if not items:
        return None

    artist = items[0]

    return {
        "type": "artist",
        "name": artist.get("name"),
        "uri": artist.get("uri"),
        "id": artist.get("id"),
    }


def find_album(
    query: str,
):
    items = search_spotify(
        query,
        "album",
        limit=5,
    )

    if not items:
        return None

    album = items[0]

    artists = [
        str(
            artist.get(
                "name",
                "",
            )
        ).strip()
        for artist
        in album.get(
            "artists",
            [],
        )
        if artist.get("name")
    ]

    return {
        "type": "album",
        "name": album.get("name"),
        "artist":
            artists[0]
            if artists
            else None,
        "artists": artists,
        "uri": album.get("uri"),
        "id": album.get("id"),
    }


def _normalize_spotify_name(
    value: str,
):
    """
    Normalize catalog names for deterministic exact-match comparison.
    """
    import re
    import unicodedata

    value = str(
        value or ""
    ).strip().lower()

    value = unicodedata.normalize(
        "NFKD",
        value,
    )

    value = "".join(
        character
        for character in value
        if not unicodedata.combining(
            character
        )
    )

    value = re.sub(
        r"[^a-z0-9]+",
        " ",
        value,
    )

    return " ".join(
        value.split()
    )


def _split_track_artist_query(
    query: str,
):
    """
    Split a natural request such as:

        Take Me Out by Franz Ferdinand

    into track and artist components.
    """
    import re

    query = str(
        query or ""
    ).strip()

    match = re.match(
        r"^(.+?)\s+by\s+(.+)$",
        query,
        flags=re.IGNORECASE,
    )

    if not match:
        return None

    track_name = (
        match.group(1)
        .strip()
    )

    artist_name = (
        match.group(2)
        .strip()
    )

    if (
        not track_name
        or not artist_name
    ):
        return None

    return (
        track_name,
        artist_name,
    )


def find_track_by_artist(
    track_name: str,
    artist_name: str,
):
    """
    Search using Spotify's track and artist field filters.
    """
    track_name = str(
        track_name or ""
    ).strip()

    artist_name = str(
        artist_name or ""
    ).strip()

    if (
        not track_name
        or not artist_name
    ):
        return None

    query = (
        f'track:"{track_name}" '
        f'artist:"{artist_name}"'
    )

    results = search_tracks(
        query,
        limit=5,
    )

    if not results:
        return None

    return results[0]


def resolve_spotify_play_query(
    query: str,
):
    """
    Resolve a natural 'play X' request into a Spotify URI.

    Priority:
      1. Explicit 'track by artist'
      2. Exact track-name match
      3. Exact artist-name match
      4. Exact album-name match
      5. Top track result as fallback

    Explicit 'play artist ...' and 'play album ...' commands remain
    handled separately in web_app.py and therefore take precedence.
    """
    query = str(
        query or ""
    ).strip()

    if not query:
        return None

    split_query = (
        _split_track_artist_query(
            query
        )
    )

    if split_query:
        track_name, artist_name = (
            split_query
        )

        result = find_track_by_artist(
            track_name,
            artist_name,
        )

        if result:
            return {
                **result,
                "type": "track",
            }

    normalized_query = (
        _normalize_spotify_name(
            query
        )
    )

    track_results = (
        search_tracks(
            query,
            limit=5,
        )
    )

    artist_results = (
        search_spotify(
            query,
            "artist",
            limit=5,
        )
    )

    album_results = (
        search_spotify(
            query,
            "album",
            limit=5,
        )
    )

    # ---------------------------------------------------------
    # Exact track match
    # ---------------------------------------------------------
    for track in track_results:
        if (
            _normalize_spotify_name(
                track.get(
                    "name"
                )
            )
            ==
            normalized_query
        ):
            return {
                **track,
                "type": "track",
            }

    # ---------------------------------------------------------
    # Exact artist match
    # ---------------------------------------------------------
    for artist in artist_results:
        if (
            _normalize_spotify_name(
                artist.get(
                    "name"
                )
            )
            ==
            normalized_query
        ):
            return {
                "type":
                    "artist",

                "name":
                    artist.get(
                        "name"
                    ),

                "artist":
                    artist.get(
                        "name"
                    ),

                "album":
                    None,

                "uri":
                    artist.get(
                        "uri"
                    ),

                "id":
                    artist.get(
                        "id"
                    ),
            }

    # ---------------------------------------------------------
    # Exact album match
    # ---------------------------------------------------------
    for album in album_results:
        if (
            _normalize_spotify_name(
                album.get(
                    "name"
                )
            )
            ==
            normalized_query
        ):
            artists = [
                str(
                    artist.get(
                        "name",
                        "",
                    )
                ).strip()
                for artist
                in album.get(
                    "artists",
                    [],
                )
                if artist.get(
                    "name"
                )
            ]

            return {
                "type":
                    "album",

                "name":
                    album.get(
                        "name"
                    ),

                "artist":
                    (
                        artists[0]
                        if artists
                        else None
                    ),

                "album":
                    album.get(
                        "name"
                    ),

                "uri":
                    album.get(
                        "uri"
                    ),

                "id":
                    album.get(
                        "id"
                    ),
            }

    # ---------------------------------------------------------
    # Fallback: Spotify's top track result
    # ---------------------------------------------------------
    if track_results:
        return {
            **track_results[0],
            "type": "track",
        }

    return None
