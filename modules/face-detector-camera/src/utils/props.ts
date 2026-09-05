import {
  CameraNativeProps,
  CameraProps
} from '../Camera.types'

export function convertNativeProps( props?: CameraProps ): CameraNativeProps {
  if ( !props || typeof props !== 'object' ) {
    return {}
  }

  const nativeProps: CameraNativeProps = {}
  for ( const [ key, value ] of Object.entries( props ) ) {
    ( nativeProps as Record<string, any> )[ key ] = value
  }

  return nativeProps
}

export function ensureNativeProps( props?: CameraProps ): CameraNativeProps {
  return convertNativeProps( props )
}
