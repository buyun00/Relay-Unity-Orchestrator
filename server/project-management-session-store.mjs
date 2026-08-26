import fs from "node:fs";
import path from "node:path";

import { runProcess } from "./process.mjs";

export const PROJECT_MANAGEMENT_SESSION_STATE_FORMAT =
  "relay-project-management-session-state-v1";

function stateError(message, cause = null) {
  return Object.assign(new Error(message), {
    code: "PROJECT_MANAGEMENT_SESSION_STATE_FAILED",
    ...(cause ? { cause } : {}),
  });
}

export class ProjectManagementSessionStore {
  constructor({
    statePath,
    powershellCommand = "powershell.exe",
    scriptPath,
    timeoutMs = 15_000,
    processRunner = runProcess,
  }) {
    this.statePath = path.resolve(statePath);
    this.powershellCommand = powershellCommand;
    this.scriptPath = path.resolve(scriptPath);
    this.timeoutMs = timeoutMs;
    this.processRunner = processRunner;
  }

  async invoke(mode, input = null) {
    try {
      return await this.processRunner(
        this.powershellCommand,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          this.scriptPath,
          "-Mode",
          mode,
          "-Path",
          this.statePath,
        ],
        {
          input,
          timeoutMs: this.timeoutMs,
        },
      );
    } catch (error) {
      const reason =
        error?.code ||
        (Number.isInteger(error?.exitCode)
          ? `exit-${error.exitCode}`
          : "process-failed");
      throw stateError(
        `Unable to ${mode.toLowerCase()} project-management session state (${reason})`,
        error,
      );
    }
  }

  async load() {
    if (!fs.existsSync(this.statePath)) return null;
    const result = await this.invoke("Unprotect");
    let state;
    try {
      state = JSON.parse(result.stdout);
    } catch (error) {
      throw stateError(
        "Decrypted project-management session state is invalid",
        error,
      );
    }
    if (
      !state ||
      state.format !== PROJECT_MANAGEMENT_SESSION_STATE_FORMAT ||
      !Array.isArray(state.sessions)
    ) {
      throw stateError(
        "Decrypted project-management session state has an unsupported format",
      );
    }
    return state;
  }

  async save(state) {
    if (
      !state ||
      state.format !== PROJECT_MANAGEMENT_SESSION_STATE_FORMAT ||
      !Array.isArray(state.sessions)
    ) {
      throw stateError("Project-management session state is invalid");
    }
    await this.invoke("Protect", `${JSON.stringify(state)}\n`);
  }
}
