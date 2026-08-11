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
  /**
   * The actual on-device time the scan happened, distinct from when it synced.
   * For offline scans this can be hours before `syncedAt`.
   */
  capturedAt: {
    type: Date,
    required: true,
  },
  /**
   * Which physical device produced this record — needed for audit/debugging
   * when multiple phones scan the same class.
   */
  deviceId: {
    type: String,
    required: true,
  },
  /**
   * Server receipt time. Set when the record is persisted server-side.
   */
  syncedAt: {
    type: Date,
    default: Date.now,
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

// Atomic dedupe: at most one attendance record per student per class per day.
// The sync engine uses $setOnInsert + upsert against this index so the
// first-sync-wins rule is enforced by the database, not application logic.
AttendanceLogSchema.index(
  { enrollmentNumber: 1, classId: 1, date: 1 },
  { unique: true }
);

module.exports = mongoose.model('AttendanceLog', AttendanceLogSchema);

