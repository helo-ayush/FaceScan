const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const ClassSchema = new mongoose.Schema({
  classId: {
    type: String,
    unique: true,
    default: () => uuidv4(),
  },
  name: {
    type: String,
    required: true,
  },
  code: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  }
});

module.exports = mongoose.model('Class', ClassSchema);
