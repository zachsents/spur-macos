// The disk's upkeep as this spur runs it: the census every six hours, sweeps of ended work's build
// folders every ten minutes, of simulators every half hour off the user's laptop, a low disk's sweep
// when it's under 20 GB, and a forecast that says, a day or two ahead, when it'll be low and what
// grew. Each is an event, so triage can wake a turn on a disk about to fill.
import path from "node:path"
import { Effect, Schema } from "effect"

import { AppEvents, defineEvent, personal, tool } from "spur-kit"
import { census, free, GB, outlook } from "./disk.ts"
import {
  byHolder,
  byWork,
  clear,
  freedOf,
  isLow,
  lowIdle,
  makeRoom,
  scan,
  sweepEnded,
  sweepSimulators,
} from "./sweeps.ts"
import type { ByWork, Cleared, Swept } from "./sweeps.ts"

const MINUTE = 60_000
const machine = process.env.SWITCH_MACHINE ?? "mac"
const laptop = personal()
const look = outlook(path.join(process.cwd(), "disk.json"))

const gb = (bytes: number) => Math.round((bytes / GB) * 10) / 10

const holder = Schema.Struct({
  name: Schema.String,
  path: Schema.optionalKey(Schema.String),
  gb: Schema.Finite,
  clears: Schema.Boolean,
  count: Schema.optionalKey(Schema.Finite),
  grewGb: Schema.optionalKey(Schema.Finite),
  clearedGb: Schema.optionalKey(Schema.Finite),
})

/** What holds the disk, from the census every six hours. */
export const DiskUse = defineEvent(
  "macos.disk_use",
  1,
  Schema.Struct({
    machine: Schema.String,
    at: Schema.String,
    freeGb: Schema.Finite,
    fallingGbADay: Schema.optionalKey(Schema.Finite),
    overDays: Schema.optionalKey(Schema.Finite),
    underGb: Schema.optionalKey(Schema.Finite),
    inDays: Schema.optionalKey(Schema.Finite),
    grewOverDays: Schema.optionalKey(Schema.Finite),
    holders: Schema.Array(holder),
    trimmed: Schema.Array(
      Schema.Struct({ name: Schema.String, freedGb: Schema.Finite, how: Schema.String }),
    ),
  }),
)

/** What a sweep cleared: build folders, tool caches, simulators. */
export const DiskSwept = defineEvent(
  "macos.disk_swept",
  1,
  Schema.Struct({
    machine: Schema.String,
    /** ended: work nothing runs in; low: a low disk; make_room; simulators. */
    why: Schema.Literals(["ended", "low", "make_room", "simulators"]),
    freedGb: Schema.Finite,
    freeGb: Schema.Finite,
    folders: Schema.Array(
      Schema.Struct({
        folder: Schema.String,
        gb: Schema.Finite,
        worktree: Schema.optionalKey(Schema.String),
      }),
    ),
    trimmed: Schema.Array(Schema.Struct({ name: Schema.String, freedGb: Schema.Finite })),
    simulators: Schema.Array(Schema.Struct({ name: Schema.String, gb: Schema.Finite })),
  }),
)

/** The disk will be low within two days, or a low disk's sweep couldn't keep 10 GB free. */
export const DiskLow = defineEvent(
  "macos.disk_low",
  1,
  Schema.Struct({
    machine: Schema.String,
    severity: Schema.String,
    text: Schema.String,
    freeGb: Schema.Finite,
    fallingGbADay: Schema.optionalKey(Schema.Finite),
    inDays: Schema.optionalKey(Schema.Finite),
    grew: Schema.Array(
      Schema.Struct({ name: Schema.String, gb: Schema.Finite, clearedGb: Schema.Finite }),
    ),
  }),
)

/** A piece of work's build folders went over (or back under) its 8 GB budget. */
export const DiskByWork = defineEvent(
  "macos.disk_by_work",
  1,
  Schema.Struct({
    machine: Schema.String,
    overBudget: Schema.Array(
      Schema.Struct({ worktree: Schema.String, gb: Schema.Finite, running: Schema.Boolean }),
    ),
  }),
)

// One clearing at a time: a sweep and make_room would delete the same folders and miscount.
let queue: Promise<unknown> = Promise.resolve()
const exclusive = async <A>(f: () => Promise<A>): Promise<A> => {
  const next = queue.catch(() => null).then(f)
  queue = next.catch(() => null)
  return await next
}

const task = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

const sweptOf = (why: "ended" | "low" | "make_room" | "simulators", c: Cleared) => ({
  machine,
  why,
  freedGb: gb(freedOf(c)),
  freeGb: gb(free()),
  folders: c.swept.map((s: Swept) => ({
    folder: s.folder,
    gb: gb(s.freed),
    ...(s.worktree !== undefined && { worktree: s.worktree }),
  })),
  trimmed: c.trimmed.map((t) => ({ name: t.name, freedGb: gb(t.freed) })),
  simulators: c.simulators.map((s) => ({ name: s.name, gb: gb(s.freed) })),
})

let latest: ReturnType<typeof look.facts> | null = null
let works: readonly ByWork[] = []

const takeCensus = async () => {
  const s = await scan()
  const c = await census(s.folders, !laptop)
  look.counted(c)
  latest = look.facts(c, free())
  return latest
}

const NOTHING: Cleared = { trimmed: [], swept: [], simulators: [] }

/** The disk's upkeep, while the spur runs. */
export const watchDisk = Effect.gen(function* upkeep() {
  const events = yield* AppEvents
  const emit = (e: Parameters<typeof events.emit>[0]) => events.emit(e).pipe(Effect.ignore)
  let ended = 0
  let sims = 0
  let pauseUntil = 0
  let over = ""
  for (;;) {
    const now = Date.now()
    look.sample(now, free())
    if (look.censusDue(now)) {
      const facts = yield* Effect.option(task(async () => await exclusive(takeCensus)))
      if (facts._tag === "Some") {
        yield* emit(DiskUse.make({ machine, ...facts.value }))
        const w = look.warning(machine, now, free(), false)
        if (w !== null) {
          yield* emit(DiskLow.make(w))
        }
      }
    }
    if (now - ended >= 10 * MINUTE) {
      ended = now
      const done = yield* Effect.option(
        task(
          async () =>
            await exclusive(async () => {
              const s = await scan()
              const swept = await sweepEnded(s)
              return { swept, works: await byWork(s) }
            }),
        ),
      )
      if (done._tag === "Some") {
        const { works: counted } = done.value
        works = counted
        const c: Cleared = { ...NOTHING, swept: done.value.swept }
        if (c.swept.length > 0) {
          look.cleared(now, byHolder(c))
          yield* emit(DiskSwept.make(sweptOf("ended", c)))
        }
        const overBudget = works
          .filter((w) => w.overBudget)
          .map((w) => ({ worktree: w.worktree, gb: w.gb, running: w.running }))
        const key = overBudget.map((w) => w.worktree).join("\n")
        if (key !== over) {
          over = key
          yield* emit(DiskByWork.make({ machine, overBudget }))
        }
      }
    }
    if (!laptop && now - sims >= 30 * MINUTE) {
      sims = now
      const gone = yield* Effect.option(task(async () => await exclusive(sweepSimulators)))
      if (gone._tag === "Some" && gone.value.length > 0) {
        const c: Cleared = { ...NOTHING, simulators: gone.value }
        look.cleared(now, byHolder(c))
        yield* emit(DiskSwept.make(sweptOf("simulators", c)))
      }
    }
    const left = free()
    if (isLow(left) && now >= pauseUntil) {
      pauseUntil = now + (left < 10 * GB ? 5 : 15) * MINUTE
      const c = yield* Effect.option(
        task(
          async () =>
            await exclusive(async () => await clear(await scan(), lowIdle(left), 40 * GB, !laptop)),
        ),
      )
      if (c._tag === "Some" && freedOf(c.value) > 0) {
        look.cleared(now, byHolder(c.value))
        yield* emit(DiskSwept.make(sweptOf("low", c.value)))
      }
      const w = look.warning(machine, now, free(), true)
      if (w !== null) {
        yield* emit(DiskLow.make(w))
      }
    }
    yield* Effect.sleep("1 minute")
  }
})

export const diskTool = tool(
  "disk",
  {
    description:
      "What holds this Mac's disk: each tool cache, the build folders, simulators, toolchains and models, with what each grew by over three days (counting what sweeps cleared), how fast free space is falling and in how many days it'll be low; and each piece of work's (git worktree's) build folders against its 8 GB budget. From the census every six hours; `fresh` takes one now. Sweeps clear build folders of work nothing runs in, and on a low disk tool caches, idle build folders and simulators.",
    readOnly: true,
    input: Schema.Struct({ fresh: Schema.optionalKey(Schema.Boolean) }),
  },
  (input) =>
    task(async () => {
      const facts = input.fresh === true || latest === null ? await exclusive(takeCensus) : latest
      return { machine, ...facts, works }
    }),
)

export const makeRoomTool = tool(
  "make_room",
  {
    description:
      "Free disk space on this Mac now, before a build or a download: tool caches, then build folders nothing has built in for half an hour and nothing works in, oldest first, then (off the user's laptop) simulators shut down for an hour, until `gb` are free (40 by default). Says what it freed and the biggest build folders left.",
    input: Schema.Struct({ gb: Schema.optionalKey(Schema.Finite) }),
  },
  (input) =>
    task(async () => {
      const done = await exclusive(
        async () => await makeRoom(input.gb === undefined ? undefined : input.gb * GB, !laptop),
      )
      look.cleared(Date.now(), byHolder(done.cleared))
      return {
        ...sweptOf("make_room", done.cleared),
        beforeGb: gb(done.before),
        wantedGb: gb(done.target),
        left: done.held,
      }
    }),
)

export const diskEvents = [DiskUse, DiskSwept, DiskLow, DiskByWork]
