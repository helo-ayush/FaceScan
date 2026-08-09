import os
import sys
import numpy as np

def inspect_tflite_model(model_path):
    print(f"=== Inspecting TFLite Model: {model_path} ===")
    if not os.path.exists(model_path):
        print(f"ERROR: Model file not found at {model_path}")
        return

    # Try tflite_runtime first, then tensorflow
    interpreter = None
    try:
        import tflite_runtime.interpreter as tflite
        interpreter = tflite.Interpreter(model_path=model_path)
    except ImportError:
        try:
            import tensorflow as tf
            interpreter = tf.lite.Interpreter(model_path=model_path)
        except ImportError:
            print("Neither tflite_runtime nor tensorflow is installed. Falling back to raw flatbuffer parsing if available.")

    if interpreter is not None:
        interpreter.allocate_tensors()
        input_details = interpreter.get_input_details()
        output_details = interpreter.get_output_details()

        print("\nInput Tensor Details:")
        for idx, item in enumerate(input_details):
            print(f"  [{idx}] Name: {item['name']}")
            print(f"      Shape: {item['shape'].tolist()}")
            print(f"      Type: {item['dtype']}")
            print(f"      Quantization (scale, zero_point): {item.get('quantization', (0.0, 0))}")
            if 'shape_signature' in item:
                print(f"      Shape Signature: {item['shape_signature'].tolist()}")

        print("\nOutput Tensor Details:")
        for idx, item in enumerate(output_details):
            print(f"  [{idx}] Name: {item['name']}")
            print(f"      Shape: {item['shape'].tolist()}")
            print(f"      Type: {item['dtype']}")
            print(f"      Quantization (scale, zero_point): {item.get('quantization', (0.0, 0))}")
            if 'shape_signature' in item:
                print(f"      Shape Signature: {item['shape_signature'].tolist()}")
    else:
        # Fallback reading file size
        file_size = os.path.getsize(model_path)
        print(f"File Size: {file_size} bytes")

def inspect_onnx_model(onnx_path):
    print(f"\n=== Inspecting ONNX Model: {onnx_path} ===")
    if not os.path.exists(onnx_path):
        print(f"ONNX file not found at {onnx_path}")
        return
    try:
        import onnx
        model = onnx.load(onnx_path)
        print("ONNX IR Version:", model.ir_version)
        print("Producer Name:", model.producer_name)
        print("\nInputs:")
        for inp in model.graph.input:
            shape = [d.dim_value for d in inp.type.tensor_type.shape.dim]
            print(f"  Name: {inp.name}, Shape: {shape}, Type: {inp.type.tensor_type.elem_type}")
        print("\nOutputs:")
        for out in model.graph.output:
            shape = [d.dim_value for d in out.type.tensor_type.shape.dim]
            print(f"  Name: {out.name}, Shape: {shape}, Type: {out.type.tensor_type.elem_type}")
    except ImportError:
        print("onnx module not installed.")

if __name__ == "__main__":
    tflite_path = os.path.join(os.getcwd(), "android", "app", "src", "main", "assets", "minifasnetv2_80.tflite")
    inspect_tflite_model(tflite_path)

    onnx_path = os.path.join(os.getcwd(), ".tmp", "fas", "minifasnetv2_80.onnx")
    inspect_onnx_model(onnx_path)
