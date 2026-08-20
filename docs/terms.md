# Terms

`agy-plugin-codex` is provided under the MIT License (see `LICENSE`), without warranty of any
kind.

Using it means running Google's Antigravity CLI against your own Antigravity account. Your
use of that CLI and that account is governed by Google's terms, not by this project, and runs
consume your account's quota.

This project is not affiliated with, endorsed by, or supported by Google, OpenAI, or Anomaly
Innovations.

Two operational points worth stating as terms rather than documentation:

- `agy_run`, `agy_continue` and `agy_rescue` are **write-capable in the directory you give
  them**. agy has no read-only permission mode, so a run that may read may also write.
- `agy_review` and `agy_adversarial_review` isolate by giving agy a disposable copy of the
  working tree. That protects the repository, not the whole filesystem: agy still writes to
  `~/.gemini/antigravity-cli` on every run, and it runs with its permission prompts skipped.

You remain responsible for reviewing anything agy produces before acting on it.
