export class OzdqpBuildClientError extends Error {
  constructor(
    message,
    {
      code = "OZDQP_REQUEST_FAILED",
      status = null,
      retryable = false,
      retryAfterMs = null,
    } = {},
  ) {
    super(message);
    this.name = "OzdqpBuildClientError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMilliseconds(value, clock) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - clock());
}

function responsePayload(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function httpError(status, retryAfterMs) {
  const retryable =
    [408, 425, 429].includes(status) || (status >= 500 && status <= 599);
  const configuration = [401, 403].includes(status);
  return new OzdqpBuildClientError(
    configuration
      ? `OZDQP API rejected its authentication configuration (HTTP ${status})`
      : `OZDQP API returned HTTP ${status}`,
    {
      code: configuration
        ? "OZDQP_AUTH_CONFIGURATION_ERROR"
        : retryable
          ? "OZDQP_HTTP_RETRYABLE"
          : "OZDQP_HTTP_PERMANENT",
      status,
      retryable,
      retryAfterMs,
    },
  );
}

function safeText(value, limit = 1_000) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, limit)
    : null;
}

function jobFromPayload(payload) {
  const job = payload?.job;
  if (!job || typeof job !== "object") return null;
  return {
    jobId: safeText(job.jobId, 240),
    status: safeText(job.status, 80)?.toLowerCase() || "unknown",
    buildMode: safeText(job.buildMode, 80),
    sourceBranch: safeText(job.sourceBranch, 500),
    sourceCommit: safeText(job.sourceCommit, 80)?.toLowerCase() || null,
    currentStep: safeText(job.currentStep, 500),
    cdnUrl: safeText(job.cdnUrl, 2_000),
    error: safeText(job.error, 2_000),
    startedAt: safeText(job.startedAtUtc, 80),
    finishedAt: safeText(job.finishedAtUtc, 80),
    updatedAt: safeText(job.updatedAtUtc, 80),
    durationSeconds:
      Number.isFinite(Number(job.durationSeconds)) &&
      Number(job.durationSeconds) >= 0
        ? Number(job.durationSeconds)
        : null,
  };
}

export class OzdqpBuildClient {
  constructor({
    endpoint,
    apiKey = null,
    timeoutMs = 10_000,
    fetcher = globalThis.fetch,
    clock = () => Date.now(),
  }) {
    if (typeof fetcher !== "function") {
      throw new TypeError("A fetch implementation is required");
    }
    this.endpoint = endpoint;
    this.apiKey = apiKey || null;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 10_000);
    this.fetcher = fetcher;
    this.clock = clock;
  }

  payload(dispatch) {
    return {
      projectKey: dispatch.projectKey,
      repository: {
        url: dispatch.repositoryUrl,
        branch: dispatch.branchName,
        commitSha: dispatch.commitSha,
      },
      buildType: "cdn",
      mode: "cdn",
      modules: dispatch.modules,
      playerBaseVersion: dispatch.playerBaseVersion,
      requestedBy: dispatch.requestedBy,
    };
  }

  async submit(dispatch) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          Object.assign(new Error("OZDQP request timed out"), {
            code: "OZDQP_REQUEST_TIMEOUT",
          }),
        ),
      this.timeoutMs,
    );
    timeout.unref?.();
    try {
      const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Idempotency-Key": dispatch.idempotencyKey,
      };
      if (this.apiKey) headers["X-OZDQP-API-Key"] = this.apiKey;
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(this.payload(dispatch)),
        signal: controller.signal,
      });
      const body = responsePayload(await response.text());
      const job = jobFromPayload(body);
      const jobId = job?.jobId || null;
      if (
        (response.status === 200 ||
          response.status === 202 ||
          response.status === 409) &&
        jobId
      ) {
        return {
          jobId,
          jobStatus: job.status,
          currentStep: job.currentStep,
          cdnUrl: job.cdnUrl,
          status: response.status,
          deduplicated:
            response.status === 200 ||
            response.status === 409 ||
            body?.deduplicated === true,
        };
      }
      const retryAfterMs = retryAfterMilliseconds(
        response.headers.get("retry-after"),
        this.clock,
      );
      if (response.status >= 200 && response.status < 300) {
        throw new OzdqpBuildClientError(
          "OZDQP API accepted the request without returning a job ID",
          {
            code: "OZDQP_INVALID_RESPONSE",
            status: response.status,
            retryable: false,
          },
        );
      }
      throw httpError(response.status, retryAfterMs);
    } catch (error) {
      if (error instanceof OzdqpBuildClientError) throw error;
      const timedOut =
        controller.signal.aborted ||
        error?.name === "AbortError" ||
        error?.code === "OZDQP_REQUEST_TIMEOUT";
      throw new OzdqpBuildClientError(
        timedOut
          ? "OZDQP API request timed out"
          : "OZDQP API request failed before receiving a response",
        {
          code: timedOut ? "OZDQP_REQUEST_TIMEOUT" : "OZDQP_NETWORK_ERROR",
          retryable: true,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async getJob(dispatch) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          Object.assign(new Error("OZDQP status request timed out"), {
            code: "OZDQP_STATUS_REQUEST_TIMEOUT",
          }),
        ),
      this.timeoutMs,
    );
    timeout.unref?.();
    try {
      const endpoint = new URL(
        `./jobs/${encodeURIComponent(dispatch.ozdqpJobId)}`,
        this.endpoint,
      );
      endpoint.searchParams.set("logLines", "1");
      const headers = {};
      if (this.apiKey) headers["X-OZDQP-API-Key"] = this.apiKey;
      const response = await this.fetcher(endpoint.toString(), {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      const body = responsePayload(await response.text());
      if (response.status < 200 || response.status >= 300) {
        throw httpError(
          response.status,
          retryAfterMilliseconds(
            response.headers.get("retry-after"),
            this.clock,
          ),
        );
      }
      const job = jobFromPayload(body);
      if (!job?.jobId || !job.sourceBranch || !job.sourceCommit) {
        throw new OzdqpBuildClientError(
          "OZDQP job status response did not contain a complete job identity",
          {
            code: "OZDQP_STATUS_INVALID_RESPONSE",
            status: response.status,
            retryable: true,
          },
        );
      }
      if (
        job.jobId !== dispatch.ozdqpJobId ||
        job.sourceBranch !== dispatch.branchName ||
        job.sourceCommit !== dispatch.commitSha.toLowerCase() ||
        (job.buildMode && job.buildMode !== "cdn")
      ) {
        throw new OzdqpBuildClientError(
          "OZDQP job status identity did not match the accepted build",
          {
            code: "OZDQP_STATUS_IDENTITY_MISMATCH",
            status: response.status,
            retryable: false,
          },
        );
      }
      return job;
    } catch (error) {
      if (error instanceof OzdqpBuildClientError) throw error;
      const timedOut =
        controller.signal.aborted ||
        error?.name === "AbortError" ||
        error?.code === "OZDQP_STATUS_REQUEST_TIMEOUT";
      throw new OzdqpBuildClientError(
        timedOut
          ? "OZDQP job status request timed out"
          : "OZDQP job status request failed before receiving a response",
        {
          code: timedOut
            ? "OZDQP_STATUS_REQUEST_TIMEOUT"
            : "OZDQP_STATUS_NETWORK_ERROR",
          retryable: true,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
