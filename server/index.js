const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const Class = require("./models/Class");
const Student = require("./models/Student");
const AttendanceLog = require("./models/AttendanceLog");

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/facescan";

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  console.warn("Admin login env vars are missing. Check server/.env and how the backend is started.");
}

// Enable CORS for frontend app
app.use(cors());
app.use(express.json());

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
    res.status(200).json({ success: true, students });
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
    });
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
app.post("/api/attendance/scan", async (req, res) => {
  const { enrollmentNumber, classId, similarity, margin, pose } = req.body;

  if (!enrollmentNumber) {
    return res.status(400).json({ success: false, message: "enrollmentNumber is required" });
  }

  try {
    const student = await Student.findOne({ enrollmentNumber });
    if (!student) {
      return res.status(404).json({ success: false, message: "Student not found" });
    }

    const today = new Date().toISOString().split("T")[0];
    const targetClassId = student.classId || classId || "GENERAL";

    let attendance = await AttendanceLog.findOne({
      enrollmentNumber: student.enrollmentNumber,
      classId: targetClassId,
      date: today,
    });

    // Already marked today: report it without creating a duplicate row.
    const alreadyMarked = Boolean(attendance);

    if (!attendance) {
      attendance = await AttendanceLog.create({
        enrollmentNumber: student.enrollmentNumber,
        classId: targetClassId,
        status: "present",
        date: today,
        similarity: typeof similarity === "number" ? similarity : undefined,
        margin: typeof margin === "number" ? margin : undefined,
        pose: pose || undefined,
      });
    }

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
