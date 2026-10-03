const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { recognize, initialize } = require('../index');
const modelAvailable = fs.existsSync(require.resolve('../models/mnist-12.onnx'));

const stroke = (...points) => points.map(([x, y]) => ({ x, y }));
const samples = {
  one: [stroke([5, 5], [5, 95])],
  seven: [stroke([5, 5], [55, 5], [20, 95])],
  zero: [stroke([10, 10], [45, 5], [80, 10], [90, 50], [80, 90], [45, 95], [10, 90], [5, 50], [10, 10])]
};

test('rejects empty, malformed, and oversized input before model work', async () => {
  await assert.rejects(() => recognize({ width: 100, height: 100, strokes: [] }), { code: 'INVALID_HANDWRITING_INPUT' });
  await assert.rejects(() => recognize({ width: 1025, height: 100, strokes: samples.one }), { code: 'INVALID_HANDWRITING_INPUT' });
  await assert.rejects(() => recognize({ width: 100, height: 100, strokes: [[...Array(4097)].map(() => ({ x: 1, y: 1 }))] }), { code: 'INVALID_HANDWRITING_INPUT' });
});

test('independent handwritten sample fixtures run through the real local model', { skip: !modelAvailable ? 'MNIST model fixture is unavailable' : false }, async () => {
  await initialize();
  const result = await recognize({ width: 100, height: 100, strokes: samples.seven });
  assert.equal(typeof result.recognizedText, 'string'); assert.equal(result.needsConfirmation, true); assert.equal(result.digits.length, 1); assert.ok(result.confidence >= 0 && result.confidence <= 1);
});

test('UCI independent handwritten test split reports accuracy for all ten classes', { skip: !modelAvailable ? 'MNIST model fixture is unavailable' : false }, async () => {
  const lines = fs.readFileSync(require.resolve('../tests/fixtures/pendigits.tes'), 'utf8').trim().split(/\r?\n/);
  const first = new Map(); let correct = 0; let total = 0;
  for (const line of lines) {
    const values = line.split(',').map(Number); const label = values.pop();
    const strokePoints = []; for (let i = 0; i < values.length; i += 2) strokePoints.push({ x: values[i], y: 100 - values[i + 1] });
    const result = await recognize({ width: 100, height: 100, strokes: [strokePoints] });
    if (!first.has(label)) first.set(label, { expected: label, predicted: result.digits[0] });
    if (result.digits[0] === label) correct++; total++;
    if (total >= 300) break;
  }
  console.log(`UCI pendigits independent sample accuracy: ${correct}/${total} = ${(correct / total * 100).toFixed(2)}%; classes=${[...first.keys()].sort().join('')}`);
  assert.equal(first.size, 10); assert.ok(correct / total > 0.1, 'model must beat random baseline on real samples');
});

test('multi-digit and negative layouts are accepted', { skip: !modelAvailable ? 'MNIST model fixture is unavailable' : false }, async () => {
  const input = { width: 300, height: 100, strokes: [stroke([5, 50], [70, 50]), stroke([90, 10], [120, 5], [145, 10], [150, 50], [145, 90], [120, 95], [90, 90], [85, 50], [90, 10]), stroke([180, 10], [210, 5], [235, 10], [240, 50], [235, 90], [210, 95], [180, 90], [175, 50], [180, 10])] };
  const result = await recognize(input); assert.equal(result.needsConfirmation, true); assert.equal(result.recognizedText[0], '-');
});
