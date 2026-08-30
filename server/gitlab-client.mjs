import fs from "node:fs";

import { HttpError, sleep } from "./util.mjs";

function trimMessage(value, fallback = "GitLab request failed") {
  const text = String(value || "").trim();
  return (text || fallback).slice(0, 1_000);
}

function repositoryProjectPath(repositoryUrl) {
  let parsed;
  try {
    parsed = new URL(repositoryUrl);
  } catch {
    throw new HttpError(
      400,
      "GITLAB_REPOSITORY_URL_INVALID",
      "The task repository URL is not a valid GitLab URL",
    );
  }
  if (!/^https?:$/u.test(parsed.protocol)) {
    throw new HttpError(
      400,
      "GITLAB_REPOSITORY_URL_INVALID",
      "The task repository must use HTTP or HTTPS",
    );
  }
  const projectPath = decodeURIComponent(parsed.pathname)
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/iu, "");
  if (!projectPath || projectPath.includes("..")) {
    throw new HttpError(
      400,
      "GITLAB_PROJECT_PATH_INVALID",
      "The task repository does not contain a safe GitLab project path",
    );
  }
  return {
    origin: parsed.origin,
    projectPath,
  };
}

function tokenFromFile(filePath) {
  if (!filePath) {
    throw new HttpError(
      503,
      "GITLAB_TOKEN_NOT_CONFIGURED",
      "GitLab automatic merge is not configured",
    );
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new HttpError(
      503,
      "GITLAB_TOKEN_FILE_UNAVAILABLE",
      "GitLab automatic merge token file cannot be read",
    );
  }
  const lines = raw
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  let token = null;
  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) continue;
    if (
      /(?:gitlab.*token|token.*gitlab|private.*token|api.*token)/iu.test(
        match[1],
      )
    ) {
      token = match[2];
      break;
    }
  }
  if (!token && lines.length === 1 && !lines[0].includes("=")) token = lines[0];
  token = String(token || "")
    .trim()
    .replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, (_, double, single) =>
      double == null ? single : double,
    );
  raw = null;
  if (!token || token.length > 10_000 || /[\r\n]/u.test(token)) {
    throw new HttpError(
      503,
      "GITLAB_TOKEN_FILE_INVALID",
      "GitLab automatic merge token file is invalid",
    );
  }
  return token;
}

function responseMessage(payload, fallback) {
  if (typeof payload?.message === "string") return payload.message;
  if (typeof payload?.error === "string") return payload.error;
  if (payload?.message && typeof payload.message === "object") {
    return Object.entries(payload.message)
      .flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value]).map(
          (item) => `${key}: ${String(item)}`,
        ),
      )
      .join("; ");
  }
  return fallback;
}

export class GitLabClient {
  constructor({
    baseUrl = null,
    tokenFile = null,
    timeoutMs = 15_000,
    fetchImpl = fetch,
  } = {}) {
    try {
      this.allowedOrigin = baseUrl ? new URL(baseUrl).origin : null;
    } catch {
      throw new HttpError(
        500,
        "GITLAB_BASE_URL_INVALID",
        "GitLab automatic merge base URL is invalid",
      );
    }
    this.tokenFile = tokenFile;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async request(
    origin,
    pathname,
    { method = "GET", query = null, body = undefined, accepted = [200] } = {},
  ) {
    const url = new URL(`/api/v4${pathname}`, origin);
    for (const [key, value] of Object.entries(query || {})) {
      if (value != null && value !== "")
        url.searchParams.set(key, String(value));
    }
    const token = tokenFromFile(this.tokenFile);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("GitLab request timed out")),
      this.timeoutMs,
    );
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          "PRIVATE-TOKEN": token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!accepted.includes(response.status)) {
        const upstreamMessage = trimMessage(
          responseMessage(payload, response.statusText),
        );
        const status =
          response.status === 401 || response.status === 403
            ? 502
            : response.status === 404
              ? 404
              : response.status === 409 ||
                  response.status === 405 ||
                  response.status === 422
                ? 409
                : 502;
        const code =
          response.status === 401 || response.status === 403
            ? "GITLAB_AUTHORIZATION_FAILED"
            : response.status === 404
              ? "GITLAB_RESOURCE_NOT_FOUND"
              : response.status === 409 ||
                  response.status === 405 ||
                  response.status === 422
                ? "GITLAB_MERGE_BLOCKED"
                : "GITLAB_REQUEST_FAILED";
        throw new HttpError(
          status,
          code,
          `GitLab 拒绝自动合并：${upstreamMessage}`,
          { upstreamStatus: response.status },
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (controller.signal.aborted) {
        throw new HttpError(
          504,
          "GITLAB_TIMEOUT",
          "GitLab 自动合并请求超时，请重试",
        );
      }
      throw new HttpError(
        502,
        "GITLAB_UNAVAILABLE",
        `无法连接 GitLab：${trimMessage(error?.message)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async project(repositoryUrl) {
    const repository = repositoryProjectPath(repositoryUrl);
    if (!this.allowedOrigin) {
      throw new HttpError(
        503,
        "GITLAB_BASE_URL_NOT_CONFIGURED",
        "GitLab automatic merge base URL is not configured",
      );
    }
    if (repository.origin !== this.allowedOrigin) {
      throw new HttpError(
        409,
        "GITLAB_REPOSITORY_HOST_NOT_ALLOWED",
        `任务仓库不属于允许自动合并的 GitLab：${this.allowedOrigin}`,
      );
    }
    const project = await this.request(
      repository.origin,
      `/projects/${encodeURIComponent(repository.projectPath)}`,
    );
    if (!project?.id) {
      throw new HttpError(
        502,
        "GITLAB_PROJECT_INVALID",
        "GitLab returned an invalid project",
      );
    }
    return { repository, project };
  }

  async branch(origin, projectId, branchName) {
    return this.request(
      origin,
      `/projects/${encodeURIComponent(projectId)}/repository/branches/${encodeURIComponent(branchName)}`,
    );
  }

  async branchOrNull(origin, projectId, branchName) {
    try {
      return await this.branch(origin, projectId, branchName);
    } catch (error) {
      if (error?.code === "GITLAB_RESOURCE_NOT_FOUND") return null;
      throw error;
    }
  }

  async commitReferences(origin, projectId, commitSha) {
    return this.request(
      origin,
      `/projects/${encodeURIComponent(projectId)}/repository/commits/${encodeURIComponent(commitSha)}/refs`,
      { query: { type: "branch" } },
    );
  }

  async mergeRequests(origin, projectId, sourceBranch, targetBranch) {
    const result = await this.request(
      origin,
      `/projects/${encodeURIComponent(projectId)}/merge_requests`,
      {
        query: {
          state: "all",
          source_branch: sourceBranch,
          target_branch: targetBranch,
          order_by: "updated_at",
          sort: "desc",
          per_page: 50,
        },
      },
    );
    return Array.isArray(result) ? result : [];
  }

  async mergeRequest(origin, projectId, iid) {
    return this.request(
      origin,
      `/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(iid)}`,
    );
  }

  async verifyTargetContains(origin, projectId, targetBranch, expectedSha) {
    const refs = await this.commitReferences(origin, projectId, expectedSha);
    if (
      !Array.isArray(refs) ||
      !refs.some((ref) => ref?.type === "branch" && ref?.name === targetBranch)
    ) {
      throw new HttpError(
        409,
        "GITLAB_MERGE_NOT_VERIFIED",
        `GitLab 已返回合并结果，但 ${targetBranch} 尚未包含任务提交 ${expectedSha.slice(0, 12)}`,
      );
    }
  }

  async waitUntilMergeable(origin, projectId, iid) {
    let mergeRequest = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      mergeRequest = await this.mergeRequest(origin, projectId, iid);
      const status = String(
        mergeRequest?.detailed_merge_status || mergeRequest?.merge_status || "",
      );
      if (["mergeable", "can_be_merged"].includes(status)) return mergeRequest;
      if (
        [
          "conflict",
          "cannot_be_merged",
          "not_approved",
          "draft_status",
          "discussions_not_resolved",
          "ci_must_pass",
          "ci_still_running",
          "blocked_status",
        ].includes(status)
      ) {
        throw new HttpError(
          409,
          "GITLAB_MERGE_BLOCKED",
          `MR !${iid} 当前不能合并：${status}`,
          { mergeRequestIid: iid, detailedMergeStatus: status },
        );
      }
      await sleep(500);
    }
    throw new HttpError(
      409,
      "GITLAB_MERGE_STATUS_PENDING",
      `MR !${iid} 的可合并状态尚未确认，请稍后重试`,
    );
  }

  async ensureMerged({
    repositoryUrl,
    sourceBranch,
    targetBranch,
    title,
    description,
  }) {
    const { repository, project } = await this.project(repositoryUrl);
    const projectId = project.id;
    await this.branch(repository.origin, projectId, targetBranch);
    const existing = await this.mergeRequests(
      repository.origin,
      projectId,
      sourceBranch,
      targetBranch,
    );
    let mergeRequest = existing.find(
      (candidate) => candidate?.state === "opened",
    );
    const source = await this.branchOrNull(
      repository.origin,
      projectId,
      sourceBranch,
    );
    if (!source) {
      mergeRequest = existing.find(
        (candidate) => candidate?.state === "merged",
      );
      const mergedSourceSha = String(mergeRequest?.sha || "").toLowerCase();
      if (!mergeRequest || !/^[0-9a-f]{40}$/u.test(mergedSourceSha)) {
        throw new HttpError(
          404,
          "GITLAB_SOURCE_BRANCH_NOT_FOUND",
          `GitLab 上不存在任务分支 ${sourceBranch}，也没有可确认的已合并 MR`,
        );
      }
      const mergedCommitSha = String(
        mergeRequest.merge_commit_sha ||
          mergeRequest.squash_commit_sha ||
          mergedSourceSha,
      ).toLowerCase();
      if (!/^[0-9a-f]{40}$/u.test(mergedCommitSha)) {
        throw new HttpError(
          409,
          "GITLAB_MERGE_NOT_VERIFIED",
          `GitLab 已返回 MR !${mergeRequest.iid} 合并结果，但缺少可验证的合并提交`,
        );
      }
      await this.verifyTargetContains(
        repository.origin,
        projectId,
        targetBranch,
        mergedCommitSha,
      );
      return {
        iid: mergeRequest.iid,
        webUrl: mergeRequest.web_url,
        sourceBranch,
        targetBranch,
        mergedCommitSha,
        alreadyMerged: true,
        sourceBranchDeleted: true,
      };
    }

    const sourceSha = String(source?.commit?.id || "").toLowerCase();
    if (!/^[0-9a-f]{40}$/u.test(sourceSha)) {
      throw new HttpError(
        502,
        "GITLAB_SOURCE_BRANCH_INVALID",
        `GitLab 返回的任务分支 ${sourceBranch} 缺少有效提交`,
      );
    }
    const refs = await this.commitReferences(
      repository.origin,
      projectId,
      sourceSha,
    );
    if (
      Array.isArray(refs) &&
      refs.some((ref) => ref?.type === "branch" && ref?.name === targetBranch)
    ) {
      const mergedRequest = existing.find(
        (candidate) =>
          candidate?.state === "merged" &&
          String(candidate?.sha || "").toLowerCase() === sourceSha,
      );
      return {
        iid: mergedRequest?.iid || null,
        webUrl: mergedRequest?.web_url || null,
        sourceBranch,
        targetBranch,
        mergedCommitSha:
          mergedRequest?.merge_commit_sha ||
          mergedRequest?.squash_commit_sha ||
          sourceSha,
        alreadyMerged: true,
        sourceBranchDeleted: false,
      };
    }
    if (mergeRequest) {
      mergeRequest = await this.mergeRequest(
        repository.origin,
        projectId,
        mergeRequest.iid,
      );
    }
    if (!mergeRequest) {
      mergeRequest = await this.request(
        repository.origin,
        `/projects/${encodeURIComponent(projectId)}/merge_requests`,
        {
          method: "POST",
          accepted: [201],
          body: {
            source_branch: sourceBranch,
            target_branch: targetBranch,
            title,
            description,
            remove_source_branch: false,
            squash: false,
          },
        },
      );
    }
    mergeRequest = await this.waitUntilMergeable(
      repository.origin,
      projectId,
      mergeRequest.iid,
    );
    const merged = await this.request(
      repository.origin,
      `/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mergeRequest.iid)}/merge`,
      {
        method: "PUT",
        body: {
          should_remove_source_branch: false,
          merge_when_pipeline_succeeds: false,
          squash: false,
        },
      },
    );
    if (merged?.state !== "merged" || !merged?.merged_at) {
      throw new HttpError(
        409,
        "GITLAB_MERGE_NOT_CONFIRMED",
        `GitLab 尚未确认 MR !${mergeRequest.iid} 合并成功`,
      );
    }
    const mergedSourceSha = String(
      merged?.sha || mergeRequest?.sha || sourceSha,
    ).toLowerCase();
    if (!/^[0-9a-f]{40}$/u.test(mergedSourceSha)) {
      throw new HttpError(
        409,
        "GITLAB_MERGE_NOT_VERIFIED",
        `GitLab 已返回 MR !${mergeRequest.iid} 合并结果，但缺少可验证的源提交`,
      );
    }
    await this.verifyTargetContains(
      repository.origin,
      projectId,
      targetBranch,
      mergedSourceSha,
    );
    return {
      iid: merged.iid,
      webUrl: merged.web_url,
      sourceBranch,
      targetBranch,
      mergedCommitSha:
        merged.merge_commit_sha || merged.squash_commit_sha || mergedSourceSha,
      alreadyMerged: false,
      sourceBranchDeleted: false,
    };
  }
}
