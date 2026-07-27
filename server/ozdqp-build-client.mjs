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
      const jobId =
        typeof body?.job?.jobId === "string" && body.job.jobId.trim()
          ? body.job.jobId.trim()
          : null;
      if (
        (response.status === 200 ||
          response.status === 202 ||
          response.status === 409) &&
        jobId
      ) {
        return {
          jobId,
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
}
