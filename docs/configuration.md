# Configuration and runtime layout

Two roots have different responsibilities:

- The Git checkout contains DSH integration in `apps/dsh-plugins/`, the backend
  and its internal search/native implementations in `apps/controller/`, scripts,
  reusable workflows and public documentation. [Component ownership](components.md)
  defines their update and responsibility boundaries.
- `MEDIA_STUDIO_HOME` is the absolute private runtime root. It owns effective
  `config/`, `data/`, managed process receipts, logs, caches, inputs and outputs.
  Keep ComfyUI weights in the node's model category under `ComfyUI/models/`,
  for example `diffusion_models/`, `text_encoders/`, `loras/`, or `vae/`.
  Keep Strata GGUF shards and their vision projector together under
  `Strata/models/`, with the corresponding prepared pack under `Strata/packs/`.
  These directories contain local assets and are excluded from product Git
  history.

The managed Strata configuration and its installation receipt remain in the
private runtime. When relocating assets, update `--native`, `--ple-gguf`,
`--pack`, and the vision `model` and `mmproj` paths together. Verify that the
shard names and contents still match the pack, then record the new configuration
SHA-256 in the installation receipt. Validate the launcher before starting,
then test model loading and image input through the managed provider.

Set the environment variable before calling the package scripts:

```powershell
$env:MEDIA_STUDIO_HOME = (Resolve-Path '<your-private-runtime>').Path
& '<media-studio-checkout>/scripts/Start-Environment.ps1' -Service DSH
```

Replace both placeholders. A missing home setting is only suitable for an
intentional fresh setup using the package root; production should always set it
explicitly. Keep private runtime data outside the Git checkout.

Each host plugin's profile configuration uses an explicit `runtimeRoot`. This
must equal the managed private runtime. It is not inferred from the checkout's
position. `studio-host` also uses Media Studio's trusted policy module to protect
active production and its verified launcher to restart only DSH. Neither field
may be supplied by arbitrary prompt text.

[The Host policy example](../examples/host-policy.patch.example.yml) shows the
full launcher shape and `launcher.env.MEDIA_STUDIO_HOME`. Configure the existing
generic `studio-host` entry with this policy and `requirePolicy: true`; do not
register another Host plugin copy. The example stays disabled until every path
and the managed startup contract have been verified.

Copy only reviewed example structures into a new private `config/`. Fill in the
actual product roots, executables, ports and installation identities. Preserve
loopback binding and ownership checks. Models and license/purpose confirmations
must be established by the installer and runtime catalog; source examples do not
count as consent or successful installation.

In private `config/environment.json`, set `dshPluginsDirectory` to the absolute
DSH Plugins checkout root. Managed DSH startup uses that package's
`scripts/maintenance/Apply-SessionDeletions.mjs` before starting DSH. This keeps
the session persistence adapter in the generic package instead of maintaining a
second copy in Media Studio. The example's `privateEnvironmentFields` illustrates
this field; the surrounding example is not a complete environment configuration.

Secrets are created/read under the private runtime. Do not commit copied auth
tokens, connection launch URLs, `.env` files, model license receipts, service
records or conversation databases. Do not copy a user's private config back into
the source examples during maintenance.

## Controller Node.js

Controller uses the separately installed **Windows x64 Node.js 24** runtime;
the Git repository does not contain a JavaScript runtime or a bundled Node
binary. Set the optional `controllerNodeExecutable` in the private
`config/environment.json` to an absolute local path to a direct `node.exe`.
That executable may be outside `MEDIA_STUDIO_HOME`, for example an existing
system-managed installation. If the field is absent, the existing private
`nodeDirectory/node.exe` convention remains the fallback. The field does not
change DSH's separate `nodeDirectory`.

The Services settings screen can validate and save the path while the managed
services are stopped. Before saving and before Controller launch, the executable
must provide Node 24, `node:sqlite`, `fetch`, and `AbortSignal.any`. A Node shim
that resolves to a different executable, redirected path, network path, and
unsupported major version are rejected. The direct executable path is required
to preserve managed process-identity and safe-stop checks. `NODE_OPTIONS` is
not inherited by the Controller launch or its validation probe. Runtime upgrades
are the installer's responsibility; retest compatibility before adopting a new
Node major. Do not remove the existing runtime while a service, launcher, or
recovery tool still depends on it.

An existing installation can retain thin private launch wrappers that set
`MEDIA_STUDIO_HOME` and call scripts in this checkout. Updating the checkout then
updates source without relocating the user's data. Keep a rollback reference to
the previous source revision and preserve saved receipts after uncertain results.

For an installation with a maintainer-created `data/plugin-migration/retirement.json`,
`node scripts/Finalize-PluginMigration.mjs --root <PRIVATE_RUNTIME>` checks retained
source without moving it. Add `--apply` only for the recorded source transition.
It archives allow-listed source after the original owning processes have exited
and every saved hash matches. It never stops a process or deletes user data.
An interrupted archive move can be reconciled against the saved hashes.

## Optional search

RustXNG is a separately installed service. If the private runtime does not
contain `config/rustxng.json`, or that JSON explicitly has `"enabled": false`,
the Controller and managed launcher start without it. Search and page retrieval
are disabled, while existing records remain readable and cancellable; user-turn
and cancellation bookkeeping remains active for the managed DSH route.

For compatibility, an existing configuration with no `enabled` field is
enabled. An enabled configuration must supply a valid loopback `baseUrl`, and
the managed launcher verifies its executable, pinned hash and configuration
before starting services. Invalid JSON, invalid enabled settings or a failed
search start is an error; it is never silently converted to disabled. A
configured-but-stopped search backend can still fail an approved search, and its
enabled state is not proof of backend health.

The Controller status reports `search.enabled` as the configured state and
`search.availability` as `disabled`, `unprotected`, `unavailable`, or
`requires-current-host-confirmation`. The last value means that the protected
route is configured; it does not confirm that the current Host, turn, or
search backend is ready.

Every new external search also requires verified DSH Host/turn ownership and
an authenticated, fresh loopback confirmation immediately before dispatch.
Configure the native probe below; if it, the gateway, ownership or the saved
history cannot be verified, search stays on hold without blocking local image
production. A previous `searchTurnOwnership: false` Controller setting now
disables search instead of selecting an unprotected path. Existing sessions
without enough ownership evidence require maintenance; their conversation and
saved results must be retained. A stop or confirmation failure cannot prove
that an already-started external request was never sent.

## Optional native observations

For the optional Windows-only `nativeProbe` Controller field and its build,
activation and rollback procedure, see [native system probe](native-probe.md).
It is disabled unless explicitly configured in the private runtime.

## Agent preset and model route

The bundle defines `preset-local-image` using the native
`@deepseek-ai/dsh-agent-preset` composition. The preset's durable ID is
`local-image` and its display name is **media-studio**. `local-genai` belongs
inside `config.plugins` of this preset because its tools and instructions are
Agent-scoped. It refuses Host-root registration. Clarification, isolated basic
compaction and the isolated Skill registry/source/tool are declared beside it.
Do not flatten these children into Host entries or register a second preset with
the same ID.

Configure a private deployment in this order:

1. Set each `runtimeRoot` to the actual private home, the Controller loopback
   origin/port, and `tokenFile` to the DSH credential file inside that home.
   The usual relative reference is `data/controller/dsh-token`; it is distinct
   from the Controller administrator's `auth-token`. Neither value belongs in
   the public bundle. Start the configured Controller to create its private
   credentials before enabling integrations that read that file.
2. Configure the native provider through
   [model-provider.patch.example.yml](../examples/model-provider.patch.example.yml).
   Override the existing `llm-pi-ai` row rather than mounting another adapter.
   Keep the route/model IDs **`local-strata` / `strata-core`**: both the managed
   gateway and generation tools require this route. Set the model's display name
   to the actual installed model and replace capacity placeholders with verified
   integer limits. Declare image input only after the installed Strata vision
   path works; text-only routing cannot establish visual output review.
3. Resolve `MEDIA_STUDIO_DSH_TOKEN` through DSH's private credential/environment
   seam to the Controller's DSH token. `apiKeyEnv` is a reference name, not a
   place to paste a token into YAML. The provider endpoint is Controller `/v1`,
   not a direct Strata URL, so resource leases and ownership checks stay active.
4. Review basic-compaction budgets against the verified model context window.
   Its summary route is also `local-strata` / `strata-core`. Keep the compaction
   and Skill isolation groups intact.
5. Explicitly enable the outer `preset-local-image` row and its nested
   `local-genai` row, then enable the configured gateway and desired media UI
   entries. Disabled ancestors intentionally keep their children inactive.
   Enable the generic Host entry only with the required Media Studio policy.
6. In a new conversation select **media-studio**, then **Strata** and the actual
   model display name. Provider configuration and selecting a preset are separate
   operations. The example does not change an existing conversation's model or
   the user's global default preset.

All local module references in the bundle, including preset children, are
relative to the root bundle file. Preserve that resolution base when installing;
deployment tooling may replace them with absolute local file URLs. A profile
snippet copied to a different folder needs its module URLs resolved again.
