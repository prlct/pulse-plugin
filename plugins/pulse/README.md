# Pulse plugin for Claude Code and Codex

The Pulse plugin connects Claude Code and Codex to Pulse. You sign in once per computer, and the folder
with each project's code is connected to its Pulse project.

Pulse records which skills, tools and model your assistant uses and how many tokens, never your
conversations or code. Every hour your assistant writes a short session report in the background. Your
project managers can read it.

The plugin also loads the skills of your Pulse project (`/pulse:skills`, `$pulse:skills`), writes your daily
update as a draft in Pulse (`/pulse:daily`, `$pulse:daily`) and brings the Pulse tools for changelogs, so you
need no separate Pulse connector.

Requirements: Node.js 20 or newer.

## Install

Claude Code, in a terminal:

```sh
claude plugin marketplace add prlct/pulse-plugin
claude plugin install pulse@pulse
```

Codex, in a terminal:

```sh
codex plugin marketplace add prlct/pulse-plugin
codex plugin add pulse@pulse
```

When Codex starts, it asks you to review the Pulse hooks: accept them. If you missed that screen, open
`/hooks` and accept the three Pulse hooks. Until you do, Pulse records nothing in Codex.

## Start

1. Open the folder with your project's code in Claude Code or Codex.
2. Type `/pulse:status` (Codex: `$pulse:status`) and say **connect**.
3. Click **Allow** on the Pulse page that opens in your browser. If the browser does not open, the link is
   copied to your clipboard: paste it into your browser.
4. If the project's GitHub repository is linked to one of your Pulse projects, the folder is connected to
   it by itself, also when you just start a session there. Otherwise the assistant shows your projects:
   reply with a number.

One sign-in covers Claude Code and Codex on the same computer.

## Commands

| Claude Code            | Codex                  | What it does                                               |
| ---------------------- | ---------------------- | ---------------------------------------------------------- |
| `/pulse:status`        | `$pulse:status`        | Sign-in, project and reports. Also connect and disconnect. |
| `/pulse:project`       | `$pulse:project`       | Change the Pulse project of this folder.                   |
| `/pulse:skills`        | `$pulse:skills`        | List the skills of this project in Pulse.                  |
| `/pulse:skills <name>` | `$pulse:skills <name>` | Run a project skill for your task.                         |
| `/pulse:daily`         | `$pulse:daily`         | Write today's update, save it as a draft in Pulse.         |
| `/pulse:help`          | `$pulse:help`          | The command list.                                          |

To sign out of Pulse on this computer, say **disconnect**. It signs out Claude Code and Codex.

## What Pulse records

For every member of a project who uses the plugin (guests are not recorded), once per assistant turn:

- when the turn started and ended, with session ids that cannot be traced back to your session;
- the project and, when Pulse linked the folder's GitHub repository to it, the repository and branch;
- the assistant (Claude Code or Codex), the model and the token counts;
- the names and counts of the tools, MCP servers and skills used, and for a Pulse project skill its
  version, outcome and duration.

The hooks never send your prompts, the conversation, code, file contents, secrets, tool arguments or tool
output.

### Session reports

About once an hour, and when a Claude Code session ends, the plugin starts a short background run of your
own assistant (`claude -p` or `codex exec`) in an empty folder, with its tools turned off: it cannot run
commands, change files or browse the web, and it loads no MCP servers. Claude Code conversations go only to
Claude Code, and Codex conversations only to Codex. The run gets your prompts and the assistant's replies of
that hour (not tool calls, command output or their results, at most about 60,000 characters, newest first)
and writes a short report: progress, blockers, decisions and suggestions, without code, file names, paths or
secrets. Only that report is sent to Pulse. If the hour had nothing new, nothing is sent. If the run fails,
a later one covers the same hour.

If a new Claude Code or Codex version saves conversations in a way Pulse cannot read yet, reports from that
assistant are held: Pulse status says so, and the Pulse team is told (only the assistant and its version).
Reports from it resume after a Pulse update.

## Updating

When Pulse has a newer plugin, your assistant asks "Pulse has an update. Update now?" and runs the update
command when you say yes. The command is also copied to your clipboard. You can run it yourself:

- Claude Code: `claude plugin marketplace update pulse && claude plugin update pulse@pulse`. Then run
  `/reload-plugins` in each open Claude Code session, or restart them. Open sessions keep the old plugin.
- Codex: `codex plugin marketplace upgrade pulse`. Then restart each open Codex session, because open sessions
  keep the old plugin. When Codex starts, accept the Pulse hooks.

A plugin older than the version Pulse needs sends nothing until you update. What it recorded waits on this
computer and is sent after the update.

## Settings

- `PULSE_API_URL`: the Pulse server (default `https://api.paralect.ai`). Only `api.paralect.ai`,
  `staging.paralect.ai` and `localhost` are accepted unless `PULSE_ALLOW_CUSTOM_API=1` is set. For any
  other server the plugin shows a warning and does not open the browser by itself.
- `PULSE_HOME`: where the plugin keeps its files (default `~/.config/pulse`, readable only by you).
- `PULSE_NO_BROWSER=1`: never open the browser or copy to the clipboard.

## What the plugin cannot prevent

An assistant that you allow to run any shell command runs as you: it can read the sign-in in
`~/.config/pulse` and call Pulse with it. Approve shell commands that touch `~/.config/pulse` or
`pulse.mjs` only if you meant to. To cut the plugin off, sign out, or click **Disconnect plugin** in Pulse
**Settings**.

## For maintainers

The plugin is developed in a private repository and published to `prlct/pulse-plugin` automatically; the
published branch is set by the `PULSE_PLUGIN_BRANCH` repository variable.

Run the Pulse API on `http://localhost:3001`, then:

```sh
PULSE_API_URL=http://localhost:3001 claude --plugin-dir ./plugins/pulse
codex plugin marketplace add /path/to/pulse-v2 && codex plugin add pulse@pulse && PULSE_API_URL=http://localhost:3001 codex
```

Use `PULSE_HOME=/tmp/pulse-dev` to keep test sign-ins apart. Checks (the tests are not published):

```sh
node --test plugins/pulse/test/*.test.mjs
claude plugin validate ./plugins/pulse --strict
```

The CLI (`node scripts/pulse.mjs help | login | logout | status | project [list | bind <n>] | skills [<slug>] | daily [save <markdown>] | flush`)
runs the same commands as the `pulse_*` tools. Hooks: Claude Code `SessionStart`, `UserPromptSubmit`,
`PostToolUse`, `UserPromptExpansion`, `Stop`, `SessionEnd`; Codex `SessionStart`, `PostToolUse`, `Stop`.
They always exit 0, log their own errors (never payload contents) to `pulse.log`, upload in a detached
`pulse.mjs flush`, and start the report writer as a detached `pulse.mjs report-writer` when a report is
due. The writer runs `claude --safe-mode -p --tools "" --disallowedTools "mcp__*" --strict-mcp-config
--mcp-config '{"mcpServers":{}}' --no-session-persistence --output-format json` or `codex exec
--ignore-user-config --sandbox read-only --skip-git-repo-check --ephemeral --disable <each tool feature>
-c web_search="disabled" -o <file> -` (the feature list is `CODEX_TOOL_FEATURES` in `scripts/lib/writer.mjs`) with
`PULSE_REPORT_WRITER=1`, under which every Pulse hook exits at once; one writer runs per person and
project at a time.
