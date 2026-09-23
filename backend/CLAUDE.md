# Backend

app.py serves the Calgary map and API. detector.py runs the retained YOLO model over overlapping windows of a caller-supplied street photo and returns sign crops. ocr.py reads a selected crop or full photo with gemini-3.5-flash-lite. The current map UI has no photo-upload workflow. The Google Street View walker is for visual navigation only; do not use Google Map Tiles for image analysis or populate the portable City overlay from Google imagery.

The model loads on first detection to keep map startup quick. The former depth-estimation model, broad automatic area scan, local OSM database, and historical crop conversions are retired. Reviewed sign crops must be explicitly linked to City sign IDs or curb decision IDs in the evidence registry; do not silently turn camera bearings into asserted curb locations.
