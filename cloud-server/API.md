# Classroom API

## v2 Multi-classroom API

The isolated v2 API is mounted below `/api/v2` and persists to `DATA_DIR/v2-state.json` using atomic replacement. It does not use or alter legacy device tokens. Send the returned `teacherToken` or `studentToken` as `Authorization: Bearer <token>` (or `X-V2-Token`).

- `POST /api/v2/courses` `{teacherName,title}` creates a course and returns a six-character uppercase alphanumeric `courseCode` and `teacherToken`.
- `POST /api/v2/courses/join` `{courseCode,studentName,deviceId?}` joins a student and returns `studentId` and `studentToken`.

`deviceId` should be the terminal's stable MAC-derived ID (`MAX35-` plus the 12 hexadecimal eFuse MAC characters). The server canonicalizes raw 12-character MAC values and rejects whitespace/control characters; browser-only students may use a stable non-MAC device label.
- `POST /api/v2/courses/recover` `{courseCode,teacherToken}` recovers the teacher session only when the token was issued for that exact course; a course code alone is never teacher authorization.
- `GET /api/v2/courses/:id/home` returns the course, enabled modes, current activity, role, and student ID.
- `POST /api/v2/courses/:id/modes` (teacher) `{type:"classroom|vocabulary|arithmetic",enabled}` toggles a mode.
- `POST /api/v2/courses/:id/activities` (teacher) `{modeType,question...}` starts an activity and enables its mode. Vocabulary questions use `word`, four-item `options`, and exactly one `correctIndex` integer from `0` to `3`; invalid indexes are rejected. Arithmetic uses `expression` and/or `answer`.
- `GET /api/v2/courses/:id/current` returns the currently active activity for polling.
- `POST /api/v2/courses/:id/activities/:activityId/answers` (student) `{answer,clientEventId,studentToken?}` returns server-calculated `correct`; vocabulary answers must be a JSON integer `0` to `3` or letters `A` to `D`, with no one-based interpretation. Numeric strings and out-of-range values are rejected. A disabled activity returns HTTP 409 and is not counted. Repeating the same event, or submitting another answer for the same activity, is idempotent and returns the original result with `duplicate:true`.
- `GET /api/v2/courses/:id/stats` (teacher) returns attempted, correct, accuracy, and per-student mode statistics.
- `GET /api/v2/courses/:id/members` and `GET /api/v2/courses/:id/devices` (teacher) list membership and device bindings.
- `PUT /api/v2/courses/:id/devices/:deviceId/bind` (teacher) `{studentId}` binds a device.
- Rejoining a known `deviceId` requires its issued `deviceSecret` or the current `studentToken`; guessing a device ID cannot impersonate a student. A first device join returns `deviceSecret`. Teacher bind/unbind updates routing and revokes affected student sessions.
- `GET /api/v2/discovery` is unauthenticated and returns only `{service,protocol,name,port}`.
- `GET /api/v2/courses/:id/classroom/state` returns course-scoped classroom state. `POST /api/v2/courses/:id/classroom/commands` (teacher) accepts `start_quiz`, `start_buzzer`, `start_photo`, and `stop`; quiz questions use four unique options and optional zero-based `correctIndex`.
- `POST /api/v2/courses/:id/classroom/answer` (student) accepts `{questionId,answer:A-D,clientEventId}`. `POST /api/v2/courses/:id/classroom/buzz` accepts `{roundId,clientSeq}` and enforces the server deadline with winner idempotency.
- `POST /api/v2/courses/:id/classroom/photo` (student) accepts multipart `photo` and `clientSeq`; files are stored below the course directory and the response never includes the filesystem path. `GET /api/v2/courses/:id/classroom/photos/:photoId` requires the same course and permits only the owner or teacher. Legacy `/uploads/v2/...` static access is denied.
- `GET /api/v2/courses/:id/device-state` returns the current student's binding, enabled modes, classroom summary, own stats, and server time. `POST /api/v2/courses/:id/heartbeat` requires a student token and an associated device. Devices retains the legacy mapping and may include `deviceDetails`.
- `POST /api/v2/courses/:id/practice/next` (student) accepts `{modeType:vocabulary|arithmetic}` and creates an owner-only activity without changing `currentActivity`, classroom state, or requiring a teacher mode toggle. Vocabulary returns four randomized Chinese options and attempts a public English dictionary lookup for the English definition; the local word list remains available when the lookup is unavailable. Practice uses the normal activity answer endpoint and is counted once.
- `GET /api/v2/courses/:id/dictionary/:word` (course member) returns a best-effort public English definition and an optional local Chinese gloss for supported word-list entries. It is a server-side proxy with a short timeout; terminal use does not require direct public HTTPS support.
- `POST /api/v2/courses/:id/handwriting/recognize` (student, arithmetic mode enabled) accepts `{width,height,strokes}` using the handwriting module limits (1-1024 canvas, at most 32 strokes and 4096 points). It returns only `{recognizedText,confidence,digits,needsConfirmation}`; the recognition result is never treated as an answer or returned with the question key. Invalid input returns `400`; an unavailable model returns `503`.
- `GET /api/v2/courses/:id/classroom/photos` (teacher) lists course photos. `POST /api/v2/courses/:id/annotations` (teacher) accepts `{targetType:"photo",targetId,content}` and creates or updates a teacher-private annotation. `GET /api/v2/courses/:id/annotations` is teacher-only; student endpoints do not expose annotations.
- `GET /api/v2/courses/:id/learning-insights` (teacher) returns transparent, local rule-based summaries from answer counts, accuracy, and teacher annotation counts. It is advisory, reports insufficient evidence for fewer than three attempts, and is not a diagnostic or external AI service.

Base URL defaults to `http://host:8080`. All JSON errors have shape `{ "error": "..." }`. Device APIs require `X-Device-Token`. When `TEACHER_TOKEN` is configured, teacher APIs require `X-Teacher-Token` or a teacher session cookie. State and uploaded files require a valid device token, teacher token, or session. With no teacher token configured authentication is disabled for local development.

## State and realtime

`GET /api/state` returns `{ mode, question, roundId, roundStartedAt, roundDeadlineAt, serverNow, buzzWinner, answers, buzzes, photos, devices, updatedAt }`. `mode` is `idle`, `quiz`, `buzzer`, or `photo`. `question` is null or `{ id, text, options, publishedAt }`; `roundId` is a string; `roundStartedAt` and `roundDeadlineAt` are ISO timestamps for an active buzzer round, otherwise null; `serverNow` is the server clock sampled when the snapshot is generated; `buzzWinner` is an event or null. Each device includes `id`, `name`, `lastSeen`, `ip`, and computed `online` (last heartbeat within 60 seconds). The snapshot and all record lists are persisted in `DATA_DIR/state.json`.

Connect WebSocket at the server root (`ws://host:8080/`). The initial message and every state change have shape `{ "type": "state", "state": <complete GET /api/state snapshot> }`.

## Device endpoints

Every device call requires `X-Device-Token`.

- `POST /api/device/heartbeat` JSON `{ deviceId, name }`. Legacy `device_id` and `id` are accepted for the ID. Returns `{ ok, device, state }`.
- `POST /api/device/answer` JSON `{ deviceId, questionId, answer, clientSeq }`. `answer` is A-D. Requires active quiz and matching question ID. One accepted answer per device per question; subsequent posts return `{ ok:true, accepted:false, duplicate:true, event }` without replacing it. Stale question/mode returns 409.
- `POST /api/device/buzz` JSON `{ deviceId, roundId, clientSeq }`. Requires active buzzer, current round, and server time before `roundDeadlineAt`; after the deadline it returns HTTP 409 with `{ error: "buzzer round has expired" }` without changing buzzes or winner. First request wins atomically; response `{ ok:true, accepted, duplicate, winner }`. Repeats by a device return its original acceptance and current winner. New buzzer mode generates a fresh round ID and ISO timestamps.
- `POST /api/device/photo` multipart fields `photo` (JPEG/PNG), `deviceId`, `clientSeq`. Only accepted in photo mode. No `roundId` is used. Repeating the same `deviceId` and `clientSeq` returns the original event with `duplicate:true` and does not save another image. Maximum file size is 8 MiB; actual file signature is checked. Returns `{ ok:true, deviceId, clientSeq, url, receivedAt }`.

Device IDs are limited to 100 characters; names, question text and option text to 500 characters. Record lists are capped to the latest 1000 entries. Heartbeat online status expires after 60 seconds. Unknown JSON fields are ignored.

## Teacher endpoints

- `POST /api/teacher/login` JSON `{ token }`: issues `teacher_session` HttpOnly, SameSite=Strict cookie when token matches.
- `GET /api/teacher/session`: `{ authenticated, authRequired }` for the cookie session. `authRequired` is true when `TEACHER_TOKEN` is configured and false in local no-password mode.
- `POST /api/teacher/logout`: expires the session cookie, invalidates the server-side session, and closes WebSockets belonging to that session. Sessions expire server-side after the cookie's 43200-second Max-Age.
- `POST /api/teacher/question` JSON `{ text, options:[four strings] }`: publishes new UUID question, switches to quiz, creates round ID and clears current answers/buzzes/winner.
- `POST /api/teacher/mode` JSON `{ mode }`: sets mode. Every request setting `buzzer` creates a new round ID and clears buzzes/winner. The default countdown is 10 seconds; `RUSH_COUNTDOWN_SECONDS` can configure 1-120 seconds. Other modes clear the round timestamps.
- `POST /api/teacher/reset`: clears question and classroom records, sets idle, but leaves uploaded files in place.

Successful teacher mutations return a full state snapshot. State is synchronously persisted before the response. In-memory device heartbeats are not persisted and are repopulated by device reconnects.

## Static files and limits

Uploaded image URLs are `/uploads/<generated-name>` and are protected by the same auth policy. Multer temporary files are removed after validation failures. JSON request bodies are limited to 64 KiB. Configure a strong `TEACHER_TOKEN` and `DEVICE_TOKEN` outside local development.
# v2 activity privacy and idempotency

Student `GET /api/v2/courses/:id/home` and `GET /api/v2/courses/:id/current` responses never include vocabulary correct indexes or arithmetic answers. A disabled current activity is returned as `null`. Teacher responses retain the answer key.

Each student is counted at most once for each activity. Reusing a `clientEventId`, or submitting another answer for an already-submitted activity, returns the original result with `duplicate: true`.

Arithmetic practice also accepts `answer:{type:"stroke",width?,height?,strokes,value}` (dimensions may be top-level on the request). The server recognizes the strokes locally, requires a confirmed numeric `value`, and grades only that value against the activity answer. Recognition errors or confidence below `0.8` return `409`, are not counted, and do not save an answer. Accepted events retain bounded stroke metadata only (`width`, `height`, stroke/point counts, recognized text, and confidence).

Teacher statistics include each student's total attempts plus `practice:{attempted,correct,accuracy}` for vocabulary and arithmetic, so terminal-initiated practice remains distinguishable from teacher-published work.
