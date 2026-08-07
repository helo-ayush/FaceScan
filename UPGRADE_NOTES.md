# Model Upgrade: MobileFaceNet 192-dim → ArcFace `w600k_mbf` 512-dim

## What changed

The recognizer is now **ArcFace `w600k_mbf`** (512-dim, from InsightFace's
`buffalo_sc` pack), and — more importantly — the face crop now uses ArcFace's
own alignment template.

| | before | after |
|---|---|---|
| model | MobileFaceNet v2, 192-dim | ArcFace `w600k_mbf`, 512-dim |
| asset size | ~5 MB | 13.6 MB |
| eye distance in crop | 46 px | 35.2 px |
| eye row in crop | y = 43 | y = 51.6 |
| input scaling | `(x-127.5)/128.0` | `(x-127.5)/127.5` |

### The alignment fix mattered more than the model

ArcFace is trained through InsightFace's `norm_crop`, which warps every face onto
one exact geometry. The pipeline was still using the old MobileFaceNet template —
roughly 30% too zoomed in and 9 px too high. That is an input-distribution shift,
and ArcFace degrades sharply under it. Swapping models without fixing the
template would have kept the poor separation.

Channel order is RGB. This is not cosmetic: feeding BGR costs about 0.19 cosine
on a genuine pair. The `/128.0` → `/127.5` change is numerically irrelevant
(0.999986 cosine) and was made only to match the reference exactly.

### A ResNet50 variant was evaluated and rejected

`w600k_r50` (the recognizer shared by `buffalo_l` and `buffalo_m`) was converted
and tested first. It ran at roughly **1.2 s per frame** on device — unusable.
Note that `buffalo_m` and `buffalo_l` contain the *same* recognizer and differ
only in their detector, which this project does not use because ML Kit handles
detection. There is no mid-tier option: it is 13.6 MB or 174 MB.

## Results

Measured on a two-subject calibration recording (2042 comparisons, both
subjects, all three poses, deliberately varied and uneven lighting):

| | old pipeline | new pipeline |
|---|---|---|
| genuine min | 0.566 | **0.717** |
| genuine median | 0.902 | 0.831 |
| impostor median | 0.643 | **0.428** |
| impostor max | 0.826 | **0.515** |
| separation | **−0.035** (overlapping) | **+0.202** (no overlap) |

The distributions no longer overlap. The worst genuine frame beats the best
impostor frame by 0.202, and no wrong person ranked first in any frame. On the
old pipeline the two overlapped and only the margin test prevented false
accepts; separation is now structural.

At the current thresholds, all 1021 frames were accepted correctly with zero
false accepts and zero rejections.

## Breaking change: all enrollments must be redone

Embeddings from two different models are unrelated vectors. The same face
through `w600k_mbf` and `w600k_r50` scores **−0.015** cosine — no better than
two strangers.

**Dimension count is not a safe check for this.** The `r50` → `mbf` migration
kept 512 dims, so the old length-mismatch guard would have silently accepted
stale templates and left those students permanently unrecognizable with no error
anywhere. Students now carry an `embeddingModel` tag instead:

- `server/index.js` defines `EMBEDDING_MODEL` and stamps it at enrollment.
- `GET /api/students` blanks the templates of any student whose tag does not
  match and sets `needsReEnrollment`, so they stay visible in the roster rather
  than failing quietly.

Bump `EMBEDDING_MODEL` whenever the `.tflite` asset changes.

### How to delete enrollments

**Via the app:** go to each student and tap delete.

**Bulk, via the server API:**

```bash
curl -X DELETE http://YOUR_SERVER:5000/api/students/ENROLLMENT_NUMBER
```

**Nuclear, wipes every student:**

```bash
mongosh --eval 'db.getSiblingDB("facescan").students.deleteMany({})'
```

## Thresholds

Set in `utils/faceMatching.ts` from the measurements above:

| | value | reasoning |
|---|---|---|
| `acceptSimilarity` | 0.66 | keeps 100% of measured genuine frames (worst was 0.717) while clearing the extrapolated stranger ceiling for a full class |
| `marginOverRunnerUp` | 0.15 | well below the smallest measured margin (0.263), which came from a two-person roster and will compress as the class grows |
| `displayFullConfidence` | 0.76 | genuine 5th percentile; the on-screen percentage saturates here |

### Why the floor is 0.66 and not the midpoint of the measured gap

The obvious choice is the midpoint of the observed gap between the best impostor
(0.515) and the worst genuine frame (0.717), which is 0.62. That understates the
risk, because **the impostor ceiling grows with roster size**. The calibration
recording had two people, so a stranger got one draw at resembling someone
enrolled; in a class of 40 they get 40 draws.

Extrapolating the measured impostor tail (mean 0.426, sd 0.049):

| roster | typical stranger max | 1-in-100 bad case |
|---|---|---|
| 2 (as recorded) | 0.446 | 0.551 |
| 40 | 0.512 | 0.595 |
| 100 | 0.539 | 0.606 |

A floor of 0.62 clears the 40-person bad case by only 0.025. At 0.66 the margin
is 0.065, and — critically — it is free: every floor up to 0.70 keeps 100% of the
measured genuine frames, because the genuine minimum is 0.717.

It is not pushed to 0.70 because that leaves only 0.017 below the worst measured
genuine frame. Uneven lighting is what drives genuine scores down, and 0.66
retains 0.057 of buffer for lighting worse than has been tested.

Note that these impostor figures come from a sibling pair — the hardest realistic
case — so they are conservative for unrelated strangers.

### The floor is not what stops a sibling

`acceptSimilarity` guards against people who are **not enrolled**. It does
nothing against the wrong *enrolled* person: a sibling scanning their own face
clears any floor legitimately. `marginOverRunnerUp` is what prevents them being
matched to someone else, and it is the threshold to revisit as the roster grows —
with a full class the runner-up is the nearest of many rather than the nearest of
one, so margins compress.

### The on-screen percentage was recalibrated

It previously scaled cosine against a perfect 1.0. ArcFace genuine pairs top out
around 0.89, so 1.0 is unreachable and every correct match displayed as
mediocre — a solid frame read 82%, and a dimly lit but perfectly safe one read
53%, which looks like a near-miss when it is actually 0.202 clear of the best
impostor. The scale now runs from `acceptSimilarity` to `displayFullConfidence`.

A well-separated system should show mostly 100% for the right person and 0% for
everyone else. That is what clean separation looks like on a confidence readout,
not a broken bar. Use the calibration panel when the raw cosine is needed.

## Recalibrating

Record a session per person from the in-app Calibration panel, export the CSV,
then:

```bash
node scripts/analyze-calibration.js path/to/data.csv
```

Include at least one person who is *not* enrolled — ideally the lookalike you are
worried about, since the margin threshold is calibrated off impostor near-misses.

Re-run after any change to the embedding model, the alignment template, or
enrollment. Thresholds do not survive those changes: each model puts genuine and
impostor scores on its own scale.

## What's unchanged

- Input format: NHWC `[1,112,112,3]`
- L2-normalization: still done in the native stage
- Alignment is still 2-point (eyes only) — only the target template moved
- The JS scoring logic, consensus window, and quality gates

## Known issue

`w600k_mbf` runs about 131 ms in TFLite versus 5.8 ms for the same model in
ONNX — a roughly 125 ms fixed overhead, most likely the 34 unfused `PRELU` ops
in the converted graph. Worth attacking if the phone feels sluggish, but it is
already far better than the 1.2 s ResNet50 path.
