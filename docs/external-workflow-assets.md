# External Comfy workflow assets

The optional official MOSS and Qwen prompt enhancers use texts derived from
Comfy Org's [workflow templates](https://github.com/Comfy-Org/workflow_templates)
revision `60d0d2c2f5c98ab50116abd837156e4010534657`. The original workflow
files and extracted texts are not included in this repository. Comfy Org's MIT
notice remains in [third-party notices](../THIRD_PARTY_NOTICES.md) because the
integration also includes adaptations of the upstream workflows.

Obtain the pinned upstream revision separately, review its terms and keep it
outside this repository. With a local `templates` directory from that revision
and an existing absolute private `MEDIA_STUDIO_HOME`, run:

```powershell
node scripts/install-external-prompts.mjs <absolute-official-templates-directory> <absolute-private-runtime-directory>
```

This importer performs no downloads. It validates each source file's fixed
SHA-256, the exact source node and extracted text SHA-256 before writing any
prompt. It writes only missing files, verifies existing files and refuses to
replace different content. A partial interruption can be safely rerun after
inspection. It does not install models, register nodes, enable an enhancer or
approve a model license. Keep the upstream license with separately distributed
copies of the source files.

Runtime lookup uses `MEDIA_STUDIO_HOME/external/comfy-workflow-templates/workflows/source/`
with separate `moss-image/` and `qwen-image-2.1/` directories. `MEDIA_STUDIO_HOME`
must be an absolute private runtime path. Missing, modified or incorrectly
located texts make the respective enhancer unavailable; normal image generation
does not require these optional files. The user or a separate maintainer must
still qualify the model, nodes and actual GPU behavior before enabling the
corresponding capability.
