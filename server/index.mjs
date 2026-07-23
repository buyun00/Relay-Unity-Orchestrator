import { config } from "./config.mjs";
import { createAdapter } from "./adapters/index.mjs";
import { Store } from "./db.mjs";
import { PipelineHttpServer } from "./http.mjs";
import { Scheduler } from "./scheduler.mjs";

const store = new Store(config);
const adapter = createAdapter(config);
const scheduler = new Scheduler({ config, store, adapter });
const api = new PipelineHttpServer({ config, store, scheduler });

await api.listen();
scheduler.start();

console.log(
  `Relay pipeline API listening on http://${config.host}:${config.port}`,
);
console.log(
  `Adapter: ${config.adapter}; authentication: ${config.authRequired ? "required" : "disabled"}`,
);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Received ${signal}; stopping pipeline service`);
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
