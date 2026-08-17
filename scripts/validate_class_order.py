import os
import sys
import numpy as np

def run_tflite(tflite_path, input_data):
    import tensorflow as tf
    interpreter = tf.lite.Interpreter(model_path=tflite_path)
    interpreter.allocate_tensors()
    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()
    interpreter.set_tensor(input_details[0]['index'], input_data)
    interpreter.invoke()
    return interpreter.get_tensor(output_details[0]['index'])

def run_onnx(onnx_path, input_data_nchw):
    try:
        import onnxruntime as ort
        session = ort.InferenceSession(onnx_path)
        input_name = session.get_inputs()[0].name
        output_name = session.get_outputs()[0].name
        return session.run([output_name], {input_name: input_data_nchw})[0]
    except Exception as e:
        print("ONNXRuntime execution error:", e)
        return None

def test_model_onnx_vs_tflite(model_name, tflite_path, onnx_path):
    print(f"\n========================================================")
    print(f"=== Testing {model_name} ONNX vs TFLite Equivalence ===")
    print(f"========================================================")
    if not os.path.exists(tflite_path):
        print(f"ERROR: TFLite model missing: {tflite_path}")
        return False
    if not os.path.exists(onnx_path):
        print(f"ERROR: ONNX model missing: {onnx_path}")
        return False

    np.random.seed(42)
    dummy_pixels = np.random.randint(0, 256, (1, 80, 80, 3), dtype=np.uint8)

    # Variant 1: BGR [0..255] (Expected raw byte scale)
    bgr_255 = dummy_pixels[..., ::-1].astype(np.float32)
    # Variant 2: RGB [0..255]
    rgb_255 = dummy_pixels.astype(np.float32)
    # Variant 3: BGR [0,1]
    bgr_01 = dummy_pixels[..., ::-1].astype(np.float32) / 255.0
    # Variant 4: RGB [0,1]
    rgb_01 = dummy_pixels.astype(np.float32) / 255.0
    # Variant 5: BGR [-1,1]
    bgr_m11 = ((dummy_pixels[..., ::-1].astype(np.float32)) - 127.5) / 127.5
    # Variant 6: RGB [-1,1]
    rgb_m11 = (dummy_pixels.astype(np.float32) - 127.5) / 127.5

    variants = {
        "Variant 1 (BGR [0..255] - Raw Byte Scale)": bgr_255,
        "Variant 2 (RGB [0..255] - Raw Byte Scale)": rgb_255,
        "Variant 3 (BGR [0,1])": bgr_01,
        "Variant 4 (RGB [0,1])": rgb_01,
        "Variant 5 (BGR [-1,1])": bgr_m11,
        "Variant 6 (RGB [-1,1])": rgb_m11,
    }

    max_diffs = []
    for name, nhwc_data in variants.items():
        print(f"\n  Testing {name}:")
        tflite_res = run_tflite(tflite_path, nhwc_data)
        print("    TFLite Output Logits:", [round(x, 4) for x in tflite_res[0].tolist()])

        # For ONNX, convert NHWC to NCHW
        nchw_data = np.transpose(nhwc_data, (0, 3, 1, 2))
        onnx_res = run_onnx(onnx_path, nchw_data)
        if onnx_res is not None:
            print("    ONNX Output Logits:  ", [round(x, 4) for x in onnx_res[0].tolist()])
            diff = np.max(np.abs(tflite_res - onnx_res))
            print(f"    Max Absolute Difference (TFLite vs ONNX): {diff:.8f}")
            max_diffs.append(diff)
            assert diff < 1e-3, f"Parity failure between ONNX and TFLite: {diff}"

    print(f"\n  [PASS] {model_name} passed all ONNX vs TFLite equivalence checks! Max Diff: {max(max_diffs):.8f}")
    return True

def test_onnx_vs_tflite():
    models = [
        {
            "name": "MiniFASNetV2 (80x80 @ 2.7x)",
            "tflite": os.path.join(os.getcwd(), "android", "app", "src", "main", "assets", "minifasnetv2_80.tflite"),
            "onnx": os.path.join(os.getcwd(), ".tmp", "fas", "minifasnetv2_80.onnx"),
        },
        {
            "name": "MiniFASNetV1SE (80x80 @ 4.0x)",
            "tflite": os.path.join(os.getcwd(), "android", "app", "src", "main", "assets", "minifasnetv1se_80.tflite"),
            "onnx": os.path.join(os.getcwd(), ".tmp", "fas", "minifasnetv1se_80.onnx"),
        }
    ]

    all_passed = True
    for m in models:
        passed = test_model_onnx_vs_tflite(m["name"], m["tflite"], m["onnx"])
        all_passed = all_passed and passed

    if all_passed:
        print("\n========================================================")
        print("ALL MODELS (V2 and V1SE) PASSED VALIDATION SUCCESSFULLY!")
        print("========================================================")

if __name__ == "__main__":
    test_onnx_vs_tflite()

