import React from "react";
import { LayoutChangeEvent } from "react-native";
import { PerformanceMode, ScanningPerformanceMode, LivenessStrictnessMode } from "@/utils/settings";

/**
 * Web fallback. Note this file, not `LiveFaceCamera.native.tsx`, is what `tsc`
 * resolves for `@/components/LiveFaceCamera` — so any field added to the native
 * component's types must be mirrored here or the native-only consumers will not
 * type-check against it.
 */

export type RealtimeFace = {
  imageWidth: number;
  imageHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  trackingId: number | null;
  smilingProbability: number | null;
  leftEyeOpenProbability: number | null;
  rightEyeOpenProbability: number | null;
  frameBrightness: number | null;
  faceBrightness: number | null;
  backgroundBrightness: number | null;
  alignmentReady: boolean;
  alignmentRotationDegrees: number | null;
  alignmentScale: number | null;
  normalizationReady: boolean;
  normalizationCoverage: number | null;
  previewBase64: string | null;
  embedding: number[] | null;
  processDurationMs: number | null;
  livenessScore: number | null;
  livenessPrintProb?: number | null;
  livenessReplayProb?: number | null;
  livenessRawLogits?: number[] | null;
  livenessSelectedClass?: number | null;
  livenessStatus?: string | null;
  livenessDurationMs: number | null;
  livenessSamples: number;
  isLive: boolean | null;
  /**
   * Set when the native quality gate refused to score the frame, e.g.
   * "MOVE_CLOSER" / "MORE_LIGHT" / "HOLD_STILL". Refusal is not a spoof verdict,
   * so the UI must prompt rather than reject.
   */
  livenessGuidance?: string | null;
  /** Accumulated fusion evidence in nats; positive favours attack. Debug/telemetry. */
  livenessEvidence?: number | null;
  yawAngle: number | null;
  rollAngle: number | null;
};

export type RealtimeLighting = {
  frameBrightness: number | null;
  brightPixelRatio: number | null;
};

export type LiveFaceCameraProps = {
  cameraRef?: React.RefObject<any>;
  faceDetectorMode?: any;
  onFaceChange: (face: RealtimeFace | null) => void;
  onLightingChange: (lighting: RealtimeLighting) => void;
  performanceMode: PerformanceMode;
  scanningPerformance?: ScanningPerformanceMode;
  cameraFacing: "front" | "back";
  /** Anti-spoofing operating point; native-only, ignored by this fallback. */
  livenessStrictness?: LivenessStrictnessMode;
  showNativeOverlay?: boolean;
  smoothNativeOverlay?: boolean;
  onCameraReady: () => void;
  onError: (message: string) => void;
  onPreviewLayout: (event: LayoutChangeEvent) => void;
};

/** Web fallback; the native runtime resolves LiveFaceCamera.native.tsx. */
export function LiveFaceCamera(_props: LiveFaceCameraProps) {
  return null;
}
