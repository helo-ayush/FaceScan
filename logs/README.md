# Anti-spoof calibration captures

On-device `logcat` captures of the liveness fusion, Aug 2026. These are the evidence behind
the `CALIBRATION` table in `LivenessFusion.kt`; without them
`scripts/calibrate_anti_spoof.py` has nothing to fit or verify against.

Contents are numeric cue scores only — no images and no identity.

## Conditions

| file | class | what it is |
|---|---|---|
| `genuine_bright.txt` | real | real face, bright room |
| `genuine_indoor.txt` | real | real face, normal indoor light |
| `genuine_dim.txt` | real | real face, dim room — **the known unfixed case** |
| `m_genuine.txt` | real | real face, handheld, longer session |
| `replay_30cm.txt` | attack | phone screen held ~30 cm from the camera |
| `replay_50cm.txt` | attack | phone screen at ~50 cm |
| `replay_angled.txt` | attack | phone screen at an angle |
| `m_replay.txt` | attack | **the attack that actually defeats the app** — a live PC webcam feed shown on a laptop display, close up, ±45°, side-lit |

`m_replay` is the one that matters. The other three attacks are easier and were already
mostly held; `m_replay` is what the user could reproduce by hand, and it is the condition
the v1 calibration was chosen against.

## Reproducing the numbers

```bash
python scripts/calibrate_anti_spoof.py --dir logs
```

This replays the SPRT accumulator offline and first checks itself against the logged
`FUSION | total=` on every file — so if the script and the device have drifted apart, it
says so before reporting any rates. Useful flags: `--search` (fit a table),
`--gate-sweep` (quality-gate limits), `--strictness STRICT`.

Note the captures were recorded under the **2026-08-18** calibration, which is why
`CALIBRATION_HISTORY` in that script keeps old revisions: the fidelity check matches each
file against the table it was recorded under, while the reported rates use the current one.

## Re-capturing

```bash
adb logcat -c ; adb logcat -s FaceAntiSpoof:D -v time > logs/genuine_bright.txt
```

PowerShell writes UTF-16LE with a BOM; `read_text()` in the script handles that, but the
tracked copies here are converted to UTF-8 so git can diff them.

One protocol detail that is easy to get wrong: `FacePipeline` stops sampling once liveness
is confirmed, so standing in front of the camera for two minutes yields only a handful of
scored frames. Cover and uncover the camera between attempts to re-arm it.
