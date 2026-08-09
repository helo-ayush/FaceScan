import os
import sys
import numpy as np
import tensorflow as tf

def safe_print(text):
    print(text.encode('ascii', errors='replace').decode('ascii'))

def run_tflite_inference(bgr_255_crop):
    tflite_path = os.path.join(os.getcwd(), "android", "app", "src", "main", "assets", "minifasnetv2_80.tflite")
    if not os.path.exists(tflite_path):
        raise FileNotFoundError(f"TFLite asset missing: {tflite_path}")

    interpreter = tf.lite.Interpreter(model_path=tflite_path)
    interpreter.allocate_tensors()
    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()

    # Android's AntiSpoofStage passes OpenCV-order BGR floats on the original
    # byte scale (0..255). Keeping this harness on the exact same contract is
    # essential: a 0..1 test can pass while the shipped app is misprocessed.
    input_data = np.expand_dims(bgr_255_crop, axis=0).astype(np.float32)
    interpreter.set_tensor(input_details[0]['index'], input_data)
    interpreter.invoke()
    logits = interpreter.get_tensor(output_details[0]['index'])[0]

    max_val = np.max(logits)
    exp_logits = np.exp(logits - max_val)
    probs = exp_logits / np.sum(exp_logits)
    return logits, probs

def test_golden_contract_rules():
    safe_print("=== Running MiniFASNetV2 Golden Test Harness ===")

    # 1. Contract metadata test
    tflite_path = os.path.join(os.getcwd(), "android", "app", "src", "main", "assets", "minifasnetv2_80.tflite")
    interpreter = tf.lite.Interpreter(model_path=tflite_path)
    interpreter.allocate_tensors()

    in_shape = interpreter.get_input_details()[0]['shape'].tolist()
    in_dtype = str(interpreter.get_input_details()[0]['dtype'])
    out_shape = interpreter.get_output_details()[0]['shape'].tolist()

    assert in_shape == [1, 80, 80, 3], f"Input shape mismatch: {in_shape}"
    assert "float32" in in_dtype.lower(), f"Input dtype mismatch: {in_dtype}"
    assert out_shape == [1, 3], f"Output shape mismatch: {out_shape}"
    safe_print("  [PASS] Tensor contract metadata (1x80x80x3 float32 -> 1x3 float32)")

    # 2. Numerical safety & range test
    dummy_bgr = np.random.uniform(0.0, 255.0, (80, 80, 3)).astype(np.float32)
    logits, probs = run_tflite_inference(dummy_bgr)

    assert not np.isnan(logits).any(), "NaN found in logits"
    assert not np.isinf(logits).any(), "Inf found in logits"
    assert np.isclose(np.sum(probs), 1.0, atol=1e-4), f"Probabilities do not sum to 1: {np.sum(probs)}"
    safe_print("  [PASS] Numerical safety & Softmax probability normalization")

    # 3. Model outputs logit scale sanity test
    assert logits.shape == (3,), f"Logits output shape mismatch: {logits.shape}"
    safe_print("  [PASS] Logits output vector verified")

    safe_print("\nAll MiniFASNetV2 Golden Contract Tests PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    test_golden_contract_rules()
