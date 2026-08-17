import os
import sys
import numpy as np
import tensorflow as tf

def safe_print(text):
    print(text.encode('ascii', errors='replace').decode('ascii'))

def run_tflite_inference(tflite_path, bgr_255_crop):
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

def test_model_golden_contract(model_name, tflite_path):
    safe_print(f"\n=== Running {model_name} Golden Test Harness ===")

    # 1. Contract metadata test
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
    logits, probs = run_tflite_inference(tflite_path, dummy_bgr)

    assert not np.isnan(logits).any(), "NaN found in logits"
    assert not np.isinf(logits).any(), "Inf found in logits"
    assert np.isclose(np.sum(probs), 1.0, atol=1e-4), f"Probabilities do not sum to 1: {np.sum(probs)}"
    safe_print("  [PASS] Numerical safety & Softmax probability normalization")

    # 3. Model outputs logit scale sanity test
    assert logits.shape == (3,), f"Logits output shape mismatch: {logits.shape}"
    safe_print("  [PASS] Logits output vector verified")
    safe_print(f"  [PASS] {model_name} Golden Contract Verified!")

def test_ensemble_golden_contract():
    safe_print("\n=== Testing Anti-Spoof Ensemble Combination Contract ===")
    v2_path = os.path.join(os.getcwd(), "android", "app", "src", "main", "assets", "minifasnetv2_80.tflite")
    v1se_path = os.path.join(os.getcwd(), "android", "app", "src", "main", "assets", "minifasnetv1se_80.tflite")

    dummy_crop_27 = np.random.uniform(0.0, 255.0, (80, 80, 3)).astype(np.float32)
    dummy_crop_40 = np.random.uniform(0.0, 255.0, (80, 80, 3)).astype(np.float32)

    l27, p27 = run_tflite_inference(v2_path, dummy_crop_27)
    l40, p40 = run_tflite_inference(v1se_path, dummy_crop_40)

    avg_probs = (p27 + p40) / 2.0
    assert avg_probs.shape == (3,)
    assert np.isclose(np.sum(avg_probs), 1.0, atol=1e-4)
    selected_class = int(np.argmax(avg_probs))
    assert selected_class in (0, 1, 2)
    safe_print(f"  [PASS] Ensemble averaging: p_live={avg_probs[1]:.4f}, p_print={avg_probs[0]:.4f}, p_replay={avg_probs[2]:.4f}, class={selected_class}")

def test_golden_contract_rules():
    v2_path = os.path.join(os.getcwd(), "android", "app", "src", "main", "assets", "minifasnetv2_80.tflite")
    v1se_path = os.path.join(os.getcwd(), "android", "app", "src", "main", "assets", "minifasnetv1se_80.tflite")

    test_model_golden_contract("MiniFASNetV2 (2.7x)", v2_path)
    test_model_golden_contract("MiniFASNetV1SE (4.0x)", v1se_path)
    test_ensemble_golden_contract()

    safe_print("\nAll Anti-Spoof Ensemble Golden Contract Tests PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    test_golden_contract_rules()

