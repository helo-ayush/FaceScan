/**
 * Calibration harness (development only).
 *
 * Thresholds should be measured, not guessed. With this enabled, every usable
 * live frame records the cosine similarity of the live face against *every*
 * enrolled student, tagged with who is actually standing in front of the camera.
 *
 * Workflow:
 *   1. Enable calibration and set the ground-truth subject.
 *   2. Have that person scan for ~15 seconds; repeat for each test subject.
 *   3. Export the CSV and look at two distributions:
 *        - genuine  = similarity where candidate == truth
 *        - impostor = similarity where candidate != truth
 *      Pick `acceptSimilarity` above the highest impostor score and
 *      `marginOverRunnerUp` above the largest impostor best-vs-runner-up gap,
 *      leaving headroom below the genuine cluster.
 *   4. Write the numbers into MATCH_TUNING in utils/faceMatching.ts.
 */

import { Share } from "react-native";
import type { PoseKey, ScoredFrame } from "./faceMatching";

export type CalibrationRow = {
  /** Milliseconds since the session started. */
  t: number;
  /** Who is really in front of the camera, as entered by the tester. */
  truth: string;
  /** Which stored template produced this score. */
  pose: PoseKey;
  /** Where the head actually was, from yaw. Differs from `pose` now that every
   *  template competes — the gap between the two is what exposes a weak pose. */
  headPose: PoseKey;
  yaw: number;
  candidateName: string;
  candidateId: string;
  similarity: number;
  /** True when this candidate is the person actually being scanned. */
  genuine: boolean;
  /** Rank of this candidate in the frame (0 = best). */
  rank: number;
  /** Frame-level gap between the best and the closest different student. */
  margin: number;
};

const MAX_ROWS = 20000;

class CalibrationRecorder {
  private enabled = false;
  private truth = "";
  private rows: CalibrationRow[] = [];
  private startedAt: number | null = null;
  private listeners = new Set<() => void>();

  get isEnabled() {
    return this.enabled;
  }

  get currentTruth() {
    return this.truth;
  }

  get rowCount() {
    return this.rows.length;
  }

  /** Number of distinct frames recorded (rows are per candidate, per frame). */
  get frameCount() {
    const seen = new Set<number>();
    for (const row of this.rows) seen.add(row.t);
    return seen.size;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled && this.startedAt === null) {
      this.startedAt = Date.now();
    }
    this.notify();
  }

  setTruth(truth: string) {
    this.truth = truth;
    this.notify();
  }

  /**
   * Records one scored frame. `truth` is matched against candidate names and
   * enrollment numbers case-insensitively, so entering either works.
   */
  record(scored: ScoredFrame, yaw: number) {
    if (!this.enabled || !this.truth.trim()) return;
    if (this.rows.length >= MAX_ROWS) return;

    const truth = this.truth.trim().toLowerCase();
    const t = this.startedAt === null ? 0 : Date.now() - this.startedAt;

    scored.ranked.forEach((candidate, rank) => {
      const { student } = candidate;
      const genuine =
        student.name.trim().toLowerCase() === truth ||
        student.enrollmentNumber.trim().toLowerCase() === truth;

      this.rows.push({
        t,
        truth: this.truth.trim(),
        pose: candidate.pose,
        headPose: scored.pose,
        yaw: Math.round(yaw),
        candidateName: student.name,
        candidateId: student.enrollmentNumber,
        similarity: Number(candidate.similarity.toFixed(5)),
        genuine,
        rank,
        margin: Number(scored.margin.toFixed(5)),
      });
    });

    this.notify();
  }

  clear() {
    this.rows = [];
    this.startedAt = Date.now();
    this.notify();
  }

  /**
   * Separation summary over everything recorded so far. This is the number that
   * actually answers "can I set a threshold with zero false accepts?".
   */
  summary() {
    const genuine = this.rows.filter((r) => r.genuine).map((r) => r.similarity);
    const impostor = this.rows.filter((r) => !r.genuine).map((r) => r.similarity);

    const stats = (values: number[]) => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
      return {
        n: sorted.length,
        min: sorted[0],
        p05: at(0.05),
        median: at(0.5),
        p95: at(0.95),
        max: sorted[sorted.length - 1],
        mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
      };
    };

    const g = stats(genuine);
    const i = stats(impostor);

    return {
      genuine: g,
      impostor: i,
      /**
       * Gap between the worst genuine score and the best impostor score. Positive
       * means a clean separating threshold exists; negative means the
       * distributions overlap and no single cutoff can be safe.
       */
      separation: g && i ? g.min - i.max : null,
      /** A threshold sitting midway in the separating gap, when one exists. */
      suggestedAccept: g && i && g.min > i.max ? Number(((g.min + i.max) / 2).toFixed(3)) : null,
    };
  }

  /** Prints the summary to the console in a readable form. */
  logSummary() {
    const s = this.summary();
    console.log("[Calibration] frames:", this.frameCount, "rows:", this.rows.length);
    console.log("[Calibration] genuine :", s.genuine);
    console.log("[Calibration] impostor:", s.impostor);
    console.log("[Calibration] separation (genuine.min - impostor.max):", s.separation);
    console.log("[Calibration] suggested acceptSimilarity:", s.suggestedAccept);
    if (s.separation !== null && s.separation <= 0) {
      console.warn(
        "[Calibration] Distributions OVERLAP — no single threshold is safe. " +
          "Improve enrollment quality/alignment, or swap the embedding model.",
      );
    }
  }

  toCsv(): string {
    const header = "t,truth,pose,headPose,yaw,candidateName,candidateId,similarity,genuine,rank,margin";
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const lines = this.rows.map((r) =>
      [
        r.t,
        escape(r.truth),
        r.pose,
        r.headPose,
        r.yaw,
        escape(r.candidateName),
        escape(r.candidateId),
        r.similarity,
        r.genuine ? 1 : 0,
        r.rank,
        r.margin,
      ].join(","),
    );
    return [header, ...lines].join("\n");
  }

  /** Opens the OS share sheet with the CSV so it can be pulled off the device. */
  async export() {
    if (this.rows.length === 0) return;
    this.logSummary();
    try {
      await Share.share({
        title: "face-calibration.csv",
        message: this.toCsv(),
      });
    } catch (err) {
      console.warn("[Calibration] export failed", err);
    }
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }
}

export const Calibration = new CalibrationRecorder();
