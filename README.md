# spur-macos

A Mac as the agent's body: shell commands, files, vitals and load, attention and the moment, screenshots and driving any app's interface (a Swift helper does Accessibility and input), plus upkeep: stray processes, protected folders. One runs on every Mac. Widgets: vitals and a glance at the screen, in Home.

A [Switch](https://switch.ax) spur, built on [spur-kit](https://github.com/zachsents/spur-kit).

## Install

Ask Switch's agent to install `github:zachsents/spur-macos`, or add it in the desktop's Spurs view
(⌘K, Spurs). Switch runs it on the first machine with what it needs.

## Permissions

Accessibility, Screen Recording and Full Disk Access belong to the app the host runs under.

## Develop

```sh
bun install
bun run check
bun start   # serves MCP on stdio
```
