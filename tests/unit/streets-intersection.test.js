/**
 * Unit tests for street intersection detection.
 * Tests findIntersectionNodes() with various intersection configurations.
 */

function _localBearingDegrees(fromLat, fromLng, toLat, toLng) {
    const dLat = toLat - fromLat;
    const dLng = (toLng - fromLng) * Math.cos((fromLat * Math.PI) / 180);
    return ((Math.atan2(dLng, dLat) * 180) / Math.PI + 360) % 360;
}

function findIntersectionNodes(wayGeometry, allWays) {
    if (!wayGeometry || wayGeometry.length === 0 || !allWays || allWays.length === 0) {
        return [];
    }

    const PRECISION = 5;
    const MIN_CROSSING_ANGLE_DEG = 25;

    const coordKeyToWayInfos = new Map();

    for (const way of allWays) {
        const nodes = way.geometry || [];
        const seenKeys = new Set();

        for (let i = 0; i < nodes.length; i++) {
            const lat = nodes[i].lat;
            const lng = nodes[i].lon ?? nodes[i].lng;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

            const key = `${lat.toFixed(PRECISION)},${lng.toFixed(PRECISION)}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);

            if (!coordKeyToWayInfos.has(key)) {
                coordKeyToWayInfos.set(key, []);
            }
            coordKeyToWayInfos.get(key).push({ way, nodeIndex: i });
        }
    }

    function streetDirectionAtNode(way, nodeIndex) {
        const nodes = way.geometry || [];
        if (nodes.length < 2) return null;

        let from, to;
        if (nodeIndex < nodes.length - 1) {
            from = nodes[nodeIndex];
            to = nodes[nodeIndex + 1];
        } else {
            from = nodes[nodeIndex - 1];
            to = nodes[nodeIndex];
        }

        const fromLng = from.lon ?? from.lng;
        const toLng = to.lon ?? to.lng;
        if (!Number.isFinite(from.lat) || !Number.isFinite(fromLng) ||
            !Number.isFinite(to.lat) || !Number.isFinite(toLng)) return null;

        const bearing = _localBearingDegrees(from.lat, fromLng, to.lat, toLng);
        return ((bearing % 180) + 180) % 180;
    }

    function classifyCrossing(wayInfos) {
        const names = new Set();
        let allNamed = true;

        for (const info of wayInfos) {
            const name = info.way.tags?.name;
            if (name) { names.add(name); } else { allNamed = false; }
        }

        if (names.size >= 2) return { isCrossing: true };
        if (names.size === 1 && allNamed) return { isCrossing: false };

        const dirs = [];
        for (const info of wayInfos) {
            const d = streetDirectionAtNode(info.way, info.nodeIndex);
            if (d !== null) dirs.push(d);
        }

        for (let i = 0; i < dirs.length; i++) {
            for (let j = i + 1; j < dirs.length; j++) {
                const diff = Math.abs(dirs[i] - dirs[j]);
                if (Math.min(diff, 180 - diff) > MIN_CROSSING_ANGLE_DEG) {
                    return { isCrossing: true };
                }
            }
        }

        return { isCrossing: false };
    }

    const intersectionNodes = [];
    for (let nodeIdx = 0; nodeIdx < wayGeometry.length; nodeIdx++) {
        const node = wayGeometry[nodeIdx];
        const lat = node.lat;
        const lng = node.lon ?? node.lng;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

        const key = `${lat.toFixed(PRECISION)},${lng.toFixed(PRECISION)}`;
        const wayInfos = coordKeyToWayInfos.get(key);
        if (!wayInfos || wayInfos.length < 2) continue;

        const { isCrossing } = classifyCrossing(wayInfos);
        if (!isCrossing) continue;

        const mainDir = streetDirectionAtNode({ geometry: wayGeometry }, nodeIdx);
        const crossStreetTags = [];

        for (const info of wayInfos) {
            const otherDir = streetDirectionAtNode(info.way, info.nodeIndex);
            if (mainDir !== null && otherDir !== null) {
                const diff = Math.abs(mainDir - otherDir);
                if (Math.min(diff, 180 - diff) <= MIN_CROSSING_ANGLE_DEG) continue;
            }
            const tags = info.way.tags || {};
            crossStreetTags.push({
                highway: tags.highway || null,
                lanes: tags.lanes || null,
                oneway: tags.oneway || null,
            });
        }

        intersectionNodes.push({
            lat,
            lng,
            nodeIndex: nodeIdx,
            crossStreetTags,
        });
    }

    return intersectionNodes;
}

// Test cases
const tests = [
    {
        name: "T-intersection: way 1 (N-S) crosses way 2 (E-W), shared node in middle",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },
            { lat: 40.1, lon: -73.0 },  // intersection at nodeIndex 1
            { lat: 40.2, lon: -73.0 },
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.1, lon: -73.0 },
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "Main St" },
            },
            {
                geometry: [
                    { lat: 40.1, lon: -73.1 },
                    { lat: 40.1, lon: -73.0 },  // shared node
                    { lat: 40.1, lon: -72.9 },
                ],
                tags: { name: "Cross St" },
            },
        ],
        expectedCount: 1,
        expectedNodeIndices: [1],
    },

    {
        name: "Cross intersection: 2 ways cross at center node",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },
            { lat: 40.1, lon: -73.0 },  // intersection at nodeIndex 1
            { lat: 40.2, lon: -73.0 },
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.1, lon: -73.0 },
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "NS St" },
            },
            {
                geometry: [
                    { lat: 40.1, lon: -73.1 },
                    { lat: 40.1, lon: -73.0 },  // shared
                    { lat: 40.1, lon: -72.9 },
                ],
                tags: { name: "EW St" },
            },
        ],
        expectedCount: 1,
        expectedNodeIndices: [1],
    },

    {
        name: "No intersection: parallel ways, no shared nodes",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },
            { lat: 40.1, lon: -73.0 },
            { lat: 40.2, lon: -73.0 },
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.1, lon: -73.0 },
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "Way A" },
            },
            {
                geometry: [
                    { lat: 40.0, lon: -73.1 },
                    { lat: 40.1, lon: -73.1 },
                    { lat: 40.2, lon: -73.1 },
                ],
                tags: { name: "Way B (parallel)" },
            },
        ],
        expectedCount: 0,
        expectedNodeIndices: [],
    },

    {
        name: "Endpoint intersection: ways meet at endpoint",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },
            { lat: 40.1, lon: -73.0 },
            { lat: 40.2, lon: -73.0 },  // endpoint is intersection
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.1, lon: -73.0 },
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "Way A" },
            },
            {
                geometry: [
                    { lat: 40.2, lon: -73.1 },
                    { lat: 40.2, lon: -73.0 },  // connects to endpoint
                ],
                tags: { name: "Way B" },
            },
        ],
        expectedCount: 1,
        expectedNodeIndices: [2],
    },

    {
        name: "Multiple intersections along way",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },  // intersection at nodeIndex 0
            { lat: 40.1, lon: -73.0 },  // intersection at nodeIndex 1
            { lat: 40.2, lon: -73.0 },  // intersection at nodeIndex 2
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.1, lon: -73.0 },
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "Main St" },
            },
            {
                geometry: [
                    { lat: 40.0, lon: -73.1 },
                    { lat: 40.0, lon: -73.0 },  // connects at first node
                ],
                tags: { name: "Cross 1" },
            },
            {
                geometry: [
                    { lat: 40.1, lon: -73.1 },
                    { lat: 40.1, lon: -73.0 },  // connects at second node
                ],
                tags: { name: "Cross 2" },
            },
            {
                geometry: [
                    { lat: 40.2, lon: -73.1 },
                    { lat: 40.2, lon: -73.0 },  // connects at third node
                ],
                tags: { name: "Cross 3" },
            },
        ],
        expectedCount: 3,
        expectedNodeIndices: [0, 1, 2],
    },

    {
        name: "Empty wayGeometry returns empty result",
        wayGeometry: [],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                ],
                tags: { name: "Some St" },
            },
        ],
        expectedCount: 0,
        expectedNodeIndices: [],
    },

    {
        name: "Empty allWays returns empty result",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },
            { lat: 40.1, lon: -73.0 },
        ],
        allWays: [],
        expectedCount: 0,
        expectedNodeIndices: [],
    },

    {
        name: "Null wayGeometry returns empty result",
        wayGeometry: null,
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                ],
                tags: { name: "Some St" },
            },
        ],
        expectedCount: 0,
        expectedNodeIndices: [],
    },

    {
        name: "Way with lng property instead of lon",
        wayGeometry: [
            { lat: 40.0, lng: -73.0 },
            { lat: 40.1, lng: -73.0 },  // intersection at nodeIndex 1
            { lat: 40.2, lng: -73.0 },
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lng: -73.0 },
                    { lat: 40.1, lng: -73.0 },
                    { lat: 40.2, lng: -73.0 },
                ],
                tags: { name: "Main St" },
            },
            {
                geometry: [
                    { lat: 40.1, lng: -73.1 },
                    { lat: 40.1, lng: -73.0 },  // shared node
                    { lat: 40.1, lng: -72.9 },
                ],
                tags: { name: "Cross St" },
            },
        ],
        expectedCount: 1,
        expectedNodeIndices: [1],
    },

    {
        name: "Skip invalid lat/lon values",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },
            { lat: null, lon: -73.0 },    // invalid
            { lat: 40.2, lon: -73.0 },
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: null, lon: -73.0 },  // invalid in other way too, but shouldn't match
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "Way A" },
            },
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "Way B" },
            },
        ],
        expectedCount: 2,  // nodes at indices 0 and 2 appear in 2 ways
        expectedNodeIndices: [0, 2],
    },

    {
        name: "Same-street continuation split (same name, same direction) is NOT an intersection",
        wayGeometry: [
            { lat: 42.360, lon: -71.094 },
            { lat: 42.361, lon: -71.093 },  // shared node
            { lat: 42.362, lon: -71.092 },
        ],
        allWays: [
            {
                geometry: [
                    { lat: 42.360, lon: -71.094 },
                    { lat: 42.361, lon: -71.093 },
                    { lat: 42.362, lon: -71.092 },
                ],
                tags: { name: "Vassar Street", highway: "secondary" },
            },
            {
                geometry: [
                    { lat: 42.359, lon: -71.095 },
                    { lat: 42.360, lon: -71.094 },  // shared at endpoint
                    { lat: 42.361, lon: -71.093 },  // shared mid-node
                ],
                tags: { name: "Vassar Street", highway: "secondary" },
            },
        ],
        expectedCount: 0,
        expectedNodeIndices: [],
    },

    {
        name: "Unnamed continuation with same bearing is NOT an intersection",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },
            { lat: 40.1, lon: -73.0 },  // shared node
            { lat: 40.2, lon: -73.0 },
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.1, lon: -73.0 },
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { highway: "residential" },  // no name
            },
            {
                geometry: [
                    { lat: 39.9, lon: -73.0 },
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.1, lon: -73.0 },
                ],
                tags: { highway: "residential" },  // no name, same direction
            },
        ],
        expectedCount: 0,
        expectedNodeIndices: [],
    },

    {
        name: "Intersection node includes crossStreetTags",
        wayGeometry: [
            { lat: 40.0, lon: -73.0 },
            { lat: 40.1, lon: -73.0 },  // intersection
            { lat: 40.2, lon: -73.0 },
        ],
        allWays: [
            {
                geometry: [
                    { lat: 40.0, lon: -73.0 },
                    { lat: 40.1, lon: -73.0 },
                    { lat: 40.2, lon: -73.0 },
                ],
                tags: { name: "Main St", highway: "secondary", lanes: "3" },
            },
            {
                geometry: [
                    { lat: 40.1, lon: -73.1 },
                    { lat: 40.1, lon: -73.0 },
                    { lat: 40.1, lon: -72.9 },
                ],
                tags: { name: "Cross St", highway: "primary", lanes: "4" },
            },
        ],
        expectedCount: 1,
        expectedNodeIndices: [1],
        checkCrossStreetTags: (nodes) => {
            const tags = nodes[0].crossStreetTags;
            if (!Array.isArray(tags) || tags.length === 0) return "crossStreetTags missing or empty";
            if (!tags.some(t => t.highway === "primary")) return "expected primary highway in crossStreetTags";
            return null;
        },
    },
];

// Run tests
console.log("Running findIntersectionNodes() unit tests...\n");
let passed = 0;
let failed = 0;

for (const test of tests) {
    const result = findIntersectionNodes(test.wayGeometry, test.allWays);

    const countMatch = result.length === test.expectedCount;
    const indicesMatch =
        result.length === test.expectedNodeIndices.length &&
        result.every((node, i) => node.nodeIndex === test.expectedNodeIndices[i]);
    const success = countMatch && indicesMatch;

    const customCheckError = success && test.checkCrossStreetTags ? test.checkCrossStreetTags(result) : null;
    if (customCheckError) success = false;

    if (success) {
        console.log(`✓ ${test.name}`);
        passed++;
    } else {
        console.log(`✗ ${test.name}`);
        if (!countMatch) {
            console.log(`  Expected ${test.expectedCount} intersections, got ${result.length}`);
        }
        if (!indicesMatch) {
            const actualIndices = result.map(n => n.nodeIndex);
            console.log(`  Expected nodeIndices ${test.expectedNodeIndices}, got ${actualIndices}`);
        }
        if (customCheckError) {
            console.log(`  Custom check failed: ${customCheckError}`);
        }
        if (result.length > 0) {
            console.log(`  Full result:`, JSON.stringify(result, null, 2));
        }
        failed++;
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
