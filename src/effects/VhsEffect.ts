import * as THREE from 'three';
import { BaseShaderEffect } from './BaseShaderEffect';
import { vertexShader } from './shaders';

/**
 * VHS。テープ再生の劣化を 1 つの Effect に統合する（DESIGN.md §6）。
 *
 * 実機ではトラッキングノイズ・色ズレ・ジッターは同時に起きる連動現象なので、
 * バラバラの Effect にせず、マスターの「劣化度」(intensity) が全要素を
 * まとめて汚す。個別の量は追加パラメータで微調整できる。
 */
export class VhsEffect extends BaseShaderEffect {
  readonly name = 'VHS';

  constructor() {
    super(
      {
        uniforms: {
          tDiffuse: { value: null },
          uIntensity: { value: 0.55 },
          uTracking: { value: 1 },
          uJitter: { value: 1 },
          uBleed: { value: 1 },
          uScanline: { value: 0.7 },
          uColorNoise: { value: 0.7 },
          uTime: { value: 0 },
          uResolution: { value: new THREE.Vector2(innerWidth, innerHeight) },
        },
        vertexShader,
        fragmentShader: /* glsl */ `
          uniform sampler2D tDiffuse;
          uniform float uIntensity;
          uniform float uTracking;
          uniform float uJitter;
          uniform float uBleed;
          uniform float uScanline;
          uniform float uColorNoise;
          uniform float uTime;
          uniform vec2 uResolution;
          varying vec2 vUv;

          float hash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
          }

          void main() {
            float amount = clamp(uIntensity, 0.0, 1.0);
            vec2 uv = vUv;

            // トラッキングノイズ帯: ゆっくり流れる横帯が行を横へ引きずる。
            float band = fract(uTime * 0.11);
            float inBand = smoothstep(0.055, 0.0, abs(uv.y - band));
            float rowNoise = hash(vec2(floor(uv.y * 240.0), floor(uTime * 24.0)));
            uv.x += inBand * (rowNoise - 0.5) * 0.12 * uTracking * amount;

            // 画面下部のジッター: ヘッド切替に近い乱れ。
            float bottom = smoothstep(0.18, 0.0, uv.y);
            uv.x += bottom
              * (hash(vec2(floor(uTime * 30.0), floor(uv.y * 60.0))) - 0.5)
              * 0.05 * uJitter * amount;

            // 行単位の微細な揺れ。
            uv.x += (hash(vec2(floor(uv.y * 300.0), floor(uTime * 18.0))) - 0.5)
              * 0.006 * amount;

            uv = clamp(uv, 0.0, 1.0);

            // 色ズレ: 帯の中では強く出る。
            float shift = 0.0025 * uBleed * amount * (1.0 + inBand * 3.0);
            float r = texture2D(tDiffuse, clamp(uv + vec2(shift, 0.0), 0.0, 1.0)).r;
            vec4 base = texture2D(tDiffuse, uv);
            float b = texture2D(tDiffuse, clamp(uv - vec2(shift, 0.0), 0.0, 1.0)).b;
            vec3 color = vec3(r, base.g, b);

            // 色ノイズ (クロマノイズ)。
            float cn = hash(floor(uv * uResolution * 0.35) + floor(uTime * 15.0));
            color += (vec3(cn, hash(vec2(cn, 0.31)), hash(vec2(0.73, cn))) - 0.5)
              * 0.10 * uColorNoise * amount;

            // 走査線。
            float scan = 0.5 + 0.5 * sin(uv.y * uResolution.y * 3.14159);
            color *= mix(1.0, 0.82 + 0.18 * scan, clamp(uScanline, 0.0, 1.0) * amount);

            // テープ劣化: 彩度低下・黒浮き・輝度ノイズ。
            float luma = dot(color, vec3(0.299, 0.587, 0.114));
            color = mix(color, vec3(luma), 0.25 * amount);
            color += (hash(uv * uResolution + uTime * 60.0) - 0.5) * 0.08 * amount;
            color = color * (1.0 - 0.1 * amount) + vec3(0.03) * amount;

            // 帯の中は信号が飛んで白く走る。
            color += inBand * rowNoise * 0.12 * uTracking * amount;

            gl_FragColor = vec4(clamp(color, 0.0, 1.0), base.a);
          }
        `,
      },
      { label: 'Degradation', defaultValue: 0.55, min: 0, max: 1, step: 0.001 },
      [
        { key: 'tracking', type: 'number', label: 'Tracking band', defaultValue: 1, min: 0, max: 1, step: 0.01 },
        { key: 'jitter', type: 'number', label: 'Bottom jitter', defaultValue: 1, min: 0, max: 1, step: 0.01 },
        { key: 'bleed', type: 'number', label: 'Color bleed', defaultValue: 1, min: 0, max: 1, step: 0.01 },
        { key: 'scanline', type: 'number', label: 'Scanlines', defaultValue: 0.7, min: 0, max: 1, step: 0.01 },
        { key: 'colorNoise', type: 'number', label: 'Color noise', defaultValue: 0.7, min: 0, max: 1, step: 0.01 },
      ],
    );
  }
}
