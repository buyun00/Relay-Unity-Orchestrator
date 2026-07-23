import { HyperVAdapter } from "./hyperv.mjs";

export function createAdapter(config) {
  return new HyperVAdapter(config);
}
