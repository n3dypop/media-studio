# Studio Services

This independent Host/client plugin exposes managed Strata, ComfyUI and Controller
status plus **Start**, **Stop** and **Restart** in **Media & Resources** and DSH
General settings. **Unload** explicitly releases Strata or ComfyUI models without
stopping the service. Service management remains available in DSH while the
Controller is stopped.

Lifecycle operations verify conversation activity, Controller runs/inference/GPU
leases, ComfyUI queues, Strata in-flight work and recorded process identity.
Stopped-service checks require repeated proof of process absence and a free
listener; inaccessible or reused identities remain unknown. Starting Controller
prepares its required services in order and reuses only verified running
instances. Stopping a dependency first stops Controller normally; restarting
restores Controller only when it was running before the operation.

Unload requires the target service and Controller to be running. It uses the
Controller's authenticated resource route and GPU gate, with fresh ownership,
queue and process-generation checks. Strata unload leaves the lease idle until a
normal request reloads the core. ComfyUI unload preserves the core's load state.
Service RAM, CUDA context and other allocations may remain. Unknown completion
keeps admission blocked; unload and reload are not automatically repeated.

Launch paths are edited at **Settings → General → Services → Service paths**.
They update the single private `config/environment.json` using its current
revision and an atomic save with a recovery copy.

| Setting | Purpose |
| --- | --- |
| `comfyDirectory` | Existing ComfyUI installation within its configured product root. |
| `comfyPythonExecutable` | Existing Python environment belonging to that ComfyUI installation. |
| `strataPythonExecutable` | Prepared Strata API runtime matching its installation receipt. |
| `controllerNodeExecutable` | Private runtime's Controller Node executable, separate from DSH's runtime. |

Saving paths requires the managed services and durable production state to be
idle, with no uncertain/conflicting operation. It does not install products,
change model/input/output locations, or start/restart services. Reload the form
when its revision is stale.

Operations use durable request IDs and receipts in
`data/service-manager/operations.json`. The UI hides completed operation cards
while retaining the journal for reconciliation. A failed or unknown operation
keeps its explanation. Credentials, cookies and raw launcher output are not
returned to the client or copied into operation receipts. Do not repeat an
uncertain mutation or delete its ownership/lock records to bypass recovery.

Disabling the plugin removes routes and controls, stops scheduling later steps,
and retains already-running service processes and their records. It does not
roll back completed lifecycle steps or force-stop service children. Use the
[managed Controller and recovery path](../../controller/README.md) to reconcile
outstanding work.

The plugin owns its `studio.services` English/Japanese dictionaries. Edit
`ja.json`, then run `node build-client.mjs` to rebuild its embedded client
dictionary. Select Japanese through DSH's language setting. See the package
manifest for supported DSH versions and [configuration](../../../docs/configuration.md).
