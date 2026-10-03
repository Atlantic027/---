# max35_cloud_clicker

无屏 ESP32-S3 固件，使用当前 `cloud-server/API.md` 的 device API。网络请求在 Arduino loop 中同步执行，状态由单一任务拥有，避免 String/HTTP/显示并发竞争。

## 安装与配置

1. 安装 ESP32 Arduino Core，选择 ESP32-S3 Dev Module、OPI PSRAM。
2. 安装 ArduinoJson 7.x（本机验证版本：7.4.2）。
3. 首次配置时复制 `classroom_config.h.example` 为 `classroom_config.h`，填写 Wi-Fi、`SERVER_BASE_URL`、`DEVICE_TOKEN`、`DEVICE_ID`。现有真实配置无需覆盖。
4. Arduino IDE 打开本目录中的 `.ino`，选择正确的 ESP32-S3 OPI PSRAM 板卡后编译。此固件不需要 LovyanGFX 或相机库。

## 已实现与限制

- 心跳、完整状态轮询、答题、抢答均使用 `deviceId/name/questionId/roundId/clientSeq`；`clientSeq` 是整数递增值。
- 状态快照会恢复当前题目和轮次，并从 `answers` 恢复本设备已有答案，支持设备重启后不重复提交。
- 抢答按 `winner.deviceId == DEVICE_ID` 显示 `WINNER`，其他赢家显示 `LOST` 并锁定；新 `roundId` 解锁。
- HTTP 请求阻塞 loop，连接和读取超时分别配置为 2.5 秒；DNS、写入、读取和后续轮询可能累计更久，不是整个操作的 2.5 秒总上限。期间串口处理暂停。状态为 `HTTP <code>` 或离线，不能把超时当作成功。
- `clientSeq` 写入 NVS 后再提交，重启会恢复序号；网络结果不确定时会重新轮询服务端状态。
- 无屏固件不实现相机，`PHOTO`/`SNAP` 会被识别为不支持命令，不发送伪造成功结果。

## 串口命令

`HELP` `A` `B` `C` `D` `OK` `BUZZ` `SYNC` `STATUS`

模式仅由服务端控制。`OK` 提交已选 A-D，不发送字符 O。必须先同步状态；已有提交、已产生赢家的抢答都锁定。

共享库位于 `firmware/libraries/ClassroomClient`，从快照根目录运行 CLI 编译必须加 `--libraries .\firmware\libraries`；IDE 用户需安装该库至 sketchbook libraries。具体命令见根 README，本次未重新编译。

串口速度为 115200。未自动烧录板子，也未宣称实机网络或输入验证。
