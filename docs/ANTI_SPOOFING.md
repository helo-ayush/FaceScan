# Multi-Cue Anti-Spoofing & Liveness Detection (PAD)

This document provides a comprehensive technical breakdown of the presentation attack detection (PAD) architecture in **FaceScan**, including deep learning ensembles, 2D Fourier spatial frequency analysis, 3D parallax geometry, and Wald's Sequential Probability Ratio Test (SPRT).

---

## 1. Threat Models & Attack Surfaces

Biometric face scanners face three distinct categories of Presentation Attacks (PA):

```mermaid
graph TD
    Threats["Presentation Attack Threats"]
    
    subgraph PrintAttacks["1. 2D Print Attacks"]
        P1["Color laser prints on paper"]
        P2["High-gloss photo prints"]
        P3["Cutout eyes/mouth paper masks"]
    end
    
    subgraph ReplayAttacks["2. 2D Digital Screen Replay"]
        R1["Smartphone screen playback"]
        R2["Tablet / iPad video loops"]
        R3["Laptop display with room light specular reflections"]
    end
    
    subgraph ThreeDAttacks["3. 3D Masks & Mannequins"]
        M1["Rigid resin/plastic masks"]
        M2["Silicone organic masks"]
    end

    Threats --> PrintAttacks
    Threats --> ReplayAttacks
    Threats --> ThreeDAttacks
```

---

## 2. Dual-Scale MiniFASNet Neural Ensemble

FaceScan deploys two complementary deep convolutional neural networks based on the MiniVision MiniFASNet architecture:

```mermaid
graph TD
    subgraph ImageInput["Camera Frame (YUV / NV21)"]
        Raw["Input Frame"]
    end

    subgraph DualCrops["Multi-Scale Region Extraction"]
        Crop27["2.7x Face Crop (Tight Landmark Focus)"]
        Crop40["4.0x Wide Context Crop (Shoulders, Bezels & Hands)"]
    end

    subgraph DeepNetworks["Neural Models (TensorFlow Lite)"]
        V2["MiniFASNet V2 (80x80 BGR [0, 255])"]
        V1SE["MiniFASNet V1SE (80x80 BGR [0, 255] + Squeeze-and-Excitation)"]
    end

    subgraph Logits["Multi-Class Logit Outputs"]
        L2["Logits: [P_print, P_live, P_replay]"]
        L1["Logits: [P_print, P_live, P_replay]"]
    end

    subgraph SafetyEnsemble["Ensemble Decision Gate"]
        Gate["Attack Guard: if either model detects attack (≥0.25), take maxOf(v2, v1se)"]
        FusedScore["Fused Attack Probability (0.0 = Pure Live, 1.0 = Pure Attack)"]
    end

    Raw --> Crop27
    Raw --> Crop40
    Crop27 --> V2
    Crop40 --> V1SE
    V2 --> L2
    V1SE --> L1
    L2 --> Gate
    L1 --> Gate
    Gate --> FusedScore
```

### The `[0, 255]` Raw Byte Scale Contract
A critical discovery during model reverse-engineering: MiniFASNet models were trained directly on raw byte arrays $[0, 255]$ in BGR channel order.
- **The Trap**: Dividing pixels by $255.0$ (standard deep learning practice) compresses the input into $[0, 1]$, collapsing internal convolution activations and destroying the model's discriminative power ($p_{\text{live}}$ dynamic range collapses from **0.989** down to **0.003**).
- **FaceScan Guarantee**: Inputs are maintained strictly in $[0, 255]$ raw float representation, validated continuously by [`scripts/run_golden_tests.py`](file:///c:/Users/Ayush%20Kumar/Desktop/FaceC/scripts/run_golden_tests.py).

---

## 3. Physical Liveness Cues (Beyond Deep Learning)

To defeat sophisticated attacks that might fool a single neural network, FaceScan combines neural predictions with physical optical cues:

```mermaid
graph LR
    subgraph Cue1["1. 2D Fourier (FFT 64x64)"]
        FFT1["Radial Frequency Energy"]
        FFT2["Screen LCD Subpixel Lattice Peak"]
        FFT3["Moiré Fringe Pattern Detection"]
    end

    subgraph Cue2["2. 3D Parallax & Planarity"]
        PAR1["Homography vs Affine Residual"]
        PAR2["3D Depth Parallax Across Micro-Yaw"]
        PAR3["Flat Paper/Screen Rejection"]
    end

    subgraph Cue3["3. Optical Glare Guard"]
        GL1["Luminance Saturation (Luma ≥ 200)"]
        GL2["Contrast Variance Across Reflections"]
        GL3["Specular LCD Replay Gate"]
    end
```

### A. 2D Discrete Fast Fourier Transform (FFT 64x64)
LCD, OLED, and tablet screens feature microscopic RGB subpixel grids. When photographed by a camera, this grid produces high-frequency spatial periodicity (moiré fringes).
- The native pipeline computes a 2D FFT on a central $64 \times 64$ patch.
- Natural human skin exhibits smooth, decaying $1/f^\alpha$ power spectra.
- Digital displays show sharp, concentrated frequency peaks outside the organic skin power spectrum, instantly triggering spoof suspicion.

### B. 3D Parallax & Homography vs. Affine Residuals
Under natural micro-movements of the head (1° to 4° of yaw or pitch):
- A **flat 2D photo or laptop screen** can be modeled almost perfectly by a planar homography ($H \in \mathbb{R}^{3 \times 3}$). The residual reprojection error between the homography and an affine transformation is near zero ($\approx 0.00 \text{ px}$).
- A **genuine 3D human face** has prominent non-planar relief (nose bridge, eye sockets, cheekbones). When the head rotates even 2°, parallax creates substantial non-planar displacement ($> 0.38 \text{ px}$ residual), orders of magnitude above the planar floor.

---

## 4. Sequential Probability Ratio Test (SPRT)

Single-frame anti-spoof decisions are vulnerable to transient noise. FaceScan implements **Abraham Wald's Sequential Probability Ratio Test (SPRT)** in [`LivenessFusion.kt`](file:///c:/Users/Ayush%20Kumar/Desktop/FaceC/node_modules/react-native-face-detector-camera/android/src/main/java/com/facedetectorcamera/pipeline/LivenessFusion.kt).

```mermaid
graph TD
    subgraph Hypotheses["Hypothesis Formulation"]
        H0["H0: Subject is a Genuine Live Face"]
        H1["H1: Subject is a Presentation Attack (Spoof)"]
    end

    subgraph LogLikelihood["Log-Likelihood Ratio Accumulation"]
        Evidence["z_t = ln( P(score_t | H1) / P(score_t | H0) )"]
        Accumulator["Lambda_t = Lambda_{t-1} + z_t"]
    end

    subgraph Bounds["Wald Decision Boundaries"]
        AcceptBound["Accept Live Bound A (e.g. -2.0 nats)"]
        RejectBound["Reject Spoof Bound B (e.g. +3.0 nats)"]
        Continue["Continue Accumulating (INCONCLUSIVE)"]
    end

    H0 --> Evidence
    H1 --> Evidence
    Evidence --> Accumulator
    Accumulator --> Bounds

    Bounds -->|Lambda_t ≤ A| AcceptLive["VERDICT: LIVE (Accept Face)"]
    Bounds -->|Lambda_t ≥ B| RejectSpoof["VERDICT: SPOOF (Reject Attack)"]
    Bounds -->|A < Lambda_t < B| Continue
```

### Mathematical Formulation
For each frame $t$, the log-likelihood ratio $z_t$ is computed from the calibrated attack score relative to an adaptive centre $c$:

$$z_t \approx k \cdot (\text{score}_t - c)$$

where:
- When $\text{score}_t < c$, $z_t$ is negative, moving $\Lambda_t$ downward toward the **Live Accept Bound** ($A = -2.0$).
- When $\text{score}_t > c$, $z_t$ is positive, driving $\Lambda_t$ upward toward the **Spoof Reject Bound** ($B = +3.0$).

---

## 5. Edge-Case Engineering & Safety Gates

Real-world deployments encounter challenging conditions that standard algorithms fail on. FaceScan incorporates three mission-critical safeguards:

```mermaid
flowchart TD
    FrameInput["New Evaluated Frame"] --> CheckGlare{"Has Specular Glare? (Luma ≥ 200 on screen)"}
    
    CheckGlare -- "Yes" --> GlareRule["Tighten SPRT Centre to 0.23f & Disable Smoothing"]
    CheckGlare -- "No" --> CheckBacklit{"Backlit Frontal Face? (isBacklit & |yaw| < 8° & class=1)"}
    
    CheckBacklit -- "Yes" --> BacklitRule["Raise SPRT Centre to 0.30f (Prevent Shadow False Rejection)"]
    CheckBacklit -- "No" --> CheckDim{"Scene Truly Dim? (faceLuma < 75)"}
    
    CheckDim -- "Yes" --> DimRule["Apply Gentle Denoising (threshold = 5) & Centre = 0.28f"]
    CheckDim -- "No" --> StandardRule["Standard Operating Point (Centre = 0.25f)"]
    
    GlareRule --> ProcessSPRT["Accumulate into SPRT"]
    BacklitRule --> ProcessSPRT
    DimRule --> ProcessSPRT
    StandardRule --> ProcessSPRT
```

### 1. Laptop Screen Specular Glare Protection
- **Problem**: When a laptop screen reflects a desk lamp or ceiling light, the intense specular glare washes out LCD moiré lines in the reflection zone, causing naive filters to mistake the reflection for natural light on human skin.
- **Solution**: The `ScreenReflectionGuard` detects saturated pixels ($\text{luma} \ge 200$). If detected, bilateral denoising is immediately disabled, and the SPRT centre tightens from $0.25$ to **$0.23$**, firmly rejecting screen replays.

### 2. Backlit Frontal Face Verification
- **Problem**: In rooms with bright background windows or overhead backlights, deep shadows fall across the eye sockets and nose. When looking straight at the camera ($yaw \approx 0^\circ$), bilateral symmetry makes the face look like a dark 2D paper cutout, causing standard algorithms to stall.
- **Solution**: When `isBacklit && abs(yaw) < 8°` and MiniFASNet's primary classification is `LIVE (Class 1)`, the centre adapts to **$0.30$**, allowing the student to verify in 0.3 seconds.

### 3. Refined Gentle Denoising ($\text{threshold} = 5$)
- **Problem**: High-ISO sensor shot noise in dim rooms can degrade neural classification. However, standard bilateral filters (threshold $\ge 18$) blur out LCD subpixels, accidentally making screens look like smooth human skin.
- **Solution**: FaceScan uses a gentle bilateral range threshold of **$5$**. This eliminates $\pm 2$ sensor shot noise grain while preserving sharp screen grid lines.
