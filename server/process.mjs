import { spawn } from "node:child_process";

export function runProcess(command, args, options = {}) {
  const {
    cwd,
    env,
    signal,
    timeoutMs = 0,
    onStdout,
    onStderr,
    acceptExitCodes = [0],
  } = options;
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const terminate = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    const abort = () => {
      terminate();
      const error =
        signal?.reason instanceof Error
          ? signal.reason
          : Object.assign(new Error("Process aborted"), { code: "ABORTED" });
      finish(() => reject(error));
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            terminate();
            const error = Object.assign(
              new Error(`Process timed out after ${timeoutMs}ms`),
              { code: "PROCESS_TIMEOUT" },
            );
            finish(() => reject(error));
          }, timeoutMs)
        : null;

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout = (stdout + text).slice(-2_000_000);
      onStdout?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr = (stderr + text).slice(-2_000_000);
      onStderr?.(text);
    });
    child.on("error", (cause) => {
      const error = Object.assign(
        new Error(`Failed to start ${command}: ${cause.message}`),
        {
          code: "PROCESS_START_FAILED",
          cause,
        },
      );
      finish(() => reject(error));
    });
    child.on("close", (exitCode, childSignal) => {
      if (!acceptExitCodes.includes(exitCode)) {
        const detail = stderr.trim() || stdout.trim();
        const error = Object.assign(
          new Error(
            `${command} exited with code ${exitCode}${detail ? `: ${detail.slice(-2_000)}` : ""}`,
          ),
          {
            code: "PROCESS_FAILED",
            exitCode,
            signal: childSignal,
            stdout,
            stderr,
          },
        );
        finish(() => reject(error));
        return;
      }
      finish(() => resolve({ exitCode, signal: childSignal, stdout, stderr }));
    });
  });
}
