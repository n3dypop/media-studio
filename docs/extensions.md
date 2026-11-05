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

For video, representative frames provide only partial visual evidence. They do
not establish full motion continuity, sound, identity consistency or every frame's
quality. A future video profile must define those checks and its supported limits
before being exposed as available.
