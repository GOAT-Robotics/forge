# Module map

| Path | Responsibility |
|---|---|
| `frontend/src/main.tsx` | Projects, versions, part/spec editor, rule review, mating records, vendor access, QC, history |
| `frontend/src/components.tsx` | Shared UI: modal, PDF preview (pdf.js), 2D flat-pattern SVG view, structured manufacturing specification editor |
| `frontend/src/controls.tsx` | Custom Select and Combo (suggestions) controls with portal popovers — replaces native select/datalist so dropdowns match the app on every OS |
| `frontend/src/constants.ts` | Category colours, RAL colour table, datalist suggestions for materials/processes/finishes |
| `frontend/src/Viewer.tsx` | Three.js GLB viewer, instancing, hover/click picking, fly-to selection, ghosting/isolation, animated explosion, section and measurement |
| `backend/app/main.py` | HTTP API, state transitions, permissions, input checks and exports |
| `backend/app/security.py` | Password hashing, sessions, CSRF header checks, scoped vendor tokens |
| `backend/app/db.py` | SQLite schema, defaults and audit events |
| `backend/app/cad.py` | OpenCascade import, feature analysis, tessellation and hidden-line projections |
| `backend/app/unfold.py` | Conservative developable-sheet flattening and rejection checks |
| `backend/app/rules.py` | Configurable geometric rules, manual verification and public standards references |
| `backend/app/drawings.py` | PDF/DXF part sheets, feature schedules, assembly/mating illustrations |
| `backend/app/worker.py` | Persisted import/document jobs, activation/archival, releases and ZIP packaging |
| `backend/tests` | Synthetic CAD and revision/vendor/release/QC integration fixtures |

Data resides under `DATA_DIR`: `forge.sqlite` plus `revisions/<id>`. Each revision retains the original uploaded neutral file and hash, component instances, assembly GLB and per-body BREP/GLB/derived artifacts. Each upload has its own specifications and workshop-rule snapshot. Mutable specifications invalidate affected documents. Do not edit the data directory manually in a live installation.

Extension priorities for production drafting are semantic PMI ingestion, section/detail views and datum/GD&T tools, engineer-authored drawing overrides, generalized mating/contact checks, calibrated material/process libraries, more sheet topologies and automated regression fixtures from approved shop parts. Identity/operations extensions include SSO/MFA, explicit team project ACLs, centralized observability, schema migrations and tested disaster recovery. Add these behind the existing revision/release contract; do not silently reuse old approvals for modified geometry.
