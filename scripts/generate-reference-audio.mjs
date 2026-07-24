// 確認用音源を生成する。DESIGN.md「8. 確認用音源」を参照。
//
// 音楽がないと何も描かれない仕様のため、開発時の確認に既定の音源を置いている。
// 実楽曲ではなく合成音にしているのは、音程・音色・立ち上がりを狙って動かせて、
// L1〜L3 の写像が効いているかを切り分けて確認できるため。
//
//   node scripts/generate-reference-audio.mjs
//
// 出力先: public/audio/reference.wav（同名で上書きすれば別の音源に差し替えられる）

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 44100;
const DURATION = 24;
const BPM = 120;
const BEAT = 60 / BPM;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'public', 'audio', 'reference.wav');

// 音程は半音単位の離散値にする。L2 量子化写像が「音程が変わると図形が跳ぶ」
// 挙動を持つため、連続スイープよりも段階的な音程のほうが確認しやすい。
const SEMITONES = [0, 4, 7, 12, 7, 16, 12, 19];
const pitchAt = (step) => 110 * Math.pow(2, SEMITONES[step % SEMITONES.length] / 12);

// 決定論的な擬似乱数。実行するたびに同じ音源が出るようにする。
let seed = 12345;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return (seed / 4294967296) * 2 - 1;
};

const samples = new Float32Array(Math.floor(SAMPLE_RATE * DURATION));

for (let i = 0; i < samples.length; i++) {
  const t = i / SAMPLE_RATE;
  const beatIndex = Math.floor(t / BEAT);
  const beatPhase = (t % BEAT) / BEAT;
  let value = 0;

  // 0-6s: 段階的な音程だけ。音程と明るさの追従を見る。
  // 12-18s: 持続音。sustain と平坦度の低さを見る。
  const toneOn = t < 6 || (t >= 12 && t < 18) || t >= 18;
  if (toneOn) {
    const frequency = pitchAt(beatIndex);
    const envelope = t >= 12 && t < 18 ? 0.5 : 0.5 * Math.exp(-beatPhase * 2.2);
    value += Math.sin(2 * Math.PI * frequency * t) * envelope;
    value += Math.sin(2 * Math.PI * frequency * 2 * t) * envelope * 0.22;
    value += Math.sin(2 * Math.PI * frequency * 3 * t) * envelope * 0.11;
  }

  // 6-12s と 18-24s: キックとハイハット。立ち上がりとノイズ性を見る。
  if (t >= 6 && t < 12) {
    const kick = Math.exp(-beatPhase * 18);
    value += Math.sin(2 * Math.PI * 55 * Math.pow(1 - beatPhase, 2) * t) * kick * 0.85;
    if (beatPhase > 0.5) {
      value += noise() * Math.exp(-(beatPhase - 0.5) * 40) * 0.28;
    }
  }

  if (t >= 18) {
    const kick = Math.exp(-beatPhase * 16);
    value += Math.sin(2 * Math.PI * 48 * t) * kick * 0.7;
    value += noise() * Math.exp(-beatPhase * 26) * 0.2;
  }

  // 全体の入りと終わりをなだらかにして、クリックノイズを避ける。
  const fade = Math.min(1, t / 0.05, (DURATION - t) / 0.4);
  samples[i] = Math.max(-1, Math.min(1, value * 0.72)) * Math.max(fade, 0);
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
