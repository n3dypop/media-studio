---
name: output-review
description: Review actual image or video output against saved criteria, distinguishing met, unmet and unverified.
---
Input: actual delivered media and the saved brief. Output: an evaluation for every exact saved criterion as met, unmet or unverified, with evidence, strengths and decision. Review the actual image, not a prompt or success flag. Separate technical facts from visual judgment; mark inaccessible or uncertain observations unverified. Preserve what works and identify locations and severity of defects.

Inspect the image delivered in the current turn. If a run has completed and its image is absent from this turn, reopen the saved result with local_render_result(productionId). For one visible image candidate, call local_production_evaluate with criteria and decision. The tool resolves the production, run and image from the current turn and checks the live revision. With multiple candidates, identify the intended production and, when needed, the exact image hash. Use local_production_history for earlier decisions. local_asset_view is for input or reference images.

Use the saved criteria returned with the actual result, each exact ID once; do not invent, rename or approximate one. If rejected, use the saved list in the diagnostic. A missing criterion is not automatically unverified; submit unverified explicitly with its reason. If any required part of a criterion is unknown, the criterion is unverified. complete requires every criterion met; otherwise use needs_user when evidence or the user's decision is needed, or revise only for a specific justified change. A single image cannot prove a person is fictional or dissimilar to all real people.

executionEvidence distinguishes submitted request, SHA-verified output bytes/dimensions and Comfy history. Submitted settings alone do not prove execution; historyGraph exists only when the saved graph matches verified history and is not an independent numerical GPU measurement. Alpha evidence proves a channel or non-opaque pixels, not a correct cutout. If evidence is absent, do not invent it; older runs may leave execution settings unverified. Use details=true for omitted planning or diagnostic data.

For MP4 inspect all three actually delivered sampled frames and retain exact frame/video hashes. Frames cannot establish the full clip, motion, flicker, camera or audio; mark unseen criteria unverified and use needs_user. Do not claim automatic acceptance proves user satisfaction. The best candidate may differ from the latest; select only on evidence and preserve prior outputs.

Present the actual image, visible compliance and meaningful unverified points concisely, asking only for the user's selection or desired changes. Do not list internal production/run/criterion IDs, hashes or old RAM/VRAM unless requested or needed to explain a specific failure; evidence remains saved. A fictional prompt or user approval is not proof of identity or non-similarity; do not ask the user to certify those facts.

If evaluation recording is uncertain and local_production_action_reconcile is available, read the same production/request with operation=evaluate; do not submit the evaluation again. A rejected record is not an evaluation, and absent or started evidence stays unresolved.
