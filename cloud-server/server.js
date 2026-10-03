const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const mountClassroomV2 = require('./classroom-v2');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
const PORT = Number(process.env.PORT || 8080);
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'local-mvp-device-token';
const TEACHER_TOKEN = process.env.TEACHER_TOKEN || '';
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const MAX_STRING = 500;
const MAX_RECORDS = 1000;
const ONLINE_MS = 60000;
const TEACHER_SESSION_MS = 43200 * 1000;
const configuredRushSeconds = Number(process.env.RUSH_COUNTDOWN_SECONDS);
const RUSH_COUNTDOWN_SECONDS = Number.isFinite(configuredRushSeconds) ? Math.min(120, Math.max(1, Math.trunc(configuredRushSeconds))) : 10;
const sessions = new Map();
const devices = new Map();
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function emptyState() {
  return { mode: 'idle', question: null, roundId: crypto.randomUUID(), roundStartedAt: null, roundDeadlineAt: null, buzzWinner: null, answers: [], buzzes: [], photos: [], updatedAt: new Date().toISOString() };
}
function boundedArray(value) { return Array.isArray(value) ? value.slice(-MAX_RECORDS) : []; }
function loadState() {
  try {
    const old = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const restored = { ...emptyState(), ...old, answers: boundedArray(old.answers), buzzes: boundedArray(old.buzzes), photos: boundedArray(old.photos), roundId: typeof old.roundId === 'string' ? old.roundId : crypto.randomUUID(), buzzWinner: old.buzzWinner || null };
    if (restored.mode !== 'buzzer') { restored.roundStartedAt = null; restored.roundDeadlineAt = null; }
    return restored;
  } catch (_) { return emptyState(); }
}
let state = loadState();
function now() { return new Date().toISOString(); }
function saveState() {
  const temporary = `${STATE_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
    fs.renameSync(temporary, STATE_FILE);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function publicDevices() {
  const current = Date.now();
  return Array.from(devices.values()).map(d => ({ ...d, online: current - Date.parse(d.lastSeen) <= ONLINE_MS })).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}
function snapshot() {
  // Do not hand callers references to the live state (in particular buzzWinner).
  return JSON.parse(JSON.stringify({ ...state, serverNow: now(), answers: [...state.answers], buzzes: [...state.buzzes], photos: [...state.photos], devices: publicDevices() }));
}
function broadcastState() { const payload = JSON.stringify({ type: 'state', state: snapshot() }); for (const client of wss.clients) if (client.readyState === 1) client.send(payload); }
function changed(type, payload = {}) { state.updatedAt = now(); saveState(); try { fs.appendFileSync(EVENTS_FILE, `${JSON.stringify({ type, ...payload, createdAt: now() })}\n`); } catch (_) {} broadcastState(); }
function fail(res, status, error) { return res.status(status).json({ error }); }
function requireDevice(req, res, next) { if (req.get('X-Device-Token') !== DEVICE_TOKEN) return fail(res, 401, 'invalid device token'); next(); }
function sessionId(req) {
  const value = req.get('cookie')?.match(/(?:^|;\s*)teacher_session=([^;]+)/)?.[1];
  return value ? decodeURIComponent(value) : null;
}
function closeSession(sid) {
  const session = sessions.get(sid);
  if (!session) return;
  sessions.delete(sid);
  for (const ws of session.websockets) ws.close(1000, 'session closed');
  session.websockets.clear();
}
function getTeacherSession(sid) {
  const session = sid && sessions.get(sid);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { closeSession(sid); return null; }
  return session;
}
function hasTeacherSession(req) { return !!getTeacherSession(sessionId(req)); }
function requireTeacher(req, res, next) {
  if (!TEACHER_TOKEN || hasTeacherSession(req) || req.get('X-Teacher-Token') === TEACHER_TOKEN) return next();
  return fail(res, 401, 'teacher authentication required');
}
const app = express();
app.use(express.json({ limit: '64kb' }));
mountClassroomV2(app, { dataDir: DATA_DIR, uploadDir: UPLOAD_DIR, port: PORT });
app.use(express.static(path.join(ROOT, 'public')));
app.post('/api/teacher/login', (req, res) => {
  if (!TEACHER_TOKEN || typeof req.body.token !== 'string' || req.body.token !== TEACHER_TOKEN) return fail(res, 401, 'invalid teacher token');
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { expiresAt: Date.now() + TEACHER_SESSION_MS, websockets: new Set() });
  res.set('Set-Cookie', `teacher_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`).json({ ok: true });
});
app.get('/api/teacher/session', (req, res) => res.json({ authRequired: !!TEACHER_TOKEN, authenticated: !TEACHER_TOKEN || !!hasTeacherSession(req) }));
app.post('/api/teacher/logout', (req, res) => { const sid = sessionId(req); if (sid) closeSession(sid); res.set('Set-Cookie', 'teacher_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT').json({ ok: true }); });
app.get('/api/state', (req, res) => {
  if (TEACHER_TOKEN && !hasTeacherSession(req) && req.get('X-Device-Token') !== DEVICE_TOKEN && req.get('X-Teacher-Token') !== TEACHER_TOKEN) return fail(res, 401, 'authentication required');
  res.json(snapshot());
});
app.post('/api/device/heartbeat', requireDevice, (req, res) => {
  const id = String(req.body.deviceId || req.body.device_id || req.body.id || '').trim();
  const name = String(req.body.name || id).trim();
  if (!id || id.length > 100 || !name || name.length > MAX_STRING) return fail(res, 400, 'valid deviceId and name are required');
  const device = { id, name, lastSeen: now(), ip: req.ip };
  devices.set(id, device); state.updatedAt = now(); saveState(); broadcastState();
  res.json({ ok: true, device, state: snapshot() });
});
app.post('/api/device/answer', requireDevice, (req, res) => {
  const { deviceId, questionId, clientSeq } = req.body;
  const answer = String(req.body.answer || '').toUpperCase();
  if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 100 || !Number.isSafeInteger(clientSeq) || !['A', 'B', 'C', 'D'].includes(answer)) return fail(res, 400, 'deviceId, integer clientSeq, and answer A-D are required');
  if (state.mode !== 'quiz' || !state.question || questionId !== state.question.id) return fail(res, 409, 'question is not active');
  let event = state.answers.find(x => x.deviceId === deviceId && x.questionId === questionId);
  const duplicate = !!event;
  if (!event) { event = { deviceId, questionId, answer, clientSeq, receivedAt: now() }; state.answers.push(event); state.answers = boundedArray(state.answers); changed('answer', { event }); }
  res.json({ ok: true, accepted: !duplicate, duplicate, event });
});
app.post('/api/device/buzz', requireDevice, (req, res) => {
  const { deviceId, roundId, clientSeq } = req.body;
  if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 100 || typeof roundId !== 'string' || !Number.isSafeInteger(clientSeq)) return fail(res, 400, 'deviceId, roundId, and integer clientSeq are required');
  if (state.mode !== 'buzzer' || roundId !== state.roundId) return fail(res, 409, 'buzzer round is not active');
  const deadline = Date.parse(state.roundDeadlineAt);
  if (!Number.isFinite(deadline) || Date.now() >= deadline) return fail(res, 409, 'buzzer round has expired');
  let event = state.buzzes.find(x => x.deviceId === deviceId && x.roundId === roundId);
  if (event) {
    const isWinner = !!state.buzzWinner && state.buzzWinner.deviceId === event.deviceId && state.buzzWinner.roundId === event.roundId;
    return res.json({ ok: true, accepted: isWinner, duplicate: true, winner: state.buzzWinner });
  }
  event = { deviceId, name: devices.get(deviceId)?.name || deviceId, roundId, clientSeq, receivedAt: now() };
  state.buzzes.push(event); state.buzzes = boundedArray(state.buzzes);
  const accepted = state.buzzWinner === null;
  if (accepted) state.buzzWinner = event;
  changed('buzz', { event, accepted });
  res.json({ ok: true, accepted, duplicate: false, winner: state.buzzWinner });
});
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename(req, file, cb) {
      const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.tmp`;
      (req._uploadPaths ||= []).push(path.join(UPLOAD_DIR, filename));
      cb(null, filename);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 }
});
app.post('/api/device/photo', requireDevice, upload.single('photo'), (req, res) => {
  if (!req.file) return fail(res, 400, 'JPEG or PNG photo is required');
  try {
    const deviceId = String(req.body.deviceId || '').trim();
    const clientSeq = Number(req.body.clientSeq);
    if (!deviceId || deviceId.length > 100 || !Number.isSafeInteger(clientSeq)) return fail(res, 400, 'deviceId and integer clientSeq are required');
    if (state.mode !== 'photo') return fail(res, 409, 'photo mode is not active');
    const duplicate = state.photos.find(x => x.deviceId === deviceId && x.clientSeq === clientSeq);
    if (duplicate) return res.json({ ok: true, ...duplicate, duplicate: true });
    const fd = fs.openSync(req.file.path, 'r'); const header = Buffer.alloc(8); const count = fs.readSync(fd, header, 0, 8, 0); fs.closeSync(fd);
    const png = count >= 8 && header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = count >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    if (!png && !jpeg) return fail(res, 400, 'file content is not JPEG or PNG');
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${png ? '.png' : '.jpg'}`;
    fs.renameSync(req.file.path, path.join(UPLOAD_DIR, filename));
    const event = { deviceId, clientSeq, url: `/uploads/${filename}`, receivedAt: now() };
    state.photos.push(event); state.photos = boundedArray(state.photos); changed('photo', { event });
    return res.json({ ok: true, ...event });
  } finally {
    for (const file of req._uploadPaths || []) if (fs.existsSync(file)) fs.unlinkSync(file);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});
app.use('/uploads/v2', (req, res) => fail(res, 403, 'v2 photos require course authorization'));
app.use('/uploads', (req, res, next) => {
  if (TEACHER_TOKEN && !hasTeacherSession(req) && req.get('X-Device-Token') !== DEVICE_TOKEN && req.get('X-Teacher-Token') !== TEACHER_TOKEN) return fail(res, 401, 'authentication required');
  next();
}, express.static(UPLOAD_DIR));
app.post('/api/teacher/mode', requireTeacher, (req, res) => {
  if (!['idle', 'quiz', 'buzzer', 'photo'].includes(req.body.mode)) return fail(res, 400, 'mode must be idle, quiz, buzzer, or photo');
  const nextMode = req.body.mode;
  if (nextMode === 'quiz' && !state.question) return fail(res, 409, 'a question is required for quiz mode');
  state.mode = nextMode;
  if (nextMode === 'buzzer') {
    state.roundId = crypto.randomUUID();
    state.roundStartedAt = now();
    state.roundDeadlineAt = new Date(Date.parse(state.roundStartedAt) + RUSH_COUNTDOWN_SECONDS * 1000).toISOString();
    state.buzzes = []; state.buzzWinner = null;
  } else { state.roundStartedAt = null; state.roundDeadlineAt = null; }
  changed('state', { state: snapshot() }); res.json(snapshot());
});
app.post('/api/teacher/question', requireTeacher, (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  const options = Array.isArray(req.body.options) ? req.body.options : [];
  if (!text || text.length > MAX_STRING || options.length !== 4 || options.some(x => typeof x !== 'string' || !x.trim() || x.length > MAX_STRING)) return fail(res, 400, 'text and exactly four non-empty options (max 500 characters each) are required');
  state.question = { id: crypto.randomUUID(), text, options: options.map(x => x.trim()), publishedAt: now() };
  state.mode = 'quiz'; state.roundId = crypto.randomUUID(); state.roundStartedAt = null; state.roundDeadlineAt = null; state.answers = []; state.buzzes = []; state.buzzWinner = null;
  changed('state', { state: snapshot() }); res.json(snapshot());
});
app.post('/api/teacher/reset', requireTeacher, (req, res) => { const photos = state.photos; state = emptyState(); state.photos = photos; changed('state', { state: snapshot() }); res.json(snapshot()); });
app.use((err, req, res, next) => {
  for (const file of req._uploadPaths || []) if (fs.existsSync(file)) fs.unlinkSync(file);
  if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  if (err instanceof multer.MulterError) return fail(res, err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.message);
  return fail(res, 400, 'invalid request');
});
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  let session = null;
  if (TEACHER_TOKEN) {
    const cookie = req.headers.cookie || '';
    const sid = cookie.match(/(?:^|;\s*)teacher_session=([^;]+)/)?.[1];
    session = getTeacherSession(sid);
    if (!session && req.headers['x-device-token'] !== DEVICE_TOKEN && req.headers['x-teacher-token'] !== TEACHER_TOKEN) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, session));
});
wss.on('connection', (ws, req, session) => {
  if (session) session.websockets.add(ws);
  ws.once('close', () => { if (session) session.websockets.delete(ws); });
  ws.send(JSON.stringify({ type: 'state', state: snapshot() }));
});
if (require.main === module) {
  if (!TEACHER_TOKEN) console.warn('TEACHER_TOKEN is unset; configure it before deployment.');
  server.listen(PORT, '0.0.0.0', () => console.log(`Cloud classroom server listening on http://0.0.0.0:${PORT}`));
}
module.exports = { app, server, wss };
