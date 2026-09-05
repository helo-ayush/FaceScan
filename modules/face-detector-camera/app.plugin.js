const {
  createRunOncePlugin,
  withAndroidManifest,
  withInfoPlist,
} = require('@expo/config-plugins');

const CAMERA_USAGE = 'Allow $(PRODUCT_NAME) to access the camera';

const withCamera = (config, { cameraPermission } = {}) => {
  config = withInfoPlist(config, (config) => {
    config.modResults.NSCameraUsageDescription =
      cameraPermission || config.modResults.NSCameraUsageDescription || CAMERA_USAGE;
    return config;
  });

  config = withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults;
    if (!androidManifest.manifest['uses-permission']) {
      androidManifest.manifest['uses-permission'] = [];
    }
    const permissions = androidManifest.manifest['uses-permission'];
    const cameraPermissionName = 'android.permission.CAMERA';
    if (!permissions.some((perm) => perm.$?.['android:name'] === cameraPermissionName)) {
      permissions.push({
        $: {
          'android:name': cameraPermissionName,
        },
      });
    }
    return config;
  });

  return config;
};

const pkg = require('./package.json');

module.exports = createRunOncePlugin(withCamera, pkg.name, pkg.version);
