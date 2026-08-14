import { AppState, AppStateStatus } from 'react-native';
import NetInfo, { NetInfoSubscription } from '@react-native-community/netinfo';
import {
  getUnsyncedAttendance,
  getUnsyncedEnrollment,
  getUnsyncedConflicts,
  getUnsyncedStudentDeletions,
  markAttendanceSynced,
  markEnrollmentSynced,
  markConflictsSynced,
  markStudentDeletionSynced,
  markAttendanceFailed,
  markEnrollmentFailed,
  markStudentDeletionFailed,
  getPendingCount,
  replaceCachedClasses,
  deletePendingEnrollment,
  deletePendingAttendanceByEnrollment,
  insertLocalConflict,
} from './localDb';
import { getDownloadedClasses, downloadClassPackage, isPackageStale } from './classPackageStore';
import { getOrCreateDeviceId } from './deviceId';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SyncStatus = {
  isSyncing: boolean;
  pendingCount: number;
  lastSyncAt: string | null;
  lastError: string | null;
  isOnline: boolean | null;
  lastServerContactAt: string | null;
  lastSyncStartedAt: string | null;
};

type SyncListener = (status: SyncStatus) => void;

// ─── Module state ────────────────────────────────────────────────────────────

let isSyncing = false;
let pendingCount = 0;
let lastSyncAt: string | null = null;
let lastError: string | null = null;
let isOnline: boolean | null = null;
let lastServerContactAt: string | null = null;
let lastSyncStartedAt: string | null = null;
let apiUrl: string = '';
let backgroundIntervalId: ReturnType<typeof setInterval> | null = null;
let appStateSubscription: { remove(): void } | null = null;
let networkSubscription: NetInfoSubscription | null = null;

/** Set of listeners notified on every status change. */
const listeners = new Set<SyncListener>();

/** Flag to suppress sync during an active scanning session (§7.4). */
let scanningSessionActive = false;

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Initialize the sync engine. Must be called once at app startup, after
 * `initDb()` and `getOrCreateDeviceId()` have completed.
 *
 * Sets up:
 * - AppState listener (sync on foreground)
 * - Background interval (safety net, every 2 minutes)
 */
export function initSyncEngine(serverApiUrl: string): void {
  apiUrl = serverApiUrl;

  // Sync on app foreground.
  appStateSubscription = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active' && !scanningSessionActive) {
      attemptSync();
    }
  });

  networkSubscription = NetInfo.addEventListener((state) => {
    const online = Boolean(state.isConnected && state.isInternetReachable !== false);
    const wasOffline = isOnline === false;
    isOnline = online;
    emitStatus();
    if (online && wasOffline && !scanningSessionActive) void attemptSync();
  });

  // Safety-net interval: every 2 minutes.
  backgroundIntervalId = setInterval(() => {
    if (!scanningSessionActive) {
      attemptSync();
    }
  }, 2 * 60 * 1000);

  // Immediately check pending count.
  refreshPendingCount();
}

/**
 * Tear down listeners. Call on unmount (though in practice the sync engine
 * lives for the lifetime of the app process).
 */
export function teardownSyncEngine(): void {
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
  if (backgroundIntervalId) {
    clearInterval(backgroundIntervalId);
    backgroundIntervalId = null;
  }
  networkSubscription?.();
  networkSubscription = null;
}

// ─── Scanning session guard (§7.4) ──────────────────────────────────────────

/**
 * Call when a scanning session starts. Suppresses attemptSync() to protect
 * real-time inference performance.
 */
export function notifyScanSessionStart(): void {
  scanningSessionActive = true;
}

/**
 * Call when a scanning session ends. Triggers a sync immediately.
 */
export function notifyScanSessionEnd(): void {
  scanningSessionActive = false;
  void attemptSync(true);
}

// ─── Status listeners ────────────────────────────────────────────────────────

export function addSyncListener(fn: SyncListener): () => void {
  listeners.add(fn);
  // Immediately fire with current state.
  fn(getSyncStatus());
  return () => listeners.delete(fn);
}

export function getSyncStatus(): SyncStatus {
  return { isSyncing, pendingCount, lastSyncAt, lastError, isOnline, lastServerContactAt, lastSyncStartedAt };
}

function noteServerContact(): void {
  isOnline = true;
  lastServerContactAt = new Date().toISOString();
}

function noteSyncFailure(message: string): void {
  lastError = message;
  emitStatus();
}

function emitStatus(): void {
  const status = getSyncStatus();
  for (const fn of listeners) {
    try { fn(status); } catch { /* listener error, swallow */ }
  }
}

async function refreshPendingCount(): Promise<void> {
  try {
    pendingCount = await getPendingCount();
  } catch {
    // DB not ready yet, leave count as-is.
  }
  emitStatus();
}

// ─── Core sync routine ──────────────────────────────────────────────────────

/**
 * The single sync function. Called from every trigger point:
 * - After every local queue write
 * - On app foreground
 * - On background interval
 * - On network reconnect (caller's responsibility)
 * - NOT during active scanning sessions
 *
 * Uses a simple boolean lock to prevent concurrent runs. If already running,
 * returns immediately (the in-progress run will pick up any new records).
 */
export async function attemptSync(force = false): Promise<void> {
  if (isSyncing) return;
  if (!apiUrl) return;
  if (scanningSessionActive) return;
  if (isOnline === false && !force) return;

  isSyncing = true;
  lastError = null;
  lastSyncStartedAt = new Date().toISOString();
  emitStatus();

  const deviceId = await getOrCreateDeviceId();
  const serverContactAtRunStart = lastServerContactAt;

  try {
    // 1. Sync student deletions FIRST (so deleted students are purged on server)
    await syncStudentDeletions();

    // 2. Drain enrollment queue (so newly registered students exist on the server before their attendance is pushed)
    await syncEnrollment(deviceId);

    // 3. Drain attendance queue
    await syncAttendance(deviceId);

    // 4. Drain conflict log
    await syncConflictLog();

    // 5. Check for stale class packages
    await refreshStalePackages();

    // 6. Refresh local class cache for offline enrollment
    await refreshClassCache();

    if (lastServerContactAt && lastServerContactAt !== serverContactAtRunStart) {
      lastSyncAt = new Date().toISOString();
    }
  } catch (err: any) {
    lastError = err?.message || 'Sync failed';
    console.warn('[syncEngine] attemptSync error:', err);
  } finally {
    isSyncing = false;
    await refreshPendingCount();
  }
}

// ─── Student deletions sync ──────────────────────────────────────────────────

async function syncStudentDeletions(): Promise<void> {
  const rows = await getUnsyncedStudentDeletions();
  for (const row of rows) {
    try {
      const res = await fetch(`${apiUrl}/api/students/${encodeURIComponent(row.enrollment_number)}`, {
        method: 'DELETE',
      });

      noteServerContact();
      if (res.ok || res.status === 404) {
        // Success or already deleted on server — mark deletion synced
        await markStudentDeletionSynced(row.enrollment_number);
      } else {
        const error = `Student deletion upload failed (HTTP ${res.status})`;
        await markStudentDeletionFailed(row.enrollment_number, error);
        noteSyncFailure(error);
      }
    } catch (err) {
      const error = 'Cannot reach the server. Student deletion will retry automatically.';
      await markStudentDeletionFailed(row.enrollment_number, error);
      isOnline = false;
      noteSyncFailure(error);
      console.warn(`[syncEngine] Student deletion sync network error for ${row.enrollment_number}:`, err);
      break;
    }
  }
}

// ─── Attendance sync ─────────────────────────────────────────────────────────

async function syncAttendance(deviceId: string): Promise<void> {
  const rows = await getUnsyncedAttendance();
  for (const row of rows) {
    try {
      const res = await fetch(`${apiUrl}/api/sync/attendance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentNumber: row.enrollment_number,
          classId: row.class_id,
          date: row.local_date,
          capturedAt: row.captured_at,
          deviceId,
          similarity: row.similarity,
          margin: row.margin,
          pose: row.pose,
        }),
      });

      noteServerContact();
      if (!res.ok) {
        const error = `Attendance upload failed (HTTP ${res.status})`;
        await markAttendanceFailed(row.id, error);
        noteSyncFailure(error);
        continue;
      }

      const data = await res.json();
      if (data.success) {
        // Success covers: newly created, already marked, student deleted.
        // All are resolved outcomes — mark synced.
        await markAttendanceSynced(row.id);
      }
    } catch (err) {
      const error = 'Cannot reach the server. Attendance will retry automatically.';
      await markAttendanceFailed(row.id, error);
      isOnline = false;
      noteSyncFailure(error);
      console.warn(`[syncEngine] Attendance sync network error for row ${row.id}:`, err);
      break; // If network is down, don't try remaining rows.
    }
  }
}

// ─── Enrollment sync ─────────────────────────────────────────────────────────

async function syncEnrollment(deviceId: string): Promise<void> {
  const rows = await getUnsyncedEnrollment();
  for (const row of rows) {
    try {
      const faceEmbeddings = JSON.parse(row.embeddings_json);
      const res = await fetch(`${apiUrl}/api/sync/enrollment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentNumber: row.enrollment_number,
          name: row.name,
          classId: row.class_id,
          faceEmbeddings,
          embeddingModel: row.embedding_model,
          deviceId,
        }),
      });

      noteServerContact();
      if (!res.ok) {
        const error = `Registration upload failed (HTTP ${res.status})`;
        await markEnrollmentFailed(row.id, error);
        noteSyncFailure(error);
        continue;
      }

      const data = await res.json();
      if (data.success) {
        if (data.created === false || data.conflict) {
          // Server rejected enrollment due to conflict (e.g. enrollment number collision)
          // As required: delete the local pending student and delete all pending attendance for this student
          console.warn(`[syncEngine] Enrollment conflict for ${row.enrollment_number}: ${data.message || 'Discarded'}`);
          await deletePendingEnrollment(row.id);
          await deletePendingAttendanceByEnrollment(row.enrollment_number);
          await insertLocalConflict({
            type: data.conflict || 'enrollment_number_conflict',
            enrollmentNumber: row.enrollment_number,
            classId: row.class_id,
            deviceId,
            message: data.message || `Enrollment number ${row.enrollment_number} already exists on server — local enrollment and attendance discarded.`,
            severity: 'needs_attention',
          });
        } else {
          // Success: created on server
          await markEnrollmentSynced(row.id);
        }
      }
    } catch (err) {
      const error = 'Cannot reach the server. Registration will retry automatically.';
      await markEnrollmentFailed(row.id, error);
      isOnline = false;
      noteSyncFailure(error);
      console.warn(`[syncEngine] Enrollment sync network error for row ${row.id}:`, err);
      break;
    }
  }
}

// ─── Conflict log sync ──────────────────────────────────────────────────────

async function syncConflictLog(): Promise<void> {
  const rows = await getUnsyncedConflicts();
  if (rows.length === 0) return;

  try {
    const res = await fetch(`${apiUrl}/api/sync/conflict-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries: rows.map((r) => ({
          type: r.type,
          enrollmentNumber: r.enrollment_number,
          classId: r.class_id,
          deviceId: r.device_id,
          message: r.message,
          severity: r.severity,
          createdAt: r.created_at,
        })),
      }),
    });

    noteServerContact();
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        await markConflictsSynced(rows.map((r) => r.id));
      }
    }
  } catch (err) {
    isOnline = false;
    noteSyncFailure('Cannot reach the server. Conflict logs will retry automatically.');
    console.warn('[syncEngine] Conflict log sync error:', err);
  }
}

// ─── Class package refresh ───────────────────────────────────────────────────

async function refreshStalePackages(): Promise<void> {
  try {
    const downloaded = await getDownloadedClasses();
    if (downloaded.length === 0) return;

    // Fetch class list from server to get live updatedAt values.
    const res = await fetch(`${apiUrl}/api/classes`);
    if (!res.ok) return;

    const serverClasses: Array<{ id: string; [key: string]: any }> = await res.json();
    // The /api/classes response uses `id` for classId.

    for (const local of downloaded) {
      // Find this class in the server response. The server returns `id` not `classId`.
      // We need the live updatedAt, but /api/classes doesn't return it directly.
      // Fetch the class's package metadata instead — check if classUpdatedAt differs.
      try {
        const metaRes = await fetch(`${apiUrl}/api/classes/${local.classId}/package`);
        if (!metaRes.ok) continue;
        const manifest = await metaRes.json();
        if (isPackageStale(local.classUpdatedAt, manifest.classUpdatedAt)) {
          // Re-download the full package (we already have the response).
          // But the checksum verification and storage happen in downloadClassPackage,
          // so just call it again for consistency.
          await downloadClassPackage(apiUrl, local.classId);
        }
      } catch {
        // Network issue — skip this class, try next.
      }
    }
  } catch (err) {
    console.warn('[syncEngine] Package refresh error:', err);
  }
}

// ─── Class cache refresh (offline enrollment) ────────────────────────────────

/**
 * Fetch the full class list from the server and cache it locally so the
 * enrollment dropdown works even when the device is completely offline.
 */
async function refreshClassCache(): Promise<void> {
  try {
    const res = await fetch(`${apiUrl}/api/classes`);
    if (!res.ok) return;

    noteServerContact();
    const serverClasses: Array<{ id: string; code: string; title: string; updatedAt?: string }> = await res.json();

    await replaceCachedClasses(
      serverClasses.map((c) => ({
        id: c.id,
        code: c.code,
        title: c.title,
        updatedAt: c.updatedAt,
      }))
    );
  } catch (err) {
    // Network down — keep existing cache, don't fail the sync.
    console.warn('[syncEngine] Class cache refresh error:', err);
  }
}
