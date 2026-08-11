import { AppState, AppStateStatus } from 'react-native';
import NetInfo, { NetInfoSubscription } from '@react-native-community/netinfo';
import {
  getUnsyncedAttendance,
  getUnsyncedEnrollment,
  getUnsyncedConflicts,
  markAttendanceSynced,
  markEnrollmentSynced,
  markConflictsSynced,
  markAttendanceFailed,
  markEnrollmentFailed,
  getPendingCount,
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
    // 1. Drain attendance queue
    await syncAttendance(deviceId);

    // 2. Drain enrollment queue
    await syncEnrollment(deviceId);

    // 3. Drain conflict log
    await syncConflictLog();

    // 4. Check for stale class packages
    await refreshStalePackages();

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
        // Success covers: created, or conflict (resolved by discarding).
        await markEnrollmentSynced(row.id);
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
