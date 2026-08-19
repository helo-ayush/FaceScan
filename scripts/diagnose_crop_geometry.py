#!/usr/bin/env python3
"""
Crop-geometry sensitivity diagnostic for the MiniFASNet anti-spoof ensemble.

Why this exists
---------------
MiniFASNet does not see a face; it sees an 80x80 patch cut at a *specific*
scale around a *specific* bounding-box convention. The 2.7x / 4.0x scales in
the upstream repo are defined against RetinaFace (Widerface) boxes and the
patch is produced with `cv2.resize(..., INTER_LINEAR)`. Change the box
convention, the centring, or the resampling filter and you are feeding the
network off-distribution data -- the score stops meaning "liveness".

This script measures how much each of those factors actually moves the score,
so the Android crop code can be held to whatever tolerance really matters
instead of a guess.

The input contract is [0,255] BGR, NOT [0,1]: upstream deliberately removed the
/255 division in src/data_io/functional.py ("# return img.float().div(255)
modify by zkx"). The ToTensor docstring still claims [0,1] and is stale.

Usage:
  python scripts/diagnose_crop_geometry.py
  python scripts/diagnose_crop_geometry.py --sfas-dir .tmp/sfas
"""

import argparse
import math
import os
import sys

import numpy as np

# ---------------------------------------------------------------- model access


def load_models(sfas_dir):
    """Loads both MiniFASNet variants from the upstream .pth weights."""
    import torch

    sys.path.insert(0, sfas_dir)
    from src.model_lib.MiniFASNet import MiniFASNetV2, MiniFASNetV1SE
    from src.utility import get_kernel

    specs = [
        ("V2@2.7", MiniFASNetV2, "2.7_80x80_MiniFASNetV2.pth", 2.7),
        ("V1SE@4.0", MiniFASNetV1SE, "4_0_0_80x80_MiniFASNetV1SE.pth", 4.0),
    ]
    models = []
    for tag, cls, fname, scale in specs:
        path = os.path.join(sfas_dir, "resources", "anti_spoof_models", fname)
        model = cls(conv6_kernel=get_kernel(80, 80))
        state = torch.load(path, map_location="cpu", weights_only=True)
        if any(k.startswith("module.") for k in state):
            state = {k[7:]: v for k, v in state.items()}
        missing, unexpected = model.load_state_dict(state, strict=True)[:2]
        assert not missing and not unexpected, f"{tag}: state_dict mismatch"
        model.eval()
        models.append((tag, model, scale))
    return models


def infer(models, patches):
    """patches: dict tag -> HxWx3 BGR float [0,255]. Returns ensemble probs."""
    import torch
    import torch.nn.functional as F

    total = np.zeros(3, dtype=np.float64)
    per_model = {}
    for tag, model, _ in models:
        arr = patches[tag].astype(np.float32)
        tensor = torch.from_numpy(arr.transpose(2, 0, 1)[None])
        with torch.no_grad():
            probs = F.softmax(model(tensor), dim=1).numpy()[0]
        per_model[tag] = probs
        total += probs
    return total / len(models), per_model


# ------------------------------------------------------------------- geometry


def get_new_box(src_w, src_h, bbox, scale):
    """Verbatim port of upstream CropImage._get_new_box (generate_patches.py)."""
    x, y, box_w, box_h = bbox
    scale = min((src_h - 1) / box_h, min((src_w - 1) / box_w, scale))
    new_w, new_h = box_w * scale, box_h * scale
    cx, cy = box_w / 2 + x, box_h / 2 + y
    lt_x, lt_y = cx - new_w / 2, cy - new_h / 2
    rb_x, rb_y = cx + new_w / 2, cy + new_h / 2
    if lt_x < 0:
        rb_x -= lt_x
        lt_x = 0
    if lt_y < 0:
        rb_y -= lt_y
        lt_y = 0
    if rb_x > src_w - 1:
        lt_x -= rb_x - src_w + 1
        rb_x = src_w - 1
    if rb_y > src_h - 1:
        lt_y -= rb_y - src_h + 1
        rb_y = src_h - 1
    return int(lt_x), int(lt_y), int(rb_x), int(rb_y)


def crop_patch(img, bbox, scale, interp, out=80):
    """Upstream crop, with the resampling filter left configurable."""
    import cv2

    h, w = img.shape[:2]
    x1, y1, x2, y2 = get_new_box(w, h, bbox, scale)
    region = img[y1 : y2 + 1, x1 : x2 + 1]
    if region.size == 0:
        return None
    return cv2.resize(region, (out, out), interpolation=interp)


def retinaface_bbox(sfas_dir, img):
    """Reference detector: the convention the 2.7/4.0 scales were defined against."""
    import cv2

    proto = os.path.join(sfas_dir, "resources", "detection_model", "deploy.prototxt")
    weights = os.path.join(
        sfas_dir, "resources", "detection_model", "Widerface-RetinaFace.caffemodel"
    )
    net = cv2.dnn.readNetFromCaffe(proto, weights)
    h, w = img.shape[0], img.shape[1]
    aspect = w / h
    small = img
    if w * h >= 192 * 192:
        small = cv2.resize(
            img,
            (int(192 * math.sqrt(aspect)), int(192 / math.sqrt(aspect))),
            interpolation=cv2.INTER_LINEAR,
        )
    blob = cv2.dnn.blobFromImage(small, 1, mean=(104, 117, 123))
    net.setInput(blob, "data")
    out = net.forward("detection_out").squeeze()
    best = np.argmax(out[:, 2])
    left, top, right, bottom = (
        out[best, 3] * w,
        out[best, 4] * h,
        out[best, 5] * w,
        out[best, 6] * h,
    )
    return [int(left), int(top), int(right - left + 1), int(bottom - top + 1)]


# ------------------------------------------------------------------ experiments


def build(models, img, bbox, interp, scale_mult=1.0, off=(0.0, 0.0)):
    """Crops every model's patch, optionally perturbing scale and centre."""
    x, y, bw, bh = bbox
    shifted = [x + off[0] * bw, y + off[1] * bh, bw, bh]
    return {
        tag: crop_patch(img, shifted, scale * scale_mult, interp)
        for tag, _, scale in models
    }


def main():
    import cv2

    ap = argparse.ArgumentParser()
    ap.add_argument("--sfas-dir", default=os.path.join(".tmp", "sfas"))
    args = ap.parse_args()
    sfas = os.path.abspath(args.sfas_dir)

    models = load_models(sfas)
    samples = [
        ("image_T1.jpg", "LIVE"),
        ("image_F1.jpg", "SPOOF"),
        ("image_F2.jpg", "SPOOF"),
    ]
    loaded = []
    for name, truth in samples:
        img = cv2.imread(os.path.join(sfas, "images", "sample", name))
        bbox = retinaface_bbox(sfas, img)
        loaded.append((name, truth, img, bbox))
        print(f"{name:16s} truth={truth:5s} {img.shape[1]}x{img.shape[0]} bbox={bbox}")

    print("\n" + "=" * 78)
    print("BASELINE  (reference box, reference scales, INTER_LINEAR)")
    print("=" * 78)
    print(f"{'image':16s} {'truth':6s} {'p_live':>8s} {'verdict':>8s}")
    for name, truth, img, bbox in loaded:
        probs, _ = infer(models, build(models, img, bbox, cv2.INTER_LINEAR))
        verdict = "LIVE" if int(np.argmax(probs)) == 1 else "SPOOF"
        print(f"{name:16s} {truth:6s} {probs[1]:8.4f} {verdict:>8s}")

    print("\n" + "=" * 78)
    print("A. RESAMPLING FILTER   (app uses nearest-neighbour)")
    print("=" * 78)
    filters = [
        ("INTER_LINEAR (ref)", cv2.INTER_LINEAR),
        ("INTER_AREA", cv2.INTER_AREA),
        ("INTER_NEAREST (app)", cv2.INTER_NEAREST),
    ]
    print(f"{'filter':22s} " + " ".join(f"{n[:11]:>12s}" for n, _, _, _ in loaded))
    for label, interp in filters:
        row = []
        for name, truth, img, bbox in loaded:
            probs, _ = infer(models, build(models, img, bbox, interp))
            row.append(f"{probs[1]:12.4f}")
        print(f"{label:22s} " + " ".join(row))

    print("\n" + "=" * 78)
    print("B. CROP SCALE          (multiplier on the 2.7x / 4.0x reference scales)")
    print("=" * 78)
    print(f"{'scale x':22s} " + " ".join(f"{n[:11]:>12s}" for n, _, _, _ in loaded))
    for mult in [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 2.0]:
        row = []
        for name, truth, img, bbox in loaded:
            probs, _ = infer(
                models, build(models, img, bbox, cv2.INTER_LINEAR, scale_mult=mult)
            )
            row.append(f"{probs[1]:12.4f}")
        star = "  <-- reference" if mult == 1.0 else ""
        print(f"{mult:<22.2f} " + " ".join(row) + star)

    print("\n" + "=" * 78)
    print("C. CENTRE OFFSET       (fraction of box width/height)")
    print("=" * 78)
    print(f"{'offset (dx,dy)':22s} " + " ".join(f"{n[:11]:>12s}" for n, _, _, _ in loaded))
    for off in [(0, 0), (0.1, 0), (0.2, 0), (0, 0.1), (0, 0.2), (0.15, 0.15), (0.3, 0.3)]:
        row = []
        for name, truth, img, bbox in loaded:
            probs, _ = infer(models, build(models, img, bbox, cv2.INTER_LINEAR, off=off))
            row.append(f"{probs[1]:12.4f}")
        star = "  <-- reference" if off == (0, 0) else ""
        print(f"{str(off):22s} " + " ".join(row) + star)

    print("\n" + "=" * 78)
    print("D. BOX TIGHTNESS       (simulates a detector with a different convention)")
    print("=" * 78)
    print("   ML Kit boxes are looser and taller than RetinaFace's. Growing the box")
    print("   by k while keeping the reference scale multiplies the captured area.")
    print(f"{'box grow k':22s} " + " ".join(f"{n[:11]:>12s}" for n, _, _, _ in loaded))
    for k in [0.8, 0.9, 1.0, 1.1, 1.2, 1.35, 1.5]:
        row = []
        for name, truth, img, bbox in loaded:
            x, y, bw, bh = bbox
            cx, cy = x + bw / 2, y + bh / 2
            grown = [cx - bw * k / 2, cy - bh * k / 2, bw * k, bh * k]
            probs, _ = infer(models, build(models, img, grown, cv2.INTER_LINEAR))
            row.append(f"{probs[1]:12.4f}")
        star = "  <-- reference" if k == 1.0 else ""
        print(f"{k:<22.2f} " + " ".join(row) + star)

    print("\n" + "=" * 78)
    print("E. MODEL/SCALE PAIRING (feeding each model the other model's crop)")
    print("=" * 78)
    for name, truth, img, bbox in loaded:
        correct = build(models, img, bbox, cv2.INTER_LINEAR)
        swapped = {
            "V2@2.7": crop_patch(img, bbox, 4.0, cv2.INTER_LINEAR),
            "V1SE@4.0": crop_patch(img, bbox, 2.7, cv2.INTER_LINEAR),
        }
        p_ok, _ = infer(models, correct)
        p_sw, _ = infer(models, swapped)
        print(
            f"{name:16s} truth={truth:5s} correct p_live={p_ok[1]:.4f}   "
            f"swapped p_live={p_sw[1]:.4f}"
        )


if __name__ == "__main__":
    main()
