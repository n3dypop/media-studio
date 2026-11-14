"""Three local ComfyUI maintenance tools, backed by the official Comfy CLI."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

from mcp.server.mcpserver import MCPServer


ROOT = Path(os.environ["COMFY_MAINTENANCE_ROOT"]).resolve(strict=True)
COMFY = Path(os.environ["COMFY_PRODUCT_ROOT"]).resolve(strict=True)
CLI = Path(sys.executable).with_name("comfy.exe" if os.name == "nt" else "comfy")
WORKFLOWS = COMFY / "user/default/workflows"
LOCAL_URL = os.environ["COMFY_LOCAL_URL"]
if not re.fullmatch(r"http://127\.0\.0\.1:[0-9]{1,5}", LOCAL_URL) or not 1024 <= int(LOCAL_URL.rsplit(":", 1)[1]) <= 65535:
    raise ValueError("COMFY_LOCAL_URL must be a fixed loopback endpoint.")
MAX_GRAPH_BYTES = 1024 * 1024
ADDRESS = re.compile(r"[1-9][0-9]{0,8}\.[a-zA-Z_0-9]{1,80}")
NAME = re.compile(r"[a-zA-Z0-9 _.-]{1,100}")
SERVER = MCPServer("ComfyUI Maintenance")


def checked_graph(file, base):
    if file.is_symlink() or file.resolve() != file or not file.is_relative_to(base):
        raise ValueError("The workflow must be a regular file inside the workflow directory.")
    if not file.is_file() or file.stat().st_size > MAX_GRAPH_BYTES:
        raise ValueError("The workflow is missing or exceeds 1 MiB.")
    return file


def run_cli(*args, validation=False):
    result = subprocess.run(
        [str(CLI), "--json", *map(str, args)], cwd=COMFY,
        capture_output=True, encoding="utf-8", timeout=25,
        env={**os.environ, "COMFY_NO_TELEMETRY": "1", "COMFY_NO_WATCH": "1",
             "PYTHONUTF8": "1", "COMFY_WHERE": "local", "COMFY_LOCAL_URL": LOCAL_URL},
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        envelope = json.loads(result.stdout)
    except ValueError:
        raise ValueError("The local Comfy CLI did not return JSON.") from None
    data = envelope.get("data")
    invalid_workflow = (
        validation and isinstance(data, dict) and data.get("valid") is False
        and type(data.get("error_count")) is int and type(data.get("warning_count")) is int
        and isinstance(data.get("errors"), list) and isinstance(data.get("warnings"), list)
    )
    if not isinstance(data, dict) or (envelope.get("ok") is not True and not invalid_workflow):
        raise ValueError("Comfy CLI rejected the request. Check the arguments and the local ComfyUI service.")
    return data


def search_nodes(query: str) -> dict:
    """Find local ComfyUI node class names by keyword. Returns up to six matches."""
    query = query.strip()
    if not NAME.fullmatch(query) or query.startswith("-"):
        raise ValueError("Use a short node name or keyword.")
    data = run_cli("nodes", "search", query)
    rows = [row for row in data["rows"] if row.get("is_api_node") is False]
    return {"nodes": [{"class": row["name"], "label": row["display_name"]} for row in rows[:6]],
            "truncated": data.get("total", len(rows)) > 6}


def edit_workflow(workflow: str, operation: str, target: str, value: str = "", source: str = "") -> dict:
    """Save an edited copy. Use a workflow path relative to ComfyUI Workflows or a returned draft ID. Operations: set (target node.field, value JSON), connect (source and target node.port), disconnect (target node.port)."""
    if not ADDRESS.fullmatch(target):
        raise ValueError("Use a node ID and a field or port, such as 7.strength.")
    original = resolve_workflow(workflow)
    if operation == "set":
        if len(value.encode("utf-8")) > 4096:
            raise ValueError("The value exceeds 4 KiB.")
        parsed = json.loads(value)
        if type(parsed) not in (str, bool, int, float):
            raise ValueError("Set a JSON string, number or boolean.")
        args = ("set-slot", original, f"{target}={json.dumps(parsed, ensure_ascii=False, allow_nan=False)}")
    elif operation == "connect" and ADDRESS.fullmatch(source):
        args = ("connect", original, source, target)
    elif operation == "disconnect":
        args = ("disconnect", original, target)
    else:
        raise ValueError("Use set, connect or disconnect with the specified ports.")
    data = run_cli("workflow", *args, "--stdout")
    graph = data.get("workflow_json")
    if isinstance(graph, str):
        graph = json.loads(graph)
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
        raise ValueError("The CLI did not return an editable workflow.")
    encoded = json.dumps(graph, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
    if len(encoded) > MAX_GRAPH_BYTES:
        raise ValueError("The draft exceeds 1 MiB.")
    draft_id = "draft-" + uuid.uuid4().hex
    draft = ROOT / (draft_id + ".json")
    staging = draft.with_suffix(".partial")
    with staging.open("xb") as output:
        try:
            output.write(encoded)
        except OSError:
            output.close()
            staging.unlink()
            raise
    staging.rename(draft)
    return {"draft": draft_id, "operation": operation, "target": target,
            "warnings": [str(item)[:180] for item in (data.get("warnings") or [])[:3]]}


def resolve_workflow(name):
    if re.fullmatch(r"draft-[0-9a-f]{32}", name):
        return checked_graph(ROOT / (name + ".json"), ROOT)
    parts = name.split("/")
    if len(parts) > 5 or not all(NAME.fullmatch(part) and part not in (".", "..") for part in parts) or not name.endswith(".json"):
        raise ValueError("Provide a workflow path relative to ComfyUI Workflows or a draft ID.")
    return checked_graph(WORKFLOWS.joinpath(*parts), WORKFLOWS)


def validate_workflow(workflow: str) -> dict:
    """Statically validate a saved workflow or draft against local ComfyUI. Does not queue a job."""
    data = run_cli("workflow", "validate", "--where", "local", "--workflow", resolve_workflow(workflow), validation=True)
    errors, warnings = data.get("errors", []), data.get("warnings", [])
    issues = [{key: str(item[key])[:160] for key in ("node_id", "field", "code", "message") if key in item}
              for item in (errors + warnings)[:3] if isinstance(item, dict)]
    return {"valid": data["valid"] is True and not data.get("partner_nodes"),
            "errors": data["error_count"], "warnings": data["warning_count"], "issues": issues,
            **({"partner_nodes": True} if data.get("partner_nodes") else {})}


TOOLS = {tool.__name__: tool for tool in (search_nodes, edit_workflow, validate_workflow)}
for tool in TOOLS.values():
    SERVER.tool()(tool)

if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--cli":
        print(json.dumps(TOOLS[sys.argv[2]](**json.loads(sys.argv[3]))))
    else:
        SERVER.run(transport="stdio")
