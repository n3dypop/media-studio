# media-results

This Host/client plugin displays saved generation state, images and supported
video attachments in DSH conversations. Images appear in
`conversation.chat.turnTail` through DSH's standard gallery and lightbox.
Authenticated plugin routes provide original PNG downloads and video range
requests.

Cards show recorded model, mode, size, steps, seed and agent decisions when those
values are available. They distinguish running, failed, stopped and unresolved
work. Process completion means that execution or saving ended; it does not mean
that visual criteria passed or the user accepted the work. Missing values are
not inferred.

Each displayed image retains its standard gallery preview. Original PNG delivery
verifies the conversation, recorded run/name/hash, Controller ownership and the
returned bytes. Arbitrary filesystem paths and URLs are not accepted. Video
attachments also require conversation ownership; sampled still frames do not
establish whole-video motion or audio quality. A configured video-capable profile
is required before video generation is available.

Host dependencies are authenticated `webServer`, `connection`, `sessionQuery`,
`attachments`, the local Controller and its private DSH token. The client uses
DSH tool/attachment/chat/conversation APIs, `slots`, `uiConversation` and the
standard `Button`. Theme tokens keep the cards consistent with DSH; optional
theme and image-viewing plugins are not required.

Disabling the plugin removes its routes, display slots and conversation
projection. Active HTTP requests may fail, but conversations and saved outputs
remain available for reconstruction after re-enabling. It does not cancel jobs
or release GPU resources; those remain Controller responsibilities.

The integration targets DSH 0.2.1-rc.5. Do not enable the retired `local-genai-ui`
result renderer alongside this plugin, because both register overlapping display
and route entries. See [configuration](../../../docs/configuration.md).
