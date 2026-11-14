# Adding a model, node or workflow

Media Studio executes registered capabilities. It can select approved templates
and change supported graph parameters. It does not install missing model weights,
custom nodes or an unsupported generation technique merely because a user asks
for one. The user or a separate maintenance agent develops that integration.

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
   Register the matching tool/catalog contract without implying broader support.
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
reports absent dependencies and exposes a `dshProfile` only when the live managed
catalog exposes that operation. GPU fit, runtime behavior and visual quality
require separate validation. A missing library index leaves the managed catalog
usable. Keep model sources and hashes in the asset manifest or handoff.

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
