# Offline handwriting recognition

独立模块，不读取题目、答案或服务器状态；推理只使用传入的笔迹，并且 CPU、本地 ONNX 模型、无网络调用。

## 接口

```js
const { recognize } = require('./cloud-server/handwriting');
const result = await recognize({ width, height, strokes: [[{ x, y }, ...], ...] });
// { recognizedText, confidence, digits, needsConfirmation: true }
```

`recognize` 会异步初始化并缓存 `onnxruntime-node` session。限制：最多 32 笔、4096 点，宽高均为 1..1024；空、越界、NaN、非整数尺寸都会拒绝。

预处理为笔迹栅格化、横向投影近邻分组（重叠/相邻笔画合并）、每字符 MNIST 28x28 归一化。首位宽横笔画按负号处理；目标是 0-9 多位整数及负号。置信度是模型 softmax 的真实最大概率，始终要求确认。

## 模型与离线打包

`models/mnist-12.onnx` 是 ONNX Model Zoo `onnx/models` 的 MNIST-12 模型，模型页声明输入 `[1,1,28,28]` float32、10 类 logits，并标注 MIT。当前资产：26,143 bytes，SHA-256 `5c688690f8bacf667d4c2074af5ad0646ca328d7ab03eccf944a65b320171bdd`，与官方 LFS OID 相同。下载来源使用 GitHub raw `?download=1` 端点；`npm run fetch-assets` 会轮询官方 raw/media 端点、校验 LFS 指针 SHA-256，并生成 `models/SHA256SUMS`、`manifest.json` 和许可证文件。仓库根 LICENSE 文件本身为 Apache-2.0；模型页的 MIT 声明单独适用于该模型资产。

UCI PenDigits 独立测试集资产位于 `tests/fixtures/pendigits.tes`，来源为 UCI DOI `10.24432/C5MG6K`，CC BY 4.0；测试运行前 300 条、覆盖 0..9 全部类别，并输出真实模型准确率。

依赖固定为 `onnxruntime-node@1.30.0`（MIT；npm lockfile 记录完整 integrity）。这是 native Node addon：Windows Electron 打包时必须按目标 Electron/Node ABI 重新安装或 rebuild，并将对应平台 `onnxruntime` native 二进制纳入 asar-unpack/资源；不要在运行时联网下载。

## 验证

在本目录运行 `npm test`。测试包含独立构造的手写轨迹样本、真实模型调用、多位/负号布局，以及空白/非法/过大输入路径。`npm run evaluate` 会完整评估 3,498 条 UCI 独立手写测试轨迹，将所有预测、逐类统计和失败行保存到 `tests/evaluation.json`。本次 Windows x64 / Node v24.18.0 / onnxruntime-node 1.30.0 实测：单数字 `2381/3498 = 68.07%`；0..9 各类分别为 `0:357/363, 1:124/364, 2:354/364, 3:328/336, 4:229/364, 5:317/335, 6:290/336, 7:103/364, 8:230/336, 9:49/336`。组合正数两位测试 `49/100`，负号两位测试 `49/100`。这些是本模块当前预处理和模型的实测结果，不是模型仓库宣称值；低置信或失败结果仍要求用户确认。模型缺失或哈希不匹配时模块会报明确错误，不会随机替代或伪造结果。
