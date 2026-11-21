# spur-macos

A Mac as the agent's body: shell commands and files, vitals and load, what the Mac is (sleep, automation grants, prompts waiting), attention and the moment, screenshots and driving any app's interface (a Swift helper does Accessibility and input), plus upkeep: the disk (what holds it, a low-disk forecast, and make_room when asked), stray processes, protected folders. On the user's own laptop (its host provides `personal`) it refuses heavy commands and driving apps unless they asked. One runs on every Mac. Widget: vitals.

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
