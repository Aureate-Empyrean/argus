"""The few Nexus module APIs Argus uses, with its own bearer token (never a browser credential).

Argus asks Nexus which references point at a photo, so it can warn before a photo that another
module uses is deleted. It sees only relationships their creators explicitly shared with
`argus` (Entity References: owning a target never grants backlink visibility), and labels them
through the owners' resolvers, which decide what to disclose.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 4
MAX_LABELS = 12


class NexusUnavailable(Exception):
    pass


def _call(method, path, body=None):
    base = os.getenv("NEXUS_URL", "").rstrip("/")
    token = os.getenv("NEXUS_TOKEN", "")
    if not base or not token:
        raise NexusUnavailable("Not running under Nexus")
    req = urllib.request.Request(
        base + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )  # fmt: skip
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read(1024 * 1024))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise NexusUnavailable(str(exc)) from exc


def usage(photo_ref):
    """Who uses this photo, as far as Argus may know: {known, items:[...]}."""
    try:
        items, cursor = [], None
        for _ in range(5):
            q = {"resource": photo_ref, "direction": "incoming", "limit": 100}
            if cursor:
                q["after"] = cursor
            page = _call("GET", "/api/v1/module/references?" + urllib.parse.urlencode(q))
            items += page.get("references", [])
            cursor = page.get("next_cursor")
            if not page.get("has_more"):
                break
    except NexusUnavailable:
        return {"known": False, "items": []}
    out = []
    for edge in items:
        source = edge.get("source", "")
        parts = source.split(":")
        entry = {"module": edge.get("creator") or (parts[2] if len(parts) == 5 else ""),
                 "relation": edge.get("relation", ""), "resource": source, "label": None,
                 "availability": None}  # fmt: skip
        if len(out) < MAX_LABELS:
            try:
                res = _call("POST", "/api/v1/module/resources/resolve", {"resource": source})
                entry["availability"] = res.get("availability")
                if res.get("availability") == "available":
                    entry["label"] = res.get("label")
            except NexusUnavailable:
                pass
        out.append(entry)
    return {"known": True, "items": out}


def create_reference(source, target, relation, readers):
    out = _call("POST", "/api/v1/module/references", {"source": source, "target": target, "relation": relation, "readers": readers})
    return out["reference"]["id"]


def delete_reference(reference_id):
    try:
        _call("DELETE", f"/api/v1/module/references/{reference_id}")
    except NexusUnavailable as exc:
        if "404" not in str(exc):
            raise


def people(q):
    """Meridian's people-directory projection: names only, for choosing who a face is."""
    try:
        page = _call("POST", "/api/v1/module/projections/query", {
            "module": "meridian", "projection": "people-directory", "query": {"q": q[:100], "limit": 10}, "cursor": None})  # fmt: skip
    except NexusUnavailable:
        return {"availability": "nexus_unreachable", "items": []}
    if page.get("availability") != "available":
        return {"availability": page.get("availability") or "unavailable", "items": []}
    return {"availability": "available", "items": [
        {"resource": x["resource"], "label": str(x.get("label") or "")[:200]}
        for x in page.get("items") or [] if str(x.get("resource", "")).startswith("nexus:v1:meridian:person:")]}  # fmt: skip
