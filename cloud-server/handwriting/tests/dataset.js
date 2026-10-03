'use strict';
const fs = require('node:fs');
const path = require('node:path');
function loadSamples() {
  return fs.readFileSync(path.join(__dirname, 'fixtures/pendigits.tes'), 'utf8').trim().split(/\r?\n/).map((line, index) => {
    const values = line.split(',').map(Number);
    return { row: index + 1, label: String(values[16]), stroke: Array.from({ length: 8 }, (_, i) => ({ x: values[2 * i], y: 100 - values[2 * i + 1] })) };
  });
}
function compose(samples, negative = false) {
  const offset = negative ? 60 : 0;
  const strokes = samples.map((s, i) => s.stroke.map(p => ({ x: p.x + offset + i * 130 + 5, y: p.y + 5 })));
  if (negative) strokes.push([{ x: 5, y: 55 }, { x: 40, y: 55 }]);
  return { width: offset + samples.length * 130, height: 110, strokes };
}
module.exports = { loadSamples, compose };
