#pragma once
#include <esp_camera.h>
#include <img_converters.h>
#include <esp_heap_caps.h>
#include "display_hal.h"

// Wire owns I2C0; SCCB borrows it. All sensor/touch calls run on loop.
inline bool cameraSession = false;
inline camera_fb_t displayedFrame = {};
inline uint32_t previewFrames = 0;
static constexpr bool CAMERA_YUV_UYVY = false;
static constexpr bool CAMERA_VERTICAL_FLIP = true;

inline uint16_t cameraYuvTo565(int y, int u, int v) {
  int c = y - 16, d = u - 128, e = v - 128;
  int r = (298 * c + 409 * e + 128) >> 8;
  int g = (298 * c - 100 * d - 208 * e + 128) >> 8;
  int b = (298 * c + 516 * d + 128) >> 8;
  r = constrain(r, 0, 255); g = constrain(g, 0, 255); b = constrain(b, 0, 255);
  return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}

inline uint16_t cameraYuv422Pixel565(const uint8_t* pair, bool oddPixel) {
  int y, u, v;
  if (CAMERA_YUV_UYVY) { u = pair[0]; y = oddPixel ? pair[3] : pair[1]; v = pair[2]; }
  else { y = oddPixel ? pair[2] : pair[0]; u = pair[1]; v = pair[3]; }
  return cameraYuvTo565(y, u, v);
}

inline bool cameraPixelSelfTest() {
  const uint8_t black[] = {16,128,16,128}, white[] = {235,128,235,128};
  const uint8_t red[] = {82,90,82,240}, green[] = {145,54,145,34}, blue[] = {41,240,41,110};
  return cameraYuv422Pixel565(black, false) == 0x0000 && cameraYuv422Pixel565(white, false) == 0xFFFF &&
    cameraYuv422Pixel565(red, false) == 0xF800 && cameraYuv422Pixel565(green, false) == 0x07E0 &&
    cameraYuv422Pixel565(blue, false) == 0x001F;
}
inline void releaseDisplayedFrame() {
  free(displayedFrame.buf);
  displayedFrame = {};
}
inline bool startCamera(Max35Touch& touch, String& error) {
  if (cameraSession) return true;
  if (!psramFound()) { error = "PSRAM REQUIRED"; return false; }
  releaseDisplayedFrame();
  previewFrames = 0;
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_1; c.ledc_timer = LEDC_TIMER_1;
  c.pin_d0 = 12; c.pin_d1 = 4; c.pin_d2 = 11; c.pin_d3 = 17;
  c.pin_d4 = 18; c.pin_d5 = 3; c.pin_d6 = 1; c.pin_d7 = 2;
  c.pin_xclk = 41; c.pin_pclk = 38; c.pin_vsync = 39; c.pin_href = 40;
  c.pin_sccb_sda = -1; c.pin_sccb_scl = -1;
  c.sccb_i2c_port = 0; // esp_camera uses SCCB_Use_Port; never installs a second driver.
  c.pin_pwdn = -1; c.pin_reset = -1;
  c.xclk_freq_hz = 16000000; // Reference implementation value (its 8 MHz comment is stale).
  c.pixel_format = PIXFORMAT_YUV422; c.frame_size = FRAMESIZE_QVGA;
  c.jpeg_quality = 12; c.fb_count = 1;
  c.fb_location = CAMERA_FB_IN_PSRAM; c.grab_mode = CAMERA_GRAB_LATEST;
  esp_err_t result = esp_camera_init(&c);
  cameraSession = result == ESP_OK;
  if (cameraSession && CAMERA_VERTICAL_FLIP) {
    sensor_t* sensor = esp_camera_sensor_get();
    if (!sensor || !sensor->set_vflip || sensor->set_vflip(sensor, 1) != 0) {
      error = "CAMERA VFLIP ERROR"; esp_camera_deinit(); cameraSession = false;
    }
  }
  if (!cameraSession) { error = "CAMERA INIT " + String(static_cast<int>(result)); esp_camera_deinit(); }
  return cameraSession;
}

inline void stopCamera(Max35Touch& touch) {
  if (cameraSession) esp_camera_deinit();
  cameraSession = false;
  releaseDisplayedFrame();
}

inline bool capturePreview(Max35Touch& touch, Max35Display& lcd, String& error) {
  camera_fb_t* frame = esp_camera_fb_get();
  bool ok = false;
  if (!frame) error = "CAMERA FRAME ERROR";
  else if (frame->format == PIXFORMAT_YUV422 && frame->width && frame->height) {
    const uint16_t outW = 296, outH = 222;
    uint16_t* pixels = static_cast<uint16_t*>(heap_caps_malloc(outW * outH * sizeof(uint16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!pixels) error = "PREVIEW MEMORY ERROR";
    else {
      for (uint16_t y = 0; y < outH; ++y) {
        uint32_t sy = (uint32_t)y * frame->height / outH;
        for (uint16_t x = 0; x < outW; ++x) {
          uint32_t sampleX = (uint32_t)x * frame->width / outW;
          uint32_t sx = sampleX & ~1U;
          const uint8_t* p = frame->buf + (sy * frame->width + sx) * 2;
          pixels[y * outW + x] = cameraYuv422Pixel565(p, (sampleX & 1) != 0);
        }
      }
      if (displayedFrame.len != frame->len) {
        releaseDisplayedFrame();
        displayedFrame.buf = static_cast<uint8_t*>(heap_caps_malloc(frame->len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
      }
      if (displayedFrame.buf) {
        uint8_t* saved = displayedFrame.buf;
        displayedFrame = *frame;
        displayedFrame.buf = saved;
        memcpy(saved, frame->buf, frame->len);
        const bool oldSwap = lcd.getSwapBytes();
        lcd.setSwapBytes(true);
        lcd.pushImage(12, 89, outW, outH, pixels);
        lcd.setSwapBytes(oldSwap);
        ++previewFrames;
        ok = true;
      } else error = "FREEZE BUFFER ERROR";
      heap_caps_free(pixels);
    }
  } else error = frame->format == PIXFORMAT_JPEG ? "JPEG LIVE PREVIEW UNSUPPORTED" : "CAMERA FORMAT ERROR";
  if (frame) esp_camera_fb_return(frame);
  if (!ok) { stopCamera(touch); }
  return ok;
}

inline bool freezeJpeg(Max35Touch& touch, uint8_t*& jpeg, size_t& length, String& error) {
  jpeg = nullptr; length = 0;
  camera_fb_t* frame = displayedFrame.buf ? &displayedFrame : nullptr;
  bool ok = false;
  if (!frame) error = "CAMERA FRAME ERROR";
  else if (frame->format == PIXFORMAT_YUV422)
    ok = frame2jpg(frame, 80, &jpeg, &length) && jpeg && length > 0;
  else error = "CAMERA FORMAT ERROR";
  stopCamera(touch);
  if (!ok) { if (!error.length()) error = "JPEG ENCODE ERROR"; free(jpeg); jpeg = nullptr; length = 0; }
  return ok;
}

inline void releaseJpeg(uint8_t*& jpeg, size_t& length) {
  free(jpeg);
  jpeg = nullptr;
  length = 0;
}

inline bool uploadPhoto(ClassroomClient& client, const uint8_t* jpeg, size_t length, uint64_t seq, String& error) {
  const String boundary = "----max35-" + String(static_cast<unsigned long>(millis()));
  const String head = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"deviceId\"\r\n\r\n" + client.deviceId() +
    "\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"clientSeq\"\r\n\r\n" + String(seq) +
    "\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"capture.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n";
  const String tail = "\r\n--" + boundary + "--\r\n";
  const size_t total = head.length() + length + tail.length();
  uint8_t* payload = static_cast<uint8_t*>(heap_caps_malloc(total, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!payload) { error = "PHOTO MEMORY ERROR"; return false; }
  memcpy(payload, head.c_str(), head.length());
  memcpy(payload + head.length(), jpeg, length);
  memcpy(payload + head.length() + length, tail.c_str(), tail.length());
  HTTPClient http;
  bool ok = false;
  if (!http.begin(client.endpoint("/api/device/photo"))) error = "PHOTO HTTP BEGIN ERROR";
  else {
    ClassroomClient::configureHttp(http, 5000);
    http.addHeader("Content-Type", "multipart/form-data; boundary=" + boundary);
    int code = http.sendRequest("POST", payload, total);
    String response = code > 0 ? http.getString() : "";
    JsonDocument document;
    ok = code >= 200 && code < 300 && !deserializeJson(document, response) && document["ok"] == true;
    if (!ok) error = "PHOTO HTTP " + String(code);
    http.end();
  }
  free(payload);
  return ok;
}
