import { createPermissionHook } from 'expo-modules-core'
import { PermissionResponse } from './Camera.types'
import CameraManager from './CameraManager'
export { default as CameraView } from './CameraView'

/**
 * Checks user's permissions for accessing camera.
 * @return A promise that resolves to an object of type PermissionResponse.
 */
async function getCameraPermissionsAsync(): Promise<PermissionResponse> {
  return CameraManager.getCameraPermissionsAsync()
}

/**
 * Asks the user to grant permissions for accessing camera.
 * On iOS this will require apps to specify an `NSCameraUsageDescription` entry in the **Info.plist**.
 * @return A promise that resolves to an object of type PermissionResponse.
 */
async function requestCameraPermissionsAsync(): Promise<PermissionResponse> {
  return CameraManager.requestCameraPermissionsAsync()
}

/**
 * Check or request permissions to access the camera.
 * This uses both `requestCameraPermissionsAsync` and `getCameraPermissionsAsync` to interact with the permissions.
 *
 * @example
 * ```ts
 * const [status, requestPermission] = useCameraPermissions();
 * ```
 */
export const useCameraPermissions = createPermissionHook( {
  getMethod: getCameraPermissionsAsync,
  requestMethod: requestCameraPermissionsAsync,
} )

export * from './Camera.types'

/**
 * Plays a native positive acknowledgment chime on attendance confirmation.
 */
export function playAttendanceChime(): void {
  try {
    CameraManager.playAttendanceChime?.();
  } catch {
    // Graceful fallback on unsupported platforms
  }
}

/**
 * @hidden
 */
export const Camera = {
  getCameraPermissionsAsync,
  requestCameraPermissionsAsync,
  playAttendanceChime,
}
