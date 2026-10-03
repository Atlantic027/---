# Cloud Classroom Server

服务同时提供旧版单课堂和 v2 多课程接口。旧版使用 WebSocket 推送状态快照；v2 网页轮询课程接口，记录保存在 data/v2-state.json。上传图片存放于 uploads/；旧版 reset 保留图片。教师 v2 入口为 `/teacher-v2.html`，学生入口为 `/student-v2.html`，根路径 `/` 为旧版。

## 运行

```sh
npm ci
cd handwriting
npm ci
cd ..
npm start
```

默认监听 `0.0.0.0:8080`。可配置 `PORT`、`DATA_DIR`、`UPLOAD_DIR`、`DEVICE_TOKEN`、`TEACHER_TOKEN`。未配置教师令牌时允许本地免认证，启动会提示部署前必须设置 `TEACHER_TOKEN`。设备请求携带 `X-Device-Token`。教师可使用 `X-Teacher-Token` 或 `/api/teacher/login` 获取 HttpOnly、SameSite=Strict session cookie。认证和字段详情见 [API.md](API.md)。

在 Windows PowerShell 中从本目录启动，确保使用本项目源码和 `data/`、`uploads/`：

```powershell
Set-Location .\cloud-server
npm.cmd start
```

若需停止 launcher 启动的服务，使用对应 stop-classroom 脚本。

## 测试

```sh
npm test
```

集成测试使用临时目录及随机端口，不读取或修改默认 `data/`、`uploads/`。

集成测试覆盖旧版答题、抢答、图片上传和 WebSocket，以及 v2 课程隔离、权限、重连、作答与图片访问。启动及当前限制见 [根 README](../README.md)。
