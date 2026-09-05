import logging

try:
    from ddgs import DDGS  # new package name (pip install ddgs)
except ImportError:
    from duckduckgo_search import DDGS  # fallback for older installs

logger = logging.getLogger(__name__)


NETHERLANDS_REGION_KEYWORDS = (
    "netherlands",
    "the netherlands",
    "nederland",
    "dutch",
    "amsterdam",
    "rotterdam",
    "utrecht",
    "den haag",
    "the hague",
    "eindhoven",
    "groningen",
    "maastricht",
    "leiden",
    "delft",
    "haarlem",
    "tilburg",
    "breda",
    "nijmegen",
    "arnhem",
    "dordrecht",
)

CANADA_REGION_KEYWORDS = (
    "canada",
    "canadian",
    "ontario",
    "brantford",
    "toronto",
    "ottawa",
    "hamilton",
    "mississauga",
    "waterloo",
    "kitchener",
    "vancouver",
    "montreal",
)


def choose_search_region(query: str) -> str:
    """
    Choose the most appropriate DuckDuckGo search region.

    Netherlands-related queries use nl-nl.
    Canada-related queries use ca-en.
    Everything else defaults to us-en.
    """
    query_lower = query.lower()

    if any(
        keyword in query_lower
        for keyword in NETHERLANDS_REGION_KEYWORDS
    ):
        return "nl-nl"

    if any(
        keyword in query_lower
        for keyword in CANADA_REGION_KEYWORDS
    ):
        return "ca-en"

    return "us-en"


def search_web(query: str) -> str:
    """
    Searches DuckDuckGo for the given query and returns a summary of the
    top results.

    Special case:
    Weather uses wttr.in for better accuracy.
    """
    logger.info(f"Searching web for: {query}")

    query_lower = query.lower()

    # 0. Special Case: Weather
    if "weather" in query_lower:
        location = "Brantford"

        if "in " in query_lower:
            location = (
                query_lower
                .split("in ", 1)[1]
                .split(",")[0]
                .strip()
                .replace(" ", "+")
            )

        try:
            import requests

            # Using format v2 with 0 days
            # for today's detailed table.
            url = (
                f"https://wttr.in/"
                f"{location}"
                f"?format=v2&0"
            )

            resp = requests.get(
                url,
                timeout=10,
            )

            if resp.status_code == 200:
                result = (
                    f"LIVE WEATHER DATA "
                    f"for {location}:\n"
                    f"{resp.text}"
                )

                logger.info(
                    "Weather fetched from "
                    f"wttr.in: {location}"
                )

                return result

        except Exception as e:
            logger.warning(
                f"wttr.in Weather Error: {e}"
            )

            # Fall through to DDG
            # if wttr.in fails.

    try:
        with DDGS(timeout=10) as ddgs:
            results = []

            region = choose_search_region(
                query
            )

            logger.info(
                "Selected DuckDuckGo "
                f"region={region} "
                f"for query='{query}'"
            )

            # 1. Try News search first
            # for current events.
            if any(
                keyword in query_lower
                for keyword in (
                    "news",
                    "latest",
                    "today",
                    "happening",
                    "current",
                )
            ):
                try:
                    logger.info(
                        "Searching News "
                        f"(region={region})..."
                    )

                    results = list(
                        ddgs.news(
                            query,
                            region=region,
                            max_results=5,
                        )
                    )

                    if results:
                        logger.info(
                            "Found "
                            f"{len(results)} "
                            "news items."
                        )

                except Exception as e:
                    logger.warning(
                        f"News Search Error: {e}"
                    )

            # 2. Fallback to Text search
            if not results:
                logger.info(
                    "Trying text search "
                    f"(region={region})..."
                )

                try:
                    results = list(
                        ddgs.text(
                            query,
                            region=region,
                            max_results=3,
                        )
                    )

                    if results:
                        logger.info(
                            "Found Text: "
                            f"{results[0].get('title')}"
                        )

                except Exception as e:
                    logger.warning(
                        f"Text Search Error: {e}"
                    )

            if results:
                parts = []

                for result in results[:3]:
                    title = result.get(
                        "title",
                        "No Title",
                    )

                    body = result.get(
                        "body",
                        result.get(
                            "snippet",
                            "No Body",
                        ),
                    )

                    parts.append(
                        f"Title: {title}\n"
                        f"Snippet: {body[:400]}"
                    )

                return (
                    f"SEARCH RESULTS "
                    f"for '{query}':\n"
                    + "\n---\n".join(parts)
                )

            logger.info(
                "Search returned 0 results."
            )

            return "SEARCH_EMPTY"

    except Exception as e:
        logger.error(
            "Connection/Library Error "
            f"during search: {e}"
        )

        return "SEARCH_ERROR"


def search_images(query: str) -> str:
    """
    Searches DuckDuckGo for the given query and
    returns the first image URL.
    """
    logger.info(
        f"Searching images for: {query}"
    )

    try:
        with DDGS(timeout=10) as ddgs:
            region = choose_search_region(
                query
            )

            results = list(
                ddgs.images(
                    query,
                    region=region,
                    max_results=1,
                )
            )

            if results:
                image_url = results[0].get(
                    "image"
                )

                logger.info(
                    f"Found Image: {image_url}"
                )

                return image_url

            logger.info(
                "Image search returned "
                "0 results."
            )

            return ""

    except Exception as e:
        logger.error(
            f"Image Search Error: {e}"
        )

        return ""
