import React, { PropsWithChildren } from "react";

/** ML Kit is native-only; keep the browser preview working without a detector. */
export function FaceDetectionRoot({ children }: PropsWithChildren) {
  return <>{children}</>;
}
