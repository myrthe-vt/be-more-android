from __future__ import annotations

import os
import platform
import shutil
import socket
import subprocess
from dataclasses import dataclass
from typing import Optional

from dotenv import load_dotenv


load_dotenv()

SSH_TIMEOUT_SECONDS = 5

PRIMARY_SSH_HOST = (
    os.environ.get(
        "BMO_HOMELAB_PRIMARY_HOST",
        "",
    ).strip()
    or None
)

MEDIA_SSH_HOST = (
    os.environ.get(
        "BMO_HOMELAB_MEDIA_HOST",
        "",
    ).strip()
    or None
)


@dataclass(frozen=True)
class Node:
    key: str
    name: str
    ssh_host: Optional[str]
    local: bool = False


NODES = {
    "primary": Node(
        key="primary",
        name="primary",
        ssh_host=PRIMARY_SSH_HOST,
    ),
    "media": Node(
        key="media",
        name="Media",
        ssh_host=MEDIA_SSH_HOST,
    ),
    "local": Node(
        key="local",
        name="Local",
        ssh_host=None,
        local=True,
    ),
    "mac": Node(
        key="local",
        name="Local",
        ssh_host=None,
        local=True,
    ),
}


SERVICE_NODES = {
    # primary / Air
    "caddy": "primary",
    "homepage": "primary",
    "uptime-kuma": "primary",
    "dozzle": "primary",
    "syncthing": "primary",
    "adguard": "primary",
    "bookstack": "primary",
    "paperless": "primary",
    "paperless-webserver": "primary",
    "open-webui": "primary",
    "vaultwarden": "primary",

    # Media
    "jellyfin": "media",
    "sonarr": "media",
    "radarr": "media",
    "prowlarr": "media",
    "bazarr": "media",
    "qbittorrent": "media",
    "gluetun": "media",
    "immich": "media",
    "immich_server": "media",
    "audiobookshelf": "media",
}


DISK_PATHS = {
    "primary": {
        "system": "/",
        "external": "/media/myfiles/external",
        "storage": "/media/storage",
    },
    "media": {
        "system": "/",
        "storage": "/media/storage",
    },
    "local": {
        "system": "/",
    },
}


def _resolve_node(node_name: str) -> Node:
    key = node_name.strip().lower()

    if key not in NODES:
        raise ValueError(f"Unknown homelab node: {node_name}")

    return NODES[key]


def _run_local(command: list[str], timeout: int = SSH_TIMEOUT_SECONDS) -> str:
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )

    if result.returncode != 0:
        error = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(error or f"Command failed with code {result.returncode}")

    return result.stdout.strip()


def _run_remote(
    node: Node,
    command: str,
    timeout: int = SSH_TIMEOUT_SECONDS,
) -> str:
    if node.local:
        raise ValueError("_run_remote() cannot be used for a local node")

    if not node.ssh_host:
        raise ValueError(f"No SSH host configured for {node.name}")

    result = subprocess.run(
        [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            f"ConnectTimeout={timeout}",
            node.ssh_host,
            command,
        ],
        capture_output=True,
        text=True,
        timeout=timeout + 2,
        check=False,
    )

    if result.returncode != 0:
        error = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(error or f"SSH returned code {result.returncode}")

    return result.stdout.strip()


def node_online(node_name: str) -> dict:
    node = _resolve_node(node_name)

    if node.local:
        return {
            "ok": True,
            "node": node.key,
            "name": node.name,
            "online": True,
            "hostname": socket.gethostname(),
        }

    try:
        hostname = _run_remote(node, "hostname")

        return {
            "ok": True,
            "node": node.key,
            "name": node.name,
            "online": True,
            "hostname": hostname,
        }

    except Exception as exc:
        return {
            "ok": False,
            "node": node.key,
            "name": node.name,
            "online": False,
            "error": str(exc),
        }


def _docker_ps_remote(node: Node) -> list[dict]:
    output = _run_remote(
        node,
        "docker ps "
        "--format '{{.Names}}|{{.Status}}|{{.Image}}'",
    )

    containers = []

    for line in output.splitlines():
        if not line.strip():
            continue

        parts = line.split("|", 2)

        containers.append(
            {
                "name": parts[0].strip(),
                "status": parts[1].strip() if len(parts) > 1 else "",
                "image": parts[2].strip() if len(parts) > 2 else "",
            }
        )

    return containers


def containers(node_name: str) -> dict:
    node = _resolve_node(node_name)

    if node.local:
        return {
            "ok": False,
            "node": node.key,
            "name": node.name,
            "error": "Local does not use Docker for the BMO homelab stack.",
            "containers": [],
        }

    try:
        running = _docker_ps_remote(node)

        return {
            "ok": True,
            "node": node.key,
            "name": node.name,
            "count": len(running),
            "containers": running,
        }

    except Exception as exc:
        return {
            "ok": False,
            "node": node.key,
            "name": node.name,
            "error": str(exc),
            "containers": [],
        }


def service_status(service_name: str) -> dict:
    requested = service_name.strip().lower()

    aliases = {
        "qbit": "qbittorrent",
        "qbit torrent": "qbittorrent",
        "openwebui": "open-webui",
        "open webui": "open-webui",
        "paperless ngx": "paperless",
        "immich server": "immich_server",
    }

    service = aliases.get(requested, requested)

    node_name = SERVICE_NODES.get(service)

    if not node_name:
        return {
            "ok": False,
            "service": service,
            "error": f"Service {service_name} is not in BMO's allow-list.",
        }

    node = _resolve_node(node_name)

    try:
        running = _docker_ps_remote(node)

    except Exception as exc:
        return {
            "ok": False,
            "service": service,
            "node": node.key,
            "node_name": node.name,
            "running": False,
            "error": str(exc),
        }

    service_lower = service.lower()

    matches = [
        container
        for container in running
        if (
            container["name"].lower() == service_lower
            or service_lower in container["name"].lower()
        )
    ]

    if matches:
        match = matches[0]

        return {
            "ok": True,
            "service": service,
            "node": node.key,
            "node_name": node.name,
            "running": True,
            "container": match["name"],
            "status": match["status"],
        }

    return {
        "ok": True,
        "service": service,
        "node": node.key,
        "node_name": node.name,
        "running": False,
        "status": "not running",
    }


def _parse_df(output: str) -> dict:
    lines = [line for line in output.splitlines() if line.strip()]

    if len(lines) < 2:
        raise RuntimeError(f"Unexpected df output: {output}")

    columns = lines[-1].split()

    if len(columns) < 6:
        raise RuntimeError(f"Unexpected df output: {output}")

    return {
        "filesystem": columns[0],
        "size": columns[1],
        "used": columns[2],
        "available": columns[3],
        "percent_used": columns[4],
        "mount": columns[5],
    }


def disk_usage(node_name: str, disk_name: str = "system") -> dict:
    node = _resolve_node(node_name)
    disk_key = disk_name.strip().lower()

    available_disks = DISK_PATHS.get(node.key, {})

    if disk_key not in available_disks:
        return {
            "ok": False,
            "node": node.key,
            "name": node.name,
            "disk": disk_key,
            "error": (
                f"Unknown disk {disk_name} for {node.name}. "
                f"Available: {', '.join(available_disks)}"
            ),
        }

    path = available_disks[disk_key]

    try:
        if node.local:
            usage = shutil.disk_usage(path)

            total_gb = usage.total / (1024 ** 3)
            used_gb = usage.used / (1024 ** 3)
            free_gb = usage.free / (1024 ** 3)

            percent_used = (
                (usage.used / usage.total) * 100
                if usage.total
                else 0
            )

            data = {
                "filesystem": path,
                "size": f"{total_gb:.1f}G",
                "used": f"{used_gb:.1f}G",
                "available": f"{free_gb:.1f}G",
                "percent_used": f"{percent_used:.0f}%",
                "mount": path,
            }

        else:
            output = _run_remote(
                node,
                f"df -hP -- {path}",
            )

            data = _parse_df(output)

        return {
            "ok": True,
            "node": node.key,
            "name": node.name,
            "disk": disk_key,
            "path": path,
            **data,
        }

    except Exception as exc:
        return {
            "ok": False,
            "node": node.key,
            "name": node.name,
            "disk": disk_key,
            "path": path,
            "error": str(exc),
        }


def system_status(node_name: str) -> dict:
    node = _resolve_node(node_name)

    if node.local:
        try:
            uptime = _run_local(["uptime"])

            return {
                "ok": True,
                "node": node.key,
                "name": node.name,
                "online": True,
                "hostname": socket.gethostname(),
                "platform": platform.platform(),
                "uptime": uptime,
            }

        except Exception as exc:
            return {
                "ok": False,
                "node": node.key,
                "name": node.name,
                "error": str(exc),
            }

    try:
        output = _run_remote(
            node,
            "printf 'HOSTNAME='; hostname; "
            "printf 'UPTIME='; uptime -p; "
            "printf 'LOAD='; cat /proc/loadavg | cut -d' ' -f1-3; "
            "printf 'MEMORY='; free -h | awk '/^Mem:/ "
            "{print $3 \"/\" $2}'; "
            "printf 'TEMP='; "
            "cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || true",
        )

        data = {}

        for line in output.splitlines():
            if "=" not in line:
                continue

            key, value = line.split("=", 1)
            data[key.lower()] = value.strip()

        temp = data.get("temp", "")

        if temp.isdigit():
            data["temperature_c"] = round(int(temp) / 1000, 1)

        return {
            "ok": True,
            "node": node.key,
            "name": node.name,
            "online": True,
            **data,
        }

    except Exception as exc:
        return {
            "ok": False,
            "node": node.key,
            "name": node.name,
            "online": False,
            "error": str(exc),
        }


def homelab_overview() -> dict:
    nodes = {
        name: node_online(name)
        for name in ("primary", "media", "local")
    }

    return {
        "ok": True,
        "nodes": nodes,
    }


if __name__ == "__main__":
    import json

    print("=== Nodes ===")
    print(json.dumps(homelab_overview(), indent=2))

    print("\n=== primary containers ===")
    print(json.dumps(containers("primary"), indent=2))

    print("\n=== Media containers ===")
    print(json.dumps(containers("media"), indent=2))

    print("\n=== Jellyfin ===")
    print(json.dumps(service_status("jellyfin"), indent=2))

    print("\n=== Media storage ===")
    print(json.dumps(disk_usage("media", "storage"), indent=2))
