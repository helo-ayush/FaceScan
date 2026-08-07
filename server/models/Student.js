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
  /**
   * Which embedding model produced `faceEmbeddings`.
   *
   * Templates are only comparable against a live frame from the same model —
   * embeddings from two different models are unrelated vectors even when they
   * share a dimension count. Measured: the same face through w600k_mbf and
   * w600k_r50 scores −0.015 cosine, i.e. no better than two strangers.
   *
   * Dimension count alone is not a safe check. The r50 -> mbf migration kept
   * 512 dims, so a length comparison would have silently accepted stale
   * templates and left those students permanently unrecognizable with no
   * error surfaced anywhere. Tag the model instead, and re-enroll on change.
   */
  embeddingModel: {
    type: String,
    default: null,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  }
});

module.exports = mongoose.model('Student', StudentSchema);
