import React, { PropsWithChildren } from "react";

/**
 * TypeScript's platform-independent fallback. Native runtime resolves the
 * .native implementation; web resolves the .web implementation.
 */
export function FaceDetectionRoot({ children }: PropsWithChildren) {
  return <>{children}</>;
}
