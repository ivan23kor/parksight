#!/usr/bin/env python3
"""
Empirical test: can Google Street View depth maps measure camera-to-ground
distance at a given heading?

For each test panorama we:
1. Fetch the depth map from Google's photometa/v1 endpoint
2. Parse the plane-based depth representation
3. Sample depth at sign heading + various downward pitches
4. Compute horizontal distance to ground at those headings
5. Print results + Google Maps links for manual verification

Usage:
    GOOGLE_MAPS_API_KEY=... python3 scripts/test_depth_map.py
"""

import base64
import json
import math
import os
import struct
import sys
import zlib
from dataclasses import dataclass

import requests

CAMERA_HEIGHT_M = 2.5  # Google SV car camera height


# ---------------------------------------------------------------------------
# Test panoramas: locations where parking signs are visible
# Each has a pano_id OR lat/lng, plus approximate sign heading and road bearing
# ---------------------------------------------------------------------------
TEST_CASES = [
    {
        "name": "Boston - Cambridge St",
        "lat": 42.3601,
        "lng": -71.0589,
        "sign_heading_approx": 135,
        "road_bearing_approx": 90,
        "notes": "Downtown Boston, 2-lane one-way",
    },
    {
        "name": "Manhattan - 7th Ave & W 47th",
        "lat": 40.7590,
        "lng": -73.9845,
        "sign_heading_approx": 70,
        "road_bearing_approx": 25,
        "notes": "Times Square area, multi-lane",
    },
    {
        "name": "San Francisco - Market St",
        "lat": 37.7849,
        "lng": -122.4094,
        "sign_heading_approx": 150,
        "road_bearing_approx": 60,
        "notes": "Wide boulevard, 4+ lanes",
    },
    {
        "name": "Chicago - Dearborn St",
        "lat": 41.8827,
        "lng": -87.6294,
        "sign_heading_approx": 100,
        "road_bearing_approx": 5,
        "notes": "Grid street, 2-lane",
    },
    {
        "name": "Toronto - Bay St",
        "lat": 43.6510,
        "lng": -79.3832,
        "sign_heading_approx": 110,
        "road_bearing_approx": 170,
        "notes": "Downtown Toronto, 4-lane",
    },
    {
        "name": "Los Angeles - Spring St",
        "lat": 34.0522,
        "lng": -118.2428,
        "sign_heading_approx": 80,
        "road_bearing_approx": 350,
        "notes": "Downtown LA, 2-lane one-way",
    },
    {
        "name": "Seattle - 5th Ave",
        "lat": 47.6097,
        "lng": -122.3376,
        "sign_heading_approx": 260,
        "road_bearing_approx": 200,
        "notes": "Downtown Seattle, 2-lane",
    },
    {
        "name": "Austin - Congress Ave",
        "lat": 30.2672,
        "lng": -97.7431,
        "sign_heading_approx": 100,
        "road_bearing_approx": 180,
        "notes": "Wide avenue, 4-lane",
    },
]


# ---------------------------------------------------------------------------
# Step 1: Resolve lat/lng to pano_id via Street View metadata API
# ---------------------------------------------------------------------------
def get_pano_id(lat: float, lng: float, api_key: str) -> dict | None:
    """Get the nearest Street View pano_id for a lat/lng."""
    url = "https://maps.googleapis.com/maps/api/streetview/metadata"
    params = {"location": f"{lat},{lng}", "key": api_key, "source": "outdoor"}
    resp = requests.get(url, params=params, timeout=10)
    data = resp.json()
    if data.get("status") != "OK":
        return None
    return {
        "pano_id": data["pano_id"],
        "lat": data["location"]["lat"],
        "lng": data["location"]["lng"],
        "date": data.get("date", "unknown"),
    }


# ---------------------------------------------------------------------------
# Step 2: Fetch depth map from photometa/v1
# ---------------------------------------------------------------------------
def fetch_depth_data(pano_id: str) -> str | None:
    """Fetch raw depth map string from Google's photometa endpoint."""
    url = "https://www.google.com/maps/photometa/v1"
    params = {
        "authuser": "0",
        "hl": "en",
        "gl": "us",
        "pb": (
            "!1m4!1smaps_sv.tactile!11m2!2m1!1b1!2m2!1sen!2sus"
            f"!3m3!1m2!1e2!2s{pano_id}"
            "!4m57!1e1!1e2!1e3!1e4!1e5!1e6!1e8!1e12"
            "!2m1!1e1!4m1!1i48!5m1!1e1!5m1!1e2"
            "!6m1!1e1!6m1!1e2"
            "!9m36!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3"
            "!1m3!1e3!2b1!3e2!1m3!1e3!2b0!3e3"
            "!1m3!1e8!2b0!3e3!1m3!1e1!2b0!3e3"
            "!1m3!1e4!2b0!3e3!1m3!1e10!2b1!3e2"
            "!1m3!1e10!2b0!3e3"
        ),
    }
    resp = requests.get(url, params=params, timeout=15)
    if resp.status_code != 200:
        return None

    # Response is )]}\n followed by JSON
    text = resp.text
    if text.startswith(")]}'"):
        text = text[text.index("\n") + 1 :]

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None

    # Navigate the nested proto-like structure to find depth string
    # Path: [1][0][5][0][5][1][2]
    try:
        depth_str = data[1][0][5][0][5][1][2]
        return depth_str
    except (IndexError, TypeError, KeyError):
        pass

    # Fallback: try alternate paths
    for path in [
        [1, 0, 5, 0, 5, 1, 2],
        [1, 0, 5, 0, 5, 2, 2],
    ]:
        try:
            node = data
            for idx in path:
                node = node[idx]
            if isinstance(node, str) and len(node) > 50:
                return node
        except (IndexError, TypeError, KeyError):
            continue
    return None


# ---------------------------------------------------------------------------
# Step 3: Parse depth map
# ---------------------------------------------------------------------------
def decode_depth_data(raw: str) -> bytes:
    """Base64-decode and decompress the depth data string."""
    padded = raw + "=" * ((4 - len(raw) % 4) % 4)
    padded = padded.replace("-", "+").replace("_", "/")
    decoded = base64.b64decode(padded)
    try:
        return zlib.decompress(decoded)
    except zlib.error:
        return decoded


@dataclass
class DepthPlane:
    nx: float
    ny: float
    nz: float
    d: float


@dataclass
class DepthMap:
    width: int
    height: int
    num_planes: int
    planes: list[DepthPlane]
    indices: list[int]


def parse_depth_map(data: bytes) -> DepthMap:
    """Parse the binary depth map into planes and indices."""
    header_size = data[0]
    num_planes = struct.unpack_from("<H", data, 1)[0]
    width = struct.unpack_from("<H", data, 3)[0]
    height = struct.unpack_from("<H", data, 5)[0]
    offset = struct.unpack_from("<H", data, 7)[0]

    indices = list(data[offset : offset + width * height])

    planes = []
    plane_offset = offset + width * height
    for i in range(num_planes):
        base = plane_offset + i * 16
        nx = struct.unpack_from("<f", data, base)[0]
        ny = struct.unpack_from("<f", data, base + 4)[0]
        nz = struct.unpack_from("<f", data, base + 8)[0]
        d = struct.unpack_from("<f", data, base + 12)[0]

        planes.append(DepthPlane(nx=nx, ny=ny, nz=nz, d=d))

    return DepthMap(
        width=width,
        height=height,
        num_planes=num_planes,
        planes=planes,
        indices=indices,
    )


def sample_depth(dm: DepthMap, heading_deg: float, pitch_deg: float) -> float | None:
    """
    Sample the depth map at a given heading and pitch.

    The depth map is an equirectangular projection of the panorama.
    - heading 0° = north, increases clockwise
    - pitch 0° = horizon, negative = below horizon

    Returns distance in meters from camera to the surface, or None if no data.
    """
    # Convert heading/pitch to depth map pixel coordinates
    # Depth map: x=0 is heading ~180° from pano center, wraps around
    # Width covers 360° horizontally, height covers 180° vertically (top=up, bottom=down)
    theta = (90 - pitch_deg) * math.pi / 180  # polar angle from top (0=up, pi=down)
    phi = (180 - heading_deg) * math.pi / 180  # azimuthal, adjusted for depth map convention

    # Map to pixel coords in the depth map
    y = theta / math.pi * dm.height
    x = phi / (2 * math.pi) * dm.width
    # Wrap x
    x = x % dm.width

    ix = int(x) % dm.width
    iy = int(y) % dm.height

    plane_idx = dm.indices[iy * dm.width + ix]
    if plane_idx == 0:
        return None  # No depth data (sky, etc.)

    plane = dm.planes[plane_idx]

    # Ray direction in the depth map's coordinate system
    sin_theta = math.sin(theta)
    cos_theta = math.cos(theta)
    sin_phi = math.sin(phi)
    cos_phi = math.cos(phi)

    vx = sin_theta * cos_phi
    vy = sin_theta * sin_phi
    vz = cos_theta

    denom = vx * plane.nx + vy * plane.ny + vz * plane.nz
    if abs(denom) < 1e-10:
        return None

    t = abs(plane.d / denom)
    return t


# ---------------------------------------------------------------------------
# Step 4: Run the test
# ---------------------------------------------------------------------------
def heading_to_depth_map_heading(heading_deg: float) -> float:
    """
    Ensure heading is in [0, 360) range.
    Depth map heading convention: 0° = north, clockwise.
    """
    return heading_deg % 360


def run_test(api_key: str):
    """Run depth map test across all test cases."""
    print("=" * 90)
    print("GOOGLE STREET VIEW DEPTH MAP TEST")
    print("=" * 90)
    print()

    results = []

    for tc in TEST_CASES:
        name = tc["name"]
        print(f"--- {name} ---")
        print(f"    Notes: {tc['notes']}")

        # Step 1: Get pano_id
        meta = get_pano_id(tc["lat"], tc["lng"], api_key)
        if not meta:
            print(f"    SKIP: No Street View coverage at {tc['lat']}, {tc['lng']}")
            print()
            continue

        pano_id = meta["pano_id"]
        actual_lat, actual_lng = meta["lat"], meta["lng"]
        print(f"    Pano ID: {pano_id}")
        print(f"    Actual location: {actual_lat:.6f}, {actual_lng:.6f}")
        print(f"    Date: {meta['date']}")
        gmaps_link = (
            f"https://www.google.com/maps/@{actual_lat},{actual_lng},3a,75y,"
            f"{tc['sign_heading_approx']:.0f}h,90t"
        )
        print(f"    Google Maps: {gmaps_link}")

        # Step 2: Fetch depth data
        raw_depth = fetch_depth_data(pano_id)
        if not raw_depth:
            print(f"    SKIP: Could not fetch depth data")
            print()
            continue

        # Step 3: Parse depth map
        decoded = decode_depth_data(raw_depth)
        dm = parse_depth_map(decoded)
        print(f"    Depth map: {dm.width}x{dm.height}, {dm.num_planes} planes")

        # Step 4: Sample at sign heading at various pitches
        sign_h = heading_to_depth_map_heading(tc["sign_heading_approx"])
        road_b = tc["road_bearing_approx"]
        alpha = (sign_h - road_b) % 360
        if alpha > 180:
            alpha -= 360

        print(f"    Sign heading: {sign_h:.0f}°, Road bearing: {road_b}°, Angle from road: {alpha:.1f}°")
        print()

        # Sample at the sign heading at various downward pitches
        print(f"    {'Pitch':>8s}  {'Raw depth':>10s}  {'Horiz dist':>10s}  {'Plane idx':>10s}")
        print(f"    {'-----':>8s}  {'----------':>10s}  {'----------':>10s}  {'----------':>10s}")

        test_pitches = [0, -5, -10, -15, -20, -25, -30, -35, -40, -45, -50, -60, -70, -80]
        pitch_results = []

        for pitch in test_pitches:
            d = sample_depth(dm, sign_h, pitch)
            if d is not None and d < 1000:
                h_dist = d * math.cos(math.radians(pitch))

                # Get plane index for this pixel
                theta = (90 - pitch) * math.pi / 180
                phi = (180 - sign_h) * math.pi / 180
                y = int(theta / math.pi * dm.height) % dm.height
                x = int(phi / (2 * math.pi) * dm.width) % dm.width
                pidx = dm.indices[y * dm.width + x]

                print(f"    {pitch:>7d}°  {d:>9.2f}m  {h_dist:>9.2f}m  {pidx:>10d}")
                pitch_results.append({"pitch": pitch, "raw_depth": d, "horiz_dist": h_dist, "plane_idx": pidx})
            else:
                print(f"    {pitch:>7d}°  {'no data':>10s}  {'---':>10s}  {'---':>10s}")

        # Also sample perpendicular to road (toward right curb)
        perp_heading = heading_to_depth_map_heading(road_b + 90)
        print()
        print(f"    Perpendicular to road (heading {perp_heading:.0f}°):")
        print(f"    {'Pitch':>8s}  {'Raw depth':>10s}  {'Horiz dist':>10s}  {'Plane idx':>10s}")
        print(f"    {'-----':>8s}  {'----------':>10s}  {'----------':>10s}  {'----------':>10s}")

        for pitch in [-20, -25, -30, -35, -40, -50, -60]:
            d = sample_depth(dm, perp_heading, pitch)
            if d is not None and d < 1000:
                h_dist = d * math.cos(math.radians(pitch))
                theta = (90 - pitch) * math.pi / 180
                phi = (180 - perp_heading) * math.pi / 180
                y = int(theta / math.pi * dm.height) % dm.height
                x = int(phi / (2 * math.pi) * dm.width) % dm.width
                pidx = dm.indices[y * dm.width + x]
                print(f"    {pitch:>7d}°  {d:>9.2f}m  {h_dist:>9.2f}m  {pidx:>10d}")
            else:
                print(f"    {pitch:>7d}°  {'no data':>10s}  {'---':>10s}  {'---':>10s}")

        # Compute geometric projection if we have ground data at sign heading
        ground_pitches = [r for r in pitch_results if r["pitch"] <= -25]
        if ground_pitches:
            # Use the measurement at -30° as representative (middle of range)
            best = min(ground_pitches, key=lambda r: abs(r["pitch"] - (-30)))
            h_dist = best["horiz_dist"]
            along_road = h_dist * math.cos(math.radians(alpha))
            perp_offset = h_dist * math.sin(math.radians(alpha))
            print()
            print(f"    >> Using depth at pitch={best['pitch']}°:")
            print(f"       Horizontal distance to ground at sign heading: {h_dist:.2f}m")
            print(f"       Along-road distance: {along_road:.2f}m")
            print(f"       Perpendicular offset (curb distance): {abs(perp_offset):.2f}m")

        # Check: at sign heading and pitch=0 (horizon), do we see the sign or background?
        sign_level_depths = [r for r in pitch_results if -10 <= r["pitch"] <= 5]
        if sign_level_depths:
            print()
            print(f"    >> Sign-level depth (pitch 0° to -10°):")
            for r in sign_level_depths:
                print(f"       pitch={r['pitch']}°: {r['raw_depth']:.2f}m (plane {r['plane_idx']})")

        results.append({
            "name": name,
            "pano_id": pano_id,
            "depth_map_size": f"{dm.width}x{dm.height}",
            "num_planes": dm.num_planes,
            "pitch_results": pitch_results,
        })
        print()

    # Summary
    print("=" * 90)
    print("SUMMARY")
    print("=" * 90)
    for r in results:
        ground_results = [p for p in r["pitch_results"] if p["pitch"] <= -25]
        sign_results = [p for p in r["pitch_results"] if -10 <= p["pitch"] <= 5]

        unique_ground_planes = set(p["plane_idx"] for p in ground_results) if ground_results else set()
        unique_sign_planes = set(p["plane_idx"] for p in sign_results) if sign_results else set()

        ground_dists = [p["horiz_dist"] for p in ground_results] if ground_results else []
        sign_dists = [p["raw_depth"] for p in sign_results] if sign_results else []

        print(f"  {r['name']}")
        print(f"    Depth map: {r['depth_map_size']}, {r['num_planes']} planes")
        if ground_dists:
            print(f"    Ground horiz distances: {', '.join(f'{d:.1f}m' for d in ground_dists)}")
            print(f"    Ground planes used: {unique_ground_planes}")
        if sign_dists:
            print(f"    Sign-level distances: {', '.join(f'{d:.1f}m' for d in sign_dists)}")
            print(f"    Sign planes used: {unique_sign_planes}")
            same = unique_sign_planes == unique_ground_planes
            print(f"    Sign plane == Ground plane: {'YES ⚠️' if same else 'NO ✓ (sign has own plane)'}")
        print()


def main():
    api_key = os.environ.get("GOOGLE_MAPS_API_KEY", "")
    if not api_key:
        print("ERROR: Set GOOGLE_MAPS_API_KEY environment variable", file=sys.stderr)
        sys.exit(1)
    run_test(api_key)


if __name__ == "__main__":
    main()
