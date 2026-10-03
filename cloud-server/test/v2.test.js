const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'classroom-v2-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, PORT: String(port), DATA_DIR: path.join(root, 'data'), UPLOAD_DIR: path.join(root, 'uploads'), TEACHER_TOKEN: 'legacy-teacher', DEVICE_TOKEN: 'legacy-device' };
let child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const json = { 'content-type': 'application/json' };
async function wait() { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/teacher/session`)).ok) return; } catch (_) {} await new Promise(r => setTimeout(r, 30)); } throw new Error('server did not start'); }
async function request(method, url, body, token) { return fetch(`${base}${url}`, { method, headers: { ...json, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); }
async function stopProcess(process) {
  if (!process || process.exitCode !== null) return;
  const exited = once(process, 'exit');
  process.kill();
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('child process did not exit')), 3000))]);
}
async function stop() { await stopProcess(child); }
after(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); });

test('v2 multi-classroom workflow, permissions, idempotency, and restart recovery', { timeout: 30000 }, async () => {
  await wait();
  let r = await request('POST', '/api/v2/courses', { teacherName: 'Teacher', title: 'Math' });
  assert.equal(r.status, 201); let made = await r.json();
  assert.match(made.courseCode, /^[A-Z0-9]{6}$/); const courseId = made.course.id;
  const teacher = made.teacherToken;
  r = await request('POST', '/api/v2/courses/join', { courseCode: made.courseCode, studentName: 'Alice', deviceId: 'tablet-1' });
  assert.equal(r.status, 201); const student = await r.json();
  assert.equal((await request('POST', '/api/v2/courses/join', { courseCode: made.courseCode, studentName: 'Bob', deviceId: 'tablet-1' })).status, 409);
  assert.equal((await request('POST', `/api/v2/courses/${courseId}/modes`, { type: 'vocabulary', enabled: true }, student.studentToken)).status, 403);
  r = await request('POST', `/api/v2/courses/${courseId}/activities`, { modeType: 'vocabulary', question: { word: 'apple', options: [' 苹果 ', '香蕉', '梨', '桃'], correctIndex: 0, solution: 'hidden', answerKey: 0, expectedOption: '苹果' } }, teacher);
  assert.equal(r.status, 201); const vocabularyResponse = await r.json(); const vocabulary = vocabularyResponse.activity;
  assert.equal(vocabularyResponse.currentActivity.question.correctIndex, 0);
  assert.equal(vocabularyResponse.currentActivity.question.options.length, 4);
  assert.equal(vocabularyResponse.currentActivity.question.correctIndex, 0);
  r = await request('GET', `/api/v2/courses/${courseId}/current`, undefined, student.studentToken); assert.equal(r.status, 200);
  const studentCurrent = await r.json(); assert.equal('correctIndex' in studentCurrent.activity.question, false);
  assert.equal('solution' in studentCurrent.activity.question, false); assert.equal('answerKey' in studentCurrent.activity.question, false); assert.equal('expectedOption' in studentCurrent.activity.question, false);
  assert.equal((await request('GET', `/api/v2/courses/${courseId}/home`, undefined, student.studentToken)).status, 200);
  r = await request('POST', `/api/v2/courses/${courseId}/activities/${vocabulary.id}/answers`, { answer: 0, clientEventId: 'one' }, student.studentToken); const firstAnswer = await r.json(); assert.equal(firstAnswer.correct, true);
  r = await request('POST', `/api/v2/courses/${courseId}/activities/${vocabulary.id}/answers`, { answer: 2, clientEventId: 'one' }, student.studentToken); const duplicateActivity = await r.json(); assert.equal(duplicateActivity.correct, true); assert.equal(duplicateActivity.answer, 0); assert.equal(duplicateActivity.duplicate, true);
  r = await request('POST', `/api/v2/courses/${courseId}/activities`, { modeType: 'vocabulary', question: { word: 'cat', options: ['猫', '狗', '鸟', '鱼'], correctIndex: 2 } }, teacher); const indexedVocabulary = (await r.json()).activity;
  r = await request('POST', `/api/v2/courses/${courseId}/activities/${indexedVocabulary.id}/answers`, { answer: 'C', clientEventId: 'index-normalization' }, student.studentToken); assert.equal((await r.json()).correct, true);
  r = await request('POST', `/api/v2/courses/${courseId}/activities`, { modeType: 'vocabulary', question: { word: 'zero', options: ['zero', 'one', 'two', 'three'], correctIndex: 0 } }, teacher); const strictVocabulary = (await r.json()).activity;
  assert.equal((await request('POST', `/api/v2/courses/${courseId}/activities/${strictVocabulary.id}/answers`, { answer: '1', clientEventId: 'invalid-string-index' }, student.studentToken)).status, 400);
  assert.equal((await request('POST', `/api/v2/courses/${courseId}/activities/${strictVocabulary.id}/answers`, { answer: 4, clientEventId: 'invalid-index' }, student.studentToken)).status, 400);
  r = await request('POST', `/api/v2/courses/${courseId}/activities/${strictVocabulary.id}/answers`, { answer: 1, clientEventId: 'strict-one' }, student.studentToken); assert.equal((await r.json()).correct, false);
  assert.equal((await request('POST', `/api/v2/courses/${courseId}/activities`, { modeType: 'vocabulary', question: { word: 'bad', options: ['a', 'b', 'c', 'd'], correctIndex: 4 } }, teacher)).status, 400);
  assert.equal((await request('POST', `/api/v2/courses/${courseId}/modes`, { type: 'vocabulary', enabled: false }, teacher)).status, 200);
  r = await request('GET', `/api/v2/courses/${courseId}/current`, undefined, student.studentToken); assert.equal((await r.json()).activity, null);
  assert.equal((await request('POST', `/api/v2/courses/${courseId}/activities/${strictVocabulary.id}/answers`, { answer: 0, clientEventId: 'disabled' }, student.studentToken)).status, 409);
  assert.equal((await request('POST', `/api/v2/courses/${courseId}/modes`, { type: 'vocabulary', enabled: true }, teacher)).status, 200);
  r = await request('POST', `/api/v2/courses/${courseId}/activities/${strictVocabulary.id}/answers`, { answer: 0, clientEventId: 'reenabled' }, student.studentToken); const reenabledResult = await r.json(); assert.equal(reenabledResult.correct, false); assert.equal(reenabledResult.duplicate, true);
  r = await request('POST', `/api/v2/courses/${courseId}/activities`, { modeType: 'arithmetic', expression: '7 * 6' }, teacher);
  const arithmetic = (await r.json()).activity;
  r = await request('POST', `/api/v2/courses/${courseId}/activities/${arithmetic.id}/answers`, { answer: 42, clientEventId: 'math' }, student.studentToken); assert.equal((await r.json()).correct, true);
  assert.equal((await request('GET', `/api/v2/courses/${courseId}/stats`, undefined, student.studentToken)).status, 403);
  r = await request('GET', `/api/v2/courses/${courseId}/stats`, undefined, teacher); const statistics = await r.json(); assert.equal(statistics.stats.vocabulary.attempted, 3); assert.equal(statistics.stats.vocabulary.correct, 2);
  assert.equal((await request('PUT', `/api/v2/courses/${courseId}/devices/tablet-2/bind`, { studentId: student.studentId }, teacher)).status, 200);
  assert.equal((await request('GET', `/api/v2/courses/${courseId}/members`, undefined, teacher)).status, 200);
  await stop(); child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }); await wait();
  r = await request('GET', `/api/v2/courses/${courseId}/home`, undefined, teacher); assert.equal(r.status, 200); assert.equal((await r.json()).course.courseCode, made.courseCode);
  const v2StateFile = path.join(env.DATA_DIR, 'v2-state.json'); const legacyState = JSON.parse(fs.readFileSync(v2StateFile, 'utf8')); delete legacyState.courses[courseId].members; fs.writeFileSync(v2StateFile, JSON.stringify(legacyState));
  await stop(); child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }); await wait();
  r = await request('GET', `/api/v2/courses/${courseId}/stats`, undefined, teacher); assert.equal(r.status, 200); assert.equal((await r.json()).stats.vocabulary.attempted, 0);
});
