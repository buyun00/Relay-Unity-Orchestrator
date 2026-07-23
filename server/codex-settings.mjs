import { HttpError } from "./util.mjs";

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_REASONING_EFFORT = "xhigh";
export const DEFAULT_CODEX_FAST_MODE = false;

export const CODEX_MODEL_REASONING_EFFORTS = Object.freeze({
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
});

function choice(value, field, allowed, fallback) {
  const selected = value == null ? fallback : value;
  if (typeof selected !== "string" || !allowed.includes(selected)) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `${field} must be one of: ${allowed.join(", ")}`,
    );
  }
  return selected;
}

export function codexTaskSettings(body, defaults = {}) {
  const models = Object.keys(CODEX_MODEL_REASONING_EFFORTS);
  const fallbackModel = models.includes(defaults.codexModel)
    ? defaults.codexModel
    : DEFAULT_CODEX_MODEL;
  const codexModel = choice(
    body.codexModel,
    "codexModel",
    models,
    fallbackModel,
  );
  const efforts = CODEX_MODEL_REASONING_EFFORTS[codexModel];
  const fallbackEffort = efforts.includes(defaults.codexReasoningEffort)
    ? defaults.codexReasoningEffort
    : DEFAULT_CODEX_REASONING_EFFORT;
  const codexReasoningEffort = choice(
    body.codexReasoningEffort,
    "codexReasoningEffort",
    efforts,
    fallbackEffort,
  );
  const fallbackFastMode =
    typeof defaults.codexFastMode === "boolean"
      ? defaults.codexFastMode
      : DEFAULT_CODEX_FAST_MODE;
  const codexFastMode =
    body.codexFastMode == null ? fallbackFastMode : body.codexFastMode;
  if (typeof codexFastMode !== "boolean") {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "codexFastMode must be a boolean",
    );
  }
  return { codexModel, codexReasoningEffort, codexFastMode };
}
