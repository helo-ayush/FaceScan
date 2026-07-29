const mongoose = require('mongoose');

const AttendanceLogSchema = new mongoose.Schema({
  enrollmentNumber: {
    type: String,
    required: true,
  },
  classId: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['present', 'absent'],
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  date: {
    type: String, // YYYY-MM-DD
    required: true,
  }
});

module.exports = mongoose.model('AttendanceLog', AttendanceLogSchema);
