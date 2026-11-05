---
name: comfyui-generate
description: Execute a validated workflow once through the managed controller and recover its actual saved media.
---
Input: fixed production, current revision and validated workflow. Output: owned run and prompt identity, actual readable media, hashes, settings, status and any measured duration. The Controller alone manages GPU handoff, admission, tracking, release and cleanup; never bypass it with raw HTTP, shells or model load/unload.

For official MOSS/Qwen use local_prepared_render with productionId, expectedRevision and workflowId. It derives exact settings from the immutable draft: never retype them or pass an enhancer flag. Change settings only by preparing a new draft; an adopted PE result must already be bound. For legacy profiles use local_production_render with the supported parameters and enhancer=false unless a configured enhancer is justified. Read preflightDiagnostic by its classified issue/field; do not mistake a mismatch for a missing model or retry unchanged.

Do not submit twice after a timeout or uncertain response: retain request/run/prompt identity and reconcile that same operation. Stop for unknown submission, cleanup or cancellation; do not stop other jobs. Reopen an owned result with local_render_result, never regenerate to display it. Check actual output exists and is readable; report missing/corrupt output as technical failure. Preserve input and prior runs. Record returned seed, model, workflow, settings and measured duration; do not invent unobserved facts. Check the live catalog for video availability; generated video requires its durable MP4 and sampled frames.
