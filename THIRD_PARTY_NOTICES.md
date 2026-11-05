# Third-party notices

The repository's MIT license covers its original orchestration code. It does
not change the licenses of external applications, model weights or workflows.

| Material | Upstream | License and retained notice |
| --- | --- | --- |
| DeepSeek Harness integration and upstream-derived compatibility material | [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness), compatibility target 0.2.1-rc.5 | MIT, Copyright 2026 DeepSeek. Full text: [DeepSeek-Harness-MIT.txt](docs/licenses/DeepSeek-Harness-MIT.txt). |
| Comfy Org-derived workflow adaptations and compatibility | [Comfy Org workflow templates](https://github.com/Comfy-Org/workflow_templates), source revision `60d0d2c2f5c98ab50116abd837156e4010534657` | MIT, Copyright 2023-present Comfy Org. Full text: [Comfy-Org-MIT.txt](docs/licenses/Comfy-Org-MIT.txt). Installed source packages used for attribution: `comfyui_workflow_templates` 0.11.100 and `comfyui_workflow_templates_json` 0.1.126. |

ComfyUI, Strata, RustXNG, Python/Node runtimes and model weights are obtained
separately. They are not included in this source repository. Check each upstream
application and each model/component's terms before installation or use.
The original Comfy workflow JSON and extracted enhancer prompts are also kept
outside the repository; see [external workflow assets](docs/external-workflow-assets.md).

In particular, MIT-licensed Qwen workflow templates do not grant permission to
use Qwen model weights. Qwen-Image-2.1 uses a separate research license; the
integration requires an explicit research/evaluation purpose confirmation.
Do not commit a user's consent record or describe that model as generally
licensed for commercial use. The software's license does not resolve unverified
terms for other model components.

Product names identify compatibility. This is an independent project and is
not an official distribution of DeepSeek Harness, Strata or ComfyUI.

The optional Rust system probe uses Cargo-locked dependencies. Its
[dependency notices](apps/controller/native/system-probe/THIRD_PARTY_NOTICES.md) apply to compiled
probe distributions; this repository does not bundle a compiled executable.
