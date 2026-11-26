/*
 * MMDAgent-EX Web
 * Copyright 2026 Kazushi Kato
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 *
 * Translated to JavaScript and modified from MMDAgent-EX:
 *   Library_MMDFiles/src/lib/PMDMaterial.cpp (setup, setExtParam)
 *   Library_MMDFiles/src/lib/PMDModel.cpp (setEdgeThin)
 *   Library_MMDFiles/src/lib/PMDModel_parse.cpp (edge width, toon textures)
 *   Library_MMDFiles/src/lib/PMDModel_update.cpp (toon coordinates, edge vertices)
 *   Library_MMDFiles/src/lib/PMDModel_render.cpp (renderModel)
 *   Library_MMDAgent/src/lib/Render.cpp (updateLight, renderSceneShadowMap)
 *   Copyright 2022-2023 Nagoya Institute of Technology (Apache License, Version 2.0)
 *   Copyright (c) 2009-2016 Nagoya Institute of Technology, Department of Computer Science
 *   (MMDAgent Project Team; BSD 3-Clause, see LICENSES/MMDAgent-BSD-3-Clause.txt)
 */

/**
 * How MMDAgent-EX draws a model, as shaders on three.js meshes.
 *
 * Model surface (PMDModel::renderModel, OpenGL fixed function, per vertex):
 *   color = clamp(0.2 * Ma + La * Ma + Ld * Md * max(n·l, 0) + Ls * Ms * (n·h)^shininess)
 *   with Ma = Md = diffuse * 0.5 + ambient in toon mode, then
 *   × texture (or sphere map) × toon texture at (0, (1 - l·n) / 2) × additional sphere map.
 * Edge: back faces of the mesh pushed out along the normal by
 *   vertex rate × material edge width × 0.03 × cartoon_edge_width
 *   (× ((1 - l·n) / 2 × 1.5 + 0.2) with light_edge), in the material's edge colour.
 * Colours are mixed as stored, without colour-space conversion, as OpenGL does.
 */

import * as THREE from 'three';
import { DEFAULT_EDGE_COLOR, EDGE_OFFSET_SCALE } from './material-looks.js';

// ------------------------------------------------------------------ shaders

const NORMAL_BLOCK = '#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )';

const SHADOW_PARS = `
uniform float uShadowOn;
uniform sampler2D uShadowMap;
uniform float uShadowBias;
varying vec4 vShadowCoord;
float mmdInShadow() {
  if ( uShadowOn < 0.5 ) return 0.0;
  vec3 p = vShadowCoord.xyz / vShadowCoord.w;
  if ( p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0 ) return 0.0;
  float d = unpackRGBAToDepth( texture2D( uShadowMap, p.xy ) );
  return p.z - uShadowBias > d ? 1.0 : 0.0;
}
`;

/**
 * Uniforms shared by every material of one model (light, toon mode, edge size).
 * @param {{ shadow: any }} global uniforms shared by the whole scene
 */
export function createModelUniforms(global) {
  return {
    uLightDir: global.uLightDir,
    uLightAmb: { value: new THREE.Vector3(0.9, 0.9, 0.9) },
    uLightDif: { value: new THREE.Vector3(0, 0, 0) },
    uLightSpc: { value: new THREE.Vector3(0.6, 0.6, 0.6) },
    uDimLight: global.uDimLight,
    uToon: { value: 1 },
    uEdgeOffset: { value: 0.7 * EDGE_OFFSET_SCALE },
    uLightEdge: global.uLightEdge,
    uShadowOn: global.uShadowOn,
    uShadowMap: global.uShadowMap,
    uShadowMatrix: global.uShadowMatrix,
    uShadowBias: global.uShadowBias,
    uShadowToonV: global.uShadowToonV,
  };
}

/**
 * Set the per-model light from Render::updateLight.
 * @param {ReturnType<typeof createModelUniforms>} u
 * @param {number[]} color light_color
 * @param {{ d: number, a: number, s: number }} t
 * @param {boolean} toon
 */
export function setModelLight(u, color, t, toon) {
  u.uLightAmb.value.set(color[0] * t.a, color[1] * t.a, color[2] * t.a);
  u.uLightDif.value.set(color[0] * t.d, color[1] * t.d, color[2] * t.d);
  u.uLightSpc.value.set(color[0] * t.s, color[1] * t.s, color[2] * t.s);
  u.uToon.value = toon ? 1 : 0;
}

/**
 * The surface material of one model material.
 * @param {import('./material-looks.js').MaterialLook} look
 * @param {{
 *   map: THREE.Texture | null, sphere: THREE.Texture | null, sphereAdd: boolean,
 *   toon: THREE.Texture, toonShadow: THREE.Texture,
 * }} tex
 * @param {ReturnType<typeof createModelUniforms>} shared
 */
export function createSurfaceMaterial(look, tex, shared) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: tex.map || null,
    side: look.face ? THREE.DoubleSide : THREE.FrontSide,
    transparent: false,
    depthWrite: true,
  });
  const avg = look.diffuse.map((d, i) => d * 0.5 + look.ambient[i]);
  const own = {
    uAvg: { value: new THREE.Vector3(...avg) },
    uDif: { value: new THREE.Vector3(...look.diffuse) },
    uAmb: { value: new THREE.Vector3(...look.ambient) },
    uSpec: { value: new THREE.Vector3(...look.specular) },
    uShin: { value: look.shininess },
    uToonMap: { value: tex.toon },
    uToonShadowMap: { value: tex.toonShadow },
    uSphereMap: { value: tex.sphere },
    // 1: the texture itself is a sphere map, 2: an additional sphere map
    uSphereUse: { value: tex.sphere ? (tex.map ? 2 : 1) : 0 },
    uSphereAdd: { value: tex.sphereAdd ? 1 : 0 },
  };
  mat.userData.mmd = { look, own };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, own);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `
uniform vec3 uAvg, uDif, uAmb, uSpec;
uniform float uShin, uToon;
uniform vec3 uLightDir, uLightAmb, uLightDif, uLightSpc;
uniform float uDimLight;
uniform mat4 uShadowMatrix;
varying vec3 vLit;
varying vec3 vLitDim;
varying float vToonV;
varying vec2 vSphereUv;
varying vec4 vShadowCoord;
void main() {`)
      .replace(NORMAL_BLOCK, '#if 1')
      .replace('#include <project_vertex>', `#include <project_vertex>
  {
    vec3 Ma = uToon > 0.5 ? uAvg : uAmb;
    vec3 Md = uToon > 0.5 ? uAvg : uDif;
    vec3 Lw = normalize( uLightDir );
    vec3 eN = normalize( normalMatrix * objectNormal );
    vec3 eL = normalize( mat3( viewMatrix ) * Lw );
    float ndl = dot( eN, eL );
    vec3 c = 0.2 * Ma + uLightAmb * Ma;
    vec3 cd = 0.2 * Ma + uDimLight * Ma;
    if ( ndl > 0.0 ) {
      c += uLightDif * Md * ndl;
      cd += uDimLight * Md * ndl;
      vec3 H = normalize( eL + vec3( 0.0, 0.0, 1.0 ) );
      float ndh = max( dot( eN, H ), 0.0 );
      c += uLightSpc * uSpec * ( uShin > 0.0 ? pow( ndh, uShin ) : 1.0 );
    }
    vLit = clamp( c, 0.0, 1.0 );
    vLitDim = clamp( cd, 0.0, 1.0 );
    vec3 wN = normalize( mat3( modelMatrix ) * objectNormal );
    vToonV = ( 1.0 - dot( Lw, wN ) ) * 0.5;
    // GL_SPHERE_MAP texture coordinate generation
    vec3 u = normalize( mvPosition.xyz );
    vec3 r = reflect( u, eN );
    float m = 2.0 * sqrt( r.x * r.x + r.y * r.y + ( r.z + 1.0 ) * ( r.z + 1.0 ) );
    vSphereUv = vec2( r.x / m + 0.5, r.y / m + 0.5 );
    vShadowCoord = uShadowMatrix * modelMatrix * vec4( transformed, 1.0 );
  }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `#include <packing>
uniform float uToon;
uniform sampler2D uToonMap;
uniform sampler2D uToonShadowMap;
uniform sampler2D uSphereMap;
uniform float uSphereUse, uSphereAdd;
uniform float uShadowToonV;
varying vec3 vLit;
varying vec3 vLitDim;
varying float vToonV;
varying vec2 vSphereUv;
${SHADOW_PARS}
vec4 mmdSphere( vec4 c ) {
  // sphere maps are stored upside down (PMDTexture::load)
  vec4 s = texture2D( uSphereMap, vec2( vSphereUv.x, 1.0 - vSphereUv.y ) );
  if ( uSphereAdd > 0.5 ) return vec4( min( c.rgb + s.rgb, 1.0 ), c.a * s.a );
  return c * s;
}
void main() {`)
      .replace('#include <map_fragment>', `
  float inShadow = mmdInShadow();
  // the shadow pass draws toon models with the toon light and others with a dim light
  diffuseColor.rgb *= ( inShadow > 0.5 && uToon < 0.5 ) ? vLitDim : vLit;
  #include <map_fragment>
  if ( uSphereUse > 0.5 && uSphereUse < 1.5 ) diffuseColor = mmdSphere( diffuseColor );
  if ( uToon > 0.5 ) {
    if ( inShadow > 0.5 ) diffuseColor *= texture2D( uToonShadowMap, vec2( 0.0, uShadowToonV ) );
    else diffuseColor *= texture2D( uToonMap, vec2( 0.0, vToonV ) );
  }
  if ( uSphereUse > 1.5 ) diffuseColor = mmdSphere( diffuseColor );
  if ( diffuseColor.a <= 0.0 ) discard;`);
  };
  mat.customProgramCacheKey = () => 'mmdagent-surface';
  return mat;
}

/**
 * The edge material of one model material.
 * @param {import('./material-looks.js').MaterialLook} look
 * @param {boolean} hasExt the model has a CSV (else every edge is black)
 * @param {ReturnType<typeof createModelUniforms>} shared
 */
export function createEdgeMaterial(look, hasExt, shared) {
  const col = hasExt && look.edgeColor ? look.edgeColor : DEFAULT_EDGE_COLOR;
  const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: col[3] < 1, opacity: col[3] });
  mat.color.setRGB(col[0], col[1], col[2]);
  mat.userData.mmd = { baseAlpha: col[3] };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `
attribute float edgeRate;
uniform vec3 uLightDir;
uniform float uEdgeOffset;
uniform float uLightEdge;
void main() {`)
      .replace(NORMAL_BLOCK, '#if 1')
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>
  {
    float r = edgeRate * uEdgeOffset;
    if ( uLightEdge > 0.5 ) {
      vec3 wN = normalize( mat3( modelMatrix ) * objectNormal );
      r *= ( 1.0 - dot( normalize( uLightDir ), wN ) ) * 0.5 * 1.5 + 0.2;
    }
    transformed += objectNormal * r;
  }`);
  };
  mat.customProgramCacheKey = () => 'mmdagent-edge';
  return mat;
}

/**
 * Floor and background (TileTexture::render): white material under the scene
 * light, darkened by the dim light where the shadow map says so.
 * @param {THREE.Texture} map
 * @param {{ value: THREE.Vector3 }} lit uniform: clamp(0.2 + a + d · max(n·l, 0))
 * @param {{ value: THREE.Vector3 }} dim uniform: the same with the dim light
 * @param {any} global scene uniforms
 */
export function createStageMaterial(map, lit, dim, global) {
  const mat = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, global, { uLit: lit, uLitDim: dim });
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform mat4 uShadowMatrix;\nvarying vec4 vShadowCoord;\nvoid main() {')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vShadowCoord = uShadowMatrix * modelMatrix * vec4( transformed, 1.0 );');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `#include <packing>\nuniform vec3 uLit, uLitDim;\n${SHADOW_PARS}\nvoid main() {`)
      .replace('#include <map_fragment>', 'diffuseColor.rgb *= mmdInShadow() > 0.5 ? uLitDim : uLit;\n  #include <map_fragment>');
  };
  mat.customProgramCacheKey = () => 'mmdagent-stage';
  return mat;
}

/**
 * Whether an image has any pixel that is not fully opaque (PMDTexture::isTransparent).
 * @param {any} image
 */
export function imageHasAlpha(image) {
  try {
    const w = image?.width || 0;
    const h = image?.height || 0;
    if (!w || !h) return false;
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const px = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
  } catch (_) {
    return false;
  }
  return false;
}
