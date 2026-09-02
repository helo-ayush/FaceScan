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
  captureMode?: "front_burst" | "three_pose";
};

/**
 * Decision thresholds, in cosine-similarity space (-1..1).
 *
 * Measured from a two-subject calibration recording on the current pipeline
 * (ArcFace `w600k_mbf`, 512-dim, with the `norm_crop` alignment template),
 * 2042 comparisons across both subjects and all three poses, deliberately
 * including varied and uneven lighting:
 *
 *   genuine   min 0.717  p05 0.760  median 0.831  max 0.891
 *   impostor  min 0.299  median 0.428  p95 0.491  max 0.515
 *
 * The distributions DO NOT overlap: the worst genuine frame (0.717) beats the
 * best impostor frame (0.515) by 0.202, and no wrong person ranked first in any
 * frame. This is a change in kind from the previous pipeline, where the two
 * overlapped by 0.035 and only the margin test prevented false accepts.
 *
 * The two thresholds still have different jobs:
 *
 *   - `acceptSimilarity` rejects people who are not enrolled at all. With a
 *     single enrolled student it is the ONLY protection, because the margin
 *     test has no runner-up to compare against.
 *   - `marginOverRunnerUp` rejects the wrong *enrolled* person.
 *
 * Re-measure with `scripts/analyze-calibration.js` after any change to the
 * embedding model, the alignment template, or enrollment.
 */
export const MATCH_TUNING = {
  /**
   * Absolute floor the best candidate must clear.
   *
   * This guards against people who are NOT enrolled. It does nothing against
   * the wrong *enrolled* person — a sibling scanning their own face clears any
   * floor legitimately, and `marginOverRunnerUp` is what stops them being
   * matched to someone else.
   *
   * Set at 0.66, which keeps 100% of the measured genuine frames (the worst was
   * 0.717) while sitting well above the impostor range. It is deliberately not
   * fitted just under the genuine 5th percentile (0.760): uneven lighting is
   * what drives genuine scores down, the recording's weakest frames came from
   * exactly that, and 0.057 of buffer below the worst measured frame leaves
   * room for lighting worse than has been tested.
   *
   * Why not lower, at the midpoint of the measured gap (0.62)? Because the
   * impostor ceiling grows with roster size. The recording had two people, so a
   * stranger got one draw at resembling someone; in a class of 40 they get 40.
   * Extrapolating the measured impostor tail (mean 0.426, sd 0.049) puts a
   * 1-in-100 unlucky stranger at ~0.595 against a 40-person roster, which 0.62
   * would clear by only 0.025.
   */
  acceptSimilarity: 0.66,
  /**
   * How far the winner must beat the closest different student.
   *
   * The smallest measured margin was 0.263, but that is from a two-person
   * enrollment and does not generalize: with a full class the runner-up is the
   * nearest of many rather than the nearest of one, so margins compress. Set
   * well below the measured value so class growth does not start rejecting
   * genuine frames, while still far above any observed ambiguity.
   *
   * Revisit this once a realistically sized class is enrolled — it is the
   * threshold most sensitive to roster size.
   */
  marginOverRunnerUp: 0.15,
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
  /**
   * Similarity that the on-screen percentage treats as full confidence.
   *
   * Set to the measured genuine 5th percentile (0.760). A frame at or above
   * this is statistically indistinguishable from a normal correct match, so
   * showing anything less than 100% would misrepresent it.
   *
   * This exists because scaling against a perfect 1.0 is wrong for ArcFace:
   * genuine pairs top out around 0.89, so 1.0 is unreachable and every correct
   * match displayed as mediocre. A genuine frame under uneven lighting (0.717,
   * the worst ever measured, and still 0.202 clear of the best impostor) showed
   * as 53% and read as a near-failure when it was nothing of the sort.
   */
  displayFullConfidence: 0.76,
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
 * `frontalYawLimit` (20) and the side poses start past it — so a captured sample
 * can never land on a boundary and get routed to a different template at match
 * time. The side windows target a gentle ~30-degree turn and accept anything
 * from a barely-turned 22 degrees up to a moderate 45, guiding the person into
 * position instead of demanding an exact angle.
 */
export const POSE_CAPTURE: Record<PoseKey, { minYaw: number; maxYaw: number }> = {
  front: { minYaw: 0, maxYaw: 18 },
  left45: { minYaw: 22, maxYaw: 45 },
  right45: { minYaw: 22, maxYaw: 45 },
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
export function checkFrameQuality(
  face: QualitySignals,
  options: { requireGoodLighting?: boolean } = {},
): QualityVerdict {
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

  const brightness = face.faceBrightness;
  if (options.requireGoodLighting !== false && brightness !== null) {
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
    const templatePoses = student.captureMode === "front_burst" ? ["front" as const] : ALL_POSES;
    for (const templatePose of templatePoses) {
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
 * the thresholds above are the source of truth.
 *
 * NOT currently wired to the scan UI, deliberately. The match card used to show
 * this as "N% MATCH" and it read as fabricated data: because the scale saturates
 * at `displayFullConfidence`, 96% of genuine frames displayed as exactly 100%,
 * which is not a number any real face produces. The card now shows raw cosine.
 * If you re-introduce this, label it "confidence", never "similarity".
 *
 * Maps `acceptSimilarity` to 0% and `displayFullConfidence` to 100%, NOT a
 * perfect 1.0. ArcFace genuine pairs measured on this pipeline top out at 0.891,
 * so scaling against 1.0 made every correct match read as mediocre — a solid
 * frame showed as 82% and a dimly lit but perfectly safe one as 53%, which reads
 * as a near-miss when it is actually 0.202 clear of the best impostor.
 *
 * Note that a well-separated system SHOULD show mostly 100% for the right person
 * and 0% for everyone else. That is what clean separation looks like on a
 * confidence readout; it is not the bar being broken. Watch raw cosine in the
 * calibration panel when you need the underlying number.
 */
export function similarityToDisplayPercent(similarity: number): number {
  const floor = MATCH_TUNING.acceptSimilarity;
  const ceiling = MATCH_TUNING.displayFullConfidence;
  // A later threshold edit could collapse the range; don't emit NaN for it.
  if (ceiling <= floor) return similarity >= floor ? 100 : 0;
  const scaled = ((similarity - floor) / (ceiling - floor)) * 100;
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
