# Maintaining Media Studio

Keep public documentation in English. This checkout contains source and templates;
`MEDIA_STUDIO_HOME` and configured `runtimeRoot` identify private operational state.
Never commit real settings, credentials, conversations, model weights, license
consents, generated media, logs or private investigation reports.

This is the Media Studio product repository, including its Controller backend,
internal search and native observer, DSH integration, workflows and launchers.
Keep those components compatible in one revision; generic DSH plugins live in
their own repository. Read `docs/components.md` before moving a boundary.
This Git checkout is canonical. External development/test mirrors must not
overwrite it through a bulk copy or a retired publication-preparation script.

Preserve the managed Controller route, ownership checks, stable IDs and saved
history. Agent tools belong inside the Media Studio preset; resource exclusion,
cancellation and execution guarantees belong in Controller code. New models or
custom nodes require the complete integration handoff in `docs/extensions.md`.
Do not describe a template, Skill or successful process exit as GPU/quality proof.

Run `npm run check` and `npm test`. Live activation must check idle state and saved
receipts. Never retry an uncertain job or service mutation automatically.
