# Validation record — 21 September 2026

## Automated tests

Eight tests pass locally and inside the Linux ARM64 Docker image:

1. Named bore diameter/position/external-edge web and flat-plate volume/contour agreement.
2. A 90-degree constant-thickness bracket with the expected K-factor bend allowance.
3. Thick block classified as machining rather than sheet.
4. Coaxial bushing/shaft candidate and PDF/DXF mating export; separated axial positions rejected.
5. STEP multi-body import and millimetre envelope preservation.
6. Double-curved shell rejected by the sheet unfolding engine.
7. Repeated XCAF component placements and local definition coordinates preserved.
8. Full authenticated workflow: initial setup, login/CSRF checks, import, vendor scope and comments, release requirements, direct release-bypass rejection, document availability during generation, locked released edits/documents, QC pass/fail and mismatched-limit rejection, QC CSV, failed upload preserving the active revision, successful upload archiving it, and revoked/cross-revision vendor access denial.

Tests use synthetic geometry and a separate temporary database. They do not establish production structural accuracy or all possible CAD topology behavior. One upstream Starlette/AnyIO deprecation warning remains; it does not fail the tests.

## Supplied OMNI assembly

- Source: `GT OMNI V2 FINAL VERSION.STEP`, approximately 254 MB.
- Imported 985 solid body definitions and 1,487 solid body occurrences; surface-only supplier geometry is also visible.
- 2,238 named cylindrical bores.
- Current **inferred** classification: 86 machining, 84 sheet-metal, 815 purchased. These counts are not an approved manufacturing BOM.
- Generated 170 custom-part drawing sets and 24 candidate mating interfaces.
- Pack contains 171 PDFs, 888 pages and 653 files, approximately 37 MB compressed.
- ZIP CRC check passed; all PDFs opened; all extracted text stayed within page bounds; all exported DXFs parsed and passed ezdxf's structural error audit.
- Representative wheel-mount hole maps, formed/flat clamp sheets, assembly overview and mating sheets were rendered and inspected visually. This is sample visual review, not manual approval of all 888 pages.
- Unsupported sheet topologies remain explicitly blocked; a supported development is still provisional until its material/tooling allowance is approved.

The example PDF and ZIP under `docs/examples` are draft engineering-review artifacts. The Docker workspace contains the same completed package. No real part has been signed off or released, and no production inspection was fabricated.

## Browser and runtime checks

Verified the running Docker site loads the real assembly, searches/selects parts, isolates a part in its own coordinates, exposes its generated downloads, and shows a supported developed sheet. Verified the scoped vendor view cannot navigate to the internal project list. Account setup is left for the user; no production owner password was installed.

At a 1280 × 800 viewport on this local macOS Codex browser, the displayed full-assembly frame rate was approximately 108–120 fps with 3,246,973 rendered triangles, including a checked orbit interaction. Individual and flat-part views also exceeded 60 fps in these spot checks. This is not a sustained benchmark or a guarantee for other hardware, browsers, viewport sizes or files. The viewer reports actual FPS and can reduce pixel ratio when slow.

Docker health checks pass. Both services use the persistent named volume, non-root runtime users, read-only root filesystems and loopback-only port binding. The web service remained responsive while the CAD worker generated the sample pack. The final build and tests were run using pinned Node 22.23.2 and Python 3.13.15 base-image tags.

## Remaining production qualification

Validate approved shop parts across your expected CAD exporters and feature families; reconcile part classification and all drawing dimensions; qualify bend allowances against actual tooling; verify the drawing template against your adopted standards; assess the robot's real load cases; and test backup restoration, authentication policy and remote HTTPS access before relying on this installation for controlled production.
