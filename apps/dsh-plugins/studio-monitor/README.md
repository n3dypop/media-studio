# Studio Monitor

This Host/client plugin owns the **Media & Resources** right pane. Open it with
**Resources** in the conversation header or through the right-pane guide. DSH's
official sidebar provides resizing, tabs, focus and narrow-screen layout; the
plugin does not patch the Host DOM or overwrite another tab's width preference.

The pane shows conversation-owned productions, current stages, elapsed time,
attempt/review counts, Strata and ComfyUI resource observations, and the managed
GPU lease owner. Standard DSH buttons and theme tokens keep it consistent with
the Host. `studio-controls` supplies production decisions/stops and conversation
inference/search stops; `studio-services` supplies lifecycle controls through the
monitor's public child slots.

The Host authenticates the DSH connection and existing conversation before
requesting the Controller's limited monitor projection. Credentials, another
conversation's records, prompts and local output paths are not sent to the
browser. UI polling and elapsed-time updates run while the view is visible and
stop when it is hidden or disposed.

System totals, verified process measurements and the cooperative GPU lease are
separate observations. RAM prefers private resident memory and falls back to
working set when necessary. Strata includes only the managed API/listener and
verified directly owned native engines matching the installation receipt;
arbitrary descendant processes are excluded. Process identities and owned-child
sets are checked around measurement. Missing or changed evidence is unavailable,
not zero.

Per-process GPU usage uses NVIDIA measurements when complete, otherwise compatible
Windows dedicated-GPU counters. Shared GPU memory is excluded. Partial coverage
and source/scope remain explicit. Colored system bars attribute Strata and
ComfyUI only when the measurements are comparable; unknown usage stays in Other.
Contradictory totals are reported instead of proportionally adjusting the values.

ComfyUI node progress requires the matching conversation, run, prompt, GPU lease,
server epoch and WebSocket handshake. Its bar describes that node's work units,
not overall workflow completion or remaining time. Lost/stale connections and
unknown ownership produce unavailable progress. The stage list does not claim
that optional iteration or visual review already happened.

Disabling the monitor removes its pane and child-slot surfaces without changing
Controller execution, resource ownership or saved results. The integration targets
DSH 0.2.1-rc.5 official sidebar/header APIs. See
[configuration](../../../docs/configuration.md) and the
[Controller](../../controller/README.md).
