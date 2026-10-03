'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ort = require('onnxruntime-node');
const crypto = require('node:crypto');

const MODEL = path.join(__dirname, 'models', 'mnist-12.onnx');
const MAX_STROKES = 32;
const MAX_POINTS = 4096;
let sessionPromise;

function invalid(message) { const error = new TypeError(message); error.code = 'INVALID_HANDWRITING_INPUT'; throw error; }

function validate(input) {
  if (!input || !Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.width > 1024 || input.height < 1 || input.height > 1024) invalid('width and height must be integers from 1 to 1024');
  if (!Array.isArray(input.strokes) || input.strokes.length === 0 || input.strokes.length > MAX_STROKES) invalid('strokes must contain 1 to 32 strokes');
  let points = 0;
  for (const stroke of input.strokes) {
    if (!Array.isArray(stroke) || stroke.length === 0) invalid('each stroke must contain points');
    points += stroke.length;
    if (points > MAX_POINTS) invalid('at most 4096 points are accepted');
    for (const point of stroke) {
      if (!point || typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > input.width || point.y < 0 || point.y > input.height) invalid('points must be finite and inside the canvas');
    }
  }
  if (points > MAX_POINTS) invalid('at most 4096 points are accepted');
}

function bounds(strokes) {
  const all = strokes.flat(Infinity);
  return { minX: Math.min(...all.map(p => p.x)), maxX: Math.max(...all.map(p => p.x)), minY: Math.min(...all.map(p => p.y)), maxY: Math.max(...all.map(p => p.y)) };
}

function inkMask(strokes, size = 28) {
  const b = bounds(strokes); const spanX = Math.max(1, b.maxX - b.minX); const spanY = Math.max(1, b.maxY - b.minY);
  const source = Array.from({ length: size }, () => new Float32Array(size));
  const scale = 18 / Math.max(spanX, spanY);
  const ox = (27 - spanX * scale) / 2, oy = (27 - spanY * scale) / 2;
  const draw = (a, c) => {
    const x0 = ox + (a.x - b.minX) * scale, y0 = oy + (a.y - b.minY) * scale;
    const x1 = ox + (c.x - b.minX) * scale, y1 = oy + (c.y - b.minY) * scale;
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 0; i <= n; i++) { const x = Math.round(x0 + (x1 - x0) * i / n), y = Math.round(y0 + (y1 - y0) * i / n); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (source[y + dy]?.[x + dx] !== undefined) source[y + dy][x + dx] = 1; }
  };
  for (const stroke of strokes) { if (stroke.length === 1) draw(stroke[0], stroke[0]); else for (let i = 1; i < stroke.length; i++) draw(stroke[i - 1], stroke[i]); }
  const out = new Float32Array(size * size); for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out[y * size + x] = source[y][x];
  let mass = 0, cx = 0, cy = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const v = out[y * size + x]; mass += v; cx += x * v; cy += y * v; }
  const shifted = new Float32Array(size * size), dx = Math.round(13.5 - cx / mass), dy = Math.round(13.5 - cy / mass);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (x + dx >= 0 && x + dx < size && y + dy >= 0 && y + dy < size) shifted[(y + dy) * size + x + dx] = out[y * size + x];
  return shifted;
}

function segments(strokes) {
  const items = strokes.map((stroke, index) => ({ stroke, index, ...bounds([stroke]) }));
  items.sort((a, b) => a.minX - b.minX);
  // Rasterized horizontal projection of stroke extents: connected x intervals
  // merge overlapping strokes transitively, independent of drawing order.
  const gap = 1;
  const groups = [];
  for (const item of items) {
    let group = groups.find(g => item.minX <= g.maxX + gap && item.maxX >= g.minX - gap);
    if (!group) { group = { items: [], minX: item.minX, maxX: item.maxX }; groups.push(group); }
    group.items.push(item); group.minX = Math.min(group.minX, item.minX); group.maxX = Math.max(group.maxX, item.maxX);
  }
  groups.sort((a, b) => a.minX - b.minX);
  return groups.map(g => g.items.map(x => x.stroke));
}

async function getSession() {
  if (!fs.existsSync(MODEL)) throw new Error(`MNIST model is missing: ${MODEL}`);
  if (!sessionPromise) {
    const bytes = fs.readFileSync(MODEL);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== '5c688690f8bacf667d4c2074af5ad0646ca328d7ab03eccf944a65b320171bdd') throw new Error('MODEL_HASH_MISMATCH');
    sessionPromise = ort.InferenceSession.create(bytes, { executionProviders: ['cpu'], intraOpNumThreads: 1 }).catch(error => { sessionPromise = undefined; throw error; });
  }
  return sessionPromise;
}

async function classify(strokes) {
  const session = await getSession(); const input = new ort.Tensor('float32', inkMask(strokes), [1, 1, 28, 28]);
  const result = await session.run({ [session.inputNames[0]]: input }); const values = Array.from(result[session.outputNames[0]].data);
  const max = Math.max(...values); const exps = values.map(v => Math.exp(v - max)); const total = exps.reduce((a, b) => a + b, 0); const probabilities = exps.map(v => v / total); const digit = probabilities.indexOf(Math.max(...probabilities));
  return { digit, confidence: probabilities[digit] };
}

async function recognize(input) {
  validate(input); const groups = segments(input.strokes); const classified = [];
  const horizontal = group => { const b = bounds(group); return b.maxX - b.minX >= 3 && b.maxY - b.minY <= (b.maxX - b.minX) * 0.15; };
  const minus = groups.length > 1 && horizontal(groups[0]);
  for (const [i, group] of groups.entries()) {
    const b = bounds(group);
    if (Math.max(b.maxX - b.minX, b.maxY - b.minY) < 2) invalid('blank or degenerate ink');
    if (minus && i === 0) continue;
    if (horizontal(group)) invalid('minus must precede one or more digits');
    classified.push(await classify(group));
  }
  const digits = classified.map(x => x.digit);
  const recognizedText = (minus ? '-' : '') + digits.join(''); const confidence = classified.length ? Math.min(...classified.map(x => x.confidence)) : 0;
  return { recognizedText, confidence, digits, needsConfirmation: true };
}

module.exports = { recognize, initialize: getSession };
