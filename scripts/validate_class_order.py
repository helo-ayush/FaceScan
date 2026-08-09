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

def test_onnx_vs_tflite():
    tflite_path = os.path.join(os.getcwd(), "android", "app", "src", "main", "assets", "minifasnetv2_80.tflite")
    onnx_path = os.path.join(os.getcwd(), ".tmp", "fas", "minifasnetv2_80.onnx")

    print("=== Testing ONNX vs TFLite Equivalence across Preprocessing Variants ===")
    np.random.seed(42)
    dummy_pixels = np.random.randint(0, 256, (1, 80, 80, 3), dtype=np.uint8)

    # Variant A: RGB [0,1]
    rgb_01 = dummy_pixels.astype(np.float32) / 255.0
    # Variant B: BGR [0,1]
    bgr_01 = dummy_pixels[..., ::-1].astype(np.float32) / 255.0
    # Variant C: RGB [-1,1]
    rgb_m11 = (dummy_pixels.astype(np.float32) - 127.5) / 127.5
    # Variant D: BGR [-1,1]
    bgr_m11 = ((dummy_pixels[..., ::-1].astype(np.float32)) - 127.5) / 127.5

    variants = {
        "Variant A (RGB [0,1])": rgb_01,
        "Variant B (BGR [0,1])": bgr_01,
        "Variant C (RGB [-1,1])": rgb_m11,
        "Variant D (BGR [-1,1])": bgr_m11,
    }

    for name, nhwc_data in variants.items():
        print(f"\nTesting {name}:")
        tflite_res = run_tflite(tflite_path, nhwc_data)
        print("  TFLite Output Logits:", tflite_res[0].tolist())

        # For ONNX, convert NHWC to NCHW
        nchw_data = np.transpose(nhwc_data, (0, 3, 1, 2))
        onnx_res = run_onnx(onnx_path, nchw_data)
        if onnx_res is not None:
            print("  ONNX Output Logits:  ", onnx_res[0].tolist())
            diff = np.max(np.abs(tflite_res - onnx_res))
            print(f"  Max Absolute Difference (TFLite vs ONNX): {diff:.8f}")

if __name__ == "__main__":
    test_onnx_vs_tflite()
