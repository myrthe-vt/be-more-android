from __future__ import annotations

import argparse
import datetime
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError


logger = logging.getLogger(__name__)


SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly"
]

CREDENTIALS_FILE = Path(
    "credentials.google-calendar.json"
)

TOKEN_FILE = Path(
    "token.google-calendar.json"
)

CALENDAR_SELECTION_FILE = Path(
    "calendar_selection.json"
)

LOCAL_TIMEZONE = ZoneInfo(
    "Europe/Amsterdam"
)


@dataclass
class CalendarEvent:
    summary: str
    start: datetime.datetime | datetime.date
    end: datetime.datetime | datetime.date | None
    all_day: bool
    location: str | None = None
    calendar_id: str | None = None


class CalendarError(RuntimeError):
    pass


class CalendarNotAuthorized(CalendarError):
    pass


def _load_credentials(
    *,
    interactive: bool = False,
) -> Credentials:
    creds = None

    if TOKEN_FILE.exists():
        try:
            creds = Credentials.from_authorized_user_file(
                str(TOKEN_FILE),
                SCOPES,
            )

        except Exception as exc:
            logger.warning(
                "Could not read Google Calendar token: %s",
                exc,
            )

    if (
        creds
        and creds.expired
        and creds.refresh_token
    ):
        try:
            creds.refresh(
                Request()
            )

            TOKEN_FILE.write_text(
                creds.to_json(),
                encoding="utf-8",
            )

        except Exception as exc:
            logger.warning(
                "Could not refresh Google Calendar token: %s",
                exc,
            )

            creds = None

    if creds and creds.valid:
        return creds

    if not interactive:
        raise CalendarNotAuthorized(
            "Google Calendar is not authorized."
        )

    if not CREDENTIALS_FILE.exists():
        raise CalendarNotAuthorized(
            "Google Calendar credentials file is missing."
        )

    try:
        flow = InstalledAppFlow.from_client_secrets_file(
            str(CREDENTIALS_FILE),
            SCOPES,
        )

        creds = flow.run_local_server(
            port=0
        )

    except Exception as exc:
        raise CalendarNotAuthorized(
            "Google Calendar authorization failed."
        ) from exc

    TOKEN_FILE.write_text(
        creds.to_json(),
        encoding="utf-8",
    )

    return creds


def authorize_calendar() -> None:
    _load_credentials(
        interactive=True
    )

    print(
        "Google Calendar authorization complete."
    )


def _calendar_service():
    creds = _load_credentials(
        interactive=False
    )

    try:
        return build(
            "calendar",
            "v3",
            credentials=creds,
            cache_discovery=False,
        )

    except Exception as exc:
        raise CalendarError(
            "Could not create Google Calendar service."
        ) from exc


def list_available_calendars() -> list[dict[str, str]]:
    service = _calendar_service()

    calendars = []
    page_token = None

    try:
        while True:
            response = (
                service.calendarList()
                .list(
                    pageToken=page_token
                )
                .execute()
            )

            for item in response.get(
                "items",
                [],
            ):
                if not isinstance(
                    item,
                    dict,
                ):
                    continue

                calendar_id = item.get(
                    "id"
                )

                if not isinstance(
                    calendar_id,
                    str,
                ):
                    continue

                summary = str(
                    item.get("summary")
                    or calendar_id
                )

                calendars.append(
                    {
                        "id": calendar_id,
                        "summary": summary,
                        "primary": str(
                            bool(
                                item.get(
                                    "primary"
                                )
                            )
                        ),
                    }
                )

            page_token = response.get(
                "nextPageToken"
            )

            if not page_token:
                break

    except HttpError as exc:
        raise CalendarError(
            "Could not list Google calendars."
        ) from exc

    return calendars


def _selected_calendar_ids() -> list[str]:
    if not CALENDAR_SELECTION_FILE.exists():
        return [
            "primary"
        ]

    try:
        data = json.loads(
            CALENDAR_SELECTION_FILE.read_text(
                encoding="utf-8"
            )
        )

    except Exception as exc:
        raise CalendarError(
            "Could not read calendar_selection.json."
        ) from exc

    calendar_ids = data.get(
        "calendar_ids"
    )

    if not isinstance(
        calendar_ids,
        list,
    ):
        raise CalendarError(
            "calendar_selection.json must contain "
            'a "calendar_ids" list.'
        )

    cleaned = []

    for calendar_id in calendar_ids:
        if (
            isinstance(
                calendar_id,
                str,
            )
            and calendar_id.strip()
        ):
            cleaned.append(
                calendar_id.strip()
            )

    if not cleaned:
        return [
            "primary"
        ]

    return cleaned


def _parse_datetime(
    value: str,
) -> datetime.datetime:
    value = value.replace(
        "Z",
        "+00:00",
    )

    result = datetime.datetime.fromisoformat(
        value
    )

    if result.tzinfo is None:
        result = result.replace(
            tzinfo=LOCAL_TIMEZONE
        )

    return result.astimezone(
        LOCAL_TIMEZONE
    )


def _parse_event(
    raw: dict[str, Any],
    *,
    calendar_id: str,
) -> CalendarEvent:
    summary = str(
        raw.get("summary")
        or "Untitled event"
    ).strip()

    location = raw.get(
        "location"
    )

    if not isinstance(
        location,
        str,
    ):
        location = None

    start_data = raw.get(
        "start",
        {},
    )

    end_data = raw.get(
        "end",
        {},
    )

    if not isinstance(
        start_data,
        dict,
    ):
        raise CalendarError(
            "Calendar returned an invalid event start."
        )

    if not isinstance(
        end_data,
        dict,
    ):
        end_data = {}

    if start_data.get(
        "dateTime"
    ):
        start = _parse_datetime(
            start_data["dateTime"]
        )

        end = None

        if end_data.get(
            "dateTime"
        ):
            end = _parse_datetime(
                end_data["dateTime"]
            )

        return CalendarEvent(
            summary=summary,
            start=start,
            end=end,
            all_day=False,
            location=location,
            calendar_id=calendar_id,
        )

    if start_data.get(
        "date"
    ):
        try:
            start_date = (
                datetime.date.fromisoformat(
                    start_data["date"]
                )
            )

        except ValueError as exc:
            raise CalendarError(
                "Calendar returned an invalid event date."
            ) from exc

        end_date = None

        if end_data.get(
            "date"
        ):
            try:
                end_date = (
                    datetime.date.fromisoformat(
                        end_data["date"]
                    )
                )

            except ValueError:
                end_date = None

        return CalendarEvent(
            summary=summary,
            start=start_date,
            end=end_date,
            all_day=True,
            location=location,
            calendar_id=calendar_id,
        )

    raise CalendarError(
        "Calendar event has no valid start time."
    )


def _rfc3339(
    value: datetime.datetime,
) -> str:
    return value.isoformat()


def _event_sort_key(
    event: CalendarEvent,
) -> datetime.datetime:
    if isinstance(
        event.start,
        datetime.datetime,
    ):
        return event.start.astimezone(
            LOCAL_TIMEZONE
        )

    return datetime.datetime.combine(
        event.start,
        datetime.time.min,
        tzinfo=LOCAL_TIMEZONE,
    )


def _deduplicate_events(
    events: list[CalendarEvent],
) -> list[CalendarEvent]:
    result = []
    seen = set()

    for event in events:
        key = (
            event.summary.casefold(),
            _event_sort_key(
                event
            ).isoformat(),
            str(
                event.end
            ),
            event.location or "",
        )

        if key in seen:
            continue

        seen.add(
            key
        )

        result.append(
            event
        )

    return result


def _list_events(
    *,
    time_min: datetime.datetime,
    time_max: datetime.datetime | None = None,
    max_results: int = 20,
) -> list[CalendarEvent]:
    service = _calendar_service()

    events: list[CalendarEvent] = []

    for calendar_id in _selected_calendar_ids():
        kwargs: dict[str, Any] = {
            "calendarId": calendar_id,
            "timeMin": _rfc3339(
                time_min
            ),
            "singleEvents": True,
            "orderBy": "startTime",
            "maxResults": max_results,
        }

        if time_max is not None:
            kwargs["timeMax"] = _rfc3339(
                time_max
            )

        try:
            result = (
                service.events()
                .list(
                    **kwargs
                )
                .execute()
            )

        except HttpError as exc:
            logger.warning(
                "Google Calendar API request failed "
                "for %r: %s",
                calendar_id,
                exc,
            )

            raise CalendarError(
                "Google Calendar is unavailable."
            ) from exc

        except Exception as exc:
            logger.exception(
                "Unexpected Google Calendar failure "
                "for %r",
                calendar_id,
            )

            raise CalendarError(
                "Google Calendar is unavailable."
            ) from exc

        raw_events = result.get(
            "items",
            [],
        )

        if not isinstance(
            raw_events,
            list,
        ):
            continue

        for raw in raw_events:
            if not isinstance(
                raw,
                dict,
            ):
                continue

            if raw.get(
                "status"
            ) == "cancelled":
                continue

            try:
                events.append(
                    _parse_event(
                        raw,
                        calendar_id=calendar_id,
                    )
                )

            except CalendarError:
                logger.exception(
                    "Could not parse calendar event"
                )

    events = _deduplicate_events(
        events
    )

    events.sort(
        key=_event_sort_key
    )

    return events[
        :max_results
    ]


def _day_bounds(
    day: datetime.date,
) -> tuple[
    datetime.datetime,
    datetime.datetime,
]:
    start = datetime.datetime.combine(
        day,
        datetime.time.min,
        tzinfo=LOCAL_TIMEZONE,
    )

    end = start + datetime.timedelta(
        days=1
    )

    return start, end


def get_today_events() -> list[CalendarEvent]:
    today = datetime.datetime.now(
        LOCAL_TIMEZONE
    ).date()

    start, end = _day_bounds(
        today
    )

    return _list_events(
        time_min=start,
        time_max=end,
    )


def get_tomorrow_events() -> list[CalendarEvent]:
    tomorrow = (
        datetime.datetime.now(
            LOCAL_TIMEZONE
        ).date()
        + datetime.timedelta(
            days=1
        )
    )

    start, end = _day_bounds(
        tomorrow
    )

    return _list_events(
        time_min=start,
        time_max=end,
    )


def get_afternoon_events() -> list[CalendarEvent]:
    now = datetime.datetime.now(
        LOCAL_TIMEZONE
    )

    start = now.replace(
        hour=12,
        minute=0,
        second=0,
        microsecond=0,
    )

    end = now.replace(
        hour=18,
        minute=0,
        second=0,
        microsecond=0,
    )

    return _list_events(
        time_min=start,
        time_max=end,
    )


def get_next_event() -> CalendarEvent | None:
    now = datetime.datetime.now(
        LOCAL_TIMEZONE
    )

    events = _list_events(
        time_min=now,
        max_results=1,
    )

    if not events:
        return None

    return events[0]


def _format_time(
    value: datetime.datetime,
) -> str:
    return value.strftime(
        "%H:%M"
    )


def _format_event_short(
    event: CalendarEvent,
) -> str:
    if event.all_day:
        return (
            f"{event.summary}, all day"
        )

    if isinstance(
        event.start,
        datetime.datetime,
    ):
        return (
            f"{event.summary} at "
            f"{_format_time(event.start)}"
        )

    return event.summary


def _format_event_list(
    events: list[CalendarEvent],
    *,
    label: str,
) -> str:
    if not events:
        return (
            f"You don't have anything "
            f"on your calendar {label}."
        )

    shown = events[:4]

    descriptions = [
        _format_event_short(
            event
        )
        for event in shown
    ]

    if len(descriptions) == 1:
        body = descriptions[0]

    elif len(descriptions) == 2:
        body = (
            f"{descriptions[0]} and "
            f"{descriptions[1]}"
        )

    else:
        body = (
            ", ".join(
                descriptions[:-1]
            )
            + f", and {descriptions[-1]}"
        )

    extra_count = (
        len(events)
        - len(shown)
    )

    if extra_count > 0:
        return (
            f"{label.capitalize()}, you have "
            f"{body}, plus {extra_count} more."
        )

    return (
        f"{label.capitalize()}, "
        f"you have {body}."
    )


def format_today() -> str:
    return _format_event_list(
        get_today_events(),
        label="today",
    )


def format_tomorrow() -> str:
    return _format_event_list(
        get_tomorrow_events(),
        label="tomorrow",
    )


def format_afternoon() -> str:
    return _format_event_list(
        get_afternoon_events(),
        label="this afternoon",
    )


def format_next_event() -> str:
    event = get_next_event()

    if event is None:
        return (
            "You don't have any upcoming events."
        )

    if event.all_day:
        if isinstance(
            event.start,
            datetime.date,
        ):
            today = datetime.datetime.now(
                LOCAL_TIMEZONE
            ).date()

            if event.start == today:
                when = "today, all day"

            elif event.start == (
                today
                + datetime.timedelta(
                    days=1
                )
            ):
                when = "tomorrow, all day"

            else:
                when = (
                    event.start.strftime(
                        "%A %d %B"
                    )
                    + ", all day"
                )

        else:
            when = "all day"

    elif isinstance(
        event.start,
        datetime.datetime,
    ):
        now = datetime.datetime.now(
            LOCAL_TIMEZONE
        )

        event_date = (
            event.start.date()
        )

        if event_date == now.date():
            when = (
                f"today at "
                f"{_format_time(event.start)}"
            )

        elif event_date == (
            now.date()
            + datetime.timedelta(
                days=1
            )
        ):
            when = (
                f"tomorrow at "
                f"{_format_time(event.start)}"
            )

        else:
            when = (
                event.start.strftime(
                    "%A %d %B"
                )
                + " at "
                + _format_time(
                    event.start
                )
            )

    else:
        when = "soon"

    return (
        f"Your next event is "
        f"{event.summary}, {when}."
    )


def print_available_calendars() -> None:
    calendars = list_available_calendars()

    if not calendars:
        print(
            "No calendars found."
        )
        return

    print(
        "AVAILABLE GOOGLE CALENDARS:"
    )
    print()

    for index, calendar in enumerate(
        calendars,
        start=1,
    ):
        primary = (
            " [PRIMARY]"
            if calendar["primary"] == "True"
            else ""
        )

        print(
            f"{index}. "
            f"{calendar['summary']}"
            f"{primary}"
        )

        print(
            f"   ID: {calendar['id']}"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--authorize",
        action="store_true",
    )

    parser.add_argument(
        "--list-calendars",
        action="store_true",
    )

    args = parser.parse_args()

    try:
        if args.authorize:
            authorize_calendar()

        elif args.list_calendars:
            print_available_calendars()

        else:
            print("SELECTED CALENDARS:")
            for calendar_id in _selected_calendar_ids():
                print(
                    f"- {calendar_id}"
                )

            print()
            print("TODAY:")
            print(
                format_today()
            )

            print()
            print("TOMORROW:")
            print(
                format_tomorrow()
            )

            print()
            print("NEXT:")
            print(
                format_next_event()
            )

            print()
            print("AFTERNOON:")
            print(
                format_afternoon()
            )

    except CalendarNotAuthorized:
        print(
            "CALENDAR NOT AUTHORIZED"
        )
        print(
            "Run:"
        )
        print(
            "python -m core.calendar --authorize"
        )

    except CalendarError as exc:
        print(
            f"CALENDAR ERROR: {exc}"
        )
