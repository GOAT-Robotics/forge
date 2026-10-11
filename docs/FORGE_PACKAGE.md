# Forge package (`.forge`) — CAD interchange format, version 1

A `.forge` file is how a CAD system hands Forge everything a neutral STEP file cannot carry: tapped holes and
cosmetic threads, sheet-metal parameters, material, part properties, the assembly tree with fasteners and
press-in inserts. Geometry stays in open STEP; the package only adds a JSON layer next to it. A plain STEP upload
keeps working — a package is the same import with less for the engineer to type.

Forge never infers threads from hole diameters. A package is accepted because every specification in it was set by
the designer in their CAD features; Forge applies it, marks it **from CAD**, and the engineer can still change it.

Exporters: `tools/solidworks/forge_export.py` (SolidWorks, Windows, uses the seat's own API). Forge also builds a
package itself from a native `.sldprt` upload with its own SolidWorks reader (`backend/app/native.py`, `backend/app/swread`).
Other CAD systems that expose hole, thread and sheet-metal features through an API (Onshape, Fusion 360, Inventor,
FreeCAD) can write the same package.

## Container

A ZIP archive (deflate or stored), extension `.forge`:

```
GT400.forge
├── manifest.json          required  package metadata, model reference, generator
├── model.step             required  STEP AP214 (AP203/AP242 accepted); whole assembly, parts in their own frames
│                                    (packages Forge builds itself from a native part may carry model.brep instead)
├── assembly.json          optional  component tree, fasteners, inserts (assemblies only)
├── parts/<part-id>.json   optional  one file per part document / configuration
└── previews/<part-id>.png optional  thumbnails (≤ 512 px, ≤ 200 kB each)
```

Member names are relative, lower-case extensions, no directories other than `parts/` and `previews/`. Anything
else is ignored. `<part-id>` is `[a-z0-9][a-z0-9._-]{0,79}`. Limits: ≤ 20 000 parts, ≤ 5 000 holes per part,
≤ 20 MB per JSON file; `model.step` is subject to the normal upload limit.

Units are millimetres and degrees everywhere. Coordinates in a part file are in that part's own coordinate
system — the same frame as that part's shape in `model.step`. Transforms are 4 × 4 row-major matrices
(`[r00 r01 r02 tx r10 … 0 0 0 1]`, 16 numbers) mapping part coordinates into root coordinates.

## manifest.json

```json
{
  "schema": "forge-package/1",
  "generator": {"name": "forge-solidworks-exporter", "version": "0.1.0"},
  "source": {"cad": "SolidWorks", "version": "2024 SP3", "file": "GT400.SLDASM", "kind": "assembly"},
  "created": "2026-10-09T08:30:00Z",
  "units": "mm",
  "model": {"path": "model.step", "format": "step-ap214", "sha256": "…"},
  "root": "gt400"
}
```

- `schema` — exactly `forge-package/1`.
- `source.file` — file name only, never a path. `source.kind` — `part` or `assembly`.
- `model.sha256` — of the STEP member; a mismatch is reported, not fatal.
- `root` — id of the top-level document: the part id for a part export, free text for an assembly.

Forge sanitizes `model.step` exactly like a direct STEP upload (header, authoring-system names, users, paths).

## parts/<part-id>.json

```json
{
  "id": "gt-sm-046-smps-plate",
  "name": "GT-SM-046 SMPS PLATE",
  "file": "GT-SM-046 SMPS PLATE.SLDPRT",
  "configuration": "Default",
  "step_names": ["GT-SM-046 SMPS PLATE"],
  "part_number": "GT-SM-046",
  "description": "SMPS mounting plate",
  "revision": "B",
  "properties": {"Finish": "Powder coat RAL 9005", "Vendor": "In-house"},
  "material": "AISI 304",
  "density": 8.0,
  "mass_kg": 0.412,
  "volume_mm3": 51500.0,
  "bbox": [220.0, 140.0, 22.0],
  "bodies": 1,
  "sheet_metal": {
    "thickness": 2.0, "bend_radius": 2.0, "k_factor": 0.42, "bend_allowance": null, "bend_deduction": null,
    "flat_pattern": true, "flat_size": [262.3, 140.0],
    "bends": [{"feature": "Edge-Flange1", "angle": 90.0, "radius": 2.0, "direction": "up", "k_factor": 0.42}]
  },
  "holes": [
    {"id": "h1", "feature": "M5 Tapped Hole1", "kind": "tap", "standard": "ISO", "fastener": "M5",
     "thread": "M5x0.8", "thread_class": "6H", "thread_depth": 10.0, "thread_through": false,
     "diameter": 4.2, "depth": 12.0, "through": false,
     "counterbore": null, "countersink": null,
     "point": [40.0, 25.0, 22.0], "direction": [0.0, 0.0, -1.0], "face": "forge:h1"}
  ],
  "welds": [{"feature": "Weld Bead1", "type": "fillet", "size": 4.0, "length": 120.0}]
}
```

- `name` — display name; the exporter strips CAD noise (virtual-component suffixes, mirror prefixes). `step_names`
  lists the product names the CAD system wrote into `model.step` for this document so Forge can match the two;
  Forge also matches by cleaned name, then by bounding box + volume, then by hole signature.
- `density` in g/cm³. `bbox` is the axis-aligned size in part coordinates; `volume_mm3` the solid volume (all bodies).
- `color` — optional `#RRGGBB` appearance of the part; used when the STEP carries no colour.
- `sheet_metal` only for sheet-metal parts. `k_factor` is the value the designer set (bend allowance / deduction
  are given instead when that is how the feature is defined). `flat_pattern: false` means the CAD system could not
  unfold the part.
- `holes[]` — one entry per hole **instance** (a pattern of four tapped holes is four entries).
  - `kind`: `tap` (tapped / threaded hole), `clearance`, `counterbore`, `countersink`, `dowel`, `simple`,
    `cosmetic_thread` (a cosmetic thread applied to a plain hole), `thread` (modelled thread feature).
  - `thread`: metric `M<d>x<pitch>` (`M5x0.8`), imperial `#10-32`, `1/4-20`, `5/16-18`. `thread_class` optional
    (`6H`, `2B`). `thread_depth` in mm from the entry face, `thread_through` when the thread runs through.
  - `diameter` — the modelled hole (for taps the tap drill). `depth` — modelled hole depth; `through` when it exits.
  - `counterbore {diameter, depth}` and `countersink {diameter, angle}` describe the mouth when present.
  - `point` — entry point on the face the hole starts from; `direction` — unit vector into the material.
  - `face` — reserved: a name the exporter gave the hole's cylindrical face in `model.step` (`ADVANCED_FACE`
    name). Forge 1 links holes geometrically (below) and ignores it.
- `unplaced_threads[]` — optional: threads the writer knows (size, depth, count) but cannot place because the
  feature's face reference is lost (cosmetic threads on mirrored or derived bodies, which the native decoder
  cannot trace). Each entry: `feature`, `thread`, `diameter` (major), `thread_depth`, `thread_through`. Forge
  puts them on the bores of the thread's tap-drill size (major − pitch, ±0.15 mm; then the major diameter, for
  holes modelled at nominal) **only when the number of such bores equals the number of entries for that thread**;
  otherwise they are reported as unmatched. Placements are flagged in the part notes and the import summary.
- `welds[]` — pass-through for now (shown, not applied).

## assembly.json

```json
{
  "name": "GT400", "configuration": "Default",
  "components": [
    {"id": "c12", "part": "gt-sm-046-smps-plate", "name": "GT-SM-046 SMPS PLATE", "instance": "GT-SM-046 SMPS PLATE-1",
     "path": "GT400 / SMPS MODULE-1 / GT-SM-046 SMPS PLATE-1", "configuration": "Default",
     "transform": [1,0,0,120.0, 0,1,0,40.0, 0,0,1,0, 0,0,0,1],
     "suppressed": false, "exclude_from_bom": false, "virtual": false, "fixed": false, "mirrored": false}
  ],
  "fasteners": [
    {"id": "f1", "kind": "screw", "standard": "ISO 4762", "size": "M5", "length": 12.0, "name": "ISO 4762 M5 x 12",
     "path": "GT400 / SMPS MODULE-1 / socket head cap screw_iso-3", "transform": [ … ]}
  ],
  "inserts": [
    {"id": "i1", "type": "nut", "thread": "M3", "pn": "S-M3-1", "name": "PEM S-M3-1", "host": "gt-sm-046-smps-plate",
     "path": "GT400 / SMPS MODULE-1 / S-M3-1-4", "transform": [ … ], "axis": [0,0,1]}
  ]
}
```

- `components` is the flat list of every leaf occurrence (sub-assemblies appear only in `path`). `transform` maps
  the part's coordinates into the root's. Suppressed components are listed so counts reconcile but carry no geometry.
- `fasteners` — Toolbox / library fasteners the designer placed: `kind` in `screw`, `bolt`, `nut`, `washer`,
  `rivet`, `pin`, `other`; `standard`, `size`, `length`, `name` as the library gives them.
- `inserts` — press-in / self-clinching hardware placed as components: `type` in `nut`, `flush_nut`, `stud`,
  `standoff`, `rivnut`, `weld_nut`; `thread`; `pn` (supplier part number, e.g. PEM `S-M3-1`); `axis` is the
  insert's axis in root coordinates; `host` the part it is pressed into when the exporter knows it. Forge matches an
  insert to the hole whose axis passes through its origin and assigns the matching catalogue hardware.

## What Forge applies

| Package data | Effect in Forge |
|---|---|
| `holes[].kind = tap / cosmetic_thread / thread` | Hole hardware **Tap** on the matched hole (catalogue item when the thread is known, custom tap otherwise), drawing callout `M5 X 0.8 - 6H THRU` / `↧ 10`, flat DXF cuts the tap drill. Marked *from CAD*; engineer-set hardware on that hole is never overwritten. |
| `unplaced_threads[]` | Same tap hardware, on the bores of the tap-drill size when the count is unambiguous; noted as *placed by tap-drill size* for confirmation. |
| `counterbore`, `countersink` | Already in the STEP geometry; Forge reads them from the shape. Used only for cross-checks. |
| `sheet_metal.k_factor` | Part K-factor pre-filled (still needs the engineering approval). Thickness mismatch > 0.1 mm is reported. |
| `material`, `properties.Finish` (or `Surface finish`), `description` | Pre-filled where the specification is still empty. |
| `part_number`, `revision`, `configuration`, `mass_kg`, `properties` | Shown with the part ("From CAD"). |
| `inserts[]` | Hole hardware (nut / stud / standoff / rivnut / weld nut) on the hole the insert sits in. |
| `fasteners[]`, `welds[]` | Stored with the revision; counted in the import summary. Assembly-step pre-fill is planned. |

Unmatched holes or inserts never fail the import: they are listed in the import summary so the engineer can set
them by hand.

## Matching rules (how Forge links JSON to geometry)

1. Package part → Forge part: `name` / `step_names` / file stem / `id` against the cleaned STEP product name →
   bounding box (±0.5 %) + volume (±1 %) → hole signature (sorted diameters); the fallbacks only count when they
   are unique. Multi-body parts: every body of the part is a candidate; holes land on the body whose geometry
   contains them.
2. Package hole → geometric hole: same diameter (±0.03 mm or ±0.5 %), parallel axis (cos ≥ 0.9995), `point` within
   0.1 mm of the axis line and within the bore's axial span (±1 mm). If nothing matches in the part frame, the
   component transforms from `assembly.json` are tried (for STEP writers that flatten the assembly).
3. Insert → hole: insert origin within 0.15 mm of a hole axis, inside its span (±2 mm); sheet-metal parts preferred.

## Versioning

`schema` is bumped only for incompatible changes. Forge ignores unknown keys, so exporters may add data freely under
the same schema version. Reference JSON Schema: `docs/forge-package.schema.json`.
