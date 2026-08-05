/**
 * Face matching decision logic.
 *
 * The embeddings coming out of the native pipeline are already L2-normalized, so
 * cosine similarity is just the dot product, and it relates to the L2 distance by
 * `cos = 1 - L2^2 / 2`. We work in cosine space because it is linear and easy to
 * reason about — the previous quadratic distance->percent curve compressed exactly
 * the region where genuine and impostor scores live, which made the margin between
 * the right person and a lookalike look far smaller than it actually is.
 *
 * A match is only accepted when it clears an absolute floor AND beats the closest
 * *other* student by a clear margin. The margin test is what keeps siblings and
 * lookalikes out: an impostor frame often scores high against the person they
 * resemble, but it scores nearly as high against several people, so the gap
 * collapses and the frame is rejected.
 */

export type PoseKey = "front" | "left45" | "right45";

export type MatchableStudent = {
  _id?: string;
  name: string;
  enrollmentNumber: string;
  classId: string;
  faceEmbeddings?: Partial<Record<PoseKey, number[] | null>>;
};

/**
 * Decision thresholds, in cosine-similarity space (-1..1).
 *
 * Measured, not guessed. Set from a two-subject calibration recording (112
 * distinct embeddings, one genuine subject and one sibling impostor):
 *
 *   genuine   min 0.567  p05 0.751  median 0.902  max 0.971
 *   impostor  min 0.380  median 0.643  p95 0.786  max 0.826
 *
 * The distributions OVERLAP: the impostor's best frame (0.826) beats the genuine
 * 5th percentile (0.751), so no absolute floor can separate two real faces on
 * this model. That is why the two thresholds have different jobs, and why
 * `acceptSimilarity` must not be mistaken for the safety net:
 *
 *   - `acceptSimilarity` rejects people who are not enrolled at all.
 *   - `marginOverRunnerUp` rejects the wrong *enrolled* person. This is the one
 *     doing the real work against siblings and lookalikes.
 *
 * In the recording the impostor never ranked first; his closest frame trailed by
 * 0.092, at a side pose (yaw -39) where his score climbed to 0.826 while the
 * genuine score held at 0.918. A 0.10 margin rejects that frame and every other
 * one near it, at a cost of ~8% of genuine frames — which the consensus window
 * absorbs without the user noticing.
 *
 * Re-measure after any change to enrollment, alignment, or the embedding model.
 */
export const MATCH_TUNING = {
  /**
   * Absolute floor the best candidate must clear. Set just under the genuine
   * 5th percentile (0.751). Raising it further is blocked by weak enrollments
   * rather than by impostors — at 0.82 a poorly enrolled subject loses over a
   * third of their own frames while the impostor ceiling is still 0.826.
   */
  acceptSimilarity: 0.75,
  /**
   * How far the winner must beat the closest different student. Set above the
   * largest measured impostor near-miss (0.092).
   */
  marginOverRunnerUp: 0.1,
  /** Frames that must agree, inside the `consensusWindow` most recent frames. */
  consensusRequired: 3,
  consensusWindow: 4,
  /** Yaw (degrees) below which we treat the head as frontal. */
  frontalYawLimit: 20,
  /** Widest yaw we will still trust for a 45-degree pose template. */
  maxPoseYaw: 60,
  /** Reject frames where the head is tilted more than this (degrees). */
  maxRoll: 25,
  /** Both eyes must be at least this open, when ML Kit reports it. */
  minEyeOpenProbability: 0.4,
  /** Usable face brightness window (0-255). */
  minFaceBrightness: 66,
  maxFaceBrightness: 222,
};

/** Cosine similarity of two L2-normalized vectors. Returns -1 when unusable. */
export function cosineSimilarity(a?: number[] | null, b?: number[] | null): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  // Guard against un-normalized vectors sneaking in (e.g. legacy enrollments).
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA <= 0 || normB <= 0) return -1;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  const cos = dot / denom;
  return Math.max(-1, Math.min(1, cos));
}

/**
 * Normalizes a head angle into the signed -180..180 range.
 *
 * The native detector mirrors front-camera angles with `(-angle + 360) % 360`,
 * which folds every negative angle into the 180..360 half instead of keeping it
 * signed. A 25-degree turn came through as 335, so `Math.abs(...)` saw a
 * 335-degree head rotation: side poses in one direction were permanently
 * rejected as "turned too far", `left45` was unreachable on the front camera,
 * and any head tilt in one direction read as ~357 and failed the roll check.
 * Wrapping here fixes both cameras and is a no-op on already-signed values.
 */
export function signedAngle(angle: number | null | undefined): number | null {
  if (angle === null || angle === undefined || !Number.isFinite(angle)) return null;
  let normalized = angle % 360;
  if (normalized > 180) normalized -= 360;
  if (normalized < -180) normalized += 360;
  return normalized;
}

/** Which stored pose template a given yaw angle should be compared against. */
export function poseForYaw(yaw: number): PoseKey {
  const angle = signedAngle(yaw) ?? 0;
  if (Math.abs(angle) <= MATCH_TUNING.frontalYawLimit) return "front";
  return angle < 0 ? "left45" : "right45";
}

/**
 * Yaw windows (as magnitudes, in degrees) that a frame must fall inside to be
 * accepted as a sample for that pose during enrollment.
 *
 * These sit strictly inside the routing bands above — `front` stops short of
 * `frontalYawLimit` and the side poses start past it — so a captured sample can
 * never land on a boundary and get routed to a different template at match time.
 * They are deliberately wide: a natural "slight turn" is around 25-40 degrees,
 * and demanding an exact angle is what makes enrollment feel impossible.
 */
export const POSE_CAPTURE: Record<PoseKey, { minYaw: number; maxYaw: number }> = {
  front: { minYaw: 0, maxYaw: 18 },
  left45: { minYaw: 24, maxYaw: 56 },
  right45: { minYaw: 24, maxYaw: 56 },
};

export type PoseGuidance = {
  /** True when this frame's yaw is usable as a sample for `pose`. */
  inBand: boolean;
  /** What the person should do, or null when they are already in position. */
  hint: string | null;
};

/**
 * Turns a raw yaw reading into actionable guidance for the pose being captured.
 * Distinguishing "not turned enough" from "turned too far" matters — a single
 * generic message leaves the person guessing which way to move.
 */
export function poseCaptureGuidance(yaw: number, pose: PoseKey): PoseGuidance {
  const angle = signedAngle(yaw) ?? 0;
  const band = POSE_CAPTURE[pose];
  const magnitude = Math.abs(angle);

  if (pose === "front") {
    return magnitude <= band.maxYaw
      ? { inBand: true, hint: null }
      : { inBand: false, hint: "look straight at the camera" };
  }

  const side = pose === "left45" ? "left" : "right";
  const turnedWrongWay = pose === "left45" ? angle > 0 : angle < 0;

  if (turnedWrongWay || magnitude < band.minYaw) {
    return { inBand: false, hint: `turn a little more to your ${side}` };
  }
  if (magnitude > band.maxYaw) {
    return { inBand: false, hint: `turned too far — come back toward the camera` };
  }
  return { inBand: true, hint: null };
}

export type QualitySignals = {
  alignmentReady: boolean;
  normalizationReady: boolean;
  embedding: number[] | null;
  yawAngle: number | null;
  rollAngle: number | null;
  leftEyeOpenProbability: number | null;
  rightEyeOpenProbability: number | null;
  faceBrightness: number | null;
};

export type QualityVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Rejects frames that are too poor to make an identity decision on. Bad frames
 * are the main source of score noise, and noise is what lets an impostor spike
 * above the threshold on a lucky frame.
 */
export function checkFrameQuality(face: QualitySignals): QualityVerdict {
  if (!face.embedding || face.embedding.length === 0) {
    return { ok: false, reason: "no embedding yet" };
  }
  if (!face.alignmentReady || !face.normalizationReady) {
    return { ok: false, reason: "face not aligned" };
  }

  // Angles are normalized defensively here too: a caller that forwards a raw
  // native reading would otherwise fail every check on one side of centre.
  const yaw = signedAngle(face.yawAngle);
  if (yaw !== null && Math.abs(yaw) > MATCH_TUNING.maxPoseYaw) {
    return { ok: false, reason: "head turned too far to the side" };
  }

  const roll = signedAngle(face.rollAngle);
  if (roll !== null && Math.abs(roll) > MATCH_TUNING.maxRoll) {
    return { ok: false, reason: "head tilted — straighten up" };
  }

  const { leftEyeOpenProbability: left, rightEyeOpenProbability: right } = face;
  if (
    (left !== null && left < MATCH_TUNING.minEyeOpenProbability) ||
    (right !== null && right < MATCH_TUNING.minEyeOpenProbability)
  ) {
    return { ok: false, reason: "eyes closed" };
  }

  const brightness = face.faceBrightness;
  if (brightness !== null) {
    if (brightness < MATCH_TUNING.minFaceBrightness) return { ok: false, reason: "face too dim" };
    if (brightness > MATCH_TUNING.maxFaceBrightness) return { ok: false, reason: "face overexposed" };
  }

  return { ok: true };
}

export type Candidate = {
  student: MatchableStudent;
  studentId: string;
  similarity: number;
  /** Which of the student's stored templates produced `similarity`. */
  pose: PoseKey;
};

export type ScoredFrame = {
  /** All students that had a usable template for this frame, best first. */
  ranked: Candidate[];
  best: Candidate | null;
  /** Best score belonging to a *different* student than `best`. */
  runnerUp: Candidate | null;
  /** best.similarity - runnerUp.similarity, or `best.similarity + 1` when alone. */
  margin: number;
  /** The pose the head was actually in, from yaw. Reporting only. */
  pose: PoseKey;
};

export function studentKey(student: MatchableStudent): string {
  return student._id || student.enrollmentNumber;
}

export const ALL_POSES: PoseKey[] = ["front", "left45", "right45"];

/**
 * Scores a live embedding against every stored template of every student and
 * reports the ranking plus the gap between the winner and the closest other
 * identity.
 *
 * Each student is scored against *all* of their poses and keeps their best one,
 * rather than being scored only against the template matching the frame's yaw.
 * Routing to a single pose put a cliff at the routing boundary: calibration on a
 * genuine face showed similarity falling from 0.93 to 0.66 across a single
 * degree of head turn, purely because the frame switched templates. It also made
 * the whole system hostage to the weakest template — measured side templates
 * topped out around 0.81-0.87 on the very face they were enrolled from, below
 * the worst frontal frame. Taking the max is monotone: it can only raise a
 * genuine score, it removes the boundary discontinuity entirely, and it degrades
 * gracefully when a pose is missing or was captured badly.
 *
 * It also raises impostor scores slightly, since an impostor now gets a best-of-N
 * draw. That is what `marginOverRunnerUp` and the consensus window are for, and
 * it is why both must be set from measured impostor data rather than guessed.
 */
export function scoreFrame(
  liveEmbedding: number[],
  students: MatchableStudent[],
  yaw: number,
): ScoredFrame {
  const pose = poseForYaw(yaw);

  const ranked: Candidate[] = [];
  for (const student of students) {
    let bestForStudent: Candidate | null = null;
    for (const templatePose of ALL_POSES) {
      const template = student.faceEmbeddings?.[templatePose];
      const similarity = cosineSimilarity(liveEmbedding, template);
      if (similarity <= -1) continue;
      if (!bestForStudent || similarity > bestForStudent.similarity) {
        bestForStudent = {
          student,
          studentId: studentKey(student),
          similarity,
          pose: templatePose,
        };
      }
    }
    if (bestForStudent) ranked.push(bestForStudent);
  }
  ranked.sort((a, b) => b.similarity - a.similarity);

  const best = ranked[0] ?? null;
  const runnerUp = best ? ranked.find((c) => c.studentId !== best.studentId) ?? null : null;
  // With a single enrolled student there is no runner-up to compare against, so
  // the margin test cannot help; fall back to the absolute floor alone.
  const margin = best ? (runnerUp ? best.similarity - runnerUp.similarity : best.similarity + 1) : 0;

  return { ranked, best, runnerUp, margin, pose };
}

export type FrameDecision =
  | { accept: true; candidate: Candidate; scored: ScoredFrame }
  | { accept: false; reason: string; scored: ScoredFrame | null };

/** Applies the absolute-floor and margin rules to a single scored frame. */
export function decideFrame(scored: ScoredFrame): FrameDecision {
  const { best, margin } = scored;
  if (!best) return { accept: false, reason: "no enrolled templates for this pose", scored };
  if (best.similarity < MATCH_TUNING.acceptSimilarity) {
    return { accept: false, reason: "below accept threshold", scored };
  }
  if (margin < MATCH_TUNING.marginOverRunnerUp) {
    // Ambiguous: someone else is nearly as close. This is the lookalike guard.
    return { accept: false, reason: "ambiguous — runner-up too close", scored };
  }
  return { accept: true, candidate: best, scored };
}

/**
 * Sliding window of recent per-frame winners. A match is only confirmed when the
 * same student wins `consensusRequired` of the last `consensusWindow` frames,
 * which stops a single lucky frame from marking attendance.
 */
export class ConsensusTracker {
  private window: (string | null)[] = [];

  push(studentId: string | null): string | null {
    this.window.push(studentId);
    if (this.window.length > MATCH_TUNING.consensusWindow) {
      this.window.shift();
    }
    if (!studentId) return null;

    const agreeing = this.window.filter((id) => id === studentId).length;
    return agreeing >= MATCH_TUNING.consensusRequired ? studentId : null;
  }

  reset() {
    this.window = [];
  }

  /** How many of the frames in the window back `studentId`. */
  countFor(studentId: string): number {
    return this.window.filter((id) => id === studentId).length;
  }
}

/**
 * Cosine -> percentage, for display only. Never feed this back into a decision;
 * the thresholds above are the source of truth. Maps `acceptSimilarity` to 0%
 * and a perfect match to 100% so the number on screen tracks the real headroom.
 */
export function similarityToDisplayPercent(similarity: number): number {
  const floor = MATCH_TUNING.acceptSimilarity;
  const scaled = ((similarity - floor) / (1 - floor)) * 100;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

/** Averages samples and re-normalizes to unit length, producing a centroid template. */
export function averageEmbeddings(samples: number[][]): number[] | null {
  const usable = samples.filter((s) => Array.isArray(s) && s.length > 0);
  if (usable.length === 0) return null;

  const dim = usable[0].length;
  if (usable.some((s) => s.length !== dim)) return null;

  const sum = new Array<number>(dim).fill(0);
  for (const sample of usable) {
    for (let i = 0; i < dim; i++) sum[i] += sample[i];
  }

  let norm = 0;
  for (let i = 0; i < dim; i++) {
    sum[i] /= usable.length;
    norm += sum[i] * sum[i];
  }
  norm = Math.sqrt(norm);
  if (norm <= 0) return null;

  for (let i = 0; i < dim; i++) sum[i] /= norm;
  return sum;
}

/**
 * Mean pairwise cosine similarity of a sample set — a tightness measure for an
 * enrollment capture. Low values mean the frames disagree with each other, which
 * usually means the pose drifted or the crops were poor.
 */
export function sampleCohesion(samples: number[][]): number {
  if (samples.length < 2) return 1;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      total += cosineSimilarity(samples[i], samples[j]);
      pairs++;
    }
  }
  return pairs === 0 ? 1 : total / pairs;
}
