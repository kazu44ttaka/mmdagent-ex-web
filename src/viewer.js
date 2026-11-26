/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDAgent/src/lib/Render.cpp
 *   Library_MMDAgent/src/lib/Stage.cpp
 *   Library_MMDAgent/src/lib/KeyHandler.cpp
 *   Library_MMDFiles/src/lib/PMDMaterial.cpp
 *   Library_MMDFiles/src/lib/PMDRigidBody.cpp
 *   Library_MMDFiles/src/lib/PMDConstraint.cpp
 *   Library_MMDFiles/src/lib/BulletPhysics.cpp
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * three.js side of the stage: renderer, light, floor / background, models'
 * meshes, projection shadows, shared Bullet world, and the camera. The frame
 * timing follows MMDAgent::updateScene: the world advances in fixed steps of
 * 30 / bullet_fps frames, and the caller updates motions in `onStep`.
 */

import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { mdfBool, mdfFloat, mdfVec } from './mdf.js';
import { CameraState } from './camera.js';
import { EDGE_OFFSET_SCALE, materialLooks, vertexEdgeRates, lightTerms } from './material-looks.js';
import {
  createModelUniforms, setModelLight, createSurfaceMaterial, createEdgeMaterial, createStageMaterial, imageHasAlpha,
} from './look.js';

// OpenGL mixes colours as stored; so do the shaders here (no sRGB decode / encode)
THREE.ColorManagement.enabled = false;
const SYSTEM_TOON_DIR = './appdata/toon/';

// ammo.wasm.js fetches ammo.wasm.wasm from its own folder, so both ship in vendor/.
const AMMO_SCRIPT = './vendor/three/examples/jsm/libs/ammo.wasm.js';
// generous: the first render can keep the main thread busy compiling shaders
const AMMO_TIMEOUT_MS = 30000;
/** Prefix of model / motion paths handed to the loader; the URL modifier maps them to files. */
export const VFS_PREFIX = 'mmdvfs/';
const NEAR = 0.5; // RENDER_VIEWPOINTFRUSTUMNEAR
const FAR = 500.0; // RENDER_VIEWPOINTFRUSTUMFAR

let ammoPromise = null;

function loadAmmo() {
  if (window.Ammo && window.Ammo.btVector3) return Promise.resolve(window.Ammo);
  if (ammoPromise) return ammoPromise;
  ammoPromise = new Promise((resolve, reject) => {
    const boot = (factory) => {
      if (factory && factory.btVector3) {
        resolve(factory);
        return;
      }
      if (typeof factory !== 'function') {
        reject(new Error('Ammo factory missing'));
        return;
      }
      Promise.resolve(factory()).then(() => {
        if (!window.Ammo?.btVector3) reject(new Error('Ammo wasm init failed'));
        else resolve(window.Ammo);
      }).catch(reject);
    };
    const existing = window.Ammo;
    if (typeof existing === 'function' || existing?.btVector3) {
      boot(existing);
      return;
    }
    const script = document.createElement('script');
    script.src = AMMO_SCRIPT;
    script.async = true;
    script.onload = () => boot(window.Ammo);
    script.onerror = () => reject(new Error(`failed to load ${AMMO_SCRIPT}`));
    document.head.appendChild(script);
  });
  return ammoPromise;
}

function createWebGLRenderer(antialias) {
  try {
    return new THREE.WebGLRenderer({
      antialias,
      alpha: false,
      stencil: true,
      depth: true,
      powerPreference: 'default',
      failIfMajorPerformanceCaveat: false,
    });
  } catch (err) {
    const wrapped = new Error(`WebGL を使えません。ほかのタブを閉じるか、ブラウザを再起動してください。(${err?.message || err})`);
    wrapped.cause = err;
    throw wrapped;
  }
}

/**
 * @typedef {{
 *   onLog?: (msg: string) => void,
 *   urlModifier?: (url: string) => string,
 *   onFrame?: (elapsedSec: number, fps: number) => void,
 *   onStep?: (frames: number) => void,
 *   onAfterSteps?: (frames: number) => void,
 * }} ViewerOptions
 */

/**
 * @param {HTMLElement} container
 * @param {ViewerOptions} [options]
 */
export function createViewer(container, options = {}) {
  const log = options.onLog || ((m) => console.log(m));
  /** @type {(url: string) => string} */
  let urlModifier = options.urlModifier || ((u) => u);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(16, 1, NEAR, FAR);
  camera.matrixAutoUpdate = false;
  const cam = new CameraState();

  const renderer = createWebGLRenderer(true);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth || 640, container.clientHeight || 480);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = false;
  renderer.shadowMap.type = THREE.BasicShadowMap;
  container.appendChild(renderer.domElement);

  // The shaders in look.js do the lighting; this light only renders the shadow map.
  const dir = new THREE.DirectionalLight(0xffffff, 1);
  dir.position.set(0.5, 1.0, 0.5);
  dir.shadow.camera.near = 0.1;
  dir.shadow.camera.far = 400;
  // around the default stage (25 × 25) and the models on it
  dir.shadow.camera.left = -30;
  dir.shadow.camera.right = 30;
  dir.shadow.camera.top = 30;
  dir.shadow.camera.bottom = -30;
  scene.add(dir);
  scene.add(dir.target);
  let lightIntensity = 0.6;
  let lightDir = [0.5, 1.0, 0.5];
  let likeMmd = true;
  let cartoonOn = true;
  let campusColor = [0, 0, 0.2];
  let stageSize = [25, 25, 40];
  let useShadow = true;
  let useShadowMapping = false;
  let shadowDensity = 0.5;
  let lightColor = [1, 1, 1];
  let edgeThin = 0.7;
  let edgeStep = 1.2;
  /** uniforms shared by every model and the stage */
  const look = {
    uLightDir: { value: new THREE.Vector3(0.5, 1.0, 0.5).normalize() },
    // Render::renderSceneShadowMap: light for the shadowed part of non-toon surfaces
    uDimLight: { value: 0.34 - 0.13 * 1.0 },
    uLightEdge: { value: 1 },
    uShadowOn: { value: 0 },
    uShadowMap: { value: null },
    uShadowMatrix: { value: dir.shadow.matrix },
    uShadowBias: { value: 0.002 },
    // PMDModel::updateShadowColorTexCoord: toon coordinate of the shadowed part
    uShadowToonV: { value: 1.0 },
  };

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => urlModifier(url));
  const loader = new MMDLoader(manager);
  const texLoader = new THREE.TextureLoader(manager);

  // physics
  let physicsWanted = true;
  let physicsReady = false;
  let bulletFloorOn = true;
  let gravityVec = new THREE.Vector3(0, -98, 0);
  let bulletHz = 120;
  /** @type {any} */
  let sharedWorld = null;
  let floorBody = null;
  let ammoScratch = null;

  /** @type {Set<import('./model.js').Model>} */
  const models = new Set();
  /** @type {THREE.Object3D[]} */
  const stageObjects = [];
  /** @type {THREE.SkinnedMesh | THREE.Mesh | null} */
  let stageModel = null;

  function resize() {
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 480;
    camera.aspect = w / h;
    renderer.setSize(w, h);
  }

  // ---------------------------------------------------------------- settings

  /** @param {Map<string, string>} mdf */
  function applyMdf(mdf) {
    campusColor = mdfVec(mdf, 'campus_color', [0, 0, 0.2]);
    scene.background = new THREE.Color(campusColor[0], campusColor[1], campusColor[2]);
    stageSize = mdfVec(mdf, 'stage_size', [25, 25, 40]);
    likeMmd = mdfBool(mdf, 'use_mmd_like_cartoon', true);
    cartoonOn = mdfBool(mdf, 'use_cartoon_rendering', true);
    lightIntensity = mdfFloat(mdf, 'light_intensity', 0.6);
    setLightColor(mdfVec(mdf, 'light_color', [1, 1, 1]));
    setLightDirection(mdfVec(mdf, 'light_direction', [0.5, 1.0, 0.5]));
    useShadow = mdfBool(mdf, 'use_shadow', true);
    useShadowMapping = mdfBool(mdf, 'use_shadow_mapping', false);
    shadowDensity = mdfFloat(mdf, 'shadow_density', 0.5);
    const selfDensity = mdfFloat(mdf, 'shadow_mapping_self_density', 1.0);
    look.uDimLight.value = 0.34 - 0.13 * selfDensity;
    look.uShadowToonV.value = selfDensity;
    const mapSize = Math.max(256, Math.round(mdfFloat(mdf, 'shadow_mapping_texture_size', 2048)));
    dir.shadow.mapSize.set(mapSize, mapSize);
    dir.shadow.map?.dispose();
    dir.shadow.map = null;
    setShadowMapping(useShadowMapping);
    edgeThin = mdfFloat(mdf, 'cartoon_edge_width', 0.7);
    edgeStep = mdfFloat(mdf, 'cartoon_edge_step', 1.2);
    look.uLightEdge.value = mdfBool(mdf, 'light_edge', true) ? 1 : 0;
    info.style.display = mdfBool(mdf, 'show_fps', true) ? '' : 'none';
    physicsWanted = true;
    bulletFloorOn = mdfBool(mdf, 'bullet_floor', true);
    gravityVec = new THREE.Vector3(0, -9.8 * mdfFloat(mdf, 'gravity_factor', 10), 0);
    bulletHz = Math.max(1, Math.round(mdfFloat(mdf, 'bullet_fps', 120)));
    cam.setView(
      mdfVec(mdf, 'camera_transition', [0, 13, 0]),
      mdfVec(mdf, 'camera_rotation', [0, 0, 0]),
      mdfFloat(mdf, 'camera_distance', 100),
      mdfFloat(mdf, 'camera_fovy', 16),
    );
    cam.setMoveTime(-1);
    cam.snap();
    rotateStep = mdfFloat(mdf, 'rotate_step', 4.5);
    translateStep = mdfFloat(mdf, 'translate_step', 0.5);
    distanceStep = mdfFloat(mdf, 'distance_step', 4.0);
    fovyStep = mdfFloat(mdf, 'fovy_step', 1.0);
    for (const m of models) updateShadowMesh(m);
    refreshLooks();
  }

  /** Toon flag of a model: cartoon rendering on, and not MODEL_ADD …|OFF. */
  function toonOf(model) {
    return cartoonOn && model?.cartoon !== false;
  }

  /** Render::updateLight for each model (toon models and others differ) and the stage. */
  function refreshLooks() {
    for (const m of models) refreshModelLook(m);
    if (stageModel?.userData.mmdLook) {
      setModelLight(stageModel.userData.mmdLook.uniforms, lightColor, lightTerms(likeMmd, cartoonOn, lightIntensity), cartoonOn);
    }
    const t = lightTerms(likeMmd, cartoonOn, lightIntensity);
    const l = new THREE.Vector3(...lightDir).normalize();
    for (const o of stageObjects) {
      const s = o.userData.mmdStage;
      if (!s) continue;
      const ndl = Math.max(0, s.normal.dot(l));
      const dim = look.uDimLight.value;
      s.lit.value.set(...lightColor.map((c) => Math.min(1, 0.2 + c * (t.a + t.d * ndl))));
      s.dim.value.setScalar(Math.min(1, 0.2 + dim + dim * ndl));
    }
  }

  /** @param {import('./model.js').Model} model */
  function refreshModelLook(model) {
    const data = model.mesh.userData.mmdLook;
    if (!data) return;
    const toon = toonOf(model);
    setModelLight(data.uniforms, lightColor, toon ? lightTerms(likeMmd, true, lightIntensity) : lightTerms(true, false, lightIntensity), toon);
    data.uniforms.uEdgeOffset.value = edgeThin * EDGE_OFFSET_SCALE;
    if (model.edgeMesh) model.edgeMesh.visible = toon;
  }

  /** LIGHTCOLOR @param {number[]} rgb */
  function setLightColor(rgb) {
    lightColor = [rgb[0], rgb[1], rgb[2]];
    refreshLooks();
  }

  /** LIGHTDIRECTION @param {number[]} v */
  function setLightDirection(v) {
    lightDir = [v[0], v[1], v[2]];
    look.uLightDir.value.set(v[0], v[1], v[2]).normalize();
    dir.position.set(v[0], v[1], v[2]).normalize().multiplyScalar(100);
    dir.target.position.set(0, 0, 0);
    for (const m of models) m.shadowUniform && m.shadowUniform.value.set(v[0], v[1], v[2]);
    refreshLooks();
  }

  /** use_shadow_mapping / the x key */
  function setShadowMapping(on) {
    useShadowMapping = on;
    renderer.shadowMap.enabled = on;
    dir.castShadow = on;
    look.uShadowOn.value = 0;
    for (const m of models) {
      updateShadowMesh(m);
      updateCasterMesh(m);
    }
  }

  // ------------------------------------------------------------------- stage

  function clearStage() {
    for (const o of stageObjects) {
      scene.remove(o);
      o.geometry?.dispose?.();
      o.material?.map?.dispose?.();
      o.material?.dispose?.();
    }
    stageObjects.length = 0;
    if (stageModel) {
      scene.remove(stageModel);
      stageModel = null;
    }
  }

  function loadTexture(url) {
    return new Promise((resolve, reject) => {
      texLoader.load(url, (tex) => {
        tex.colorSpace = THREE.NoColorSpace;
        resolve(tex);
      }, undefined, () => reject(new Error(`texture ${url}`)));
    });
  }

  /**
   * Floor and background quads (Stage::setSize): floor ±w × ±d at y = 0,
   * background at z = -d up to h, each texture drawn once.
   * @param {string | null} floorUrl
   * @param {string | null} backUrl
   */
  async function setStage(floorUrl, backUrl) {
    clearStage();
    const [w, d, h] = stageSize;
    const quad = async (url, a, b, c, e) => {
      if (!url) return;
      let tex;
      try {
        tex = await loadTexture(url);
      } catch (err) {
        log(`舞台の画像を読めません: ${err?.message || err}`);
        return;
      }
      const geo = new THREE.BufferGeometry();
      // vertices 0,1,3,2 as a strip in TileTexture::render, uv (0,1)(1,1)(0,0)(1,0)
      geo.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...e, ...c], 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
      geo.setIndex([0, 1, 2, 2, 1, 3]);
      geo.computeVertexNormals();
      // fixed-function lighting of a white material (refreshLooks)
      const n = new THREE.Vector3().crossVectors(new THREE.Vector3(...b).sub(new THREE.Vector3(...a)), new THREE.Vector3(...e).sub(new THREE.Vector3(...a))).normalize();
      const lit = { value: new THREE.Vector3(1, 1, 1) };
      const dim = { value: new THREE.Vector3(1, 1, 1) };
      const mesh = new THREE.Mesh(geo, createStageMaterial(tex, lit, dim, look));
      mesh.userData.mmdStage = { normal: n, lit, dim };
      mesh.renderOrder = -2;
      scene.add(mesh);
      stageObjects.push(mesh);
      refreshLooks();
    };
    await quad(floorUrl, [-w, 0, d], [w, 0, d], [w, 0, -d], [-w, 0, -d]);
    await quad(backUrl, [-w, 0, -d], [w, 0, -d], [w, h, -d], [-w, h, -d]);
  }

  /** STAGE|file.pmd: a 3D stage model. @param {string} path */
  async function setStageModel(path) {
    clearStage();
    const { mesh } = await loadMesh(path, null);
    stageModel = mesh;
    scene.add(mesh);
    refreshLooks();
  }

  // ------------------------------------------------------------------ models

  /** Texture settings of PMDTexture (no mip-maps, rows as stored, colours as stored). */
  function setupTexture(tex, wrap) {
    const apply = (t) => {
      t.flipY = false;
      t.colorSpace = THREE.NoColorSpace;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      t.wrapS = wrap;
      t.wrapT = wrap;
      t.needsUpdate = Boolean(t.image);
    };
    if (Array.isArray(tex.readyCallbacks)) tex.readyCallbacks.push(apply);
    else apply(tex);
    return tex;
  }

  /** Load a texture by virtual path; resolves once the image is there (or failed). */
  function loadModelTexture(path, wrap) {
    const tex = new THREE.Texture();
    tex.userData.ready = new Promise((resolve) => {
      texLoader.load(urlModifier(`${VFS_PREFIX}${path}`), (t) => {
        tex.image = t.image;
        setupTexture(tex, wrap);
        resolve(tex);
      }, undefined, () => {
        log(`テクスチャを読めません: ${path}`);
        resolve(null);
      });
    });
    setupTexture(tex, wrap);
    return tex;
  }

  /** Is this virtual path one of the picked files? */
  function hasFile(path) {
    const url = `${VFS_PREFIX}${path}`;
    return urlModifier(url) !== url;
  }

  /**
   * Toon textures 0-10 of a model (PMDModel_parse): a file next to the model
   * (toon0.bmp, or the name listed in the PMD), else the system one.
   */
  function modelToons(data, dirPath) {
    const toons = [];
    for (let j = 0; j <= 10; j += 1) {
      const sys = j === 0 ? 'toon0.bmp' : `toon${String(j).padStart(2, '0')}.bmp`;
      const listed = j > 0 ? data.toonTextures?.[j - 1]?.fileName : null;
      const local = `${dirPath}${listed || sys}`;
      if (hasFile(local)) toons.push(loadModelTexture(local, THREE.ClampToEdgeWrapping));
      else {
        const t = texLoader.load(`${SYSTEM_TOON_DIR}${sys}`);
        toons.push(setupTexture(t, THREE.ClampToEdgeWrapping));
      }
    }
    return toons;
  }

  /**
   * Parse and build a .pmd / .pmx with MMDAgent-EX's look; the parsed data is
   * kept for bone types.
   * @param {string} path virtual path for the URL modifier
   * @param {ReturnType<typeof import('./modelext.js').parseModelCsv> | null} csv "<model>.csv"
   * @returns {Promise<{ mesh: THREE.SkinnedMesh, data: any }>}
   */
  async function loadMesh(path, csv) {
    const url = `${VFS_PREFIX}${path}`;
    const res = await fetch(urlModifier(url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const parser = loader._getParser();
    const isPmx = path.toLowerCase().endsWith('.pmx');
    const data = isPmx ? parser.parsePmx(buffer, true) : parser.parsePmd(buffer, true);
    const resourcePath = url.slice(0, url.lastIndexOf('/') + 1);
    // three converts type-2 bodies under a simulated parent into type 1; MMDAgent-EX does not
    const mesh = loader.meshBuilder.setCrossOrigin(loader.crossOrigin).build(data, resourcePath, undefined, (err) => log(`テクスチャを読めません: ${err?.message || err}`));
    restoreNativeRigidBodyTypes(mesh);
    applyLook(mesh, data, isPmx, csv, path.slice(0, path.lastIndexOf('/') + 1));
    return { mesh, data };
  }

  /**
   * Replace three's MMD materials with MMDAgent-EX's (look.js) and keep what the
   * edge, shadow and material order need.
   */
  function applyLook(mesh, data, isPmx, csv, dirPath) {
    const built = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const { materials: looks, hasExt } = materialLooks(data, isPmx, csv);
    const toons = modelToons(data, dirPath);
    const uniforms = createModelUniforms(look);
    const sameFile = (a, b) => String(a || '').replace(/\\/g, '/').toLowerCase() === String(b || '').replace(/\\/g, '/').toLowerCase();
    const surfaces = looks.map((lk, i) => {
      const b = built[i] || {};
      let map = b.map || null;
      let sphere = b.matcap || null;
      let sphereAdd = b.matcapCombine === THREE.AddOperation;
      // PMDMaterial::setExtParam: textures named in the CSV
      const pmdNames = isPmx ? [] : String(data.materials[i].fileName || '').split('*');
      const pmdMain = pmdNames.find((n) => n && !/\.sp[ha]$/i.test(n)) || null;
      const pmdSphere = pmdNames.find((n) => /\.sp[ha]$/i.test(n)) || null;
      if (lk.tex && !sameFile(lk.tex, pmdMain)) map = loadModelTexture(`${dirPath}${lk.tex}`, THREE.RepeatWrapping);
      if (lk.sphere && (lk.sphereMode === 1 || lk.sphereMode === 2)) {
        if (!sameFile(lk.sphere, pmdSphere)) sphere = loadModelTexture(`${dirPath}${lk.sphere}`, THREE.RepeatWrapping);
        sphereAdd = lk.sphereMode === 2;
      }
      if (map && map === b.map) setupTexture(map, THREE.RepeatWrapping);
      if (sphere && sphere === b.matcap) setupTexture(sphere, THREE.RepeatWrapping);
      let toon = toons[0];
      if (isPmx) {
        const m = data.materials[i];
        if (m.toonFlag === 1 && m.toonIndex >= 0 && m.toonIndex < 10) toon = toons[m.toonIndex + 1];
        else if (m.toonFlag === 0 && m.toonIndex >= 0 && data.textures?.[m.toonIndex]) toon = loadModelTexture(`${dirPath}${data.textures[m.toonIndex]}`, THREE.ClampToEdgeWrapping);
      } else if (lk.toonIndex >= 0 && lk.toonIndex < 10) {
        toon = toons[lk.toonIndex + 1];
      }
      const toonId = toon === toons[0] ? 0 : 1;
      // Render::renderSceneShadowMap: toon0 when the material takes no self shadow
      const toonShadow = !lk.shadowMapRender ? toons[0] : toonId === 0 ? toons[1] : toon;
      const mat = createSurfaceMaterial(lk, { map, sphere, sphereAdd, toon, toonShadow }, uniforms);
      mat.opacity = lk.alpha;
      mat.transparent = lk.alpha < 0.98;
      mat.name = b.name || lk.name || '';
      // PMDModel::updateMaterialOrder: textures with transparent pixels are drawn after the opaque ones
      const checkAlpha = (t) => {
        if (t?.image && imageHasAlpha(t.image)) {
          mat.userData.mmd.translucent = true;
          mat.transparent = true;
        }
      };
      if (map) {
        if (Array.isArray(map.readyCallbacks)) map.readyCallbacks.push(checkAlpha);
        else if (map.userData.ready) map.userData.ready.then(checkAlpha);
        else checkAlpha(map);
      }
      b.dispose?.();
      return mat;
    });
    mesh.material = surfaces;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const rates = vertexEdgeRates(data, isPmx, looks, csv?.vertexEdge);
    mesh.geometry.setAttribute('edgeRate', new THREE.BufferAttribute(rates, 1));
    mesh.userData.mmdLook = { looks, hasExt, uniforms, centers: materialCenters(mesh.geometry) };
  }

  /** Centre and radius of each material group in the rest pose (PMDMaterial::computeCenterVertex). */
  function materialCenters(geometry) {
    const pos = geometry.getAttribute('position');
    const index = geometry.getIndex();
    return geometry.groups.map((g) => {
      const c = new THREE.Vector3();
      const v = new THREE.Vector3();
      const n = Math.max(1, g.count);
      for (let k = g.start; k < g.start + g.count; k += 1) c.add(v.fromBufferAttribute(pos, index ? index.getX(k) : k));
      c.divideScalar(n);
      let r = 0;
      for (let k = g.start; k < g.start + g.count; k += 1) r = Math.max(r, v.fromBufferAttribute(pos, index ? index.getX(k) : k).distanceTo(c));
      return { materialIndex: g.materialIndex, center: c, radius: r };
    });
  }

  const tmpMat = new THREE.Matrix4();
  const tmpVec = new THREE.Vector3();
  /**
   * PMDModel::updateMaterialOrder: opaque materials first in file order, then the
   * others from far to near.
   * @param {THREE.SkinnedMesh} mesh
   */
  function sortMaterials(mesh) {
    const data = mesh.userData.mmdLook;
    if (!data) return;
    const mats = mesh.material;
    tmpMat.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
    const opaque = [];
    const blended = [];
    for (const c of data.centers) {
      const m = mats[c.materialIndex];
      if (m?.transparent) {
        const z = tmpVec.copy(c.center).applyMatrix4(tmpMat).z + c.radius;
        blended.push({ c, z });
      } else opaque.push(c);
    }
    if (!blended.length) return;
    blended.sort((a, b) => a.z - b.z);
    const byIndex = new Map(mesh.geometry.groups.map((g) => [g.materialIndex, g]));
    mesh.geometry.groups = [...opaque.map((c) => byIndex.get(c.materialIndex)), ...blended.map((x) => byIndex.get(x.c.materialIndex))].filter(Boolean);
  }

  function restoreNativeRigidBodyTypes(mesh) {
    const mmd = mesh?.geometry?.userData?.MMD;
    if (!mmd?.rigidBodies || !mmd.bones) return;
    for (const body of mmd.rigidBodies) {
      const idx = body.boneIndex;
      if (idx == null || idx < 0) continue;
      if (mmd.bones[idx]?.rigidBodyType === 2 && body.type === 1) body.type = 2;
    }
  }

  const hiddenMaterial = new THREE.MeshBasicMaterial({ visible: false });

  /** A mesh drawn with the model's skeleton and morphs, as a child of the model. */
  function skinnedChild(model, material) {
    const mesh = new THREE.SkinnedMesh(model.mesh.geometry, material);
    mesh.bind(model.mesh.skeleton, model.mesh.bindMatrix);
    mesh.morphTargetInfluences = model.mesh.morphTargetInfluences;
    mesh.morphTargetDictionary = model.mesh.morphTargetDictionary;
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Edges of the materials with the edge flag (PMDModel::renderModel). */
  function createEdgeMesh(model) {
    const data = model.mesh.userData.mmdLook;
    if (!data) return;
    const mats = data.looks.map((lk) => (lk.edge ? createEdgeMaterial(lk, data.hasExt, data.uniforms) : hiddenMaterial));
    model.edgeMaterials = mats.filter((m) => m !== hiddenMaterial);
    if (!model.edgeMaterials.length) return;
    model.edgeMesh = skinnedChild(model, mats);
    model.mesh.add(model.edgeMesh);
  }

  /**
   * The flat shadow MMDAgent-EX draws on the floor (use_shadow without shadow
   * mapping): the materials with the shadow flag projected along the light
   * onto y = 0, in one shade (PMDModel::renderForShadow).
   * @param {import('./model.js').Model} model
   */
  function updateShadowMesh(model) {
    if (model.shadowMesh) {
      model.mesh.remove(model.shadowMesh);
      model.shadowMaterial?.dispose();
      model.shadowMesh = null;
    }
    if (!useShadow || useShadowMapping) return;
    const lightUniform = { value: new THREE.Vector3(lightDir[0], lightDir[1], lightDir[2]) };
    const mat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: shadowDensity, depthWrite: false, side: THREE.DoubleSide,
      stencilWrite: true, stencilRef: 0, stencilFunc: THREE.EqualStencilFunc, stencilZPass: THREE.IncrementStencilOp,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.shadowLight = lightUniform;
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'uniform vec3 shadowLight;\nvoid main() {')
        .replace('#include <project_vertex>', `
          vec4 wp = modelMatrix * vec4( transformed, 1.0 );
          vec3 L = normalize( shadowLight );
          float k = wp.y / max( L.y, 0.001 );
          wp.xyz -= L * k;
          wp.y = 0.01;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;`);
    };
    const looks = model.mesh.userData.mmdLook?.looks;
    const mesh = skinnedChild(model, looks ? looks.map((lk) => (lk.shadow ? mat : hiddenMaterial)) : mat);
    mesh.renderOrder = -1;
    model.shadowMesh = mesh;
    model.shadowMaterial = mat;
    model.shadowUniform = lightUniform;
    // a child, so it follows the model's placement and visibility
    model.mesh.add(mesh);
  }

  /**
   * Shadow mapping: the materials that drop a shadow, written only to the shadow
   * map, back faces as in Render::renderSceneShadowMap.
   * @param {import('./model.js').Model} model
   */
  function updateCasterMesh(model) {
    if (model.casterMesh) {
      model.mesh.remove(model.casterMesh);
      model.casterMaterial?.dispose();
      model.casterMesh = null;
    }
    if (!useShadowMapping) return;
    const looks = model.mesh.userData.mmdLook?.looks;
    const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false, shadowSide: THREE.BackSide });
    const mesh = skinnedChild(model, looks ? looks.map((lk) => (lk.shadowMapDrop ? mat : hiddenMaterial)) : mat);
    mesh.castShadow = true;
    model.casterMesh = mesh;
    model.casterMaterial = mat;
    model.mesh.add(mesh);
  }

  /** @param {import('./model.js').Model} model */
  function addModel(model) {
    models.add(model);
    scene.add(model.mesh);
    createEdgeMesh(model);
    updateShadowMesh(model);
    updateCasterMesh(model);
    refreshModelLook(model);
    model.onCartoonChange = () => refreshModelLook(model);
    if (physicsReady) enableModelPhysics(model);
  }

  /** @param {import('./model.js').Model} model */
  function removeModel(model) {
    models.delete(model);
    scene.remove(model.mesh);
    model.disposePhysics();
    model.mesh.geometry.dispose();
    for (const m of model.materials) m.dispose();
    for (const m of model.edgeMaterials || []) m.dispose();
    model.shadowMaterial?.dispose();
    model.casterMaterial?.dispose();
  }

  // ----------------------------------------------------------------- physics

  function ensureAmmoScratch() {
    const AmmoLib = window.Ammo;
    if (!AmmoLib?.btVector3 || ammoScratch) return ammoScratch;
    ammoScratch = {
      tr: new AmmoLib.btTransform(),
      origin: new AmmoLib.btVector3(0, 0, 0),
      quat: new AmmoLib.btQuaternion(0, 0, 0, 1),
      vec: new AmmoLib.btVector3(0, 0, 0),
    };
    return ammoScratch;
  }

  function tunePhysics(physics) {
    try {
      // BulletPhysics::setup: m_numIterations = 10 * 60 / fps
      physics.world.getSolverInfo().set_m_numIterations(Math.max(1, Math.round((10 * 60) / bulletHz)));
    } catch (_) { /* differs between Ammo builds */ }
    const DISABLE_DEACTIVATION = 4;
    for (const rb of physics.bodies || []) {
      const body = rb.body;
      try {
        if (typeof body.set_m_additionalDamping === 'function') body.set_m_additionalDamping(true);
        body.setActivationState(DISABLE_DEACTIVATION);
      } catch (_) { /* ignore */ }
      // PMDRigidBody::applyTransformToBone type 2: rotation only
      if (rb.params?.type === 2) {
        rb.updateBone = function matchNativeType2() {
          if (this.params.boneIndex === -1) return this;
          this._updateBoneRotation();
          this.bone.updateMatrixWorld(true);
          return this;
        };
      }
    }
    for (const c of physics.constraints || []) {
      const constraint = c?.constraint;
      if (!constraint) continue;
      try {
        // PMDConstraint::setup: rotational springs always enabled; Bullet's default ERP
        const rot = c.params?.springRotation || [0, 0, 0];
        for (let i = 0; i < 3; i += 1) {
          constraint.enableSpring(i + 3, true);
          constraint.setStiffness(i + 3, rot[i] || 0);
        }
        if (typeof constraint.setParam === 'function') for (let i = 0; i < 6; i += 1) constraint.setParam(2, 0.2, i);
        physics.world.removeConstraint(constraint);
        physics.world.addConstraint(constraint, false);
      } catch (_) { /* differs between Ammo builds */ }
    }
  }

  function addPhysicsFloor() {
    const AmmoLib = window.Ammo;
    if (!AmmoLib?.btVector3 || !sharedWorld || floorBody || !bulletFloorOn) return;
    // BulletPhysics::addFloor: plane y = 0, collision group 15
    const shape = new AmmoLib.btStaticPlaneShape(new AmmoLib.btVector3(0, 1, 0), 1);
    const tr = new AmmoLib.btTransform();
    tr.setIdentity();
    tr.setOrigin(new AmmoLib.btVector3(0, -1, 0));
    const info = new AmmoLib.btRigidBodyConstructionInfo(0, new AmmoLib.btDefaultMotionState(tr), shape, new AmmoLib.btVector3(0, 0, 0));
    floorBody = new AmmoLib.btRigidBody(info);
    sharedWorld.addRigidBody(floorBody, 1 << 15, -1);
  }

  /** @param {import('./model.js').Model} model */
  function enableModelPhysics(model) {
    try {
      model.mesh.updateMatrixWorld(true);
      model.enablePhysics({ world: sharedWorld || undefined, gravity: gravityVec, unitStep: 1 / bulletHz });
      if (!model.physics) return;
      if (!sharedWorld) sharedWorld = model.physics.world;
      tunePhysics(model.physics);
      addPhysicsFloor();
      model.physics.reset();
      savePhysicsAncestors(model);
    } catch (err) {
      log(`物理演算を使えません（${err?.message || err}）`);
    }
  }

  /** Load Ammo.js; models get physics as soon as it is ready. */
  async function enablePhysics() {
    if (!physicsWanted || physicsReady) return physicsReady;
    try {
      await Promise.race([
        loadAmmo(),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error(`Ammo.js timeout ${AMMO_TIMEOUT_MS}ms`)), AMMO_TIMEOUT_MS)),
      ]);
    } catch (err) {
      log(`物理演算なしで表示します: ${err?.message || err}`);
      return false;
    }
    physicsReady = true;
    ensureAmmoScratch();
    for (const m of models) enableModelPhysics(m);
    log('物理演算を有効にしました');
    return true;
  }

  function kinematicAncestor(model, bone) {
    let node = bone;
    while (node && model.simulatedBones.has(node)) node = node.parent;
    return node || model.mesh;
  }

  function savePhysicsAncestors(model) {
    if (!model.physics) return;
    for (const rb of model.physics.bodies) {
      if (rb.params?.type === 0) continue;
      const anc = kinematicAncestor(model, rb.bone);
      let mat = model.savedAncestorWorld.get(anc);
      if (!mat) model.savedAncestorWorld.set(anc, (mat = new THREE.Matrix4()));
      mat.copy(anc.matrixWorld);
    }
  }

  const _wm = new THREE.Matrix4();
  const _wi = new THREE.Matrix4();
  const _wp = new THREE.Vector3();
  const _wq = new THREE.Quaternion();
  const _ws = new THREE.Vector3();
  const _wl = new THREE.Vector3();
  const _wa = new THREE.Vector3();
  const _wd = new THREE.Quaternion();

  /**
   * PMDObject::skipNextSimulation → setPhysicsControl(true, keepStatus): for one
   * step, carry the simulated bodies along with their kinematic parents.
   * @param {import('./model.js').Model} model
   */
  function warpPhysicsKeepStatus(model) {
    const scratch = ensureAmmoScratch();
    if (!model.physics || !scratch) return;
    for (const rb of model.physics.bodies) {
      if (!rb?.body || rb.params?.type === 0) continue;
      const anc = kinematicAncestor(model, rb.bone);
      const prev = model.savedAncestorWorld.get(anc);
      if (!prev) continue;
      _wi.copy(prev).invert();
      _wm.copy(anc.matrixWorld).multiply(_wi);
      const ms = rb.body.getMotionState();
      if (!ms) continue;
      ms.getWorldTransform(scratch.tr);
      const o = scratch.tr.getOrigin();
      const q = scratch.tr.getRotation();
      _wp.set(o.x(), o.y(), o.z()).applyMatrix4(_wm);
      _wq.set(q.x(), q.y(), q.z(), q.w());
      _wm.decompose(_wl, _wd, _ws);
      _wq.premultiply(_wd);
      scratch.origin.setValue(_wp.x, _wp.y, _wp.z);
      scratch.quat.setValue(_wq.x, _wq.y, _wq.z, _wq.w);
      scratch.tr.setOrigin(scratch.origin);
      scratch.tr.setRotation(scratch.quat);
      rb.body.setCenterOfMassTransform(scratch.tr);
      ms.setWorldTransform(scratch.tr);
      const lv = rb.body.getLinearVelocity();
      const av = rb.body.getAngularVelocity();
      _wl.set(lv.x(), lv.y(), lv.z()).applyQuaternion(_wd);
      _wa.set(av.x(), av.y(), av.z()).applyQuaternion(_wd);
      scratch.vec.setValue(_wl.x, _wl.y, _wl.z);
      rb.body.setLinearVelocity(scratch.vec);
      scratch.vec.setValue(_wa.x, _wa.y, _wa.z);
      rb.body.setAngularVelocity(scratch.vec);
    }
  }

  /** BulletPhysics::update for every model in one world. @param {number} sec */
  function stepPhysics(sec) {
    const list = Array.from(models).filter((m) => m.physics && m.mesh.visible !== false);
    if (!list.length) return;
    for (const m of list) {
      m.mesh.updateMatrixWorld(true);
      if (m.needResetKinematic) {
        warpPhysicsKeepStatus(m);
        m.needResetKinematic = false;
      }
      m.physics._updateRigidBodies();
    }
    list[0].physics._stepSimulation(sec);
    for (const m of list) {
      m.physics._updateBones();
      savePhysicsAncestors(m);
    }
  }

  // ----------------------------------------------------------------- camera

  const _cq = new THREE.Quaternion();
  const _view = new THREE.Matrix4();
  const _t = new THREE.Matrix4();

  /** Render::updateModelViewMatrix, then the three.js camera from its inverse. */
  function applyCamera() {
    const r = cam.currentRot;
    _cq.set(r[0], r[1], r[2], r[3]);
    _view.makeRotationFromQuaternion(_cq);
    const tr = cam.currentTrans;
    _t.makeTranslation(-tr[0], -tr[1], -tr[2]);
    _view.multiply(_t);
    _view.premultiply(_t.makeTranslation(0, 0, -cam.currentDistance));
    const bone = cam.baseBone;
    if (bone) {
      bone.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(bone.matrixWorld).invert();
      if (cam.modelFollow) {
        const p = new THREE.Vector3().setFromMatrixPosition(inv);
        const target = [p.x, 0, 0];
        cam.lastFollowPos = cam.lastFollowPos.map((v, i) => v + (target[i] - v) * 0.01);
        _view.multiply(_t.makeTranslation(cam.lastFollowPos[0], 0, 0));
      } else {
        _view.multiply(inv);
      }
    }
    camera.matrix.copy(_view).invert();
    camera.matrixWorld.copy(camera.matrix);
    camera.matrixWorldInverse.copy(_view);
    camera.fov = cam.currentFovy;
    camera.updateProjectionMatrix();
  }

  // mouse / wheel view control, like MMDAgent-EX's (rotate_step, translate_step, distance_step, fovy_step)
  let rotateStep = 4.5;
  let translateStep = 0.5;
  let distanceStep = 4.0;
  let fovyStep = 1.0;
  let drag = null;
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    drag = { x: ev.clientX, y: ev.clientY, button: ev.button, shift: ev.shiftKey };
    renderer.domElement.setPointerCapture(ev.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    cam.setMoveTime(0);
    if (drag.button === 2 || drag.shift) cam.translateBy([-dx * translateStep * 0.1, dy * translateStep * 0.1, 0]);
    else cam.rotateBy(dy * rotateStep * 0.1, dx * rotateStep * 0.1);
  });
  renderer.domElement.addEventListener('pointerup', () => { drag = null; });
  renderer.domElement.addEventListener('contextmenu', (ev) => ev.preventDefault());
  renderer.domElement.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    cam.setMoveTime(0);
    if (ev.ctrlKey) cam.setFovy(cam.fovy + Math.sign(ev.deltaY) * fovyStep);
    else cam.setDistance(Math.max(0, cam.distance + Math.sign(ev.deltaY) * distanceStep));
  }, { passive: false });

  // ---------------------------------------------------------------- run loop

  let rafId = 0;
  let last = performance.now();
  let restFrame = 0;
  let fpsAvg = 60;
  function animate(now) {
    rafId = requestAnimationFrame(animate);
    const sec = Math.min(0.25, Math.max(0, (now - last) / 1000));
    last = now;
    if (sec > 0) fpsAvg = fpsAvg * 0.9 + (1 / sec) * 0.1;
    options.onFrame?.(sec, fpsAvg);
    const stepFrame = 30 / bulletHz;
    restFrame += sec * 30;
    let n = 0;
    while (restFrame >= stepFrame && n < 60) {
      options.onStep?.(stepFrame);
      if (physicsReady && !physicsPaused) stepPhysics(stepFrame / 30);
      restFrame -= stepFrame;
      n += 1;
    }
    if (n >= 60) restFrame = 0;
    options.onAfterSteps?.(sec * 30);
    cam.update(sec);
    applyCamera();
    for (const m of models) sortMaterials(m.mesh);
    renderer.render(scene, camera);
    // the shadow map exists after the first frame with shadow mapping on
    const map = useShadowMapping ? dir.shadow.map?.texture || null : null;
    look.uShadowMap.value = map;
    look.uShadowOn.value = map ? 1 : 0;
  }

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(container);
  else window.addEventListener('resize', resize);
  resize();
  rafId = requestAnimationFrame(animate);

  // ------------------------------------------------------- key operations
  let physicsPaused = false;
  let wireframe = false;
  const info = document.createElement('div');
  Object.assign(info.style, { position: 'absolute', left: '8px', bottom: '8px', color: '#fff', font: '12px monospace', textShadow: '0 0 3px #000', pointerEvents: 'none', display: 'none', whiteSpace: 'pre' });
  container.appendChild(info);
  setInterval(() => {
    if (info.style.display === 'none') return;
    const t = cam.currentTrans;
    info.textContent = `${fpsAvg.toFixed(1)} fps
${t.map((v) => v.toFixed(2)).join(', ')} | ${cam.angle.map((v) => v.toFixed(2)).join(', ')} | ${cam.currentDistance.toFixed(2)} | ${cam.currentFovy.toFixed(2)}`;
  }, 250);

  /**
   * KeyHandler::processCharMessage / processKeyMessage actions that work in a browser.
   * @param {string} key KeyboardEvent.key
   * @param {boolean} shift
   * @returns {boolean} handled
   */
  function keyAction(key, shift) {
    switch (key) {
      case 'f':
        if (document.fullscreenElement) document.exitFullscreen();
        else container.requestFullscreen?.();
        return true;
      case 's':
        info.style.display = info.style.display === 'none' ? '' : 'none';
        return true;
      case '+':
      case '-':
        cam.setMoveTime(-1);
        cam.setDistance(Math.max(0, cam.distance + (key === '+' ? -distanceStep : distanceStep)));
        return true;
      case 'S':
        useShadow = !useShadow;
        for (const m of models) updateShadowMesh(m);
        return true;
      case 'x':
        setShadowMapping(!useShadowMapping);
        return true;
      case 'k':
      case 'K':
        // MMDAgent::changeEdgeWidth
        edgeThin = Math.min(1000, Math.max(0.001, key === 'k' ? edgeThin * edgeStep : edgeThin / edgeStep));
        for (const m of models) refreshModelLook(m);
        return true;
      case 'p':
        physicsPaused = !physicsPaused;
        return true;
      case 'w':
        wireframe = !wireframe;
        for (const m of models) for (const mat of m.materials) mat.wireframe = wireframe;
        return true;
      case 'ArrowLeft':
      case 'ArrowRight':
        cam.setMoveTime(-1);
        if (shift) cam.translateBy([key === 'ArrowLeft' ? -translateStep : translateStep, 0, 0]);
        else cam.rotateBy(0, key === 'ArrowLeft' ? -rotateStep : rotateStep);
        return true;
      case 'ArrowUp':
      case 'ArrowDown':
        cam.setMoveTime(-1);
        if (shift) cam.translateBy([0, key === 'ArrowUp' ? translateStep : -translateStep, 0]);
        else cam.rotateBy(key === 'ArrowUp' ? -rotateStep : rotateStep, 0);
        return true;
      default:
        return false;
    }
  }

  return {
    scene,
    camera,
    renderer,
    cam,
    keyAction,
    get models() {
      return models;
    },
    /** @param {(url: string) => string} fn */
    setUrlModifier(fn) {
      urlModifier = fn;
    },
    applyMdf,
    setLightColor,
    setLightDirection,
    setStage,
    setStageModel,
    loadMesh,
    addModel,
    removeModel,
    enablePhysics,
    resize,
    /** Remove everything (new scene). */
    reset() {
      for (const m of Array.from(models)) removeModel(m);
      clearStage();
      if (floorBody && sharedWorld) {
        try { sharedWorld.removeRigidBody(floorBody); } catch (_) { /* gone */ }
      }
      floorBody = null;
      sharedWorld = null;
      cam.setMotion(null);
    },
    dispose() {
      cancelAnimationFrame(rafId);
      if (ro) ro.disconnect();
      else window.removeEventListener('resize', resize);
      try { renderer.forceContextLoss(); } catch (_) { /* gone */ }
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
