# Forge

**A self-hosted workspace that turns a STEP assembly into manufacturing: drawings, flat patterns, weld setups, release control and shop-floor tracking.**

Upload a neutral CAD file, classify every part (machined, sheet metal, purchased), record how each one is made, and Forge produces the drawing set, sheet-metal developments and manufacturing pack. It then follows the parts through release, job orders and quality inspection. One revision-controlled record from design review to the shop floor, running on your own server.

Forge is built and used in production at [GOAT Robotics](https://goat-robotics.com) for its autonomous mobile robots.

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [How a project flows through Forge](#how-a-project-flows-through-forge)
- [Drawings](#drawings)
- [Architecture](#architecture)
- [Security model](#security-model)
- [Operations](#operations)
- [Development](#development)
- [Scope and limits](#scope-and-limits)
- [Contributing](#contributing)
- [License](#license)

---

## What it does

**CAD workspace**
- Imports STEP, IGES and BREP assemblies. Keeps the assembly tree, component placements, occurrence quantities and multi-body parts.
- Fast 3D viewer: part navigator with assembly hierarchy, category filters, isolate a part (or one instance of a multi-quantity part), ghosting, section, explode, measure and view cube.
- Classifies parts as machining, sheet metal or purchased from geometry and naming rules. Every suggestion is reviewed by an engineer, and sub-assemblies can be re-classified in one step.

**Manufacturing definition**
- Material, stock, process sequence, finish, coating (RAL picker), tolerances, datums, heat treatment, roughness, masking, marking and K-factor per part, or applied from reusable process templates.
- A step-by-step *Make production ready* walkthrough that asks the questions an engineer must answer before a part can be released.
- Rule checks (bend radius, flange length, hole-to-edge, …) with recorded waivers and manual verification items.

**Drawings and documents**
- GOAT-style A4/A3/A2 sheets: third- or first-angle views, ordinate dimensions, hole callouts or hole tables, chamfer and fillet notes, angled holes and sloped faces, pictorial views, a title block filled from your project settings.
- Sheet-metal flat patterns with bend lines, UP/DOWN bend table, outside heights and blank thickness. Flat DXF ready for laser cutting.
- A vector drawing editor: move views and callouts, add notes and detail views, switch hidden lines per view, set threads and fits, review and export PDF. Geometry stays linked to the STEP.
- Editable DXF with true-scale ordinate dimensions, per-part STEP, and a ZIP manufacturing pack.

**Welding and assembly**
- Weld studio: pick two faces on any parts (touching or with a gap), or let Forge find every seam between selected components. Filter by inside/outside side, see the bead in 3D, and get ISO 2553 symbols on the assembly drawing.
- Bolted, press-fit and other joints with torque, fit limits and assembly instructions.

**Release and production**
- Release gate: every custom part needs a complete specification, design review and drawing review before the revision can be released.
- Job orders with a per-part process checklist, deadlines with days remaining and schedule pace, hold and cancel reasons, and count corrections.
- Quality inspection against released limits, CSV export, a review thread and a full audit trail.
- Expiring, revocable, read-only vendor links scoped to one revision.

---

## Quick start

You need Docker with Compose v2 and about 8 GB of free RAM for the CAD worker.

```sh
git clone https://github.com/goat-robotics/forge.git
cd forge
cp .env.example .env
# Edit .env: set ALLOWED_EMAIL_DOMAINS and ADMIN_EMAILS for your organisation
docker compose up -d --build
```

Open **http://localhost:8100**.

- **Without Microsoft Entra ID**, the first visitor creates the administrator account with a password. Do this before the server is reachable from a network.
- **With Microsoft Entra ID**, run `scripts/entra-register.sh` (see [platform guide](docs/PLATFORM.md)). People then sign in with their organisation account, and the first one (or anyone in `ADMIN_EMAILS`) becomes administrator.

Two services start: the web/API service and a separate CAD worker. Data lives in the `forge-manufacturing_forge-data` Docker volume. Stop with `docker compose stop` and resume with `docker compose up -d`. **Never run `docker compose down -v` unless you mean to delete every project.**

The port is bound to `127.0.0.1` by default. For remote use, put Forge behind an HTTPS reverse proxy and set `COOKIE_SECURE=true` and `PUBLIC_URL`.

---

## Configuration

All settings are environment variables, read from `.env` by Docker Compose. See [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8100` | Local port (bound to loopback). |
| `PUBLIC_URL` | `http://localhost:8100` | External URL, used for sign-in redirects and links. |
| `COOKIE_SECURE` | `false` | Set `true` whenever Forge is served over HTTPS. |
| `FORGE_SECRET` | generated | Signs short-lived model links and sign-in state. If unset, a random secret is created in the data volume; set it explicitly (`openssl rand -hex 32`) when running more than one container. |
| `ALLOWED_EMAIL_DOMAINS` | — | Comma-separated e-mail domains allowed to sign in. Set this to your own domain. |
| `ADMIN_EMAILS` | — | Accounts that become administrators on first sign-in. |
| `DEFAULT_ROLE` | `viewer` | Role for other new accounts. |
| `AUTH_MICROSOFT_ENTRA_ID_ID` / `_SECRET` / `_ISSUER` | — | Microsoft Entra ID single-tenant sign-in. Filled by `scripts/entra-register.sh`. |
| `FORGE_ALLOW_LOCAL_LOGIN` | `false` | Keep password sign-in available as break-glass access once Entra is configured. |
| `MAX_UPLOAD_MB` | `1024` | Largest CAD upload. |
| `FORGE_DRAWING_WORKERS` | `3` | Parallel drawing-generation processes in the worker. |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | — | Optional S3-compatible mirror for uploads and generated files. |
| `CAD_EXECUTION_MODE` | `local` | `ephemeral` runs each CAD job on a short-lived DigitalOcean Droplet (see below). |

**Company details on drawings** (company name, drawn/checked/approved by, tolerance table, fits, general note) are set in the app under *Settings → Drawing*, not in the environment. Part-number prefixes, make/buy rules and workshop rules are per project.

---

## How a project flows through Forge

1. **Upload** a `.step`/`.stp`/`.iges`/`.igs`/`.brep`. Export native CAD (SolidWorks, Creo, Inventor, …) to STEP first. Assemblies keep their structure; multi-body parts become one record per body.
2. **Classify.** Review the suggested category of every part. Mark purchased items, hide small bought-in parts, and mark anything *Not for production* with a reason.
3. **Specify.** Fill in how each part is made, directly or with the *Make production ready* walkthrough. Apply process templates to many parts at once.
4. **Check.** Work through the rule findings and manual checks, and approve fits and joints. Configure welds in the weld studio.
5. **Generate documents.** Drawings, flat patterns, DXF, STEP and the manufacturing pack are produced by the worker in the background. Refine any drawing in the editor and mark it reviewed.
6. **Release.** When every part is production ready, *Release revision* locks engineering edits and produces the final pack.
7. **Produce.** Open job orders against the released revision, record progress per process step, and track the deadline.
8. **Inspect.** Record measurements against released limits. Forge computes pass/fail and keeps the record.
9. **Revise.** Upload the next revision. Specifications carry over by part name and shape; every part returns to review.

Details, roles and permissions are in the [platform guide](docs/PLATFORM.md).

---

## Drawings

Forge generates a starting drawing for every machined and sheet-metal part:

- **View selection:** the main view is the face with the largest area; long parts are laid along the sheet. Top, side and extra views are added where holes enter.
- **Dimensions:** ordinate dimensions from each view's bottom-left corner, hole positions, step edges, angled holes (entry point and drilling angle) and sloped faces.
- **Holes:** grouped callouts (Ø, depth, THRU, counterbore, countersink). Crowded views switch to a tagged hole table in CNC tool order.
- **Placement:** every label is placed with a collision map of views, dimensions, holes and other text. Sheet size and scale are chosen so nothing overlaps.
- **Sheet metal:** a formed views sheet plus a flat pattern sheet with the blank edge view and thickness, bend lines, a bend table and balloon tags tied to each bend line.
- **Never inferred:** thread size, thread class and fits are never guessed from geometry. They come only from what an engineer specifies.

The drawing editor is documented in [docs/DRAWING_EDITOR.md](docs/DRAWING_EDITOR.md). What is and is not covered automatically is in [docs/COVERAGE.md](docs/COVERAGE.md).

---

## Architecture

```
frontend/   React + TypeScript + Three.js (Vite)    workspace, viewer, weld studio, drawing editor
backend/    FastAPI + SQLite (WAL)                  API, auth, permissions, jobs
  app/cad.py, hole_features.py, unfold.py, seams.py   OpenCascade geometry: analysis, holes, flat patterns, weld seams
  app/sheet.py, drawing_scene.py, pictorials.py        drawing layout, editable vector scene, PDF/DXF output
  app/worker.py                                        CAD import and document generation worker
```

- **Geometry:** OpenCascade (OCP), trimesh and shapely. **Documents:** ReportLab (PDF) and ezdxf (DXF).
- **Services:** no Redis, PostgreSQL or cloud CAD service. One API process and one worker on a single host with a persistent volume. Jobs are persisted and resume after a restart.
- **Ephemeral CAD workers (optional):** with `CAD_EXECUTION_MODE=ephemeral` and DigitalOcean/Spaces credentials, each CAD job runs on a one-off Droplet that gets only expiring upload and download URLs, then is deleted.

The module map and extension points are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Security model

- Sign-in with Microsoft Entra ID (single tenant, no guests) or local passwords. Sessions are HttpOnly; access can be restricted to listed e-mail domains.
- Roles and per-project membership decide who can edit, review, release, download CAD or manage job orders.
- 3D models are streamed encrypted through short-lived, session-bound URLs and are not downloadable. STEP/DXF downloads need an explicit permission.
- Vendor links are read-only, scoped to one revision, expiring and revocable, and stored as hashes.
- Containers run read-only, with no Linux capabilities and `no-new-privileges`.

Report security issues privately to the maintainers (see [Contributing](#contributing)), not in public issues.

---

## Operations

**Backup.** Stop both services briefly and archive the volume:

```sh
mkdir -p backups
docker compose stop
docker run --rm --user 0 --entrypoint sh \
  -v forge-manufacturing_forge-data:/data:ro \
  -v "$PWD/backups:/backup" forge-manufacturing:local \
  -c 'tar -czf /backup/forge-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /data .'
docker compose up -d
```

The archive contains accounts, CAD, vendor links and quality records, so store it privately. Restore into a separate empty volume and validate it before replacing a live installation.

**Resources.** The API is limited to 768 MB. The worker is limited to 6 GB and 3 CPUs; large assemblies need that much RAM and disk.

**Do not scale workers.** Job recovery assumes exactly one worker.

---

## Development

Requirements: Python 3.13 and Node 22.

```sh
python3.13 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
(cd frontend && npm ci && npm run build)

# API
PYTHONPATH=backend .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8100
# Worker (second terminal)
PYTHONPATH=backend .venv/bin/python -m app.worker

# Tests (isolated temporary database and generated geometry fixtures)
PYTHONPATH=backend .venv/bin/python -m pytest backend/tests -q
# Type check the frontend
(cd frontend && npx tsc --noEmit -p .)
```

For frontend work, run `npm run dev` in `frontend/` alongside the API. Interactive API documentation is served at `/docs`.

---

## Scope and limits

Forge produces an **engineering starting point, not finished production detailing**. An engineer remains responsible for every released drawing.

- GD&T, datum feature symbols, functional dimensioning, machining setups and full assembly sequences still need drafting by an engineer.
- Flat patterns use the configured K-factor and are marked provisional until the allowance is approved for your tooling.
- DXF curves are sampled at 0.025 mm deflection; they are not validated CAM toolpaths.
- Classification, weld seams and fits are suggestions until reviewed.
- Release records your organisation's approval; it is not an independent certification of the design.

See [docs/COVERAGE.md](docs/COVERAGE.md) and [docs/VALIDATION.md](docs/VALIDATION.md).

---

## Contributing

Issues and pull requests are welcome.

1. Open an issue describing the problem or feature first, for anything larger than a small fix.
2. Keep changes focused, and add or update tests in `backend/tests`.
3. Run the backend tests and the frontend type check before opening a pull request.
4. Never commit customer CAD, generated drawings, credentials or `.env` files.

By contributing you agree that your contribution is licensed under the project license below, and that GOAT Robotics may also offer it under the commercial license.

---

## License

Forge is **dual-licensed**.

**1. GNU Affero General Public License v3.0 (AGPL-3.0)** — see [LICENSE](LICENSE).
You may use, study, modify and self-host Forge free of charge. If you modify Forge and let anyone use it over a network, including inside your company or as a hosted service, you must make your complete modified source code available to those users under the AGPL-3.0.

**2. Commercial license** from GOAT Robotics Private Limited.
For companies that do not want the AGPL obligations, or that sell, host or embed Forge as part of a paid product or service. The commercial license is offered on a revenue-share basis and includes:
- disclosure of your organisation's use of Forge;
- notice to GOAT Robotics of any modifications;
- contribution of those modifications back to the Forge project.

To ask about commercial licensing, contact **naveen@goat-robotics.com**.

We also ask every user, under either license, to tell us you use Forge and to send improvements upstream. It keeps the project useful for everyone.

"Forge" and the GOAT Robotics name and logo are not licensed for use in derived products without permission.
