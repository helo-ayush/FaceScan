import AsyncStorage from '@react-native-async-storage/async-storage';

const DEVICE_ID_KEY = 'facescan_device_id';

/**
 * Generates a v4-style UUID using Math.random (good enough for a device
 * identifier that only needs to be unique across a handful of phones,
 * not cryptographically unpredictable).
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

let cachedDeviceId: string | null = null;

/**
 * Returns a persistent, per-device UUID. Generated once on first launch and
 * stored in AsyncStorage. Used as `deviceId` in every sync payload so the
 * server can distinguish which physical phone produced a given record.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;

  try {
    const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (stored) {
      cachedDeviceId = stored;
      return stored;
    }
  } catch {
    // AsyncStorage read failed — fall through to generate.
  }

  const id = generateUUID();
  try {
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    // Best-effort persist. If it fails, the device gets a new ID next launch,
    // which is mildly annoying for audit logs but not a correctness issue.
  }
  cachedDeviceId = id;
  return id;
}
