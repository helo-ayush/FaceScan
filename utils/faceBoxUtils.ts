import { RealtimeFace } from "@/components/LiveFaceCamera";

export type PreviewLayout = {
  width: number;
  height: number;
};

export type MappedFaceBox = {
  position: "absolute";
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Maps ML Kit face coordinates (already native-mirrored for front camera) to
 * React Native preview coordinates using "cover" scale behaviour.
 *
 * IMPORTANT: The native module (CameraView.kt / FaceDetector.kt) always mirrors
 * face.x before emitting to JS when on the front camera. This means the
 * coordinates arriving in JS are already correct for the mirrored selfie preview.
 * Never apply an additional mirror in JS — call this with mirrored = false.
 *
 * @param face       - RealtimeFace from onFaceChange (native-mirrored when front cam)
 * @param preview    - Current layout dimensions of the camera preview
 * @param mirrored   - Set to false; native already handled mirroring
 */
export function mapFaceToPreview(
  face: RealtimeFace,
  preview: PreviewLayout,
  mirrored: boolean = false,
): MappedFaceBox | null {
  if (!face.imageWidth || !face.imageHeight || !preview.width || !preview.height) {
    return null;
  }

  const scale = Math.max(
    preview.width / face.imageWidth,
    preview.height / face.imageHeight,
  );
  const renderedWidth = face.imageWidth * scale;
  const renderedHeight = face.imageHeight * scale;
  const offsetX = (preview.width - renderedWidth) / 2;
  const offsetY = (preview.height - renderedHeight) / 2;

  const width = face.width * scale;
  const height = face.height * scale;
  const sourceLeft = face.x * scale + offsetX;

  return {
    position: "absolute",
    left: Math.max(0, mirrored ? preview.width - sourceLeft - width : sourceLeft),
    top: Math.max(0, face.y * scale + offsetY),
    width: Math.min(preview.width, width),
    height: Math.min(preview.height, height),
  };
}
