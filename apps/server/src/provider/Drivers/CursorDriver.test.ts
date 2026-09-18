// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { CursorDriver } from "./CursorDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cursor-driver-copy-command-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Cursor must not make an HTTP request")),
    ),
  ),
);

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

it.layer(testLayer)("CursorDriver", (it) => {
  it.effect.skipIf(windowsHost)(
    "quotes a configured executable path in the copyable update command",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-driver-" });
        const binaryPath = NodePath.join(tempDir, "Cursor Tools", "bin", "cursor-agent");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
        yield* fs.chmod(binaryPath, 0o755);

        const instance = yield* CursorDriver.create({
          instanceId: ProviderInstanceId.make("cursor-copy-command"),
          displayName: "Cursor test",
          enabled: false,
          environment: [],
          config: { ...CursorDriver.defaultConfig(), binaryPath },
        });

        const capabilities = yield* instance.snapshot.resolveMaintenance();
        expect(capabilities.update).toMatchObject({
          command: `'${binaryPath}' update`,
          executable: binaryPath,
          args: ["update"],
        });
        expect((yield* instance.snapshot.refresh).status).toBe("disabled");
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Disabled Cursor must not spawn a process")),
        ),
        Effect.scoped,
      ),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const instance = yield* CursorDriver.create({
        instanceId: ProviderInstanceId.make("cursor-missing"),
        displayName: "Cursor test",
        enabled: false,
        environment: [],
        config: {
          ...CursorDriver.defaultConfig(),
          binaryPath: NodePath.join(NodeOS.tmpdir(), "t3-cursor-missing", "cursor-agent"),
        },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("Disabled Cursor must not spawn a process")),
      ),
      Effect.scoped,
    ),
  );

  it.effect.skipIf(!windowsHost)("uses Scoop for an owned Windows Cursor CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-scoop-" });
      const current = NodePath.join(root, "apps", "cursor-agent", "current");
      const target = NodePath.join(current, "cursor-agent.exe");
      const shim = NodePath.join(root, "shims", "cursor-agent.exe");
      const manager = NodePath.join(root, "shims", "scoop.cmd");
      yield* fs.makeDirectory(current, { recursive: true });
      yield* fs.makeDirectory(NodePath.dirname(shim), { recursive: true });
      yield* fs.writeFileString(target, "fixture");
      yield* fs.writeFileString(shim, "fixture");
      yield* fs.writeFileString(shim.replace(/\.exe$/i, ".shim"), `path = "${target}"`);
      yield* fs.writeFileString(NodePath.join(current, "install.json"), '{"bucket":"extras"}');
      yield* fs.writeFileString(manager, "@echo off\r\n");

      const instance = yield* CursorDriver.create({
        instanceId: ProviderInstanceId.make("cursor-scoop"),
        displayName: "Cursor Scoop",
        enabled: false,
        environment: [{ name: "PATH", value: NodePath.dirname(manager), sensitive: false }],
        config: { ...CursorDriver.defaultConfig(), binaryPath: shim },
      });
      expect((yield* instance.snapshot.resolveMaintenance({ fresh: true })).update).toMatchObject({
        args: ["update", "extras/cursor-agent"],
        windowsInstaller: { manager: "scoop", scope: "user" },
      });
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("Scoop ownership must not spawn a probe")),
      ),
      Effect.scoped,
    ),
  );

  it.effect.skipIf(!windowsHost)("keeps unproven WinGet Cursor CLI paths manual-only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-winget-" });
      const binaryPath = NodePath.join(root, "Microsoft", "WinGet", "Packages", "cursor-agent.exe");
      yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(binaryPath, "fixture");
      const instance = yield* CursorDriver.create({
        instanceId: ProviderInstanceId.make("cursor-winget"),
        displayName: "Cursor WinGet",
        enabled: false,
        environment: [],
        config: { ...CursorDriver.defaultConfig(), binaryPath },
      });
      expect((yield* instance.snapshot.resolveMaintenance({ fresh: true })).update).toBeNull();
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("Unknown WinGet ownership must not spawn")),
      ),
      Effect.scoped,
    ),
  );
});
