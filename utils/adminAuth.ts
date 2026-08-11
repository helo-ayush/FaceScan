import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const OFFLINE_VERIFIER_KEY = 'facescan_offline_admin_verifier_v1';

type OfflineVerifier = {
  username: string;
  salt: string;
  verifier: string;
  lastVerifiedAt: string;
};

async function hashCredentials(username: string, password: string, salt: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${username.trim().toLowerCase()}\u0000${password}\u0000${salt}`
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Store only a salted verifier in encrypted device storage — never the password. */
export async function rememberOfflineAdminCredentials(username: string, password: string): Promise<void> {
  const salt = bytesToHex(await Crypto.getRandomBytesAsync(16));
  const verifier: OfflineVerifier = {
    username: username.trim().toLowerCase(),
    salt,
    verifier: await hashCredentials(username, password, salt),
    lastVerifiedAt: new Date().toISOString(),
  };
  await SecureStore.setItemAsync(OFFLINE_VERIFIER_KEY, JSON.stringify(verifier));
}

/** Verify a freshly typed password while offline. This does not auto-unlock Admin. */
export async function verifyOfflineAdminCredentials(username: string, password: string): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(OFFLINE_VERIFIER_KEY);
  if (!raw) return false;
  try {
    const saved: OfflineVerifier = JSON.parse(raw);
    if (saved.username !== username.trim().toLowerCase()) return false;
    return (await hashCredentials(username, password, saved.salt)) === saved.verifier;
  } catch {
    return false;
  }
}
