# studio-controls

This Host/client plugin provides explicit search and page-fetch approvals,
production-specific stopping, and acceptance or rejection of generated candidates.
It uses DSH buttons and theme tokens. Search cards use `tool.call.toolview`;
production and conversation controls use the child slots owned by `studio-monitor`.
There is no separate stop button in the prompt composer.

Search cards show the exact terms or URLs, destination, purpose and current state.
Local status updates automatically while a request awaits approval or is running;
completed results remain expanded. External content is data, not instructions or
permission. The plugin does not fetch a proposed URL before approval or resend a
mutation whose outcome is unknown. Switching conversations cancels obsolete UI
reads so a late response cannot appear in another conversation.

Stopping a production verifies its conversation, production ID, latest run and
revision, then targets only that production's generation or prompt enhancement.
Stopping conversation inference and search is a separate action. Acknowledging a
stop request does not prove that execution and cleanup have finished.

Candidate acceptance is stored as the user's decision, separately from agent
review. Rejection saves feedback and may request planning of the next step; it
does not itself authorize another generation. A saved request ID and durable
send intent prevent duplicate planning requests. An uncertain request must be
reconciled against the existing DSH events/inbox before any resend.

Host dependencies are authenticated `webServer`, `connection`, `sessionQuery`
and `agents`, plus Controller access. Credentials remain on the Host. The client
uses DSH tool/conversation APIs, slots and the standard `Button`; appearance and
image-viewing plugins are optional. Without `studio-monitor`, search views remain
available but its production/conversation control slots are absent.

Disabling the plugin removes its routes and controls. It does not stop active
work or delete conversations and results; the Controller retains execution and
resource ownership. Re-enable the controls or use the managed administration
path to finish an outstanding decision. The integration targets DSH 0.2.1-rc.5.
See [configuration](../../../docs/configuration.md).
