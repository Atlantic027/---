const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
async function check(exe, serverOnly) {
  const verification = fs.mkdtempSync(path.join(root, '.verification-'));
  const userData = path.join(verification, 'user-data');
  const args = [`--verify-dir=${userData}`, ...(serverOnly ? ['--server-only'] : [])];
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(dist, exe), args, { cwd: dist, env, windowsHide: true, stdio: 'ignore' });
  let spawnError; child.on('error', error => { spawnError = error; });
  try {
    const start = Date.now();
    const readyPath = path.join(userData, 'ready.json');
    while (!fs.existsSync(readyPath)) {
      if (spawnError) throw spawnError;
      if (fs.existsSync(path.join(userData, 'failure.json'))) throw Error(fs.readFileSync(path.join(userData, 'failure.json'), 'utf8'));
      if (Date.now() - start > 60000) throw Error('portable readiness timed out');
      await delay(250);
    }
    const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
    assert.equal(ready.running, true); assert.equal(ready.packaged, true); assert.notEqual(ready.port, 8080);
    if (!serverOnly) {
      assert.equal(ready.renderer.node, 'undefined'); assert.equal(ready.renderer.require, 'undefined');
      assert.deepEqual(ready.renderer.keys.sort(), ['connectNetwork', 'getLocalAddresses', 'getServiceStatus', 'listNetworks']);
      assert.equal(ready.renderer.status.running, true);
      assert.equal(ready.renderer.teacherUi.url, ready.teacherUrl);
      assert.equal(ready.renderer.teacherUi.courseCodeVisible, true);
      assert.equal(ready.renderer.teacherUi.dashboardVisible, true);
    }
    assert.equal(ready.modelIncluded, true, `modelIncluded: ${JSON.stringify(ready)}`);
    assert.equal(ready.handwriting.available, true, `handwriting health: ${JSON.stringify(ready.handwriting)}`);
    assert.equal(ready.handwriting.status, 'available', `handwriting health: ${JSON.stringify(ready.handwriting)}`);
    const teacher = await fetch(ready.teacherUrl); assert.equal(teacher.status, 200); const teacherHtml = await teacher.text(); assert.match(teacherHtml, /教师控制台 v2/); assert.match(teacherHtml, /创建新课程/);
    const discovery = await (await fetch(`${ready.origin}/api/v2/discovery`)).json(); assert.equal(discovery.port, ready.port);
    const created = await fetch(`${ready.origin}/api/v2/courses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teacherName: '桌面隔离验证', title: 'EXE health test' }) });
    assert.equal(created.status, 201);
    const course = await created.json(); assert.match(course.courseCode, /^[A-Z0-9]{6}$/);
    const request = async (route, body, token) => {
      const response = await fetch(`${ready.origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
    };
    const base = `/api/v2/courses/${course.course.id}`;
    await request(`${base}/modes`, { type: 'arithmetic', enabled: true }, course.teacherToken);
    const command = await request(`${base}/classroom/commands`, { command: 'start_buzzer', durationSeconds: 10 }, course.teacherToken);
    assert.equal(command.classroom.mode, 'buzzer');
    const student = await request('/api/v2/courses/join', { courseCode: course.courseCode, studentName: 'Isolated model test' });
    const recognition = await request(`${base}/handwriting/recognize`, { width: 100, height: 100, strokes: [[{ x: 5, y: 5 }, { x: 55, y: 5 }, { x: 20, y: 95 }]] }, student.studentToken);
    assert.match(recognition.recognizedText, /^\d$/); assert.ok(recognition.confidence >= 0 && recognition.confidence <= 1); assert.equal(recognition.needsConfirmation, true);
    const health = await (await fetch(`${ready.origin}/api/desktop/health`)).json();
    assert.equal(health.modelIncluded, true);
    assert.equal(health.handwriting.available, true);
    assert.equal(health.handwriting.status, 'available');
    assert.equal(ready.scan.ok, true); assert.ok(ready.scan.networksCount > 0, 'real SSID scan must return networks');
    assert.equal(fs.existsSync(path.join(userData, 'data/v2-state.json')), true);
    fs.writeFileSync(path.join(userData, 'stop'), '');
    let stopped = false;
    for (let i = 0; i < 40; i++) {
      await delay(250);
      try { await fetch(ready.teacherUrl, { signal: AbortSignal.timeout(500) }); } catch { stopped = true; break; }
    }
    assert.equal(stopped, true, 'own service must stop');
    return { mode: serverOnly ? 'server-only' : 'window', ...ready, httpTeacher: 200, teacherV2: true, courseCreated: 201, courseCodeValid: true, teacherCommand: 'buzzer', recognition, handwriting: health.handwriting, persistence: true, stopped };
  } finally {
    if (fs.existsSync(userData)) fs.writeFileSync(path.join(userData, 'stop'), '');
    // Remove only this verifier's temporary data after the owned service exits.
    await delay(1000);
    if (child.exitCode === null) child.kill();
    fs.rmSync(verification, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
(async () => {
  const exe = `MAX35-Teacher-${require('../package.json').version}-with-model-x64.exe`;
  if (!exe) throw Error('portable EXE not found');
  const runs = [await check(exe, false), await check(exe, true)];
  const bytes = fs.readFileSync(path.join(dist, exe));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const result = { exe, bytes: bytes.length, sha256, checkedAt: new Date().toISOString(), modelIncluded: runs.every(run => run.modelIncluded === true), handwritingAvailable: runs.every(run => run.handwriting.available === true), cleanMachineWithoutNode: false, runs };
  assert.equal(result.modelIncluded, true);
  assert.equal(result.handwritingAvailable, true);
  fs.writeFileSync(path.join(dist, `${exe}.sha256`), `${sha256}  ${exe}\n`);
  fs.writeFileSync(path.join(dist, 'PORTABLE-HEALTH.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
