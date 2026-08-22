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
  them**. This plugin invokes agy 1.1.18 with permission prompts skipped, so those direct
  runs have write-capable tool access.
- `agy_review` and `agy_adversarial_review` isolate by giving agy a disposable copy of the
  working tree. That protects the repository, not the whole filesystem: the agy 1.1.16 probes
  observed writes to `~/.gemini/antigravity-cli`, and reviews run agy 1.1.18 with permission
  prompts skipped.

You remain responsible for reviewing anything agy produces before acting on it.
