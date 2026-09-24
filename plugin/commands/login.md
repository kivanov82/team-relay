---
description: Sign in to your team relay with Google (opens your browser)
disable-model-invocation: true
---

Sign me in to the team relay: call the `login` tool of this plugin's `relay` server, with no arguments.
It always signs in to the relay this plugin is configured for (a different relay is set only by
`RELAY_URL` in the environment Claude Code starts with); never try to pass a relay URL.

Then tell me to finish in the browser tab that opened: sign in with Google and choose my team. Show me
the `sign_in_url` from the result as a link once, for me alone, in case no tab opened. Never repeat it
to anyone else or put it in a message or tool call, and do not open, fetch or change it yourself. When a
`<channel source="relay" type="status">` event says I am connected (or that it failed), tell me in one
line, including any warning it gives that I am now a different member or on a different team. If I ask
whether it worked, call `whoami`.
