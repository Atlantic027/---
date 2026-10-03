#pragma once
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WiFiUdp.h>

#ifndef RUSH_COUNTDOWN_SECONDS
#define RUSH_COUNTDOWN_SECONDS 10
#endif
#ifndef V2_MODE_ENABLED
#define V2_MODE_ENABLED false
#endif
#ifndef V2_API_BASE_PATH
#define V2_API_BASE_PATH "/api/v2"
#endif
#ifndef V2_COURSE_CODE
#define V2_COURSE_CODE ""
#endif
#ifndef V2_STUDENT_NAME
#define V2_STUDENT_NAME ""
#endif

// All methods and model fields belong to the Arduino loop task only.
struct ClassroomModel {
  String mode = "idle", questionId, roundId, roundDeadlineAt, answer;
  String buzzState = "BUZZ", photoState = "PHOTO READY", status = "SYNC REQUIRED";
  String v2ActivityId, v2ActivityType, v2Prompt, v2Definition, v2ArithmeticInput, v2Result;
  String v2RecognizedText, v2PracticeMode;
  float v2Confidence = 0;
  bool v2NeedsConfirmation = false, v2Practice = false;
  String v2Options[4];
  uint32_t roundStartedAt = 0;
  uint32_t roundDeadlineMillis = 0;
  bool submitted = false, synced = false, busy = false;
  bool v2Synced = false, v2Submitted = false, v2TokenReady = false;
};

class ClassroomClient {
 public:
  ClassroomModel model;
  uint64_t clientSeq = 0;
  bool dirty = true;

  void begin() {
    configuredSsid = WIFI_SSID;
    configuredPassword = WIFI_PASSWORD;
    configuredServer = SERVER_BASE_URL;
    sequenceReady = prefs.begin("classroom", false);
    if (sequenceReady) clientSeq = prefs.getULong64("seq", 0);
    if (v2Prefs.begin("classroom", false)) {
      v2StudentToken = v2Prefs.getString("v2token", "");
      v2DeviceSecret = v2Prefs.getString("v2secret", "");
      v2CourseId = v2Prefs.getString("v2course", "");
      v2CourseCode = v2Prefs.getString("v2code", V2_COURSE_CODE);
      v2StudentName = v2Prefs.getString("v2name", V2_STUDENT_NAME);
      configuredSsid = v2Prefs.getString("ssid", WIFI_SSID);
      configuredPassword = v2Prefs.getString("pass", WIFI_PASSWORD);
      configuredServer = v2Prefs.getString("server", SERVER_BASE_URL);
      configuredDeviceId = v2Prefs.getString("device", "");
      model.v2TokenReady = v2StudentToken.length() > 0;
    }
    WiFi.mode(WIFI_STA);
    WiFi.begin(configuredSsid.c_str(), configuredPassword.c_str());
  }

  String endpoint(const char* path) const {
    String base = configuredServer.length() ? configuredServer : String(SERVER_BASE_URL);
    while (base.endsWith("/")) base.remove(base.length() - 1);
    return base + path;
  }

  // Persist before transmission so a reboot cannot reuse a photo deduplication key.
  uint64_t nextSeq() {
    if (!sequenceReady || clientSeq >= 9007199254740991ULL) return 0;
    uint64_t next = clientSeq + 1;
    if (prefs.putULong64("seq", next) != sizeof(next)) return 0;
    clientSeq = next;
    return next;
  }

  static void configureHttp(HTTPClient& http, uint16_t timeout = 2500) {
    http.setConnectTimeout(2500);
    http.setTimeout(timeout);
    http.addHeader("X-Device-Token", DEVICE_TOKEN);
  }

  bool request(const char* path, JsonDocument* body, JsonDocument& response) {
    if (WiFi.status() != WL_CONNECTED) { setStatus("WIFI OFFLINE"); return false; }
    HTTPClient http;
    if (!http.begin(endpoint(path))) { setStatus("HTTP BEGIN ERROR"); return false; }
    configureHttp(http);
    int code;
    if (body) {
      String payload;
      serializeJson(*body, payload);
      http.addHeader("Content-Type", "application/json");
      code = http.POST(payload);
    } else code = http.GET();
    String payload = code > 0 ? http.getString() : "";
    http.end();
    if (code < 200 || code >= 300) {
      setStatus("HTTP " + String(code));
      if (code == 409) model.synced = false;
      return false;
    }
    if (deserializeJson(response, payload)) { setStatus("INVALID JSON"); return false; }
    setStatus("ONLINE");
    return true;
  }

  String v2Path(const char* suffix) const {
    String path = V2_API_BASE_PATH;
    while (path.endsWith("/")) path.remove(path.length() - 1);
    return path + suffix;
  }

  // V2 student credentials are obtained only from the device binding response.
  bool v2Request(const String& path, const char* method, JsonDocument* body,
                 JsonDocument& response, bool useStudentToken = true) {
    if (WiFi.status() != WL_CONNECTED) { setStatus("WIFI OFFLINE"); return false; }
    HTTPClient http;
    if (!http.begin(endpoint(path.c_str()))) { setStatus("V2 HTTP BEGIN ERROR"); return false; }
    http.setConnectTimeout(2500); http.setTimeout(8000);
    if (body) http.addHeader("Content-Type", "application/json");
    if (useStudentToken && v2StudentToken.length())
      http.addHeader("Authorization", "Bearer " + v2StudentToken);
    String payload;
    int code;
    if (body) serializeJson(*body, payload);
    code = strcmp(method, "POST") == 0 ? http.POST(payload) : http.GET();
    String responsePayload = code > 0 ? http.getString() : "";
    http.end();
    if (code < 200 || code >= 300) { setStatus("V2 HTTP " + String(code)); return false; }
    if (deserializeJson(response, responsePayload)) { setStatus("V2 INVALID JSON"); return false; }
    return true;
  }

  bool bindV2() {
    if (!V2_MODE_ENABLED) { setStatus("V2 DISABLED"); return false; }
    if (v2CourseCode.isEmpty() || v2StudentName.isEmpty()) {
      setStatus("V2 COURSE/NAME REQUIRED"); return false;
    }
    JsonDocument body, response;
    body["courseCode"] = v2CourseCode;
    body["studentName"] = v2StudentName;
    body["deviceId"] = deviceId();
    if (v2StudentToken.length()) body["studentToken"] = v2StudentToken;
    if (v2DeviceSecret.length()) body["deviceSecret"] = v2DeviceSecret;
    // Binding is the one V2 request without Authorization or a teacher/device token.
    if (!v2Request(v2Path("/courses/join"), "POST", &body, response, false)) return false;
    const char* token = response["studentToken"] | "";
    if (!token || !token[0]) token = response["token"] | "";
    if (!token || !token[0]) { setStatus("V2 BIND NO STUDENT TOKEN"); return false; }
    v2StudentToken = token;
    v2DeviceSecret = response["deviceSecret"] | v2DeviceSecret;
    v2CourseId = response["course"]["id"] | "";
    if (v2CourseId.isEmpty()) v2CourseId = response["courseId"] | "";
    model.v2TokenReady = true;
    v2Prefs.putString("v2token", v2StudentToken);
    v2Prefs.putString("v2secret", v2DeviceSecret);
    v2Prefs.putString("v2course", v2CourseId);
    v2Prefs.putString("v2code", v2CourseCode);
    v2Prefs.putString("v2name", v2StudentName);
    setStatus("V2 BOUND");
    return true;
  }

  bool pollV2() {
    if (!V2_MODE_ENABLED || !model.v2TokenReady || v2StudentToken.isEmpty()) {
      if (V2_MODE_ENABLED) setStatus("V2 TOKEN REQUIRED; USE V2_BIND");
      return false;
    }
    JsonDocument response;
    if (v2CourseId.isEmpty()) { setStatus("V2 COURSE REQUIRED"); return false; }
    String currentPath = String("/courses/") + v2CourseId + "/current";
    if (!v2Request(v2Path(currentPath.c_str()), "GET", nullptr, response)) {
      model.v2Synced = false; dirty = true; return false;
    }
    // The formal v2 response is current.activity.question, while older
    // deployments returned activity.question or activity at the top level.
    JsonVariantConst current = response["current"].isNull()
      ? response.as<JsonVariantConst>() : response["current"].as<JsonVariantConst>();
    JsonVariantConst activity = current["activity"].isNull()
      ? current : current["activity"].as<JsonVariantConst>();
    JsonVariantConst question = activity["question"].isNull()
      ? activity : activity["question"].as<JsonVariantConst>();
    if (!activity["id"].is<const char*>()) {
      model.v2Synced = false; model.v2ActivityId = ""; model.v2Submitted = false;
      dirty = true; setStatus("V2 WAITING FOR ACTIVITY"); return true;
    }
    if (model.v2ActivityId == activity["id"].as<String>()) {
      model.v2Synced = true; return true;
    }
    model.v2ActivityId = activity["id"].as<String>();
    model.v2ActivityType = activity["modeType"] | "";
    if (model.v2ActivityType.isEmpty()) model.v2ActivityType = activity["type"] | "";
    model.v2Prompt = question["prompt"] | "";
    if (model.v2Prompt.isEmpty()) model.v2Prompt = question["word"] | "";
    if (model.v2Prompt.isEmpty()) model.v2Prompt = question["expression"] | "";
    model.v2Definition = question["definition"] | "";
    model.v2ArithmeticInput = "";
    model.v2Result = "";
    model.v2Submitted = false;
    model.v2Practice = activity["practice"] | false;
    model.v2PracticeMode = model.v2ActivityType;
    JsonArrayConst options = question["options"].as<JsonArrayConst>();
    for (uint8_t i = 0; i < 4; ++i) model.v2Options[i] = i < options.size() ? options[i].as<String>() : "";
    model.v2Synced = true;
    dirty = true;
    setStatus("V2 ONLINE");
    return true;
  }

  bool submitV2Answer(const String& value) {
    if (!V2_MODE_ENABLED || !model.v2Synced || model.v2ActivityId.isEmpty() || model.v2Submitted) return false;
    if (!model.v2TokenReady || v2StudentToken.isEmpty()) { setStatus("V2 TOKEN REQUIRED"); return false; }
    JsonDocument body, response;
    const bool vocabulary = model.v2ActivityType.indexOf("vocab") >= 0;
    const bool arithmetic = model.v2ActivityType.indexOf("arith") >= 0 || model.v2ActivityType.indexOf("number") >= 0;
    if (!vocabulary && !arithmetic) {
      setStatus("V2 STROKE NOT IMPLEMENTED");
      return false;
    }
    if (vocabulary) {
      int index = value.toInt();
      for (uint8_t i = 0; i < 4; ++i) if (model.v2Options[i] == value) index = i;
      body["answer"] = index;
    } else {
      body["answer"] = value.toInt();
    }
    uint64_t eventSeq = nextSeq();
    if (!eventSeq) { setStatus("SEQUENCE STORAGE ERROR"); return false; }
    body["clientEventId"] = deviceId() + "-v2-" + String((unsigned long long)eventSeq);
    String answerPath = String("/courses/") + v2CourseId + "/activities/" + model.v2ActivityId + "/answers";
    if (!v2Request(v2Path(answerPath.c_str()), "POST", &body, response)) return false;
    if (!response["correct"].is<bool>() && !response["duplicate"].is<bool>()) { setStatus("V2 ANSWER NOT ACCEPTED"); return false; }
    model.v2ArithmeticInput = value;
    model.v2Result = response["result"] | "";
    if (model.v2Result.isEmpty()) model.v2Result = (response["correct"] | false) ? "CORRECT" : "INCORRECT";
    model.v2Submitted = true;
    dirty = true;
    setStatus("V2 ANSWER ACCEPTED");
    return true;
  }

  bool nextV2Practice(const String& modeType) {
    if (v2CourseId.isEmpty() || !model.v2TokenReady) { setStatus("V2 TOKEN REQUIRED"); return false; }
    JsonDocument body, response;
    body["modeType"] = modeType;
    String path = String("/courses/") + v2CourseId + "/practice/next";
    if (!v2Request(v2Path(path.c_str()), "POST", &body, response)) return false;
    JsonVariantConst activity = response["activity"];
    if (activity.isNull() || !activity["id"].is<const char*>()) { setStatus("PRACTICE INVALID"); return false; }
    return applyV2Activity(activity);
  }

  bool startV2Practice(const String& modeType) {
    if (model.mode != "idle") { setStatus("CLASSROOM ACTIVITY ACTIVE"); return false; }
    return nextV2Practice(modeType);
  }

  bool recognizeHandwriting(uint16_t width, uint16_t height, const JsonArrayConst& strokes) {
    if (v2CourseId.isEmpty() || !model.v2TokenReady) return false;
    JsonDocument body, response; body["width"] = width; body["height"] = height; body["strokes"] = strokes;
    String path = String("/courses/") + v2CourseId + "/handwriting/recognize";
    if (!v2Request(v2Path(path.c_str()), "POST", &body, response)) return false;
    model.v2RecognizedText = response["recognizedText"] | "";
    model.v2Confidence = response["confidence"] | 0.0f;
    model.v2NeedsConfirmation = response["needsConfirmation"] | true;
    model.v2ArithmeticInput = model.v2RecognizedText;
    dirty = true; return model.v2RecognizedText.length() > 0;
  }

  bool submitV2Stroke(uint16_t width, uint16_t height, const JsonArrayConst& strokes, const String& value) {
    if (!model.v2Synced || model.v2Submitted || model.v2ActivityId.isEmpty()) return false;
    JsonDocument body, response; body["answer"]["type"] = "stroke"; body["answer"]["width"] = width; body["answer"]["height"] = height; body["answer"]["strokes"] = strokes; body["answer"]["value"] = value.toInt();
    uint64_t seq = nextSeq(); if (!seq) { setStatus("SEQUENCE STORAGE ERROR"); return false; }
    body["clientEventId"] = deviceId() + "-v2-" + String((unsigned long long)seq);
    String path = String("/courses/") + v2CourseId + "/activities/" + model.v2ActivityId + "/answers";
    if (!v2Request(v2Path(path.c_str()), "POST", &body, response)) return false;
    model.v2Submitted = true; model.v2ArithmeticInput = value; model.v2Result = (response["correct"] | false) ? "CORRECT" : "INCORRECT"; dirty = true; return true;
  }

  String deviceId() const {
    if (configuredDeviceId.length()) return configuredDeviceId;
    if (String(DEVICE_ID).length()) return String(DEVICE_ID);
    char id[24];
    const uint64_t mac = ESP.getEfuseMac();
    snprintf(id, sizeof(id), "MAX35-%04X%08X", (uint16_t)(mac >> 32), (uint32_t)mac);
    return String(id);
  }
  bool discoverServer(uint16_t listenPort = 41235) {
    WiFiUDP udp; if (!udp.begin(listenPort)) return false;
    udp.beginPacket(IPAddress(255,255,255,255), listenPort); udp.print("service=cloud-classroom protocol=v2"); udp.endPacket();
    uint32_t until = millis() + 800;
    while ((int32_t)(until - millis()) > 0) { int n=udp.parsePacket(); if (n <= 0) { delay(10); continue; } String payload=udp.readString(); if (payload.indexOf("service=cloud-classroom") < 0 || payload.indexOf("protocol=v2") < 0) continue; int ipAt=payload.indexOf("ip="); int portAt=payload.indexOf("port="); if (ipAt>=0 && portAt>=0) { String ip=payload.substring(ipAt+3,payload.indexOf(' ',ipAt)); String port=payload.substring(portAt+5); port.trim(); configuredServer="http://"+ip+":"+port; v2Prefs.putString("server",configuredServer); udp.stop(); return true; } }
    udp.stop(); return false;
  }
  void saveNetwork(const String& ssid, const String& pass, const String& server) { configuredSsid=ssid; configuredPassword=pass; configuredServer=server; v2Prefs.putString("ssid",ssid); v2Prefs.putString("pass",pass); v2Prefs.putString("server",server); }
  void saveDeviceId(const String& value) { configuredDeviceId=value; v2Prefs.putString("device",value); }
  const String& serverUrl() const { return configuredServer; }

  bool selectV2Option(uint8_t index) {
    if (index >= 4 || model.v2Options[index].isEmpty()) return false;
    return submitV2Answer(model.v2Options[index]);
  }

  void configureV2(const String& code, const String& name) {
    if (v2CourseCode != code) { v2StudentToken=""; v2DeviceSecret=""; v2CourseId=""; model.v2TokenReady=false; model.v2Synced=false; v2Prefs.remove("v2token"); v2Prefs.remove("v2secret"); v2Prefs.remove("v2course"); }
    v2CourseCode = code; v2StudentName = name;
    v2Prefs.putString("v2code", code); v2Prefs.putString("v2name", name);
    setStatus("V2 CONFIGURED; USE V2_BIND");
  }

  bool applyV2Activity(JsonVariantConst activity) {
    JsonVariantConst question = activity["question"];
    model.v2ActivityId = activity["id"] | ""; model.v2ActivityType = activity["modeType"] | "";
    model.v2Prompt = question["word"] | ""; if (model.v2Prompt.isEmpty()) model.v2Prompt = question["expression"] | ""; model.v2Definition = question["definition"] | "";
    JsonArrayConst options = question["options"].as<JsonArrayConst>(); for (uint8_t i=0;i<4;i++) model.v2Options[i] = i < options.size() ? options[i].as<String>() : "";
    model.v2Practice = activity["practice"] | false; model.v2Synced=true; model.v2Submitted=false; model.v2ArithmeticInput=""; model.v2Result=""; dirty=true; return true;
  }

  bool applyState(JsonVariantConst state, uint32_t responseRttMs = 0) {
    if (!state["mode"].is<const char*>() || !state["roundId"].is<const char*>()) return false;
    String mode = state["mode"].as<String>();
    if (mode != "idle" && mode != "quiz" && mode != "buzzer" && mode != "photo") return false;
    String question = state["question"]["id"] | "";
    String round = state["roundId"] | "";
    if (mode == "quiz" && question.isEmpty()) return false;
    if (question != model.questionId) {
      model.answer = "";
      model.submitted = false;
    }
    const bool newRound = round != model.roundId;
    if (newRound) {
      model.buzzState = "BUZZ";
      model.roundStartedAt = millis();
    }
    if (mode == "buzzer") {
      model.roundDeadlineAt = state["roundDeadlineAt"] | "";
      int64_t deadlineEpoch = parseIsoMillis(model.roundDeadlineAt);
      int64_t serverEpoch = parseIsoMillis(state["serverNow"] | "");
      int64_t remaining = deadlineEpoch >= 0 && serverEpoch >= 0 ? deadlineEpoch - serverEpoch : -1;
      // Full RTT is conservative even with asymmetric network delays; no RTC needed.
      int64_t conservative = remaining >= 0 && remaining <= 120000 ? remaining - responseRttMs : 0;
      uint32_t sampledAt = millis();
      uint32_t candidate = sampledAt + (uint32_t)(conservative > 0 ? conservative : 0);
      // Polls can shorten the gate, never reopen or extend this round.
      if (newRound || (int32_t)(candidate - model.roundDeadlineMillis) < 0)
        model.roundDeadlineMillis = candidate;
    }
    if (mode != "buzzer") { model.roundDeadlineAt = ""; model.roundDeadlineMillis = 0; }
    if (mode != model.mode) model.photoState = "PHOTO READY";
    model.mode = mode;
    model.questionId = question;
    model.roundId = round;
    // A teacher-controlled legacy classroom activity takes priority over any
    // personal V2 practice screen. Do not let stale practice UI overlay it.
    if (mode != "idle") {
      model.v2Synced = false;
      model.v2Submitted = false;
      model.v2ActivityId = "";
      model.v2ActivityType = "";
    }
    String winner = state["buzzWinner"]["deviceId"] | "";
    if (mode == "buzzer" && winner.length())
      model.buzzState = winner == deviceId() ? "WINNER" : "LOST";
    for (JsonObjectConst event : state["answers"].as<JsonArrayConst>()) {
      if (event["deviceId"].as<String>() == deviceId() && event["questionId"] == question) {
        model.answer = event["answer"] | "";
        model.submitted = true;
      }
    }
    model.synced = true;
    dirty = true;
    return true;
  }

  bool poll() {
    JsonDocument response;
    lastPoll = millis();
    uint32_t requestStarted = millis();
    if (!request("/api/state", nullptr, response) || !applyState(response.as<JsonVariantConst>(), millis() - requestStarted)) {
      model.synced = false;
      dirty = true;
      return false;
    }
    return true;
  }

  void tick() {
    if (WiFi.status() != WL_CONNECTED) {
      model.synced = false;
      if (wasConnected) { wasConnected = false; setStatus("WIFI OFFLINE"); }
      if (millis() - lastReconnect >= 10000) {
        lastReconnect = millis();
        WiFi.reconnect();
      }
      return;
    }
    bool connectedNow = !wasConnected;
    wasConnected = true;
    if (connectedNow || millis() - lastPoll >= 3000) poll();
    if (connectedNow || millis() - lastHeartbeat >= 30000) {
      lastHeartbeat = millis();
      JsonDocument body, response;
      body["deviceId"] = deviceId();
      body["name"] = deviceId();
      uint32_t requestStarted = millis();
      if (request("/api/device/heartbeat", &body, response) && response["ok"] == true)
        applyState(response["state"], millis() - requestStarted);
    }
    if (V2_MODE_ENABLED && model.v2TokenReady && model.mode == "idle" && !model.v2Practice && millis() - lastV2Poll >= 3000) {
      lastV2Poll = millis();
      pollV2();
    }
  }

  void selectAnswer(char answer) {
    if (model.synced && model.mode == "quiz" && !model.submitted && answer >= 'A' && answer <= 'D') {
      model.answer = String(answer);
      dirty = true;
    }
  }

  void submitAnswer() {
    if (!model.synced || model.mode != "quiz" || model.submitted || model.answer.length() != 1) return;
    uint64_t seq = nextSeq();
    if (!seq) { setStatus("SEQUENCE STORAGE ERROR"); return; }
    JsonDocument body, response;
    body["deviceId"] = deviceId();
    body["questionId"] = model.questionId;
    body["answer"] = model.answer;
    body["clientSeq"] = seq;
    if (request("/api/device/answer", &body, response) && response["ok"] == true &&
        (response["accepted"] == true || response["duplicate"] == true)) {
      model.answer = response["event"]["answer"] | model.answer;
      model.submitted = true;
      dirty = true;
    }
    // Reconcile ambiguous timeouts and stale question responses with server truth.
    poll();
  }

  uint32_t rushSecondsRemaining() const {
    if (!model.roundDeadlineMillis) return 0;
    const int32_t remaining = (int32_t)(model.roundDeadlineMillis - millis());
    return remaining <= 0 ? 0 : (remaining + 999) / 1000;
  }

  void buzz() {
    if (!model.synced || model.mode != "buzzer" || model.buzzState != "BUZZ") return;
    if (!rushSecondsRemaining()) { setStatus("BUZZ TIME EXPIRED"); return; }
    uint64_t seq = nextSeq();
    if (!seq) { setStatus("SEQUENCE STORAGE ERROR"); return; }
    JsonDocument body, response;
    body["deviceId"] = deviceId();
    body["roundId"] = model.roundId;
    body["clientSeq"] = seq;
    if (request("/api/device/buzz", &body, response) && response["ok"] == true) {
      String winner = response["winner"]["deviceId"] | "";
      if (winner.length()) model.buzzState = winner == deviceId() ? "WINNER" : "LOST";
      dirty = true;
    }
    poll();
  }

  bool command(String command) {
    String rawCommand = command;
    rawCommand.trim();
    command.toUpperCase();
    if (command.length() == 1 && command[0] >= 'A' && command[0] <= 'D') selectAnswer(command[0]);
    else if (command == "OK") submitAnswer();
    else if (command == "BUZZ") buzz();
    else if (command == "SYNC") poll();
    else if (command == "V2_STATUS") {
      Serial.printf("v2_ready=%d v2_synced=%d practice=%d submitted=%d type=%s prompt=%s result=%s status=%s\n",
        model.v2TokenReady, model.v2Synced, model.v2Practice, model.v2Submitted,
        model.v2ActivityType.c_str(), model.v2Prompt.c_str(), model.v2Result.c_str(), model.status.c_str());
    }
    else if (command == "V2_BIND") bindV2();
    else if (command == "V2_SYNC") pollV2();
    else if (command.startsWith("V2_CONFIG ")) {
      int split = rawCommand.indexOf(' ', 10);
      if (split > 10) configureV2(rawCommand.substring(10, split), rawCommand.substring(split + 1));
      else setStatus("V2_CONFIG CODE NAME REQUIRED");
    }
    else if (command == "V2_NEXT_VOCAB") nextV2Practice("vocabulary");
    else if (command == "V2_NEXT_ARITH") nextV2Practice("arithmetic");
    else if (command.startsWith("V2_ANSWER ")) submitV2Answer(rawCommand.substring(11));
    else if (command.startsWith("V2_OPTION ")) selectV2Option((uint8_t)command.substring(10).toInt());
    else if (command == "STATUS")
      Serial.printf("mode=%s synced=%d submitted=%d answer=%s buzz=%s photo=%s status=%s round=%s remaining=%lu seq=%llu\n",
        model.mode.c_str(), model.synced, model.submitted, model.answer.c_str(),
        model.buzzState.c_str(), model.photoState.c_str(), model.status.c_str(), model.roundId.c_str(),
        (unsigned long)rushSecondsRemaining(), clientSeq);
      else if (command == "HELP") Serial.println("A B C D OK BUZZ SYNC STATUS V2_CONFIG CODE NAME V2_BIND V2_SYNC V2_NEXT_VOCAB V2_NEXT_ARITH V2_OPTION 0..3 V2_ANSWER <value>");
    else return false;
    return true;
  }

  void setStatus(const String& status) { model.status = status; dirty = true; }

 private:
  static int64_t parseIsoMillis(const String& value) {
    int year, month, day, hour, minute, second, millisPart = 0;
    if (sscanf(value.c_str(), "%d-%d-%dT%d:%d:%d.%dZ", &year, &month, &day, &hour, &minute, &second, &millisPart) < 6) return -1;
    if (month <= 2) { year--; month += 12; }
    int64_t days = 365LL * year + year / 4 - year / 100 + year / 400 + (153LL * (month - 3) + 2) / 5 + day - 719469;
    return ((days * 24 + hour) * 60 + minute) * 60000LL + second * 1000LL + millisPart;
  }

  Preferences prefs, v2Prefs;
   String v2StudentToken, v2DeviceSecret, v2CourseId, v2CourseCode, v2StudentName;
  String configuredSsid, configuredPassword, configuredServer, configuredDeviceId;
  bool sequenceReady = false, wasConnected = false;
  uint32_t lastPoll = 0, lastHeartbeat = 0, lastReconnect = 0, lastV2Poll = 0;
};
