# SolidWorks implementation review — 28 October 2026

This review traces native uploads through container decoding, Parasolid reconstruction, package conversion,
assembly placement, feature matching and the import worker. It also reviews the SolidWorks API exporter and runs
the backend suite and frontend production build. Tests use synthetic CAD and temporary databases; no production
data or remote server was changed. This is not certification of every SolidWorks feature or file version.

## Fixes

- Assembly definitions are grouped by file **and configuration**, keeping separate geometry and occurrences.
- Explicit configuration requests reject missing names or unavailable geometry rather than substituting another
  configuration. Name matching preserves punctuation (e.g. `Default-2` and `Default2` are distinct).
- Hidden and excluded-from-BOM state propagates from nested assembly occurrences to their leaves; nested rotation
  and translation are covered by regression tests.
- Assembly XML without a declaration is accepted, including compressed tree streams.
- Native bundle feature metadata links using the package definition ID carried through the worker, including
  multi-body definitions and configurations with identical geometry/names.
- Repeated aliases of a single package part no longer count as multiple possible matches.
- The Windows exporter activates the occurrence's referenced configuration before reading features, bounds and
  mass, then restores the previously active configuration, including when reading fails. Activation failure stops
  the export rather than reading the wrong configuration.
- The assembly PDF test now accounts for the existing cover page and checks both cover and step content.

## Feature coverage and boundaries

| Path / feature | Implementation and validation |
| --- | --- |
| Native SLDPRT container | Modern DEFLATE and legacy OLE stream readers; synthetic modern container, CRC, invalid/empty-file tests. Legacy OLE needs real-file qualification. |
| Saved geometry | Parasolid nodes rebuilt into OpenCascade; analytic and spline surface/curve handlers, body selection and validity checks. Fixture proves plate volume and bore radius. Arbitrary schema/topology coverage is not established. |
| Features such as extrude, revolve, cut, loft, sweep, fillet, chamfer and patterns | Imported as saved B-rep, not an editable parametric SolidWorks feature history. Per-feature rebuild equivalence needs representative real files. |
| Configuration geometry | Explicit selection is strict; native bundle conversion tests separate two configurations and preserve their bounds. Implicit active-part fallback retains its warning behavior. |
| Hole Wizard and cosmetic threads | Feature/face attribution, metric thread normalization, package matching and tap-drill fallback tests. Arbitrarily renamed/localized features and unsupported thread forms need real-file qualification. |
| Material, properties, appearance | Native property/material/color extraction and package mapping; material, finish and part number verified through authenticated upload to ready revision. |
| Sheet metal | Cut-list thickness/radius/K-factor import and package validation; unfolding and drawing tests exercise geometry downstream. Native flat-pattern fidelity across real sheet-metal models remains unqualified. |
| SLDASM | ZIP/Pack and Go required; component tree, virtual components, repeated occurrences, suppressed leaves, nested placements, inherited flags and configurations. A standalone SLDASM upload is intentionally rejected. |
| Missing/unreadable assembly components | Flagged bounding-box placeholders when available; otherwise omitted with warnings. Failed configuration reads follow this same path rather than substituting geometry. |
| Forge exporter | Pure-Python tests for transforms, bore grouping, hardware recognition, host mapping, package acceptance and configuration switching/restoration. Windows SolidWorks COM execution was not available. |
| Drawings, manufacturing and release | Full backend suite covers these downstream paths; synthetic import tests run authenticated upload, worker processing, metadata application and ready/failed status handling. Browser interaction was not exercised in this review. |

## Existing limits

The exporter does not recover metadata for modelled helical Thread features, apply weld beads, or export bend
direction/flat-pattern size. Native geometry decoding can reject unsupported Parasolid data. Missing components
remain placeholders, so warnings must be reconciled before manufacturing. Assemblies import saved placements;
Forge does not solve SolidWorks mates or replay its parametric history.

No real `.sldprt` or `.sldasm` files were found in the inspected workspace sample paths. The optional
`FORGE_SW_SAMPLES` test remains skipped until a sample directory is supplied. Real-file and Windows-seat checks
are still needed before claiming comprehensive SolidWorks compatibility.

## Validation results

- Full backend suite: **115 passed, 1 skipped** (62.48 seconds).
- Final SolidWorks/package regression run, including two XML cases added after the full run:
  **30 passed, 1 skipped** (2.07 seconds).
- Frontend `npm run build`: passed; Vite reported its existing large-chunk warning.
- `git diff --check`: passed.

The skipped case is the optional real SolidWorks sample test. Backend warnings concern upstream TestClient
and macOS multiprocessing deprecations.
