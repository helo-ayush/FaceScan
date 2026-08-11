import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { initDb } from './localDb';
import { getOrCreateDeviceId } from './deviceId';
import {
  initSyncEngine,
  teardownSyncEngine,
  addSyncListener,
  attemptSync,
  notifyScanSessionStart,
  notifyScanSessionEnd,
  type SyncStatus,
} from './syncEngine';

// ─── Context ─────────────────────────────────────────────────────────────────

type SyncContextValue = {
  /** Current sync status (pending count, syncing flag, etc.) */
  status: SyncStatus;
  /** Manually trigger a sync attempt. */
  triggerSync: () => void;
  /** Notify the engine that a scanning session is active (suppress sync). */
  scanSessionStart: () => void;
  /** Notify the engine that a scanning session ended (resume & trigger sync). */
  scanSessionEnd: () => void;
  /** Whether the sync engine has finished initializing. */
  ready: boolean;
  /** The device's persistent UUID. */
  deviceId: string | null;
};

const SyncContext = createContext<SyncContextValue>({
  status: { isSyncing: false, pendingCount: 0, lastSyncAt: null, lastError: null },
  triggerSync: () => {},
  scanSessionStart: () => {},
  scanSessionEnd: () => {},
  ready: false,
  deviceId: null,
});

/**
 * Hook to access the sync engine from any component.
 */
export function useSyncEngine() {
  return useContext(SyncContext);
}

// ─── Provider ────────────────────────────────────────────────────────────────

/**
 * Wraps the app root. Initializes the local SQLite database, generates
 * the device ID, and starts the sync engine with all trigger points.
 */
export function SyncProvider({
  apiUrl,
  children,
}: {
  apiUrl: string;
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<SyncStatus>({
    isSyncing: false,
    pendingCount: 0,
    lastSyncAt: null,
    lastError: null,
  });
  const [ready, setReady] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      try {
        // 1. Open/create the SQLite database.
        await initDb();

        // 2. Get or generate the persistent device UUID.
        const id = await getOrCreateDeviceId();
        if (mounted) setDeviceId(id);

        // 3. Start the sync engine (AppState listener + interval).
        initSyncEngine(apiUrl);

        // 4. Subscribe to status updates.
        const unsubscribe = addSyncListener((s) => {
          if (mounted) setStatus(s);
        });
        cleanupRef.current = unsubscribe;

        if (mounted) setReady(true);

        // 5. Run an initial sync attempt.
        attemptSync();
      } catch (err) {
        console.error('[SyncProvider] Bootstrap failed:', err);
      }
    }

    bootstrap();

    return () => {
      mounted = false;
      cleanupRef.current?.();
      teardownSyncEngine();
    };
  }, [apiUrl]);

  return (
    <SyncContext.Provider
      value={{
        status,
        triggerSync: attemptSync,
        scanSessionStart: notifyScanSessionStart,
        scanSessionEnd: notifyScanSessionEnd,
        ready,
        deviceId,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
}
