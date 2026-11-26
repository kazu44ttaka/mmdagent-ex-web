[English](README.md) | [日本語](README_JP.md)

# MMDAgent-EX Web

Runs [MMDAgent-EX](https://github.com/mmdagent-ex/MMDAgent-EX) content (`.mdf`, `.fst`, `.pmd` / `.pmx`, `.vmd`) in a web
browser, and connects to a Plugin_Remote WebSocket server the same way MMDAgent-EX does. Applications that drive an
MMDAgent-EX avatar over Plugin_Remote, such as [MaAI-SDS](https://github.com/MaAI-Kyoto/MaAI-SDS), can show the avatar
in a browser instead.

The engine parts are ported from the MMDAgent-EX sources: the FST runner (Plugin_VIManager), the motion system
(MotionManager / MotionController with VMD Bézier tables), bone update order, bindings, lip sync motions, camera,
movement, and the Plugin_Remote protocol. Everything runs in the browser; the content folder you pick is read locally
and is not uploaded anywhere.

## Setup

You need Chrome or Edge, Git, and an HTTP server for the page (Python's `http.server` below; any static server works).
MMDAgent-EX itself is not needed.

```sh
# 1. this repository
git clone https://github.com/kazu44ttaka/mmdagent-ex-web.git

# 2. content to show: the official example collection (the Gene and Uka avatars are submodules, so use --recursive; about 470 MB)
git clone --recursive https://github.com/mmdagent-ex/example
```

The page uses ES modules, so serve it over HTTP (not as a `file://` page):

```sh
cd mmdagent-ex-web
python -m http.server 8000
```

## Usage

Open <http://localhost:8000> in Chrome or Edge, then:

1. **Content**: choose (or drop) an MMDAgent-EX content folder (the `example` cloned above), pick an `.mdf`, and press
   「開始」 (Start). Files the `.mdf` reaches through paths like `../gene/...` are read too, so choose the whole content
   folder, not the folder holding the `.mdf`.
   The FST with the same name as the `.mdf` and its sub FSTs start running, as in MMDAgent-EX.
2. **Connection**: press 「接続」 (Connect). The address comes from `Plugin_Remote_Websocket_Host`, `_Port` and `_Directory`
   in the `.mdf` (for `example_websocket.mdf`: `ws://localhost:9001/chat`) and can be edited. Like Plugin_Remote, the page
   keeps retrying until the server is up.

Click the 3D view once if the browser has blocked audio playback. Mouse drag rotates the view, right drag (or Shift)
moves it, and the wheel changes the distance, as in MMDAgent-EX.

### With MaAI-SDS

1. Copy the `assets/mmdagent/maai_sds` folder of MaAI-SDS into the example collection (`example/maai_sds`).
2. In MaAI-SDS, set 「アバターの表示先」 (avatar display) in 「MMDAgent-EX起動設定」 to 「ブラウザ（MMDAgent-EX Web）」. MaAI-SDS
   then does not start MMDAgent-EX and listens on `ws://localhost:9001/chat` (the port can be changed there).
3. On this page, choose `example`, start `example/maai_sds/maai_sds_web.mdf`, and press 「接続」 (Connect).
4. Start a voice dialogue in MaAI-SDS: Gene speaks (lip sync by Julius), nods and blinks.

## What works

| Area | Supported |
|---|---|
| Content | `.mdf` settings (camera, light, cartoon rendering, edge width, projection shadow / shadow mapping, physics, stage size, `max_num_model`, `lipsync_priority`, `show_fps`), the FST of the same name and its sub FSTs, `%INCLUDE`, variables, `$a==b` tests, `@regexp@` inputs |
| Models | `MODEL_ADD` (several models, position / rotation, cartoon ON/OFF, attaching to another model's bone), `MODEL_CHANGE`, `MODEL_CHANGE_ASYNC`, `MODEL_DELETE` (fade out, attached models too), `<model>.shapemap` or the system `default.shapemap`, `<model>.lip`, `<model>.csv` (material opacity), `<model>.loadmessage` / `.deletemessage`, PMD bone types (IK, under-rotate, follow-rotate) |
| Motions | `MOTION_ADD` (priority, `FULL` / `PART`, `ONCE` / `LOOP`, smooth start / loop / end, re-position), `MOTION_CHANGE`, `MOTION_RESET`, `MOTION_ACCELERATE`, `MOTION_CONFIGURE` (replace / add / multiply modes, blend rate), `MOTION_DELETE`, VMD IK and display switches, `LIPSYNC_START` / `LIPSYNC_STOP` (lip.txt) |
| Placement | `MOVE_START` / `MOVE_STOP`, `TURN_START` / `TURN_STOP`, `ROTATE_START` / `ROTATE_STOP` (local / global, speed) |
| Scene | `STAGE` (floor and background images, or a 3D stage model), `CAMERA` (view, timed move, following a bone, camera VMD), `LIGHTCOLOR`, `LIGHTDIRECTION` |
| Control | `KEYVALUE_SET`, `MODEL_BINDBONE`, `MODEL_BINDFACE`, `MODEL_UNBINDBONE`, `MODEL_UNBINDFACE`, `OPEN_CONTENT`, `HOME_SET` / `HOME_CLEAR`, `MOTIONCAPTURE_START` / `STOP` (the VMD is downloaded), `REMOTEKEY_CHAR`, `PLUGIN_ENABLE` / `PLUGIN_DISABLE` |
| On screen | `MENU`, `PROMPT_SHOW`, `INFOTEXT_STRING` / `INFOTEXT_FILE`, `CAPTION_SETSTYLE` / `CAPTION_START` / `CAPTION_STOP`, `BUTTON_ADD` / `BUTTON_DELETE`, `WINDOWFRAME*`, `WINDOWOVERLAY*` |
| Plugins | VIManager, Remote, Variables (`VALUE_*`, `TIMER_*`), Audio (`SOUND_START` / `SOUND_STOP`, lip sync from `.lab`), TextArea (`TEXTAREA_*`), LookAt (`l` key) |
| Plugin_Remote | text messages, `__AV_MESSAGE`, `__AV_START`, `__AV_END`, `__AV_SETMODEL`, `__AV_EXMORPH`, `__AV_ACTION`, `__AVCONF_DISABLEAUTOLIP`, speech audio (`SND` + 4-digit length, 16 kHz 16-bit mono; `SNDSTRM`, `SNDFILE`, `SNDBRKS`), `SPEAK_START` / `SPEAK_STOP`, `AVATAR_CONTROL`, `AVATAR_EVENT_IDLE` |
| Speech | `SYNTH_START` / `SYNTH_STOP` and `RECOG_EVENT_START` / `RECOG_EVENT_STOP` through the browser's Web Speech API (turn the microphone on in the panel) |
| Events | the events of all of the above, `KEY`, `MODEL_EVENT_SELECT` (double-click a model), `REMOTE_EVENT_CONNECTED` / `DISCONNECTED` |
| Keys | `f` full screen, `s` info, `+` / `-` distance, arrows rotate (Shift: move), `S` shadow, `x` shadow mapping, `k` / `K` edge, `p` physics, `w` wireframe, `/` menu, `R` reload, `l` LookAt |

Every message inside the page (commands, events, and the ones received) is also sent back to the WebSocket server, as
Plugin_Remote does.

### Differences from MMDAgent-EX

- **Lip sync from received speech** works as in MMDAgent-EX: Julius (the copy bundled with MMDAgent-EX, built to
  WebAssembly) recognises phonemes with the same model and settings, and the mouth follows the same table and easing.
  Only if Julius cannot start (for example, opened as `file://`) is the shape estimated from the loudness instead.
- **Speech synthesis and recognition**: the browser's voices and recognizer stand in for Open_JTalk / Flite and Julius.
  The browser gives no phoneme timing, so `SYNTH_START` moves the mouth in an even pattern, and Julius-specific events
  (`RECOG_EVENT_MODIFY`, `_GMM`, `_AWAY`, `_OVERFLOW`, `_RAPID`) do not occur.
- **Rendering**: drawn with three.js, so the look is close but not pixel-identical. PMX bone / material / UV morphs, the
  PMX layered bone order and local grants, `doppel_shadow`, the diffusion post-filter, `light_edge` and
  `cartoon_edge_selected_color` are not applied. On-screen parts are HTML in MMDAgent-EX's colours, and `BUTTON_ADD`
  coordinates are approximate.
- **Not available in a browser**: `TRANSPARENT_*`, `REMOTEKEY_DOWN` / `UP`, `RECOG_RECORD_*`, `LOG_UPLOAD`,
  `AVATAR_LOGSAVE_*`, animated textures (`TEXTURE_SETANIMATIONRATE`), the built-in HTTP server, and the AnyScript,
  Network, Kafka, RabbitMQ and WindowController plugins. Their messages still reach the FSTs and the server.

## Development

```sh
npm test   # node --test (Node.js 20 or later); no packages to install
```

| File | Role |
|---|---|
| `src/app.js` | page, message queue, plugin wiring |
| `src/core.js` | MMDAgent-EX core commands and the per-step scene update |
| `src/model.js` | one model: pose, bone update order, placement, physics |
| `src/motion.js`, `src/vmd.js` | MotionManager / MotionController, VMD reading |
| `src/camera.js` | camera (Render / CameraController) |
| `src/fst.js` | FST loader and runner (Plugin_VIManager) |
| `src/protocol.js`, `src/avatar.js`, `src/julius-lip.js`, `src/julius-worker.js` | Plugin_Remote stream, avatar control, Julius lip sync |
| `julius/` | `jw.c` (Julius A/D-in and result hooks) and `build.sh`; `dist/` holds the built `julius.js` / `julius.wasm` |
| `src/bindings.js`, `src/lipsync-motion.js` | KeyValue and bindings, LIPSYNC motions |
| `src/plugins.js`, `src/speech.js`, `src/ui.js`, `src/system.js` | plugins, Web Speech, on-screen parts, other commands |
| `src/viewer.js` | three.js rendering, stage, shadows, shared physics world |

three.js r160 and Ammo.js are bundled in `vendor/`, and `appdata/` holds MMDAgent-EX's `lip.txt`, `default.shapemap`
and Julius phoneme model, so the page works offline. To rebuild Julius, install [emsdk](https://emscripten.org/) and run
`julius/build.sh <MMDAgent-EX source folder>`.

## License

[Apache License 2.0](LICENSE). Most of the code is translated to JavaScript from MMDAgent-EX
(Copyright 2022-2023 Nagoya Institute of Technology, Apache License 2.0); files ported from its MMDAgent-derived parts
also carry the MMDAgent notice (Copyright (c) 2009-2016 Nagoya Institute of Technology, BSD 3-Clause,
[LICENSES/MMDAgent-BSD-3-Clause.txt](LICENSES/MMDAgent-BSD-3-Clause.txt)). Each ported file names its sources; see
[NOTICE](NOTICE). Bundled libraries and files keep their own licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Published with the permission of the MMDAgent-EX developers. The avatars and motions of MMDAgent-EX content have their own
terms (for example, Gene is CC BY 4.0 with trademark and design rights held by Nagoya Institute of Technology); follow the
terms of the content you use.
