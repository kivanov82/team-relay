---
description: Sign in to your team relay with Google (opens your browser)
argument-hint: "[relay-url]"
disable-model-invocation: true
---

Sign me in to the team relay: call the `login` tool of this plugin's `relay` server.

Relay URL given with the command (may be empty): `$ARGUMENTS`

If that is empty, call `login` with no arguments (the plugin's own relay). If it is a URL, pass it as
`relay_url` and nothing else.

Then show me the `sign_in_url` from the result as a link, and tell me to finish in the browser tab that
opened: sign in with Google and choose my team. Do not open, fetch or change the link yourself. When a
`<channel source="relay" type="status">` event says I am signed in (or that it failed), tell me in one
line. If I ask whether it worked, call `whoami`.
