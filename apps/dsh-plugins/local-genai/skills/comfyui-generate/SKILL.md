---
name: comfyui-generate
description: Execute a validated workflow once through the managed controller and recover its actual saved media.
---
Input: fixed production, current revision and validated workflow. Output: owned run and prompt identity, actual readable media, hashes, settings, status and any measured duration. The Controller alone manages GPU handoff, admission, tracking, release and cleanup; never bypass it with raw HTTP, shells or model load/unload.

Follow the next tool and its saved arguments from preparation. For official MOSS/Qwen, local_prepared_render uses the immutable draft settings. Prepare a new draft to change them and bind any adopted PE result first. For legacy profiles, add the supported settings to local_production_render. The enhancer defaults to false. Read the classified preflight issue and field before retrying.

Do not submit twice after a timeout or uncertain response: retain request/run/prompt identity and reconcile that same operation. Stop for unknown submission, cleanup or cancellation; do not stop other jobs. Reopen an owned result with local_render_result, never regenerate to display it. Check actual output exists and is readable; report missing/corrupt output as technical failure. Preserve input and prior runs. Record returned seed, model, workflow, settings and measured duration; do not invent unobserved facts. Check the live catalog for video availability; generated video requires its durable MP4 and sampled frames.

Use local_render_reconcile with the exact production and request IDs for an uncertain prepared render or a legacy render supported by that tool's current description; it does not submit a job. A verified rejected request was not accepted. An unknown or still-started request remains unresolved even if no run is found. Observe termination and GPU cleanup separately from the acceptance or rejection of a stop request.
