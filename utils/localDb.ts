import * as SQLite from 'expo-sqlite';

// ─── Types ───────────────────────────────────────────────────────────────────

export type PendingAttendanceRow = {
  id: number;
  enrollment_number: string;
  class_id: string;
  captured_at: string; // ISO timestamp
  local_date: string;  // YYYY-MM-DD
  similarity: number | null;
  margin: number | null;
  pose: string | null;
  synced: number;      // 0 or 1
  retry_count: number;
  last_error: string | null;
  last_attempt_at: string | null;
};

export type PendingEnrollmentRow = {
  id: number;
  enrollment_number: string;
  name: string;
  class_id: string;
  embeddings_json: string;
  embedding_model: string;
  captured_at: string;
  synced: number;
  retry_count: number;
  last_error: string | null;
  last_attempt_at: string | null;
};

export type ConflictLogLocalRow = {
  id: number;
  type: string;
  enrollment_number: string;
  class_id: string;
  device_id: string;
  message: string;
  severity: string;
  created_at: string;
  synced: number;
  retry_count: number;
  last_error: string | null;
  last_attempt_at: string | null;
};

// ─── Database singleton ──────────────────────────────────────────────────────

let db: SQLite.SQLiteDatabase | null = null;

/**
 * Open (or create) the local sync database. Must be called once at app startup
 * before any other localDb functions.
 */
export async function initDb(): Promise<void> {
  if (db) return;
  db = await SQLite.openDatabaseAsync('facescan_sync.db');

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS pending_attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enrollment_number TEXT NOT NULL,
      class_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      local_date TEXT NOT NULL,
      similarity REAL,
      margin REAL,
      pose TEXT,
      synced INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pending_enrollment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enrollment_number TEXT NOT NULL,
      name TEXT NOT NULL,
      class_id TEXT NOT NULL,
      embeddings_json TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS conflict_log_local (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      enrollment_number TEXT NOT NULL DEFAULT '',
      class_id TEXT NOT NULL DEFAULT '',
      device_id TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      created_at TEXT NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Existing installs already have these tables, so add diagnostics as a
  // lightweight forward-only migration. SQLite has no ADD COLUMN IF NOT EXISTS.
  await addColumnIfMissing('pending_attendance', 'retry_count INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing('pending_attendance', 'last_error TEXT');
  await addColumnIfMissing('pending_attendance', 'last_attempt_at TEXT');
  await addColumnIfMissing('pending_enrollment', 'retry_count INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing('pending_enrollment', 'last_error TEXT');
  await addColumnIfMissing('pending_enrollment', 'last_attempt_at TEXT');
  await addColumnIfMissing('conflict_log_local', 'retry_count INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing('conflict_log_local', 'last_error TEXT');
  await addColumnIfMissing('conflict_log_local', 'last_attempt_at TEXT');
}

async function addColumnIfMissing(table: string, definition: string): Promise<void> {
  try {
    await db?.execAsync(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch {
    // Duplicate-column errors mean this app version has already migrated.
  }
}

function getDb(): SQLite.SQLiteDatabase {
  if (!db) throw new Error('localDb not initialized — call initDb() first.');
  return db;
}

// ─── Pending attendance ──────────────────────────────────────────────────────

/**
 * Queue an attendance record for sync. Performs a local dedupe check first:
 * if there's already an unsynced row for the same (enrollment, class, date),
 * the insert is skipped (§5.2).
 *
 * @returns true if the record was inserted, false if it was a local duplicate.
 */
export async function insertPendingAttendance(record: {
  enrollmentNumber: string;
  classId: string;
  capturedAt: string;
  localDate: string;
  similarity?: number;
  margin?: number;
  pose?: string;
}): Promise<boolean> {
  const d = getDb();

  // Local dedupe: skip if an unsynced row already exists for this combo.
  const existing = await d.getFirstAsync<{ id: number }>(
    `SELECT id FROM pending_attendance
     WHERE enrollment_number = ? AND class_id = ? AND local_date = ? AND synced = 0`,
    [record.enrollmentNumber, record.classId, record.localDate]
  );
  if (existing) return false;

  await d.runAsync(
    `INSERT INTO pending_attendance
       (enrollment_number, class_id, captured_at, local_date, similarity, margin, pose)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      record.enrollmentNumber,
      record.classId,
      record.capturedAt,
      record.localDate,
      record.similarity ?? null,
      record.margin ?? null,
      record.pose ?? null,
    ]
  );
  return true;
}

/**
 * Queue an enrollment for sync. Full embedding payloads are stored as JSON.
 */
export async function insertPendingEnrollment(record: {
  enrollmentNumber: string;
  name: string;
  classId: string;
  embeddingsJson: string;
  embeddingModel: string;
  capturedAt: string;
}): Promise<void> {
  const d = getDb();
  await d.runAsync(
    `INSERT INTO pending_enrollment
       (enrollment_number, name, class_id, embeddings_json, embedding_model, captured_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      record.enrollmentNumber,
      record.name,
      record.classId,
      record.embeddingsJson,
      record.embeddingModel,
      record.capturedAt,
    ]
  );
}

/**
 * Record a local conflict log entry (also pushed to server during sync).
 */
export async function insertLocalConflict(record: {
  type: string;
  enrollmentNumber?: string;
  classId?: string;
  deviceId?: string;
  message: string;
  severity?: string;
}): Promise<void> {
  const d = getDb();
  await d.runAsync(
    `INSERT INTO conflict_log_local
       (type, enrollment_number, class_id, device_id, message, severity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      record.type,
      record.enrollmentNumber ?? '',
      record.classId ?? '',
      record.deviceId ?? '',
      record.message,
      record.severity ?? 'info',
      new Date().toISOString(),
    ]
  );
}

// ─── Read unsynced ───────────────────────────────────────────────────────────

export async function getUnsyncedAttendance(): Promise<PendingAttendanceRow[]> {
  const d = getDb();
  return d.getAllAsync<PendingAttendanceRow>(
    `SELECT * FROM pending_attendance WHERE synced = 0 ORDER BY id ASC`
  );
}

export async function getUnsyncedEnrollment(): Promise<PendingEnrollmentRow[]> {
  const d = getDb();
  return d.getAllAsync<PendingEnrollmentRow>(
    `SELECT * FROM pending_enrollment WHERE synced = 0 ORDER BY id ASC`
  );
}

export async function getUnsyncedConflicts(): Promise<ConflictLogLocalRow[]> {
  const d = getDb();
  return d.getAllAsync<ConflictLogLocalRow>(
    `SELECT * FROM conflict_log_local WHERE synced = 0 ORDER BY id ASC`
  );
}

// ─── Mark synced ─────────────────────────────────────────────────────────────

export async function markAttendanceSynced(id: number): Promise<void> {
  const d = getDb();
  await d.runAsync(
    `UPDATE pending_attendance SET synced = 1, last_error = NULL, last_attempt_at = ? WHERE id = ?`,
    [new Date().toISOString(), id]
  );
}

export async function markEnrollmentSynced(id: number): Promise<void> {
  const d = getDb();
  await d.runAsync(
    `UPDATE pending_enrollment SET synced = 1, last_error = NULL, last_attempt_at = ? WHERE id = ?`,
    [new Date().toISOString(), id]
  );
}

export async function markConflictsSynced(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const d = getDb();
  const placeholders = ids.map(() => '?').join(',');
  await d.runAsync(
    `UPDATE conflict_log_local SET synced = 1 WHERE id IN (${placeholders})`,
    ids
  );
}

export async function markAttendanceFailed(id: number, error: string): Promise<void> {
  const d = getDb();
  await d.runAsync(
    `UPDATE pending_attendance
     SET retry_count = retry_count + 1, last_error = ?, last_attempt_at = ?
     WHERE id = ?`,
    [error.slice(0, 300), new Date().toISOString(), id]
  );
}

export async function markEnrollmentFailed(id: number, error: string): Promise<void> {
  const d = getDb();
  await d.runAsync(
    `UPDATE pending_enrollment
     SET retry_count = retry_count + 1, last_error = ?, last_attempt_at = ?
     WHERE id = ?`,
    [error.slice(0, 300), new Date().toISOString(), id]
  );
}

// ─── Aggregate helpers ───────────────────────────────────────────────────────

/**
 * Total number of records waiting to be synced (across all tables).
 */
export async function getPendingCount(): Promise<number> {
  const d = getDb();
  const result = await d.getFirstAsync<{ total: number }>(`
    SELECT
      (SELECT COUNT(*) FROM pending_attendance WHERE synced = 0) +
      (SELECT COUNT(*) FROM pending_enrollment WHERE synced = 0) +
      (SELECT COUNT(*) FROM conflict_log_local WHERE synced = 0) AS total
  `);
  return result?.total ?? 0;
}

/**
 * Get today's local attendance marks (synced or not) for display in the session log.
 */
export async function getTodaysAttendance(localDate: string): Promise<PendingAttendanceRow[]> {
  const d = getDb();
  return d.getAllAsync<PendingAttendanceRow>(
    `SELECT * FROM pending_attendance WHERE local_date = ? ORDER BY id DESC`,
    [localDate]
  );
}
