# Third-party notices

## MMDAgent-EX

The behaviour of this software (the FST runner, the Plugin_Remote protocol, `MODEL_BINDBONE` / `MODEL_BINDFACE`, the
`.shapemap` and `.csv` model files, rendering and physics settings) follows MMDAgent-EX. The JavaScript code was written for
this project from reading the MMDAgent-EX sources; constants such as the face smearing rate (`SMEARINGRATEFACE`) and the
Bullet physics parameters come from them.

- Project: <https://github.com/mmdagent-ex/MMDAgent-EX>
- License: Apache License 2.0
- Copyright 2022-2023 Nagoya Institute of Technology
- MMDAgent-derived parts: Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
  (MMDAgent Project Team), BSD 3-Clause ([LICENSES/MMDAgent-BSD-3-Clause.txt](LICENSES/MMDAgent-BSD-3-Clause.txt))

The ports cover Plugin_VIManager (FST), Library_MMDFiles MotionManager / MotionController / VMD (motions and Bézier
tables), PMDModel / PMDBone (bone update order), Library_MMDAgent BoneFaceControl, LipSync, Render (camera),
CameraController, PMDObject (placement), Plugin_Remote (protocol, Avatar, Speak), Plugin_Variables, Plugin_Audio,
Plugin_TextArea and Plugin_LookAt (BoneController).

`appdata/lip.txt` and `appdata/default.shapemap` are copied unchanged from `Release/AppData/` of MMDAgent-EX
(Apache License 2.0).

## Julius — `julius/dist/`, `appdata/julius/`

`julius/dist/julius.wasm` is Julius 4.6 (with the libfvad patch) as bundled in MMDAgent-EX's `Library_Julius`, built
with Emscripten by `julius/build.sh`. `appdata/julius/` holds MMDAgent-EX's phoneme recognition setting
(`jconf_phone.txt`, `phoneseq/`, including the `super_mono128.binhmm` acoustic model) from `Release/AppData/Julius`.

- Project: <https://github.com/julius-speech/julius>
- License: BSD 3-Clause ([appdata/julius/LICENSE-Julius.txt](appdata/julius/LICENSE-Julius.txt))
- Copyright (c) 1991-2020 Kawahara Lab., Kyoto University; (c) 1997-2000 Information-technology Promotion Agency, Japan;
  (c) 2000-2005 Shikano Lab., Nara Institute of Science and Technology; (c) 2005-2020 Julius project team, Nagoya
  Institute of Technology
- libfvad (in the Julius source): BSD 3-Clause, Copyright (c) 2011 The WebRTC project authors, (c) 2016 Daniel Pirch
  ([appdata/julius/LICENSE-libfvad.txt](appdata/julius/LICENSE-libfvad.txt))
- zlib (linked by Emscripten): zlib License

## three.js (r160) — `vendor/three/`

- Project: <https://github.com/mrdoob/three.js>
- License: MIT ([vendor/three/LICENSE](vendor/three/LICENSE))
- Copyright © 2010-2023 three.js authors

Includes, under `vendor/three/examples/jsm/`:

- `libs/mmdparser.module.js` — mmd-parser by Takahiro (<https://github.com/takahirox/mmd-parser>), MIT License.
- `libs/ammo.wasm.js`, `libs/ammo.wasm.wasm` — Ammo.js (<https://github.com/kripken/ammo.js>), a port of the Bullet Physics
  library. zlib License. Bullet Physics: Copyright (c) 2003-2014 Erwin Coumans.
