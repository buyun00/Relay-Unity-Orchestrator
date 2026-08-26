import { HttpError } from "./util.mjs";

function completionError(error) {
  if (error instanceof HttpError) return error;
  return new HttpError(
    500,
    error?.code || "TASK_COMPLETION_FAILED",
    error?.message || "任务收尾失败",
  );
}

export class TaskCompletionService {
  constructor({ store, gitlabClient, projectManagementClient = null }) {
    this.store = store;
    this.gitlabClient = gitlabClient;
    this.projectManagementClient = projectManagementClient;
    this.active = new Map();
  }

  async complete(taskId, actorName = null) {
    if (this.active.has(taskId)) {
      throw new HttpError(
        409,
        "TASK_COMPLETION_IN_PROGRESS",
        "该任务正在执行确认完成流程，请勿重复提交",
      );
    }
    const operation = this.run(taskId, actorName).finally(() => {
      this.active.delete(taskId);
    });
    this.active.set(taskId, operation);
    return operation;
  }

  async completeMany(taskIds, actorName = null) {
    const uniqueTaskIds = [
      ...new Set(taskIds.map((taskId) => String(taskId || "").trim())),
    ].filter(Boolean);
    const results = [];
    for (const taskId of uniqueTaskIds) {
      const existing = this.store.getTask(taskId);
      try {
        const task = await this.complete(taskId, actorName);
        results.push({
          taskId,
          number: task.number,
          status: "completed",
          task,
        });
      } catch (caught) {
        const error = completionError(caught);
        results.push({
          taskId,
          number: existing?.number || null,
          status: "failed",
          error: {
            status: error.status || 500,
            code: error.code || "TASK_COMPLETION_FAILED",
            message: error.message,
          },
        });
      }
    }
    const completed = results.filter(
      (result) => result.status === "completed",
    ).length;
    return {
      total: results.length,
      completed,
      failed: results.length - completed,
      results,
    };
  }

  async completeRelayOnly(taskId, actorName = null) {
    if (this.active.has(taskId)) {
      throw new HttpError(
        409,
        "TASK_COMPLETION_IN_PROGRESS",
        "该任务正在执行确认完成流程，请勿重复提交",
      );
    }
    const task = this.store.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    if (task.status === "closed") return task;
    if (this.store.hasActiveTurn(taskId)) {
      throw new HttpError(
        409,
        "TASK_RUNNING",
        "任务仍有排队或执行中的轮次，不能仅完成 Relay",
      );
    }
    if (task.status !== "waiting_user") {
      throw new HttpError(
        409,
        "TASK_NOT_WAITING_CONFIRMATION",
        "只有待确认任务可以仅完成 Relay",
      );
    }
    return this.store.finishTaskRelayOnly(taskId, actorName);
  }

  async run(taskId, actorName) {
    let task = this.store.getTask(taskId);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found");
    if (task.status === "closed" && task.completion?.status === "completed") {
      return task;
    }
    if (this.store.hasActiveTurn(taskId)) {
      throw new HttpError(
        409,
        "TASK_RUNNING",
        "任务仍有排队或执行中的轮次，不能确认完成",
      );
    }
    if (task.status !== "waiting_user") {
      throw new HttpError(
        409,
        "TASK_NOT_WAITING_CONFIRMATION",
        "只有待确认任务可以执行自动合并",
      );
    }
    const project = this.store.getProject(task.projectId);
    if (!project?.repoUrl || !project?.defaultBranch) {
      throw new HttpError(
        409,
        "TASK_PROJECT_REPOSITORY_INVALID",
        "任务项目缺少 Git 仓库或主分支配置",
      );
    }
    this.store.startTaskCompletion(taskId, actorName);

    let mergeRequest;
    try {
      mergeRequest = await this.gitlabClient.ensureMerged({
        repositoryUrl: project.repoUrl,
        sourceBranch: task.branchName,
        targetBranch: project.defaultBranch,
        title: `Relay ${task.number}: ${task.title}`.slice(0, 240),
        description: [
          `由 Relay 任务 ${task.number} 的“确认完成”流程自动创建并合并。`,
          `任务分支：${task.branchName}`,
          `已验证提交：${task.latestCommitSha}`,
        ].join("\n\n"),
      });
      task = this.store.recordTaskMerge(taskId, mergeRequest, actorName);
    } catch (caught) {
      const error = completionError(caught);
      this.store.failTaskCompletion(taskId, "merge_request", error, actorName);
      throw error;
    }

    const link = this.store.getTaskProjectManagementLink(taskId);
    if (link && !link.resolvedAt) {
      this.store.startProjectManagementCompletion(taskId, actorName);
      try {
        if (!this.projectManagementClient) {
          throw new HttpError(
            503,
            "PROJECT_MANAGEMENT_DISABLED",
            "任务已合并，但轻语集成当前不可用；Relay 尚未标记完成",
          );
        }
        const resolution = await this.projectManagementClient.resolveDefect(
          link.bindingKey,
          {
            defectId: link.defectId,
            externalProjectId: link.externalProjectId,
            userId: link.userId,
            userName: link.userName,
          },
        );
        this.store.recordProjectManagementResolved(
          taskId,
          resolution,
          actorName,
        );
      } catch (caught) {
        const original = completionError(caught);
        const error = new HttpError(
          original.status || 502,
          original.code || "PROJECT_MANAGEMENT_RESOLVE_FAILED",
          `MR 已合并，但轻语缺陷未能设为已解决：${original.message}`,
          {
            mergeRequestIid: mergeRequest?.iid || null,
            mergeRequestUrl: mergeRequest?.webUrl || null,
            causeCode: original.code || null,
          },
        );
        this.store.failTaskCompletion(
          taskId,
          "project_management",
          error,
          actorName,
        );
        throw error;
      }
    }

    try {
      return this.store.finishTaskCompletion(taskId, actorName);
    } catch (caught) {
      const error = completionError(caught);
      this.store.failTaskCompletion(taskId, "relay", error, actorName);
      throw error;
    }
  }
}
