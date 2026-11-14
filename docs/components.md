# Components and ownership

Media Studio is one product repository with several components. The Controller
belongs here because its job/progress/output contracts, workflow profiles,
resource rules and service identity checks must agree with the DSH tools and UI.
A source checkout revision identifies the compatible set. The generic
`n3dypop/dsh-plugins` repository remains independent of these generation internals.

| Component | Owns | Does not own |
| --- | --- | --- |
| DSH integration in `apps/dsh-plugins/` | User interaction, preset and Skills, catalog/tools, media presentation, explicit approvals and managed service requests. | GPU lease enforcement, arbitrary process termination or unregistered model installation. |
| Controller in `apps/controller/` | Validated production API, jobs, durable history, ownership, resource exclusion, cancellation/recovery, artifact validation and delivery. | Model weights, ComfyUI node installation, user satisfaction or generic DSH appearance/session features. |
| Embedded `apps/controller/search/` | Approved search and page retrieval under the Controller's ownership and persistence rules. | A separately deployed search server or permission to send images externally. |
| Rust `apps/controller/native/system-probe/` | Read-only Windows RAM/commit, process-memory and listener-identity observations. | Lease/cancellation decisions, service lifecycle, GPU inference or a background daemon. |
| `workflows/` | Versioned templates and source material used by registered profiles. | Evidence that a model/node is installed or that a capability has passed real execution. |

## Changes and compatibility

Keep the DSH bundle's module paths and durable IDs stable. Managed launchers load
`apps/controller/server.mjs`; the internal search/native directories do not
require new DSH profile entries. `MEDIA_STUDIO_HOME` and per-plugin `runtimeRoot`
continue to identify private operational data, separately from source paths.
Moving source must never move or overwrite existing conversations, assets,
models, output files, credentials or process receipts.

Select **Catalog** next to **Resources** to open its right-hand pane. The buttons
are in the conversation header, or above the composer in a new conversation.
The workflow list supports keyword, media and operation filters.
**Add to prompt** appends a request to the current draft and keeps its attachments.
Managed workflows insert the exact profile and operation. Standalone entries insert
a request for ComfyUI inputs and instructions. Unavailable DSH mappings insert a
maintenance request. Send the draft when it is ready.
The Strata section shows the model specified in startup settings and the model
currently loaded by Strata. An active server can show **Not loaded**. The settings
warning appears when verified settings differ from those used at startup.
Refresh updates both sections without loading models or queuing workflows. **Media & Resources**
continues to show usage, service controls and conversation jobs.

The service and production controls accept JSON mutations from the active
loopback DSH listener. The Desktop originless route also requires an
owner-authenticated, route-bound proof. Monitor and catalog routes are read-only.

Controller changes that affect tools/catalog, workflow inputs, output evidence
or progress must update their integration contracts and tests in the same
revision. Service-management code also shares the Controller's process-identity
and executable-path validation helpers. The optional native binary has its own
build receipt and pinned hash; it is not installed merely by updating Git source.

The canonical source is this Git checkout. Any external development mirror is
a generated test workspace, not a second source to copy over the repository.
Commit reviewed source, run the checks and keep an idle-checked activation and
rollback reference when a running Controller needs an update.

A separate Controller repository becomes useful only with an independent
release/installation lifecycle, a versioned client/API contract, explicit
capability negotiation and tests covering supported client/backend combinations.
Until those exist, splitting source would add synchronization requirements
without separating the runtime process or reducing its resource use.

See [configuration](configuration.md), [capability extension](extensions.md)
and the [native build and installation procedure](native-probe.md).
