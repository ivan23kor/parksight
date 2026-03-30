2D Panorama Capture Point Discovery
Problem
No way to visualize where Google Street View capture points actually exist in a neighbourhood. Currently, syncPanoramaCaptureSpotsOnMap only shows 1-hop linked panos from the active rendered panorama.
Current Mechanism
index.html (syncPanoramaCaptureSpotsOnMap, lines 682-715):
Gets current pano position via detectionPanorama.getPosition()
Gets links via detectionPanorama.getLinks() (requires a rendered panorama)
Calls fetchLinkedPanoramaCaptureSpots(links) which resolves each link's lat/lng via StreetViewService.getPanorama({pano: id})
Renders current + linked spots as circle markers on panoramaCaptureSpotsLayer
Critically, StreetViewService.getPanorama({pano}) returns response.data.links (Array of {pano, heading, description}) in addition to response.data.location — so we can discover the full link graph without rendering any panorama.
Proposed Changes
1. New function: discoverPanoNetwork(seedPanoId, maxDepth=3)
Add to index.html inline (near the existing fetchLinkedPanoramaCaptureSpots).
BFS traversal:
Input: a seed panoId + maxDepth (default 3)
Uses a single StreetViewService instance
Maintains a visited Map of panoId → {lat, lng, depth, heading, description, links}
Queue-based BFS: for each pano, call svService.getPanorama({pano}), extract position + links, enqueue unvisited links up to maxDepth
Concurrency control: process each BFS level in parallel via Promise.allSettled (all panos at depth N resolve before starting depth N+1). This keeps API calls manageable — worst case ~40 calls for depth 3 at a 4-way intersection
Returns the visited Map
2. New function: renderPanoNetworkOnMap(networkMap)
Add near renderPanoramaCaptureSpotsOnMap.
Renders all discovered pano points on panoramaCaptureSpotsLayer:
Depth 0 (seed): blue, radius 7
Depth 1: dark gray, radius 5
Depth 2: medium gray, radius 4
Depth 3: light gray, radius 3
Lines connecting each pano to its parent (optional, thin gray polylines) to show the street network structure
Each marker gets a popup: pano ID, description, depth
Clicking a marker opens that panorama (reuses existing initPanoramaForContext flow)
3. Trigger: expand existing map-click flow
Modify the map click handler (line 1905) in setupEventHandlers:
After the existing initPanoramaForContext() call, also run discoverPanoNetwork(panoId, 3) and render results
This replaces the current 1-hop syncPanoramaCaptureSpotsOnMap with the 3-hop network for the clicked point
The existing syncPanoramaCaptureSpotsOnMap (triggered on pano_changed/position_changed) continues to work when navigating within the panorama view; the network dots persist until the next map click or clear
4. Cancellation & cleanup
Store a monotonic token (like existing panoramaCaptureSpotsSyncToken) so stale BFS results are discarded if the user clicks again before the previous BFS completes
clearPanoramaCaptureSpots() already clears the layer — wire it to also abort any in-flight BFS
Files Changed
index.html — Add discoverPanoNetwork, renderPanoNetworkOnMap, modify map-click handler, ~80 lines total
