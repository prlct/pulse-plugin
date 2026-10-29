# Pulse plugin

The Pulse plugin connects Claude Code and Codex to Pulse: one sign-in, and the folder with each project's code is connected to its Pulse project. Pulse records which skills, tools and model your assistant uses and how many tokens, never your conversations or code. Every hour your assistant writes a short session report in the background. Your project managers can read it. Also loads your project's Pulse skills and the Pulse tools for daily updates and changelogs.

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
