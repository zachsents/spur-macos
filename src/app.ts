// The Mac as the agent's body, ported from Switchboard's sb-macos: commands, files, vitals,
// attention, the moment, screenshots and driving any app's interface, plus the upkeep that was
// grown beside it (strays from proc-sweep, protected folders from tcc-guard, whose load from
// load-owners). One runs on every Mac, as `macos-<machine>`. Accessibility, Screen Recording and
// Full Disk Access are the host app's, which this runs under.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import type { Stats } from "node:fs"
import { appendFile, readFile, writeFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"

import { AppEvents, answer, defineApp, defineEvent, HOME, SWITCH_CATALOG, tool } from "spur-kit"
import { capture, hands } from "./hands.ts"
import { load, noteDisk } from "./load.ts"
import { check, grants } from "./protected.ts"
import * as strays from "./strays.ts"
import { alerts, notable, read, reading } from "./vitals.ts"
import type { Reading } from "./vitals.ts"

export const machine = process.env.SWITCH_MACHINE ?? hostname().split(".")[0] ?? "mac"
const dir = process.cwd()
const OFF = path.join(dir, "attention-off")
const RULES = path.join(dir, "strays.json")

// Events, versioned.

export const Vitals = defineEvent("macos.vitals", 1, reading)

export const Attention = defineEvent(
  "macos.attention",
  1,
  Schema.Struct({
    machine: Schema.String,
    /** Following what's in front; off, only whether the user is here. */
    tracking: Schema.Boolean,
    /** Input in the last two minutes, and the screen open. */
    active: Schema.Boolean,
    locked: Schema.Boolean,
    app: Schema.optionalKey(Schema.String),
    bundle: Schema.optionalKey(Schema.String),
    window: Schema.optionalKey(Schema.String),
  }),
)

export const Permissions = defineEvent(
  "macos.permissions",
  1,
  Schema.Struct({
    machine: Schema.String,
    accessibility: Schema.Boolean,
    screenRecording: Schema.Boolean,
    fullDiskAccess: Schema.Boolean,
  }),
)

export const StraysStopped = defineEvent(
  "macos.strays_stopped",
  1,
  Schema.Struct({
    machine: Schema.String,
    stopped: Schema.Array(
      Schema.Struct({ pid: Schema.Finite, kind: Schema.String, what: Schema.String }),
    ),
  }),
)

// Plain async work as a tool's effect: its error's message is what went wrong.
const task = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })

const expand = (p: string) => (p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p)

// Attention: what's in front, kept as it changes.

const IDLE_S = 120
const HISTORY = 20
const OWN_INPUT_MS = 1000
const CHROMIUM = new Set([
  "com.google.Chrome",
  "com.google.Chrome.canary",
  "com.google.Chrome.beta",
  "org.chromium.Chromium",
  "com.brave.Browser",
  "com.microsoft.edgemac",
  "company.thebrowser.Browser",
  "com.vivaldi.Vivaldi",
])
/** Switch's own window, by its app's name (a dev build is "Switch-dev"). */
const isSwitch = (app: string) => app === "Switch" || app.startsWith("Switch-")

interface Glance {
  readonly app: string
  readonly bundle: string
  readonly pid: number
  readonly window?: string
  readonly at: number
}

const str = (v: unknown) => (typeof v === "string" ? v : "")
const num = (v: unknown) => (typeof v === "number" ? v : 0)
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? { ...v } : {}

let current: Glance | null = null
const history: Glance[] = []
let posted = 0
let person: number | null = null

/** Seconds since the user's last input, not counting keys this spur posted for the agent. */
const idleOf = (idle: number) => {
  const latest = Date.now() - idle * 1000
  const own = posted > 0 && Math.abs(latest - posted) <= OWN_INPUT_MS
  const at = own ? (person ?? 0) : latest
  person = at
  return Math.max(0, (Date.now() - at) / 1000)
}

const glance = async () => {
  const g = obj(await hands("glance"))
  const bundle = str(g.bundle)
  // A browser's window title is its tab's, which may be a private one: only its app is known.
  const window = CHROMIUM.has(bundle) ? undefined : str(g.window) || undefined
  const seen: Glance = {
    app: str(g.app),
    bundle,
    pid: num(g.pid),
    ...(window === undefined ? {} : { window }),
    at: Date.now(),
  }
  return {
    seen,
    idle: idleOf(num(g.idle)),
    locked: g.locked === true,
    trusted: g.trusted === true,
  }
}

const tracking = () => !existsSync(OFF)

const strip = ({ pid: _, ...g }: Glance) => g

const samePlace = (a: Glance | null, b: Glance) =>
  a !== null && a.bundle === b.bundle && a.window === b.window

const watchAttention = Effect.gen(function* watching() {
  const events = yield* AppEvents
  let last = ""
  let lastAt = 0
  for (;;) {
    yield* Effect.sleep("2 seconds")
    const looked = yield* Effect.option(task(glance))
    if (looked._tag === "None") {
      continue
    }
    const { seen, idle, locked } = looked.value
    const on = tracking()
    const active = idle < IDLE_S && !locked
    if (on && !samePlace(current, seen)) {
      history.push(seen)
      history.splice(0, Math.max(0, history.length - HISTORY))
    }
    current = on ? seen : null
    const payload = {
      machine,
      tracking: on,
      active,
      locked,
      ...(on && seen.app !== "" ? { app: seen.app, bundle: seen.bundle } : {}),
      ...(on && seen.window !== undefined ? { window: seen.window } : {}),
    }
    const key = JSON.stringify(payload)
    // Presence and the lock count at once; titles that tick, once per five seconds.
    if (key === last || (!stateChanged(last, payload) && Date.now() - lastAt < 5000)) {
      continue
    }
    last = key
    lastAt = Date.now()
    yield* events.emit(Attention.make(payload)).pipe(Effect.ignore)
  }
})

const stateChanged = (
  was: string,
  now: { readonly tracking: boolean; readonly active: boolean; readonly locked: boolean },
) => {
  const parsed = obj(was === "" ? null : JSON.parse(was))
  return (
    parsed.tracking !== now.tracking || parsed.active !== now.active || parsed.locked !== now.locked
  )
}

// Vitals: read every minute, an event every five or when something worth a glance changes.

let latest: Reading | null = null

const watchVitals = Effect.gen(function* watching() {
  const events = yield* AppEvents
  let sent: Reading | null = null
  let sentAt = 0
  for (;;) {
    const r = yield* Effect.option(task(async () => await read(machine)))
    if (r._tag === "Some") {
      latest = r.value
      noteDisk(r.value.diskFreeGb)
      if (notable(sent, r.value) || Date.now() - sentAt >= 300_000) {
        sent = r.value
        sentAt = Date.now()
        yield* events.emit(Vitals.make(r.value)).pipe(Effect.ignore)
      }
    }
    yield* Effect.sleep("1 minute")
  }
})

// Permissions, as they change.

const access = async () => {
  const a = obj(await hands("access"))
  return {
    machine,
    accessibility: a.accessibility === true,
    screenRecording: a.screenRecording === true,
    fullDiskAccess: grants().fullDiskAccess === true,
  }
}

const watchPermissions = Effect.gen(function* watching() {
  const events = yield* AppEvents
  let last = ""
  for (;;) {
    const a = yield* Effect.option(task(access))
    if (a._tag === "Some" && JSON.stringify(a.value) !== last) {
      last = JSON.stringify(a.value)
      yield* events.emit(Permissions.make(a.value)).pipe(Effect.ignore)
    }
    yield* Effect.sleep("5 minutes")
  }
})

// Strays, swept every five minutes.

const sweep = async () => {
  const found = await strays.find(RULES)
  return await strays.stop(found.filter((s) => s.stopInS === 0))
}

const watchStrays = Effect.gen(function* watching() {
  const events = yield* AppEvents
  for (;;) {
    yield* Effect.sleep("5 minutes")
    const stopped = yield* Effect.option(task(sweep))
    if (stopped._tag === "Some" && stopped.value.length > 0) {
      const list = stopped.value.map((s) => ({ pid: s.pid, kind: s.kind, what: s.what }))
      yield* events.emit(StraysStopped.make({ machine, stopped: list })).pipe(Effect.ignore)
    }
  }
})

/** What this spur does on its own while it runs. */
export const watch = Effect.all([watchAttention, watchVitals, watchPermissions, watchStrays], {
  concurrency: "unbounded",
  discard: true,
})

// Tools.

const MAX_OUTPUT = 30_000

const clipOutput = (text: string) =>
  text.length <= MAX_OUTPUT
    ? text
    : `${text.slice(0, 10_000)}\n… ${text.length - MAX_OUTPUT} characters cut …\n${text.slice(-20_000)}`

const exec = tool(
  "exec",
  {
    description:
      "Run a shell command on this Mac (zsh, login environment), in its own process group: a timeout stops everything it started. Output is its head and tail when long.",
    input: Schema.Struct({
      command: Schema.String,
      cwd: Schema.optionalKey(Schema.String),
      timeout_s: Schema.optionalKey(Schema.Finite),
      env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  },
  (input) =>
    task(async () => {
      const started = Date.now()
      const proc = Bun.spawn(["/bin/zsh", "-lc", input.command], {
        cwd: expand(input.cwd ?? "~"),
        env: { ...process.env, ...input.env, SWITCH_EXEC: crypto.randomUUID() },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      })
      const limit = Math.min(Math.max(1, input.timeout_s ?? 120), 3600) * 1000
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          process.kill(-proc.pid, "SIGKILL")
        } catch {
          proc.kill("SIGKILL")
        }
      }, limit)
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      clearTimeout(timer)
      return {
        code,
        ...(timedOut ? { timedOut: true } : {}),
        ms: Date.now() - started,
        stdout: clipOutput(out),
        ...(err === "" ? {} : { stderr: clipOutput(err) }),
      }
    }),
)

const IMAGE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}
const MAX_TEXT = 256 * 1024

const readFileTool = tool(
  "read_file",
  {
    description:
      "Read a file on this Mac: text (from `offset`, at most `limit` bytes, 256 KB by default) or an image, shown.",
    readOnly: true,
    input: Schema.Struct({
      path: Schema.String,
      offset: Schema.optionalKey(Schema.Finite),
      limit: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    task(async () => {
      const p = expand(input.path)
      const mime = IMAGE[path.extname(p).toLowerCase()]
      const bytes = await readFile(p)
      if (mime !== undefined) {
        return answer({ path: p, size: bytes.length }, [
          { type: "image", data: bytes.toString("base64"), mimeType: mime },
        ])
      }
      const from = Math.max(0, input.offset ?? 0)
      const part = bytes.subarray(from, from + Math.min(input.limit ?? MAX_TEXT, MAX_TEXT))
      if (part.includes(0)) {
        throw new Error(`Binary, ${bytes.length} bytes`)
      }
      return { text: part.toString("utf-8"), size: bytes.length, from, to: from + part.length }
    }),
)

const writeFileTool = tool(
  "write_file",
  {
    description: "Write text to a file on this Mac, making its folders; `append` adds to the end.",
    input: Schema.Struct({
      path: Schema.String,
      text: Schema.String,
      append: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) =>
    task(async () => {
      const p = expand(input.path)
      mkdirSync(path.dirname(p), { recursive: true })
      await (input.append === true ? appendFile(p, input.text) : writeFile(p, input.text))
      return { path: p, size: statSync(p).size }
    }),
)

const kindOf = (s: Stats) => {
  if (s.isDirectory()) {
    return "folder"
  }
  if (s.isSymbolicLink()) {
    return "link"
  }
  return "file"
}

const listFiles = tool(
  "list_files",
  {
    description: "A folder's entries on this Mac: name, kind, size and when modified. At most 500.",
    readOnly: true,
    input: Schema.Struct({ path: Schema.String }),
  },
  (input) =>
    task(async () => {
      const p = expand(input.path)
      const names = readdirSync(p).toSorted().slice(0, 500)
      const entries = names.map((name) => {
        try {
          const s = statSync(path.join(p, name))
          return { name, kind: kindOf(s), size: s.size, modified: s.mtime.toISOString() }
        } catch {
          return { name, kind: "unreadable" }
        }
      })
      return await Promise.resolve({ path: p, entries })
    }),
)

const statFile = tool(
  "stat_file",
  {
    description: "Whether a path on this Mac exists, and its kind, size, times and mode.",
    readOnly: true,
    input: Schema.Struct({ path: Schema.String }),
  },
  (input) =>
    task(async () => {
      const p = expand(input.path)
      if (!existsSync(p)) {
        return { path: p, exists: false }
      }
      const s = statSync(p)
      return await Promise.resolve({
        path: p,
        exists: true,
        kind: kindOf(s),
        size: s.size,
        modified: s.mtime.toISOString(),
        created: s.birthtime.toISOString(),
        mode: (s.mode % 0o1_0000).toString(8),
      })
    }),
)

const line = (r: Reading) => {
  const parts = [`CPU ${Math.round(r.cpu)}%`, `Mem ${r.memoryPct}%`]
  if (r.battery !== undefined && (r.battery.onBattery || r.battery.pct < 100)) {
    parts.push(`Bat ${r.battery.pct}%`)
  }
  parts.push(`${Math.round(r.diskFreeGb)} GB`)
  return parts.join(" · ")
}

const vitals = tool(
  "vitals",
  {
    description:
      "This Mac's vitals now: load, CPU, memory and its pressure, swap, free disk, battery.",
    readOnly: true,
  },
  () =>
    task(async () => {
      const r = latest ?? (await read(machine))
      const found = alerts(r)
      // `label`, `value` and `alert` are the widget's line.
      return { ...r, alerts: found, label: machine, value: line(r), alert: found.length > 0 }
    }),
)

const loadTool = tool(
  "load",
  {
    description:
      "Whose load this Mac carries: each owner (app, Claude Code session, program) with its CPU and memory footprint, heaviest first; and the disk, free and how fast it's falling.",
    readOnly: true,
    input: Schema.Struct({ top: Schema.optionalKey(Schema.Finite) }),
  },
  (input) => task(async () => await load(input.top ?? 12)),
)

const attention = tool(
  "attention",
  {
    description:
      "Whether this Mac follows what's in front of the user (app and window). With `on`, turn it on or off; off, only whether they're here is known.",
    input: Schema.Struct({ on: Schema.optionalKey(Schema.Boolean) }),
  },
  (input) =>
    task(async () => {
      if (input.on === false) {
        writeFileSync(OFF, "")
        current = null
        history.length = 0
      } else if (input.on === true) {
        rmSync(OFF, { force: true })
      }
      return await Promise.resolve({ on: tracking() })
    }),
)

const moment = tool(
  "moment",
  {
    description:
      "What the user is doing on this Mac now: the app and window in front (what was before Switch, if Switch is), what's focused and selected there, the last places they went, how long since their last input, whether the screen is locked. Secure fields are never read.",
    readOnly: true,
  },
  () =>
    task(async () => {
      const { seen, idle, locked, trusted } = await glance()
      if (!tracking()) {
        return { machine, tracking: false, idleS: Math.round(idle), locked }
      }
      const recent = history.slice(-10).toReversed()
      const lookedAt = isSwitch(seen.app)
        ? recent.find((g) => !isSwitch(g.app) && g.at > Date.now() - 600_000)
        : seen
      const focus =
        lookedAt !== undefined && trusted && !CHROMIUM.has(lookedAt.bundle)
          ? await hands("focused", { pid: lookedAt.pid }).catch((): null => null)
          : null
      return {
        machine,
        tracking: true,
        front: strip(seen),
        ...(lookedAt === undefined || lookedAt === seen ? {} : { lookedAt: strip(lookedAt) }),
        focus,
        recent: recent.map(strip),
        idleS: Math.round(idle),
        locked,
        accessibility: trusted,
      }
    }),
)

const screenshot = tool(
  "screenshot",
  {
    description:
      "A screenshot of a display of this Mac (1 is the main one). A locked screen that takes no password is opened first; one only the user can open fails, saying so.",
    readOnly: true,
    input: Schema.Struct({
      display: Schema.optionalKey(Schema.Finite),
      width: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    task(async () => {
      await hands("open-screen")
      const data = await capture({ display: input.display ?? 1 }, input.width ?? 1600)
      return answer({ machine, display: input.display ?? 1 }, [
        { type: "image", data, mimeType: "image/jpeg" },
      ])
    }),
)

const onScreen = tool(
  "on_screen",
  {
    description: "A glance at this Mac's screen: the app and window in front, and a small picture.",
    readOnly: true,
  },
  () =>
    task(async () => {
      const { seen, locked } = await glance()
      const picture = locked
        ? ""
        : `data:image/jpeg;base64,${await capture({ display: 1 }, 640).catch(() => "")}`
      return {
        machine,
        label: locked ? "Locked" : (seen.window ?? seen.app),
        value: locked || (seen.window ?? seen.app) === seen.app ? machine : seen.app,
        picture: picture.endsWith(",") ? "" : picture,
      }
    }),
)

const ui = tool(
  "ui",
  {
    description:
      'Drive any app on this Mac through Accessibility: one step {op, app?, match?: {role?, text?}, index?, …} or {app?, steps: [step, …]}, stopping at the first that fails. Ops: tree {depth?}, find, press, set {attribute? (AXValue), value}, focus, keys {keys: "cmd+shift+g"}, type {text}, wait {timeout_ms?, gone?}. `app` is a name or bundle id, the front one if left out.',
    input: Schema.Record(Schema.String, Schema.Unknown),
  },
  (input) =>
    task(async () => {
      const keyed = /"op":"(?:keys|type)"/u.test(JSON.stringify(input))
      const result = await hands("ui", input)
      if (keyed) {
        posted = Date.now()
      }
      return obj(result)
    }),
)

const open = tool(
  "open",
  {
    description:
      "Open a URL (System Settings panes too), with an app if given; or an app; or show a path in Finder (`reveal`).",
    input: Schema.Struct({
      url: Schema.optionalKey(Schema.String),
      app: Schema.optionalKey(Schema.String),
      reveal: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    task(async () => {
      const opened: string[] = []
      if (input.url !== undefined || input.app !== undefined) {
        const argv = ["open"]
        if (input.app !== undefined) {
          const byId = input.app.includes(".") && !/[ /]/u.test(input.app)
          argv.push(byId ? "-b" : "-a", input.app)
        }
        if (input.url !== undefined) {
          argv.push(input.url)
        }
        if ((await Bun.spawn(argv, { stderr: "ignore" }).exited) !== 0) {
          throw new Error(`Couldn't open ${input.url ?? input.app ?? ""}`)
        }
        opened.push(input.url ?? input.app ?? "")
      }
      if (input.reveal !== undefined) {
        const p = expand(input.reveal)
        if ((await Bun.spawn(["open", "-R", p], { stderr: "ignore" }).exited) !== 0) {
          throw new Error(`Couldn't show ${p} in Finder`)
        }
        opened.push(p)
      }
      if (opened.length === 0) {
        throw new Error("open takes url, app or reveal")
      }
      return { opened }
    }),
)

const checkPaths = tool(
  "check_paths",
  {
    description:
      "Before touching a path macOS privacy may guard (Downloads, Desktop, Documents, iCloud, Mail, other apps' containers, /Volumes): per path, ok, blocked, missing or error, what guards it and the grant that opens it. Probes in a child killed after timeout_ms, so it never hangs; `live` false decides from the grants alone, touching nothing.",
    readOnly: true,
    input: Schema.Struct({
      paths: Schema.Array(Schema.String),
      timeout_ms: Schema.optionalKey(Schema.Finite),
      live: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) =>
    task(async () => {
      const held = grants()
      const ms = Math.min(Math.max(100, input.timeout_ms ?? 3000), 60_000)
      const paths = await Promise.all(
        input.paths.map(async (p) => await check(p, ms, input.live ?? true, held)),
      )
      return { permissions: held, paths }
    }),
)

const straysTool = tool(
  "strays",
  {
    description:
      "Processes agent turns and execs left running on this Mac, by kind (claude-shell, exec, leftover, unclaimed), with when each is due to be stopped; unclaimed ones are only reported. Swept every five minutes.",
    readOnly: true,
  },
  () => task(async () => ({ strays: await strays.find(RULES) })),
)

const sweepStrays = tool(
  "sweep_strays",
  {
    description:
      "Stop strays now: those given by pid (any kind but a launchd job's), else every one that's due. TERM, then KILL after 10 s.",
    input: Schema.Struct({ pids: Schema.optionalKey(Schema.Array(Schema.Finite)) }),
  },
  (input) =>
    task(async () => {
      const found = await strays.find(RULES)
      const { pids } = input
      const chosen =
        pids === undefined
          ? found.filter((s) => s.stopInS === 0)
          : found.filter((s) => pids.includes(s.pid))
      const stopped = await strays.stop(chosen)
      return { stopped: stopped.map((s) => ({ pid: s.pid, kind: s.kind, what: s.what })) }
    }),
)

const keepRunning = tool(
  "keep_running",
  {
    description: "Never stop a stray whose command line holds `text`.",
    input: Schema.Struct({ text: Schema.String }),
  },
  (input) => task(async () => await Promise.resolve(strays.keep(RULES, input.text))),
)

export const macosApp = defineApp({
  name: "macos",
  version: "1",
  instructions: `The Mac ${machine}: commands, files, vitals, what the user is doing on it, screenshots and any app's interface.`,
  tools: [
    exec,
    readFileTool,
    writeFileTool,
    listFiles,
    statFile,
    vitals,
    loadTool,
    attention,
    moment,
    screenshot,
    onScreen,
    ui,
    open,
    checkPaths,
    straysTool,
    sweepStrays,
    keepRunning,
  ],
  events: [Vitals, Attention, Permissions, StraysStopped],
  widgets: [
    {
      name: "vitals",
      title: "Vitals",
      surfaces: ["space"],
      resource: "ui://macos/vitals",
      space: HOME,
      size: {
        aspect: "auto",
        min: { cols: 2, rows: 1 },
        preferred: { cols: 4, rows: 1 },
        grows: true,
      },
      tool: "vitals",
      refresh: [Vitals.type],
      a2ui: () => [
        { version: "1.0", createSurface: { surfaceId: "vitals", catalogId: SWITCH_CATALOG } },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "vitals",
            components: [
              { id: "root", component: "Lines", children: ["line"] },
              {
                id: "line",
                component: "Field",
                label: { "@path": "/label" },
                value: { "@path": "/value" },
                alert: { "@path": "/alert" },
              },
            ],
          },
        },
      ],
    },
    {
      name: "screen",
      title: "On screen",
      surfaces: ["space", "chat"],
      resource: "ui://macos/screen",
      tool: "on_screen",
      refresh: [Attention.type],
      a2ui: () => [
        { version: "1.0", createSurface: { surfaceId: "screen", catalogId: SWITCH_CATALOG } },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "screen",
            components: [
              { id: "root", component: "Lines", children: ["now", "picture"] },
              {
                id: "now",
                component: "Field",
                label: { "@path": "/label" },
                value: { "@path": "/value" },
              },
              { id: "picture", component: "Picture", src: { "@path": "/picture" } },
            ],
          },
        },
      ],
    },
  ],
})
