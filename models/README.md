# MAX35 Terminal OpenSCAD Model

`max35_terminal.scad` is a configurable visual and enclosure-reference model for the Spotpear ESP32S3-MAX35 terminal.

## Reference Basis

- Board features and product identity come from the Spotpear MAX35 documentation: 3.5-inch display, camera connector/module, USB-C, SD slot, BOOT/PWR controls, speaker interface, touch connector, ES8311 audio codec and 16 MB flash.
- The current `163 x 104 x 0.8 mm` board dimensions are concept placeholders, NOT verified manufacturer dimensions. The complete STEP assembly has not been measured. Do not use individual STEP coordinates as overall dimensions.
- The display, camera, connector, speaker and button placements are reference approximations. Measure the physical device before printing a case or machining a part.

## Open in OpenSCAD

Open `max35_terminal.scad` in OpenSCAD. Set `render_part` near the top:

- `0`: board plus visible terminal features.
- `1`: PCB reference only.
- `2`: display module only.
- `3` / `4`: starting points for front/back printable enclosure shells.

All dimensions use millimetres. Adjust the exposed parameters before export.

## Official CAD

For detailed mechanical work, use the manufacturer-provided STEP model as the authority. The OpenSCAD model intentionally stays editable and lightweight; it does not replace the official detailed CAD.

Reference page: https://spotpear.cn/wiki/ESP32-S3-3.5-inch-LCD-Display-TouchScreen-GC0308-Deepseek.html

Official STEP: https://cdn.static.spotpear.cn/uploads/picture/learn/ESP32/ESP32S3-MAX35-Only-Board/ESP32S3-3.5inch-AI.step

当前版本是可编辑的外观概念模型。壳体为结构草案，尚未完成端口位置、装配间隙、螺柱及紧固件设计，不能直接作为实机外壳打印定稿。
