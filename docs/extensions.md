# Adding a model, node or workflow

Media Studio selects approved templates and adjusts their exposed settings.
The user or a separate maintenance agent owns new workflows, topology changes,
asset installation and registration. The standalone library lists editable UI
workflows. The managed catalog lists model/operation pairs that Controller can
admit for execution from Media Studio.

Use this handoff sequence:

1. Record the requested capability, modes, required inputs and exact model.
   Identify the upstream source revision, component compatibility, licenses and
   expected resource requirements. Research approval is separate from approval
   to install or send an image to an external service.
2. Install assets in the product's designated model/node directories. Preserve
   previous usable assets and record hashes and versions. Installing a file does
   not register a capability with the Controller or DSH.
3. Implement the Controller profile, input admission and output validation,
   permitted graph nodes/parameters, resource behavior and cancellation/recovery.
   Use the managed profile checklist below for natural-language use in DSH.
4. Validate the graph statically first. ComfyUI `/prompt` submits a job; it is not
   a read-only validation endpoint. Perform a separately identified execution
   test and preserve its model, seed, workflow and settings.
5. Verify readable artifacts, DSH delivery and actual review/iteration behavior.
   Keep static, fixture, real GPU, browser and user-acceptance evidence distinct.
6. Hand over supported modes and limits, sources, tests, known gaps, rollback,
   resource observations and the next action when the requested mode is missing.

Do not silently replace an explicitly requested model, lower dimensions or video
duration, terminate unmanaged work or publish an untested capability as available.
Missing capabilities should produce a useful handoff, not an invented execution.

## Managed profile checklist

1. Add a stable profile ID and label to `apps/controller/media-modes.mjs`.
   Both Controller and the DSH tool layer use this registry. Keep existing IDs
   for saved records. If the preset gains a new operation or input type, implement
   its input admission, mode checks and ownership binding here before exposing it.
2. Add `workflows/approved/<profile-id>.json` in ComfyUI API format. Preserve a
   separate editable UI JSON in the ComfyUI Workflows folder. In
   `workflows.mjs`, register exact model loaders, allowed nodes and connections,
   output limits and the runtime discovery for each supported pair. In `comfy.mjs`
   validate preparation and the final graph against installed model and node schemas.
   A known profile alone does not give the assistant permission to execute it.
3. Implement preparation and render dispatch. The DSH create result returns
   `next.tool` and `next.args` through `productionPreparation` in
   `apps/dsh-plugins/local-genai/index.mjs`. Keep permission and arguments aligned
   with that dispatch. Test explicit profile selection, dimensions, input ownership,
   output attachment and evaluation. Verify model/node provenance in the ledger.
4. Put the same profile ID and operation on the UI workflow's library entry.
   Check `dshProfile` in **Catalog** and the pair in `local_workflow_catalog` after
   updating Controller and the DSH plugin together. `unavailableDshProfile`
   exposes an unresolved mapping. Check its ID, operation, assets and permitted
   node schema before claiming DSH availability.
5. Use **Add to prompt** in a `media-studio` conversation. Confirm the exact
   profile and operation in the draft. For acceptance, send a minimal request
   with an expected size and owned inputs, then verify the actual attachment,
   evaluation, resource recovery and provenance. Record which Host and model
   ran each test, and how to restore the prior version.

## Standalone ComfyUI library

With product workflow storage enabled, Controller reads
`ComfyUI/user/media-studio/workflow-catalog.json`. Version 1 lists UI templates in
`user/default/workflows/Media Studio/<family>/`. Give each entry a stable ID,
family, label, operation, media type, relative file and exact loader choices
(`category` and `name`). An optional `profile` links an existing managed equivalent
for the same operation. Registering a UI template never creates a managed profile.

`GET /api/workflow-library` and the DSH `local_workflow_library` tool support keyword,
media and operation filters and pagination. The library checks template files,
local node registration and model loader options without queuing a job. It
reports absent dependencies. To see a managed mapping, match the entry's profile
and operation against the live catalog. The response lists all registered
operation filters, and keyword search includes profile IDs and weight names.
GPU fit, runtime behavior and visual quality
require separate validation. A missing library index leaves the managed catalog
usable. Keep model sources and hashes in the asset manifest or handoff.

### Resource forecasts and execution warnings

Record evidence in `ComfyUI/user/media-studio/workflow-resource-observations.json`
(`version: 1`). Under `workflows`, use the library ID as the key. Store the
editable template's `workflowSha256`, `gpu`, `width`, `height`, `sampleIntervalMs`,
`vramPeakDeltaBytes` and `ramWorkingSetPeakBytes`. Include `frames`, `fps`,
`steps`, `samples`, `gpuPeakBytes`, `ramPrivatePeakBytes`, `commitPeakDeltaBytes`
and `outputBytes` when observed. Keep the actual graph, loaded weight versions,
GPU/driver/runtime, cold or warm start, sampling method and output evidence in
the handoff. Compare the actual templates after upgrades. Missing peak data stays
unknown. Disk weight sizes, process RAM and system commit are separate quantities.

Catalog shows observed peaks, an advisory planning target of 120% of each peak,
installed capacity, current free capacity and output-disk space. The target is
for the recorded settings and is compared with current memory only on a matching
GPU. The live snapshot is taken before Controller's handoff from Strata and can
change. Do not extrapolate measurements to other dimensions, frame counts, load
policies or weight variants. The resource gate still uses its own fresh checks.

For an unexpected runtime termination or sustained capacity problem, review the
logs and add an `assessments` entry keyed by the affected library ID. Record the
date, reason, affected settings and whether the evidence is direct or shared.
For example:

```json
{
  "version": 1,
  "assessments": {
    "example-video": {
      "issue": "abnormal-termination",
      "evidence": "observed",
      "date": "2026-11-15",
      "summary": "Windows stopped while the text encoder was loading.",
      "attempt": { "width": 512, "height": 288, "frames": 22, "fps": 24 }
    }
  }
}
```

Use `shared-path` when an untested sibling uses the implicated stage. Use
`resource-capacity` with `verified` and a summary for a verified incompatibility.
For a measured or documented hard minimum, set `workflowSha256` and
`minimum` with the known fields `vramBytes`, `ramBytes` and `commitBytes`. A hard
minimum above total capacity is tagged automatically for that template revision.
Temporary pressure, cancellations, idle timeouts and missing measurements alone
do not justify this tag. Recorded incidents remain visible after template edits.
Remove or narrow an assessment after reviewing new evidence and recording the
conditions and result in the handoff.

Check the Catalog badge and `local_workflow_library` result. A direct standalone
request must include the warning in its explanation. For a managed profile,
Media Studio presents the specific warning before submitting the render and can
proceed with the same settings after the user expressly confirms. Confirmation
does not bypass profile registration, asset validation, lease ownership or the
resource gate. Keep failure details and new findings in the maintenance record.

Maintenance agents can use the official [ComfyUI CLI](https://docs.comfy.org/agent-tools/cli)
or [ComfyUI MCP server](https://docs.comfy.org/agent-tools/mcp) to inspect live
nodes and models, edit draft workflows and validate connections before execution.
Validate the exported API graph against the target instance. Run GPU trials on
the standalone instance after checking shared GPU ownership and queues. Managed
generation goes through Controller after the workflow's inputs, outputs and
resource contract have been integrated.

The optional **ComfyUI Maintenance** preset uses DSH's scoped stdio MCP client.
Install `apps/comfy-maintenance/requirements.txt` into a dedicated Python
environment. In each Web or Desktop profile, enable `preset-comfy-maintenance`,
set the MCP command to that environment's Python and its argument to
`apps/comfy-maintenance/server.py` in the installed plugin checkout. Set
`COMFY_PRODUCT_ROOT` to the local ComfyUI product directory,
`COMFY_LOCAL_URL` to its loopback endpoint, and `COMFY_MAINTENANCE_ROOT` to an
existing private draft directory. Select the local Strata model in DSH.

The preset lists three tools. Search returns local node names. Edits accept
paths relative to ComfyUI's Workflows folder and save copies under a returned
draft ID. Validate the draft using that ID. Recover the editable JSON from the
draft directory. To deploy a draft for production, follow the profile handoff
above.

For video, representative frames provide only partial visual evidence. They do
not establish full motion continuity, sound, identity consistency or every frame's
quality. A future video profile must define those checks and its supported limits
before being exposed as available.
