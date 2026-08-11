import * as FileSystem from 'expo-file-system';
import * as Crypto from 'expo-crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ClassPackageStudent = {
  enrollmentNumber: string;
  name: string;
  faceEmbeddings: {
    front: number[];
    left45: number[];
    right45: number[];
  };
  updatedAt: string;
};

export type ClassPackageManifest = {
  classId: string;
  className: string;
  generatedAt: string;
  embeddingModel: string;
  schemaVersion: number;
  classUpdatedAt: string;
  checksum: string;
  students: ClassPackageStudent[];
};

export type DownloadedClassInfo = {
  classId: string;
  className: string;
  classUpdatedAt: string;
  downloadedAt: string;
  studentCount: number;
  embeddingModel: string;
};

// ─── Constants ───────────────────────────────────────────────────────────────

/** Schema version this app build supports. Reject packages built for a newer format. */
const SUPPORTED_SCHEMA_VERSION = 1;

/** The embedding model the current app build uses. Must match the package. */
const APP_EMBEDDING_MODEL = 'w600k_mbf';

/**
 * App-private directory for class packages. Using documentDirectory (not
 * cacheDirectory) so the OS doesn't evict them when storage is low — these
 * are deliberately downloaded by the teacher and losing them silently would
 * be confusing.
 */
function packageDir(): string {
  return `${FileSystem.documentDirectory}class_packages/`;
}

function packagePath(classId: string): string {
  return `${packageDir()}${classId}.json`;
}

function metaPath(classId: string): string {
  return `${packageDir()}${classId}.meta.json`;
}

// ─── Checksum verification ───────────────────────────────────────────────────

/**
 * SHA-256 hex digest of the stringified students array. Must match the server's
 * `crypto.createHash('sha256').update(JSON.stringify(students)).digest('hex')`.
 */
async function computeChecksum(students: ClassPackageStudent[]): Promise<string> {
  const serialized = JSON.stringify(students);
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    serialized
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Download a class embedding package from the server, verify its integrity,
 * and store it in app-private storage.
 *
 * Throws on network error, checksum mismatch, or schema/model incompatibility.
 */
export async function downloadClassPackage(
  apiUrl: string,
  classId: string
): Promise<ClassPackageManifest> {
  const response = await fetch(`${apiUrl}/api/classes/${classId}/package`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Package download failed (${response.status}): ${body}`);
  }

  const manifest: ClassPackageManifest = await response.json();

  // ─── Compatibility gates ─────────────────────────────────────────────────
  if (manifest.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Package schema version ${manifest.schemaVersion} is newer than this app supports (${SUPPORTED_SCHEMA_VERSION}). Update the app.`
    );
  }
  if (manifest.embeddingModel !== APP_EMBEDDING_MODEL) {
    throw new Error(
      `Package uses embedding model "${manifest.embeddingModel}" but this app uses "${APP_EMBEDDING_MODEL}". Re-enroll students with the current model.`
    );
  }

  // ─── Checksum verification ───────────────────────────────────────────────
  const computed = await computeChecksum(manifest.students);
  if (computed !== manifest.checksum) {
    throw new Error(
      'Checksum mismatch — the downloaded package may be corrupted or tampered with.'
    );
  }

  // ─── Persist ─────────────────────────────────────────────────────────────
  const dir = packageDir();
  const dirInfo = await FileSystem.getInfoAsync(dir);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }

  // Write the full manifest (with students + embeddings).
  await FileSystem.writeAsStringAsync(
    packagePath(classId),
    JSON.stringify(manifest)
  );

  // Write a lightweight metadata file for listing without parsing large packages.
  const meta: DownloadedClassInfo = {
    classId: manifest.classId,
    className: manifest.className,
    classUpdatedAt: manifest.classUpdatedAt,
    downloadedAt: new Date().toISOString(),
    studentCount: manifest.students.length,
    embeddingModel: manifest.embeddingModel,
  };
  await FileSystem.writeAsStringAsync(metaPath(classId), JSON.stringify(meta));

  return manifest;
}

/**
 * Load a previously-downloaded class package from app-private storage.
 * Verifies checksum on load; returns null if not found or invalid.
 */
export async function loadClassPackage(
  classId: string
): Promise<ClassPackageManifest | null> {
  const path = packagePath(classId);
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) return null;

  try {
    const raw = await FileSystem.readAsStringAsync(path);
    const manifest: ClassPackageManifest = JSON.parse(raw);

    // Re-verify checksum on load to catch corruption.
    const computed = await computeChecksum(manifest.students);
    if (computed !== manifest.checksum) {
      console.warn(`Package for ${classId} failed checksum on load — discarding.`);
      await deleteClassPackage(classId);
      return null;
    }

    // Reject if the app's model changed since the package was downloaded.
    if (manifest.embeddingModel !== APP_EMBEDDING_MODEL) {
      console.warn(`Package for ${classId} uses stale model "${manifest.embeddingModel}" — discarding.`);
      await deleteClassPackage(classId);
      return null;
    }

    return manifest;
  } catch (err) {
    console.warn(`Failed to load package for ${classId}:`, err);
    await deleteClassPackage(classId).catch(() => {});
    return null;
  }
}

/**
 * List all locally downloaded class packages (lightweight — reads only metadata).
 */
export async function getDownloadedClasses(): Promise<DownloadedClassInfo[]> {
  const dir = packageDir();
  const dirInfo = await FileSystem.getInfoAsync(dir);
  if (!dirInfo.exists) return [];

  const files = await FileSystem.readDirectoryAsync(dir);
  const metaFiles = files.filter((f) => f.endsWith('.meta.json'));

  const results: DownloadedClassInfo[] = [];
  for (const file of metaFiles) {
    try {
      const raw = await FileSystem.readAsStringAsync(`${dir}${file}`);
      results.push(JSON.parse(raw));
    } catch {
      // Skip corrupt metadata files.
    }
  }
  return results;
}

/**
 * Delete a locally stored class package.
 */
export async function deleteClassPackage(classId: string): Promise<void> {
  const pkg = packagePath(classId);
  const meta = metaPath(classId);

  const pkgInfo = await FileSystem.getInfoAsync(pkg);
  if (pkgInfo.exists) await FileSystem.deleteAsync(pkg, { idempotent: true });

  const metaInfo = await FileSystem.getInfoAsync(meta);
  if (metaInfo.exists) await FileSystem.deleteAsync(meta, { idempotent: true });
}

/**
 * Check if a locally stored package is stale compared to the server's updatedAt.
 */
export function isPackageStale(
  localUpdatedAt: string,
  serverUpdatedAt: string
): boolean {
  return localUpdatedAt !== serverUpdatedAt;
}
