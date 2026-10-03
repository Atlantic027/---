# max35_cloud_clicker_display

ESP32-S3 OPI PSRAM 固件，使用 ST7796S 320x480、GT911 和 GC0308 DVP 相机，并遵循 `cloud-server/API.md`。

中文 UI 与拍照预览确认已实现：
- 待机闲置、A-D 选择与提交确认、抢答准备/赢家/输家锁定与新轮解锁。
- 拍摄 JPEG 后进入 320x480 界面局部预览（QVGA 296x222 等比居中），屏幕提供【确认上传】、【重拍】与【取消】三项明确操作。
- 确认后才向云端发起 multipart 上传；取消直接释放 PSRAM 缓存；上传失败保留原图允许直接重试上传或重新拍摄，杜绝假成功。
- photo 模式进入时持续运行 GC0308 YUV422 相机；按约 8fps 最近帧刷新 296x222 RGB565 局部预览，点击【拍摄 / 冻结】才编码 JPEG 并进入原确认流程。JPEG 相机输出不用于实时预览，会明确报错，不伪称画面有效。
- 抢答每个新 round 本地单调倒计时，默认 10 秒，可在配置中设置 `RUSH_COUNTDOWN_SECONDS`；超时后锁定本机按钮，服务端赢家/输家结果优先。

## 硬件与中文校验

显示：`CS=5`、`MOSI=48`、`SCLK=46`、`DC=47`、`RST=-1`、`BL=42`；触摸 I2C：`SDA=15`、`SCL=14`，地址 `0x5D/0x14`。相机 DVP：D0..D7=`12,4,11,17,18,3,1,2`，XCLK=41、PCLK=38、VSYNC=39、HREF=40，SCCB 与触摸共用 GPIO15/14。不要修改已确认引脚。

参考板卡资料要求背光 `invert=true`、面板颜色 `invert=true`；本固件提供 `LCD_BL_INVERT` 和 `LCD_INVERT_COLOR` 宏参数，默认均为 true。硬件校验步骤：断电核对丝印/原理图引脚；上电确认背光有效；串口确认 GT911 地址；触摸按住时确认 ready=0 不会误释放；最后在无相机和有相机硬件上分别观察真实错误/照片结果。

## 已实现

- ArduinoJson 7 正规解析/序列化；心跳、状态快照、答题、抢答使用 `deviceId/name/questionId/roundId/clientSeq`，clientSeq 为递增整数。
- 网络和拍照由单一 Arduino loop 执行，避免状态、显示和共享 SCCB 总线并发。HTTP 连接超时配置 2500ms，普通请求读取超时 2500ms，照片读取超时 5000ms；这些不是整个操作的总时间上限。DNS、连接、写入、读取、相机取帧及后续状态轮询可能累计更久，期间触摸/串口处理暂停，短按可能丢失。
- 拍后留存原图并显示解码预览，提供重拍/放弃/确认上传的完整闭环；支持失败直接重传，避免重复拍摄。
- GT911 ready=0 保持前次按下状态，只有 ready 且 count=0 才释放；按钮使用严格半开矩形边界和按下沿。
- 模式切换时自动注销并释放未提交的拍照 PSRAM 缓存。
- V2 适配默认关闭（`V2_MODE_ENABLED=false`），不改变旧 `/api/device/*`、旧 heartbeat 或旧课堂状态同步。
- V2 `V2_BIND` POST `/api/v2/courses/join` 发送 `{courseCode,studentName,deviceId}`，不发送 Authorization；响应中的 `studentToken`、`deviceSecret` 和 `course.id` 持久化到 NVS。后续 current 与答题请求使用 `Authorization: Bearer studentToken`。
- `V2_SYNC` GET `/api/v2/courses/:id/current`，兼容顶层或 `activity/question` 嵌套的脱敏题目。词汇题提交 `answer: {index}`，算数题提交 `answer: {type:"number",value}`，每次使用唯一 `clientEventId`；stroke 识别仍未实现，不伪造结果。
- 相机持续占用共享 SCCB/I2C 时先停用 GT911；相机停止后重新初始化触摸。相机错误路径归还帧、释放临时 JPEG 并恢复触摸。

## 安装与编译参数

必须使用 16MB Flash 分区配置，或 4MB Flash 的 huge_app 配置进行编译：
```powershell
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,CDCOnBoot=cdc" --build-path "D:\ai-max35-cloud-classroom\firmware\verify-build-photo-preview-ui-20261003" --libraries "D:\ai-max35-cloud-classroom\firmware\libraries" "D:\ai-max35-cloud-classroom\firmware\max35_cloud_clicker_display"
```
从快照根目录执行的相对路径编译命令见 [根 README](../../README.md)。历史操作记录和编译产物未随源码发布，本次未重新编译或实机验证。
