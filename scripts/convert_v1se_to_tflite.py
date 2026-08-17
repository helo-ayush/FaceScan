import os
import sys
import numpy as np

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

def convert_pth_to_onnx(pth_path, onnx_path):
    import torch
    from collections import OrderedDict
    
    # Add .tmp/silent_face_src to path
    sys.path.insert(0, os.path.join(os.getcwd(), ".tmp", "silent_face_src"))
    from model_lib.MiniFASNet import MiniFASNetV1SE
    
    print(f"Loading PyTorch weights from: {pth_path}")
    model = MiniFASNetV1SE(conv6_kernel=(5, 5))
    
    state_dict = torch.load(pth_path, map_location='cpu', weights_only=True)
    if any(k.startswith('module.') for k in state_dict.keys()):
        new_state_dict = OrderedDict()
        for k, v in state_dict.items():
            name = k[7:] if k.startswith('module.') else k
            new_state_dict[name] = v
        model.load_state_dict(new_state_dict)
    else:
        model.load_state_dict(state_dict)
        
    model.eval()
    
    dummy_input = torch.randn(1, 3, 80, 80, dtype=torch.float32)
    with torch.no_grad():
        torch_out = model(dummy_input)
    print(f"PyTorch dummy inference succeeded. Output logits shape: {torch_out.shape}")
    
    print(f"Exporting to ONNX: {onnx_path}")
    torch.onnx.export(
        model,
        dummy_input,
        onnx_path,
        input_names=['input'],
        output_names=['logits'],
        opset_version=11,
        do_constant_folding=True,
        dynamo=False
    )
    print("ONNX export complete.")
    return model

def convert_onnx_to_tflite(onnx_path, tflite_path):
    print(f"Converting ONNX to TFLite...")
    import subprocess
    
    saved_model_dir = os.path.join(os.getcwd(), ".tmp", "fas", "saved_model_v1se")
    
    # Run onnx2tf
    cmd = [
        sys.executable, "-m", "onnx2tf",
        "-i", onnx_path,
        "-o", saved_model_dir,
        "-nuo"
    ]
    print("Running:", " ".join(cmd))
    res = subprocess.run(cmd, capture_output=True, text=True)
    print("onnx2tf stdout:\n", res.stdout[-1500:] if len(res.stdout) > 1500 else res.stdout)
    if res.returncode != 0:
        print("onnx2tf stderr:\n", res.stderr)
        raise RuntimeError("onnx2tf failed.")
        
    # Find generated float32 tflite model from onnx2tf
    generated_tflite = os.path.join(saved_model_dir, "minifasnetv1se_80_float32.tflite")
    if not os.path.exists(generated_tflite):
        import glob
        matches = glob.glob(os.path.join(saved_model_dir, "*float32.tflite"))
        if matches:
            generated_tflite = matches[0]
        else:
            matches_all = glob.glob(os.path.join(saved_model_dir, "*.tflite"))
            if matches_all:
                generated_tflite = matches_all[0]
            
    if os.path.exists(generated_tflite):
        import shutil
        os.makedirs(os.path.dirname(tflite_path), exist_ok=True)
        shutil.copyfile(generated_tflite, tflite_path)
        print(f"Successfully copied TFLite to: {tflite_path}")
    else:
        # Fallback to tf.lite.TFLiteConverter from saved_model
        import tensorflow as tf
        converter = tf.lite.TFLiteConverter.from_saved_model(saved_model_dir)
        tflite_model = converter.convert()
        os.makedirs(os.path.dirname(tflite_path), exist_ok=True)
        with open(tflite_path, "wb") as f:
            f.write(tflite_model)
        print(f"Successfully converted and saved TFLite to: {tflite_path}")

def validate_conversion(torch_model, tflite_path):
    import torch
    import tensorflow as tf
    
    print("\n=== Validating PyTorch vs TFLite Equivalence for MiniFASNetV1SE ===")
    np.random.seed(42)
    dummy_nhwc = np.random.uniform(0, 255.0, (1, 80, 80, 3)).astype(np.float32)
    dummy_nchw = np.transpose(dummy_nhwc, (0, 3, 1, 2))
    
    # PyTorch inference
    with torch.no_grad():
        torch_logits = torch_model(torch.from_numpy(dummy_nchw)).numpy()[0]
    
    # TFLite inference
    interpreter = tf.lite.Interpreter(model_path=tflite_path)
    interpreter.allocate_tensors()
    in_idx = interpreter.get_input_details()[0]['index']
    out_idx = interpreter.get_output_details()[0]['index']
    
    interpreter.set_tensor(in_idx, dummy_nhwc)
    interpreter.invoke()
    tflite_logits = interpreter.get_tensor(out_idx)[0]
    
    print(f"PyTorch Logits: {torch_logits.tolist()}")
    print(f"TFLite  Logits: {tflite_logits.tolist()}")
    
    diff = np.max(np.abs(torch_logits - tflite_logits))
    print(f"Max Absolute Error: {diff:.8f}")
    assert diff < 1e-3, f"Error too high: {diff}"
    print("VALIDATION PASSED: PyTorch and TFLite outputs match within tolerance!")

if __name__ == "__main__":
    pth = os.path.join(os.getcwd(), ".tmp", "fas", "4_0_0_80x80_MiniFASNetV1SE.pth")
    onnx_file = os.path.join(os.getcwd(), ".tmp", "fas", "minifasnetv1se_80.onnx")
    tflite_dest = os.path.join(os.getcwd(), "android", "app", "src", "main", "assets", "minifasnetv1se_80.tflite")
    
    torch_model = convert_pth_to_onnx(pth, onnx_file)
    convert_onnx_to_tflite(onnx_file, tflite_dest)
    validate_conversion(torch_model, tflite_dest)
