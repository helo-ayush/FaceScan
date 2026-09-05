/**
 * The single place the backend address is resolved.
 *
 * `EXPO_PUBLIC_API_URL` is inlined by Expo at **build time**, not read at runtime.
 * Changing `.env` therefore has no effect on an already-installed APK — the app
 * must be rebuilt. For a Metro dev run, restart with `npx expo start -c` so the
 * new value is picked up instead of the cached bundle.
 *
 * This used to be copy-pasted into six screens, each with its own fallback, and
 * `login.tsx` fell back to `http://localhost:5000` — which on Android means the
 * *phone itself*, so sign-in failed while every other screen quietly talked to a
 * LAN IP. One constant means one thing to change and no screen disagreeing with
 * the others about where the server is.
 */

/**
 * Last-resort address used only when `EXPO_PUBLIC_API_URL` is missing from the
 * build. A LAN IP is a poor default — it is whatever machine the dev server
 * happened to be on — so treat reaching this as a misconfigured build rather
 * than a working setup. `hasConfiguredApiUrl` below is how a screen can tell.
 */
const FALLBACK_API_URL = 'https://facescan-568n.onrender.com';

/** True when the build actually carries an `EXPO_PUBLIC_API_URL`. */
export const hasConfiguredApiUrl = Boolean(process.env.EXPO_PUBLIC_API_URL);

/**
 * Base URL for every server call, with any trailing slash removed — call sites
 * build paths as `${API_URL}/api/...`, so a configured value ending in `/` would
 * otherwise produce a double slash.
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || FALLBACK_API_URL).replace(/\/+$/, '');
