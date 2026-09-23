# ParkSight: Calgary Tower pilot

ParkSight maps City of Calgary curb zones and active parking signs in the four blocks between 1 Street SW, 1 Street SE, 8 Avenue, and 10 Avenue. The app shows a legend and City layers on one Google map, with a manual Street View panorama beside it. Clicking a curb or sign opens its nearby panorama and an evidence popup on the map. The popup identifies City-only records when no reviewed sign photo is linked to that curb decision or sign.

## Run

Set GOOGLE_MAPS_BROWSER_KEY in the environment or a local .env file, then run: bun run start. GOOGLE_MAPS_BROWSER_KEY_FILE can point to an existing local key file instead of copying the secret into .env.

Open http://127.0.0.1:8080. The map and manual Street View walker require the Maps JavaScript API. The portable City overlay files can be used independently in other map tools. The retained backend can read independently sourced photos with Gemini 3.5 Flash-Lite when a separate evidence workflow supplies them.

## Data and code

- data/calgary-tower-zones.geojson is a clipped snapshot of the City of Calgary's On-Street Parking Zones (https://data.calgary.ca/d/rhkg-vwwp), with source and retrieval date embedded.
- data/calgary-tower-signs.geojson is a snapshot of the City's Traffic Signs inventory (https://data.calgary.ca/d/u6ce-yibw), filtered to parking-related sign blades on active posts, with source and retrieval date embedded. A City record with missing sign text shows its sign code; it is not presented as a visually verified reading.
- data/calgary-tower-curb-overlay.geojson and .kml are portable color-coded curb layers built from the City zone snapshot. They show designated curb use, not whether parking is allowed at the current time.
- data/calgary-tower-sign-evidence.json links independently sourced sign crops to City sign IDs and curb decision IDs. It is empty until real photos are reviewed; a City-only segment or sign must show that no photo decision exists.
- bun run refresh:data refreshes both City snapshots and rebuilds the portable overlay files.
- web/ holds the map, panorama walker, and on-map evidence popups.
- backend/ retains the API, photo-only YOLO sign detection, and Gemini reading for evidence ingestion.
- backend/models/best.pt is the existing trained model; backend/models/best_openvino_model/ is its CPU-optimized runtime copy.

The City layers are official curb-zone and sign-inventory data. The map popup only presents a crop as decision evidence when the evidence record explicitly links its ID to a curb decision or City sign. City inventory signs are not visually verified until supported by independent photo evidence. The legend colors identify curb designations, not current parking availability.

Google Map Tiles API disallows image analysis and object detection, so the walker never sends Google imagery to the model or Gemini. The portable overlay uses City data, not information extracted from Google imagery. Google Maps Platform terms also restrict combining Google Maps services with a non-Google map in one app, so the interactive app has one Google map while the City overlay can be imported into independent map tools.

Keep the app centered on producing an accurate small Calgary map. A human must review each sign before adding photo evidence to a curb decision.
