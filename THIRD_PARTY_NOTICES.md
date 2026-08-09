# Third-party model notices

## MiniFASNetV2 face anti-spoofing model

The file `android/app/src/main/assets/minifasnetv2_80.tflite` is a TensorFlow Lite conversion of MiniVision's `2.7_80x80_MiniFASNetV2.pth` model from Silent-Face-Anti-Spoofing.

- Source: https://github.com/minivision-ai/Silent-Face-Anti-Spoofing
- Copyright: 2020 Minivision
- License: Apache License 2.0
- Modification: converted from PyTorch to ONNX and then TensorFlow Lite float32 for on-device Android inference. Model outputs were validated against PyTorch with maximum absolute error below 0.000003.

The full license is included at `licenses/MiniVision-Silent-Face-Anti-Spoofing-APACHE-2.0.txt`.