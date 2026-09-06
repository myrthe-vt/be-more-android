from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import requests


logger = logging.getLogger(__name__)


DEFAULT_LOCATION_NAME = "Amsterdam"
DEFAULT_LATITUDE = 52.3676
DEFAULT_LONGITUDE = 4.9041
DEFAULT_TIMEZONE = "Europe/Amsterdam"

OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_GEOCODING_URL = (
    "https://geocoding-api.open-meteo.com/v1/search"
)


@dataclass
class WeatherLocation:
    name: str
    latitude: float
    longitude: float
    timezone: str
    country: str | None = None
    admin1: str | None = None


@dataclass
class WeatherDay:
    date: str
    weather_code: int
    temperature_max_c: float
    temperature_min_c: float
    precipitation_probability_max: int
    precipitation_mm: float


@dataclass
class WeatherResult:
    location: str
    current_temperature_c: float
    current_apparent_temperature_c: float
    current_weather_code: int
    current_is_day: bool
    today: WeatherDay
    tomorrow: WeatherDay


class WeatherError(RuntimeError):
    pass


class WeatherLocationNotFound(WeatherError):
    pass


def weather_code_description(code: int) -> str:
    descriptions = {
        0: "clear",
        1: "mostly clear",
        2: "partly cloudy",
        3: "overcast",
        45: "foggy",
        48: "foggy",
        51: "light drizzle",
        53: "drizzly",
        55: "heavy drizzle",
        56: "light freezing drizzle",
        57: "freezing drizzle",
        61: "light rain",
        63: "rainy",
        65: "heavy rain",
        66: "light freezing rain",
        67: "freezing rain",
        71: "light snow",
        73: "snowy",
        75: "heavy snow",
        77: "snow grains",
        80: "light rain showers",
        81: "rain showers",
        82: "heavy rain showers",
        85: "light snow showers",
        86: "heavy snow showers",
        95: "thunderstorms",
        96: "thunderstorms with hail",
        99: "severe thunderstorms with hail",
    }

    return descriptions.get(
        code,
        "mixed weather",
    )


def _number(
    value: Any,
    *,
    field_name: str,
) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(
            value,
            (int, float),
        )
    ):
        raise WeatherError(
            f"Weather provider returned invalid {field_name}."
        )

    return float(value)


def _integer(
    value: Any,
    *,
    field_name: str,
) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(
            value,
            (int, float),
        )
    ):
        raise WeatherError(
            f"Weather provider returned invalid {field_name}."
        )

    return int(value)


def _daily_value(
    daily: dict[str, Any],
    field: str,
    index: int,
) -> Any:
    values = daily.get(
        field
    )

    if (
        not isinstance(values, list)
        or len(values) <= index
    ):
        raise WeatherError(
            f"Weather provider did not return "
            f"{field} for day {index}."
        )

    return values[index]


def _parse_day(
    daily: dict[str, Any],
    index: int,
) -> WeatherDay:
    date = _daily_value(
        daily,
        "time",
        index,
    )

    if not isinstance(
        date,
        str,
    ):
        raise WeatherError(
            "Weather provider returned "
            "an invalid forecast date."
        )

    return WeatherDay(
        date=date,
        weather_code=_integer(
            _daily_value(
                daily,
                "weather_code",
                index,
            ),
            field_name="weather code",
        ),
        temperature_max_c=_number(
            _daily_value(
                daily,
                "temperature_2m_max",
                index,
            ),
            field_name="maximum temperature",
        ),
        temperature_min_c=_number(
            _daily_value(
                daily,
                "temperature_2m_min",
                index,
            ),
            field_name="minimum temperature",
        ),
        precipitation_probability_max=_integer(
            _daily_value(
                daily,
                "precipitation_probability_max",
                index,
            ),
            field_name="precipitation probability",
        ),
        precipitation_mm=_number(
            _daily_value(
                daily,
                "precipitation_sum",
                index,
            ),
            field_name="precipitation",
        ),
    )


def resolve_location(
    query: str,
    *,
    timeout: float = 10.0,
) -> WeatherLocation:
    query = str(
        query or ""
    ).strip()

    if not query:
        raise WeatherLocationNotFound(
            "No location was provided."
        )

    params = {
        "name": query,
        "count": 1,
        "language": "en",
        "format": "json",
    }

    try:
        response = requests.get(
            OPEN_METEO_GEOCODING_URL,
            params=params,
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json()

    except requests.RequestException as exc:
        logger.warning(
            "Weather geocoding request failed: %s",
            exc,
        )

        raise WeatherError(
            "Weather location service is unavailable."
        ) from exc

    except ValueError as exc:
        logger.warning(
            "Weather geocoding returned invalid JSON: %s",
            exc,
        )

        raise WeatherError(
            "Weather location service returned invalid data."
        ) from exc

    if not isinstance(
        payload,
        dict,
    ):
        raise WeatherError(
            "Weather location service returned "
            "an unexpected response."
        )

    results = payload.get(
        "results"
    )

    if (
        not isinstance(results, list)
        or not results
    ):
        raise WeatherLocationNotFound(
            f"Could not find location: {query}"
        )

    result = results[0]

    if not isinstance(
        result,
        dict,
    ):
        raise WeatherError(
            "Weather location service returned "
            "an invalid location."
        )

    name = result.get(
        "name"
    )
    latitude = result.get(
        "latitude"
    )
    longitude = result.get(
        "longitude"
    )
    timezone = result.get(
        "timezone"
    )

    if not isinstance(
        name,
        str,
    ):
        raise WeatherError(
            "Weather location service returned "
            "an invalid place name."
        )

    if not isinstance(
        timezone,
        str,
    ):
        raise WeatherError(
            "Weather location service returned "
            "an invalid timezone."
        )

    return WeatherLocation(
        name=name,
        latitude=_number(
            latitude,
            field_name="location latitude",
        ),
        longitude=_number(
            longitude,
            field_name="location longitude",
        ),
        timezone=timezone,
        country=(
            result.get("country")
            if isinstance(
                result.get("country"),
                str,
            )
            else None
        ),
        admin1=(
            result.get("admin1")
            if isinstance(
                result.get("admin1"),
                str,
            )
            else None
        ),
    )


def get_weather(
    *,
    location_name: str = DEFAULT_LOCATION_NAME,
    latitude: float = DEFAULT_LATITUDE,
    longitude: float = DEFAULT_LONGITUDE,
    timezone: str = DEFAULT_TIMEZONE,
    timeout: float = 10.0,
) -> WeatherResult:
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "current": ",".join(
            (
                "temperature_2m",
                "apparent_temperature",
                "weather_code",
                "is_day",
            )
        ),
        "daily": ",".join(
            (
                "weather_code",
                "temperature_2m_max",
                "temperature_2m_min",
                "precipitation_probability_max",
                "precipitation_sum",
            )
        ),
        "timezone": timezone,
        "forecast_days": 2,
    }

    try:
        response = requests.get(
            OPEN_METEO_FORECAST_URL,
            params=params,
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json()

    except requests.RequestException as exc:
        logger.warning(
            "Weather request failed: %s",
            exc,
        )

        raise WeatherError(
            "Weather provider is unavailable."
        ) from exc

    except ValueError as exc:
        logger.warning(
            "Weather provider returned invalid JSON: %s",
            exc,
        )

        raise WeatherError(
            "Weather provider returned invalid data."
        ) from exc

    if not isinstance(
        payload,
        dict,
    ):
        raise WeatherError(
            "Weather provider returned "
            "an unexpected response."
        )

    current = payload.get(
        "current"
    )
    daily = payload.get(
        "daily"
    )

    if not isinstance(
        current,
        dict,
    ):
        raise WeatherError(
            "Weather provider did not return "
            "current conditions."
        )

    if not isinstance(
        daily,
        dict,
    ):
        raise WeatherError(
            "Weather provider did not return "
            "a daily forecast."
        )

    return WeatherResult(
        location=location_name,
        current_temperature_c=_number(
            current.get(
                "temperature_2m"
            ),
            field_name="current temperature",
        ),
        current_apparent_temperature_c=_number(
            current.get(
                "apparent_temperature"
            ),
            field_name="apparent temperature",
        ),
        current_weather_code=_integer(
            current.get(
                "weather_code"
            ),
            field_name="current weather code",
        ),
        current_is_day=bool(
            _integer(
                current.get(
                    "is_day"
                ),
                field_name="daylight state",
            )
        ),
        today=_parse_day(
            daily,
            0,
        ),
        tomorrow=_parse_day(
            daily,
            1,
        ),
    )


def get_weather_for_location(
    query: str,
    *,
    timeout: float = 10.0,
) -> WeatherResult:
    location = resolve_location(
        query,
        timeout=timeout,
    )

    logger.info(
        "Weather location resolved: %r -> "
        "%s, %s (%s, %.4f, %.4f)",
        query,
        location.name,
        location.country or "unknown country",
        location.timezone,
        location.latitude,
        location.longitude,
    )

    return get_weather(
        location_name=location.name,
        latitude=location.latitude,
        longitude=location.longitude,
        timezone=location.timezone,
        timeout=timeout,
    )


def format_current_weather(
    weather: WeatherResult,
) -> str:
    description = weather_code_description(
        weather.current_weather_code
    )

    temperature = round(
        weather.current_temperature_c
    )

    apparent = round(
        weather.current_apparent_temperature_c
    )

    if abs(
        temperature - apparent
    ) >= 3:
        return (
            f"It's {temperature} degrees and {description} "
            f"in {weather.location}. "
            f"It feels like {apparent} degrees."
        )

    return (
        f"It's {temperature} degrees and {description} "
        f"in {weather.location}."
    )


def format_today_forecast(
    weather: WeatherResult,
) -> str:
    day = weather.today

    description = weather_code_description(
        day.weather_code
    )

    return (
        f"Today in {weather.location}, "
        f"it'll be {description}, "
        f"with a high of "
        f"{round(day.temperature_max_c)} degrees "
        f"and a low of "
        f"{round(day.temperature_min_c)}. "
        f"The chance of rain is "
        f"{day.precipitation_probability_max} percent."
    )


def format_tomorrow_forecast(
    weather: WeatherResult,
) -> str:
    day = weather.tomorrow

    description = weather_code_description(
        day.weather_code
    )

    return (
        f"Tomorrow in {weather.location}, "
        f"it'll be {description}, "
        f"with a high of "
        f"{round(day.temperature_max_c)} degrees "
        f"and a low of "
        f"{round(day.temperature_min_c)}. "
        f"The chance of rain is "
        f"{day.precipitation_probability_max} percent."
    )


def format_rain_answer(
    weather: WeatherResult,
    *,
    tomorrow: bool = False,
) -> str:
    day = (
        weather.tomorrow
        if tomorrow
        else weather.today
    )

    label = (
        "Tomorrow"
        if tomorrow
        else "Today"
    )

    probability = (
        day.precipitation_probability_max
    )

    amount = (
        day.precipitation_mm
    )

    if (
        probability >= 60
        or amount >= 1.0
    ):
        return (
            f"Yes. {label} in {weather.location} "
            f"has about a {probability} percent "
            f"chance of rain, "
            f"so I'd bring an umbrella."
        )

    if (
        probability >= 30
        or amount > 0
    ):
        return (
            f"Maybe. {label} in {weather.location} "
            f"has about a {probability} percent "
            f"chance of rain. "
            f"An umbrella wouldn't hurt."
        )

    return (
        f"Probably not. {label} in {weather.location} "
        f"only has about a {probability} percent "
        f"chance of rain."
    )


if __name__ == "__main__":
    try:
        weather = get_weather()

        print("CURRENT:")
        print(
            format_current_weather(
                weather
            )
        )
        print()

        print("TODAY:")
        print(
            format_today_forecast(
                weather
            )
        )
        print()

        print("TOMORROW:")
        print(
            format_tomorrow_forecast(
                weather
            )
        )
        print()

        print("UMBRELLA:")
        print(
            format_rain_answer(
                weather
            )
        )
        print()

        print("OTHER LOCATION:")
        paris = get_weather_for_location(
            "Paris, France"
        )
        print(
            format_current_weather(
                paris
            )
        )

    except WeatherError as exc:
        print(
            f"WEATHER ERROR: {exc}"
        )
