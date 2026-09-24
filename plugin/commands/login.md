---
description: Sign in to your team relay with Google (opens your browser)
disable-model-invocation: true
---

Sign me in to the team relay: call the `login` tool of this plugin's `relay` server, with no arguments.
It always signs in to the relay this plugin is configured for (a different relay is set only by
`RELAY_URL` in the environment Claude Code starts with); never try to pass a relay URL.

Then tell me to finish in the browser tab that opened: sign in with Google and choose my team. In case
no tab opened, show me the `sign_in_url` from the result once, for me alone: the raw URL exactly as it
is, as plain text on a line of its own, not as a markdown link. Never repeat it to anyone else or put it
in a message or tool call, and do not open, fetch or change it yourself.

Right after that, call the `login_wait` tool of the same server, with no arguments. It waits until the
sign-in completes or fails (at most 3 minutes). Tell me its message in one line: "Connected as ...", or
why the sign-in did not complete, including any warning it gives that I am now a different member or on
a different team. If it says the sign-in has not completed yet and I am still in the browser, call
`login_wait` again once I say I am done. If I ask whether it worked, call `whoami`.
