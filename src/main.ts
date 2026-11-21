// The macOS spur as a stdio MCP server: what a host runs, from this Mac's spur folder.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { BunRuntime } from "@effect/platform-bun"
import { AppEvents, Models, serve } from "spur-kit"
import { Effect, Layer } from "effect"

import { macosApp, watch } from "./app.ts"

BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* serving() {
      const done = yield* serve(macosApp, new StdioServerTransport())
      yield* Effect.forkScoped(watch)
      yield* done
    }),
  ).pipe(Effect.provide(Layer.merge(AppEvents.layer(macosApp), Models.layer))),
)
