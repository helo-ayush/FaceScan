const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const Class = require("./models/Class");
const Student = require("./models/Student");
const AttendanceLog = require("./models/AttendanceLog");
const SyncConflictLog = require("./models/SyncConflictLog");

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/facescan";

/**
 * The embedding model currently in the app's native pipeline. Stamped onto every
 * enrollment so stale templates can be detected after a model swap rather than
 * silently scoring as noise. Bump this whenever the .tflite asset changes, and
 * re-enroll — templates from different models are not comparable.
 */
const EMBEDDING_MODEL = "w600k_mbf";

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  console.warn("Admin login env vars are missing. Check server/.env and how the backend is started.");
}

// Enable CORS for frontend app
app.use(cors());
// 50 MB limit — class packages with full embedding payloads can be large.
app.use(express.json({ limit: "50mb" }));

// Health check endpoint
app.get("/", (req, res) => {
  res.status(200).json({ status: "ok", message: "Server is healthy", timestamp: new Date().toISOString() });
});

// Establish MongoDB connection
mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("Successfully connected to MongoDB");
  })
  .catch((err) => console.error("MongoDB connection error:", err));

app.get("/api/classes", async (req, res) => {
  try {
    const classes = await Class.find();
    const classesWithCount = await Promise.all(
      classes.map(async (c) => {
        const students = await Student.find({ classId: c.classId });
        const count = students.length;
        const totalLogs = await AttendanceLog.countDocuments({ classId: c.classId });
        const presentLogs = await AttendanceLog.countDocuments({ classId: c.classId, status: "present" });
        const attendanceRate = totalLogs > 0 ? Math.round((presentLogs / totalLogs) * 100) : 0;
        const roster = students.map((s) => ({
          initials: s.name.split(" ").map((n) => n[0]).join(""),
          name: s.name,
          id: s.enrollmentNumber,
        }));
        return {
          id: c.classId,
          code: c.code,
          title: c.name,
          students: count,
          attendance: Math.min(attendanceRate, 100),
          roster: roster,
        };
      })
    );
    res.status(200).json(classesWithCount);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/classes", async (req, res) => {
  const { name, code, classId } = req.body;
  try {
    const classData = { name, code };
    if (classId && classId.trim() !== "") {
      classData.classId = classId.trim();
    }
    const newClass = await Class.create(classData);
    res.status(201).json({ success: true, class: newClass });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Student list endpoint (for client-side fast matching cache)
app.get("/api/students", async (req, res) => {
  try {
    const students = await Student.find();
    // Strip templates that were produced by a different embedding model. They
    // are not comparable to live frames and would score as noise (~0 cosine)
    // against the student's own face, so leaving them in place would make that
    // student silently unrecognizable. The student stays in the roster with
    // `needsReEnrollment` set, so the UI can prompt instead of failing quietly.
    const safe = students.map((student) => {
      const doc = student.toObject();
      if (doc.embeddingModel !== EMBEDDING_MODEL) {
        doc.faceEmbeddings = { front: [], left45: [], right45: [] };
        doc.needsReEnrollment = true;
      }
      return doc;
    });
    res.status(200).json({ success: true, students: safe });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Student enrollment endpoint
app.post("/api/students/enroll", async (req, res) => {
  const { name, enrollmentNumber, classId, faceEmbeddings } = req.body;
  try {
    const newStudent = await Student.create({
      name,
      enrollmentNumber,
      classId,
      faceEmbeddings,
      embeddingModel: EMBEDDING_MODEL,
    });
    // Bump the class's updatedAt so devices know to re-download the package.
    await Class.updateOne({ classId }, { $set: { updatedAt: new Date() } });
    res.status(201).json({ success: true, student: newStudent });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete Class endpoint (and cascade delete its enrolled students and attendance logs)
app.delete("/api/classes/:classId", async (req, res) => {
  const { classId } = req.params;
  try {
    const deletedClass = await Class.findOneAndDelete({ classId });
    if (!deletedClass) {
      return res.status(404).json({ success: false, message: "Class not found" });
    }

    await Student.deleteMany({ classId });
    await AttendanceLog.deleteMany({ classId });

    res.status(200).json({ success: true, message: "Class deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete Student endpoint (and cascade delete their logs)
app.delete("/api/students/:enrollmentNumber", async (req, res) => {
  const { enrollmentNumber } = req.params;
  try {
    const deletedStudent = await Student.findOneAndDelete({ enrollmentNumber });
    if (!deletedStudent) {
      return res.status(404).json({ success: false, message: "Student not found" });
    }

    await AttendanceLog.deleteMany({ enrollmentNumber });

    // Bump the class's updatedAt so devices re-download the package and stop
    // recognizing a student who was removed from the roster.
    if (deletedStudent.classId) {
      await Class.updateOne(
        { classId: deletedStudent.classId },
        { $set: { updatedAt: new Date() } }
      );
    }

    res.status(200).json({ success: true, message: "Student deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Student Stats endpoint
app.get("/api/students/:enrollmentNumber/stats", async (req, res) => {
  const { enrollmentNumber } = req.params;
  const today = new Date().toISOString().split("T")[0];

  try {
    const student = await Student.findOne({ enrollmentNumber });
    if (!student) {
      return res.status(404).json({ success: false, message: "Student not found" });
    }

    const todayLog = await AttendanceLog.findOne({ enrollmentNumber, date: today });
    const todayStatus = todayLog ? todayLog.status : "absent";

    const totalDaysPresent = await AttendanceLog.countDocuments({ enrollmentNumber, status: "present" });

    const firstLog = await AttendanceLog.findOne({ enrollmentNumber }).sort({ timestamp: 1 });
    let averageAttendance = 0;
    
    if (firstLog) {
      const firstDate = new Date(firstLog.timestamp);
      const currentDate = new Date();
      const diffTime = Math.abs(currentDate - firstDate);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1;
      
      averageAttendance = Math.round((totalDaysPresent / diffDays) * 100);
      averageAttendance = Math.min(100, Math.max(0, averageAttendance));
    } else {
      averageAttendance = 0;
    }

    res.status(200).json({
      success: true,
      stats: {
        todayStatus,
        totalDaysPresent,
        averageAttendance,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Attendance logging endpoint.
//
// Recognition happens entirely on-device: the app aligns the face, runs
// MobileFaceNet, and applies the accept threshold + runner-up margin + temporal
// consensus rules in utils/faceMatching.ts. The server used to re-run its own
// match here with a *different* score curve and threshold, which meant the two
// sides could disagree about what counted as a match. It now trusts the device's
// decision and only records it, so there is a single source of truth.
/** YYYY-MM-DD, validated. Anything else is ignored so a bad client cannot
 *  write rows onto an arbitrary date. */
function validLocalDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

app.post("/api/attendance/scan", async (req, res) => {
  const { enrollmentNumber, classId, similarity, margin, pose, localDate, capturedAt, deviceId } = req.body;

  if (!enrollmentNumber) {
    return res.status(400).json({ success: false, message: "enrollmentNumber is required" });
  }

  try {
    const student = await Student.findOne({ enrollmentNumber });
    if (!student) {
      return res.status(404).json({ success: false, message: "Student not found" });
    }

    // The phone's local date, not the server's. `toISOString()` is always UTC,
    // so an evening scan in IST (UTC+5:30) was being filed under tomorrow —
    // the row then never appeared in "today's" logs. Fall back to server time
    // only if the client did not send one.
    const today = validLocalDate(localDate) || new Date().toISOString().split("T")[0];
    const targetClassId = student.classId || classId || "GENERAL";

    // Atomic upsert: the compound unique index on (enrollmentNumber, classId, date)
    // prevents duplicates at the database level.
    const result = await AttendanceLog.updateOne(
      { enrollmentNumber: student.enrollmentNumber, classId: targetClassId, date: today },
      {
        $setOnInsert: {
          status: "present",
          timestamp: capturedAt ? new Date(capturedAt) : new Date(),
          capturedAt: capturedAt ? new Date(capturedAt) : new Date(),
          deviceId: deviceId || "direct",
          syncedAt: new Date(),
          similarity: typeof similarity === "number" ? similarity : undefined,
          margin: typeof margin === "number" ? margin : undefined,
          pose: pose || undefined,
        },
      },
      { upsert: true }
    );

    const alreadyMarked = result.upsertedCount === 0;

    return res.status(200).json({
      success: true,
      alreadyMarked,
      student: {
        name: student.name,
        id: student.enrollmentNumber,
        course: targetClassId,
        initials: student.name.split(" ").map((n) => n[0]).join(""),
      },
      similarity: typeof similarity === "number" ? Math.round(similarity * 1000) / 1000 : null,
      margin: typeof margin === "number" ? Math.round(margin * 1000) / 1000 : null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/attendance/logs", async (req, res) => {
  const { date, startDate, endDate } = req.query;
  try {
    const filter = {};
    if (startDate && endDate) {
      filter.date = { $gte: startDate, $lte: endDate };
    } else {
      const targetDate = date || new Date().toISOString().split("T")[0];
      filter.date = targetDate;
    }

    const logs = await AttendanceLog.find(filter).sort({ timestamp: -1 });
    const enrichedLogs = await Promise.all(
      logs.map(async (l) => {
        const student = await Student.findOne({ enrollmentNumber: l.enrollmentNumber });
        const course = await Class.findOne({ classId: l.classId });
        return {
          id: l.enrollmentNumber,
          name: student ? student.name : "Unknown Student",
          course: course ? `${course.code} - ${course.name}` : l.classId,
          // Formatted on the DEVICE, not here. `toLocaleTimeString` on the
          // server uses the server's timezone — on Render that is UTC, so every
          // log read 5:30 behind for an IST user. Send the raw instant and let
          // the phone render it in whatever zone the phone is in.
          timestamp: l.timestamp,
          time: new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status: l.status,
          date: l.date
        };
      })
    );

    const totalStudents = await Student.countDocuments();
    const presentCount = await AttendanceLog.countDocuments({ ...filter, status: "present" });
    const absentCount = await AttendanceLog.countDocuments({ ...filter, status: "absent" });

    res.status(200).json({
      logs: enrichedLogs,
      stats: {
        present: presentCount,
        absent: absentCount || Math.max(0, totalStudents - presentCount),
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Sync API Routes ─────────────────────────────────────────────────────────
// These routes are the server half of the offline-first sync engine. The device
// always writes to a local queue first, then attemptSync() pushes records here.

/**
 * POST /api/sync/attendance — Atomic attendance upsert.
 *
 * First-sync-wins: if a record already exists for (enrollmentNumber, classId,
 * date), the new one is silently dropped and an info-severity conflict log
 * entry is created. This is the expected behavior when two devices both scan
 * the same student, or a student walks past the camera twice.
 */
app.post("/api/sync/attendance", async (req, res) => {
  const { enrollmentNumber, classId, date, capturedAt, deviceId, similarity, margin, pose } = req.body;

  if (!enrollmentNumber || !classId || !date || !capturedAt || !deviceId) {
    return res.status(400).json({
      success: false,
      message: "enrollmentNumber, classId, date, capturedAt, and deviceId are all required.",
    });
  }

  try {
    // Check if the student still exists. If they were deleted (cascade-delete
    // policy), treat it as a resolved outcome, not an error — §6.3, edge #1.
    const student = await Student.findOne({ enrollmentNumber });
    if (!student) {
      return res.status(200).json({
        success: true,
        resolved: "student_deleted",
        message: "Student no longer exists server-side; record dropped.",
      });
    }

    const result = await AttendanceLog.updateOne(
      { enrollmentNumber, classId, date },
      {
        $setOnInsert: {
          status: "present",
          timestamp: new Date(capturedAt),
          capturedAt: new Date(capturedAt),
          similarity: typeof similarity === "number" ? similarity : undefined,
          margin: typeof margin === "number" ? margin : undefined,
          pose: pose || undefined,
          deviceId,
          syncedAt: new Date(),
        },
      },
      { upsert: true }
    );

    if (result.upsertedCount === 0) {
      // Already marked — expected, not an error.
      await SyncConflictLog.create({
        type: "attendance_already_marked",
        enrollmentNumber,
        classId,
        deviceId,
        message: `Attendance for ${enrollmentNumber} in ${classId} on ${date} was already recorded. This device's record was dropped.`,
        severity: "info",
      });
      return res.status(200).json({ success: true, alreadyMarked: true });
    }

    return res.status(200).json({ success: true, alreadyMarked: false });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/sync/enrollment — Create-or-conflict enrollment.
 *
 * Server-wins on conflict: if the enrollment number already exists, the local
 * enrollment is discarded and a needs_attention conflict log is created for
 * the teacher to resolve manually.
 */
app.post("/api/sync/enrollment", async (req, res) => {
  const { enrollmentNumber, name, classId, faceEmbeddings, embeddingModel, deviceId } = req.body;

  if (!enrollmentNumber || !name || !classId || !faceEmbeddings || !deviceId) {
    return res.status(400).json({
      success: false,
      message: "enrollmentNumber, name, classId, faceEmbeddings, and deviceId are all required.",
    });
  }

  try {
    await Student.create({
      enrollmentNumber,
      name,
      classId,
      faceEmbeddings,
      embeddingModel: embeddingModel || EMBEDDING_MODEL,
    });
    // Bump the class so devices re-download the package with the new student.
    await Class.updateOne({ classId }, { $set: { updatedAt: new Date() } });
    return res.status(201).json({ success: true, created: true });
  } catch (err) {
    if (err.code === 11000) {
      // Mongo duplicate key — enrollment number already taken.
      await SyncConflictLog.create({
        type: "enrollment_number_conflict",
        enrollmentNumber,
        classId,
        deviceId,
        message: `Enrollment number ${enrollmentNumber} already exists — local enrollment discarded.`,
        severity: "needs_attention",
      });
      return res.status(200).json({
        success: true,
        created: false,
        conflict: "enrollment_number_conflict",
        message: `Enrollment number ${enrollmentNumber} already exists.`,
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/classes/:classId/package — Full class embedding package for offline scanning.
 *
 * Returns a manifest with all students and their embeddings, plus a SHA-256
 * checksum the device verifies before trusting the package.
 */
app.get("/api/classes/:classId/package", async (req, res) => {
  const { classId } = req.params;
  try {
    const cls = await Class.findOne({ classId });
    if (!cls) {
      return res.status(404).json({ success: false, message: "Class not found" });
    }

    const students = await Student.find({ classId });

    // Strip students with a different embedding model — their templates are
    // not comparable to the live frames the device will produce.
    const safeStudents = students
      .filter((s) => s.embeddingModel === EMBEDDING_MODEL)
      .map((s) => ({
        enrollmentNumber: s.enrollmentNumber,
        name: s.name,
        faceEmbeddings: s.faceEmbeddings,
        updatedAt: s.updatedAt,
      }));

    const studentsJson = JSON.stringify(safeStudents);
    const checksum = crypto.createHash("sha256").update(studentsJson).digest("hex");

    const manifest = {
      classId: cls.classId,
      className: cls.name,
      generatedAt: new Date().toISOString(),
      embeddingModel: EMBEDDING_MODEL,
      schemaVersion: 1,
      classUpdatedAt: cls.updatedAt ? cls.updatedAt.toISOString() : cls.createdAt.toISOString(),
      checksum,
      students: safeStudents,
    };

    return res.status(200).json(manifest);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/sync/conflict-log — Persist device-side conflict log entries.
 *
 * Accepts an array of conflict entries from a device so they're visible in the
 * admin dashboard without checking each phone individually.
 */
app.post("/api/sync/conflict-log", async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ success: false, message: "entries array is required." });
  }

  try {
    await SyncConflictLog.insertMany(
      entries.map((e) => ({
        type: e.type,
        enrollmentNumber: e.enrollmentNumber,
        classId: e.classId,
        deviceId: e.deviceId,
        message: e.message,
        severity: e.severity,
        createdAt: e.createdAt ? new Date(e.createdAt) : new Date(),
      }))
    );
    return res.status(200).json({ success: true, count: entries.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/sync/conflicts — Retrieve conflict log entries for admin dashboard.
 */
app.get("/api/sync/conflicts", async (req, res) => {
  const { classId, deviceId, severity } = req.query;
  try {
    const filter = {};
    if (classId) filter.classId = classId;
    if (deviceId) filter.deviceId = deviceId;
    if (severity) filter.severity = severity;

    const conflicts = await SyncConflictLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(200);
    return res.status(200).json({ success: true, conflicts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Simple login verification route
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const envUsername = process.env.ADMIN_USERNAME;
  const envPassword = process.env.ADMIN_PASSWORD;

  if (username === envUsername && password === envPassword) {
    return res.status(200).json({ success: true, message: "Authentication successful" });
  } else {
    return res.status(401).json({ success: false, message: "Invalid username or password" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend attendance server running on port ${PORT}`);
});
