# studio-preset

This client plugin keeps **Media Studio** (`local-image`) and configured
presets such as **ComfyUI Maintenance** available in the new-conversation
picker. It filters the two compatibility-only choices and uses the labels
registered by the Host. Saved conversations still resolve their original IDs.
The compatibility entries remain visible in Settings under their legacy names.

The plugin adapts DSH's `conversation.hero.agentPreset` slot while reusing the
official picker component and selection callback. It does not rewrite stored
conversations, the preset registry or selection history, and registers no Host
route. Review the official slot and its injected props when updating the Host.
See the package manifest for supported DSH versions.

Disabling the plugin restores the standard picker, which may display legacy
entries again. Existing conversations and running generations remain unchanged;
Controller owns execution and resources. Do not enable the retired
`local-genai-ui` picker adapter alongside this plugin.

See [configuration](../../../docs/configuration.md) for the preset and managed
provider route. The display adapter alone does not configure a model, enable
production tools or change an existing conversation's selected model.
