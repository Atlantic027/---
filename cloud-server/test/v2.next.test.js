const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'classroom-v2-next-'));
const net = require('node:net');
function reservePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(error => error ? reject(error) : resolve(port)); }); }); }
let port;
let child;
let base;
const headers = { 'content-type': 'application/json' };
async function wait() { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/teacher/session`)).ok) return; } catch (_) {} await new Promise(r => setTimeout(r, 30)); } throw new Error('server did not start'); }
async function request(method, url, body, token) { return fetch(base + url, { method, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); }
async function stopProcess(process) { if (!process || process.exitCode !== null) return; const exited = once(process, 'exit'); process.kill(); await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('child process did not exit')), 3000))]); }
after(async () => { await stopProcess(child); fs.rmSync(root, { recursive: true, force: true }); });

test('v2 course isolation, recovery, devices, classroom, practice, and photo ownership', { timeout: 30000 }, async () => {
  port = await reservePort(); base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: path.join(root, 'data'), UPLOAD_DIR: path.join(root, 'uploads'), TEACHER_TOKEN: 'legacy-teacher', DEVICE_TOKEN: 'legacy-device' };
  child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  await wait();
  let r = await request('GET', '/api/v2/discovery'); assert.deepEqual(Object.keys(await r.json()).sort(), ['name', 'port', 'protocol', 'service']);
  r = await request('POST', '/api/v2/courses', { teacherName: 'T1', title: 'One' }); const one = await r.json();
  r = await request('POST', '/api/v2/courses', { teacherName: 'T2', title: 'Two' }); const two = await r.json();
  r = await request('POST', '/api/v2/courses/recover', { courseCode: one.courseCode, teacherToken: one.teacherToken }); assert.equal(r.status, 200);
  assert.equal((await request('POST', '/api/v2/courses/recover', { courseCode: one.courseCode, teacherToken: two.teacherToken })).status, 401);
  r = await request('POST', '/api/v2/courses/join', { courseCode: one.courseCode, studentName: 'A', deviceId: 'pad-1' }); const a = await r.json(); assert.ok(a.deviceSecret);
  r = await request('POST', '/api/v2/courses/join', { courseCode: one.courseCode, studentName: 'B' }); const b = await r.json();
  assert.equal((await request('POST', '/api/v2/courses/join', { courseCode: one.courseCode, studentName: 'Impostor', deviceId: 'pad-1' })).status, 409);
  r = await request('POST', '/api/v2/courses/join', { courseCode: one.courseCode, studentName: 'A', deviceId: 'pad-1', deviceSecret: a.deviceSecret }); assert.equal(r.status, 200); const resumed = await r.json();
  assert.equal((await request('POST', `/api/v2/courses/${one.course.id}/heartbeat`, { deviceId: 'pad-1' }, resumed.studentToken)).status, 200);
  assert.equal((await request('POST', `/api/v2/courses/${one.course.id}/modes`, { type: 'vocabulary', enabled: true }, a.studentToken)).status, 403);
  assert.equal((await request('POST', '/api/v2/courses/recover', { courseCode: one.courseCode, teacherToken: a.studentToken })).status, 401);
  assert.equal((await request('PUT', `/api/v2/courses/${one.course.id}/devices/evil/bind`, { studentId: a.studentId }, a.studentToken)).status, 403);
  r = await request('POST', `/api/v2/courses/${one.course.id}/practice/next`, { modeType: 'vocabulary' }, a.studentToken); assert.equal(r.status, 201); const independentPractice = await r.json(); assert.equal(independentPractice.activity.practice, true); assert.equal(independentPractice.activity.question.options.length, 4);
  r = await request('POST', `/api/v2/courses/${one.course.id}/activities/${independentPractice.activity.id}/answers`, { answer: 0, clientEventId: 'independent-practice-answer' }, a.studentToken); assert.equal(r.status, 200);
  const practiceStats = await (await request('GET', `/api/v2/courses/${one.course.id}/stats`, undefined, one.teacherToken)).json(); assert.equal(practiceStats.stats.vocabulary.practice.attempted, 1); assert.equal(practiceStats.stats.vocabulary.students.find(row => row.studentId === a.studentId).practice.attempted, 1);
  const practiceMembers = await (await request('GET', `/api/v2/courses/${one.course.id}/members`, undefined, one.teacherToken)).json(); assert.equal(practiceMembers.members.find(row => row.id === a.studentId).stats.vocabulary.practice.attempted, 1);
  await request('POST', `/api/v2/courses/${one.course.id}/modes`, { type: 'vocabulary', enabled: true }, one.teacherToken);
  r = await request('POST', `/api/v2/courses/${one.course.id}/activities`, { modeType: 'vocabulary', question: { word: 'x', options: ['甲', '乙', '丙', '丁'], correctIndex: 0 } }, one.teacherToken); const currentId = (await r.json()).activity.id;
  for (const endpoint of ['home', 'current', 'stats', 'members', 'devices', 'classroom/state']) assert.equal((await request('GET', `/api/v2/courses/${one.course.id}/${endpoint}`, undefined, two.teacherToken)).status, 403);
  assert.equal((await request('POST', `/api/v2/courses/${one.course.id}/practice/next`, { modeType: 'vocabulary' }, b.studentToken)).status, 201);
  for (const endpoint of ['home', 'current', 'stats', 'members', 'devices', 'classroom/state']) { const method = endpoint === 'classroom/state' ? 'GET' : 'GET'; assert.equal((await request(method, `/api/v2/courses/${two.course.id}/${endpoint}`, undefined, a.studentToken)).status, 403); }
  r = await request('GET', `/api/v2/courses/${one.course.id}/current`, undefined, a.studentToken); const visibleCurrent = await r.json(); assert.equal(visibleCurrent.activity.id, currentId); assert.equal('correctIndex' in visibleCurrent.activity.question, false);
  assert.equal((await request('GET', `/api/v2/courses/${one.course.id}/current`, undefined, b.studentToken)).status, 200);
  r = await request('POST', `/api/v2/courses/${one.course.id}/practice/next`, { modeType: 'vocabulary' }, a.studentToken); assert.equal(r.status, 201); const practice2 = (await r.json()).activity;
  r = await request('GET', `/api/v2/courses/${one.course.id}/current`, undefined, a.studentToken); assert.equal((await r.json()).activity.id, currentId);
  assert.equal((await request('POST', `/api/v2/courses/${one.course.id}/activities/${practice2.id}/answers`, { answer: 0, clientEventId: 'other' }, b.studentToken)).status, 409);
  assert.equal((await request('POST', `/api/v2/courses/${one.course.id}/activities/${practice2.id}/answers`, { answer: 0, clientEventId: 'p2' }, a.studentToken)).status, 200);
  r = await request('POST', `/api/v2/courses/${one.course.id}/activities/${practice2.id}/answers`, { answer: 1, clientEventId: 'p2b' }, a.studentToken); assert.equal((await r.json()).duplicate, true);
  r = await request('GET', `/api/v2/courses/${one.course.id}/stats`, undefined, one.teacherToken); const beforeDisable = await r.json();
  await request('POST', `/api/v2/courses/${one.course.id}/modes`, { type: 'vocabulary', enabled: false }, one.teacherToken);
  assert.equal((await request('POST', `/api/v2/courses/${one.course.id}/activities/${currentId}/answers`, { answer: 1, clientEventId: 'disabled' }, a.studentToken)).status, 409);
  r = await request('GET', `/api/v2/courses/${one.course.id}/stats`, undefined, one.teacherToken); assert.deepEqual((await r.json()).stats, beforeDisable.stats);
  assert.equal((await request('POST', `/api/v2/courses/${one.course.id}/activities/${practice2.id}/answers`, { answer: 1, clientEventId: 'practice-while-disabled' }, a.studentToken)).status, 200);
  await request('POST', `/api/v2/courses/${one.course.id}/modes`, { type: 'vocabulary', enabled: true }, one.teacherToken);
  await request('POST', `/api/v2/courses/${one.course.id}/classroom/commands`, { command: 'start_buzzer', durationSeconds: 1 }, one.teacherToken);
  r = await request('GET', `/api/v2/courses/${one.course.id}/classroom/state`, undefined, a.studentToken); const classroom = await r.json(); assert.equal(classroom.classroom.mode, 'buzzer');
  assert.equal((await request('POST', `/api/v2/courses/${two.course.id}/classroom/commands`, { command: 'start_photo' }, one.teacherToken)).status, 403);
  await new Promise(r => setTimeout(r, 1100)); assert.equal((await request('POST', `/api/v2/courses/${one.course.id}/classroom/buzz`, { roundId: classroom.classroom.roundId, clientSeq: 1 }, a.studentToken)).status, 409);
  await request('POST', `/api/v2/courses/${one.course.id}/classroom/commands`, { command: 'start_photo' }, one.teacherToken);
  const form = new FormData(); form.set('clientSeq', '1'); form.set('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'one.jpg');
  r = await fetch(`${base}/api/v2/courses/${one.course.id}/classroom/photo`, { method: 'POST', headers: { authorization: `Bearer ${a.studentToken}` }, body: form }); assert.equal(r.status, 200); const photo = await r.json();
  assert.equal('path' in photo, false);
  assert.equal((await fetch(`${base}/uploads/v2/${one.course.id}/anything`, { headers: { authorization: `Bearer ${a.studentToken}` } })).status, 403);
  assert.equal((await fetch(`${base}${photo.url}`, { headers: { authorization: `Bearer ${a.studentToken}` } })).status, 200);
  assert.ok([403, 404].includes((await fetch(`${base}/api/v2/courses/${two.course.id}/classroom/photos/${photo.id}`, { headers: { authorization: `Bearer ${two.teacherToken}` } })).status));
  assert.equal((await fetch(`${base}/api/v2/courses/${two.course.id}/classroom/photos/${photo.id}`, { headers: { authorization: `Bearer ${a.studentToken}` } })).status, 403);
  const invalidForm = new FormData(); invalidForm.set('clientSeq', '2'); invalidForm.set('photo', new Blob(['not an image'], { type: 'image/jpeg' }), 'bad.jpg');
  assert.equal((await fetch(`${base}/api/v2/courses/${one.course.id}/classroom/photo`, { method: 'POST', headers: { authorization: `Bearer ${a.studentToken}` }, body: invalidForm })).status, 400);
  const uploadDir = path.join(root, 'uploads', 'v2', one.course.id);
  assert.equal(fs.readdirSync(uploadDir).filter(file => file.endsWith('.upload')).length, 0);
  const oversizedForm = new FormData(); oversizedForm.set('clientSeq', '3'); oversizedForm.set('photo', new Blob([Buffer.alloc(8 * 1024 * 1024 + 1)], { type: 'image/jpeg' }), 'large.jpg');
  assert.equal((await fetch(`${base}/api/v2/courses/${one.course.id}/classroom/photo`, { method: 'POST', headers: { authorization: `Bearer ${a.studentToken}` }, body: oversizedForm })).status, 413);
  assert.equal(fs.readdirSync(uploadDir).filter(file => file.endsWith('.upload')).length, 0);
  const annotation = await (await request('POST', `/api/v2/courses/${one.course.id}/annotations`, { targetType: 'photo', targetId: photo.id, content: '构图清楚，请补充第二步计算过程。' }, one.teacherToken)).json(); assert.equal(annotation.annotation.targetId, photo.id);
  r = await request('GET', `/api/v2/courses/${one.course.id}/annotations`, undefined, one.teacherToken); assert.equal((await r.json()).annotations.length, 1);
  assert.equal((await request('GET', `/api/v2/courses/${one.course.id}/annotations`, undefined, a.studentToken)).status, 403);
  r = await request('GET', `/api/v2/courses/${one.course.id}/learning-insights`, undefined, one.teacherToken); assert.equal((await r.json()).method, 'local-rule-based');
});

test('v2 handwriting recognition and confirmed arithmetic strokes', { timeout: 30000 }, async () => {
  const created = await (await request('POST', '/api/v2/courses', { teacherName: 'Math teacher', title: 'Writing' })).json();
  const student = await (await request('POST', '/api/v2/courses/join', { courseCode: created.courseCode, studentName: 'Writer' })).json();
  const id = created.course.id;
  const stroke = [{ x: 5, y: 5 }, { x: 5, y: 95 }];
  const input = { width: 100, height: 100, strokes: [stroke] };

  assert.equal((await request('POST', `/api/v2/courses/${id}/handwriting/recognize`, { ...input, strokes: [[{ x: -1, y: 5 }]] }, student.studentToken)).status, 400);
  const recognition = await request('POST', `/api/v2/courses/${id}/handwriting/recognize`, input, student.studentToken);
  if (recognition.status === 503) {
    assert.equal((await recognition.json()).error, 'handwriting recognition is unavailable');
    return;
  }
  assert.equal(recognition.status, 200);
  const recognized = await recognition.json();
  assert.deepEqual(Object.keys(recognized).sort(), ['confidence', 'digits', 'needsConfirmation', 'recognizedText']);
  assert.equal(recognized.needsConfirmation, true);

  const practice = await (await request('POST', `/api/v2/courses/${id}/practice/next`, { modeType: 'arithmetic' }, student.studentToken)).json();
  const expression = practice.activity.question.expression.match(/^(\d+) ([+*\-/]) (\d+)$/);
  const [, left, operator, right] = expression;
  const value = operator === '+' ? Number(left) + Number(right) : operator === '-' ? Number(left) - Number(right) : operator === '*' ? Number(left) * Number(right) : Number(left) / Number(right);
  const activityId = practice.activity.id;
  const unconfirmed = await request('POST', `/api/v2/courses/${id}/activities/${activityId}/answers`, { answer: { type: 'stroke', ...input }, clientEventId: 'stroke-unconfirmed' }, student.studentToken);
  assert.equal(unconfirmed.status, 400);
  const confirmedBody = { answer: { type: 'stroke', ...input, value }, clientEventId: 'stroke-confirmed' };
  const confirmed = await request('POST', `/api/v2/courses/${id}/activities/${activityId}/answers`, confirmedBody, student.studentToken);
  if (confirmed.status === 409) {
    assert.equal((await confirmed.json()).error, 'handwriting recognition requires confirmation');
    return;
  }
  assert.equal(confirmed.status, 200);
  const result = await confirmed.json();
  assert.equal(result.answer, value);
  assert.equal('strokes' in result, false);
  const duplicate = await request('POST', `/api/v2/courses/${id}/activities/${activityId}/answers`, { ...confirmedBody, answer: { type: 'stroke', ...input, value: value + 1 } }, student.studentToken);
  assert.equal((await duplicate.json()).duplicate, true);
  const stats = await (await request('GET', `/api/v2/courses/${id}/stats`, undefined, created.teacherToken)).json();
  assert.equal(stats.stats.arithmetic.attempted, 1);
  await request('POST', `/api/v2/courses/${id}/modes`, { type: 'arithmetic', enabled: false }, created.teacherToken);
  assert.equal((await request('POST', `/api/v2/courses/${id}/practice/next`, { modeType: 'arithmetic' }, student.studentToken)).status, 201);
});
