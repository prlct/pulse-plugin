# Pulse plugin

The Pulse plugin connects Claude Code and Codex to Pulse: choose the Pulse project for each repository, decide what Pulse may collect, and load the skills added to your Pulse projects.

## Install

Claude Code:

```sh
claude plugin marketplace add prlct/pulse-plugin
claude plugin install pulse@pulse
```

Codex:

```sh
codex plugin marketplace add prlct/pulse-plugin
codex plugin add pulse@pulse
```

Setup, updates and what the plugin collects: [plugins/pulse/README.md](plugins/pulse/README.md).

This repository is published automatically from the Pulse source repository, so changes made here are overwritten.
