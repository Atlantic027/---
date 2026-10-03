const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'classroom-'));
const port = 12000 + Math.floor(Math.random() * 30000);
const env = { ...process.env, PORT: String(port), DATA_DIR: path.join(root, 'data'), UPLOAD_DIR: path.join(root, 'uploads'), DEVICE_TOKEN: 'test-device', TEACHER_TOKEN: 'test-teacher' };
let child = spawn(process.execPath, ['server.js'], { cwd: __dirname + '/..', env, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const headers = { 'content-type': 'application/json', 'x-device-token': 'test-device' };
const teacher = { 'content-type': 'application/json', 'x-teacher-token': 'test-teacher' };
async function waitServer() { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/teacher/session`)).ok) return; } catch (_) {} await new Promise(r => setTimeout(r, 50)); } throw new Error('server did not start'); }
async function post(url, body, h = headers) { return fetch(`${base}${url}`, { method: 'POST', headers: h, body: JSON.stringify(body) }); }
async function stopProcess(process) {
  if (!process || process.exitCode !== null) return;
  const exited = once(process, 'exit');
  process.kill();
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('child process did not exit')), 3000))]);
}
async function stopServer() { await stopProcess(child); }
after(async () => { await stopServer(); fs.rmSync(root, { recursive: true, force: true }); });

test('HTTP classroom workflow, persistence, upload, auth, and websocket snapshots', { timeout: 30000 }, async () => {
  await waitServer();
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers })).status, 200);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'x-device-token': 'test-device' } });
  const [, firstMessage] = await Promise.all([once(ws, 'open'), once(ws, 'message')]);
  const initial = JSON.parse(firstMessage[0].toString());
  assert.equal(initial.type, 'state'); assert.ok(Array.isArray(initial.state.devices));

  await post('/api/device/heartbeat', { deviceId: 'one', name: 'One' });
  let r = await post('/api/teacher/question', { text: 'Pick?', options: ['A', 'B', 'C', 'D'] }, teacher);
  assert.equal(r.status, 200); let state = await r.json(); const questionId = state.question.id;
  r = await post('/api/device/answer', { deviceId: 'one', questionId: 'old', answer: 'A', clientSeq: 1 }); assert.equal(r.status, 409);
  r = await post('/api/device/answer', { deviceId: 'one', questionId, answer: 'B', clientSeq: 1 }); assert.equal((await r.json()).accepted, true);
  r = await post('/api/device/answer', { deviceId: 'one', questionId, answer: 'C', clientSeq: 2 }); assert.equal((await r.json()).duplicate, true);
  state = await (await fetch(`${base}/api/state`, { headers })).json(); assert.equal(state.answers.length, 1); assert.equal(state.answers[0].answer, 'B');

  r = await post('/api/teacher/mode', { mode: 'buzzer' }, teacher); state = await r.json(); const roundId = state.roundId;
  assert.match(state.roundStartedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(state.roundDeadlineAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(Date.parse(state.roundDeadlineAt) - Date.parse(state.roundStartedAt), 10000);
  assert.ok(Date.parse(state.serverNow) >= Date.parse(state.roundStartedAt));
  const initialClock = Date.parse(state.serverNow);
  await new Promise(resolve => setTimeout(resolve, 150));
  const later = await (await fetch(`${base}/api/state`, { headers })).json();
  assert.ok(Date.parse(later.serverNow) > initialClock);
  assert.equal(later.roundDeadlineAt, state.roundDeadlineAt);
  assert.ok(Date.parse(later.roundDeadlineAt) - Date.parse(later.serverNow) < 10000);
  const race = await Promise.all(['one', 'two'].map(deviceId => post('/api/device/buzz', { deviceId, roundId, clientSeq: 1 })));
  const results = await Promise.all(race.map(x => x.json())); assert.equal(results.filter(x => x.accepted).length, 1);
  const winner = results.find(x => x.accepted).winner;
  const duplicate = await (await post('/api/device/buzz', { deviceId: winner.deviceId, roundId, clientSeq: 1 })).json(); assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.accepted, true);
  const loser = ['one', 'two'].find(id => id !== winner.deviceId);
  const loserDuplicate = await (await post('/api/device/buzz', { deviceId: loser, roundId, clientSeq: 99 })).json();
  assert.equal(loserDuplicate.duplicate, true); assert.equal(loserDuplicate.accepted, false);
  const winnerBeforeExpiry = winner.deviceId;

  await stopServer();
  child = spawn(process.execPath, ['server.js'], { cwd: __dirname + '/..', env, stdio: 'ignore' });
  await waitServer();
  const restoredBuzzer = await (await fetch(`${base}/api/state`, { headers })).json();
  assert.equal(restoredBuzzer.mode, 'buzzer'); assert.equal(restoredBuzzer.buzzWinner.deviceId, winner.deviceId);
  assert.equal(restoredBuzzer.roundDeadlineAt, state.roundDeadlineAt);
  r = await post('/api/device/buzz', { deviceId: winner.deviceId, roundId, clientSeq: 44 });
  const restoredDuplicate = await r.json(); assert.equal(restoredDuplicate.duplicate, true); assert.equal(restoredDuplicate.accepted, true);

  await post('/api/teacher/mode', { mode: 'photo' }, teacher);
  const form = new FormData(); form.set('deviceId', 'one'); form.set('clientSeq', '8'); form.set('photo', new Blob([Buffer.from([0xff,0xd8,0xff,0xdb])], { type: 'image/jpeg' }), 'a.jpg');
  r = await fetch(`${base}/api/device/photo`, { method: 'POST', headers: { 'x-device-token': 'test-device' }, body: form }); assert.equal(r.status, 200); const photo = await r.json(); assert.equal(photo.ok, true);
  const repeated = new FormData(); repeated.set('deviceId', 'one'); repeated.set('clientSeq', '8'); repeated.set('photo', new Blob([Buffer.from([0xff,0xd8,0xff,0xdb])], { type: 'image/jpeg' }), 'repeat.jpg');
  r = await fetch(`${base}/api/device/photo`, { method: 'POST', headers: { 'x-device-token': 'test-device' }, body: repeated }); assert.equal((await r.json()).duplicate, true);
  const bad = new FormData(); bad.set('deviceId', 'one'); bad.set('clientSeq', '9'); bad.set('photo', new Blob(['not image'], { type: 'image/jpeg' }), 'bad.jpg');
  r = await fetch(`${base}/api/device/photo`, { method: 'POST', headers: { 'x-device-token': 'test-device' }, body: bad }); assert.equal(r.status, 400);
  assert.equal(fs.readdirSync(path.join(root, 'uploads')).filter(x => x.endsWith('.tmp')).length, 0);
  ws.close();
  const restored = await (await fetch(`${base}/api/state`, { headers })).json(); assert.equal(restored.photos.length, 1); assert.equal(restored.buzzWinner.deviceId, winner.deviceId);
  await post('/api/teacher/reset', {}, teacher);
  r = await post('/api/teacher/mode', { mode: 'quiz' }, teacher); assert.equal(r.status, 409);
  r = await post('/api/teacher/login', { token: 'test-teacher' }); assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  r = await fetch(`${base}/api/teacher/session`, { headers: { cookie } }); const session = await r.json(); assert.equal(session.authRequired, true); assert.equal(session.authenticated, true);
  const teacherWs = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { cookie } });
   await Promise.all([once(teacherWs, 'open'), once(teacherWs, 'message')]);
  r = await post('/api/teacher/reset', {}, { cookie, 'content-type': 'application/json' }); assert.equal(r.status, 200);
   const closed = once(teacherWs, 'close');
   r = await post('/api/teacher/logout', {}, { cookie, 'content-type': 'application/json' }); assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
   await closed; assert.equal(teacherWs.readyState, WebSocket.CLOSED);
  assert.equal((await (await fetch(`${base}/api/teacher/session`, { headers: { cookie } })).json()).authenticated, false);

  r = await post('/api/teacher/mode', { mode: 'buzzer' }, teacher);
  state = await r.json();
  const expiryRoundId = state.roundId;
  const beforeExpiry = await (await post('/api/device/buzz', { deviceId: 'one', roundId: expiryRoundId, clientSeq: 100 })).json();
  assert.equal(beforeExpiry.accepted, true);
  await new Promise(resolve => setTimeout(resolve, 10100));
  const expired = await post('/api/device/buzz', { deviceId: 'two', roundId: expiryRoundId, clientSeq: 101 });
  assert.equal(expired.status, 409);
  assert.equal((await expired.json()).error, 'buzzer round has expired');
  state = await (await fetch(`${base}/api/state`, { headers })).json();
  assert.equal(state.buzzWinner.deviceId, 'one');
  assert.equal(state.buzzes.length, 1);
  assert.equal(state.buzzWinner.deviceId === winnerBeforeExpiry || state.buzzWinner.deviceId === 'one', true);
});

test('teacher session reports disabled authentication in local mode', { timeout: 10000 }, async () => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'classroom-local-'));
  const localPort = port + 1;
  const localEnv = { ...env, PORT: String(localPort), DATA_DIR: path.join(localRoot, 'data'), UPLOAD_DIR: path.join(localRoot, 'uploads'), TEACHER_TOKEN: '' };
  const localChild = spawn(process.execPath, ['server.js'], { cwd: __dirname + '/..', env: localEnv, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100; i++) { try { const response = await fetch(`http://127.0.0.1:${localPort}/api/teacher/session`); if (response.ok) { const body = await response.json(); assert.equal(body.authRequired, false); assert.equal(body.authenticated, true); return; } } catch (_) {} await new Promise(r => setTimeout(r, 50)); }
    throw new Error('local server did not start');
  } finally {
    await stopProcess(localChild);
    fs.rmSync(localRoot, { recursive: true, force: true });
  }
});
