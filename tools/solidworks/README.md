# Forge exporter for SolidWorks

Writes a **`.forge` package** (STEP + the CAD feature data STEP cannot carry — see `docs/FORGE_PACKAGE.md`) from
a SolidWorks part or assembly, using the SolidWorks API of the seat it runs on. No MBD or other add-on licence is
needed; every SolidWorks seat includes the API.

**One run exports a whole assembly**: every component (each part file / configuration once), every placement,
Toolbox fasteners and press-in inserts. There is nothing to do part by part.

What Forge gets from the package that a plain STEP upload lacks:

- tapped holes and cosmetic threads → hole hardware **Tap** on the right bore, callout `M5 X 0.8 - 6H THRU` / `↧ 10`
- sheet-metal thickness, bend radius, K-factor → pre-filled (approval stays with the engineer)
- material, finish, part number, description, revision, mass
- Toolbox fasteners (counted; assembly-step pre-fill is planned) and press-in inserts (PEM nuts, studs, standoffs,
  rivnuts, weld nuts) → hole hardware on the hole the insert sits in

Everything is marked *from CAD* in Forge and can be changed there. Hardware the engineer already chose is never
overwritten by a re-import.

## Files

| File | Purpose |
|---|---|
| `forge_export.py` | the exporter (Python, pywin32 COM) |
| `ForgeExport.vba` | SolidWorks macro source: a toolbar button that exports the active document |
| `forge-export.example.json` | template for automatic upload to Forge after each export |

## Install (Windows, once per machine)

```
py -m pip install pywin32
```

Python 3.9 or newer; SolidWorks on the same machine (Standard is enough). Put `forge_export.py` in a folder such
as `C:\Forge\`.

## Use from the SolidWorks UI (the normal way)

1. Tools › Macro › New… → save as `C:\Forge\ForgeExport.swp` (same folder as the script). The VBA editor opens.
2. Replace the module's contents with `ForgeExport.vba`, save, close the editor.
3. Tools › Customize › Commands › **Macro** → drag *New Macro Button* onto a toolbar → pick `ForgeExport.swp`,
   method `main`, tooltip "Forge export".

Click the button with a part or assembly active: it saves if needed, then a console opens, reads the model, writes
`<document>.forge` next to it and shows it in Explorer (drag it into Forge › New revision). With a
`forge-export.json` next to the script (copy the example; a dedicated upload account with local login) it uploads
straight to the named project instead and prints the new revision number. Warnings — holes it could not read,
unloaded components — are printed in the same console.

## Use from the command line

```
py forge_export.py                                         → the document active in SolidWorks
py forge_export.py "C:\Models\GT400.SLDASM"               → C:\Models\GT400.forge (opens, exports, closes)
py forge_export.py "C:\Models\PLATE.SLDPRT" --out D:\x.forge
py forge_export.py "C:\Models\GT400.SLDASM" --probe        → lists features / holes found, writes nothing
py forge_export.py GT400.SLDASM --push https://forge.example.com --project GT400 --email ... --password ...
```

`--project` takes the project name or id. The first run performs `makepy` on the SolidWorks type library (a minute
or two); later runs are quick. If that step fails on a machine, add `--late`.

## First test on a real model

1. `--probe` on a part with a few known tapped holes. Each Hole Wizard feature should list as
   `-> tap M5x0.8 Ø4.20 at [x, y, z] (sketch)`. `(axis)` instead of `(sketch)` means the placement sketch could not
   be read; the hole still links in Forge (any point on the axis inside the bore does).
2. Export for real and upload. Forge's revision overview shows the **From CAD** card: parts linked, taps applied,
   and a list of anything that did not link. Open *Holes & hardware* on a part: taps show `from CAD · <feature>`.
3. For assemblies, compare the component count with the SolidWorks tree and check that PEM / Toolbox parts were
   recognised (`inserts`, `fasteners` in the summary). Recognition is by name and description; adjust
   `INSERT_PATTERNS` / `FASTENER_WORDS` in the script for your library's naming.

## What is not exported (yet)

- Modelled `Thread` features (SolidWorks 2016+ helical cut threads): use a Hole Wizard tapped hole or a cosmetic
  thread instead; Forge reads geometry only for these.
- Weld beads: listed per part, not applied.
- Bend direction (up/down) and flat-pattern size.
- Configurations not referenced by an assembly occurrence (a standalone part exports its active configuration).

## Conventions

- Units: mm and degrees in the package (the API works in metres and radians; the script converts).
- Hole `point` is the entry point on the face the hole starts from, `direction` points into the material.
- Component `transform` is a 4 × 4 row-major matrix, part → root coordinates, built from `IMathTransform.ArrayData`
  (SolidWorks' row-vector convention transposed).
- Package part ids are slugs of the part file name (plus the configuration when it is not the default).
