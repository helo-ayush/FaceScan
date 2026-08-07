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
  },
  // Audit trail for the on-device decision that produced this row. Keeping the
  // cosine score and the gap over the runner-up makes it possible to review how
  // confident each accepted match actually was, and to re-tune thresholds later.
  similarity: {
    type: Number,
  },
  margin: {
    type: Number,
  },
  pose: {
    type: String,
    enum: ['front', 'left45', 'right45'],
  }
});

module.exports = mongoose.model('AttendanceLog', AttendanceLogSchema);
