import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("../../snapShot/DesktopSnapShot.ts", async () => {
  const Context = await import("effect/Context");
  class DesktopSnapShot extends Context.Service<
    DesktopSnapShot,
    { readonly configure: (settings: unknown) => unknown }
  >()("@t3tools/desktop/ipc/methods/clientSettings.test/DesktopSnapShot") {}
  return { DesktopSnapShot };
});

import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import { setClientSettings } from "./clientSettings.ts";

describe("client settings IPC", () => {
  it.effect("keeps a durable settings write successful when SnapShot reconfiguration fails", () => {
    const failure = new Error("capture configuration failed");
    const persisted: ClientSettings[] = [];
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });

    return Effect.gen(function* () {
      yield* setClientSettings.handler(DEFAULT_CLIENT_SETTINGS);

      assert.deepEqual(persisted, [DEFAULT_CLIENT_SETTINGS]);
      assert.equal(logs.length, 1);
      const message = logs[0];
      if (!Array.isArray(message)) return assert.fail("expected structured warning arguments");
      assert.equal(message[0], "Could not reconfigure SnapShots after saving client settings.");
      const detail = message[1];
      if (detail === null || typeof detail !== "object" || !("cause" in detail)) {
        return assert.fail("expected the reconfiguration cause in the warning");
      }
      assert.include(String(detail.cause), failure.message);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            DesktopClientSettings.DesktopClientSettings,
            DesktopClientSettings.DesktopClientSettings.of({
              get: Effect.succeed(Option.none()),
              set: (settings) =>
                Effect.sync(() => {
                  persisted.push(settings);
                }),
            }),
          ),
          Layer.succeed(
            DesktopSnapShot.DesktopSnapShot,
            DesktopSnapShot.DesktopSnapShot.of({
              configure: () => Effect.die(failure),
            } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
          ),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });
});
