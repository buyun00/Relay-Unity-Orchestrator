import { HttpError } from "./util.mjs";

function now() {
  return new Date().toISOString();
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function handoffFromRow(row) {
  if (!row) return null;
  return {
    qaInstanceId: row.qa_instance_id,
    handoffId: row.handoff_id,
    attemptId: row.attempt_id,
    defectId: row.defect_id,
    defectRevision: Number(row.defect_revision),
    projectKey: row.project_key,
    projectId: row.project_id,
    taskId: row.task_id,
    initialTurnId: row.initial_turn_id,
    requestHash: row.request_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function receiptFromRow(row) {
  if (!row) return null;
  return {
    requestHash: row.request_hash,
    response: parseJson(row.response_json),
  };
}

function outboxFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    idempotencyKey: row.idempotency_key,
    relayInstanceId: row.relay_instance_id,
    eventId: row.event_id,
    handoffId: row.handoff_id,
    attemptId: row.attempt_id,
    externalRevision: Number(row.external_revision),
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    body: row.body,
    payloadDigest: row.payload_digest,
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextAttemptAt: row.next_attempt_at,
    leaseExpiresAt: row.lease_expires_at,
    sentAt: row.sent_at,
    responseStatus: row.response_status,
    lastErrorCode: row.last_error_code,
    lastError: row.last_error,
    deadLetterAt: row.dead_letter_at,
  };
}

export class QaHubM2mSqliteStore {
  constructor({ store }) {
    this.store = store;
    this.db = store.db;
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS qa_hub_handoffs (
        qa_instance_id TEXT NOT NULL,
        handoff_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        defect_id TEXT NOT NULL,
        defect_revision INTEGER NOT NULL,
        project_key TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        initial_turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (qa_instance_id, handoff_id)
      );

      CREATE TABLE IF NOT EXISTS qa_hub_m2m_idempotency (
        kind TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (kind, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS qa_hub_webhook_outbox (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        relay_instance_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        handoff_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        external_revision INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        body TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_expires_at TEXT,
        sent_at TEXT,
        response_status INTEGER,
        last_error_code TEXT,
        last_error TEXT,
        dead_letter_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (handoff_id, external_revision)
      );

      CREATE INDEX IF NOT EXISTS qa_hub_handoffs_task_idx
        ON qa_hub_handoffs(task_id);
      CREATE INDEX IF NOT EXISTS qa_hub_webhook_outbox_due_idx
        ON qa_hub_webhook_outbox(status, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS qa_hub_webhook_outbox_handoff_idx
        ON qa_hub_webhook_outbox(handoff_id, external_revision DESC);
    `);
  }

  getIdempotency(key, kind) {
    return receiptFromRow(
      this.db
        .prepare(
          "SELECT * FROM qa_hub_m2m_idempotency WHERE kind=? AND idempotency_key=?",
        )
        .get(kind, key),
    );
  }

  putIdempotency(key, value, kind) {
    const existing = this.getIdempotency(key, kind);
    if (existing) {
      if (existing.requestHash !== value.requestHash) {
        throw new HttpError(
          409,
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
          "Idempotency-Key is already bound to another payload",
        );
      }
      return existing;
    }
    this.db
      .prepare(
        `INSERT INTO qa_hub_m2m_idempotency (
          kind, idempotency_key, request_hash, response_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(kind, key, value.requestHash, JSON.stringify(value.response), now());
    return this.getIdempotency(key, kind);
  }

  getHandoff({ qaInstanceId, handoffId }) {
    return handoffFromRow(
      this.db
        .prepare(
          "SELECT * FROM qa_hub_handoffs WHERE qa_instance_id=? AND handoff_id=?",
        )
        .get(qaInstanceId, handoffId),
    );
  }

  getHandoffByTaskId(taskId) {
    return handoffFromRow(
      this.db
        .prepare("SELECT * FROM qa_hub_handoffs WHERE task_id=?")
        .get(taskId),
    );
  }

  putHandoff(binding) {
    const existing = this.getHandoff(binding);
    if (existing) {
      const sameBinding =
        existing.requestHash === binding.requestHash &&
        existing.attemptId === binding.attemptId &&
        existing.defectId === binding.defectId &&
        existing.projectKey === binding.projectKey &&
        existing.projectId === binding.projectId &&
        existing.taskId === binding.taskId &&
        existing.initialTurnId === binding.initialTurnId;
      if (!sameBinding) {
        throw new HttpError(
          409,
          "QA_HANDOFF_BINDING_CONFLICT",
          "QA handoff is already bound to another Relay task",
        );
      }
      this.db
        .prepare(
          `UPDATE qa_hub_handoffs SET defect_revision=?, updated_at=?
           WHERE qa_instance_id=? AND handoff_id=?`,
        )
        .run(
          binding.defectRevision,
          binding.updatedAt || now(),
          binding.qaInstanceId,
          binding.handoffId,
        );
      return this.getHandoff(binding);
    }
    this.db
      .prepare(
        `INSERT INTO qa_hub_handoffs (
          qa_instance_id, handoff_id, attempt_id, defect_id, defect_revision,
          project_key, project_id, task_id, initial_turn_id, request_hash,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.qaInstanceId,
        binding.handoffId,
        binding.attemptId,
        binding.defectId,
        binding.defectRevision,
        binding.projectKey,
        binding.projectId,
        binding.taskId,
        binding.initialTurnId,
        binding.requestHash,
        binding.createdAt || now(),
        binding.updatedAt || now(),
      );
    return this.getHandoff(binding);
  }

  persistCreate({ binding, key, kind, receipt }) {
    this.putHandoff(binding);
    this.putIdempotency(key, receipt, kind);
  }

  persistContinue({ binding, key, kind, receipt }) {
    this.putIdempotency(key, receipt, kind);
    this.putHandoff(binding);
  }

  m2mAdapter() {
    return {
      getIdempotency: (key, kind) => this.getIdempotency(key, kind),
      putIdempotency: (key, value, kind) =>
        this.putIdempotency(key, value, kind),
      getHandoff: (input) => this.getHandoff(input),
      putHandoff: (binding) => this.putHandoff(binding),
    };
  }

  atomicPersistence() {
    return {
      persistCreate: (input) => this.persistCreate(input),
      persistContinue: (input) => this.persistContinue(input),
    };
  }

  findByDeliveryId(deliveryId) {
    return outboxFromRow(
      this.db
        .prepare("SELECT * FROM qa_hub_webhook_outbox WHERE delivery_id=?")
        .get(deliveryId),
    );
  }

  findLatestByHandoff(handoffId) {
    return outboxFromRow(
      this.db
        .prepare(
          `SELECT * FROM qa_hub_webhook_outbox WHERE handoff_id=?
           ORDER BY external_revision DESC, created_at DESC LIMIT 1`,
        )
        .get(handoffId),
    );
  }

  enqueue(record) {
    const existing = this.findByDeliveryId(record.deliveryId);
    if (existing) {
      if (existing.payloadDigest !== record.payloadDigest) {
        throw new HttpError(
          409,
          "INTEGRATION_EVENT_CONFLICT",
          "Relay webhook delivery ID is already bound to another payload",
        );
      }
      return existing;
    }
    const sameRevision = outboxFromRow(
      this.db
        .prepare(
          `SELECT * FROM qa_hub_webhook_outbox
           WHERE handoff_id=? AND external_revision=?`,
        )
        .get(record.handoffId, record.externalRevision),
    );
    if (sameRevision) {
      if (sameRevision.payloadDigest !== record.payloadDigest) {
        throw new HttpError(
          409,
          "INTEGRATION_EVENT_CONFLICT",
          "Relay webhook revision is already bound to another payload",
        );
      }
      return sameRevision;
    }
    this.db
      .prepare(
        `INSERT INTO qa_hub_webhook_outbox (
          id, delivery_id, idempotency_key, relay_instance_id, event_id,
          handoff_id, attempt_id, external_revision, event_type, occurred_at,
          body, payload_digest, status, attempt_count, next_attempt_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.deliveryId,
        record.idempotencyKey,
        record.relayInstanceId,
        record.eventId,
        record.handoffId,
        record.attemptId,
        record.externalRevision,
        record.eventType,
        record.occurredAt,
        record.body,
        record.payloadDigest,
        record.status || "pending",
        Number(record.attemptCount || 0),
        record.nextAttemptAt,
        record.createdAt,
        record.updatedAt,
      );
    return this.findByDeliveryId(record.deliveryId);
  }

  claim(nowMs = Date.now(), leaseMs = 30_000) {
    const timestamp = new Date(nowMs).toISOString();
    return this.store.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT candidate.* FROM qa_hub_webhook_outbox AS candidate
           WHERE ((candidate.status IN ('pending','retrying')
                 AND candidate.next_attempt_at<=?)
             OR (candidate.status='sending'
                 AND candidate.lease_expires_at IS NOT NULL
                 AND candidate.lease_expires_at<=?))
             AND NOT EXISTS (
               SELECT 1 FROM qa_hub_webhook_outbox AS earlier
               WHERE earlier.handoff_id=candidate.handoff_id
                 AND earlier.external_revision<candidate.external_revision
                 AND earlier.status IN ('pending','retrying','sending')
             )
           ORDER BY candidate.next_attempt_at ASC, candidate.created_at ASC
           LIMIT 1`,
        )
        .get(timestamp, timestamp);
      if (!row) return null;
      const claimed = this.db
        .prepare(
          `UPDATE qa_hub_webhook_outbox
           SET status='sending', attempt_count=attempt_count+1,
             lease_expires_at=?, updated_at=?
           WHERE delivery_id=? AND status IN ('pending','retrying','sending')`,
        )
        .run(
          new Date(nowMs + leaseMs).toISOString(),
          timestamp,
          row.delivery_id,
        );
      return claimed.changes ? this.findByDeliveryId(row.delivery_id) : null;
    });
  }

  markSent(deliveryId, result = {}) {
    const timestamp = result.updatedAt || now();
    this.db
      .prepare(
        `UPDATE qa_hub_webhook_outbox SET status='sent', sent_at=?,
          response_status=?, updated_at=?, lease_expires_at=NULL,
          last_error_code=NULL, last_error=NULL WHERE delivery_id=?`,
      )
      .run(result.sentAt || timestamp, result.status ?? null, timestamp, deliveryId);
    return this.findByDeliveryId(deliveryId);
  }

  markRetry(deliveryId, result = {}) {
    const timestamp = result.updatedAt || now();
    this.db
      .prepare(
        `UPDATE qa_hub_webhook_outbox SET status='retrying',
          next_attempt_at=?, response_status=?, last_error_code=?,
          last_error=?, updated_at=?, lease_expires_at=NULL
          WHERE delivery_id=?`,
      )
      .run(
        result.nextAttemptAt,
        result.status ?? null,
        result.errorCode || "WEBHOOK_RETRYABLE_FAILURE",
        result.error || null,
        timestamp,
        deliveryId,
      );
    return this.findByDeliveryId(deliveryId);
  }

  markDeadLetter(deliveryId, result = {}) {
    const timestamp = result.updatedAt || now();
    this.db
      .prepare(
        `UPDATE qa_hub_webhook_outbox SET status='dead_letter',
          dead_letter_at=?, response_status=?, last_error_code=?,
          last_error=?, updated_at=?, lease_expires_at=NULL
          WHERE delivery_id=?`,
      )
      .run(
        result.deadLetterAt || timestamp,
        result.status ?? null,
        result.errorCode || "WEBHOOK_PERMANENT_FAILURE",
        result.error || null,
        timestamp,
        deliveryId,
      );
    return this.findByDeliveryId(deliveryId);
  }

  recoverSending(nowMs = Date.now()) {
    const timestamp = new Date(nowMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE qa_hub_webhook_outbox SET status='retrying',
          next_attempt_at=?, lease_expires_at=NULL,
          last_error_code='RELAY_RESTARTED_DURING_WEBHOOK', updated_at=?
          WHERE status='sending'`,
      )
      .run(timestamp, timestamp);
    return Number(result.changes || 0);
  }

  list(filters = {}) {
    const rows = filters.status
      ? this.db
          .prepare(
            "SELECT * FROM qa_hub_webhook_outbox WHERE status=? ORDER BY created_at",
          )
          .all(filters.status)
      : this.db
          .prepare("SELECT * FROM qa_hub_webhook_outbox ORDER BY created_at")
          .all();
    return rows.map(outboxFromRow);
  }

  outboxAdapter() {
    return {
      findByDeliveryId: (deliveryId) => this.findByDeliveryId(deliveryId),
      findLatestByHandoff: (handoffId) =>
        this.findLatestByHandoff(handoffId),
      enqueue: (record) => this.enqueue(record),
      claim: (nowMs, leaseMs) => this.claim(nowMs, leaseMs),
      markSent: (deliveryId, result) => this.markSent(deliveryId, result),
      markRetry: (deliveryId, result) => this.markRetry(deliveryId, result),
      markDeadLetter: (deliveryId, result) =>
        this.markDeadLetter(deliveryId, result),
      recoverSending: (nowMs) => this.recoverSending(nowMs),
      list: (filters) => this.list(filters),
    };
  }

  listBoundEvents() {
    const taskIds = this.db
      .prepare("SELECT task_id FROM qa_hub_handoffs ORDER BY created_at")
      .all()
      .map((row) => row.task_id);
    return taskIds
      .flatMap((taskId) => this.store.listTaskEvents(taskId))
      .sort((left, right) => left.id - right.id);
  }
}
