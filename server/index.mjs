import { config } from "./config.mjs";
import { createAdapter } from "./adapters/index.mjs";
import { Store } from "./db.mjs";
import { PipelineHttpServer } from "./http.mjs";
import { GuardianClient } from "./guardian-client.mjs";
import { OpsEngine } from "./ops-engine.mjs";
import { RepairManager } from "./repair-manager.mjs";
import { Scheduler } from "./scheduler.mjs";

const store = new Store(config);
const guardian = new GuardianClient(config, {
  onEvent: (event) => store.emit(event),
});
guardian.start();
const adapter = createAdapter(config);
const runtime = await adapter.initialize();
const scheduler = new Scheduler({ config, store, adapter });
const repairManager = new RepairManager(
  { config, store },
  { restartCoordinator: guardian },
);
const ops = new OpsEngine({
  config,
  store,
  scheduler,
  repairManager,
  restartCoordinator: guardian,
});
const api = new PipelineHttpServer({
  config,
  store,
  scheduler,
  ops,
  guardian,
});

await api.listen();
await scheduler.start({ paused: !runtime.ready });
await ops.start();
if (!runtime.ready) {
  store.emit({
    type: "system.runtime.unhealthy",
    phase: "system",
    level: "error",
    message:
      "Relay host preflight is not ready; System Codex will diagnose recovery",
    data: { runtime },
  });
}

console.log(
  `Relay pipeline API listening on http://${config.host}:${config.port}`,
);
console.log(`Adapter: ${config.adapter}; access tokens: disabled`);
console.log(
  `Hyper-V access: ${runtime.hyperv.canManage ? "ready" : "unavailable"}; Codex: ${
    runtime.codex.authenticated
      ? runtime.codex.version || "authenticated"
      : "not authenticated"
  }; checkpoints: ${runtime.checkpointsEnabled ? "enabled" : "disabled"}`,
);
if (!runtime.ready) {
  console.warn(
    "Scheduler started paused because the Hyper-V/Codex host preflight is not ready. Check GET /api/runtime.",
  );
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Received ${signal}; stopping pipeline service`);
  ops.stop();
  guardian.stop();
  scheduler.stop();
  const drained = await scheduler.waitForIdle();
  if (!drained) {
    console.warn(
      "Timed out waiting for active turns to stop; startup reconciliation will preserve their workers",
    );
  }
  await api.close();
  store.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(
    signal,
    () => void shutdown(signal).finally(() => process.exit(0)),
  );
}
