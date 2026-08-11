const mongoose = require('mongoose');

/**
 * Server-side log of sync conflicts across all devices.
 *
 * Persisted server-side (not just kept on-device) so an admin can see conflicts
 * across all devices from one place, not by checking each phone individually.
 */
const SyncConflictLogSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['attendance_already_marked', 'enrollment_number_conflict'],
    required: true,
  },
  enrollmentNumber: {
    type: String,
    required: true,
  },
  classId: {
    type: String,
  },
  deviceId: {
    type: String,
    required: true,
  },
  message: {
    type: String,
    required: true,
  },
  severity: {
    type: String,
    enum: ['info', 'needs_attention'],
    // "attendance_already_marked" -> info (expected, not an error)
    // "enrollment_number_conflict" -> needs_attention (teacher needs to re-enroll)
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('SyncConflictLog', SyncConflictLogSchema);
