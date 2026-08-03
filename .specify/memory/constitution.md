<!--
Sync Impact Report
==================
Version change: (unversioned template) → 1.0.0
Rationale: first ratification for this repository. The principles are adapted
from the constitution used while omniterm was developed inside a larger private
product; this is their first adoption by the open-source host repository, so it
is an initial ratification rather than an amendment.

Principles (all five template principle slots newly filled):
  1. I. Specification Authority
  2. II. Generic Host (No Product Coupling)
  3. III. Clean Plugin Boundary (NON-NEGOTIABLE)
  4. IV. Runtime Extensibility
  5. V. Test And Evidence Discipline

Sections (both template section slots newly filled):
  - Engineering Constraints
  - Development Workflow
  - Governance filled.

Carried over but restated for this repository:
  - The plugin contract is now the published, type-only @omniterm/plugin-types;
    plugins consume it from npm and live in their own repositories.
  - Node.js 24+ (was 22+), matching `engines` in package.json.
  - Workspace layout keeps apps/*, packages/*, plugins/* — plugins/* now holds
    in-repo examples only, not shipped domain plugins.

Templates checked for alignment:
  ✅ .specify/templates/plan-template.md — its Constitution Check section is
     generic ("verify alignment with the constitution"); no principle-specific
     text required updating.
  ✅ .specify/templates/spec-template.md — no constitution-derived mandatory
     sections changed.
  ✅ .specify/templates/tasks-template.md — task categories already cover the
     testing/evidence discipline this constitution requires.
  ✅ CLAUDE.md — carries the SPECKIT pointer block only; no principle references.
  ✅ README.md / docs/prd.md — Design principles and NFR-001/002 already state
     the generic-host and clean-boundary rules consistently with Principles II
     and III.

Deferred / TODO: none.
-->

# omniterm Constitution

## Core Principles

### I. Specification Authority

- Specs are the source of truth for accepted product behavior.
- Code is an implementation artifact of the specs.
- Tests, verification reports, quality evidence, and code reviews are evidence.
- Specs are current snapshots, not historical logs; git history records history.
- When behavior changes, the relevant spec MUST be updated in the same change.
- Replaced behavior MUST be removed from the active spec once the replacement is
  accepted; a superseded note may record what changed and why.
- Unresolved spec/code/test drift MUST be reconciled, or clarified with the
  maintainer, before a feature is called done.

### II. Generic Host (No Product Coupling)

- The host (`@omniterm/host`) and SDK (`@omniterm/core`) carry no domain-specific
  behavior and no product-specific dependencies.
- Anything tied to a particular downstream domain belongs in a plugin package,
  never in the host or core.
- Rationale: the host is published for anyone to run. A dependency that only one
  consumer needs is weight every other user pays for, and a name in the host that
  only one consumer recognizes is a boundary already leaking.

### III. Clean Plugin Boundary (NON-NEGOTIABLE)

- Plugins extend the host only through the public plugin API: the `--plugin`
  loader, the `GET /api/plugins` manifest, and `HostContext` services.
- Plugins depend on the host solely through `@omniterm/plugin-types`, a
  published, **type-only** package whose imports are erased at build time. No
  plugin may import `@omniterm/core`, which is private and bundled into the host.
- No plugin may be statically imported by the host or core.
- Any plugin MUST be removable — package deleted, flag dropped — leaving the host
  building and booting with full base functionality.
- Enforced, not merely asserted: `packages/core/clean-cut-boundary.test.ts` fails
  the build if host or core names an external plugin in any import specifier, and
  it matches by shape so a plugin nobody has written yet is still covered.

### IV. Runtime Extensibility

- Plugins load at runtime by filesystem path or package name (bare names resolved
  CWD-first), compose in declaration order, and require no rebuild of the host
  client.
- Plugin UI is described by manifest data and rendered generically, so adding a
  plugin never means shipping a new host build.

### V. Test And Evidence Discipline

- New contracts (loader, manifest, `HostContext`, clean-cut) get explicit tests.
- Behavior claims MUST be backed by something executable. A test that self-skips
  when its tooling is absent MUST be reported as skipped, never as passing.
- Assertions against third-party build artifacts MUST key on behavior rather than
  on identifiers, which vendors rename without changing behavior.
- A feature is not done while known drift remains or acceptance evidence is
  missing; residual risks MUST be written down rather than left implicit.

## Engineering Constraints

- Node.js 24+, TypeScript 5 (strict mode, ESM only).
- Packaging is fully scoped under `@omniterm/*`: `@omniterm/host` (bin:
  `omniterm`) and `@omniterm/plugin-types` are published; `@omniterm/core` is
  private and bundled into the host via tsup; plugins are their own packages,
  released on their own schedules.
- Workspace layout: `apps/*` (runnable products), `packages/*` (libraries/SDK),
  `plugins/*` (in-repo example plugins — deletable, never required by the host).
- Secrets and per-deployment configuration MUST NOT live in source. Values needed
  only by an official release are injected at release-build time, so a build from
  a source checkout or a fork is inert by default.
- Client-bundle weight is a budgeted resource: vendor browser libraries are
  served from `node_modules` rather than bundled, and the entry-chunk and
  tarball-size gates are the enforcement.

## Development Workflow

- One active feature at a time, driven through the Spec Kit lifecycle
  (specify → clarify → plan → tasks → analyze → implement → verify → review).
- Cross-cutting fixes are maintenance on existing features: they reconcile the
  specs they touch and do not open a new feature entry.
- Feature IDs are stable and are not renumbered without explicit approval.
- Branch, release, PR, and merge operations require an explicit request.

## Governance

- This constitution supersedes ad-hoc practice. Complexity MUST be justified
  against the generic-host and clean-boundary principles; "it was easier" is not
  a justification for coupling.
- Amendments are documented here with a version bump and date, following semantic
  versioning: MAJOR for removing or redefining a principle, MINOR for adding or
  materially expanding one, PATCH for clarifications.
- Reviews verify compliance with these principles. Use `CLAUDE.md` for runtime
  development guidance and the active feature's plan.

**Version**: 1.0.0 | **Ratified**: 2026-08-03 | **Last Amended**: 2026-08-03
