"""Snapshot active City parking sign blades at signposts in the Tower pilot."""

import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "calgary-tower-signs.geojson"
SOURCE = "https://data.calgary.ca/resource/u6ce-yibw.json"
SOURCE_PAGE = "https://data.calgary.ca/d/u6ce-yibw"
WEST, SOUTH, EAST, NORTH = -114.06565, 51.04331, -114.06062, 51.04561
PARKING_TYPES = {
    "Parking Restrictions",
    "Timed Parking",
    "Loading Zone",
    "Park Plus",
    "Residential Parking",
    "Disabled Parking",
    "Snow Route",
}
PARKING_WORDS = re.compile(r"\b(?:PARK|PARKING|2HR|NPAT|NSAT|NPA|NSA|LZ|ZONE)\b", re.I)


def is_parking_sign(row):
    if row.get("sta_cd") != "A" or row.get("sgn_sta_cd") != "A":
        return False
    sign_type = row.get("blade_type")
    return sign_type in PARKING_TYPES or (not sign_type and bool(PARKING_WORDS.search(row.get("sign_txt") or "")))


def main():
    query = urllib.parse.urlencode({
        "$where": f"within_box(point,{NORTH},{WEST},{SOUTH},{EAST})",
        "$limit": "5000",
    })
    request = urllib.request.Request(f"{SOURCE}?{query}", headers={"User-Agent": "ParkSight Calgary Tower pilot/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        rows = json.load(response)
    if not isinstance(rows, list) or len(rows) >= 5000:
        raise RuntimeError("Calgary sign query failed or may have been truncated")

    posts = {}
    for row in rows:
        if not is_parking_sign(row) or not row.get("point"):
            continue
        post_id = row["te_signlocation_unitid"]
        post = posts.setdefault(post_id, {
            "type": "Feature",
            "id": post_id,
            "geometry": row["point"],
            "properties": {"post_id": post_id, "verification": "city_record_only", "signs": []},
        })
        post["properties"]["signs"].append({
            "id": row.get("unitid"),
            "type": row.get("blade_type") or "Parking sign",
            "text": row.get("sign_txt") or None,
            "code": row.get("book_cd") or None,
            "facing": row.get("facing_cd") or None,
            "installed": row.get("instdate") or None,
        })

    features = [posts[post_id] for post_id in sorted(posts)]
    for feature in features:
        feature["properties"]["signs"].sort(key=lambda sign: sign["id"] or "")
    if not features:
        raise RuntimeError("Calgary query returned no active parking signs in the pilot area")
    result = {
        "type": "FeatureCollection",
        "name": "Calgary Tower active parking sign inventory",
        "source": SOURCE_PAGE,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "bounds": [WEST, SOUTH, EAST, NORTH],
        "selection": "Parking-related sign blades on as-built posts; both sign and post must be active",
        "features": features,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Saved {sum(len(feature['properties']['signs']) for feature in features)} signs on {len(features)} posts to {OUTPUT}")


if __name__ == "__main__":
    main()
