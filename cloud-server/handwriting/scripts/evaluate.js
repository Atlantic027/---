'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { recognize, initialize } = require('../index');
const { loadSamples, compose } = require('../tests/dataset');
async function main() {
  const start = performance.now();
  await initialize();
  const initializationMs = performance.now() - start;
  const samples = loadSamples();
  const perClass = Array.from({ length: 10 }, (_, digit) => ({ digit, correct: 0, total: 0 }));
  const predictions = [];
  const inferenceStart = performance.now();
  for (const sample of samples) {
    const result = await recognize({ width: 100, height: 100, strokes: [sample.stroke] });
    const correct = result.recognizedText === sample.label;
    perClass[Number(sample.label)].total++;
    perClass[Number(sample.label)].correct += Number(correct);
    predictions.push({ row: sample.row, expected: sample.label, ...result, correct });
  }
  const elapsedMs = performance.now() - inferenceStart;
  const layouts = [];
  // Fixed first 200 samples, before inspecting any predictions: 100 pairs.
  for (let i = 0; i < 200; i += 2) {
    for (const negative of [false, true]) {
      const pair = samples.slice(i, i + 2);
      const expected = (negative ? '-' : '') + pair.map(s => s.label).join('');
      const result = await recognize(compose(pair, negative));
      layouts.push({ rows: pair.map(s => s.row), expected, ...result, correct: result.recognizedText === expected });
    }
  }
  const summarize = rows => ({ correct: rows.filter(p => p.correct).length, total: rows.length, accuracy: rows.filter(p => p.correct).length / rows.length });
  const report = { runtime: { node: process.version, platform: process.platform, arch: process.arch, ort: require('../node_modules/onnxruntime-node/package.json').version },
    single: summarize(predictions), positivePairs: summarize(layouts.filter(r => !r.expected.startsWith('-'))), negativePairs: summarize(layouts.filter(r => r.expected.startsWith('-'))),
    perClass, timing: { initializationMs, singleTotalMs: elapsedMs, meanSingleMs: elapsedMs / samples.length },
    failures: predictions.filter(r => !r.correct).map(r => r.row), predictions, layouts };
  fs.writeFileSync(path.join(__dirname, '../tests/evaluation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, predictions: undefined, layouts: undefined, failures: report.failures.length }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
