# Third-party model notices

## MiniFASNet face anti-spoofing models

Two TensorFlow Lite conversions of MiniVision's Silent-Face-Anti-Spoofing models ship in
`android/app/src/main/assets/`; the app runs both as an ensemble at different crop scales.

| asset | upstream checkpoint | crop scale |
|---|---|---|
| `minifasnetv2_80.tflite` | `2.7_80x80_MiniFASNetV2.pth` | 2.7× |
| `minifasnetv1se_80.tflite` | `4_0_0_80x80_MiniFASNetV1SE.pth` | 4.0× |

- Source: https://github.com/minivision-ai/Silent-Face-Anti-Spoofing
- Copyright: 2020 Minivision
- License: Apache License 2.0
- Modification: converted from PyTorch to ONNX and then TensorFlow Lite float32 for
  on-device Android inference. No weights, architecture or preprocessing were changed.

**Validation.** Outputs were compared against the upstream PyTorch models on the
upstream sample images; maximum absolute error on the output probabilities was below
3e-6. This holds **only at the input scale the models actually expect: BGR values in
`[0, 255]`, not `[0, 1]`.** The scale is worth stating explicitly because upstream's own
`ToTensor` docstring advertises `[0.0, 1.0]` while `src/data_io/functional.py:57-60`
deliberately removed the division — so the docstring is stale and the `[0,1]` path
produces near-constant output that looks exactly like a broken export. Re-measuring this
error at the wrong scale would produce a number that says nothing about the conversion.

The full license is included at `licenses/MiniVision-Silent-Face-Anti-Spoofing-APACHE-2.0.txt`.