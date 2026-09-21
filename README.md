# Forge Manufacturing

Self-hosted CAD-to-manufacturing workspace. Create projects, version neutral CAD files, review inferred manufacturing features, document engineering decisions, generate PDF/DXF packages, coordinate vendors, and record production QC against released specifications.

## Start

```sh
docker compose up -d --build
```

Open **http://localhost:8100** and create the workspace owner account. No default production password is installed. Docker Compose starts the web/API service and a separate CAD worker, with a persistent `forge-manufacturing_forge-data` volume. The default port is loopback-only. Stop with `docker compose stop`; resume with `docker compose up -d`. Do not use `down -v` unless you intend to delete the database and all uploaded/generated files.

The supplied OMNI STEP has been imported into the local installation. A fresh installation starts empty. Project data is not embedded in the Docker image or source repository.

## Workflow

1. **Create a project and upload** `.step`, `.stp`, `.brep`, `.brp`, `.igs` or `.iges`. Assemblies retain their source component placements and occurrence quantities; multi-solid components split into body records. Native proprietary CAD files must first be exported to a supported neutral format.
2. **Inspect and classify.** Navigate the whole assembly, click parts in the 3D view or the navigator (the camera flies to the part, other bodies ghost out; double-click or *Isolate* hides them), orbit, section, animate the explosion, and measure approximate mesh distances. Parts are rendered in their specified coating colour; uncoated parts use a neutral tone per category. Sheet-metal parts have a 2D *Flat pattern* view (outline, cut-outs, bend lines with allowance) and a 3D developed view. Full cylindrical bores have `H001` labels; recognized bend pairs have `B001` labels. Make/buy and sheet/machining classification are suggestions that an engineer must review.
3. **Specify manufacturing.** Record material and raw stock, primary process and an ordered process sequence, finish, coating system, coating colour (RAL picker or custom hex), film thickness, masking, heat treatment, hardness, roughness, datums, general tolerances, edge treatment, marking, packaging, feature designations, inspection limits, notes, K factor and verification evidence. Record a justified N/A where a field does not apply. The program does not choose safety-critical materials or fits from geometry alone.
4. **Review rules and interfaces.** Each upload snapshots project workshop rules. Review automated findings and enter the required manual verification notes. Candidate coaxial bore/shaft interfaces show nominal clearance; approve explicit diameter limits, torque or justified N/A, and assembly instructions. Create additional mating records where detection does not cover the interface.
3a. **Workspace settings** (gear in the left rail): part-number prefixes for sheet metal, machining and (optionally) purchased items — with *strict* on, anything outside the prefixes is purchased; whether small bought-in items are hidden in the viewer by default; and whether specifications carry over between revisions.
4a. **Fix make/buy.** Name rules classify supplier downloads (`.stp`/`.STEP` names, catalogue words such as switch, relay, duct, terminal, lidar, camera, nut) as purchased and function-named parts (mount, plate, cover, bracket…) as custom. *Re-run classification* in the revision overview applies the current rules to every part an engineer has not classified yet. Select several parts in the navigator (click, Shift-click for a range, Ctrl/Cmd-click to toggle) and use the toolbar to set a category, hide/show, or mark not for production in one go.
4b. **Scope production.** Mark parts *Not for production* (with a reason) to leave them out of release checks, drawing sets and the vendor checklist; restore them any time on an active revision. Small bought-in items (terminal blocks, lidars, connectors, fasteners…) are hidden in the viewer by default — toggle any part's visibility with the eye icon in the navigator.
5. **Generate documents.** Generate selected-part PDFs/DXFs/STEPs from the part Documents tab, or the whole manufacturing pack from the revision overview. PDFs open in an in-app preview (zoom, page through) with a download button; DXF/STEP/ZIP download directly. A full pack also writes `machining-drawings.pdf` (every machined part) and `sheet-metal-drawings.pdf` (every sheet part with flat pattern, labelled bend lines and a bend table: angle, inside radius, UP/DOWN direction, allowance, line length), each with an index page. The worker runs independently of the viewer. Drafts are marked for engineering review. Regenerate after changing specifications.
6. **Share a revision.** Create an expiring, revocable vendor link. Vendors see that revision's model, specifications, documents, QC records and comments. They cannot change engineering specifications, release a revision or browse other projects. A link never silently changes to the latest revision. Localhost links work only on your computer; remote vendor access requires your own HTTPS deployment.
6b. **Production checklist.** The Production tab (also visible to vendors) lists every production part with a thumbnail, quantity, material, finish and colour, a drawing preview, and a *produced* tick with quantity done and remarks, recorded with author and time.
7. **Release.** All custom parts must be reviewed; required specifications, manual checks and mating approvals must be complete. Invalid solids and unsupported required sheet developments block release. Release generates the final pack and locks engineering edits. This records your engineering approval; it is not an independent certification of the design.
8. **Inspect.** Record serial/batch, feature, released limits, measured value, instrument, operator and notes. The server rejects limits different from the released specification and computes pass/fail. Export QC as CSV. Hole diameters, X/Y/Z envelopes and bend angles can carry inspection limits.
9. **Revise.** A new successful upload becomes active and archives the previous version. Manufacturing specifications (material, process sequence, finish, coating, tolerances…) plus hidden / not-for-production flags are carried from the active revision into the new one, matched by part name and then by shape; feature limits, verification notes and rule dispositions are carried only when the shape is identical, and every part returns to *review pending*. Parts show a *From rev N* badge. A failed upload leaves the previous revision active. Geometry/specification approvals are not carried across versions. Compare quantities and shape fingerprints; renamed and split parts need manual reconciliation.

## Outputs

- A3 PDF template with orthographic and isometric geometry, reference envelopes, named hole labels placed beside each bore with short non-crossing leaders (ID and diameter), hole identification maps, feature coordinates, bore diameters/axial lengths, manufacturing specifications (including coating colour swatch and process sequence) and release findings.
- Layered millimetre DXF drawing geometry and reference dimensions; per-part exact STEP export.
- Supported sheet developments: flat DXF with cut contours/bend lines, developed 3D preview and PDF flat + formed isometric.
- Assembly PDF: assembly view, mating schedule, individual two-body mating illustrations, fit limits, torque and method. Assembly DXF supplies vector pair views.
- ZIP pack with assembly/part documents, parts/specification data, mating records and revision metadata.
- QC CSV, review comments and an internal audit trail in the website.

**The output is an engineering drawing starting point, not automatic complete production detailing.** Feature patterns, GD&T, datum feature symbols, threads, counterbores, welds, functional dimensions, machining setups and full assembly sequence still need engineering verification or additional drafting. Curves in 2D DXFs are sampled at 0.025 mm deflection; these files are not validated CAM/toolpaths. Flat layouts are provisional until material/tooling allowance is approved and the development is checked. See [coverage and boundaries](docs/COVERAGE.md).

## Architecture and operation

React + Three.js frontend; FastAPI + SQLite WAL API; OpenCascade geometry worker; ezdxf + ReportLab outputs. No Redis, PostgreSQL or cloud CAD upload service. Fonts and frontend assets are bundled. The worker is necessarily heavier than the web service because a full CAD kernel is required.

The default deployment is **one API process and one worker**, on one host with a local persistent volume. Mutating HTTP requests are serialized; jobs are persisted and resumed after restart. Do not scale worker replicas: automatic running-job recovery assumes one worker. This is not a distributed job system or multi-tenant SaaS.

### Durable artifact storage

Set `S3_BUCKET`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY` to mirror every accepted source file and every completed generated artifact to an S3-compatible bucket. For DigitalOcean Spaces in SFO3, keep `S3_ENDPOINT=https://sfo3.digitaloceanspaces.com` and `S3_REGION=sfo3`. The service restores an absent artifact from the bucket on demand. The S3 key must be restricted to this bucket with read/write/delete access; do not put it in Git, a Docker image, or a GitHub Actions log.

Docker service limits: API 768 MB; worker 6 GB / 3 CPUs. Large CAD assemblies need adequate host RAM and disk. Configure `PORT`, `COOKIE_SECURE`, and `MAX_UPLOAD_MB` in `.env` using `.env.example`. Keep `COOKIE_SECURE=false` only for local HTTP. For remote use, put the app behind an HTTPS reverse proxy and set `COOKIE_SECURE=true`; configure your hostname and upload/time limits. Complete first-run owner setup before making the endpoint remotely reachable. No public deployment is performed by this project.

Authentication uses scrypt password hashes and HttpOnly same-site sessions. Owner can create engineer, QC and viewer accounts. Vendor links are bearer credentials stored as hashes on the server and expire/revoke by revision. This first release has no SSO, MFA, password-reset email or per-project internal team ACLs: signed-in team members can read all projects. Back up and operate accordingly.

## Backup

For a consistent complete backup, briefly stop **both** services and archive the named volume. Restart them afterward. The archive contains credentials, CAD, vendor access records and quality data; store it privately. The following commands create a timestamped local backup without deleting any source data:

```sh
mkdir -p backups
docker compose stop
docker run --rm --user 0 --entrypoint sh \
  -v forge-manufacturing_forge-data:/data:ro \
  -v "$PWD/backups:/backup" forge-manufacturing:local \
  -c 'tar -czf /backup/forge-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /data .'
docker compose up -d
```

Restore into a separate empty volume and validate before replacing a live installation. Never overwrite a live database with an old SQLite file while the app/worker are running.

## Development and verification

Python 3.13 and Node 22:

```sh
python3.13 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
(cd frontend && npm ci && npm run build)
PYTHONPATH=backend .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8100
# Separate terminal, same working directory:
PYTHONPATH=backend .venv/bin/python -m app.worker
# Isolated temporary test database and geometry fixtures:
PYTHONPATH=backend .venv/bin/python -m pytest backend/tests -q
```

See [validation record](docs/VALIDATION.md) for the tested models, workflow and performance limits. API documentation is at `/docs`. See [module map](docs/ARCHITECTURE.md) for extension points.

On this Mac, Docker Desktop's registry credential helper stalled during the initial build. The build succeeded with an isolated temporary configuration for public base images; existing Docker credentials were left unchanged. If that helper problem recurs, run `./scripts/build-public.sh` and then `docker compose up -d`. This optional helper is for this project's public-image build, not private registries. It respects the selected Docker endpoint and removes its temporary configuration afterward.
