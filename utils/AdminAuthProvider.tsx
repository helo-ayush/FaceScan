import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

type AdminAuthValue = {
  isAdminUnlocked: boolean;
  unlockAdmin: () => void;
  lockAdmin: () => void;
};

const AdminAuthContext = createContext<AdminAuthValue>({
  isAdminUnlocked: false,
  unlockAdmin: () => {},
  lockAdmin: () => {},
});

export function AdminAuthProvider({ children }: { children: React.ReactNode }) {
  const [isAdminUnlocked, setIsAdminUnlocked] = useState(false);
  const unlockAdmin = useCallback(() => setIsAdminUnlocked(true), []);
  const lockAdmin = useCallback(() => setIsAdminUnlocked(false), []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') lockAdmin();
    });
    return () => subscription.remove();
  }, [lockAdmin]);
  const value = useMemo(() => ({ isAdminUnlocked, unlockAdmin, lockAdmin }), [isAdminUnlocked, lockAdmin, unlockAdmin]);
  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth() {
  return useContext(AdminAuthContext);
}
