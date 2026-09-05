import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import {
  getPendingEnrollmentsForClass,
  getCachedClasses,
  getUnsyncedEnrollment,
  getDeletedEnrollmentNumbers,
} from './localDb';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ClassPackageStudent = {
  enrollmentNumber: string;
  name: string;
  faceEmbeddings: {
    front: number[];
    left45?: number[];
    right45?: number[];
  };
  /** New enrollments use one frontal burst instead of three pose captures. */
  captureMode?: 'front_burst' | 'three_pose';
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
  /**
   * True only when a verified embedding package exists on disk for this class.
   *
   * `getAvailableClasses()` deliberately also lists classes that are merely known
   * (synced into `cached_classes`) or that have offline enrollments waiting, so a
   * teacher can pick them straight after enrolling. Those entries cannot be
   * scanned against the server roster, and without this flag they are
   * indistinguishable from a real download — the scan screen showed them with
   * "0 students" and then searched an empty roster forever. Optional because
   * `.meta.json` files written by older builds do not carry it; treat a missing
   * value as unknown and use `getAvailableClasses()`, which always sets it.
   */
  hasPackage?: boolean;
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

// ─── Unified Roster (Offline Matching Support) ───────────────────────────────

/**
 * Load the complete, unified student roster for a class.
 * Combines students from the downloaded package with any locally pending (unsynced)
 * enrollments, allowing offline scanning immediately after offline enrollment.
 */
export async function getUnifiedClassRoster(classId: string): Promise<{
  manifest: ClassPackageManifest | null;
  students: ClassPackageStudent[];
  className: string;
}> {
  const manifest = await loadClassPackage(classId);
  const pending = await getPendingEnrollmentsForClass(classId);
  const deletedNumbers = await getDeletedEnrollmentNumbers();

  // Map pending enrollment rows to ClassPackageStudent (excluding deleted students)
  const pendingStudents: ClassPackageStudent[] = [];
  for (const row of pending) {
    if (deletedNumbers.has(row.enrollment_number)) continue;
    try {
      const embeddings = JSON.parse(row.embeddings_json);
      pendingStudents.push({
        enrollmentNumber: row.enrollment_number,
        name: row.name,
        faceEmbeddings: embeddings,
        captureMode: embeddings.captureMode === 'front_burst' ? 'front_burst' : 'three_pose',
        updatedAt: row.captured_at,
      });
    } catch {
      // Invalid embeddings json, skip
    }
  }

  if (manifest) {
    // Start with manifest students (filtering out deleted), then merge pending students
    const studentMap = new Map<string, ClassPackageStudent>();
    for (const s of manifest.students) {
      if (!deletedNumbers.has(s.enrollmentNumber)) {
        studentMap.set(s.enrollmentNumber, s);
      }
    }
    for (const s of pendingStudents) {
      studentMap.set(s.enrollmentNumber, s);
    }
    const combinedStudents = Array.from(studentMap.values());
    const combinedManifest: ClassPackageManifest = {
      ...manifest,
      students: combinedStudents,
    };
    return {
      manifest: combinedManifest,
      students: combinedStudents,
      className: manifest.className,
    };
  }

  // If no on-disk package exists, check cached_classes in SQLite
  const cachedClasses = await getCachedClasses();
  const cached = cachedClasses.find((c) => c.class_id === classId);
  const className = cached ? `${cached.code} • ${cached.title}` : `Class ${classId}`;

  if (pendingStudents.length > 0 || cached) {
    const syntheticManifest: ClassPackageManifest = {
      classId,
      className,
      generatedAt: new Date().toISOString(),
      embeddingModel: APP_EMBEDDING_MODEL,
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      classUpdatedAt: cached?.updated_at || new Date().toISOString(),
      checksum: '',
      students: pendingStudents,
    };
    return {
      manifest: syntheticManifest,
      students: pendingStudents,
      className,
    };
  }

  return {
    manifest: null,
    students: [],
    className: '',
  };
}

/**
 * Remove a student from a downloaded class package on disk immediately.
 */
export async function removeStudentFromClassPackage(
  classId: string,
  enrollmentNumber: string
): Promise<void> {
  try {
    const manifest = await loadClassPackage(classId);
    if (!manifest) return;
    const remainingStudents = manifest.students.filter(
      (s) => s.enrollmentNumber !== enrollmentNumber
    );
    if (remainingStudents.length === manifest.students.length) return;

    const newChecksum = await computeChecksum(remainingStudents);
    const updatedManifest: ClassPackageManifest = {
      ...manifest,
      checksum: newChecksum,
      students: remainingStudents,
    };
    const path = packagePath(classId);
    await FileSystem.writeAsStringAsync(path, JSON.stringify(updatedManifest));

    const meta: DownloadedClassInfo = {
      classId: manifest.classId,
      className: manifest.className,
      classUpdatedAt: manifest.classUpdatedAt,
      downloadedAt: new Date().toISOString(),
      studentCount: remainingStudents.length,
      embeddingModel: manifest.embeddingModel,
    };
    await FileSystem.writeAsStringAsync(metaPath(classId), JSON.stringify(meta));
  } catch (err) {
    console.warn('Failed to prune student from class package on disk:', err);
  }
}

/**
 * List all available classes for scanning (combining downloaded packages,
 * cached classes from SQLite, and classes with pending enrollments).
 *
 * Only entries with `hasPackage: true` have a verified roster on disk. The rest
 * are listed so a teacher can select a class they just enrolled into offline —
 * check the flag before treating an entry as scannable.
 */
export async function getAvailableClasses(): Promise<DownloadedClassInfo[]> {
  const downloaded = await getDownloadedClasses();
  const cached = await getCachedClasses();
  const pending = await getUnsyncedEnrollment();

  const classMap = new Map<string, DownloadedClassInfo>();

  // 1. Add all downloaded classes
  for (const d of downloaded) {
    classMap.set(d.classId, { ...d, hasPackage: true });
  }

  // 2. Add cached classes that aren't already downloaded
  for (const c of cached) {
    if (!classMap.has(c.class_id)) {
      classMap.set(c.class_id, {
        classId: c.class_id,
        className: `${c.code} • ${c.title}`,
        classUpdatedAt: c.updated_at || new Date().toISOString(),
        downloadedAt: new Date().toISOString(),
        studentCount: 0,
        embeddingModel: APP_EMBEDDING_MODEL,
        hasPackage: false,
      });
    }
  }

  // 3. Update studentCount by adding pending enrollments for each class
  const pendingCountsByClass = new Map<string, number>();
  for (const p of pending) {
    pendingCountsByClass.set(
      p.class_id,
      (pendingCountsByClass.get(p.class_id) || 0) + 1
    );
  }

  for (const [classId, count] of pendingCountsByClass.entries()) {
    const existing = classMap.get(classId);
    if (existing) {
      classMap.set(classId, {
        ...existing,
        studentCount: existing.studentCount + count,
      });
    } else {
      classMap.set(classId, {
        classId,
        className: `Class ${classId}`,
        classUpdatedAt: new Date().toISOString(),
        downloadedAt: new Date().toISOString(),
        studentCount: count,
        embeddingModel: APP_EMBEDDING_MODEL,
        hasPackage: false,
      });
    }
  }

  return Array.from(classMap.values());
}
