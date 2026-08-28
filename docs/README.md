# Project documentation

This directory is the shared product and engineering memory for the companion
project. The root [`README.md`](../README.md) is the setup and usage guide;
these documents define how the product should behave and how it is delivered.

## Current documents

- [`PRODUCT.md`](PRODUCT.md) — product rules, privacy, XP, encounters, sync, and marketplace direction.
- [`DESIGN.md`](DESIGN.md) — visual language, UI boundaries, and companion presentation rules.
- [`PLAN.md`](PLAN.md) — implementation phases and acceptance criteria.
- [`ROADMAP.md`](ROADMAP.md) — shipped work, known gaps, and next engineering steps.
- [`TESTING.md`](TESTING.md) — commands and manual checks for the website, API, badge, and extension.

## Archive

[`archive/tasks/`](archive/tasks/) contains the original T1–T30 task briefs and
phase notes. They document how the prototype was built and are useful for
historical context, but the current product contract lives in the documents
above. New work should be described in `PLAN.md` and tracked in `ROADMAP.md`,
not added to the archive.

## Layout rule

The web app and browser extension live under `apps/`. Shared libraries are not
extracted into `packages/` yet; that move should happen only when a stable,
framework-independent companion-engine boundary exists.
