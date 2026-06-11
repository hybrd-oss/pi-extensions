# Pi Multitask Release Checklist

Use this checklist before publishing `@mbattagl/pi-orchestrator` or submitting it for package-gallery discovery.

## 1. Source and metadata

- [ ] `pi-orchestrator/package.json` has the intended package name, version, description, license, repository, and `pi-package` keyword.
- [ ] `pi-orchestrator/package.json` `pi.extensions` points to `./extensions` and `pi.prompts` points to `./prompts`.
- [ ] Package gallery preview metadata is present: `pi.image` points to the raw PNG at `assets/pi-multitask-gallery.png`.
- [ ] If the repository owner, branch, or package path changes, update `homepage`, `repository.directory`, and `pi.image`.
- [ ] `files` allowlist includes only publishable runtime/docs assets: `README.md`, `extensions/`, `src/`, `prompts/`, `agents/`, `docs/`, and `assets/pi-multitask-gallery.png`.

## 2. Documentation readiness

- [ ] README explains the value proposition: persistent local Pi workers, isolated git worktrees, deterministic review, integration worktree, and explicit apply.
- [ ] README differentiates Pi Multitask from `pi-subagents`, Taskplane, and `pi-crew`.
- [ ] README documents install, quickstart, examples, update/remove, troubleshooting, recovery, and cleanup.
- [ ] README documents trust boundaries:
  - [ ] Pi packages/extensions run with full system access.
  - [ ] Workers do not receive multitask orchestration tools by default.
  - [ ] Project-local agent definitions require approval/opt-in.
  - [ ] Named startup/validation scripts must be selected explicitly.
  - [ ] Worktree creation fails closed rather than running isolated work in the foreground checkout.
  - [ ] `multitask_apply` requires explicit approval and a clean foreground checkout by default.
  - [ ] Cleanup/prune commands support dry-run previews.
- [ ] README documents recovery commands: `/mt-status`, `/mt-doctor`, `/mt-resume`, and `/mt-send --restart`.

## 3. No-credit validation

Run from the repository root:

```bash
npm run test:multitask-no-credit
```

Expected:

- [ ] Passes without API keys or subscriptions.
- [ ] Does not spawn real LLM-backed Pi workers.
- [ ] Covers scheduler, spawn/provisioning, messages, recovery, deterministic review, doctor/export/prune, and package-safe status paths.

## 4. Mock smoke validation

Run from the repository root:

```bash
npm run test:orchestrator-smoke
```

Expected:

- [ ] Passes using mock workers.
- [ ] Uses only disposable temporary repositories/worktrees.
- [ ] Exercises start/status/message/review/merge/apply/cleanup behavior enough to catch package-breaking regressions.

## 5. Package dry-run

Run either command:

```bash
npm run pack:orchestrator-dry-run
# or
cd pi-orchestrator && npm run pack:dry-run
```

Expected included files:

- [ ] `package.json`
- [ ] `README.md`
- [ ] `extensions/orchestrator.ts`
- [ ] `src/**`
- [ ] `prompts/**`
- [ ] `agents/**`
- [ ] `docs/release-checklist.md`
- [ ] `assets/pi-multitask-gallery.png`

Expected excluded files:

- [ ] `test/**`
- [ ] repo-level `specs/**`
- [ ] `.pi/**` runtime state
- [ ] `.git/**`
- [ ] temporary multitask worktrees or exported run bundles

Keep the dry-run output in the release notes or PR description.

## 6. Install/update/remove verification

Use a disposable Pi profile or project when possible.

### Local path package

From the repository root:

```bash
pi -e ./pi-orchestrator
pi install ./pi-orchestrator
pi list
pi update ./pi-orchestrator
pi remove ./pi-orchestrator
```

Expected:

- [ ] `pi -e ./pi-orchestrator` loads the extension for one session.
- [ ] `pi install ./pi-orchestrator` records the local package in settings.
- [ ] `/reload` or a fresh `pi` session shows the multitask commands.
- [ ] `pi update ./pi-orchestrator` completes without changing unrelated packages.
- [ ] `pi remove ./pi-orchestrator` removes the package entry.

### npm package, after publishing

```bash
pi install npm:@mbattagl/pi-orchestrator
pi list
pi update npm:@mbattagl/pi-orchestrator
pi remove npm:@mbattagl/pi-orchestrator
```

Expected:

- [ ] Published install loads only the intended extension/prompts from this package.
- [ ] Pinned installs such as `npm:@mbattagl/pi-orchestrator@0.1.0` are skipped by broad `pi update --extensions` as documented by Pi.
- [ ] Remove uses the same npm package identity.

## 7. Optional real Pi E2E smoke

Real Pi E2E is credit-consuming and must remain gated behind `PI_MULTITASK_REAL_E2E=1`.

```bash
PI_MULTITASK_REAL_E2E=1 npm run test:multitask-real
```

Before running:

- [ ] Use a disposable git repository.
- [ ] Confirm the active model/provider can run `pi --mode rpc` workers.
- [ ] Confirm API/subscription credit usage is acceptable.
- [ ] Confirm no private project secrets are part of the fixture.

Expected:

- [ ] Starts at least one real worker.
- [ ] Sends a follow-up or steer message.
- [ ] Runs deterministic review.
- [ ] Merges into integration.
- [ ] Applies only after explicit approval in the disposable checkout.
- [ ] Cleans up worktrees/state after a dry-run preview.

If this optional test is skipped, note why in the release notes.

## 8. Final publish steps

- [ ] Bump version in `pi-orchestrator/package.json`.
- [ ] Re-run no-credit, smoke, package dry-run, and any selected real E2E.
- [ ] Review `npm pack --dry-run` output one last time.
- [ ] Publish from `pi-orchestrator/` with the intended npm account/access settings.
- [ ] Install the published package in a fresh Pi environment and run `/mt-status`, `/mt-doctor`, and a small mock/disposable run.
- [ ] Tag the repository and attach dry-run/test evidence to the release notes.
