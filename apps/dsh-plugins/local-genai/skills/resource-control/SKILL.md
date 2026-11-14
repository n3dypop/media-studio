---
name: resource-control
description: Use the controller-owned GPU lease and observable resource state; respect ownership, cancellation and uncertainty.
---
Use local_workflow_catalog for model/size limits and local_resource_status for the latest gate observation; the observation may be old. The Controller rechecks admission resources at execution, owns the GPU lease, tracks jobs, confirms release and restores Strata. Its disk observation or required space may be unknown. Do not assert a resource was checked without returned evidence, infer feasibility from nominal capacity, or bypass the Controller with raw HTTP, shell or model load/unload.

Use local_workflow_library with includeResources only when resource figures are relevant. Separate file sizes, measured peaks with settings, live free capacity, and established minima. A non-recommended entry can reflect a previous abnormal termination or a verified capacity shortfall. Report the reason and distinguish a direct incident from a shared-path inference. On workflow_warning, use the returned questionId and choices to warn the user before submission. Resume the same settings after explicit confirmation, subject to managed availability and normal admission.

Accept the user's stop request at any stage; local_production_cancel targets owned work only. Never stop foreign jobs. On OOM or resource shortage, use actual evidence and replan; never silently reduce requested resolution/duration or replace the chosen model. If a submission, cleanup or state is uncertain, preserve outputs and reconcile the same run before any retry; do not restart services to guess a solution.

If stop acceptance is uncertain and local_cancel_reconcile is available, use the exact production/request IDs. Acceptance alone does not establish job termination or GPU release; a rejected stop was not accepted. If stop persistence or search cancellation cannot be verified, report the uncertainty and that an already claimed external request may have been sent. Do not infer safety from a timeout or an absent receipt.
