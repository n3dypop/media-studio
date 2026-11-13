# Media Studio

An integrated local media-production system through **DeepSeek Harness → Strata
→ Controller → ComfyUI**, with saved inputs, workflow settings, output review and
reasoned iteration. Video planning and review boundaries remain in the design;
shipping this repository does not make a video model available.

This repository owns the Controller backend, its optional Rust system probe,
six DSH integration plugins, Skills, workflow templates and managed launchers.
They are versioned together. It is the product source repository; the generic
DSH extensions are maintained separately.

Media Studio includes six integration plugins:

| Plugin | Purpose |
| --- | --- |
| `local-genai` | Agent tools, catalog, Skills and the Strata/Controller gateway. |
| `media-results` | Verified generation results and saved media delivery. |
| `studio-controls` | Explicit search approvals and production decisions. |
| `studio-monitor` | Media & Resources pane with production and resource state. |
| `studio-preset` | One current media-studio preset, with legacy compatibility. |
| `studio-services` | Managed service lifecycle, resource release and launch paths. |

Generic appearance, session management, image viewing and DSH host restart are
provided by [DSH Plugins](https://github.com/n3dypop/dsh-plugins). DSH 0.2.2
provides the Japanese language itself.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `apps/controller/` | Node.js service: jobs, resource ownership, cancellation, recovery and validated output delivery. |
| `apps/controller/search/` | Controller-owned search/page retrieval with explicit approvals. |
| `apps/controller/native/system-probe/` | Optional Rust implementation of read-only Windows observations. |
| `apps/dsh-plugins/` | DSH tools, Skills, preset, service controls and media UI integration. |
| `workflows/` | Approved generation templates maintained for this integration. |
| `scripts/` | Managed launch, build, packaging and recovery commands. |
| `tests/`, `.github/workflows/` | Portable contract tests and Windows native build automation. |
| `docs/`, `examples/` | Operation, integration boundaries, licenses and placeholder configuration. |

The Controller and plugins share production, workflow and service contracts;
update this checkout as one unit. [Component boundaries](docs/components.md)
explain ownership and the conditions for a future independent backend package.
Private settings, process receipts, models, conversations and generated media
belong outside this source tree.

Upstream Comfy workflow JSON and extracted official prompt texts are external
runtime assets, not bundled in this source tree. The optional prompt enhancers
require hash-verified private copies; see [external workflow assets](docs/external-workflow-assets.md).

## Install and configure

The host compatibility targets are DSH Web and Windows Desktop **0.2.2-rc.1**
and **0.2.2-rc.3**,
with Node.js **24**, Windows and PowerShell 7. DSH 0.2.1-rc.5 lacks the
managed-provider hook required by the durable integration. Its bundle loader
may show `Unknown agent preset: local-image` instead of a version-specific
message: check the DSH version and use the supported Host before trying again.
Do not delete or migrate conversation history to resolve this compatibility
error. ComfyUI and Strata must be installed separately. Python image/video
helpers use the configured ComfyUI Python environment and its required libraries.
Optional search uses a separately installed RustXNG. This source repository does
not bundle those products, runtimes, Python environments or model weights.
If `config/rustxng.json` is absent or sets `enabled: false`, search and page
retrieval are disabled while conversation and image production remain available.
Previously saved search records can still be viewed and cancelled. A present
configuration without `enabled` remains enabled for existing installations;
malformed or invalid enabled configuration is an error, not a silent opt-out.

On Windows, an optional [native system probe](docs/native-probe.md) avoids
repeated PowerShell startup for process identity, RAM and commit observations.
Protected external search also requires the configured, hash-verified native
probe to confirm the current DSH Host and its loopback listener. If the probe,
Host ownership or confirmation is unavailable, search remains on hold while
local conversation and image production remain available. Existing sessions
without sufficient search ownership evidence require maintenance review; do
not delete their history or retry an uncertain external request.
Controller remains a Node.js service; the probe does not perform inference or
replace resource ownership, cancellation or recovery rules.

Clone the repository from your DSH checkout:

```powershell
git clone https://github.com/n3dypop/media-studio.git .runtime/plugins/n3dypop/media-studio
```

Keep the upstream DSH repository's `.runtime/` excluded from its Git history.
The clone has its own Git history. Existing private installations may retain
their data in `.runtime/media-studio`; moving plugin source does not require
moving conversations, images or models.

Desktop keeps a separate source clone, for example under
`%USERPROFILE%\.dsh\plugins\n3dypop\media-studio`. After initializing and
fully quitting Desktop, use its bundled `dsh` command to add that clone as a
`link:` bundle to the Desktop profile. Configure the profile rather than
modifying the checkout's bundle patch. The Desktop and Web profiles and
conversation histories are separate; both can use the same Controller, models
and private runtime when operated one Host at a time. Controller remains owned
by the existing managed runtime, not a second Desktop instance.

Desktop configuration must consistently set `controllerSessionNamespace` to
`desktop` for the gateway, the preset's `local-genai` child, `media-results`,
`studio-controls`, `studio-monitor`, and `studio-services`. The gateway and
preset child also require `desktopPackagedRuntime: true`; the Desktop controls
and services require the same explicit runtime setting. Keep the Web settings
unchanged. A Windows Desktop installation using this layout has returned a
generated image to its conversation, saved the original PNG through the result
card, and recorded the Strata review. After installation, verify the same path
with the model, hardware and DSH build you will use.
Stop the old Host only after its work has finished before opening the other.
The Controller status endpoint is a snapshot, not an admission lock; separately
confirm the previous Host is fully exited, ComfyUI queue, Strata inference and
service operations. Do not continue if any state is unknown.

Set **`MEDIA_STUDIO_HOME`** to an absolute private runtime directory. Prepare
that directory's `config/` with your actual product paths and pinned installation
records. Public configuration examples contain placeholders, not usable paths or
accepted model licenses. [Configuration](docs/configuration.md) describes the
source/runtime boundary and the [extension handoff](docs/extensions.md) describes
how supported capabilities are registered.

Register `dsh.bundle.patch.yml` in the active DSH profile, using this checkout's
module URLs and explicit `runtimeRoot` values. Use the matching Media Studio
policy for DSH host restart. The generic and media bundles must not both register
an old and a new copy of a plugin.

The bundle declares the **media-studio** Agent preset with durable ID
`local-image`. Its managed tools, clarification, isolated compaction and six
Skills are nested under that preset; `local-genai` must never be mounted at the
Host root. The gateway and media UI plugins stay on the Host. All integration
entries start disabled: configure Controller paths/credentials and the
[model/provider example](examples/model-provider.patch.example.yml), then enable
both `preset-local-image` and its `local-genai` child, the gateway and the desired
UI entries. See [configuration](docs/configuration.md) for the complete sequence.

## Use

Start DSH through the configured managed launcher and select **media-studio**.
Describe the requested image, intended use, explicit model and required output.
For attached images, distinguish references to inspect from images to feed into
the generator. Editing requests should state what to preserve and what to change.

The agent uses six Skills as needed: `generation-plan`,
`comfyui-workflow-build`, `comfyui-generate`, `output-review`,
`generation-iterate` and `resource-control`. The live catalog determines which
models, modes and inputs are actually available. A template or Skill alone is
not evidence that an installed model can execute it. The production preset
selects approved templates and adjusts their exposed settings. Use the
[extension handoff](docs/extensions.md) when a request needs a new template,
model, custom node, or graph connection.

Generated images appear in the conversation and can be reopened from the saved
run. Use **Save original PNG** on the result card for the full artifact. The
conversation attachment is a preview. After an interrupted delivery, reopen the
existing run to recover its image without submitting a second generation.

**Resources** opens **Media & Resources**, showing production stages, elapsed
time and Strata/ComfyUI resource observations. Settings contain launch paths and
managed Start, Stop, Restart and model-resource release operations. User
acceptance/rejection and stopping apply to the selected production. Search terms
and page retrieval require their own explicit approvals.

The Controller owns resource exclusion, process identity, jobs and receipts.
After a timeout, inspect the original job/request ID. If its outcome cannot be
verified, keep it pending and do not submit another generation automatically.
Review examines actual output and records unmet or unverified criteria. The user
decides whether to adopt the candidate.

## Update and validate

Update the two source checkouts independently. Preserve private runtime data and
configuration. Reload plugins through the official lifecycle and use the managed
service launcher for code changes that require a process restart. Do not copy
example settings over a running installation.

```powershell
npm run check
npm test
```

The packaged checks use synthetic data and do not download models, send prompts,
start GPU generation or delete user sessions. Real model execution and delivery
through DSH require separate acceptance tests on the chosen hardware and profile.

Original code is [MIT licensed](LICENSE). Workflow templates and external
products/models keep their [own licenses](THIRD_PARTY_NOTICES.md). No credentials,
consent receipts, conversations, generated media or model weights are committed.
