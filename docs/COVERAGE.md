# Engineering coverage and known boundaries

## What the geometry engine establishes

| Area | Implemented evidence | Engineering boundary |
|---|---|---|
| Import | STEP XCAF hierarchy/placements; BREP/IGES solids; multi-body splitting | Surface-only components are viewer-only and listed as warnings; no proprietary CAD parser or semantic PMI recovery |
| Classification | Names, supplier ancestry, thickness/plane/cylinder evidence | Heuristic, not a guaranteed BOM make/buy decision; every custom part needs review |
| Holes | Full cylindrical internal faces, nominal diameter, axis, center, cylindrical segment length, outer edge web | Segment length is not necessarily drill depth. Threads, blind-hole tip, counterbore/countersink relationships and tolerances are not reliably inferred |
| Bends | Paired coaxial cylindrical faces, thickness, radius, angle and length | Forming direction, relief design, tooling collision and process springback need checking |
| Flat pattern | Connected planar/cylindrical skin, K-based allowance, contour/overlap/coverage checks; constant-thickness flat plates | Double-curved, incomplete, ambiguous and unsupported forms are blocked. A projected silhouette is never substituted for a developed blank |
| Mating | Coaxial full bore/shaft surfaces with nominal size proximity and axial overlap, in imported poses | Candidate only. No general contact/interference solver, bearing stack-up, fastener torque calculation or functional fit-class inference |
| Quality | Released feature limits; serial, instrument, operator, measurement, automatic pass/fail; CSV | Does not certify instrument calibration, measurement uncertainty, sampling plans, capability or corrective-action closure |

## Configurable automated rules

Geometry validity, minimum hole diameter, sheet hole/thickness ratio, external hole edge-web/thickness ratio, drilling depth/diameter ratio, bend radius/thickness ratio, supported flat development, required specifications and recorded verification notes. Default workshop thresholds are configurable starting values, not universal international design limits. Rule snapshots belong to revisions; changing project defaults affects later uploads.

Manual verification records cover strength/load cases/fatigue/stability; functional dimensions/datums/GD&T; thread specifications; process/tool access/stock/fixtures; assembly/fasteners/torque; coating thickness/masking/fit effects. Writing a note is an attestation by the engineer, not independent numerical validation by the program. In particular, the OMNI project's **1.5-ton statement does not determine wheel load distribution, structural factors, material grades, fatigue life or fit tolerances**.

## Drawing conventions

The template uses A3 sheets, a left binding margin, title/revision/status fields, millimetres, identified third-angle views and named features. It references the following international drawing standards as a design basis:

- [ISO 128-1:2020 — General principles of representation](https://www.iso.org/standard/65296.html)
- [ISO 5457:1999 — Sizes and layout of drawing sheets](https://www.iso.org/standard/29017.html), including applicable amendments
- [ISO 7200:2004 — Data fields in title blocks and document headers](https://www.iso.org/standard/35446.html)
- [ISO 129-1:2018 — Presentation of dimensions and tolerances](https://www.iso.org/standard/64007.html)

These references do not imply full standards compliance. Full normative requirements and your drawing authority's current standard editions must be checked before adopting a production template. There is no licensed full-standard rules engine, automatic ISO fits selection or automatic ISO GD&T certification.

Visible/hidden curves are projected from exact BREP geometry and sampled for PDF/DXF display. Envelope values are marked **REF**. Hole coordinate tables are in part-definition coordinates; they do not constitute a functional datum scheme. Review leaders for overlapping/coincident bores. The separate part STEP is the exact nominal solid, but it also lacks missing engineering intent.

## Release semantics

Draft documents are explicitly for engineering review. Release checks ensure recorded requirements are satisfied and documents regenerated; they do not prove the design can safely carry its load or that every needed dimension has been specified. Any manufacturer using these artifacts must be provided with complete approved detail definitions, process requirements and acceptance criteria. Advanced automated section/detail views, full tolerancing and semantic feature reconstruction remain extension work.

Released revisions preserve specifications and artifacts; comments and QC records can be added afterward. Archived links display their archived status and continue to reference the old version until expired/revoked. Engineering changes require another upload. Internally, owners/engineers can generate documents, including archived draft documents, without changing that revision's specifications. Released documents cannot be regenerated through the API.

## Performance

The viewer uses pre-tessellated GLB, GPU instancing, shared geometry, a bounded pixel ratio and an adaptive reduction when frame rate is low. Heavy CAD conversion stays in the worker. FPS is measured on the current device. Sixty fps is a target, not a guarantee on every GPU, browser, viewport and assembly. Mesh measurement is approximate; exact recognized feature values and approved drawing dimensions are used for inspection.
