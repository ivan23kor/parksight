"""Build portable curb overlays from the Calgary pilot's public City data."""

import json
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
SOURCE = DATA / "calgary-tower-zones.geojson"
GEOJSON = DATA / "calgary-tower-curb-overlay.geojson"
KML = DATA / "calgary-tower-curb-overlay.kml"
COLORS = {"parking": "#228064", "loading": "#e9a324", "taxi": "#805ac9", "other": "#7695a0"}
KML_NS = "http://www.opengis.net/kml/2.2"
ET.register_namespace("", KML_NS)


def category(properties):
    kind = (properties.get("ZONE_TYPE") or "").lower()
    for value in ("parking", "loading", "taxi"):
        if value in kind:
            return value
    return "other"


def kml_color(hex_color):
    red, green, blue = hex_color[1:3], hex_color[3:5], hex_color[5:7]
    return f"ff{blue}{green}{red}"


def element(parent, tag, text=None, **attrs):
    child = ET.SubElement(parent, f"{{{KML_NS}}}{tag}", attrs)
    if text is not None:
        child.text = str(text)
    return child


def main():
    zones = json.loads(SOURCE.read_text())
    features = []
    for zone in zones["features"]:
        original = zone["properties"]
        use = category(original)
        properties = {
            "id": f"calgary:parking-zone:{zone['id']}",
            "jurisdiction": "ca-ab-calgary",
            "timezone": "America/Edmonton",
            "category": use,
            "color": COLORS[use],
            "label": (original.get("ZONE_TYPE") or "Curb zone").strip(),
            "street": (original.get("ADDRESS_DESC") or "").strip(),
            "max_stay_minutes": original.get("MAX_TIME"),
            "enforceable_time": original.get("ENFORCEABLE_TIME"),
            "parking_restrict_time": original.get("PARKING_RESTRICT_TIME"),
            "source_id": zone["id"],
            "source_url": zones["source"],
            "source_retrieved_at": zones["retrieved_at"],
            "verification": "city_record_only",
        }
        features.append({"type": "Feature", "id": properties["id"], "geometry": zone["geometry"], "properties": properties})
    overlay = {
        "type": "FeatureCollection",
        "name": "ParkSight Calgary Tower curb overlay",
        "description": "City-designated curb uses; colors do not assert that parking is allowed at the current time. Uncolored curbs have no pilot zone record.",
        "coverage_id": "ca-ab-calgary-tower-2x2",
        "bounds": zones["bounds"],
        "source": zones["source"],
        "retrieved_at": zones["retrieved_at"],
        "features": features,
    }
    GEOJSON.write_text(json.dumps(overlay, ensure_ascii=False, separators=(",", ":")) + "\n")

    kml = element(ET.Element("root"), "kml")
    document = element(kml, "Document")
    element(document, "name", overlay["name"])
    element(document, "description", overlay["description"])
    for use, color in COLORS.items():
        style = element(document, "Style", id=use)
        line = element(style, "LineStyle")
        element(line, "color", kml_color(color))
        element(line, "width", "6")
    for feature in features:
        properties = feature["properties"]
        placemark = element(document, "Placemark")
        element(placemark, "name", f"{properties['label']} · {properties['street']}")
        element(placemark, "description", "City-designated curb use. Check posted signs and current restrictions before parking.")
        element(placemark, "styleUrl", f"#{properties['category']}")
        extended = element(placemark, "ExtendedData")
        for key, value in properties.items():
            if value is None:
                continue
            entry = element(extended, "Data", name=key)
            element(entry, "value", value)
        geometry = feature["geometry"]
        paths = [geometry["coordinates"]] if geometry["type"] == "LineString" else geometry["coordinates"]
        container = element(placemark, "MultiGeometry") if len(paths) > 1 else placemark
        for path in paths:
            line = element(container, "LineString")
            element(line, "tessellate", "1")
            element(line, "coordinates", " ".join(f"{lng},{lat},0" for lng, lat in path))
    KML.write_bytes(ET.tostring(kml, encoding="utf-8", xml_declaration=True))
    print(f"Built {len(features)} curb segments for Google Maps and other map apps")


if __name__ == "__main__":
    main()
