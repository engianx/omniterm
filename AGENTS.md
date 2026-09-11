# AGENTS.md

Durable knowledge for agents working in this repo. Keep it tight: add a rule
only when it is durable, generalizable, and not already stated in the code at
the point where it matters.

## Working with live processes

The dev loop here touches the user's real `tmux` server and real Chrome
instances. Both have a trap that has already destroyed live state once.

- **Never run `tmux kill-server`.** Tear down by name only:
  `tmux kill-session -t '=<name>'`.
- **`TMUX_TMPDIR` does not isolate tmux when you are inside a tmux pane.** With
  `$TMUX` set, the client takes the socket from `$TMUX` and ignores
  `TMUX_TMPDIR`, so "isolated" commands land on the real server. Unset both:
  `env -u TMUX -u TMUX_PANE TMUX_TMPDIR=<dir> tmux ...`.
  `packages/core/plugins/terminal/lib/tmux.integration.test.ts` does this
  correctly — copy its isolation whole, never half of it, and prefer extending
  that suite over hand-rolled tmux commands. A command exiting **137** right
  after a tmux call is this bug.
- **The pid `omniterm-browser.js` registers is not the live browser on macOS.**
  Chrome re-execs and the real process is reparented to init, so killing the
  registered pid leaks a headless Chrome per run. Kill the owner recorded in
  `<user-data-dir>/SingletonLock` (`<hostname>-<pid>`), wait for it to exit,
  then remove the dir — see
  `packages/core/plugins/terminal/lib/browserShims.integration.test.ts`.
