"""Refresh the small Calgary Tower parking map from the City of Calgary."""

import json
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "calgary-tower-zones.geojson"
SOURCE = (
    "https://services1.arcgis.com/AVP60cs0Q9PEA8rH/ArcGIS/rest/services/"
    "Calgary_Parking_Authority_On_Street_Parking_Zones/FeatureServer/0/query"
)
SOURCE_PAGE = "https://data.calgary.ca/d/rhkg-vwwp"
# 1 Street SW to 1 Street SE, 8 Avenue to 10 Avenue, with the Tower inside.
WEST, SOUTH, EAST, NORTH = -114.06565, 51.04331, -114.06062, 51.04561
FIELDS = (
    "OBJECTID,BLOCK_SIDE,ADDRESS_DESC,PARKING_ZONE,ZONE_TYPE,STALL_TYPE,"
    "ZONE_CAP,STATUS,PRICE_ZONE,PARKING_RESTRICT_TIME,PARKING_RESTRICT_TYPE,"
    "MAX_TIME,ENFORCEABLE_TIME,NO_STOPPING,NO_PARKING,COMMENTS"
)


def clip_segment(a, b):
    """Clip one longitude/latitude segment to the pilot rectangle."""
    x0, y0 = a
    x1, y1 = b
    dx, dy = x1 - x0, y1 - y0
    low, high = 0.0, 1.0
    for p, q in ((-dx, x0 - WEST), (dx, EAST - x0), (-dy, y0 - SOUTH), (dy, NORTH - y0)):
        if p == 0:
            if q < 0:
                return None
            continue
        t = q / p
        if p < 0:
            low = max(low, t)
        else:
            high = min(high, t)
        if low > high:
            return None
    return [[x0 + low * dx, y0 + low * dy], [x0 + high * dx, y0 + high * dy]]


def clip_path(path):
    pieces = []
    current = []
    for a, b in zip(path, path[1:]):
        segment = clip_segment(a, b)
        if segment is None:
            if len(current) > 1:
                pieces.append(current)
            current = []
            continue
        start, end = segment
        if current and abs(current[-1][0] - start[0]) < 1e-9 and abs(current[-1][1] - start[1]) < 1e-9:
            current.append(end)
        else:
            if len(current) > 1:
                pieces.append(current)
            current = [start, end]
    if len(current) > 1:
        pieces.append(current)
    return pieces


def main():
    params = {
        "geometry": f"{WEST},{SOUTH},{EAST},{NORTH}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "outSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": FIELDS,
        "returnGeometry": "true",
        "f": "json",
    }
    request = urllib.request.Request(
        f"{SOURCE}?{urllib.parse.urlencode(params)}",
        headers={"User-Agent": "ParkSight Calgary Tower pilot/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        source = json.load(response)
    if source.get("error") or source.get("exceededTransferLimit"):
        raise RuntimeError(source.get("error") or "Calgary query was truncated")

    features = []
    for raw in source.get("features", []):
        properties = raw["attributes"]
        if properties.get("STATUS") != "Active":
            continue
        pieces = [piece for path in raw.get("geometry", {}).get("paths", []) for piece in clip_path(path)]
        if not pieces:
            continue
        geometry = (
            {"type": "LineString", "coordinates": pieces[0]}
            if len(pieces) == 1
            else {"type": "MultiLineString", "coordinates": pieces}
        )
        features.append({"type": "Feature", "id": properties["OBJECTID"], "properties": properties, "geometry": geometry})

    if not features:
        raise RuntimeError("Calgary query returned no active zones in the pilot area")
    result = {
        "type": "FeatureCollection",
        "name": "Calgary Tower curb zones",
        "source": SOURCE_PAGE,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "bounds": [WEST, SOUTH, EAST, NORTH],
        "features": features,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Saved {len(features)} City of Calgary zones to {OUTPUT}")


if __name__ == "__main__":
    main()
