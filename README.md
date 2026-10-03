# ESP32S3-MAX35 云课堂源码快照

这是用于 GitHub 上传的源码副本，包含网页课堂、手写数字识别模块、两套固件和 Windows 桌面候选程序源码。不是固件 bin，也不包含已构建的桌面 EXE。

## 当前功能与边界

- 网页教师入口 `/teacher-v2.html`，学生入口 `/student-v2.html`；支持课程码、多课程、词汇/算数活动、提交与统计。根路径 `/` 是旧版单课堂教师页。
- 旧版设备流程包含答题、抢答和照片上传。带屏固件源码包含中文界面、实时相机预览、冻结确认、取消/重拍及失败重传；无屏固件不支持相机。

**ESP32 选择题、抢答和拍照的教师入口是 `http://127.0.0.1:8080/`。** 电脑和终端连接同一路由器，终端配置电脑的局域网 IP 和与服务端一致的 `DEVICE_TOKEN`。`teacher-v2.html` 用于课程码、词汇和算数；目前其页面没有常规课堂选择题/抢答/照片控制面板，不能替代根路径的硬件课堂控制台。
- 共享固件客户端已有 v2 加入课程、轮询、答题和手写相关请求代码，默认 `V2_MODE_ENABLED=false`。不能据此声称全部 v2 硬件交互已验证。
- 教师端包含仅教师可见的学生图片批注，以及基于作答量、正确率和批注数量的本地规则学习建议；该建议透明显示依据和样本量，不是心理/医学诊断，也不调用外部 AI 服务。
- 带屏终端启用 `V2_MODE_ENABLED=true` 并加入课程后，可自主进入背单词或手写速算，不需要教师发布题目。词汇题由本机服务查询公开英英词典（不可达时继续使用本地词库），四个中文释义由服务端出题；作答仍计入该课程的教师统计。
- 手写模块使用本地 MNIST ONNX 模型识别数字，支持多位数字与负号的预处理；识别需要用户确认，不保证课堂笔迹准确率。
- 桌面源码提供 Electron 教师窗口、后端打包、Windows WLAN helper 和局域网发现。Wi-Fi 连接、跨设备发现、防火墙可达性及独立无 Node 的干净系统运行仍需实际验收。
- 同步固件 HTTP/相机操作可能阻塞触摸和串口；网络各阶段超时会累计。公网 HTTPS/WSS、固件 TLS 和完整硬件端到端验收不属于本快照已验证成果。

## 安装与网页启动

在此 README 所在目录打开 PowerShell，安装 Node.js（桌面构建要求至少 22.12），执行：

```powershell
npm.cmd ci --prefix .\cloud-server
npm.cmd ci --prefix .\cloud-server\handwriting
npm.cmd start --prefix .\cloud-server
```

两个 Node 子项目各有独立 lockfile，第二步不能省略为只安装服务端。首次安装依赖需要网络；模型已包含在源码中。教师打开 `http://127.0.0.1:8080/teacher-v2.html`，学生打开 `http://<教师电脑局域网IP>:8080/student-v2.html`。教师创建课程后将课程码告知学生。浏览器会话按来源保存，恢复课程应使用原来的浏览器地址。

也可直接双击根目录 `Start-MAX35-Teacher.cmd`（或 `launcher/start-classroom.cmd`）。脚本启动本地服务并打开新版教师控制台，教师无需使用 PowerShell 或查询 IP；新版页面可查看批注和本地学习分析，并可跳转旧版 ESP32 硬件控制台。学生设备连接同一局域网时仍需教师电脑的 LAN 地址。学生启动脚本支持 `-ServerUrl http://192.168.1.100:8080`（示例地址，需替换）。配置向导保存本地配置记录，不会自动烧录固件。服务端 API 见 [cloud-server/API.md](cloud-server/API.md)。

## 固件配置与编译

从快照根目录执行，仅在配置不存在时复制模板：

```powershell
if (!(Test-Path .\firmware\max35_cloud_clicker\classroom_config.h)) {
  Copy-Item .\firmware\max35_cloud_clicker\classroom_config.h.example .\firmware\max35_cloud_clicker\classroom_config.h
}
if (!(Test-Path .\firmware\max35_cloud_clicker_display\classroom_config.h)) {
  Copy-Item .\firmware\max35_cloud_clicker_display\classroom_config.h.example .\firmware\max35_cloud_clicker_display\classroom_config.h
}
```

编辑各自的本地配置，填写 Wi-Fi、电脑实际局域网服务地址及匹配令牌；ESP32 的服务地址不能使用电脑的 localhost。真实配置不要上传。设备 ID 留空时由芯片 MAC 派生。

带屏终端的自主练习还需将 `V2_MODE_ENABLED` 设为 `true`。首次使用通过 115200 波特率串口发送 `V2_CONFIG 课程码 学生名`，再发送 `V2_BIND`；屏幕课程页尚未提供文字输入键盘。凭据保存后在首页点击“背单词”或“手写速算”。教师在 v2 成员统计中可查看总作答及“自主”作答数。当前实现需要本机服务运行，常规课堂活动仍优先于自主练习。

参考源项目工具版本：ESP32 core 3.0.0、ArduinoJson 7.4.2、LovyanGFX 1.2.31。配置 Espressif 开发板索引后安装依赖。确认实物为 16MB Flash、OPI PSRAM 后，从根目录编译：

```powershell
arduino-cli core install esp32:esp32@3.0.0
arduino-cli lib install "ArduinoJson@7.4.2" "LovyanGFX@1.2.31"
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,CDCOnBoot=cdc" --libraries .\firmware\libraries --build-path .\firmware\build-display .\firmware\max35_cloud_clicker_display
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,CDCOnBoot=cdc" --libraries .\firmware\libraries --build-path .\firmware\build-clicker .\firmware\max35_cloud_clicker
```

本地 `ClassroomClient` 库不可省略。其他 Flash 容量需选适用的分区，不能盲用上述参数。2026-10-03 已用上述参考工具链和示例配置编译两套固件；未烧录或操作实体设备。

## 桌面与模型构建

参阅 [desktop/BUILD.md](desktop/BUILD.md)。保留了准备脚本所需的服务源码、网页、手写模块、模型、许可证和 C# 网络 helper 源码；backend、resources、network/bin 都由构建生成。

模型 `cloud-server/handwriting/models/mnist-12.onnx` 为 26,143 字节，保留 SHA-256 清单、上游说明和第三方许可证；测试 fixture 保留 UCI 来源及 CC BY 4.0 说明。已按 lockfile 安装服务端和手写依赖并运行本地模型测试。`fetch-assets` 的日志变量作用域错误已修复，下载失败后保留的 fixture 也会核验哈希；本次未重新下载资产，该脚本仍不会重建许可证文件。

## 上传 GitHub

创建空仓库后，上传本目录内的文件和子目录，让本 README 位于仓库根目录。Windows 资源管理器开启“隐藏的项目”，确认根 `.gitignore` 及子目录 `.gitignore` 一并上传；网页拖拽后检查它们确实出现在文件列表。不要上传此目录外的源项目，也不要把本地运行后产生的文件补传。

`.gitignore` 仅帮助 Git 客户端过滤文件，网页手动上传也需要自行遵守排除规则。当前快照排除了真实配置、环境凭据、运行数据/照片、日志、依赖目录、编译缓存和桌面生成资源。代码内 `local-mvp` 开头的令牌及测试/模板示例是公开开发默认值，不是真实私有凭据；使用时应自行配置。

2026-10-03 修复验证：服务端及手写模块测试 9 项通过，桌面测试 7 项通过，两套固件编译通过。集成测试在临时数据目录启动服务，覆盖 HTTP 与 WebSocket；尚未进行真实浏览器视觉验收、跨设备 Wi-Fi/相机/触摸验收或重新打包 EXE。导出清单和 EXPORT-AUDIT.json 是原始快照记录，不代表修改后的验证结果。

保留第三方资产原有许可证。本项目根目录未新增开源许可证；项目代码的授权方式需由权利人决定。
