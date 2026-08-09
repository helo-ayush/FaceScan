import os
import urllib.request

def safe_print(text):
    print(text.encode('ascii', errors='replace').decode('ascii'))

def inspect_train_test():
    os.makedirs(".tmp/silent_face_src", exist_ok=True)
    test_url = "https://raw.githubusercontent.com/minivision-ai/Silent-Face-Anti-Spoofing/master/test.py"
    train_url = "https://raw.githubusercontent.com/minivision-ai/Silent-Face-Anti-Spoofing/master/src/train_main.py"
    default_url = "https://raw.githubusercontent.com/minivision-ai/Silent-Face-Anti-Spoofing/master/src/default_config.py"

    for name, url in [("test.py", test_url), ("train_main.py", train_url), ("default_config.py", default_url)]:
        dest = f".tmp/silent_face_src/{name}"
        if not os.path.exists(dest):
            try:
                urllib.request.urlretrieve(url, dest)
            except Exception as e:
                safe_print(f"Error fetching {name}: {e}")

    for name in ["test.py", "train_main.py", "default_config.py"]:
        dest = f".tmp/silent_face_src/{name}"
        if os.path.exists(dest):
            safe_print(f"\n=================== {name} ===================")
            with open(dest, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
                for i, line in enumerate(lines):
                    safe_print(f"{i+1:4d}: {line.rstrip()}")

if __name__ == "__main__":
    inspect_train_test()
