const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { recognize } = require('./handwriting');

const MODES = ['classroom', 'vocabulary', 'arithmetic'];
const PRACTICE_MODES = ['vocabulary', 'arithmetic'];
const MAX = 500;
const HANDWRITING_MIN_CONFIDENCE = 0.8;
const WORDS = [
  ['apple', '苹果'], ['book', '书'], ['water', '水'], ['house', '房子'], ['school', '学校'],
  ['teacher', '老师'], ['student', '学生'], ['friend', '朋友'], ['family', '家庭'], ['music', '音乐'],
  ['sun', '太阳'], ['moon', '月亮'], ['star', '星星'], ['tree', '树'], ['flower', '花'],
  ['bread', '面包'], ['milk', '牛奶'], ['fish', '鱼'], ['bird', '鸟'], ['car', '汽车'],
  ['train', '火车'], ['road', '道路'], ['door', '门'], ['window', '窗户'], ['chair', '椅子'],
  ['table', '桌子'], ['computer', '电脑'], ['phone', '电话'], ['light', '光'], ['rain', '雨'],
  ['cloud', '云'], ['wind', '风'], ['summer', '夏天'], ['winter', '冬天'], ['morning', '早晨'],
  ['night', '夜晚'], ['happy', '开心的'], ['strong', '强壮的'], ['small', '小的'], ['quick', '快速的'],
  ['green', '绿色的'], ['red', '红色的'], ['read', '阅读'], ['write', '写'], ['run', '跑'],
  ['jump', '跳'], ['listen', '听'], ['speak', '说'], ['open', '打开'], ['close', '关闭']
];
const DISTRACTORS = ['香蕉', '梨', '桃子', '汽车', '学校', '天空', '河流', '山', '音乐', '书包', '朋友', '动物'];
const WORD_MEANINGS = new Map(WORDS.map(([word, meaning]) => [word, meaning]));

async function dictionaryDefinition(word) {
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { signal: AbortSignal.timeout(2500) });
    const entries = response.ok ? await response.json() : [];
    return entries?.[0]?.meanings?.[0]?.definitions?.[0]?.definition || '';
  } catch (_) {
    return '';
  }
}

function mountClassroomV2(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const uploadRoot = options.uploadDir || process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
  const port = Number(options.port || process.env.PORT || 8080);
  const file = path.join(dataDir, 'v2-state.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadRoot, { recursive: true });
  const empty = () => ({ courses: {}, sessions: {} });
  let state;
  try { state = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (_) { state = empty(); }
  state.courses ||= {}; state.sessions ||= {};

  const now = () => new Date().toISOString();
  const id = () => crypto.randomUUID();
  const secret = () => crypto.randomBytes(24).toString('hex');
  const fail = (res, status, error) => res.status(status).json({ error });
  function normalizeDeviceId(value) {
    const original = String(value || '').trim();
    if (!original || original.length > 100 || /[<>\s]/.test(original)) return null;
    const raw = original.toUpperCase().replace(/[:-]/g, '');
    if (/^[0-9A-F]{12}$/.test(raw)) return `MAX35-${raw}`;
    if (/^MAX35[0-9A-F]{8,12}$/.test(raw)) return raw;
    return original;
  }
  function save() {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  function code() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let value;
    do { value = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join(''); }
    while (Object.values(state.courses).some(c => c.code === value));
    return value;
  }
  function classroomEmpty() { return { mode: 'stop', question: null, roundId: id(), roundStartedAt: null, roundDeadlineAt: null, winner: null, answers: {}, buzzes: {}, photos: {} }; }
  function normalizeCourse(course) {
    course.modes ||= { classroom: true, vocabulary: true, arithmetic: true };
  course.members ||= {}; course.devices ||= {}; course.deviceDetails ||= {}; course.activities ||= {};
    course.practice ||= {}; course.annotations ||= {}; course.currentActivity ||= null; course.classroom ||= classroomEmpty();
    course.classroom.answers ||= {}; course.classroom.buzzes ||= {}; course.classroom.photos ||= {};
    for (const member of Object.values(course.members)) member.stats ||= {};
    return course;
  }
  Object.values(state.courses).forEach(normalizeCourse);
  function publicCourse(course) { return { id: course.id, courseCode: course.code, title: course.title, teacherName: course.teacherName, modes: course.modes, currentActivity: course.currentActivity || null }; }
  function sessionToken(req) { return req.get('Authorization')?.replace(/^Bearer\s+/i, '') || req.get('X-V2-Token') || req.body?.studentToken; }
  function auth(req, res, next) {
    const token = sessionToken(req); const session = state.sessions[token];
    if (!session || !state.courses[session.courseId]) return fail(res, 401, 'invalid v2 session token');
    if (req.params.id && req.params.id !== session.courseId) return fail(res, 403, 'token does not belong to this course');
    req.v2 = session; req.course = normalizeCourse(state.courses[session.courseId]); req.authToken = token; next();
  }
  function teacher(req, res, next) { return req.v2.role === 'teacher' ? next() : fail(res, 403, 'teacher permission required'); }
  function member(req) { return req.course.members[req.v2.memberId]; }
  function revokeStudentSessions(courseId, memberId) { for (const [key, value] of Object.entries(state.sessions)) if (value.courseId === courseId && value.memberId === memberId) delete state.sessions[key]; }
  function studentActivity(activity) {
    if (!activity) return null;
    const source = activity.question || {};
    let question;
    if (activity.modeType === 'vocabulary') question = { word: source.word, definition: source.definition || '', options: Array.isArray(source.options) ? source.options.slice(0, 4) : [] };
    else if (activity.modeType === 'arithmetic') question = { expression: source.expression };
    else question = {};
    return { id: activity.id, modeType: activity.modeType, question, createdAt: activity.createdAt, practice: !!activity.practice };
  }
  function normalizedText(value) {
    return typeof value === 'string' ? value.normalize('NFKC').trim() : '';
  }
  function validOptions(options) {
    if (!Array.isArray(options) || options.length !== 4) return null;
    const normalized = options.map(normalizedText);
    if (normalized.some(value => !value || value.length > MAX)) return null;
    if (new Set(normalized).size !== 4) return null;
    return normalized;
  }
  function normalizeAnswer(value) {
    if (typeof value === 'string' && /^[A-D]$/i.test(value.trim())) return value.trim().toUpperCase().charCodeAt(0) - 65;
    return Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
  }
  function answerMatches(activity, answer) {
    const q = activity.question || activity;
    if (activity.modeType === 'vocabulary') return normalizeAnswer(q.correctIndex) !== null && normalizeAnswer(answer) === q.correctIndex;
    if (activity.modeType === 'arithmetic') { const expected = Number(q.answer ?? q.correctAnswer); const actual = Number(answer); return Number.isFinite(expected) && Number.isFinite(actual) && expected === actual; }
    return false;
  }
  function validMemberAnswer(mode, answer) { return mode === 'vocabulary' ? normalizeAnswer(answer) !== null : mode === 'arithmetic' && Number.isFinite(Number(answer)); }
  function isStrokeAnswer(activity, answer) {
    return activity.practice && activity.modeType === 'arithmetic' && answer && answer.type === 'stroke';
  }
  function strokeInput(body, answer) {
    return { width: body.width ?? answer.width, height: body.height ?? answer.height, strokes: answer.strokes };
  }
  function strokeMetadata(input, result) {
    return {
      width: input.width,
      height: input.height,
      strokeCount: input.strokes.length,
      pointCount: input.strokes.reduce((total, stroke) => total + stroke.length, 0),
      recognizedText: result.recognizedText,
      confidence: result.confidence
    };
  }
  function updateStats(memberInfo, mode, correct) { const stat = memberInfo.stats[mode] ||= { attempted: 0, correct: 0, accuracy: null }; stat.attempted++; if (correct) stat.correct++; stat.accuracy = stat.attempted ? stat.correct / stat.attempted : null; }
  function stats(course) {
    const result = {};
    for (const mode of MODES) {
      const rows = Object.values(course.members || {}).filter(m => m.role === 'student').map(m => {
        const attempts = Object.values(course.activities || {}).map(activity => activity.answers?.[`${m.id}:${activity.id}`]).filter(answer => answer && answer.studentId === m.id && answer.modeType === mode);
        const practiceRows = attempts.filter(answer => answer.practice);
        const practiceAttempted = practiceRows.length; const practiceCorrect = practiceRows.filter(answer => answer.correct).length;
        return { studentId: m.id, name: m.name, ...(m.stats || {})[mode] || { attempted: 0, correct: 0, accuracy: null }, practice: { attempted: practiceAttempted, correct: practiceCorrect, accuracy: practiceAttempted ? practiceCorrect / practiceAttempted : null } };
      });
      const attempted = rows.reduce((n, x) => n + (x.attempted || 0), 0); const correct = rows.reduce((n, x) => n + (x.correct || 0), 0);
      const practiceAttempted = rows.reduce((n, x) => n + x.practice.attempted, 0); const practiceCorrect = rows.reduce((n, x) => n + x.practice.correct, 0);
      result[mode] = { attempted, correct, accuracy: attempted ? correct / attempted : null, practice: { attempted: practiceAttempted, correct: practiceCorrect, accuracy: practiceAttempted ? practiceCorrect / practiceAttempted : null }, students: rows };
    }
    return result;
  }
  function publicClassroom(course, isTeacher) {
    const c = course.classroom; const copy = { ...c, answers: undefined, buzzes: undefined, photos: undefined };
    if (copy.question) {
      copy.question = { id: copy.question.id, text: copy.question.text, options: Array.isArray(copy.question.options) ? copy.question.options.slice(0, 4) : [] };
      if (isTeacher && c.question.correctIndex !== undefined) copy.question.correctIndex = c.question.correctIndex;
    }
    if (!isTeacher && copy.winner) copy.winner = true;
    return copy;
  }
   async function practiceQuestion(mode) {
     if (mode === 'vocabulary') {
       const item = WORDS[crypto.randomInt(WORDS.length)];
       const options = [item[1], ...DISTRACTORS.filter(value => value !== item[1]).sort(() => Math.random() - 0.5).slice(0, 3)];
       for (let i = options.length - 1; i > 0; i--) {
         const j = crypto.randomInt(i + 1); [options[i], options[j]] = [options[j], options[i]];
       }
       const correctIndex = options.indexOf(item[1]);
       return { word: item[0], definition: await dictionaryDefinition(item[0]), options, correctIndex };
     }
     let a = crypto.randomInt(1, 50), b = crypto.randomInt(1, 20); const ops = a >= b ? ['+', '-', '*', '/'] : ['+', '*', '/']; const op = ops[crypto.randomInt(ops.length)]; if (op === '/' && a % b) a = b * crypto.randomInt(1, 6);
     return { expression: `${a} ${op} ${b}`, answer: op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b };
   }
  function publicPhoto(event) { return { ok: true, id: event.id, studentId: event.studentId, clientSeq: event.clientSeq, url: event.url, receivedAt: event.receivedAt }; }
  function photoSummaries(course) {
    return Object.values(course.classroom.photos || {}).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).map(photo => ({ id: photo.id, studentId: photo.studentId, studentName: course.members[photo.studentId]?.name || '未知学生', receivedAt: photo.receivedAt, url: photo.url }));
  }
  function annotationsFor(course, targetType, targetId) {
    return Object.values(course.annotations || {}).filter(note => note.targetType === targetType && note.targetId === targetId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  function learningInsights(course) {
    const summary = stats(course);
    return Object.values(course.members).filter(member => member.role === 'student').map(member => {
      const modes = ['vocabulary', 'arithmetic', 'classroom'].map(mode => summary[mode].students.find(row => row.studentId === member.id) || { attempted: 0, correct: 0, accuracy: null, practice: { attempted: 0, correct: 0 } });
      const attempted = modes.reduce((total, mode) => total + mode.attempted, 0);
      const correct = modes.reduce((total, mode) => total + mode.correct, 0);
      const accuracy = attempted ? correct / attempted : null;
      const annotations = Object.values(course.annotations || {}).filter(note => note.studentId === member.id);
      const evidence = [`累计作答 ${attempted} 次`, `教师图片注释 ${annotations.length} 条`];
      const recommendations = [];
      let level = '样本不足';
      if (attempted >= 3 && accuracy !== null) {
        if (accuracy >= 0.85) { level = '掌握较稳'; recommendations.push('提供进阶题和开放式解释任务，要求说出解题依据。'); }
        else if (accuracy >= 0.6) { level = '正在巩固'; recommendations.push('采用短题组练习，错题后立即给出步骤提示并安排间隔复习。'); }
        else { level = '需要更多支架'; recommendations.push('先用具体示例拆分知识点，再用一题一反馈的方式练习。'); }
      } else recommendations.push('先积累至少 3 次有效作答，再结合错误类型调整教学。');
      if ((modes[0].attempted || 0) < 2) recommendations.push('增加词汇四选一练习，并复习教师标注的图片内容。');
      if ((modes[1].attempted || 0) < 2) recommendations.push('增加手写速算练习，关注计算步骤而非只看最终结果。');
      if (annotations.length) recommendations.push('在下次面谈或讲评时先回应教师对作业图片的具体注释。');
      return { studentId: member.id, studentName: member.name, attempted, correct, accuracy, level, evidence, recommendations, annotationCount: annotations.length };
    });
  }

  app.get('/api/v2/discovery', (req, res) => res.json({ service: 'cloud-classroom', protocol: 'v2', name: 'MAX35 Cloud Classroom', port }));
  app.post('/api/v2/courses', (req, res) => {
    const teacherName = String(req.body?.teacherName || '').trim(); const title = String(req.body?.title || '').trim();
    if (!teacherName || !title || teacherName.length > MAX || title.length > MAX) return fail(res, 400, 'teacherName and title are required');
    const course = normalizeCourse({ id: id(), code: code(), teacherName, title, modes: { classroom: true, vocabulary: true, arithmetic: true }, members: {}, devices: {}, deviceDetails: {}, activities: {}, practice: {}, currentActivity: null, createdAt: now() });
    const teacherToken = secret(); const teacherId = id(); course.members[teacherId] = { id: teacherId, role: 'teacher', name: teacherName, stats: {} };
    state.courses[course.id] = course; state.sessions[teacherToken] = { courseId: course.id, role: 'teacher', memberId: teacherId }; save();
    res.status(201).json({ course: publicCourse(course), courseCode: course.code, teacherToken });
  });
  app.post('/api/v2/courses/recover', (req, res) => {
    const course = Object.values(state.courses).find(c => c.code === String(req.body?.courseCode || '').trim().toUpperCase());
    const teacherToken = String(req.body?.teacherToken || ''); const session = state.sessions[teacherToken];
    if (!course || !session || session.courseId !== course.id || session.role !== 'teacher') return fail(res, 401, 'invalid teacher recovery credentials');
    res.json({ course: publicCourse(normalizeCourse(course)), courseCode: course.code, teacherToken });
  });
  app.post('/api/v2/courses/join', (req, res) => {
    const course = Object.values(state.courses).find(c => c.code === String(req.body?.courseCode || '').trim().toUpperCase()); const name = String(req.body?.studentName || '').trim();
    if (!course || !name || name.length > MAX) return fail(res, 400, 'valid courseCode and studentName are required'); normalizeCourse(course);
    const deviceId = normalizeDeviceId(req.body?.deviceId); const suppliedToken = String(req.body?.studentToken || sessionToken(req) || ''); const suppliedSecret = String(req.body?.deviceSecret || '');
    if (req.body?.deviceId && !deviceId) return fail(res, 400, 'deviceId must be an ESP32 MAC or MAX35 MAC identifier');
    let existingId = deviceId && course.devices[deviceId];
    if (existingId) {
      const existing = course.members[existingId]; const valid = (suppliedSecret && existing.deviceSecret === suppliedSecret) || (suppliedToken && state.sessions[suppliedToken]?.courseId === course.id && state.sessions[suppliedToken]?.memberId === existingId);
      if (!valid) return fail(res, 409, 'device requires its studentToken or deviceSecret');
      const tokenValue = suppliedToken && state.sessions[suppliedToken]?.memberId === existingId ? suppliedToken : secret(); state.sessions[tokenValue] = { courseId: course.id, role: 'student', memberId: existingId };
      save(); return res.status(200).json({ course: publicCourse(course), studentId: existingId, studentToken: tokenValue, deviceSecret: existing.deviceSecret });
    }
    const memberId = id(); const studentToken = secret(); const deviceSecret = deviceId ? secret() : undefined;
    course.members[memberId] = { id: memberId, role: 'student', name, stats: {}, deviceSecret }; if (deviceId) { course.devices[deviceId] = memberId; course.deviceDetails[deviceId] = { memberId, boundAt: now() }; }
    state.sessions[studentToken] = { courseId: course.id, role: 'student', memberId }; save();
    res.status(201).json({ course: publicCourse(course), studentId: memberId, studentToken, ...(deviceSecret ? { deviceSecret } : {}) });
  });
  app.get('/api/v2/courses/:id/home', auth, (req, res) => res.json({ course: publicCourse(req.course), role: req.v2.role, studentId: req.v2.memberId }));
  app.post('/api/v2/courses/:id/modes', auth, teacher, (req, res) => { const type = String(req.body?.type || ''); if (!MODES.includes(type) || typeof req.body.enabled !== 'boolean') return fail(res, 400, 'type and boolean enabled are required'); req.course.modes[type] = req.body.enabled; save(); res.json({ modes: req.course.modes }); });
  app.post('/api/v2/courses/:id/activities', auth, teacher, (req, res) => {
    const modeType = String(req.body?.modeType || ''); if (!MODES.includes(modeType)) return fail(res, 400, 'invalid mode'); const q = req.body.question && typeof req.body.question === 'object' ? { ...req.body.question } : { ...req.body };
    if (modeType === 'vocabulary') {
      const options = validOptions(q.options);
      q.word = normalizedText(q.word);
      if (!q.word || q.word.length > MAX || !options || !Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) return fail(res, 400, 'vocabulary requires four non-empty unique options and correctIndex 0-3');
      q.options = options;
    }
    if (modeType === 'arithmetic' && !q.expression && q.answer === undefined) return fail(res, 400, 'arithmetic requires expression or answer');
    if (modeType === 'arithmetic' && q.answer === undefined) { const m = String(q.expression).match(/^\s*(\d+)\s*([+\-*\/])\s*(\d+)\s*$/); if (!m) return fail(res, 400, 'unsupported arithmetic expression'); const a = Number(m[1]), b = Number(m[3]); if (m[2] === '/' && a % b) return fail(res, 400, 'arithmetic division must be exact'); q.answer = m[2] === '+' ? a + b : m[2] === '-' ? a - b : m[2] === '*' ? a * b : a / b; }
    req.course.modes[modeType] = true; const activity = { id: id(), modeType, question: q, createdAt: now(), answers: {} }; req.course.activities[activity.id] = activity; req.course.currentActivity = activity.id; save();
    res.status(201).json({ activity: { ...activity, answers: undefined }, currentActivity: { ...activity, answers: undefined } });
  });
  app.get('/api/v2/courses/:id/current', auth, (req, res) => { const a = req.course.currentActivity && req.course.activities[req.course.currentActivity]; const visible = a && (req.v2.role === 'teacher' || req.course.modes[a.modeType]) ? a : null; res.json({ activity: req.v2.role === 'teacher' ? (visible ? { id: visible.id, modeType: visible.modeType, question: visible.question, createdAt: visible.createdAt } : null) : studentActivity(visible) }); });
  app.post('/api/v2/courses/:id/activities/:activityId/answers', auth, async (req, res) => {
    if (req.v2.role !== 'student') return fail(res, 403, 'student permission required'); const a = req.course.activities[req.params.activityId]; if (!a || (!a.practice && !req.course.modes[a.modeType]) || (a.practice ? a.ownerId !== req.v2.memberId : req.course.currentActivity !== a.id)) return fail(res, 409, 'activity is not active');
    const eventId = String(req.body?.clientEventId || ''); if (!eventId) return fail(res, 400, 'clientEventId is required'); a.answers ||= {}; const memberKey = `${req.v2.memberId}:${a.id}`; const eventKey = `${req.v2.memberId}:${eventId}`; const previous = a.answers[memberKey] || a.answers[eventKey]; if (previous) return res.json({ ...previous, duplicate: true });
    let answer = req.body.answer; let handwriting;
    if (isStrokeAnswer(a, answer)) {
      if (!Object.prototype.hasOwnProperty.call(answer, 'value') || !Number.isFinite(Number(answer.value))) return fail(res, 400, 'stroke answer requires confirmed value');
      const input = strokeInput(req.body, answer);
      try {
        const result = await recognize(input);
        if (result.confidence < HANDWRITING_MIN_CONFIDENCE) return fail(res, 409, 'handwriting recognition requires confirmation');
        handwriting = strokeMetadata(input, result);
      } catch (error) {
        if (error?.code === 'INVALID_HANDWRITING_INPUT') return fail(res, 400, error.message);
        return fail(res, 409, 'handwriting recognition requires confirmation');
      }
      answer = Number(answer.value);
    } else if (!validMemberAnswer(a.modeType, answer)) return fail(res, 400, 'invalid answer');
    const correct = answerMatches(a, answer); const event = { ok: true, duplicate: false, activityId: a.id, studentId: req.v2.memberId, modeType: a.modeType, practice: !!a.practice, answer, ...(handwriting ? { handwriting } : {}), correct, clientEventId: eventId, receivedAt: now() }; a.answers[memberKey] = event; a.answers[eventKey] = event; updateStats(member(req), a.modeType, correct); save(); res.json(event);
  });
  app.get('/api/v2/courses/:id/stats', auth, teacher, (req, res) => res.json({ courseId: req.course.id, stats: stats(req.course) }));
  app.get('/api/v2/courses/:id/members', auth, teacher, (req, res) => { const summary = stats(req.course); const members = Object.values(req.course.members).map(m => ({ id: m.id, role: m.role, name: m.name, stats: { ...(m.stats || {}), ...(m.role === 'student' ? Object.fromEntries(PRACTICE_MODES.map(mode => [mode, summary[mode].students.find(row => row.studentId === m.id)])) : {}) } })); res.json({ members }); });
  app.get('/api/v2/courses/:id/classroom/photos', auth, teacher, (req, res) => res.json({ photos: photoSummaries(req.course) }));
  app.get('/api/v2/courses/:id/annotations', auth, teacher, (req, res) => res.json({ annotations: Object.values(req.course.annotations || {}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }));
  app.post('/api/v2/courses/:id/annotations', auth, teacher, (req, res) => {
    const targetType = String(req.body?.targetType || ''); const targetId = String(req.body?.targetId || ''); const content = normalizedText(req.body?.content);
    if (targetType !== 'photo' || !targetId || !content || content.length > MAX) return fail(res, 400, 'photo targetId and annotation content are required');
    const photo = Object.values(req.course.classroom.photos || {}).find(item => item.id === targetId);
    if (!photo) return fail(res, 404, 'photo not found');
    const existing = annotationsFor(req.course, targetType, targetId)[0];
    const annotation = existing || { id: id(), targetType, targetId, studentId: photo.studentId, createdAt: now() };
    annotation.content = content; annotation.updatedAt = now(); req.course.annotations[annotation.id] = annotation; save();
    res.status(existing ? 200 : 201).json({ annotation });
  });
  app.get('/api/v2/courses/:id/learning-insights', auth, teacher, (req, res) => res.json({ generatedAt: now(), method: 'local-rule-based', students: learningInsights(req.course) }));
  app.get('/api/v2/courses/:id/devices', auth, teacher, (req, res) => res.json({ devices: req.course.devices, deviceDetails: req.course.deviceDetails }));
  app.put('/api/v2/courses/:id/devices/:deviceId/bind', auth, teacher, (req, res) => { const target = req.course.members[req.body?.studentId]; if (!target || target.role !== 'student') return fail(res, 400, 'studentId must identify a student'); for (const [deviceId, memberId] of Object.entries(req.course.devices)) if (memberId === target.id && deviceId !== req.params.deviceId) { delete req.course.devices[deviceId]; delete req.course.deviceDetails[deviceId]; } const old = req.course.devices[req.params.deviceId]; if (old && old !== target.id) revokeStudentSessions(req.course.id, old); revokeStudentSessions(req.course.id, target.id); req.course.devices[req.params.deviceId] = target.id; req.course.deviceDetails[req.params.deviceId] = { memberId: target.id, boundAt: now() }; save(); res.json({ deviceId: req.params.deviceId, studentId: target.id }); });
  app.delete('/api/v2/courses/:id/devices/:deviceId/bind', auth, teacher, (req, res) => { const old = req.course.devices[req.params.deviceId]; if (old) revokeStudentSessions(req.course.id, old); delete req.course.devices[req.params.deviceId]; delete req.course.deviceDetails[req.params.deviceId]; save(); res.json({ deviceId: req.params.deviceId, unbound: true }); });

  app.get('/api/v2/courses/:id/classroom/state', auth, (req, res) => res.json({ classroom: publicClassroom(req.course, req.v2.role === 'teacher'), serverNow: now() }));
  app.post('/api/v2/courses/:id/classroom/commands', auth, teacher, (req, res) => {
    const c = req.course.classroom; const command = String(req.body?.command || '');
    if (command === 'stop') { c.mode = 'stop'; c.question = null; c.roundStartedAt = null; c.roundDeadlineAt = null; c.winner = null; }
    else if (['start_quiz', 'start_buzzer', 'start_photo'].includes(command)) {
      c.mode = command.slice(6); c.question = null; c.roundId = id(); c.roundStartedAt = now(); c.roundDeadlineAt = null; c.winner = null; c.answers = {}; c.buzzes = {};
      if (command === 'start_quiz') { const q = req.body.question || {}; const options = validOptions(q.options); const text = normalizedText(q.text); if (!text || text.length > MAX || !options) return fail(res, 400, 'quiz requires non-empty text and four unique options'); if (q.correctIndex !== undefined && (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3)) return fail(res, 400, 'correctIndex must be 0-3'); c.question = { id: id(), text, options, ...(q.correctIndex === undefined ? {} : { correctIndex: q.correctIndex }) }; }
      if (command === 'start_buzzer') { const seconds = Number(req.body.durationSeconds || 10); if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120) return fail(res, 400, 'durationSeconds must be 1-120'); c.roundDeadlineAt = new Date(Date.now() + seconds * 1000).toISOString(); }
    } else return fail(res, 400, 'unknown classroom command');
    save(); res.json({ classroom: publicClassroom(req.course, true), serverNow: now() });
  });
  app.post('/api/v2/courses/:id/classroom/answer', auth, (req, res) => {
    if (req.v2.role !== 'student' || req.course.classroom.mode !== 'quiz') return fail(res, 409, 'quiz is not active'); const c = req.course.classroom; const q = c.question; if (!q || req.body.questionId !== q.id || !/^[A-D]$/i.test(String(req.body.answer || ''))) return fail(res, 400, 'questionId and answer A-D are required'); const key = `${req.v2.memberId}:${q.id}`; const eventKey = `${req.v2.memberId}:${String(req.body.clientEventId || '')}`; const previous = c.answers[key] || c.answers[eventKey]; if (previous) return res.json({ ...previous, duplicate: true }); const correct = q.correctIndex === undefined ? false : normalizeAnswer(req.body.answer) === q.correctIndex; const event = { ok: true, duplicate: false, questionId: q.id, studentId: req.v2.memberId, answer: String(req.body.answer).toUpperCase(), correct, clientEventId: String(req.body.clientEventId || ''), receivedAt: now() }; if (!event.clientEventId) return fail(res, 400, 'clientEventId is required'); c.answers[key] = event; c.answers[eventKey] = event; updateStats(member(req), 'classroom', correct); save(); res.json(event);
  });
  app.post('/api/v2/courses/:id/classroom/buzz', auth, (req, res) => { if (req.v2.role !== 'student' || req.course.classroom.mode !== 'buzzer') return fail(res, 409, 'buzzer is not active'); const c = req.course.classroom; if (req.body.roundId !== c.roundId) return fail(res, 409, 'buzzer round is not active'); const deadline = Date.parse(c.roundDeadlineAt); if (!Number.isFinite(deadline) || Date.now() >= deadline) return fail(res, 409, 'buzzer round has expired'); const key = req.v2.memberId; if (c.buzzes[key]) return res.json({ ok: true, accepted: c.winner === key, duplicate: true, winner: c.winner ? { studentId: c.winner } : null }); const accepted = !c.winner; c.buzzes[key] = { studentId: key, clientSeq: req.body.clientSeq, receivedAt: now() }; if (accepted) c.winner = key; save(); res.json({ ok: true, accepted, duplicate: false, winner: c.winner ? { studentId: c.winner } : null }); });

  const classroomUpload = multer({ storage: multer.diskStorage({ destination(req, file, cb) { const dir = path.join(uploadRoot, 'v2', req.course.id); fs.mkdirSync(dir, { recursive: true }); cb(null, dir); }, filename(req, file, cb) { const filename = `${id()}.upload`; (req._v2UploadPaths ||= []).push(path.join(uploadRoot, 'v2', req.course.id, filename)); cb(null, filename); } }), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  app.post('/api/v2/courses/:id/classroom/photo', auth, classroomUpload.single('photo'), (req, res) => {
    if (!req.file) return fail(res, 400, 'JPEG or PNG photo is required');
    try {
      if (req.v2.role !== 'student' || req.course.classroom.mode !== 'photo') return fail(res, 409, 'photo is not active');
      const fd = fs.openSync(req.file.path, 'r'); const header = Buffer.alloc(8); const count = fs.readSync(fd, header, 0, 8, 0); fs.closeSync(fd);
      const png = count >= 8 && header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const jpeg = count >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
      if (!png && !jpeg) { fs.unlinkSync(req.file.path); return fail(res, 400, 'file content is not JPEG or PNG'); }
      const c = req.course.classroom; const clientSeq = Number(req.body.clientSeq);
      if (!Number.isSafeInteger(clientSeq)) return fail(res, 400, 'clientSeq must be an integer');
      const key = `${req.v2.memberId}:${clientSeq}`;
      if (c.photos[key]) return res.json({ ...publicPhoto(c.photos[key]), duplicate: true });
      const photoId = id(); const extension = png ? '.png' : '.jpg';
      const finalPath = path.join(path.dirname(req.file.path), `${photoId}${extension}`);
      fs.renameSync(req.file.path, finalPath);
      const event = { id: photoId, studentId: req.v2.memberId, clientSeq, url: `/api/v2/courses/${req.course.id}/classroom/photos/${photoId}`, path: finalPath, receivedAt: now() };
      c.photos[key] = event; save(); return res.json(publicPhoto(event));
    } finally {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
  });
  app.get('/api/v2/courses/:id/classroom/photos/:photoId', auth, (req, res) => { const event = Object.values(req.course.classroom.photos).find(x => x.id === req.params.photoId); if (!event) return fail(res, 404, 'photo not found'); if (req.v2.role !== 'teacher' && event.studentId !== req.v2.memberId) return fail(res, 403, 'photo access denied'); res.sendFile(path.resolve(event.path)); });
  app.use((err, req, res, next) => {
    for (const file of req._v2UploadPaths || []) if (fs.existsSync(file)) fs.unlinkSync(file);
    if (err instanceof multer.MulterError) return fail(res, err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.message);
    return next(err);
  });
  app.get('/api/v2/courses/:id/device-state', auth, (req, res) => { const m = member(req); const bound = Object.entries(req.course.devices).filter(([, memberId]) => memberId === req.v2.memberId).map(([deviceId]) => deviceId); res.json({ binding: { studentId: m.id, name: m.name, devices: bound }, modes: req.course.modes, classroom: { mode: req.course.classroom.mode, questionId: req.course.classroom.question?.id || null }, stats: m.stats || {}, serverNow: now() }); });
  app.post('/api/v2/courses/:id/heartbeat', auth, (req, res) => { const deviceId = normalizeDeviceId(req.body?.deviceId); if (!deviceId || req.course.devices[deviceId] !== req.v2.memberId) return fail(res, 403, 'device is not bound to this student'); req.course.deviceDetails[deviceId] = { ...(req.course.deviceDetails[deviceId] || {}), memberId: req.v2.memberId, lastSeen: now(), name: String(req.body?.name || deviceId) }; save(); res.json({ ok: true, deviceId, lastSeen: req.course.deviceDetails[deviceId].lastSeen }); });
  app.post('/api/v2/courses/:id/practice/next', auth, async (req, res) => { if (req.v2.role !== 'student') return fail(res, 403, 'student permission required'); const mode = String(req.body?.modeType || ''); if (!PRACTICE_MODES.includes(mode)) return fail(res, 400, 'modeType must be vocabulary or arithmetic'); const activity = { id: id(), modeType: mode, question: await practiceQuestion(mode), createdAt: now(), answers: {}, practice: true, ownerId: req.v2.memberId }; req.course.activities[activity.id] = activity; req.course.practice[activity.id] = req.v2.memberId; save(); res.status(201).json({ activity: studentActivity(activity) }); });
  app.get('/api/v2/courses/:id/dictionary/:word', auth, async (req, res) => {
    const word = normalizedText(req.params.word).toLowerCase();
    if (!/^[a-z][a-z-]{0,63}$/.test(word)) return fail(res, 400, 'word must contain English letters only');
    const chinese = WORD_MEANINGS.get(word) || null;
    const definition = await dictionaryDefinition(word);
    res.json({ word, chinese, definition, source: definition ? 'dictionaryapi.dev' : 'local-fallback' });
  });
  app.post('/api/v2/courses/:id/handwriting/recognize', auth, async (req, res) => {
    if (req.v2.role !== 'student') return fail(res, 403, 'student permission required');
    try {
      const result = await recognize(req.body);
      res.json({ recognizedText: result.recognizedText, confidence: result.confidence, digits: result.digits, needsConfirmation: true });
    } catch (error) {
      if (error?.code === 'INVALID_HANDWRITING_INPUT') return fail(res, 400, error.message);
      return fail(res, 503, 'handwriting recognition is unavailable');
    }
  });
  return { stateFile: file };
}

module.exports = mountClassroomV2;
