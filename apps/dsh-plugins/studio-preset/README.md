# studio-preset

This client plugin keeps the new-conversation preset picker focused on the single
current **media-studio** preset, whose durable ID is `local-image`. It preserves
legacy preset definitions and IDs needed to reopen existing conversations;
compatibility entries remain distinguishable in settings as **Legacy workflow
(compatibility)** and **Legacy image (compatibility)**.

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
