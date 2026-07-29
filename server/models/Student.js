const mongoose = require('mongoose');

const StudentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  enrollmentNumber: {
    type: String,
    required: true,
    unique: true,
  },
  classId: {
    type: String, // Matches Class.classId
    required: true,
  },
  faceEmbeddings: {
    front: { type: [Number], default: [] },
    left45: { type: [Number], default: [] },
    right45: { type: [Number], default: [] }
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  }
});

module.exports = mongoose.model('Student', StudentSchema);
