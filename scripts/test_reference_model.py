import os
import sys
import urllib.request

def safe_print(text):
    safe_text = text.encode('ascii', errors='replace').decode('ascii')
    print(safe_text)

def inspect_silent_face_code():
    os.makedirs(".tmp/silent_face_src", exist_ok=True)
    predict_url = "https://raw.githubusercontent.com/minivision-ai/Silent-Face-Anti-Spoofing/master/src/anti_spoof_predict.py"
    dataset_url = "https://raw.githubusercontent.com/minivision-ai/Silent-Face-Anti-Spoofing/master/src/data_io/dataset_folder.py"
    generate_url = "https://raw.githubusercontent.com/minivision-ai/Silent-Face-Anti-Spoofing/master/src/generate_patches.py"

    for name, url in [("anti_spoof_predict.py", predict_url), ("dataset_folder.py", dataset_url), ("generate_patches.py", generate_url)]:
        dest = f".tmp/silent_face_src/{name}"
        if not os.path.exists(dest):
            try:
                urllib.request.urlretrieve(url, dest)
            except Exception as e:
                safe_print(f"Error fetching {name}: {e}")

    for name in ["anti_spoof_predict.py", "dataset_folder.py", "generate_patches.py"]:
        dest = f".tmp/silent_face_src/{name}"
        if os.path.exists(dest):
            safe_print(f"\n=================== {name} ===================")
            with open(dest, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
                for i, line in enumerate(lines):
                    safe_print(f"{i+1:4d}: {line.rstrip()}")

if __name__ == "__main__":
    inspect_silent_face_code()
