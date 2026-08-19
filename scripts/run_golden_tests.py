#!/usr/bin/env python3
"""
Golden tests for the shipped Android anti-spoof assets.

Contract under test
-------------------
`AntiSpoofStage.process()` (FacePipeline.kt) feeds the TFLite interpreter
BGR float32 on the **original byte scale [0,255]**, NHWC [1,80,80,3], and
softmaxes the [1,3] logits into (print, live, replay).

That [0,255] scale is correct and deliberate. Upstream Silent-Face-Anti-Spoofing
removed the /255 division from its ToTensor:

    src/data_io/functional.py
        img = torch.from_numpy(pic.transpose((2, 0, 1)))
        # backward compatibility
        # return img.float().div(255)  modify by zkx
        return img.float()

The `ToTensor` docstring in src/data_io/transform.py still advertises [0.0, 1.0]
and is stale -- believing it and "fixing" the app to feed [0,1] silently breaks
the models into a near-constant output. Test 3 below locks that down so nobody
makes that change again.

What each test proves
---------------------
  1. Tensor contract     -- shape/dtype the Kotlin buffer code assumes.
  2. Numerical safety    -- no NaN/Inf, softmax normalises.
  3. Scale discrimination-- [0,255] is input-sensitive and [0,1] is not.
                            This is the assertion whose absence let a wrong
                            input scale look plausible.
  4. Semantic agreement  -- on the upstream sample images, cropped with the
                            upstream RetinaFace box and CropImage geometry, the
                            shipped TFLite assets must reproduce the reference
                            verdicts (T1 live, F1/F2 spoof) and match reference
                            PyTorch probabilities within tolerance.
  5. Sampling parity     -- the direct inverse-mapped sampler that replaced
                            `imageProxyToBitmap()` + `createScaledBitmap()` in
                            FacePipeline.kt must produce the same patch: same
                            rotation mapping, same half-pixel resize
                            convention, same resulting p_live.
  6. Cue responsiveness  -- the passive cues in LivenessCues.kt must actually
                            respond to the physics they claim to measure. A cue
                            that silently returns garbage would be "calibrated"
                            to zero weight in Phase 5 with no indication why, so
                            each is driven with a synthetic stimulus containing
                            the phenomenon and a matched control without it.

Tests 1-3, 5's geometry half, and all of 6 need only the shipped assets. Test 4
and 5's score half additionally need the upstream checkout under .tmp/sfas
(weights, RetinaFace detector, sample images); those are reported as SKIPPED
rather than failed when it is absent, so CI without the 1.8 MB weights still gets
the rest.

Usage:
  python scripts/run_golden_tests.py
  python scripts/run_golden_tests.py --sfas-dir .tmp/sfas
"""

import argparse
import math
import os
import sys

import numpy as np

ASSET_DIR = os.path.join("android", "app", "src", "main", "assets")
V2_ASSET = "minifasnetv2_80.tflite"
V1SE_ASSET = "minifasnetv1se_80.tflite"

# Upstream pairing: MiniFASNetV2 gets the 2.7x crop, MiniFASNetV1SE the 4.0x crop.
# Encoded in the asset filenames' upstream names (2.7_80x80_MiniFASNetV2.pth,
# 4_0_0_80x80_MiniFASNetV1SE.pth) and mirrored by FacePipeline.
MODEL_SCALES = {V2_ASSET: 2.7, V1SE_ASSET: 4.0}

SAMPLES = [("image_T1.jpg", "LIVE"), ("image_F1.jpg", "SPOOF"), ("image_F2.jpg", "SPOOF")]

_failures = []
_skipped = []


def check(condition, label, detail=""):
    if condition:
        print(f"  [PASS] {label}")
    else:
        print(f"  [FAIL] {label}" + (f" -- {detail}" if detail else ""))
        _failures.append(label)
    return condition


# ------------------------------------------------------------------ inference


def tflite_probs(path, bgr_255):
    """Mirrors AntiSpoofStage.process(): BGR [0,255] in, softmax(logits) out."""
    import tensorflow as tf

    interp = tf.lite.Interpreter(model_path=path)
    interp.allocate_tensors()
    inp = interp.get_input_details()[0]
    out = interp.get_output_details()[0]
    interp.set_tensor(inp["index"], np.expand_dims(bgr_255, 0).astype(np.float32))
    interp.invoke()
    logits = interp.get_tensor(out["index"])[0]
    shifted = np.exp(logits - np.max(logits))
    return logits, shifted / np.sum(shifted)


# ------------------------------------------------------- tests 1-3 (assets only)


def test_tensor_contract(name, path):
    import tensorflow as tf

    print(f"\n--- {name}: tensor contract ---")
    interp = tf.lite.Interpreter(model_path=path)
    interp.allocate_tensors()
    in_d, out_d = interp.get_input_details()[0], interp.get_output_details()[0]
    in_shape = in_d["shape"].tolist()
    out_shape = out_d["shape"].tolist()
    check(in_shape == [1, 80, 80, 3], "input shape [1,80,80,3]", f"got {in_shape}")
    check("float32" in str(in_d["dtype"]).lower(), "input dtype float32", str(in_d["dtype"]))
    check(out_shape == [1, 3], "output shape [1,3]", f"got {out_shape}")


def test_numerical_safety(name, path):
    print(f"\n--- {name}: numerical safety ---")
    rng = np.random.RandomState(42)
    probe = rng.uniform(0.0, 255.0, (80, 80, 3)).astype(np.float32)
    logits, probs = tflite_probs(path, probe)
    check(not np.isnan(logits).any() and not np.isinf(logits).any(), "logits finite", str(logits))
    check(np.isclose(probs.sum(), 1.0, atol=1e-4), "softmax sums to 1", f"{probs.sum()}")
    check(logits.shape == (3,), "logit vector is length 3", str(logits.shape))


def test_scale_discrimination(name, path, sfas_dir):
    """The shipped [0,255] contract must be input-sensitive; [0,1] must not be.

    Uses a real face when the upstream samples are available, and a structured
    synthetic stand-in otherwise, plus flat/noise/stripe probes. A working model
    on the correct scale spreads p_live widely across these; on the wrong scale
    the network is starved into a near-constant response.
    """
    import cv2

    print(f"\n--- {name}: input-scale discrimination ---")
    rng = np.random.RandomState(0)
    face = None
    sample = os.path.join(sfas_dir, "images", "sample", "image_T1.jpg")
    if os.path.exists(sample):
        face = cv2.resize(cv2.imread(sample), (80, 80)).astype(np.float32)
    probes = {
        "noise": rng.uniform(0, 255, (80, 80, 3)).astype(np.float32),
        "black": np.zeros((80, 80, 3), np.float32),
        "white": np.full((80, 80, 3), 255.0, np.float32),
        "gray": np.full((80, 80, 3), 128.0, np.float32),
        "stripes": np.where(
            (np.arange(80)[None, :, None] % 2) == 0, 255.0, 0.0
        ).repeat(3, 2).repeat(80, 0).reshape(80, 80, 3).astype(np.float32),
    }
    if face is not None:
        probes["realface"] = face

    spreads = {}
    for label, divisor in (("[0,255] (shipped)", 1.0), ("[0,1] (stale docstring)", 255.0)):
        lives = []
        for pname, arr in probes.items():
            _, probs = tflite_probs(path, arr / divisor)
            lives.append(probs[1])
        spreads[label] = float(np.ptp(lives))
        print(f"    {label:26s} p_live range={np.ptp(lives):.6f}  " + " ".join(
            f"{n}={v:.3f}" for n, v in zip(probes, lives)
        ))

    check(
        spreads["[0,255] (shipped)"] > 0.10,
        "shipped [0,255] scale is input-sensitive",
        f"p_live spread only {spreads['[0,255] (shipped)']:.6f}",
    )
    check(
        spreads["[0,1] (stale docstring)"] < spreads["[0,255] (shipped)"],
        "[0,1] is less discriminative than [0,255] (do not 'fix' the app to /255)",
        f"[0,1] spread {spreads['[0,1] (stale docstring)']:.6f} "
        f">= [0,255] spread {spreads['[0,255] (shipped)']:.6f}",
    )


# --------------------------------------------- test 4 (needs upstream checkout)


def get_new_box(src_w, src_h, bbox, scale):
    """Verbatim port of upstream CropImage._get_new_box."""
    x, y, box_w, box_h = bbox
    scale = min((src_h - 1) / box_h, min((src_w - 1) / box_w, scale))
    new_w, new_h = box_w * scale, box_h * scale
    cx, cy = box_w / 2 + x, box_h / 2 + y
    lt_x, lt_y, rb_x, rb_y = cx - new_w / 2, cy - new_h / 2, cx + new_w / 2, cy + new_h / 2
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


def reference_crop(img, bbox, scale):
    import cv2

    h, w = img.shape[:2]
    x1, y1, x2, y2 = get_new_box(w, h, bbox, scale)
    return cv2.resize(img[y1 : y2 + 1, x1 : x2 + 1], (80, 80), interpolation=cv2.INTER_LINEAR)


def retinaface_bbox(sfas_dir, img):
    import cv2

    net = cv2.dnn.readNetFromCaffe(
        os.path.join(sfas_dir, "resources", "detection_model", "deploy.prototxt"),
        os.path.join(sfas_dir, "resources", "detection_model", "Widerface-RetinaFace.caffemodel"),
    )
    h, w = img.shape[0], img.shape[1]
    aspect = w / h
    small = img
    if w * h >= 192 * 192:
        small = cv2.resize(
            img,
            (int(192 * math.sqrt(aspect)), int(192 / math.sqrt(aspect))),
            interpolation=cv2.INTER_LINEAR,
        )
    net.setInput(cv2.dnn.blobFromImage(small, 1, mean=(104, 117, 123)), "data")
    out = net.forward("detection_out").squeeze()
    best = np.argmax(out[:, 2])
    l, t, r, b = out[best, 3] * w, out[best, 4] * h, out[best, 5] * w, out[best, 6] * h
    return [int(l), int(t), int(r - l + 1), int(b - t + 1)]


def reference_pytorch_probs(sfas_dir, patch, which):
    import torch
    import torch.nn.functional as F

    sys.path.insert(0, sfas_dir)
    from src.model_lib.MiniFASNet import MiniFASNetV2, MiniFASNetV1SE
    from src.utility import get_kernel

    cls, fname = {
        V2_ASSET: (MiniFASNetV2, "2.7_80x80_MiniFASNetV2.pth"),
        V1SE_ASSET: (MiniFASNetV1SE, "4_0_0_80x80_MiniFASNetV1SE.pth"),
    }[which]
    model = cls(conv6_kernel=get_kernel(80, 80))
    state = torch.load(
        os.path.join(sfas_dir, "resources", "anti_spoof_models", fname),
        map_location="cpu",
        weights_only=True,
    )
    if any(k.startswith("module.") for k in state):
        state = {k[7:]: v for k, v in state.items()}
    model.load_state_dict(state)
    model.eval()
    tensor = torch.from_numpy(patch.astype(np.float32).transpose(2, 0, 1)[None])
    with torch.no_grad():
        return F.softmax(model(tensor), dim=1).numpy()[0]


def test_semantic_agreement(sfas_dir):
    """Shipped TFLite must reproduce the upstream reference verdicts."""
    import cv2

    print("\n--- ensemble: semantic agreement with upstream reference ---")
    weights = os.path.join(sfas_dir, "resources", "anti_spoof_models")
    if not os.path.isdir(weights) or not os.path.isdir(
        os.path.join(sfas_dir, "images", "sample")
    ):
        print(f"  [SKIP] upstream checkout not found at {sfas_dir}")
        print("         Fetch with: git clone --depth 1 \\")
        print("           https://github.com/minivision-ai/Silent-Face-Anti-Spoofing.git")
        print("         then extract src/, resources/, images/sample/ into .tmp/sfas")
        _skipped.append("semantic agreement")
        return

    print(f"  {'image':16s} {'truth':6s} {'p_live':>8s} {'verdict':>8s} {'max|dP| vs torch':>18s}")
    for name, truth in SAMPLES:
        img = cv2.imread(os.path.join(sfas_dir, "images", "sample", name))
        bbox = retinaface_bbox(sfas_dir, img)
        ens = np.zeros(3)
        worst = 0.0
        for asset, scale in MODEL_SCALES.items():
            patch = reference_crop(img, bbox, scale)
            _, tfl = tflite_probs(os.path.join(ASSET_DIR, asset), patch)
            torch_probs = reference_pytorch_probs(sfas_dir, patch, asset)
            worst = max(worst, float(np.max(np.abs(tfl - torch_probs))))
            ens += tfl
        ens /= len(MODEL_SCALES)
        verdict = "LIVE" if int(np.argmax(ens)) == 1 else "SPOOF"
        print(f"  {name:16s} {truth:6s} {ens[1]:8.4f} {verdict:>8s} {worst:18.6f}")
        check(verdict == truth, f"{name}: verdict {verdict} == reference {truth}")
        check(worst < 5e-3, f"{name}: TFLite matches reference PyTorch", f"max dP={worst:.6f}")


# ------------------------------------- test 5 (Kotlin sampler port parity)


def kotlin_oriented_to_raw(oriented_x, oriented_y, rotation, raw_w, raw_h):
    """Port of YuvFrame.argbAt's oriented->raw map (continuous, centres at k+0.5)."""
    if rotation == 90:
        return oriented_y, raw_h - oriented_x
    if rotation == 180:
        return raw_w - oriented_x, raw_h - oriented_y
    if rotation == 270:
        return raw_w - oriented_y, oriented_x
    return oriented_x, oriented_y


def kotlin_sample(img, oriented_x, oriented_y, rotation):
    """Port of YuvFrame.argbAt: bilinear in raw space, border-replicate.

    Operates on an already-converted BGR image rather than YUV planes. That is
    faithful because YUV->RGB is affine and therefore commutes with bilinear
    interpolation (up to the final clamp), which is exactly why the Kotlin
    version is allowed to interpolate luma/chroma and convert afterwards.
    """
    raw_h, raw_w = img.shape[:2]
    rx, ry = kotlin_oriented_to_raw(oriented_x, oriented_y, rotation, raw_w, raw_h)
    fx, fy = rx - 0.5, ry - 0.5
    ix, iy = np.floor(fx).astype(int), np.floor(fy).astype(int)
    wx, wy = (fx - ix)[..., None], (fy - iy)[..., None]
    x0, x1 = np.clip(ix, 0, raw_w - 1), np.clip(ix + 1, 0, raw_w - 1)
    y0, y1 = np.clip(iy, 0, raw_h - 1), np.clip(iy + 1, 0, raw_h - 1)
    src = img.astype(np.float32)
    top = src[y0, x0] + (src[y0, x1] - src[y0, x0]) * wx
    bottom = src[y1, x0] + (src[y1, x1] - src[y1, x0]) * wx
    return top + (bottom - top) * wy


def kotlin_anti_spoof_patch(img, bounds, scale, rotation=0, out=80):
    """Port of NativeFaceCropStage.processAntiSpoof's grid.

    `img` is the *raw* frame; `bounds` is in oriented coordinates, matching how
    ML Kit reports face boxes.
    """
    raw_h, raw_w = img.shape[:2]
    oriented_w, oriented_h = (raw_h, raw_w) if rotation in (90, 270) else (raw_w, raw_h)
    bx, by, bw, bh = bounds
    effective = min(scale, (oriented_w - 1) / bw, (oriented_h - 1) / bh)
    crop_w_f, crop_h_f = bw * effective, bh * effective
    left = min(max(bx + bw / 2 - crop_w_f / 2, 0.0), max(oriented_w - crop_w_f, 0.0))
    top = min(max(by + bh / 2 - crop_h_f / 2, 0.0), max(oriented_h - crop_h_f, 0.0))
    origin_x, origin_y = int(left), int(top)
    crop_w = max(min(int(crop_w_f), oriented_w - origin_x), 1)
    crop_h = max(min(int(crop_h_f), oriented_h - origin_y), 1)

    grid = np.arange(out) + 0.5
    sx = origin_x + grid * (crop_w / out)
    sy = origin_y + grid * (crop_h / out)
    gx, gy = np.meshgrid(sx, sy)
    patch = kotlin_sample(img, gx, gy, rotation)
    return patch, (origin_x, origin_y, crop_w, crop_h)


def test_sampling_parity(sfas_dir):
    """The new direct sampler must match the Bitmap path it replaced."""
    import cv2

    print("\n--- FacePipeline sampler: port parity ---")
    sample = os.path.join(sfas_dir, "images", "sample", "image_T1.jpg")
    if os.path.exists(sample):
        img = cv2.imread(sample)
        origin = os.path.basename(sample)
    else:
        # Deterministic high-frequency texture: worst case for a resize mismatch.
        yy, xx = np.mgrid[0:480, 0:640]
        img = np.stack(
            [
                (127 + 127 * np.sin(xx / 3.0 + yy / 7.0)),
                (127 + 127 * np.sin(xx / 5.0 - yy / 4.0)),
                (127 + 127 * np.sin((xx + yy) / 2.0)),
            ],
            axis=-1,
        ).astype(np.uint8)
        origin = "synthetic sinusoid"
    print(f"  source: {origin} ({img.shape[1]}x{img.shape[0]})")

    # --- rotation mapping: sampling at oriented centres must equal a rotate.
    for rotation in (0, 90, 180, 270):
        raw_h, raw_w = img.shape[:2]
        ow, oh = (raw_h, raw_w) if rotation in (90, 270) else (raw_w, raw_h)
        gx, gy = np.meshgrid(np.arange(ow) + 0.5, np.arange(oh) + 0.5)
        got = kotlin_sample(img, gx, gy, rotation)
        # np.rot90(k=-1) is one clockwise quarter turn, matching postRotate(+90).
        want = np.rot90(img, k=-(rotation // 90)).astype(np.float32)
        worst = float(np.max(np.abs(got - want)))
        check(worst < 1e-3, f"rotation {rotation} deg mapping matches clockwise rotate",
              f"max |diff| = {worst}")

    # --- resize convention: must match the cv2/createScaledBitmap half-pixel grid.
    bounds = (int(img.shape[1] * 0.30), int(img.shape[0] * 0.22),
              int(img.shape[1] * 0.28), int(img.shape[0] * 0.30))
    for scale in (2.7, 4.0):
        patch, (ox, oy, cw, ch) = kotlin_anti_spoof_patch(img, bounds, scale)
        # What the old Kotlin did: crop that exact integer region, then
        # createScaledBitmap(..., filter = true) -> bilinear to 80x80.
        old = cv2.resize(
            img[oy : oy + ch, ox : ox + cw], (80, 80), interpolation=cv2.INTER_LINEAR
        ).astype(np.float32)
        worst = float(np.max(np.abs(patch - old)))
        mean = float(np.mean(np.abs(patch - old)))
        print(f"    scale {scale}x  region=({ox},{oy},{cw},{ch})  "
              f"max|dPx|={worst:.2f} mean|dPx|={mean:.3f}")
        # cv2 does bilinear weights in 5-bit fixed point, so a few LSBs differ.
        check(worst <= 2.0, f"{scale}x patch matches bilinear resize (max <= 2 LSB)",
              f"max |diff| = {worst}")
        check(mean <= 0.5, f"{scale}x patch matches bilinear resize (mean <= 0.5 LSB)",
              f"mean |diff| = {mean}")

    # --- score parity: the difference must not move the model's decision.
    if not os.path.isdir(os.path.join(sfas_dir, "resources", "anti_spoof_models")):
        print("  [SKIP] score parity needs the upstream checkout")
        _skipped.append("sampler score parity")
        return
    for name, truth in SAMPLES:
        src = cv2.imread(os.path.join(sfas_dir, "images", "sample", name))
        bbox = retinaface_bbox(sfas_dir, src)
        new_ens = np.zeros(3)
        old_ens = np.zeros(3)
        for asset, scale in MODEL_SCALES.items():
            path = os.path.join(ASSET_DIR, asset)
            patch, (ox, oy, cw, ch) = kotlin_anti_spoof_patch(src, bbox, scale)
            old = cv2.resize(
                src[oy : oy + ch, ox : ox + cw], (80, 80), interpolation=cv2.INTER_LINEAR
            )
            new_ens += tflite_probs(path, patch.astype(np.float32))[1]
            old_ens += tflite_probs(path, old.astype(np.float32))[1]
        new_ens /= len(MODEL_SCALES)
        old_ens /= len(MODEL_SCALES)
        delta = abs(new_ens[1] - old_ens[1])
        print(f"    {name:16s} {truth:6s} new p_live={new_ens[1]:.4f} "
              f"old p_live={old_ens[1]:.4f} delta={delta:.5f}")
        check(delta < 0.02, f"{name}: sampler swap moves p_live < 0.02",
              f"delta = {delta:.5f}")


# -------------------------------- test 6 (LivenessCues.kt port responsiveness)

PATCH = 64
EULER_GAMMA = 0.5772156649015329
HANN = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(PATCH) / (PATCH - 1))


def kotlin_fft64(vector):
    """Literal port of LivenessCues.kt's Fft64.transform, for one length-64 row.

    Transcribed rather than replaced by np.fft on purpose: the point is to check
    the hand-rolled radix-2 butterfly as written in Kotlin, including its
    bit-reversal table and its `wi = -sin` sign convention.
    """
    n, log_n = 64, 6
    cos_t = np.cos(2.0 * np.pi * np.arange(n // 2) / n)
    sin_t = np.sin(2.0 * np.pi * np.arange(n // 2) / n)
    reversed_idx = []
    for i in range(n):
        r, x = 0, i
        for _ in range(log_n):
            r = (r << 1) | (x & 1)
            x >>= 1
        reversed_idx.append(r)

    re = np.array(np.real(vector), dtype=np.float64)
    im = np.array(np.imag(vector), dtype=np.float64)
    for i in range(n):
        j = reversed_idx[i]
        if j > i:
            re[i], re[j] = re[j], re[i]
            im[i], im[j] = im[j], im[i]
    size = 2
    while size <= n:
        half = size // 2
        step = n // size
        base = 0
        while base < n:
            index, tw = base, 0
            while index < base + half:
                a, b = index, index + half
                wr, wi = cos_t[tw], -sin_t[tw]
                tr = re[b] * wr - im[b] * wi
                ti = re[b] * wi + im[b] * wr
                re[b], im[b] = re[a] - tr, im[a] - ti
                re[a], im[a] = re[a] + tr, im[a] + ti
                index += 1
                tw += step
            base += size
        size *= 2
    return re + 1j * im


def kotlin_fft2(patch):
    """Rows then columns, matching the two loops in ImageCues.moire."""
    out = np.array(patch, dtype=np.complex128)
    for row in range(PATCH):
        out[row, :] = kotlin_fft64(out[row, :])
    for col in range(PATCH):
        out[:, col] = kotlin_fft64(out[:, col])
    return out


def kotlin_moire_score(patch):
    """Port of ImageCues.moire: Hann -> FFT2 -> radial profile -> log-log bump.

    The falloff line is fitted to the annulus *mean* (robust) while the bump is
    measured against the annulus *peak*. Averaging on both sides buries a narrow
    spike: a 4-bin peak at r=14 is diluted across ~88 bins of that annulus.

    The expected noise maximum ln(ln n + gamma) is then subtracted, so the score
    is excess over what noise alone would produce rather than over the mean.

    Returns (bump, bump_radius, slope).
    """
    windowed = (patch - patch.mean()) * HANN[:, None] * HANN[None, :]
    spectrum = kotlin_fft2(windowed)

    power = np.zeros(PATCH)
    peak = np.zeros(PATCH)
    count = np.zeros(PATCH, dtype=int)
    for row in range(PATCH):
        ky = row if row <= PATCH // 2 else row - PATCH
        for col in range(PATCH):
            kx = col if col <= PATCH // 2 else col - PATCH
            radius = int(math.hypot(kx, ky))
            if radius >= PATCH // 2:
                continue
            bin_power = abs(spectrum[row, col]) ** 2
            power[radius] += bin_power
            peak[radius] = max(peak[radius], bin_power)
            count[radius] += 1

    w_sum = wx = wy = wxx = wxy = 0.0
    for radius in range(3, 31):
        if count[radius] == 0 or power[radius] <= 0:
            continue
        lx, ly, weight = math.log(radius), math.log(power[radius] / count[radius]), count[radius]
        w_sum += weight
        wx += weight * lx
        wy += weight * ly
        wxx += weight * lx * lx
        wxy += weight * lx * ly
    slope = (w_sum * wxy - wx * wy) / (w_sum * wxx - wx * wx)
    intercept = (wy - slope * wx) / w_sum

    bump, bump_radius = 0.0, 0
    for radius in range(7, 30):
        if count[radius] == 0 or peak[radius] <= 0:
            continue
        noise_maximum = math.log(math.log(count[radius]) + EULER_GAMMA)
        residual = (math.log(peak[radius])
                    - (slope * math.log(radius) + intercept)
                    - noise_maximum)
        if residual > bump:
            bump, bump_radius = residual, radius
    return bump, bump_radius, slope


def kotlin_homography_residual(src, dst):
    """Port of ParallaxCue.homographyResidual: RMS residual in pixels, or None.

    Inhomogeneous normalised DLT with h33 fixed to 1, both point sets recentred
    and scaled to unit RMS radius, residual scaled back by the target radius.
    """
    ok = ~(np.isnan(src[:, 0]) | np.isnan(dst[:, 0]))
    if ok.sum() < 6:
        return None

    def norm(points):
        centred = points - points.mean(axis=0)
        radius = math.sqrt((centred ** 2).sum() / len(centred))
        if radius < 1e-3:
            return None, None
        return centred / radius, radius

    s, s_radius = norm(src[ok])
    d, d_radius = norm(dst[ok])
    if s is None or d is None:
        return None

    n = len(s)
    u, v, p, q = s[:, 0], s[:, 1], d[:, 0], d[:, 1]
    rows = np.zeros((2 * n, 8))
    rows[0::2, 0] = u
    rows[0::2, 1] = v
    rows[0::2, 2] = 1.0
    rows[0::2, 6] = -u * p
    rows[0::2, 7] = -v * p
    rows[1::2, 3] = u
    rows[1::2, 4] = v
    rows[1::2, 5] = 1.0
    rows[1::2, 6] = -u * q
    rows[1::2, 7] = -v * q
    targets = np.empty(2 * n)
    targets[0::2] = p
    targets[1::2] = q

    # lstsq solves the same normal equations the Kotlin accumulates by hand.
    h, *_ = np.linalg.lstsq(rows, targets, rcond=None)
    denom = h[6] * u + h[7] * v + 1.0
    if np.min(np.abs(denom)) < 1e-6:
        return None
    dx = (h[0] * u + h[1] * v + h[2]) / denom - p
    dy = (h[3] * u + h[4] * v + h[5]) / denom - q
    return float(math.sqrt(((dx ** 2 + dy ** 2).sum()) / n) * d_radius)


def superseded_affine_residual(src, dst):
    """The 6-parameter fit ParallaxCue used before the homography.

    Kept only so the test can show *why* it was replaced: an affine map is the
    first-order approximation to a plane's inter-frame map, and the neglected
    perspective term turns out to be a large fraction of the real 3D signal at
    selfie geometry. If someone reverts to the cheaper fit, this documents the cost.
    """
    ok = ~(np.isnan(src[:, 0]) | np.isnan(dst[:, 0]))
    if ok.sum() < 5:
        return None
    s, d = src[ok], dst[ok]
    centre = s.mean(axis=0)
    radius = math.sqrt(((s - centre) ** 2).sum() / len(s))
    design = np.column_stack([(s - centre) / radius, np.ones(len(s))])
    coeff, *_ = np.linalg.lstsq(design, d, rcond=None)
    return float(np.sqrt(((design @ coeff - d) ** 2).sum() / len(s)))


# Approximate anthropometric landmark offsets in mm (x right, y down, z toward
# camera). Only the depth *spread* matters here -- ears sit ~55mm behind the eye
# plane and the nose ~22mm in front, which is what produces parallax.
FACE_3D = np.array([
    [-32.0, -35.0, 0.0], [32.0, -35.0, 0.0], [0.0, 0.0, 22.0],
    [-55.0, 0.0, -8.0], [55.0, 0.0, -8.0],
    [-25.0, 30.0, 8.0], [25.0, 30.0, 8.0], [0.0, 42.0, 10.0],
    [-75.0, -15.0, -55.0], [75.0, -15.0, -55.0],
])


def project(points3d, focal=400.0, distance=400.0, principal=(320.0, 240.0)):
    """Pinhole projection. Eye distance lands near 64px at these defaults."""
    depth = distance - points3d[:, 2]
    return np.column_stack([
        principal[0] + focal * points3d[:, 0] / depth,
        principal[1] + focal * points3d[:, 1] / depth,
    ])


def rotate_y(points3d, degrees):
    t = math.radians(degrees)
    c, s = math.cos(t), math.sin(t)
    return points3d @ np.array([[c, 0.0, -s], [0.0, 1.0, 0.0], [s, 0.0, c]]).T


def rotate_z(points3d, degrees):
    t = math.radians(degrees)
    c, s = math.cos(t), math.sin(t)
    return points3d @ np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]).T


def kotlin_bezel_score(img, bounds):
    """Port of ImageCues.bezel: ring luma -> Sobel -> 36-bin orientation modes."""
    ring_n, bins = 80, 36
    bx, by, bw, bh = bounds
    cx, cy = bx + bw / 2.0, by + bh / 2.0
    span = max(bw, bh) * 2.4
    step = span / ring_n
    start_x, start_y = cx - span / 2.0, cy - span / 2.0

    grid = np.arange(ring_n) + 0.5
    gx, gy = np.meshgrid(start_x + grid * step, start_y + grid * step)
    bgr = kotlin_sample(img, gx, gy, 0)
    ring = 0.114 * bgr[..., 0] + 0.587 * bgr[..., 1] + 0.299 * bgr[..., 2]

    inner_half = max(bw, bh) * 1.15 / 2.0
    orientation = np.zeros(bins)
    total = 0.0
    for row in range(1, ring_n - 1):
        y = start_y + (row + 0.5) * step
        for col in range(1, ring_n - 1):
            x = start_x + (col + 0.5) * step
            if abs(x - cx) < inner_half and abs(y - cy) < inner_half:
                continue
            dx = (ring[row, col + 1] - ring[row, col - 1]) \
                + 0.5 * (ring[row - 1, col + 1] - ring[row - 1, col - 1]) \
                + 0.5 * (ring[row + 1, col + 1] - ring[row + 1, col - 1])
            dy = (ring[row + 1, col] - ring[row - 1, col]) \
                + 0.5 * (ring[row + 1, col + 1] - ring[row - 1, col + 1]) \
                + 0.5 * (ring[row + 1, col - 1] - ring[row - 1, col - 1])
            magnitude = math.hypot(dx, dy)
            if magnitude < 12.0:
                continue
            angle = math.degrees(math.atan2(dy, dx)) % 180.0
            orientation[min(int(angle / (180.0 / bins)), bins - 1)] += magnitude
            total += magnitude

    if total < 2000.0:
        return None, None, total

    def circ(a, b):
        raw = abs(a - b)
        return min(raw, bins - raw)

    first = int(np.argmax(orientation))
    candidates = [b for b in range(bins) if circ(b, first) >= 8]
    if not candidates:
        return 0.0, None, total
    second = max(candidates, key=lambda b: orientation[b])
    separation = circ(first, second) * (180.0 / bins)
    if abs(separation - 90.0) > 22.0:
        return 0.0, separation, total
    energy = sum(
        orientation[(m + o) % bins] for m in (first, second) for o in range(-2, 3)
    )
    return energy / total, separation, total


def test_cue_responsiveness(sfas_dir):
    """Each passive cue must move in the right direction on a known stimulus."""
    print("\n--- LivenessCues: cue responsiveness ---")
    rng = np.random.RandomState(7)

    # --- FFT: the hand-rolled butterfly must be a real DFT.
    probe = rng.standard_normal((PATCH, PATCH))
    worst = float(np.max(np.abs(kotlin_fft2(probe) - np.fft.fft2(probe))))
    check(worst < 1e-8, "Fft64 port matches np.fft.fft2", f"max |diff| = {worst:.3e}")

    # --- Parallax: zero on a plane at every angle, growing on a 3D face.
    #     Compared like-for-like at each angle, and against the superseded affine
    #     fit, which is what exposed the perspective bias.
    plane = FACE_3D.copy()
    plane[:, 2] = 0.0
    face_before = project(FACE_3D)
    flat_before = project(plane)
    eye_distance = float(np.hypot(*(face_before[1] - face_before[0])))
    print(f"    eye distance {eye_distance:.1f} px      "
          f"({'homography':>10s} / {'affine':>8s}) residual, px")

    flat_residuals, depth_residuals = [], []
    for degrees in (2.0, 4.0, 6.0):
        flat = kotlin_homography_residual(flat_before, project(rotate_y(plane, degrees)))
        flat_affine = superseded_affine_residual(flat_before, project(rotate_y(plane, degrees)))
        deep = kotlin_homography_residual(face_before, project(rotate_y(FACE_3D, degrees)))
        deep_affine = superseded_affine_residual(face_before, project(rotate_y(FACE_3D, degrees)))
        flat_residuals.append(flat)
        depth_residuals.append(deep)
        print(f"    {degrees:.0f}deg yaw  flat photo  {flat:10.5f} / {flat_affine:8.5f}"
              f"     3D face {deep:9.5f} / {deep_affine:8.5f}"
              f"     ratio {deep / max(flat, 1e-9):8.0f}x / {deep_affine / flat_affine:5.1f}x")

    check(max(flat_residuals) < 1e-3,
          "flat photo yields ~zero homography residual at every angle",
          f"worst = {max(flat_residuals):.6f} px")
    check(depth_residuals[0] > 0.15, "3D face yields real parallax at 2deg yaw",
          f"residual = {depth_residuals[0]:.5f} px")
    check(depth_residuals == sorted(depth_residuals),
          "parallax residual grows with rotation", str(depth_residuals))
    check(depth_residuals[0] / max(flat_residuals[0], 1e-9) > 1000,
          "3D residual clears the planar floor by orders of magnitude",
          f"{depth_residuals[0]:.5f} vs {flat_residuals[0]:.6f}")

    # This is the assertion behind excluding roll from the rotation gate: an
    # in-plane rotation is absorbed exactly, so counting it would divide real
    # parallax by a rotation that cannot produce any.
    roll_residual = kotlin_homography_residual(face_before, project(rotate_z(FACE_3D, 6.0)))
    print(f"    6deg ROLL, 3D face           residual = {roll_residual:.6f} px")
    check(roll_residual < 1e-3,
          "roll produces no parallax (justifies the yaw+pitch-only gate)",
          f"residual = {roll_residual:.6f} px")

    # --- Moire: a periodic grid must raise the bump above the 1/f falloff.
    #     Base is 1/f noise, the closest cheap stand-in for natural image spectra.
    #     Several realisations, because a single seed cannot show that the floor is
    #     stable -- and a floor that wanders is indistinguishable from a signal.
    fy = np.fft.fftfreq(PATCH)[:, None]
    fx = np.fft.fftfreq(PATCH)[None, :]
    radial = np.hypot(fx, fy)
    radial[0, 0] = 1.0

    grid_cycles = 14
    ramp = 2.0 * np.pi * grid_cycles * np.arange(PATCH) / PATCH
    grid = np.sin(ramp)[None, :] + np.sin(ramp)[:, None]

    print("    1/f base -> +grid    faint (5% contrast)      strong (15% contrast)")
    floors, strong_bumps, strong_radii = [], [], []
    for seed in range(4):
        noise = np.random.RandomState(seed).standard_normal((PATCH, PATCH))
        natural = np.real(np.fft.ifft2(np.fft.fft2(noise) / radial))
        natural = 128.0 + 40.0 * natural / natural.std()

        base_bump, base_r, slope = kotlin_moire_score(natural)
        faint_bump, _, _ = kotlin_moire_score(natural + 2.0 * grid)
        strong_bump, strong_r, _ = kotlin_moire_score(natural + 6.0 * grid)
        floors.append(base_bump)
        strong_bumps.append(strong_bump)
        strong_radii.append(strong_r)
        print(f"    seed {seed}  base {base_bump:.3f} (r{base_r:2d}, slope {slope:5.2f})"
              f"   faint {faint_bump:.3f}"
              f"   strong {strong_bump:.3f} (r{strong_r:2d})")

    check(max(floors) < 0.6, "noise-only bump floor stays near zero",
          f"worst floor = {max(floors):.3f} over {len(floors)} realisations")
    check(min(strong_bumps) > 0.65, "periodic grid raises the spectral bump",
          f"weakest = {min(strong_bumps):.3f} vs worst floor {max(floors):.3f}")
    check(min(strong_bumps) > max(floors) + 0.25,
          "grid response separates from the noise floor across realisations",
          f"{min(strong_bumps):.3f} vs {max(floors):.3f}")
    check(all(abs(r - grid_cycles) <= 1 for r in strong_radii),
          "bump lands at the injected grid frequency",
          f"detected radii {strong_radii}, injected {grid_cycles}")

    # --- Bezel: two perpendicular straight-edge families must register, and
    #     clutter at a single orientation must not.
    import cv2

    face_box = (260, 170, 120, 150)
    base = np.full((480, 640, 3), 110, np.uint8)
    cv2.ellipse(base, (320, 245), (58, 74), 0, 0, 360, (170, 175, 185), -1)

    # Control: strong edges, but all one orientation, so the perpendicularity gate
    # should zero the score. A blank control would pass trivially by having no edges.
    striped = base.copy()
    for offset in range(-500, 700, 26):
        cv2.line(striped, (offset, 0), (offset + 480, 480), (240, 240, 240), 2)
    striped_score, striped_sep, striped_energy = kotlin_bezel_score(striped, face_box)

    framed = base.copy()
    cv2.rectangle(framed, (232, 132), (408, 358), (245, 245, 245), 3)
    framed_score, framed_sep, framed_energy = kotlin_bezel_score(framed, face_box)

    striped_text = "abstain" if striped_score is None else f"{striped_score:.4f}"
    striped_sep_text = "-" if striped_sep is None else f"{striped_sep:.0f}deg"
    print(f"    single-orientation clutter   score = {striped_text} "
          f"sep = {striped_sep_text} (ring energy {striped_energy:.0f})")
    print(f"    phone-bezel rectangle        score = {framed_score:.4f} "
          f"sep = {framed_sep:.0f}deg (ring energy {framed_energy:.0f})")
    check(framed_score is not None and framed_score > 0.30,
          "rectangular bezel registers strong perpendicular modes",
          f"score = {framed_score}")
    check(framed_sep is not None and abs(framed_sep - 90.0) <= 22.0,
          "bezel modes are near-perpendicular", f"separation = {framed_sep}")
    check(striped_score is not None and striped_energy > 2000,
          "single-orientation control does have edges to reject",
          f"ring energy = {striped_energy:.0f}")
    check(striped_score is not None and framed_score > 4 * striped_score,
          "perpendicularity gate suppresses single-orientation clutter",
          f"{framed_score} vs {striped_text}")


# ------------------------------------------------------------------------ main


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--sfas-dir", default=os.path.join(".tmp", "sfas"))
    args = ap.parse_args()
    sfas = os.path.abspath(args.sfas_dir)

    for asset in (V2_ASSET, V1SE_ASSET):
        path = os.path.join(ASSET_DIR, asset)
        if not os.path.exists(path):
            print(f"[FAIL] missing shipped asset: {path}")
            _failures.append(f"missing {asset}")
            continue
        test_tensor_contract(asset, path)
        test_numerical_safety(asset, path)
        test_scale_discrimination(asset, path, sfas)

    test_semantic_agreement(sfas)
    test_sampling_parity(sfas)
    test_cue_responsiveness(sfas)

    print("\n" + "=" * 70)
    if _failures:
        print(f"FAILED: {len(_failures)} check(s)")
        for f in _failures:
            print(f"  - {f}")
        sys.exit(1)
    msg = "ALL GOLDEN TESTS PASSED"
    if _skipped:
        msg += f" ({len(_skipped)} skipped: {', '.join(_skipped)})"
    print(msg)


if __name__ == "__main__":
    main()
