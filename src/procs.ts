// Processes the agent keeps on this Mac: execs under way, which `cancel` stops; and services, the
// long-running ones it starts (a dev server, a watcher), each in its own process group with its log
// in this spur's folder, kept across the spur's restarts by pid and start time, and restarted when
// they die if asked. The supervisor of Switchboard's macOS appendage (start, stop, restart, logs),
// for what the agent runs rather than for appendages: spurs are the core's.
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

const DIR = path.join(process.cwd(), "services")
const FILE = path.join(DIR, "services.json")
const MAX_LOG = 5 * 1024 * 1024
const STOP_GRACE_MS = 10_000

const startedAt = (pid: number) =>
  Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="])
    .stdout.toString()
    .trim()

const alive = (pid: number, started: string) => started !== "" && startedAt(pid) === started

const kill = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Gone.
    }
  }
}

// Execs under way, by id.

interface Running {
  readonly id: string
  readonly command: string
  readonly pid: number
  readonly at: number
}

const execs = new Map<string, Running>()

export const began = (id: string, command: string, pid: number) => {
  execs.set(id, { id, command, pid, at: Date.now() })
}

export const ended = (id: string) => {
  execs.delete(id)
}

/** Stops an exec under way, with everything it started; or lists them. */
export const cancel = (id: string | undefined) => {
  if (id === undefined) {
    return {
      running: [...execs.values()].map((e) => ({
        id: e.id,
        command: e.command.slice(0, 200),
        forS: Math.round((Date.now() - e.at) / 1000),
      })),
    }
  }
  const e = execs.get(id)
  if (e === undefined) {
    throw new Error(`No exec ${id} running`)
  }
  kill(e.pid, "SIGTERM")
  setTimeout(() => {
    kill(e.pid, "SIGKILL")
  }, STOP_GRACE_MS)
  return { cancelled: id }
}

// Services.

export interface Service {
  readonly name: string
  readonly command: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  /** Started again when it dies. */
  readonly restart: boolean
  pid: number
  started: string
  /** Stopped by hand: not started again until asked. */
  stopped: boolean
  restarts: number
  lastExit: number | null
}

const parse: (text: string) => unknown = JSON.parse

const load = (): Service[] => {
  try {
    const raw = parse(readFileSync(FILE, "utf-8"))
    return Array.isArray(raw)
      ? raw.filter((s): s is Service => typeof s === "object" && s !== null && "name" in s)
      : []
  } catch {
    return []
  }
}

const services = load()

const save = () => {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(services, null, 1))
}

const logOf = (name: string) => path.join(DIR, `${name}.log`)

const rotate = (log: string) => {
  if (existsSync(log) && statSync(log).size > MAX_LOG) {
    renameSync(log, `${log}.1`)
  }
}

const NAME = /^[\w.-]{1,60}$/u

const launch = (s: Service) => {
  mkdirSync(DIR, { recursive: true })
  const log = logOf(s.name)
  rotate(log)
  appendFileSync(log, `\n— started ${new Date().toISOString()}: ${s.command}\n`)
  const fd = openSync(log, "a")
  const proc = Bun.spawn(["/bin/zsh", "-lc", s.command], {
    cwd: s.cwd,
    env: { ...process.env, ...s.env, SWITCH_SERVICE: s.name },
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
    detached: true,
  })
  closeSync(fd)
  s.pid = proc.pid
  s.started = startedAt(proc.pid)
  s.stopped = false
  save()
  void proc.exited.then((code) => {
    if (s.pid === proc.pid) {
      s.lastExit = code
      appendFileSync(log, `— exited ${code} ${new Date().toISOString()}\n`)
      save()
    }
    return code
  })
}

const find = (name: string) => {
  const s = services.find((x) => x.name === name)
  if (s === undefined) {
    throw new Error(`No service ${name}`)
  }
  return s
}

const stopOne = async (s: Service) => {
  if (!alive(s.pid, s.started)) {
    return
  }
  kill(s.pid, "SIGTERM")
  const until = Date.now() + STOP_GRACE_MS
  const gone = async (): Promise<void> => {
    if (alive(s.pid, s.started) && Date.now() < until) {
      await Bun.sleep(250)
      await gone()
    }
  }
  await gone()
  kill(s.pid, "SIGKILL")
}

const view = (s: Service) => {
  const up = alive(s.pid, s.started)
  return {
    name: s.name,
    command: s.command,
    cwd: s.cwd,
    running: up,
    ...(up && { pid: s.pid, since: new Date(s.started).toISOString() }),
    restart: s.restart,
    stopped: s.stopped,
    restarts: s.restarts,
    ...(s.lastExit !== null && !up && { lastExit: s.lastExit }),
    log: logOf(s.name),
  }
}

export const list = () => ({ services: services.map(view) })

export const start = (input: {
  readonly name: string
  readonly command?: string
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly restart?: boolean
}) => {
  if (!NAME.test(input.name)) {
    throw new Error("A service's name is letters, digits, dots, dashes and underscores")
  }
  const was = services.find((x) => x.name === input.name)
  if (was !== undefined && alive(was.pid, was.started)) {
    throw new Error(`${input.name} is running (pid ${was.pid}); restart it, or stop it first`)
  }
  const command = input.command ?? was?.command
  if (command === undefined) {
    throw new Error(`No service ${input.name}: give its command`)
  }
  const s: Service = {
    name: input.name,
    command,
    cwd: input.command === undefined && was ? was.cwd : input.cwd,
    env: input.env ?? was?.env ?? {},
    restart: input.restart ?? was?.restart ?? false,
    pid: 0,
    started: "",
    stopped: false,
    restarts: 0,
    lastExit: null,
  }
  if (was !== undefined) {
    services.splice(services.indexOf(was), 1)
  }
  services.push(s)
  launch(s)
  return view(s)
}

export const stop = async (name: string, forget: boolean) => {
  const s = find(name)
  s.stopped = true
  await stopOne(s)
  if (forget) {
    services.splice(services.indexOf(s), 1)
  }
  save()
  return forget ? { forgot: name } : view(s)
}

export const restart = async (name: string) => {
  const s = find(name)
  await stopOne(s)
  s.restarts += 1
  launch(s)
  return view(s)
}

/** The end of a service's log. */
export const logs = (name: string, lines: number) => {
  find(name)
  const log = logOf(name)
  const text = existsSync(log) ? readFileSync(log, "utf-8") : ""
  const all = text.split("\n")
  return { name, log, text: all.slice(-Math.min(Math.max(1, lines), 2000)).join("\n") }
}

const backoff = new Map<string, number>()

/** Services asked to keep running that died, started again, backing off to five minutes. */
export const keepUp = () => {
  const now = Date.now()
  for (const s of services) {
    if (!s.restart || s.stopped || alive(s.pid, s.started) || (backoff.get(s.name) ?? 0) > now) {
      continue
    }
    s.restarts += 1
    backoff.set(s.name, now + Math.min(300_000, 1000 * 2 ** Math.min(s.restarts, 9)))
    launch(s)
  }
}
