# STEP-linked drawing editor

Open a part's **Documents → Drawing sheet** after generating its documents. Old drawings must be generated once to create the vector scene. Other PDF types retain the PDF preview.

- Select and drag a view; its dimensions, attached callouts and leader targets follow.
- Select and drag a callout; its leader stays attached to the source feature.
- Edit callout text, or use Thread specification / Fit and press-fit note. Thread depth, pitch, tolerance class and fit are explicit user decisions. The inspector retains read-only source measurements beside the override.
- Add, move and delete notes. Undo/redo operates within the editing session. Reset returns a callout or view to its generated state.
- Save persists the edit in the revision and updates the part PDF. Export PDF saves pending changes first. Full document generation incorporates the edits in combined PDFs and the manufacturing pack.

The original STEP/BREP, measured dimensions, feature IDs, inspection limits and manufacturing specifications are unchanged by presentation edits. Source measurements can be reviewed in the inspector. Raw cylindrical face IDs remain in the engineering/QC data even when several faces form one displayed hole feature.

## Geometry interpretation

Coaxial cylindrical lands connected directly or by internal conical faces form one physical hole feature. Disconnected holes remain separate. Matching features receive quantity callouts. Stepped bores list their steps within that callout; entrance cones give diameter, included angle and near/far side. Drill tips are not entrance chamfers. THRU requires both axial ends to open outside the solid; blind depths report the cylindrical portion, not inferred thread depth.

Neutral geometry does not establish M6, 6H, H7, a press fit, or a thread depth. The thread/fit controls create explicit annotation overrides; they do not infer a specification from diameter. STEP PMI and cosmetic-thread metadata are not currently imported. Verify source anomalies and engineering intent before release.

## Persistence and permissions

`drawing-scene.json` is generated from the source with a content hash. `drawing_edits` stores presentation overrides keyed to part/revision/source hash, plus an optimistic version. Concurrent stale saves return 409. Writes require engineer/owner access, CSRF verification, an active ready revision, and no running CAD job. Released, archived, vendor and viewer sessions cannot save.

Saving resets the part review flag and invalidates combined packs until full regeneration. Specification changes require regeneration before editing. Geometry exports (STEP/DXF) do not include freeform presentation overrides. Sections, detail-view creation, GD&T tools and full SolidWorks drafting parity are not included in this editor.

## GOAT template sheets (28 Sep 2026)

Drawing sheets are produced by `backend/app/sheet.py` in the GOAT SolidWorks A4 template layout: 1 mm trim + 6 mm frame with zones, GOAT title block, 0.25/0.18 mm line weights, 3.3 x 1.0 mm filled arrows, SolidWorks-style ordinate dimensions, third-angle views chosen from hole entry sides, isometric in the free corner, automatic A4/A3/A2 and scale. Each view (with its ordinates) is an editor `view` group; each hole callout / chamfer / radius note is a `callout` group with `style: goat` (shoulder leader; arrow stays on the feature). Sheet metal (laser cut) shows no hole locations or callouts; formed parts get a flat-pattern sheet with bend lines and a bend table. Threads are not inferred (see above) — use the editor's Thread specification or a feature designation.

`drawing.dxf` is the same sheet 1:1: ORDINATE DIMENSION entities with DIMLFAC = 1/scale (they read true size), MTEXT callouts (gdt.shx symbols), title block TEXT. Editor presentation edits are not written to the DXF. The specification / rule record / bend schedule moved to `review.pdf`. Title block defaults live in Workspace settings → Drawing title block.

## Sheets, detail views and review

- **Sheets** (left): click to open, drag to reorder the PDF. *New sheet* adds an empty A4/A3/A2 template sheet; select a
  view and pick another sheet under *Sheet* to move it there with its dimensions and callouts (e.g. to make room for detail
  views). Added sheets can be removed; their views go back. Title blocks renumber (SHEET n OF m) automatically.
  *Sheet template* switches this part to A4/A3/A2 or a drawing template and regenerates it.
- **Detail view** (ISO 128-3): press *Detail* and click a crowded area of a view. A circle and letter (I and O are not
  used) mark the area; the enlarged geometry is placed in free space on the sheet with its absolute scale, e.g.
  `DETAIL A (3:1)`. Drag the circle to choose the area, drag the enlargement to place it; change letter, enlargement
  (1.5–10×), radius or target sheet on the right.
- **Mark reviewed** saves the arrangement and records the drawing review (who/when). Saving further edits or regenerating
  the drawing reopens the review; release requires every drawing reviewed.

## Drawing text

Dimension and callout text is 1.8 mm (ISO 3098) in Barlow Semi Condensed; the editor loads the same font so the
screen matches the PDF. Dimension values sit on a white ground so no line runs through them. Where ordinate points are
closer than an arrowhead, dots replace arrowheads (ISO 129-1). Long hole tables go on their own sheet so the views stay
at a readable scale; tagged views move to a larger sheet when tagged holes would be closer than 3 mm on paper.
