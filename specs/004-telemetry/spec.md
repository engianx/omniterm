# Feature Specification: Built-in Telemetry (Usage + Performance)

**Feature Branch**: `004-telemetry`

**Created**: 2026-06-14

**Status**: Implemented

**Input**: Add built-in pseudonymous usage analytics and performance metrics,
reporting to the maintainers' analytics destination via PostHog Cloud.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Maintainers gain pseudonymous usage & performance visibility (Priority: P1)

As the omniterm maintainer team, we need pseudonymous, aggregate insight into how
installed instances are used and how they perform, so we can prioritize features
and catch performance regressions across real-world installs — without ever
collecting user-identifying or content data.

**Why this priority**: This is the core reason for the feature. Without
outbound, aggregatable signals the team is blind to adoption and regressions.
Everything else (privacy controls, local view) exists to make this shippable
and trustworthy.

**Independent Test**: Run an instance with telemetry enabled, perform a few
actions (start server, create/adopt/close a session, open a file), and confirm
the corresponding events — including the performance timings — arrive in the
analytics destination, attributed to a stable pseudonymous installation id.

**Acceptance Scenarios**:

1. **Given** telemetry is enabled and a network is available, **When** a user creates a terminal session, **Then** a "session created" event is recorded with its timing breakdown (total, tmux, adopt) and a pseudonymous installation id.
2. **Given** telemetry is enabled, **When** the server starts and later shuts down, **Then** a "server started" event (with session count) is recorded and any buffered events are flushed before exit.
3. **Given** the analytics destination is unreachable, **When** events are produced, **Then** the application continues to function normally and no error surfaces to the user.

---

### User Story 2 - Users control and can refuse telemetry (Priority: P1)

As someone running omniterm on my own machine or server, I must be able to know
telemetry exists and turn it off completely, and it must never run in sensitive
automated contexts.

**Why this priority**: omniterm is a locally installed dev tool; telemetry was
deliberately stripped during porting to avoid any outbound calls. Re-introducing
it is only acceptable if the off-switches are first-class and honored. Legally
and ethically this ships *with* P1, not after it.

**Independent Test**: Set each opt-out signal in turn (a standard "do not track"
environment signal, the product's own opt-out setting, no destination configured,
and an automated/test context) and confirm zero outbound telemetry network
activity in each case while the app otherwise works.

**Acceptance Scenarios**:

1. **Given** the standard do-not-track signal is set, **When** the app runs, **Then** no telemetry is initialized and no outbound telemetry calls occur.
2. **Given** the user has set the product's telemetry opt-out, **When** the app runs, **Then** no outbound telemetry calls occur and the choice persists across restarts.
3. **Given** the app runs in an automated test / CI context, **When** it starts, **Then** telemetry stays off by default.
4. **Given** no analytics destination is configured in the build, **When** the app runs, **Then** telemetry is inert (no-op) rather than erroring.
5. **Given** a fresh install, **When** the app first runs with telemetry enabled, **Then** the user is shown a one-time disclosure of what is collected and how to opt out.
6. **Given** the user runs the CLI opt-out command (or toggles the Settings UI control), **When** the choice is saved, **Then** it persists across restarts and both surfaces reflect the same state.
7. **Given** telemetry is enabled, **When** the user opens an existing workspace session for the first time after a server restart, **Then** a `terminal_rendered` event with `render_ms` is recorded (so the slow first-open is measurable), and **When** the user opts out, **Then** the browser sends no further events.

---

### User Story 3 - Local performance visibility for the operator (Priority: P3)

As an operator, I want to see recent performance timings for my own instance
without depending on any external service or having telemetry enabled.

**Why this priority**: Useful for self-diagnosis and dogfooding, and it makes
the perf data valuable even for users who opt out of phone-home. Lower priority
because it is not the primary business driver.

**Independent Test**: With telemetry disabled, trigger session operations and
confirm the local performance endpoint returns the most recent timing records.

**Acceptance Scenarios**:

1. **Given** several session operations have occurred, **When** the local performance metrics endpoint is queried, **Then** it returns the most recent timing records (bounded to a fixed maximum).
2. **Given** telemetry is opted out, **When** session operations occur, **Then** local performance records are still collected and queryable (local collection is independent of phone-home).

---

### Edge Cases

- **No network / destination down**: events are dropped or retried without blocking or surfacing errors; the user never sees a telemetry failure.
- **Opt-out toggled mid-run**: once opted out, no further outbound events are sent within the same run (next start is fully inert).
- **Missing/blank destination key**: telemetry is inert; the app behaves exactly as the current no-op build.
- **First-run id creation race**: concurrent instances converge on a single persisted pseudonymous id rather than generating duplicates that fragment data.
- **Long-running instance**: the local performance buffer is bounded (oldest records evicted) so memory does not grow without limit.
- **Conflicting signals**: if any opt-out signal is present, it wins over "enabled" (fail-closed toward privacy).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST record pseudonymous usage events for the already-instrumented actions: server started (with session count), session created, session adopted, session closed, file opened (by language), and cleanup (by count).
- **FR-002**: The system MUST attach performance timing data to the relevant events — session created (total, tmux, adopt durations) and session adopted (total, allocate-port duration).
- **FR-003**: The system MUST attribute events to a stable, randomly generated pseudonymous installation identifier persisted locally. Event payloads MUST NOT include names, hostnames, file paths, repository names, session names, plugin identifiers, or file/terminal contents. Server and browser capture MUST disable GeoIP enrichment; the destination still receives normal network transport data.
- **FR-004**: The system MUST keep recent performance timings in a bounded local store and expose them via the existing local performance metrics endpoint, independent of whether phone-home telemetry is enabled.
- **FR-005**: The system MUST send usage and performance telemetry to the configured analytics destination only when telemetry is enabled.
- **FR-006**: The system MUST treat telemetry as disabled when any of the following hold: the standard do-not-track signal is set, the product's own opt-out setting is enabled, no analytics destination is configured, or the process runs in an automated test/CI context. Opt-out signals MUST take precedence over enablement.
- **FR-007**: The system MUST persist the user's telemetry opt-out choice so it survives restarts, stored in the shared settings store so the CLI and Settings UI read/write the same value.
- **FR-008**: The system MUST show a one-time disclosure on first run (when telemetry is enabled) describing what is collected and how to opt out, and MUST document the same in user-facing docs.
- **FR-009**: Telemetry failures (network errors, destination unavailable, serialization issues) MUST NOT affect application behavior or surface errors to the user; collection is best-effort.
- **FR-010**: The system MUST flush any buffered telemetry on graceful shutdown within a bounded time, and MUST not delay shutdown beyond that bound if flushing stalls.
- **FR-011**: The analytics destination region MUST be configurable (e.g., US vs EU) at build/configuration time.
- **FR-012**: When telemetry is disabled, the system MUST make zero outbound telemetry network calls.
- **FR-013**: The system MUST provide a CLI surface to view and persistently change the telemetry opt-out — a status command, an off/on command that saves the choice, and a flag to disable telemetry for a single run.
- **FR-014**: The system MUST expose the telemetry opt-out in the Settings UI (a Privacy control), backed by the **same** persisted setting the CLI writes, so the two surfaces stay consistent.
- **FR-015**: The system MUST capture a curated set of **front-end** events covering key user actions (app loaded, workspace switched, tab opened/closed, panel toggled, file opened in the editor, plugin tab opened) and key client performance metrics (app load time, terminal first-open render time), with no names, paths, repo/session/plugin identifiers, or contents and **no DOM autocapture, pageviews, or session recording**.
- **FR-016**: Front-end telemetry MUST be gated by the **same** opt-out as the server (one `telemetryEnabled` + env signals). Because the browser can't read server env, the client MUST obtain the resolved enabled/key/host decision from the server and initialize only when enabled; turning telemetry off in Settings MUST stop client capture live.
- **FR-017**: Front-end and server events MUST share the one pseudonymous installation id (no server-vs-frontend split), and the system MUST NOT differentiate logging beyond a `surface` marker. The front-end MUST refuse to arm without a `distinctId` from the gate (events without one would be untieable to the install).

### Key Entities *(include if feature involves data)*

- **Telemetry Event**: a named, pseudonymous record of an action, carrying the installation id, a small reviewed property set, optional timing data, and a timestamp.
- **Pseudonymous Installation ID**: a randomly generated identifier created once and persisted in a local per-user config location. It is not derived from account or machine attributes, but it correlates events from the same installation.
- **Performance Metric Record**: an operation name plus its timing breakdown, retained in a bounded local buffer.
- **Telemetry Configuration / State**: the resolved enabled/disabled decision derived from opt-out signals, the persisted opt-out choice, and the configured destination/region.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With telemetry enabled and a network available, 100% of the six instrumented actions produce their corresponding events, and session create/adopt events include their timing data.
- **SC-002**: With any single opt-out signal present (do-not-track, product opt-out, no destination configured, or CI/test context), a network capture shows **zero** outbound telemetry requests.
- **SC-003**: Enabling telemetry adds no user-perceptible latency — server start and graceful shutdown each stay within their current bounds (shutdown flush capped at a fixed small timeout).
- **SC-004**: An audit of every emitted event payload finds no names, hostnames, file paths, repository names, session/plugin identifiers, or content — only the pseudonymous id, approved action metadata, timings, and `$geoip_disable: true` on direct browser captures.
- **SC-005**: A first run with telemetry enabled shows the disclosure notice exactly once; subsequent runs do not repeat it.
- **SC-006**: The local performance endpoint returns the most recent timing records (up to the fixed buffer size) regardless of telemetry opt-out state.

## Assumptions

- **Analytics provider**: PostHog Cloud (US region) is the chosen destination. Its project key is a public, write-only ingestion key. It is **not** committed to the repository: the release workflow injects it into the published bundle at build time from a `POSTHOG_KEY` repository secret, so a source or fork build has no key and sends nothing. (Provider choice is an implementation/deployment detail; the spec's requirements are provider-agnostic.)
- **Instrumentation exists**: the event call sites and taxonomy already exist in the codebase as no-op stubs; this feature implements the backend, not new instrumentation.
- **Default posture**: telemetry is enabled by default for normal interactive installs but fail-closed (off) whenever any opt-out signal is present or no destination is configured.
- **Local config location**: a standard per-user config directory is used to persist the anonymous id and opt-out choice.
- **Pseudonymous only**: no accounts, login, or user identification is introduced; there is no server-side join to another identity.

## Non-Goals

- Self-hosting the analytics backend (vendor cloud is acceptable).
- Adding names, location enrichment, or content data to event payloads (file contents, terminal output, paths, repo names, hostnames, session names, or plugin identifiers).
- Real-time per-request APM or high-frequency metrics; this is coarse, low-volume product + perf telemetry.
- A full in-product analytics dashboard UI beyond the existing local performance endpoint.
