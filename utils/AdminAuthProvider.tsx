import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { usePathname, useRouter } from 'expo-router';

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

/** Routes where an unlocked admin session must stay unlocked. */
const ADMIN_SURFACES = /^\/(dashboard|classes|enroll|logs|sync|settings)$/;

export function AdminAuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isAdminUnlocked, setIsAdminUnlocked] = useState(false);
  const unlockAdmin = useCallback(() => setIsAdminUnlocked(true), []);
  const lockAdmin = useCallback(() => setIsAdminUnlocked(false), []);

  // Locking used to live in the tabs layout's focus-effect cleanup, which fired
  // on *every* blur — including pushing /settings on top of the tabs — so coming
  // back from settings bounced through /login, and the cleanup's lock racing the
  // back-navigation made hardware-back land on /login too. Locking is decided
  // here from the settled pathname instead:
  //  - on any non-admin surface (except /login, which may be mid-sign-in with
  //    the unlock already dispatched) the session is over;
  //  - on an admin surface without an unlock (cold deep link, or the AppState
  //    lock that fired while backgrounded) send the user to the gate.
  useEffect(() => {
    if (ADMIN_SURFACES.test(pathname)) {
      if (!isAdminUnlocked) router.replace('/login');
    } else if (pathname !== '/login') {
      lockAdmin();
    }
  }, [pathname, isAdminUnlocked, lockAdmin, router]);

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
