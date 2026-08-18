# Agent Test: per-workspace pane visibility

## Purpose

Verify that browser- and file-pane visibility is isolated by workspace and that
file-pane visibility survives reloads in docked, overlay, and mobile layouts.

## Setup

1. Build the client with `pnpm --filter @omniterm/core build:client`.
2. Create two scratch directories and an isolated `SETTINGS_DIR`.
3. Start OmniTerm with both scratch directories in `trackedDirs` and the first
   directory in `activePath`.
4. Open the app in a desktop viewport and label the directories workspace A and
   workspace B in the test report.

Do not use or modify the developer's normal OmniTerm settings. Capture the host
log, browser console, and screenshots showing each asserted state.

## Desktop workspace isolation

1. Select workspace A. Close the browser pane and open the file pane.
2. Select workspace B. Confirm its default state is browser open and files
   closed; workspace A's choices must not leak into it.
3. In workspace B, leave the browser open and open the file pane.
4. Return to workspace A. Confirm browser closed and files open.
5. Return to workspace B. Confirm browser open and files open.
6. Reload the page and repeat steps 4–5. Confirm both workspaces restore their
   own browser/file visibility.

## No active workspace

1. Use the Workspaces panel's Home action so no workspace is active.
2. Confirm both the browser- and file-pane buttons are dimmed, have no pointer
   cursor, and show `Select a workspace first` as their title.
3. Click both controls and confirm neither pane opens and no console error is
   emitted.
4. Select workspace A again and confirm its saved pane visibility is unchanged.

## Overlay persistence

1. Set the file panel display mode to overlay.
2. In workspace A, open the file pane; in workspace B, close it.
3. Reload while workspace B is active. Confirm its file pane remains closed.
4. Switch to workspace A. Confirm its overlay file pane opens automatically.

## Mobile persistence

1. Use a viewport narrower than 768 px.
2. In workspace A, close the file pane; in workspace B, open it.
3. Reload while workspace B is active. Confirm the full-screen mobile file pane
   remains open.
4. Close it, switch to workspace A, and confirm workspace A remains closed.
5. Reopen it in workspace A, reload, and confirm it remains open.

## Settings evidence

Fetch `GET /api/settings` and confirm `workspacePanelState` contains distinct
entries for both absolute workspace paths, each with `browserOpen` and
`filesOpen`. Confirm the legacy top-level keys `browserPanelOpen` and
`filesPanelDockedOpen` are absent.

Report `PASS` only when all assertions succeed. Otherwise report `FAIL` with the
first mismatched workspace, viewport/mode, expected state, actual state, and
supporting screenshot or console evidence.
