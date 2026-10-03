const path = require('node:path');
const { app } = require('electron');
const resourcePath = () => app.isPackaged ? path.join(process.resourcesPath, 'handwriting') : path.join(__dirname, '../resources/handwriting');
let implementation;
let health = { status: 'unavailable', available: false, error: 'NOT_INITIALIZED' };
async function initialize() {
  try {
    implementation = require(resourcePath());
    await implementation.initialize();
    // Health includes actual inference, not just presence of an ONNX file.
    const result = await implementation.recognize({ width: 100, height: 100, strokes: [[{ x: 5, y: 5 }, { x: 55, y: 5 }, { x: 20, y: 95 }]] });
    if (!/^\d$/.test(result.recognizedText) || !Number.isFinite(result.confidence)) throw Error('INVALID_INFERENCE_RESULT');
    health = { status: 'available', available: true, runtime: 'onnxruntime-node 1.30.0', provider: 'cpu', inference: result };
  } catch (error) {
    implementation = undefined;
    health = { status: 'unavailable', available: false, error: error.code || 'MODEL_INITIALIZATION_FAILED', detail: error.message };
  }
  return getHealth();
}
function getHealth() { return { ...health }; }
async function recognize(input) {
  if (!health.available || !implementation) throw Object.assign(Error('handwriting unavailable'), { code: 'HANDWRITING_UNAVAILABLE' });
  return implementation.recognize(input);
}
module.exports = { initialize, recognize, getHealth };
