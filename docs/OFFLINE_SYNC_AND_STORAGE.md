# Offline Storage, Biometric Packages & Sync Engine

This document details the offline-first data architecture of **FaceScan**, including the local SQLite database, on-device biometric package distribution, SHA-256 integrity verification, and the background synchronization engine.

---

## 1. Offline-First Philosophy

In educational and enterprise environments, network connectivity can be unreliable, intermittent, or unavailable. FaceScan is engineered with a strict **Offline-First Contract**:

```mermaid
graph TD
    subgraph ZeroLatencyOperations["On-Device Zero-Latency Operations (No Internet Required)"]
        Scan["Student Face Scanning & Matching"]
        Enroll["New Student Biometric Enrollment"]
        ClassManage["Roster & Student List Administration"]
        LogReview["Historical Attendance Review"]
        AdminLogin["Admin Credential Verification"]
    end

    subgraph StorageLayer["Local Storage Layer"]
        SQLite["SQLite (facescan_sync.db)"]
        JSONPackages["Class Package Store (Filesystem JSON)"]
        SecureStore["Expo SecureStore (Salted Verifiers)"]
    end

    subgraph AsyncReplication["Asynchronous Background Synchronization"]
        Engine["Sync Engine Worker (syncEngine.ts)"]
        CloudAPI["Cloud REST API (apiConfig.ts)"]
    end

    ZeroLatencyOperations --> StorageLayer
    StorageLayer --> AsyncReplication
```

1. **Zero-Latency Attendance**: Face recognition and matching run 100% on-device. Scanning a student never requires a network call.
2. **Immediate Local Persistence**: Check-ins and enrollments are written to SQLite within **5 milliseconds**.
3. **Immediate Scan-After-Enroll**: A student enrolled offline is instantly recognizable on the same phone without contacting the server.

---

## 2. Local SQLite Database Schema

The local relational database is managed by [`utils/localDb.ts`](file:///c:/Users/Ayush%20Kumar/Desktop/FaceC/utils/localDb.ts) using `expo-sqlite`:

```mermaid
erDiagram
    PENDING_ATTENDANCE {
        int id PK
        string enrollment_number
        string class_id
        string captured_at
        string local_date
        float similarity
        float margin
        string pose
        int synced
        int retry_count
        string last_error
        string last_attempt_at
    }

    PENDING_ENROLLMENT {
        int id PK
        string enrollment_number
        string name
        string class_id
        string embeddings_json
        string embedding_model
        string captured_at
        int synced
        int retry_count
        string last_error
        string last_attempt_at
    }

    CACHED_CLASSES {
        string class_id PK
        string code
        string title
        int student_count
        string downloaded_at
        string last_synced_at
    }

    CONFLICT_LOG {
        int id PK
        string type
        string enrollment_number
        string class_id
        string device_id
        string message
        string severity
        string created_at
        int synced
        int retry_count
        string last_error
        string last_attempt_at
    }

    PENDING_STUDENT_DELETIONS {
        string enrollment_number PK
        string class_id
        string deleted_at
        int synced
        int retry_count
        string last_error
        string last_attempt_at
    }

    CACHED_CLASSES ||--o{ PENDING_ATTENDANCE : contains
    CACHED_CLASSES ||--o{ PENDING_ENROLLMENT : registers
    CACHED_CLASSES ||--o{ PENDING_STUDENT_DELETIONS : tracks
```

---

## 3. On-Device Biometric Packages (`classPackageStore.ts`)

To enable instant face matching without requesting vectors over the network, class rosters are compiled into immutable, self-contained **Biometric Packages**:

```mermaid
graph TD
    subgraph PackageStructure["Class Biometric Package (JSON)"]
        Meta["Metadata (classId, className, schemaVersion, timestamp)"]
        Checksum["SHA-256 Cryptographic Checksum"]
        ModelTag["Embedding Model Version (e.g. w600k_mbf)"]
        Students["Students Array [{ enrollmentNumber, name, faceEmbeddings }]"]
    end

    subgraph Verification["Integrity & Security Gate"]
        Read["Read Package from Disk / Network"]
        HashCalc["Compute SHA-256 Digest using expo-crypto"]
        Compare{"Does Computed Hash Match Manifest Checksum?"}
    end

    subgraph RosterLoad["Active Memory Roster"]
        ActiveRoster["Float32Array Hyperspherical Vector Store"]
    end

    Meta --> Read
    Checksum --> Compare
    Students --> HashCalc
    HashCalc --> Compare
    Compare -- "Valid" --> ActiveRoster
    Compare -- "Corrupt / Tampered" --> Reject["Reject Package & Warn Teacher"]
```

### The Unified Roster Algorithm (`getUnifiedClassRoster`)
How does a teacher enroll a new student in a remote classroom without internet and immediately take their attendance?
1. The on-disk package contains previously downloaded students.
2. The SQLite table `pending_enrollment` contains newly registered students whose vectors have not yet reached the server.
3. The table `pending_student_deletions` contains any students removed offline.
4. [`getUnifiedClassRoster()`](file:///c:/Users/Ayush%20Kumar/Desktop/FaceC/utils/classPackageStore.ts) performs a **dynamic union**:
   $$\text{Active Roster} = (\text{Downloaded Package} \cup \text{Pending Enrollments}) \setminus \text{Pending Deletions}$$

---

## 4. Background Sync Engine (`syncEngine.ts`)

Replication between device SQLite tables and the cloud server is managed asynchronously by [`utils/syncEngine.ts`](file:///c:/Users/Ayush%20Kumar/Desktop/FaceC/utils/syncEngine.ts):

```mermaid
stateDiagram-v2
    [*] --> Idle: App Bootstrapped
    
    Idle --> Syncing: Trigger Fired (Foreground / Timer / Reconnect / Tap)
    
    state Syncing {
        [*] --> CheckOnline: NetInfo & Server Ping
        CheckOnline --> PushDeletions: Device Online
        CheckOnline --> Abort: Device Offline
        
        PushDeletions --> PushEnrollments: Batch Deletions Synced
        PushEnrollments --> PushAttendance: Batch Enrollments Synced
        PushAttendance --> PushConflicts: Batch Attendance Synced
        PushConflicts --> PullClasses: Conflicts Replicated
        PullClasses --> CheckStalePackages: Class List Updated
        CheckStalePackages --> UpdatePackages: Packages Downloaded
        UpdatePackages --> [*]: Sync Complete
    }

    Syncing --> Idle: Success (Reset Backoff & Update lastSyncAt)
    Syncing --> Idle: Failure (Exponential Backoff: 2s -> 4s -> 8s -> 16s)
```

### Sync Trigger Points
1. **App Foregrounding**: `AppState.addEventListener('change')` triggers an immediate sync whenever the app is brought to the foreground.
2. **Network Reconnection**: `NetInfo.addEventListener` detects transitions from offline to online.
3. **Safety Timer**: A background interval fires every **2 minutes** as a safety net.
4. **Session Guard (`scanningSessionActive`)**: Crucially, while a teacher is actively scanning faces on the camera screen, the sync engine **suppresses network activity**. This prevents background HTTP requests from causing frame drops on the CameraX thread.

---

## 5. Offline Encrypted Admin Authentication (`adminAuth.ts`)

Administrators must be able to log in and configure settings even in dead zones.
- Storing plaintext passwords on the mobile device is a severe security vulnerability.
- **The FaceScan Solution**:
  - When the admin logs in successfully online, [`rememberOfflineAdminCredentials`](file:///c:/Users/Ayush%20Kumar/Desktop/FaceC/utils/adminAuth.ts) generates a random 16-byte cryptographic salt and computes:
    $$\text{verifier} = \text{SHA-256}(\text{username} \,\|\, \text{password} \,\|\, \text{salt})$$
  - The salted verifier and salt are stored in encrypted hardware storage using **Expo SecureStore**.
  - When offline, [`verifyOfflineAdminCredentials`](file:///c:/Users/Ayush%20Kumar/Desktop/FaceC/utils/adminAuth.ts) hashes the user's typed credentials against the stored salt and compares digests in constant time. Plaintext passwords are never written to disk.
