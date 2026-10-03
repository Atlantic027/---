#include "classroom_config.h"
#include <ClassroomClient.h>
#include "display_hal.h"
#include "camera_hal.h"

#ifndef RUSH_COUNTDOWN_SECONDS
#define RUSH_COUNTDOWN_SECONDS 10
#endif

ClassroomClient classroom;
Max35Display lcd;
Max35Touch touch;
String serialLine;
uint32_t lastTouch = 0;
uint8_t* pendingJpeg = nullptr;
size_t pendingJpegLength = 0;
uint32_t pendingPhotoGeneration = 0;
uint64_t pendingPhotoSeq = 0;
bool previewDecoded = false;
bool cameraReady = false;
bool liveFrameReady = false;
String cameraError;
uint32_t lastPreviewFrame = 0;
uint32_t rushRemaining = RUSH_COUNTDOWN_SECONDS;
bool rushExpired = false;
String v2ArithmeticValue;
enum UiPage { HOME, SETTINGS, WIFI_PICKER, COURSE_JOIN, PRACTICE };
UiPage uiPage = HOME;
String uiInput, uiFeedback, selectedSsid;
bool handwritingDown = false, handwritingReady = false;
uint16_t handwritingX = 0, handwritingY = 0;
JsonDocument handwritingDoc;
JsonArray handwritingStrokes;
size_t handwritingPointCount = 0;
String handwritingActivityId;
const UiRect PRACTICE_OPTIONS[] = {{12,140,296,38},{12,184,296,38},{12,228,296,38},{12,272,296,38}};
const UiRect PRACTICE_HOME = {12,400,140,48};
const UiRect PRACTICE_NEXT = {168,400,140,48};
const UiRect PRACTICE_CLEAR = {12,310,296,18};
const UiRect HANDWRITING_AREA = {12,174,296,116};
bool buttonHeld = false;

void clearHandwriting() {
  handwritingDoc.clear(); handwritingStrokes = JsonArray(); handwritingPointCount = 0;
  handwritingDown = false; handwritingReady = false; v2ArithmeticValue = "";
  classroom.model.v2RecognizedText = ""; classroom.model.v2ArithmeticInput = "";
  classroom.model.v2NeedsConfirmation = false; classroom.model.v2Confidence = 0;
}

void nextPracticeQuestion() {
  const String mode = classroom.model.v2ActivityType;
  if (classroom.nextV2Practice(mode)) {
    clearHandwriting();
    handwritingActivityId = classroom.model.v2ActivityId;
    classroom.dirty = true;
  }
}

struct ScreenSnapshot {
  String mode, status, answer, buzzState, photoState;
  String v2ActivityId, v2Definition, v2Result, input, feedback;
  UiPage page = HOME;
  bool v2Synced = false, v2Submitted = false;
  bool synced = false, submitted = false, busy = false, touchAvailable = false;
  uint32_t photoGeneration = 0;
  uint32_t rushRemaining = 0;
  bool valid = false;
};

ScreenSnapshot lastScreen;

bool screenChanged() {
  const ClassroomModel& m = classroom.model;
  return !lastScreen.valid || lastScreen.mode != m.mode || lastScreen.status != m.status ||
    lastScreen.page != uiPage || lastScreen.v2ActivityId != m.v2ActivityId ||
    lastScreen.v2Synced != m.v2Synced || lastScreen.v2Submitted != m.v2Submitted ||
    lastScreen.v2Definition != m.v2Definition || lastScreen.v2Result != m.v2Result || lastScreen.input != uiInput || lastScreen.feedback != uiFeedback ||
    lastScreen.answer != m.answer || lastScreen.buzzState != m.buzzState ||
    lastScreen.photoState != m.photoState || lastScreen.synced != m.synced ||
    lastScreen.submitted != m.submitted || lastScreen.busy != m.busy ||
    lastScreen.touchAvailable != touch.available ||
    lastScreen.photoGeneration != pendingPhotoGeneration || lastScreen.rushRemaining != rushRemaining;
}

void discardPendingPhoto() {
  releaseJpeg(pendingJpeg, pendingJpegLength);
  pendingPhotoSeq = 0;
  previewDecoded = false;
  ++pendingPhotoGeneration;
}

// Designer entry point: render only; this runs exclusively on the loop task.
void drawScreen() {
  const ClassroomModel& m = classroom.model;
  lcd.fillScreen(COLOR_BG);

  // 1. 顶部状态栏：模式与网络状态
  lcd.fillRect(0, 0, 320, 48, COLOR_PANEL);
  lcd.drawFastHLine(0, 48, 320, COLOR_BORDER);

  lcd.setFont(&fonts::efontCN_16);
  lcd.setTextColor(TFT_WHITE, COLOR_PANEL);
  lcd.setTextDatum(middle_left);

  if (uiPage == SETTINGS) {
    lcd.setFont(&fonts::efontCN_16); lcd.setTextDatum(middle_center); lcd.setTextColor(TFT_WHITE, COLOR_BG);
    lcd.drawString("设置", 160, 68); lcd.setFont(&fonts::Font0); lcd.drawString("WiFi 扫描", 80, 150); lcd.drawString("加入课程", 240, 150); lcd.drawString("设备ID", 160, 220); lcd.drawString(classroom.deviceId().c_str(),160,250); drawButton(lcd,UI_CONFIRM,"返回首页",COLOR_PANEL,TFT_WHITE,true);
  } else if (uiPage == WIFI_PICKER) {
    String masked; for (size_t i=0; i<uiInput.length(); ++i) masked += '*';
    String passwordLabel = "密码: " + masked;
    lcd.setFont(&fonts::efontCN_16); lcd.setTextDatum(middle_center); lcd.drawString("选择 WiFi",160,68); lcd.setFont(&fonts::Font0); int networks=WiFi.scanComplete(); for(int i=0;i<networks && i<4;i++) lcd.drawString(WiFi.SSID(i).c_str(),80,110+i*38); lcd.drawString(selectedSsid.length()?selectedSsid.c_str():"点选网络",220,110); lcd.drawString(passwordLabel.c_str(),160,290); drawButton(lcd,UI_CONFIRM,"连接保存",COLOR_ACCENT,TFT_WHITE,true);
  } else if (uiPage == COURSE_JOIN) {
    String joinLabel = "课程码/姓名: " + uiInput;
    lcd.setFont(&fonts::efontCN_16); lcd.setTextDatum(middle_center); lcd.drawString("加入课程",160,68); lcd.setFont(&fonts::Font0); lcd.drawString(joinLabel.c_str(),160,160); drawButton(lcd,UI_CONFIRM,"加入并保存",COLOR_ACCENT,TFT_WHITE,true);
  } else if (uiPage == HOME && !m.v2Synced && m.mode == "idle") {
    lcd.setFont(&fonts::efontCN_16); lcd.setTextDatum(middle_center); lcd.drawString("MAX35 自主练习",160,68);
    drawButton(lcd,UI_OPTIONS[0],"课堂答题",COLOR_PRIMARY,TFT_WHITE,true); drawButton(lcd,UI_OPTIONS[1],"背单词",COLOR_ACCENT,TFT_WHITE,true); drawButton(lcd,UI_OPTIONS[2],"手写速算",COLOR_SUCCESS,TFT_WHITE,true); drawButton(lcd,UI_OPTIONS[3],"设置/加入课程",COLOR_PANEL,TFT_WHITE,true);
    if (!m.v2TokenReady) { lcd.setTextColor(COLOR_WARNING,COLOR_BG); lcd.drawString("先加入课程以同步成绩",160,390); }
  } else if (m.v2Synced) {
    lcd.setFont(&fonts::efontCN_16); lcd.setTextDatum(middle_center); lcd.setTextColor(TFT_WHITE, COLOR_BG);
    lcd.drawString(m.v2ActivityType.indexOf("vocab") >= 0 ? "词汇练习" : "算数练习", 160, 68);
    lcd.setFont(&fonts::Font0); lcd.setTextColor(TFT_CYAN, COLOR_BG);
    lcd.setTextSize(m.v2ActivityType == "arithmetic" ? 4 : 2);
    lcd.drawString(m.v2Prompt.c_str(), 160, 105);
    lcd.setTextSize(1);
    if (m.v2Definition.length()) { lcd.setTextColor(TFT_LIGHTGRAY, COLOR_BG); lcd.drawString(m.v2Definition.substring(0,48).c_str(), 160, 126); }
    if (m.v2ActivityType.indexOf("vocab") >= 0) {
      for (int i = 0; i < 4; ++i) if (m.v2Options[i].length()) drawOptionButton(lcd, PRACTICE_OPTIONS[i], m.v2Options[i].c_str(), m.v2ArithmeticInput == m.v2Options[i] ? COLOR_PRIMARY : COLOR_PANEL, COLOR_BORDER, true);
      drawButton(lcd, UI_V2_CONFIRM, m.v2Submitted ? (m.v2Result == "CORRECT" ? "回答正确" : "回答错误") : "点击中文释义作答", COLOR_PANEL, TFT_WHITE, true);
    } else {
      lcd.setTextColor(TFT_WHITE, COLOR_BG);
      if (v2ArithmeticValue.length()) {
        lcd.setFont(&fonts::Font0); lcd.setTextSize(4);
        lcd.drawString(v2ArithmeticValue.c_str(),160,148); lcd.setTextSize(1);
      } else {
        lcd.setFont(&fonts::efontCN_16); lcd.drawString("在框内书写答案",160,148);
      }
      lcd.drawRect(HANDWRITING_AREA.x-1,HANDWRITING_AREA.y-1,HANDWRITING_AREA.w+2,HANDWRITING_AREA.h+2,COLOR_BORDER);
      for (JsonArray stroke : handwritingStrokes) {
        int previousX = -1, previousY = -1;
        for (JsonObject point : stroke) {
          int px = HANDWRITING_AREA.x + point["x"].as<int>();
          int py = HANDWRITING_AREA.y + point["y"].as<int>();
          if (previousX >= 0) lcd.drawLine(previousX,previousY,px,py,TFT_WHITE);
          lcd.fillCircle(px,py,1,TFT_WHITE); previousX=px; previousY=py;
        }
      }
      drawButton(lcd, UI_V2_CONFIRM, m.v2Submitted ? "下一题" : (handwritingReady ? "识别手写" : (v2ArithmeticValue.length() ? "确认并提交" : "写出答案")), m.v2Submitted ? COLOR_SUCCESS : COLOR_ACCENT, TFT_WHITE, true);
      if (m.v2Result.length()) { lcd.setTextColor(m.v2Result == "CORRECT" ? COLOR_SUCCESS : COLOR_WARNING,COLOR_BG); lcd.drawString(m.v2Result == "CORRECT" ? "回答正确" : "答案已记录",160,300); }
      drawButton(lcd, PRACTICE_CLEAR, "清空重写", COLOR_PANEL, TFT_WHITE, true);
    }
    drawButton(lcd, PRACTICE_HOME, "返回首页", COLOR_PANEL, TFT_WHITE, true);
    drawButton(lcd, PRACTICE_NEXT, "下一题", COLOR_ACCENT, TFT_WHITE, true);
  } else if (m.mode == "quiz") {
    lcd.drawString("课堂模式: 选择题答题", 12, 16);
  } else if (m.mode == "buzzer") {
    lcd.drawString("课堂模式: 实时抢答", 12, 16);
  } else if (m.mode == "photo") {
    lcd.drawString("课堂模式: 拍摄上传", 12, 16);
  } else {
    lcd.drawString("课堂模式: 待机闲置", 12, 16);
  }

  // 状态行
  lcd.setFont(&fonts::Font0); // 8px 系统字体用于显示英文/网络状态码
  lcd.setTextColor(m.synced ? TFT_GREEN : TFT_ORANGE, COLOR_PANEL);
  lcd.setTextDatum(middle_left);
  lcd.drawString(m.status.c_str(), 12, 36);

  // 2. 主区域绘制 (严格保持与 touch 判定的 UI_* 矩形一致)
  if (uiPage != HOME || (m.mode == "idle" && !m.v2Synced)) {
    // Keep the page content above the home-only interaction renderer.
  } else if (m.v2Synced) {
    // V2 touch actions are handled in handleTouch(), where x/y are scoped.
  } else if (m.mode == "quiz") {
    // 提示学生看教师大屏幕
    lcd.setFont(&fonts::efontCN_16);
    lcd.setTextDatum(middle_center);
    lcd.setTextColor(TFT_LIGHTGRAY, COLOR_BG);
    lcd.drawString("请看大屏题目，点击下方选项作答", 160, 68);

    const char* letters[] = {"A", "B", "C", "D"};
    for (int i = 0; i < 4; ++i) {
      bool isSelected = (m.answer == letters[i]);
      uint16_t bg = isSelected ? COLOR_PRIMARY : COLOR_PANEL;
      uint16_t border = isSelected ? TFT_CYAN : COLOR_BORDER;
      drawOptionButton(lcd, UI_OPTIONS[i], letters[i], bg, border);
    }

    if (m.submitted) {
      String confirmText = "已提交 (" + m.answer + ")";
      drawButton(lcd, UI_CONFIRM, confirmText.c_str(), COLOR_SUCCESS, TFT_WHITE, true);
    } else {
      bool canSubmit = m.answer.length() == 1;
      drawButton(lcd, UI_CONFIRM, "确认提交", canSubmit ? COLOR_ACCENT : COLOR_PANEL, canSubmit ? TFT_WHITE : TFT_DARKGRAY, true);
    }

  } else if (m.mode == "buzzer") {
    if (m.buzzState == "WINNER") {
      drawButton(lcd, UI_BUZZ, "抢答成功！(赢家)", COLOR_SUCCESS, TFT_WHITE, true);
      lcd.setFont(&fonts::efontCN_16);
      lcd.setTextDatum(middle_center);
      lcd.setTextColor(COLOR_WARNING, COLOR_BG);
      lcd.drawString("恭喜！你是本轮第一名！", 160, 180);
    } else if (m.buzzState == "LOST") {
      drawButton(lcd, UI_BUZZ, "本轮抢答已结束", COLOR_PANEL, TFT_DARKGRAY, true);
      lcd.setFont(&fonts::efontCN_16);
      lcd.setTextDatum(middle_center);
      lcd.setTextColor(TFT_LIGHTGRAY, COLOR_BG);
      lcd.drawString("他人抢先，下次加油！", 160, 180);
   } else if (rushExpired) {
      drawButton(lcd, UI_BUZZ, "时间到", COLOR_PANEL, TFT_DARKGRAY, true);
      lcd.setFont(&fonts::efontCN_16); lcd.setTextDatum(middle_center); lcd.setTextColor(COLOR_WARNING, COLOR_BG);
      lcd.drawString("本轮抢答时间已结束", 160, 180);
    } else {
      String buzzLabel = "按 此 抢 答  " + String(rushRemaining) + "s";
      drawButton(lcd, UI_BUZZ, buzzLabel.c_str(), COLOR_DANGER, TFT_WHITE, true);
      lcd.setFont(&fonts::efontCN_16);
      lcd.setTextDatum(middle_center);
      lcd.setTextColor(TFT_WHITE, COLOR_BG);
      lcd.drawString("倒计时进行中，抢答准备！", 160, 180);
    }

  } else if (m.mode == "photo") {
    lcd.setFont(&fonts::efontCN_16);
    lcd.setTextDatum(middle_center);

    if (m.busy) {
      lcd.setTextColor(COLOR_WARNING, COLOR_BG);
      lcd.drawString("正在拍摄，请稍候...", 160, 180);
      drawButton(lcd, UI_PHOTO, "处理中...", COLOR_PANEL, TFT_DARKGRAY, true);
    } else if (m.photoState == "LIVE PREVIEW") {
      lcd.setTextColor(TFT_WHITE, COLOR_BG); lcd.drawString("实时预览", 160, 68);
      lcd.drawRoundRect(12, 88, 296, 224, 6, COLOR_BORDER);
      if (!liveFrameReady) { lcd.fillRect(13, 89, 294, 222, COLOR_PANEL); lcd.setTextColor(COLOR_DANGER, COLOR_PANEL); lcd.drawString(cameraError.length() ? cameraError.c_str() : "等待相机画面", 160, 200); }
      drawButton(lcd, UI_PHOTO, "拍摄 / 冻结", COLOR_PRIMARY, TFT_WHITE, true);
    } else if (m.photoState == "PHOTO PREVIEW" && pendingJpeg && pendingJpegLength) {
      lcd.setFont(&fonts::efontCN_16);
      lcd.setTextColor(TFT_WHITE, COLOR_BG);
      lcd.setTextDatum(middle_center);
      lcd.drawString("照片预览 (确认是否上传)", 160, 68);

      // 照片预览外框 (12, 88, 296, 222)，等比容纳 QVGA (320x240)
      lcd.drawRoundRect(12, 88, 296, 224, 6, COLOR_BORDER);

      // 解码并渲染 JPEG 预览图：缩放为 0.925f (296x222)，刚好居中填满预览框，绝不覆盖下方操作按钮
      previewDecoded = lcd.drawJpg(pendingJpeg, pendingJpegLength, 12, 89, 296, 222, 0, 0, 0.925f, 0.925f);
      if (!previewDecoded) {
        lcd.fillRect(13, 89, 294, 222, COLOR_PANEL);
        lcd.setTextColor(COLOR_DANGER, COLOR_PANEL);
        lcd.setTextDatum(middle_center);
        lcd.drawString("照片解码失败，请重拍", 160, 200);
      }

      drawButton(lcd, UI_PHOTO_CONFIRM, "确认上传", previewDecoded ? COLOR_SUCCESS : COLOR_PANEL,
        previewDecoded ? TFT_WHITE : TFT_DARKGRAY, true);
      drawButton(lcd, UI_PHOTO_RETAKE, "重拍", COLOR_WARNING, TFT_WHITE, true);
      drawButton(lcd, UI_PHOTO_CANCEL, "取消", COLOR_PANEL, TFT_WHITE, true);
    } else if (m.photoState == "PHOTO OK") {
      lcd.setTextColor(COLOR_SUCCESS, COLOR_BG);
      lcd.drawString("照片上传成功！", 160, 180);
      drawButton(lcd, UI_PHOTO, "重新拍照上传", COLOR_PRIMARY, TFT_WHITE, true);
    } else if (m.photoState == "PHOTO ERROR") {
      lcd.setTextColor(COLOR_DANGER, COLOR_BG);
      lcd.drawString("照片上传失败，请重试", 160, 180);
      if (pendingJpeg && pendingJpegLength) {
        // 上传失败时保留了待传 JPEG，允许直接重试上传或重拍
        drawButton(lcd, UI_PHOTO_CONFIRM, "重试上传", COLOR_PRIMARY, TFT_WHITE, true);
        drawButton(lcd, UI_PHOTO_RETAKE, "重拍", COLOR_WARNING, TFT_WHITE, true);
        drawButton(lcd, UI_PHOTO_CANCEL, "放弃", COLOR_PANEL, TFT_WHITE, true);
      } else {
        drawButton(lcd, UI_PHOTO, "点击重新拍照", COLOR_DANGER, TFT_WHITE, true);
      }
    } else {
      lcd.setTextColor(TFT_LIGHTGRAY, COLOR_BG);
      lcd.drawString("对准黑板或作业本拍照", 160, 180);
      drawButton(lcd, UI_PHOTO, "初始化相机...", COLOR_PRIMARY, TFT_WHITE, true);
    }

  } else {
    // idle / 待机
    lcd.setFont(&fonts::efontCN_16);
    lcd.setTextDatum(middle_center);
    lcd.setTextColor(TFT_WHITE, COLOR_BG);
    lcd.drawString("等待教师发起课堂互动", 160, 200);
    lcd.setTextColor(TFT_LIGHTGRAY, COLOR_BG);
    lcd.drawString("请关注大屏幕指令", 160, 230);
  }

  // 3. 底部信息栏
  lcd.setFont(&fonts::Font0);
  lcd.setTextDatum(bottom_left);
  lcd.setTextColor(TFT_DARKGRAY, COLOR_BG);
  lcd.drawString(touch.available ? "TOUCH: GT911 OK" : "TOUCH: SERIAL ONLY", 12, 472);

  lcd.setTextDatum(bottom_right);
  lcd.drawString(classroom.deviceId().c_str(), 308, 472);

  classroom.dirty = false;
  lastScreen.mode = m.mode;
  lastScreen.page = uiPage;
  lastScreen.v2ActivityId = m.v2ActivityId;
  lastScreen.v2Definition = m.v2Definition;
  lastScreen.v2Synced = m.v2Synced;
  lastScreen.v2Submitted = m.v2Submitted;
  lastScreen.v2Result = m.v2Result;
  lastScreen.input = uiInput;
  lastScreen.feedback = uiFeedback;
  lastScreen.status = m.status;
  lastScreen.answer = m.answer;
  lastScreen.buzzState = m.buzzState;
  lastScreen.photoState = m.photoState;
  lastScreen.synced = m.synced;
  lastScreen.submitted = m.submitted;
  lastScreen.busy = m.busy;
  lastScreen.touchAvailable = touch.available;
  lastScreen.photoGeneration = pendingPhotoGeneration;
  lastScreen.rushRemaining = rushRemaining;
  lastScreen.valid = true;
}

void takePhoto() {
  auto& m = classroom.model;
  if (!m.synced || m.mode != "photo" || m.busy) return;
  if (WiFi.status() != WL_CONNECTED) { classroom.setStatus("WIFI OFFLINE"); return; }
  if (cameraReady) {
    if (!liveFrameReady) return;
    m.busy = true; drawScreen();
    String error;
    bool success = freezeJpeg(touch, pendingJpeg, pendingJpegLength, error);
    cameraReady = false; liveFrameReady = false;
    if (success) { previewDecoded = false; ++pendingPhotoGeneration; m.photoState = "PHOTO PREVIEW"; classroom.setStatus("PHOTO READY TO UPLOAD"); }
    else { m.photoState = "PHOTO ERROR"; classroom.setStatus(error); }
    m.busy = false; drawScreen(); return;
  }
  discardPendingPhoto();
  m.photoState = "LIVE PREVIEW";
  cameraError = ""; liveFrameReady = false;
  cameraReady = startCamera(touch, cameraError);
  if (!cameraReady) { m.photoState = "PHOTO ERROR"; classroom.setStatus(cameraError); }
  else { classroom.setStatus("LIVE CAMERA READY"); lastPreviewFrame = 0; }
  drawScreen();
}

void confirmPhotoUpload() {
  auto& m = classroom.model;
  if (!m.synced || m.mode != "photo" || m.busy || !pendingJpeg || !previewDecoded) return;
  m.busy = true; m.photoState = "PHOTO BUSY"; drawScreen();
  String error;
  if (!pendingPhotoSeq) pendingPhotoSeq = classroom.nextSeq();
  bool success = pendingPhotoSeq != 0;
  if (!success) error = "SEQUENCE STORAGE ERROR";
  else success = uploadPhoto(classroom, pendingJpeg, pendingJpegLength, pendingPhotoSeq, error);
  if (success) {
    discardPendingPhoto();
    m.photoState = "PHOTO OK";
  } else {
    // 上传失败：保留 pendingJpeg 供重试或重拍，不假称成功
    m.photoState = "PHOTO ERROR";
  }
  m.busy = false;
  classroom.setStatus(success ? "PHOTO UPLOADED" : error);
  drawScreen();
}

void cancelPhoto() {
  auto& m = classroom.model;
  if (m.busy) return;
  discardPendingPhoto();
  stopCamera(touch); cameraReady = false; liveFrameReady = false;
  m.photoState = "PHOTO READY";
  classroom.setStatus("PHOTO READY");
  drawScreen();
}

void handleTouch() {
  uint16_t x, y;
  const auto& m = classroom.model;
  bool down=false; if (!touch.readPoint(x,y,down)) return;
  if (uiPage == HOME && m.v2Synced && !m.v2Submitted && m.v2ActivityType.indexOf("arith") >= 0 && down && !buttonHeld && inRect(x,y,HANDWRITING_AREA)) {
    if (handwritingPointCount >= 4096) return;
    if (!handwritingDown) {
      if (handwritingStrokes.isNull()) handwritingStrokes = handwritingDoc["strokes"].to<JsonArray>();
      if (handwritingStrokes.size() >= 32) return;
      handwritingStrokes.add<JsonArray>();
    }
    if (handwritingPointCount >= 4096) return;
    JsonObject p = handwritingStrokes[handwritingStrokes.size()-1].as<JsonArray>().add<JsonObject>();
    p["x"] = x - HANDWRITING_AREA.x; p["y"] = y - HANDWRITING_AREA.y;
    v2ArithmeticValue=""; classroom.model.v2RecognizedText="";
    ++handwritingPointCount;
    if (handwritingDown) lcd.drawLine(handwritingX, handwritingY, x, y, TFT_WHITE);
    else lcd.fillCircle(x, y, 2, TFT_WHITE);
    handwritingX = x; handwritingY = y;
    handwritingDown=true; return;
  }
  if (!down) { buttonHeld=false; if (handwritingDown) { handwritingDown=false; handwritingReady=true; } return; }
  if (buttonHeld) return;
  buttonHeld=true;
  if (m.mode == "idle" && !m.v2Synced && uiPage == HOME) {
    if (inRect(x,y,UI_OPTIONS[0])) { classroom.pollV2(); return; }
    if (inRect(x,y,UI_OPTIONS[1])) { classroom.startV2Practice("vocabulary"); return; }
    if (inRect(x,y,UI_OPTIONS[2])) { classroom.startV2Practice("arithmetic"); return; }
    if (inRect(x,y,UI_OPTIONS[3])) { uiPage=SETTINGS; classroom.dirty=true; return; }
  }
  if (uiPage == SETTINGS) {
    if (inRect(x,y,UI_OPTIONS[0])) { uiPage=WIFI_PICKER; WiFi.scanNetworks(true, true); classroom.discoverServer(); classroom.dirty=true; return; }
    if (inRect(x,y,UI_OPTIONS[1])) { uiPage=COURSE_JOIN; uiInput=""; classroom.dirty=true; return; }
    if (inRect(x,y,UI_CONFIRM)) { uiPage=HOME; classroom.dirty=true; return; }
  } else if (uiPage == COURSE_JOIN && inRect(x,y,UI_CONFIRM)) {
    int split=uiInput.indexOf(' '); if (split>0) { classroom.configureV2(uiInput.substring(0,split),uiInput.substring(split+1)); classroom.bindV2(); uiPage=HOME; } else uiFeedback="课程码和姓名用空格分隔"; classroom.dirty=true; return;
  } else if (uiPage == WIFI_PICKER && inRect(x,y,UI_CONFIRM)) {
    classroom.saveNetwork(selectedSsid,uiInput,classroom.serverUrl()); uiPage=HOME; classroom.dirty=true; return;
  }
  if (uiPage == WIFI_PICKER && y >= 100 && y < 300) {
    uint8_t index = (y - 100) / 50;
    int count = WiFi.scanComplete();
    if (count >= 0 && index < count) { selectedSsid = WiFi.SSID(index); uiInput=""; classroom.dirty=true; }
    return;
  }
  if (uiPage != HOME || m.busy) return;
  if (m.v2Synced) {
    if (inRect(x,y,PRACTICE_HOME)) {
      classroom.model.v2Synced=false; classroom.model.v2Practice=false;
      classroom.model.v2ActivityId=""; classroom.dirty=true; return;
    }
    if (inRect(x,y,PRACTICE_NEXT)) { nextPracticeQuestion(); return; }
    if (inRect(x,y,PRACTICE_CLEAR) && m.v2ActivityType == "arithmetic" && !m.v2Submitted) {
      clearHandwriting(); drawScreen(); return;
    }
    if (m.v2ActivityType.indexOf("vocab") >= 0) {
      for (int i = 0; i < 4; ++i)
        if (inRect(x, y, PRACTICE_OPTIONS[i])) { classroom.selectV2Option(i); return; }
      if (m.v2Submitted && inRect(x, y, UI_V2_NEXT)) {
        nextPracticeQuestion(); return;
      }
    } else if (inRect(x, y, UI_V2_CONFIRM)) {
      if (m.v2Submitted) {
        nextPracticeQuestion();
      } else if (handwritingReady) {
        if (classroom.recognizeHandwriting(HANDWRITING_AREA.w,HANDWRITING_AREA.h,handwritingStrokes)) {
          v2ArithmeticValue=classroom.model.v2RecognizedText; handwritingReady=false;
        }
        drawScreen();
      }
      else if (v2ArithmeticValue.length()) {
        if (m.v2Practice) classroom.submitV2Stroke(HANDWRITING_AREA.w,HANDWRITING_AREA.h,handwritingStrokes,v2ArithmeticValue);
        else classroom.submitV2Answer(v2ArithmeticValue);
      }
    } else if (inRect(x,y,UI_V2_NEXT)) {
      nextPracticeQuestion();
    }
  } else if (m.mode == "quiz") {
    for (int i = 0; i < 4; ++i)
      if (inRect(x, y, UI_OPTIONS[i])) { classroom.selectAnswer('A' + i); return; }
    if (inRect(x, y, UI_CONFIRM)) classroom.submitAnswer();
  } else if (m.mode == "buzzer" && !rushExpired && inRect(x, y, UI_BUZZ)) classroom.buzz();
  else if (m.mode == "photo") {
    if (m.photoState == "PHOTO PREVIEW" || (m.photoState == "PHOTO ERROR" && pendingJpeg)) {
      if (inRect(x, y, UI_PHOTO_CONFIRM)) confirmPhotoUpload();
      else if (inRect(x, y, UI_PHOTO_RETAKE)) takePhoto();
      else if (inRect(x, y, UI_PHOTO_CANCEL)) cancelPhoto();
    } else if (inRect(x, y, UI_PHOTO)) takePhoto();
  }
}

void serialPoll() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      serialLine.trim();
      String normalized = serialLine;
      normalized.toUpperCase();
      if (normalized == "PHOTO" || normalized == "SNAP") takePhoto();
      else if (normalized == "PHOTO_CONFIRM") confirmPhotoUpload();
      else if (normalized == "PHOTO_CANCEL") cancelPhoto();
      else if (normalized == "PHOTO_RETAKE") takePhoto();
      else if (normalized == "CAMERA_STATUS") Serial.printf("camera=%d frames=%lu touch=%d retained=%u pending=%u\n", cameraReady, (unsigned long)previewFrames, touch.available, (unsigned)displayedFrame.len, (unsigned)pendingJpegLength);
      else if (normalized == "CAMERA_SELFTEST") Serial.printf("camera_pixel_selftest=%d yuv_layout=%s vflip=%d\n", cameraPixelSelfTest(), CAMERA_YUV_UYVY ? "UYVY" : "YUYV", CAMERA_VERTICAL_FLIP);
      else if (normalized.startsWith("V2_ANSWER ")) { v2ArithmeticValue = serialLine.substring(11); classroom.command(serialLine); }
      else if (serialLine.length() && !classroom.command(serialLine)) Serial.println("Unsupported command");
      serialLine = "";
    } else if (serialLine.length() < 64) serialLine += c;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LCD_BL, OUTPUT);
  digitalWrite(LCD_BL, LCD_BL_INVERT ? HIGH : LOW);
  lcd.init(); lcd.setRotation(0);
  digitalWrite(LCD_BL, LCD_BL_INVERT ? LOW : HIGH);
  touch.begin();
  classroom.begin();
  drawScreen();
}

void loop() {
  classroom.tick();
  if (handwritingActivityId != classroom.model.v2ActivityId) {
    handwritingActivityId = classroom.model.v2ActivityId;
    clearHandwriting();
  }
  static String previousMode;
  if (classroom.model.mode == "photo" && previousMode != "photo" && !cameraReady && !pendingJpeg) takePhoto();
  previousMode = classroom.model.mode;
  if (classroom.model.mode == "buzzer") {
    uint32_t remaining = classroom.rushSecondsRemaining();
    bool expired = classroom.model.buzzState == "BUZZ" && remaining == 0;
    if (remaining != rushRemaining || expired != rushExpired) { rushRemaining = remaining; rushExpired = expired; classroom.dirty = true; }
  } else { rushRemaining = RUSH_COUNTDOWN_SECONDS; rushExpired = false; }
  // 模式发生切换离开 photo 时，及时释放占用的 PSRAM JPEG 内存并重置状态
  if (classroom.model.mode != "photo" && (pendingJpeg || cameraReady)) {
    discardPendingPhoto();
    stopCamera(touch); cameraReady = false; liveFrameReady = false;
  }
  serialPoll();
  if (millis() - lastTouch >= 20) { lastTouch = millis(); handleTouch(); }
  if (classroom.dirty && screenChanged()) drawScreen();
  if (classroom.model.mode == "photo" && cameraReady && classroom.model.photoState == "LIVE PREVIEW" && millis() - lastPreviewFrame >= 120) {
    lastPreviewFrame = millis();
    if (capturePreview(touch, lcd, cameraError)) liveFrameReady = true;
    else { cameraReady = false; classroom.model.photoState = "PHOTO ERROR"; classroom.setStatus(cameraError); drawScreen(); }
  }
  delay(5);
}
