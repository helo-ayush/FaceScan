import React from "react";
import { LayoutChangeEvent } from "react-native";
import { PerformanceMode, ScanningPerformanceMode } from "@/utils/settings";

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
};

export type RealtimeLighting = {
  frameBrightness: number | null;
  brightPixelRatio: number | null;
};

export type LiveFaceCameraProps = {
  cameraRef?: React.RefObject<any>;
  onFaceChange: (face: RealtimeFace | null) => void;
  onLightingChange: (lighting: RealtimeLighting) => void;
  performanceMode: PerformanceMode;
  scanningPerformance?: ScanningPerformanceMode;
  cameraFacing: "front" | "back";
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
