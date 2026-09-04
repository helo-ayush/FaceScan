import React from "react";
import { LayoutChangeEvent } from "react-native";
import { PerformanceMode, ScanningPerformanceMode, LivenessStrictnessMode } from "@/utils/settings";

/**
 * Web fallback for the native camera component.
 * 
 * Note: This file, not `LiveFaceCamera.native.tsx`, is what TypeScript's compiler (`tsc`)
 * resolves for `@/components/LiveFaceCamera`. Any fields added to the native camera's
 * emitted events or props must be typed here so native consumers type-check cleanly.
 */

export type RealtimeFace = {
  /** Width of the source camera frame in native pixels. */
  imageWidth: number;
  /** Height of the source camera frame in native pixels. */
  imageHeight: number;
  /** Bounding box X coordinate (top-left) in mirrored frame space. */
  x: number;
  /** Bounding box Y coordinate (top-left) in mirrored frame space. */
  y: number;
  /** Bounding box width in frame pixels. */
  width: number;
  /** Bounding box height in frame pixels. */
  height: number;
  /** Persistent face tracking ID from ML Kit, or null if tracking is lost. */
  trackingId: number | null;
  /** Probability that the detected face is smiling [0..1]. */
  smilingProbability: number | null;
  /** Probability that the left eye is open [0..1]. */
  leftEyeOpenProbability: number | null;
  /** Probability that the right eye is open [0..1]. */
  rightEyeOpenProbability: number | null;
  /** Mean luminance of the full camera frame [0..255]. */
  frameBrightness: number | null;
  /** Mean luminance inside the face bounding box [0..255]. */
  faceBrightness: number | null;
  /** Mean luminance of the surrounding background [0..255]. */
  backgroundBrightness: number | null;
  /** Whether 5-point affine facial alignment succeeded. */
  alignmentReady: boolean;
  /** Rotation degrees applied to align eye line horizontally. */
  alignmentRotationDegrees: number | null;
  /** Scale factor applied during alignment normalization. */
  alignmentScale: number | null;
  /** Whether face crop normalization met quality thresholds. */
  normalizationReady: boolean;
  /** Fractional coverage of the face within the crop boundary. */
  normalizationCoverage: number | null;
  /** Base64 preview thumbnail string (when preview capture is active). */
  previewBase64: string | null;
  /** L2-normalized 512-dimensional ArcFace embedding vector. */
  embedding: number[] | null;
  /** Duration taken by the native embedding inference step in milliseconds. */
  processDurationMs: number | null;
  /** MiniFASNet anti-spoofing attack score [0..1] (lower represents live face). */
  livenessScore: number | null;
  /** Estimated probability of a 2D printed photo attack. */
  livenessPrintProb?: number | null;
  /** Estimated probability of a screen/video replay attack. */
  livenessReplayProb?: number | null;
  /** Raw logit outputs from the anti-spoof neural network [class0, class1, class2]. */
  livenessRawLogits?: number[] | null;
  /** Argmax classification index (1 = genuine live face, 0/2 = spoof). */
  livenessSelectedClass?: number | null;
  /** Sequential probability decision status ("LIVE", "SPOOF", "INCONCLUSIVE"). */
  livenessStatus?: string | null;
  /** Time elapsed in milliseconds during anti-spoofing evaluation. */
  livenessDurationMs: number | null;
  /** Number of frame samples accumulated into the current SPRT session. */
  livenessSamples: number;
  /** Final Boolean verdict: true if verified genuine, false if verified spoof, null if pending. */
  isLive: boolean | null;
  /**
   * Explanatory prompt when quality gate refuses to score a frame
   * ("MOVE_CLOSER", "MORE_LIGHT", "HOLD_STILL", etc.).
   */
  livenessGuidance?: string | null;
  /** Accumulated log-likelihood ratio evidence in nats (positive favours attack). */
  livenessEvidence?: number | null;
  /** Head yaw angle in degrees (negative = looking left, positive = looking right). */
  yawAngle: number | null;
  /** Head roll / tilt angle in degrees. */
  rollAngle: number | null;
};

export type RealtimeLighting = {
  /** Mean frame luminance [0..255]. */
  frameBrightness: number | null;
  /** Ratio of pixels exceeding saturation thresholds (indicating harsh glare). */
  brightPixelRatio: number | null;
};

export type LiveFaceCameraProps = {
  /** Optional reference to the underlying native camera view. */
  cameraRef?: React.RefObject<any>;
  /** ML Kit detection mode: 'fast' for high FPS scanning, 'accurate' for enrollment. */
  faceDetectorMode?: any;
  /** Callback fired whenever face tracking or biometrics update. */
  onFaceChange: (face: RealtimeFace | null) => void;
  /** Callback fired whenever ambient lighting statistics update. */
  onLightingChange: (lighting: RealtimeLighting) => void;
  /** Tracking frame rate configuration ('low', 'balanced', 'high'). */
  performanceMode: PerformanceMode;
  /** Embedding extraction frequency interval. */
  scanningPerformance?: ScanningPerformanceMode;
  /** Camera lens facing direction ('front' or 'back'). */
  cameraFacing: "front" | "back";
  /** Anti-spoofing sensitivity threshold ('lenient', 'balanced', 'strict'). */
  livenessStrictness?: LivenessStrictnessMode;
  /** Whether to render native face bounding box overlay on the camera preview. */
  showNativeOverlay?: boolean;
  /** Whether to apply native spring smoothing to overlay transitions. */
  smoothNativeOverlay?: boolean;
  /** Callback invoked when the native camera feed is bound and active. */
  onCameraReady: () => void;
  /** Callback invoked if camera permission or sensor binding fails. */
  onError: (message: string) => void;
  /** Callback invoked when preview layout dimensions change. */
  onPreviewLayout: (event: LayoutChangeEvent) => void;
};

/**
 * Web fallback stub for LiveFaceCamera.
 * Returns null as native ML Kit and CameraX operate exclusively on Android/iOS.
 */
export function LiveFaceCamera(_props: LiveFaceCameraProps) {
  return null;
}
