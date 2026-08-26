import { spawn } from "node:child_process";

export function runProcess(command, args, options = {}) {
  const {
    cwd,
    env,
    signal,
    timeoutMs = 0,
    completionCheck = null,
    completionGraceMs = 5_000,
    onStdout,
    onStderr,
    input,
    acceptExitCodes = [0],
  } = options;
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let terminationError = null;
    let completionForced = false;
    let terminationRequested = false;
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: false,
      stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (completionPoll) clearInterval(completionPoll);
      if (completionTimer) clearTimeout(completionTimer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const terminate = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      if (process.platform !== "win32" || !child.pid) {
        if (!child.killed) child.kill("SIGTERM");
        return;
      }
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        {
          windowsHide: true,
          stdio: "ignore",
        },
      );
      const fallback = () => {
        if (!child.killed) child.kill("SIGTERM");
      };
      killer.once("error", fallback);
      killer.once("close", (exitCode) => {
        if (exitCode !== 0) fallback();
      });
    };
    const abort = () => {
      if (terminationError) return;
      terminationError =
        signal?.reason instanceof Error
          ? signal.reason
          : Object.assign(new Error("Process aborted"), { code: "ABORTED" });
      terminate();
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (terminationError) return;
            terminationError = Object.assign(
              new Error(`Process timed out after ${timeoutMs}ms`),
              { code: "PROCESS_TIMEOUT", timeoutMs, timedOut: true },
            );
            terminate();
          }, timeoutMs)
        : null;
    let completionTimer = null;
    const completionPoll =
      typeof completionCheck === "function"
        ? setInterval(() => {
            let complete = false;
            try {
              complete = Boolean(completionCheck());
            } catch {
              // A partially written completion artifact is checked again.
            }
            if (!complete || completionTimer) return;
            clearInterval(completionPoll);
            completionTimer = setTimeout(
              () => {
                completionForced = true;
                terminate();
              },
              Math.max(0, completionGraceMs),
            );
          }, 250)
        : null;

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    if (child.stdin) {
      child.stdin.on("error", () => {
        // A process that exits before consuming stdin is reported by close.
      });
      child.stdin.end(input);
    }
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
      if (terminationError) {
        Object.assign(terminationError, {
          exitCode,
          signal: childSignal,
          stdout,
          stderr,
        });
        finish(() => reject(terminationError));
        return;
      }
      if (completionForced) {
        finish(() =>
          resolve({
            exitCode,
            signal: childSignal,
            stdout,
            stderr,
            completedBySentinel: true,
          }),
        );
        return;
      }
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
