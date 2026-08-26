import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PROJECT_MANAGEMENT_SESSION_STATE_FORMAT,
  ProjectManagementSessionStore,
} from "../../server/project-management-session-store.mjs";

test(
  "project management session state survives restart without plaintext tokens on disk",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "relay-project-management-session-store-"),
    );
    const statePath = path.join(directory, "sessions.dpapi.json");
    const store = new ProjectManagementSessionStore({
      statePath,
      scriptPath: path.resolve(
        "scripts",
        "Protect-ProjectManagementSessions.ps1",
      ),
    });
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const state = {
      format: PROJECT_MANAGEMENT_SESSION_STATE_FORMAT,
      savedAt: "2026-08-12T00:00:00.000Z",
      sessions: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          createdAt: 1,
          lastUsedAt: 2,
          bindingKey: "a".repeat(64),
          relayUserName: "Relay 用户甲",
          token: "plaintext-token-must-not-appear-on-disk",
          user: { id: "17", name: "轻羽用户甲", avatar: null },
        },
      ],
    };

    await store.save(state);
    const encrypted = fs.readFileSync(statePath, "utf8");
    assert.match(encrypted, /relay-project-management-sessions-dpapi-v1/u);
    assert.doesNotMatch(encrypted, /plaintext-token/u);
    assert.doesNotMatch(encrypted, /Relay 用户甲/u);
    assert.deepEqual(await store.load(), state);

    const replaced = structuredClone(state);
    replaced.sessions[0].token = "replacement-token-must-stay-encrypted";
    await store.save(replaced);
    assert.deepEqual(await store.load(), replaced);
    assert.doesNotMatch(
      fs.readFileSync(statePath, "utf8"),
      /replacement-token/u,
    );
  },
);
