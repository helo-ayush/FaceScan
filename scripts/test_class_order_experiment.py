import os
import sys
import numpy as np
import tensorflow as tf

def safe_print(text):
    print(text.encode('ascii', errors='replace').decode('ascii'))

def run_tflite_model(bgr_01_image):
    tflite_path = os.path.join(os.getcwd(), "android", "app", "src", "main", "assets", "minifasnetv2_80.tflite")
    interpreter = tf.lite.Interpreter(model_path=tflite_path)
    interpreter.allocate_tensors()
    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()

    # Input shape is [1, 80, 80, 3]
    input_data = np.expand_dims(bgr_01_image, axis=0).astype(np.float32)
    interpreter.set_tensor(input_details[0]['index'], input_data)
    interpreter.invoke()
    logits = interpreter.get_tensor(output_details[0]['index'])[0]

    # Softmax
    e = np.exp(logits - np.max(logits))
    probs = e / np.sum(e)
    return logits, probs

def create_synthetic_live_face():
    # 80x80 BGR image simulating natural face colors (skin tones, eyes, mouth)
    img = np.zeros((80, 80, 3), dtype=np.uint8)
    # Background
    img[:, :] = [180, 180, 180]
    # Oval Face (Skin tone in BGR: B~140, G~160, R~220)
    for y in range(80):
        for x in range(80):
            if ((x - 40)**2 / 22**2) + ((y - 40)**2 / 30**2) <= 1.0:
                img[y, x] = [140, 160, 220]
    # Eyes (dark blue/black in BGR: B~40, G~40, R~40)
    img[32:37, 28:34] = [30, 30, 30]
    img[32:37, 46:52] = [30, 30, 30]
    # Mouth
    img[55:58, 33:47] = [50, 60, 160]
    return img

def create_synthetic_print_attack():
    # Paper photo print: bright paper white border, flat low-contrast image with paper grain
    img = np.ones((80, 80, 3), dtype=np.uint8) * 240
    # Center photo
    img[10:70, 10:70] = [130, 150, 200]
    # Paper noise/texture
    noise = np.random.randint(-20, 20, (80, 80, 3), dtype=np.int16)
    img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    return img

def create_synthetic_replay_attack():
    # Screen display: moire high-frequency grid lines (RGB subpixel striping)
    img = np.zeros((80, 80, 3), dtype=np.uint8)
    for y in range(80):
        for x in range(80):
            if (x + y) % 2 == 0:
                img[y, x] = [255, 0, 0] # BGR Blue stripe
            else:
                img[y, x] = [0, 0, 255] # BGR Red stripe
    return img

def test_samples():
    safe_print("=== Testing MiniFASNetV2 TFLite Class Outputs on Synthetic Test Patterns ===")
    samples = {
        "Synthetic Live Face": create_synthetic_live_face(),
        "Synthetic Print Attack": create_synthetic_print_attack(),
        "Synthetic Screen Replay": create_synthetic_replay_attack(),
        "All Zero Image": np.zeros((80, 80, 3), dtype=np.uint8),
        "All White Image": np.ones((80, 80, 3), dtype=np.uint8) * 255,
    }

    for name, img_bgr in samples.items():
        # Preprocessing BGR [0,1]
        bgr_01 = img_bgr.astype(np.float32) / 255.0
        logits, probs = run_tflite_model(bgr_01)
        safe_print(f"\nSample: {name}")
        safe_print(f"  Raw Logits [c0, c1, c2]: [{logits[0]:.4f}, {logits[1]:.4f}, {logits[2]:.4f}]")
        safe_print(f"  Softmax Probs [p0, p1, p2]: [{probs[0]:.4f}, {probs[1]:.4f}, {probs[2]:.4f}]")
        safe_print(f"  Argmax Class Index: {np.argmax(probs)}")

if __name__ == "__main__":
    test_samples()
