# osu!web

A browser port of osu!lazer, in TypeScript. It plays real `.osz` beatmaps in all four rulesets (osu!, osu!taiko, osu!catch, osu!mania) with no install.

This is a **port**, not a look-alike. The gameplay code is translated file by file from this repository's C# (`osu.Game`, `osu.Game.Rulesets.*`), keeping the same constants, algorithms and edge cases. Every ported file names the C# file it comes from. The ports are checked against lazer's own reference test data (see [Verification](#verification)).

## Why a TypeScript port rather than compiling the C#

osu!lazer runs on osu-framework, which depends on native libraries that have no browser builds:

| Native dependency | Used for | Web replacement here |
|---|---|---|
| BASS (closed source) | audio playback, sample mixing, tempo change | Web Audio API + `HTMLAudioElement` (`preservesPitch` for DT/HT) |
| Realm | the database | IndexedDB |
| SDL3 + Veldrid/OpenGL | windowing, input, rendering | DOM input events + Canvas 2D |

osu-framework also has no browser host. So the gameplay logic is translated, and only the platform layer (rendering, audio, input, storage, menus) is newly written.

## Running it

```bash
cd osu.Web
npm install
npm run dev        # http://localhost:5173
```

```bash
npm test           # unit + reference tests (reads lazer's C# test resources from this repo)
npm run build      # static site in osu.Web/dist
```

### Deploying

`.github/workflows/web.yml` tests and builds on pull requests, and deploys to GitHub Pages on pushes to `master`. To turn it on, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**. The build is a static site, so any static host works.

## What's ported

| Area | Ported from (C#) | Notes |
|---|---|---|
| `.osu` decoding | `LegacyBeatmapDecoder`, `LegacyDecoder`, `ConvertHitObjectParser`, `Parsing` | Includes the v<5 timing offset, sample banks, and stable's path-type quirks |
| Control points | `ControlPointInfo`, `TimingControlPoint`, `DifficultyControlPoint`, `EffectControlPoint`, `SampleControlPoint` | |
| Slider paths | osu-framework `PathApproximator`, `SliderPath`, `SliderEventGenerator`, `BarLineGenerator` | |
| Scoring | `ScoreProcessor` (standardised), `HitResult`, `HitWindows`, `DrainingHealthProcessor`, `AccumulatingHealthProcessor` | |
| osu! | `OsuBeatmapConverter`, `OsuBeatmapProcessor` (stacking), objects, `OsuHitWindows`, hit policy, `SliderInputManager`, spinner rotation, `OsuAutoGenerator`, `OsuScoreProcessor`, `OsuHealthProcessor` | |
| osu!taiko | converter, objects, hit windows, scoring/health, auto generator, scrolling | |
| osu!catch | converter + processor (LegacyRandom offsets, hyperdash), catcher, scoring/health, auto generator | |
| osu!mania | converter incl. every legacy pattern generator, hold notes, hit windows, scoring/health, auto generator, scroll algorithm, dual stages | |
| Difficulty / pp | `OsuDifficultyCalculator` + `OsuPerformanceCalculator`, `TaikoDifficultyCalculator`, `CatchDifficultyCalculator`, `ManiaDifficultyCalculator` | Current versions |
| Mods | EZ NF HT DC HR SD PF DT NC HD FI FL AC DA MR RD 1K–10K AT CN RX AP SO | Rate mods and DA are customisable |
| Replays | `LegacyScoreDecoder` / `LegacyScoreEncoder` (`.osr`), per-ruleset legacy frame conversion | Plays are recorded and can be watched back or exported. Stable `.osr` files can be imported. |
| Player | `Player`, `GameplayClockContainer`, break/skip/pause/fail overlays, `OsuResumeOverlay`, `ModEasyWithExtraLives`, epilepsy warning | |

Rendering and menus are new: a procedural, argon-inspired look drawn with Canvas 2D, and DOM menus (main menu, song select with search filters, mod select, settings with key binding, results with local leaderboards).

## Verification

The tests run lazer's reference data from this repository's C# test projects:

| Test | Source | Result |
|---|---|---|
| osu! conversion | `OsuBeatmapConversionTest` (14 maps) | all match |
| osu! star rating | `OsuDifficultyCalculatorTest` | within 1e-5 |
| osu!taiko conversion / star rating | `TaikoBeatmapConversionTest` (7) / `TaikoDifficultyCalculatorTest` | match |
| osu!catch conversion / star rating | `CatchBeatmapConversionTest` (37) / `CatchDifficultyCalculatorTest` | match |
| osu!mania conversion / star rating | `ManiaBeatmapConversionTest` (21) + sample conversion / `ManiaDifficultyCalculatorTest` | match |
| mania hold note input | `TestSceneHoldNoteInput` (20 cases) | match |
| taiko / mania scoring and health | `TaikoScoreProcessorTest`, `TaikoHealthProcessorTest`, `ManiaScoreProcessorTest`, `ManiaHealthProcessorTest` | match |
| replay decoding | `LegacyScoreDecoderTest` (stable taiko/mania `.osr` files) | match |

There are also end-to-end checks:
- autoplay scores 100% with nomod, DT, HR and HT;
- a replay gives identical judgements at 60 and 240 fps;
- a recorded play and its replay produce the same score in the browser.

## Not ported (yet)

- **Online features** (login, online leaderboards, beatmap downloads, multiplayer, spectating, chat): these need the osu! API, which requires registered OAuth clients and doesn't allow cross-origin browser requests.
- **The beatmap editor and the tournament client.**
- **Fun mods** (Wind Up, Transform, Wiggle, …) and some ruleset conversion mods (Classic, Swap, Constant Speed, Single Tap, …).
- **Some visual details:** lazer's shader effects (e.g. triangles inside taiko notes) are approximated.

## Assets and licence

The code is MIT licensed, like osu!lazer. osu!'s official resources (`osu.Game.Resources`: textures, hitsounds, fonts) are CC-BY-NC and are **not** included. Default hitsounds are synthesised at startup, everything is drawn procedurally, and the built-in demo song and maps are generated in code. osu! is a trademark of ppy Pty Ltd.
