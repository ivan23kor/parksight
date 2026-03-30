# Ground Truth: rule-curve-intersections

## Structural assertions

### Intersections detected
- `intersections.intersectionCount` must be >= 2 (Vassar Street has at least 2 cross-street intersections in the fixture area)
- `intersections.intersectionNodeIndices` must be a non-empty array

### Rule curves rendered
- `rule_curves` array must contain at least 1 curve
- Each curve must have `pointCount` >= 3 (a curve is a polyline, not a point or single segment)
- Each curve `lengthMeters` must be > 8 (not degenerate)
- Each curve `lengthMeters` must be < 250 (bounded by intersection, not extending to infinity)
- The no_parking rule curve must have color `#ef4444` (red, matching RULE_CATEGORY_COLORS.no_parking)

### Distance calculation
- `max_distances.maxDistForward` must be > 10 (there is meaningful distance to next intersection)
- `max_distances.maxDistForward` must be < 250 (bounded by intersection, not falling back to 50m default or extending unbounded)
- `max_distances.maxDistBackward` must be > 10
- `max_distances.maxDistBackward` must be < 250

### Sign markers present
- `sign_markers` must contain at least one entry with `fillColor` "#22c55e" (green sign dot)
- `sign_markers` must contain at least one entry with `fillColor` "#60a5fa" (blue camera dot)
- `sign_markers` must contain at least one entry with `dashArray` "10 8" and `color` "#f59e0b" (amber dashed road centerline)

## Visual assertions

### Rule curve appearance
- Rule curve must be visible as a colored polyline on the map
- Rule curve must NOT extend past the visible intersection points

## Screenshot assertions

### 02-final-rule-curves.png
- A map should be visible with at least one colored polyline (the rule curve) that is NOT the same as the street lines
- The rule curve should appear offset from the street centerline, running parallel to it
- There should be colored dots visible on the map (sign markers and camera marker)

## Console assertions
- `console_errors` must be empty (no JavaScript errors during rendering)
- `console_logs` must contain at least one entry matching "renderRuleCurves" (confirming the rule curve rendering code executed)
