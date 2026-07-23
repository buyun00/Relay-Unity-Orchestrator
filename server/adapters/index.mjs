import { HyperVAdapter } from "./hyperv.mjs";
import { MockAdapter } from "./mock.mjs";

export function createAdapter(config) {
  return config.adapter === "hyperv"
    ? new HyperVAdapter(config)
    : new MockAdapter(config);
}
