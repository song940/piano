# Audio Lab 🧪

一个完全运行在浏览器里的声音实验室：生成声音、通过实时效果链处理、录音、回放并导出 WAV。

## 现在能做什么

- 合成器：正弦波、三角波、方波、锯齿波，以及钢琴、Pad、Bass、Pluck 预置
- 演奏：屏幕钢琴键盘和电脑键盘映射
- 鼓机：8 种实时合成鼓声和 16 步循环音序器
- 外部输入：麦克风接入处理管线，可选择监听
- 效果链：低通滤波、共振、过载失真、反馈延迟、卷积混响、动态压缩
- 录音：录制效果链最终输出，在浏览器内回放
- 导出：本地编码为 PCM WAV，不上传音频
- 可视化：实时示波器和输出电平

## 信号流

```text
Synth ─┐
Drums ─┼─> Input -> Filter -> Drive ┬-> Dry ─────────┐
Mic ───┘                           ├-> Delay/Feedback ┼-> Master -> Compressor -> Analyser -> Monitor
                                  └-> Convolution ───┘                              └-> Recorder -> WAV
```

项目没有构建步骤和运行时依赖，直接通过静态服务器打开即可：

```bash
python3 -m http.server 4173
```

然后访问 <http://localhost:4173>。由于浏览器安全策略，音频上下文会在第一次交互后启动；麦克风需要 HTTPS 或 localhost。

## ffmpeg-demo 怎么处理

`ffmpeg-demo` 的 ffmpeg.wasm 很适合做**非实时格式转换层**，例如导入 MP3/FLAC、导出 MP3/AAC/Opus、剪切和标准化；它不适合放进逐采样的实时效果链，因为加载体积和处理延迟都更高。

当前版本先用 Web Audio API 完成低延迟生成与处理，并原生导出 WAV。下一阶段可以把 ffmpeg.wasm 做成按需加载的导入/导出模块，只有选择压缩格式时才下载核心文件。

## 下一阶段

- 多轨时间线与波形剪辑
- AudioWorklet 录制器和自定义 DSP 节点
- 采样器：拖入音频、切片、映射到 Pad
- 参数自动化、工程保存和撤销历史
- 按需加载 ffmpeg.wasm，支持 MP3 / AAC / Opus / FLAC
- MIDI 输入与离线渲染

## 来源与历史

Audio Lab 由原来的 [`piano`](https://github.com/lsongdev/piano) 项目演进而来，并合并了 [`drumpad`](https://github.com/lsongdev/drumpad) 的鼓机概念。旧地址会由 GitHub 自动重定向；旧项目在新版本发布后保留为只读归档。
