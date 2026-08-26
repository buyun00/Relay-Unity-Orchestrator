import assert from "node:assert/strict";
import test from "node:test";
import { HostMetricsSampler } from "../../server/host-metrics.mjs";

function fakeOs() {
  let idle = 100;
  let user = 100;
  return {
    cpus() {
      idle += 50;
      user += 50;
      return [
        {
          times: { idle, user, nice: 0, sys: 0, irq: 0 },
        },
        {
          times: { idle, user, nice: 0, sys: 0, irq: 0 },
        },
      ];
    },
    totalmem: () => 1_000,
    freemem: () => 250,
  };
}

test("host metrics aggregate CPU, memory, disk, GPU, and temperature", async () => {
  let now = 1_000;
  const sampler = new HostMetricsSampler({
    clock: () => now,
    operatingSystem: fakeOs(),
    hardwareCollector: async () => ({
      disks: [
        { name: "C:", totalBytes: 1_000, freeBytes: 200 },
        { name: "D:", totalBytes: 3_000, freeBytes: 1_800 },
      ],
      diskActivityPercent: 12.25,
      gpu: {
        name: "Example GPU",
        usagePercent: 35.25,
        memoryUsedMiB: 1_024,
        memoryTotalMiB: 4_096,
        source: "test",
      },
      temperature: {
        celsius: 52.25,
        sensor: "CPU Package",
        kind: "cpu",
        source: "test",
      },
    }),
  });

  now += 250;
  const snapshot = await sampler.getSnapshot();

  assert.equal(snapshot.cpu.available, true);
  assert.equal(snapshot.cpu.usagePercent, 50);
  assert.equal(snapshot.cpu.logicalProcessors, 2);
  assert.equal(snapshot.memory.usagePercent, 75);
  assert.equal(snapshot.temperature.celsius, 52.3);
  assert.equal(snapshot.temperature.kind, "cpu");
  assert.equal(snapshot.gpu.name, "Example GPU");
  assert.equal(snapshot.gpu.usagePercent, 35.3);
  assert.equal(snapshot.gpu.memoryUsagePercent, 25);
  assert.equal(snapshot.disk.usagePercent, 12.3);
  assert.equal(snapshot.disk.capacityUsagePercent, 50);
  assert.equal(snapshot.disk.metricKind, "activity");
  assert.equal(snapshot.disk.volumes.length, 2);
});

test("host metrics cache slow hardware collection and keep fast samples live", async () => {
  let now = 10_000;
  let collections = 0;
  const sampler = new HostMetricsSampler({
    cacheTtlMs: 5_000,
    clock: () => now,
    operatingSystem: fakeOs(),
    hardwareCollector: async () => {
      collections += 1;
      return { disks: [], gpu: {}, temperature: {} };
    },
    cwd: "C:\\workspace",
    env: { SystemDrive: "C:" },
    fileSystem: {
      statfsSync: () => ({ bsize: 1, blocks: 1_000, bavail: 400 }),
    },
  });

  const first = await sampler.getSnapshot();
  now += 3_000;
  const second = await sampler.getSnapshot();
  now += 3_000;
  const third = await sampler.getSnapshot();

  assert.equal(collections, 2);
  assert.equal(first.disk.source, "node-statfs");
  assert.equal(first.disk.usagePercent, 60);
  assert.equal(first.disk.metricKind, "capacity");
  assert.equal(second.cacheAgeMs, 3_000);
  assert.equal(third.cacheAgeMs, 0);
});

test("host metrics isolate hardware collector failures", async () => {
  const sampler = new HostMetricsSampler({
    operatingSystem: fakeOs(),
    hardwareCollector: async () => {
      throw new Error("sensor provider offline");
    },
    cwd: "C:\\workspace",
    env: { SystemDrive: "C:" },
    fileSystem: {
      statfsSync: () => {
        throw new Error("disk unavailable");
      },
    },
  });

  const snapshot = await sampler.getSnapshot();

  assert.equal(snapshot.cpu.available, true);
  assert.equal(snapshot.memory.available, true);
  assert.equal(snapshot.temperature.available, false);
  assert.equal(snapshot.gpu.available, false);
  assert.equal(snapshot.disk.available, false);
  assert.match(snapshot.warning, /sensor provider offline/);
});
