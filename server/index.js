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

// Establish MongoDB connection
mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("Successfully connected to MongoDB");
    seedDatabase();
  })
  .catch((err) => console.error("MongoDB connection error:", err));

// Seeding standard mock roster data for development checks
async function seedDatabase() {
  try {
    await Class.deleteMany({});
    await Student.deleteMany({});
    await AttendanceLog.deleteMany({});
    console.log("Database collections cleared for fresh seed data...");

    const defaultClasses = [
      { classId: "CLASS-9C", name: "Class 9th C", code: "9C" },
      { classId: "CLASS-10A", name: "Class 10th A", code: "10A" },
      { classId: "CLASS-7B", name: "Class 7th B", code: "7B" }
    ];
    await Class.insertMany(defaultClasses);
    console.log("Seeded default classes");

    const mockEmbedding = Array(128).fill(0);
    const defaultStudents = [
      { name: "Himanshu Kumar", enrollmentNumber: "ENR-9001", classId: "CLASS-9C", faceEmbeddings: { front: mockEmbedding, left45: mockEmbedding, right45: mockEmbedding } },
      { name: "Sarah Jenkins", enrollmentNumber: "ENR-8492", classId: "CLASS-9C", faceEmbeddings: { front: mockEmbedding, left45: mockEmbedding, right45: mockEmbedding } },
      { name: "Marcus Chen", enrollmentNumber: "ENR-3104", classId: "CLASS-9C", faceEmbeddings: { front: mockEmbedding, left45: mockEmbedding, right45: mockEmbedding } },
      { name: "Elena Rodriguez", enrollmentNumber: "ENR-9921", classId: "CLASS-9C", faceEmbeddings: { front: mockEmbedding, left45: mockEmbedding, right45: mockEmbedding } },
      
      { name: "Liam Vance", enrollmentNumber: "ENR-1021", classId: "CLASS-10A", faceEmbeddings: { front: mockEmbedding, left45: mockEmbedding, right45: mockEmbedding } },
      { name: "Sophia Patel", enrollmentNumber: "ENR-1022", classId: "CLASS-10A", faceEmbeddings: { front: mockEmbedding, left45: mockEmbedding, right45: mockEmbedding } },
      { name: "Ethan Carter", enrollmentNumber: "ENR-1023", classId: "CLASS-10A", faceEmbeddings: { front: mockEmbedding, left45: mockEmbedding, right45: mockEmbedding } },
      
      { name: "Ava Morrison", enrollmentNumber: "ENR-2041", classId: "CLASS-7B", faceEmbeddings: { front: mockEmbedding, left45: mockEmbedding, right45: mockEmbedding } },
      { name: "Noah Bennett", enrollmentNumber: "ENR-2042", classId: "CLASS-7B", faceEmbeddings: { front: mockEmbedding, left45: mockEmbedding, right45: mockEmbedding } },
      { name: "Isabella Ross", enrollmentNumber: "ENR-2043", classId: "CLASS-7B", faceEmbeddings: { front: mockEmbedding, left45: mockEmbedding, right45: mockEmbedding } }
    ];
    const insertedStudents = await Student.insertMany(defaultStudents);
    console.log("Seeded default students list");

    console.log("Seeding attendance logs history for the last 10 days...");
    for (let i = 0; i < 10; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];

      for (const student of insertedStudents) {
        const status = Math.random() < 0.8 ? "present" : "absent";
        await AttendanceLog.create({
          enrollmentNumber: student.enrollmentNumber,
          classId: student.classId,
          status,
          date: dateStr,
          timestamp: new Date(dateStr + "T09:00:00")
        });
      }
    }
    console.log("Successfully seeded 10-day attendance logs history");
  } catch (e) {
    console.error("Error seeding database:", e);
  }
}

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

// Attendance checking scan endpoint
app.post("/api/attendance/scan", async (req, res) => {
  const { classId, embedding } = req.body;
  try {
    const students = await Student.find({ classId });
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: "No students enrolled in this class" });
    }

    let bestMatch = null;
    let minDistance = Infinity;
    const threshold = 0.6; // Matches under this Euclidean distance are verified

    function calculateDistance(vecA, vecB) {
      if (!vecA || !vecB || vecA.length !== vecB.length) return Infinity;
      let sum = 0;
      for (let i = 0; i < vecA.length; i++) {
        sum += (vecA[i] - vecB[i]) ** 2;
      }
      return Math.sqrt(sum);
    }

    for (const student of students) {
      const distFront = calculateDistance(embedding, student.faceEmbeddings.front);
      const distLeft = calculateDistance(embedding, student.faceEmbeddings.left45);
      const distRight = calculateDistance(embedding, student.faceEmbeddings.right45);

      const studentMinDist = Math.min(distFront, distLeft, distRight);
      if (studentMinDist < minDistance) {
        minDistance = studentMinDist;
        bestMatch = student;
      }
    }

    // Support mock verification check if vectors are empty placeholders
    const isMockVector = !embedding || embedding.every(v => v === 0);
    if (isMockVector) {
      const randomIndex = Math.floor(Math.random() * students.length);
      bestMatch = students[randomIndex];
      minDistance = 0.2;
    }

    if (bestMatch && minDistance <= threshold) {
      const today = new Date().toISOString().split("T")[0];
      
      let attendance = await AttendanceLog.findOne({
        enrollmentNumber: bestMatch.enrollmentNumber,
        classId,
        date: today,
      });

      if (!attendance) {
        attendance = await AttendanceLog.create({
          enrollmentNumber: bestMatch.enrollmentNumber,
          classId,
          status: "present",
          date: today,
        });
      }

      return res.status(200).json({
        success: true,
        student: {
          name: bestMatch.name,
          id: bestMatch.enrollmentNumber,
          course: classId,
          initials: bestMatch.name.split(" ").map(n => n[0]).join(""),
        },
        distance: minDistance
      });
    } else {
      return res.status(400).json({ success: false, message: "Face verification failed (profile match not found)" });
    }
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
