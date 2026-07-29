// 帯域イベント検証用の音源を生成する。
//
// Core Study の帯域別 Onset(Bass / Mid / Treble)と複数発光の検証には、
// 「1 帯域だけが鳴る瞬間」と「複数の音が完全に同時に鳴る瞬間」の両方が要る。
// reference.wav は音程写像(L1〜L3)の確認用で同時発音の設計がないため、
// 別ファイルとして追加する(reference.wav は上書きしない)。
//
//   node scripts/generate-band-demo-audio.mjs
//
// 出力先: public/audio/band-demo.wav
//
// 区間の設計(BPM 120・1 拍 = 0.5 秒):
//   0- 6s  キックのみ(Bass 単独)
//   6-12s  ハイハットのみ・8 分(Treble 単独)
//  12-18s  キック + ハイハットを完全同時(2 帯域の真の同時発音)
//  18-24s  キック表・ハイハット裏(交互。帯域の分離を見る)
//  24-30s  キック + ミッドスタブ + ハイハット同時 + 低いパッド持続
//          (3 帯域同時と「持続音の上の打撃」を同時に見る)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 44100;
const DURATION = 30;
const BPM = 120;
const BEAT = 60 / BPM;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'public', 'audio', 'band-demo.wav');

// 決定論的な擬似乱数。実行するたびに同じ音源が出るようにする。
let seed = 20260729;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return (seed / 4294967296) * 2 - 1;
};

// 打撃の部品。phase は打撃開始からの経過秒。
const kickAt = (phase, t) => {
  if (phase < 0 || phase > 0.35) return 0;
  const envelope = Math.exp(-phase * 22);
  const sweep = 52 * Math.pow(1 - Math.min(phase / 0.35, 1), 2) + 38;
  return Math.sin(2 * Math.PI * sweep * t) * envelope * 0.9;
};

// 白色雑音のままだと 20-250Hz にも同量のエネルギーが乗り、Treble 単独区間に
// ならない。2 回の差分(12dB/oct のハイパス相当)で高域へ寄せる。
let hatNoisePrev1 = 0;
let hatNoisePrev2 = 0;
const hatAt = (phase) => {
  if (phase < 0 || phase > 0.12) return 0;
  const n = noise();
  const hp = n - 2 * hatNoisePrev1 + hatNoisePrev2;
  hatNoisePrev2 = hatNoisePrev1;
  hatNoisePrev1 = n;
  return hp * Math.exp(-phase * 55) * 0.22;
};

// ミッドのスタブ(800Hz 台のプラック)。
const stabAt = (phase, t) => {
  if (phase < 0 || phase > 0.3) return 0;
  const envelope = Math.exp(-phase * 16);
  return (
    (Math.sin(2 * Math.PI * 780 * t) + Math.sin(2 * Math.PI * 1170 * t) * 0.5) *
    envelope *
    0.45
  );
};

const samples = new Float32Array(Math.floor(SAMPLE_RATE * DURATION));

for (let i = 0; i < samples.length; i++) {
  const t = i / SAMPLE_RATE;
  const beatPhase = t % BEAT;
  const halfPhase = t % (BEAT / 2);
  let value = 0;

  if (t < 6) {
    // Bass 単独。
    value += kickAt(beatPhase, t);
  } else if (t < 12) {
    // Treble 単独(8 分)。
    value += hatAt(halfPhase);
  } else if (t < 18) {
    // 2 帯域の完全同時。
    value += kickAt(beatPhase, t);
    value += hatAt(beatPhase);
  } else if (t < 24) {
    // 表と裏で交互。同時には鳴らない。
    value += kickAt(beatPhase, t);
    value += hatAt(beatPhase - BEAT / 2);
  } else {
    // 3 帯域同時 + 低いパッド持続(持続音の上の打撃を見る)。
    value += kickAt(beatPhase, t);
    value += stabAt(beatPhase, t);
    value += hatAt(beatPhase);
    value += Math.sin(2 * Math.PI * 110 * t) * 0.1 + Math.sin(2 * Math.PI * 165 * t) * 0.06;
  }

  // 全体の入りと終わりをなだらかにして、クリックノイズを避ける。
  const fade = Math.min(1, t / 0.05, (DURATION - t) / 0.4);
  samples[i] = Math.max(-1, Math.min(1, value * 0.85)) * Math.max(fade, 0);
}

const buffer = Buffer.alloc(44 + samples.length * 2);
buffer.write('RIFF', 0);
buffer.writeUInt32LE(36 + samples.length * 2, 4);
buffer.write('WAVE', 8);
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(1, 22);
buffer.writeUInt32LE(SAMPLE_RATE, 24);
buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
buffer.writeUInt16LE(2, 32);
buffer.writeUInt16LE(16, 34);
buffer.write('data', 36);
buffer.writeUInt32LE(samples.length * 2, 40);

for (let i = 0; i < samples.length; i++) {
  buffer.writeInt16LE(Math.round(samples[i] * 32767), 44 + i * 2);
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, buffer);
console.log(`wrote ${output} (${(buffer.length / 1024).toFixed(0)} KB, ${DURATION}s)`);
