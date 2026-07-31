import { RefObject } from "react";
import type { CameraView } from "expo-camera";

export type DetectedFace = {
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
};

/** TypeScript fallback; native runtime resolves useFaceTracking.native.ts. */
export function useFaceTracking(
  _cameraRef: RefObject<CameraView>,
  _enabled: boolean,
) {
  return { face: null as DetectedFace | null, error: null as string | null };
}
