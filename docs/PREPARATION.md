# Simple manufacturing preparation

The default workflow is **Prepare → answer missing details → review → release**.

- **Prepare** is available in the revision header, revision overview, individual part panel and selection panel.
  Opening it fills known CAD/project defaults and queues missing or stale drawings automatically.
- Missing manufacturing answers are grouped by part type and existing material. An answer fills empty values in
  that group; existing specifications stay intact. Users can inspect the affected part names before saving.
- Known project general tolerances and existing routing operations are reused. Unknown material, process,
  finish and measurement datums require a choice; the preparation action does not guess them.
- Only unresolved manufacturing findings are shown. A user can inspect the affected part, fix the source CAD,
  or record a reason accepting its warnings where appropriate.
- One explicit engineering review note covers loads, dimensions/fits, threads, tooling, assembly and coating for
  eligible parts. The prepared values remain available for inspection. Bend allowance approval appears only
  when needed. Existing reviewer permissions and release rules still apply.
- Drawings open in a simple PDF preview. The drawing approval action becomes available after opening the drawing;
  generation clears that opened state. The full drawing editor remains available from the part's Documents tab.
- When the whole revision is ready, **Review & release** opens the existing final release action. Preparation
  does not release a revision or manufacture an engineering/drawing approval automatically.
- Detailed engineering review, individual checks, overrides and bulk controls remain available through Advanced
  and the part's More actions menu. Part settings and detailed readiness indicators are collapsed by default.

Preparation skips purchased, other and excluded parts. It validates every requested part before applying any
answer, refuses archived/released revisions or concurrent CAD jobs, and regenerates only missing/stale drawings.
Repeating preparation with current documents and unchanged specifications preserves existing approvals and
queues no new work. Changed specifications invalidate approvals and drawings through the existing rules.

Validation on 28 October 2026: full backend suite **121 passed, 1 skipped**; frontend production build passed.
Browser verification used a synthetic native SolidWorks fixture in an isolated temporary database: Prepare,
missing answers, generation, a single engineering review, PDF preview, drawing approval and final release dialog.
No production data was changed or deployed. The optional real SolidWorks sample test remains skipped.
