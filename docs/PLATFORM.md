# Forge platform: sign-in, roles, projects, templates, job orders

## Sign-in (Microsoft Entra ID)

1. `az login` as a tenant admin, then `scripts/entra-register.sh --url https://forge.goat-robotics.com`.
   The script creates a single-tenant app registration (redirect `…/api/auth/entra/callback`), a client secret, and writes
   `AUTH_MICROSOFT_ENTRA_ID_ID/_SECRET/_ISSUER` and `FORGE_SECRET` into `.env`.
2. Set `PUBLIC_URL`, `COOKIE_SECURE=true`, `ADMIN_EMAILS=naveen@goat-robotics.com` and restart.

For the local Mac, run `scripts/entra-register.sh --url https://naveen.local:8443` and set
`PUBLIC_URL=http://localhost:8100`, `PUBLIC_URLS=https://naveen.local:8443`,
`COOKIE_SECURE=false`, and `ADMIN_EMAILS=naveen@goat-robotics.com` in the ignored `.env`.
Create the local certificate with
`mkdir -p local-certs && mkcert -cert-file local-certs/naveen.local.pem -key-file local-certs/naveen.local-key.pem naveen.local`,
then start with `docker compose --profile local-domain up -d --build`.
Forge uses Secure sign-in cookies on the HTTPS address while keeping HTTP localhost usable.
The local domain uses port 8443 because another service already occupies port 443.

Rules enforced by the server (authorization-code flow with PKCE, ID token signature/issuer/audience/nonce checked):

- only tokens from the configured tenant; guest (B2B) accounts are refused;
- only e-mail domains in `ALLOWED_EMAIL_DOMAINS` (default `goat-robotics.com`) — checked at sign-in **and** on every request;
- identity is the Entra object id; an e-mail only links a pre-created account that has no object id yet;
- `ADMIN_EMAILS` become administrators; otherwise the first person to sign in does; others get `DEFAULT_ROLE` (viewer);
- password sign-in is disabled once Entra is configured (`FORGE_ALLOW_LOCAL_LOGIN=true` for break-glass only).

## Roles

| Role | Can |
|---|---|
| Administrator | everything, including people and roles |
| Design engineer | projects, uploads, specifications, joints, drawings, reviews, release, job orders, templates, CAD downloads, vendor links |
| Design reviewer | arrange drawings, mark drawings reviewed, record design reviews |
| Production planner | create job orders, record progress and QC |
| Shop floor operator | record job-order progress |
| Quality inspector | record QC and job-order progress |
| Viewer | read only |

A project member can have a different role inside that project (Project settings → Team). Vendor links are always
read-only: no comments, no production marks; DXF/STEP only if the link was created with *Allow DXF/STEP downloads*.
The permission matrix is on Administration.

## 3D models and CAD files

GLB meshes have no download endpoint. The viewer requests a ticket (`/api/model-ticket`), which returns a URL valid for
two minutes, HMAC-signed and bound to the requesting session or vendor link, and a one-off key. The stream is AES-GCM
encrypted, `no-store`, and decrypted in memory by the browser. STEP, DXF and the ZIP pack require the *CAD download*
permission and every download is written to the audit log. (Anything a browser can display can in principle be captured
by that user; these controls stop direct links, link sharing, caching and casual saving.)

## Projects

*New project* collects, once: name and code (job orders are numbered `CODE-JO-001`), part-number prefixes, drawing
conventions (ISO/ASME, first/third-angle projection, default sheet size, hole-table mode, general tolerance), title
block, rule library, default process and drawing templates per part type, and project members. Settings apply to the
next upload and drawing generation (*Re-run classification* re-applies naming rules to the current revision).

## Templates

- **Process templates** — a routing such as Laser cut → Deburr → CNC bend → Powder coat → Final inspection (step kind:
  process, inspection, outsourced, assembly; station; standard minutes). A part follows exactly one template; applying it
  copies the steps into the part's routing, so later template edits never change a released part silently.
- **Drawing templates** — sheet size (A4/A3/A2/auto) and hole dimensioning (callouts / tagged hole table). Set per part
  in the part's Documents tab or from the drawing editor's bottom sheet bar; the drawing regenerates.

## From design to production ready

Per part: rule findings covered (value or written disposition), **design review** (specification) and **drawing review**
(open the editor, arrange views/callouts/details, *Mark reviewed*; any later edit or regeneration reopens it). The Design
checks tab groups everything by part. When every part is clear, *Production readiness → Mark production ready* locks the
revision and generates the final pack.

## Joints and welds

Ctrl/Cmd-click two or more parts (navigator or 3D view) → *Define joint / weld*: weld process (ISO 4063 numbers), type,
size, length/pitch, sides, filler, finish, quality level, field weld; or bolted/PEM/rivet/press-fit/adhesive with
fasteners and torque. *Pick faces in 3D* identifies the exact B-rep face (type, area, normal/radius) under each click.
Joints become assembly steps in job orders.

## Job orders

Only on a production-ready revision. A job order (title, requirement, build quantity, due date, priority, customer,
optional per-part quantities) generates:

- a process checklist per part (its routing × required count),
- procurement lines for purchased parts,
- assembly lines for every joint.

People with job-order access record counts (+1, all, or an exact count with rejects, a note and the date/time it
happened). A part cannot pass a step more often than the step before it. *Report a problem* blocks the step and posts a
comment on the design revision (Review tab, dashboard *Shop-floor issues*). The dashboard shows job-order progress,
overdue orders, today's recorded units, design readiness per project and recent shop-floor activity.
