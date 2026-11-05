# Media Studio Controller

The Controller is Media Studio's background service. It belongs to the
[Media Studio product](../../README.md), alongside its DSH integration, workflow
assets and service launchers. It is not a DSH Host plugin or a separately
distributed application.

## Responsibilities

- Persist production specifications, assets, workflow bindings, run IDs, review
  evidence and output receipts.
- Execute supported ComfyUI workflows and reconcile an uncertain submission
  against its original prompt ID.
- Coordinate Strata and ComfyUI resource ownership, with process identity,
  cancellation and recovery checks.
- Serve saved results and production state to the DSH integration over the
  authenticated local HTTP API.
- Keep search approval and retrieval records through the internal `search/`
  library. RustXNG remains an external service.
- Use the optional read-only [Windows system probe](native/system-probe/README.md)
  for selected OS observations. The Controller retains all lifecycle and
  ownership decisions.

The DSH plugins in `../dsh-plugins/` provide agent tools, the preset, Skills,
delivery and user controls. Model and custom-node installation remain
maintenance work; see [capability extensions](../../docs/extensions.md).

## Source and private runtime

This directory owns the service implementation, Python asset helpers, internal
search library and native probe source. Reusable workflow assets remain at the
repository's `workflows/`, and managed launch and recovery commands remain at
`scripts/`. Keep these files from the same Media Studio revision.

`MEDIA_STUDIO_HOME` selects the absolute private runtime containing effective
configuration, credentials, databases, process records, inputs and outputs. None
of those files belongs in this source directory. The service imports no DSH
packages; its DSH clients connect through the local API. See
[configuration](../../docs/configuration.md) and
[native probe setup](../../docs/native-probe.md).

## Run and maintain

Normal use starts and stops the Controller through Media Studio's managed
launcher or DSH service controls. These verify process identity, readiness and
active work. `scripts/Start-Controller.ps1` resolves this directory's
`server.mjs`, and the private runtime may retain a thin forwarding wrapper.

For a separately prepared development runtime, the private component metadata
provides this equivalent service entry from the repository root:

```powershell
$env:MEDIA_STUDIO_HOME = '<absolute-private-runtime>'
npm --prefix apps/controller start
```

This direct command starts only the Controller and does not prepare models,
start dependencies or replace the managed lifecycle checks. Windows operation
requires a direct local Windows x64 Node.js 24 executable, PowerShell, ComfyUI
and Strata environment. Node is an external dependency and is not bundled in
the source repository. An existing system-managed Node installation can be
specified as the private `controllerNodeExecutable`; see
[configuration](../../docs/configuration.md) for version and identity checks.

Run `npm run check` and `npm test` at the repository root for source and fixture
checks. Those checks do not establish real GPU execution, image delivery or
visual quality. Preserve durable records when a submission, stop or resource
release has an unknown result; recovery must not create a second generation.
