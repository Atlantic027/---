#pragma once
#include <Wire.h>
#include <LovyanGFX.hpp>

#ifndef LCD_BL_INVERT
#define LCD_BL_INVERT true
#endif
#ifndef LCD_INVERT_COLOR
#define LCD_INVERT_COLOR true
#endif
static constexpr int LCD_BL = 42, TOUCH_SDA = 15, TOUCH_SCL = 14;

// 调色板定义 (深色课堂控制台高对比配色)
static constexpr uint16_t COLOR_BG       = 0x0842; // #0b1120 暗蓝灰底色
static constexpr uint16_t COLOR_PANEL    = 0x1106; // #131d31 面板深蓝
static constexpr uint16_t COLOR_BORDER   = 0x29E9; // #2c3c58 边框色
static constexpr uint16_t COLOR_PRIMARY  = 0x235B; // #2563eb 品牌蓝
static constexpr uint16_t COLOR_ACCENT   = 0x043A; // #0284c7 高亮蓝
static constexpr uint16_t COLOR_SUCCESS  = 0x15CA; // #10b981 成功绿
static constexpr uint16_t COLOR_WARNING  = 0xFCE0; // #f59e0b 警告橙
static constexpr uint16_t COLOR_DANGER   = 0xEC88; // #ef4444 危险红

class Max35Display : public lgfx::LGFX_Device {
  lgfx::Panel_ST7796 panel;
  lgfx::Bus_SPI bus;
 public:
  Max35Display() {
    auto b = bus.config();
    b.spi_host = SPI2_HOST; b.spi_mode = 0;
    b.freq_write = 40000000; b.freq_read = 16000000;
    b.spi_3wire = true; b.use_lock = true; b.dma_channel = SPI_DMA_CH_AUTO;
    b.pin_sclk = 46; b.pin_mosi = 48; b.pin_miso = -1; b.pin_dc = 47;
    bus.config(b); panel.setBus(&bus);
    auto p = panel.config();
    p.pin_cs = 5; p.pin_rst = -1;
    p.panel_width = p.memory_width = 320;
    p.panel_height = p.memory_height = 480;
    p.readable = false; p.invert = LCD_INVERT_COLOR;
    p.rgb_order = false; p.bus_shared = false;
    panel.config(p); setPanel(&panel);
  }
};

class Max35Touch {
 public:
  bool available = false;
  void begin() {
    address = 0;
    available = Wire.begin(TOUCH_SDA, TOUCH_SCL, 400000);
    Wire.setTimeOut(50);
    if (!available) return;
    for (uint8_t candidate : {uint8_t(0x5D), uint8_t(0x14)}) {
      Wire.beginTransmission(candidate);
      if (Wire.endTransmission() == 0) { address = candidate; break; }
    }
    available = address != 0;
    // Do not reset wasDown: a held finger across camera ownership must not retrigger.
  }
  void suspend() { available = false; Wire.end(); }
  bool press(uint16_t& x, uint16_t& y) {
    if (!available) return false;
    uint8_t status;
    if (!read(0x814E, &status, 1) || !(status & 0x80)) return false;
    uint8_t count = status & 15;
    if (!count) { if (clear()) wasDown = false; return false; }
    uint8_t point[4];
    if (!read(0x8150, point, sizeof(point))) return false;
    if (!clear()) return false;
    x = point[0] | (point[1] << 8); y = point[2] | (point[3] << 8);
    bool edge = !wasDown;
    wasDown = true; // Invalid coordinates are still a contact, never a release.
    return edge && count <= 5 && x < 320 && y < 480;
  }
  bool readPoint(uint16_t& x, uint16_t& y, bool& down) {
    if (!available) return false; uint8_t status;
    if (!read(0x814E, &status, 1)) return false;
    uint8_t count = status & 15; down = (status & 0x80) && count;
    if (down) { uint8_t point[4]; if (!read(0x8150, point, sizeof(point))) return false; x=point[0]|(point[1]<<8); y=point[2]|(point[3]<<8); }
    clear(); return true;
  }
 private:
  uint8_t address = 0;
  bool wasDown = false;
  bool read(uint16_t reg, uint8_t* data, size_t size) {
    Wire.beginTransmission(address); Wire.write(reg >> 8); Wire.write(reg & 255);
    if (Wire.endTransmission(false) || Wire.requestFrom(address, size) != size) return false;
    for (size_t i = 0; i < size; ++i) data[i] = Wire.read();
    return true;
  }
  bool clear() {
    Wire.beginTransmission(address); Wire.write(0x81); Wire.write(0x4E); Wire.write(0);
    return Wire.endTransmission() == 0;
  }
};

// 严格保持 UI 触摸矩形坐标：UI_OPTIONS 4个大方块，UI_CONFIRM / UI_BUZZ / UI_PHOTO 操作条
struct UiRect { int16_t x, y, w, h; };
static constexpr UiRect UI_OPTIONS[] = {
  {12, 88, 140, 100},
  {168, 88, 140, 100},
  {12, 204, 140, 100},
  {168, 204, 140, 100}
};
static constexpr UiRect UI_CONFIRM = {12, 330, 296, 64};
static constexpr UiRect UI_V2_CONFIRM = {12, 330, 296, 64};
static constexpr UiRect UI_V2_NEXT = {12, 400, 296, 48};
static constexpr UiRect UI_BUZZ    = {12, 260, 296, 120};
static constexpr UiRect UI_PHOTO   = {12, 330, 296, 64};

// 照片预览操作按钮矩形 (Y: 330~394, 高度 64, 与 UI_PHOTO/UI_CONFIRM 处于同一清晰舒适的操作带，完全避开上方图片)
static constexpr UiRect UI_PHOTO_CONFIRM = {12,  330, 136, 64};
static constexpr UiRect UI_PHOTO_RETAKE  = {156, 330, 72,  64};
static constexpr UiRect UI_PHOTO_CANCEL  = {236, 330, 72,  64};

inline bool inRect(int x, int y, const UiRect& r) {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

// 绘制选项方块按钮
inline void drawOptionButton(Max35Display& lcd, const UiRect& r, const char* label, uint16_t bgColor, uint16_t borderColor, bool chinese = false) {
  lcd.fillRoundRect(r.x, r.y, r.w, r.h, 10, bgColor);
  lcd.drawRoundRect(r.x, r.y, r.w, r.h, 10, borderColor);
  lcd.setTextColor(TFT_WHITE, bgColor);
  lcd.setTextDatum(middle_center);
  if (chinese) { lcd.setFont(&fonts::efontCN_16); lcd.setTextSize(1); }
  else { lcd.setFont(&fonts::Font0); lcd.setTextSize(5); }
  lcd.drawString(label, r.x + r.w / 2, r.y + r.h / 2);
  lcd.setTextSize(1);
}

// 绘制动作按钮 (支持中文字体)
inline void drawButton(Max35Display& lcd, const UiRect& r, const char* text, uint16_t bgColor, uint16_t textColor = TFT_WHITE, bool isChinese = false) {
  lcd.fillRoundRect(r.x, r.y, r.w, r.h, 10, bgColor);
  lcd.drawRoundRect(r.x, r.y, r.w, r.h, 10, COLOR_BORDER);
  lcd.setTextColor(textColor, bgColor);
  lcd.setTextDatum(middle_center);
  if (isChinese) {
    lcd.setFont(&fonts::efontCN_16);
    lcd.setTextSize(1);
  } else {
    lcd.setFont(&fonts::Font0);
    lcd.setTextSize(2);
  }
  lcd.drawString(text, r.x + r.w / 2, r.y + r.h / 2);
}
