import { LayoutChangeEvent } from "react-native";

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
};

type Props = {
  onFaceChange: (face: RealtimeFace | null) => void;
  onCameraReady: () => void;
  onError: (message: string) => void;
  onPreviewLayout: (event: LayoutChangeEvent) => void;
};

/** Web fallback; the native runtime resolves LiveFaceCamera.native.tsx. */
export function LiveFaceCamera(_props: Props) {
  return null;
}
