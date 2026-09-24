# 🎨 Image Generator · IPE

SillyTavern 扩展插件 — 从 RP 正文提取场景描述，调用独立 API 生成英文生图提示词，可注入回正文。

> v2.0.0 从零重写，代码干净、结构清晰，专注生图功能。

## 功能

- **正文提取**：从 RP 正文提取场景描述，调用独立 API 生成英文生图提示词
- **正文注入**：生成结果默认包成 `<draw>…</draw>` 追加在楼尾，模板可自定义
- **分层提取**：一次请求拆成镜头 / 环境 / 氛围 / 人物 / 动作五层，每层可锁、可单独重摇
- **环境沿用**：环境层与氛围层在不变时自动沿用上一楼（副 AI 回 `NO_CHANGE`）
- **换画风重注入**：提取结果不动，换个基础模板一键把楼尾那块 `<draw>` 重拼替换，不再调副 AI
- **楼层 🎨 按钮**：每条记过提取结果的 AI 楼操作栏里有 🎨，翻到哪楼点哪楼
- **多 API 预设**：一键切换不同 API 端点
- **预设管理**：基础模板 / 角色锚点 / 提取规则 / System Prompt 预设，支持导入导出
- **失败弹窗与一次性自动重试**
- **请求打断**：支持手动中止正在进行的请求
- **补充指令**：临时附加指令，常用短语可存取
- **主题系统**：7 套配色（月潮 / 海雾 / 杏岸 / 碧岸 / 粉蓝海滩 / 珠光海螺 / 柠檬海滩）

## 安装

### 方式一：手动安装

1. 下载本仓库所有文件
2. 将整个文件夹放入 SillyTavern 的 `data/default-user/extensions/` 目录下
3. 重启 SillyTavern 或在扩展管理页面刷新

### 方式二：通过 Git 安装

在 SillyTavern 扩展管理页面的 "Install via Git URI" 输入框中填入本仓库地址。

## 使用

1. 在 SillyTavern 设置面板中找到 **🎨 Image Generator · IPE** 扩展设置
2. 填写 API 端点、API Key、模型名
3. 配置 System Prompt、基础模板、角色锚点、提取规则
4. 开启总开关
5. RP 对话中每条 AI 回复后，点浮标 🎨 或预览区的「提取」按钮即可提取场景并生成生图提示词
6. 提取完成后可编辑预览框内容，点「注入」追加到正文楼尾

## 配置说明

| 配置项 | 说明 |
|--------|------|
| API Endpoint | 独立 API 的端点地址（如 `https://api.openai.com/v1`） |
| API Key | API 密钥 |
| Model | 使用的模型名称 |
| System Prompt | 系统提示词（预设可切换） |
| Base Template | 基础模板（支持占位符 `{Description}`, `{Camera}`, `{Env}`, `{Mood}`, `{Chars}`, `{Pose}`） |
| Character Anchors | 角色锚点资料库 |
| Extraction Rules | 提取规则 |
| Auto Inject | 自动注入到正文 |
| Auto Inject Delay | 自动注入延迟（毫秒） |
| Layered Extraction | 分层提取开关 |
| Request Timeout | 请求超时（毫秒，0 = 不限） |

## 分层提取

开启分层提取后，一次 API 请求会拆成五层：

| 层 | 标签 | 说明 |
|----|------|------|
| 镜头 | `<camera>` | 景别、机位、视角、构图、景深 |
| 环境 | `<env>` | 物理空间：地点、时间段、天气、道具 |
| 氛围 | `<mood>` | 光线、色温、明暗、空气感、基调 |
| 人物 | `<chars>` | 出场角色外貌、服装、表情、状态 |
| 动作 | `<pose>` | 动作与空间关系 |

- 环境层和氛围层在场景不变时可沿用上一楼（副 AI 回 `NO_CHANGE`）
- 每层可锁定（锁定后不重提）或单独重摇
- 模板可用 `{Camera}` `{Env}` 等占位符单独放置各层

## 文件结构

```
ipe-image-generator/
├── manifest.json    # 插件清单
├── index.js         # 核心逻辑（~1600 行，从零重写）
├── style.css        # 样式（7 套主题）
├── README.md        # 说明文档
└── .gitignore       # Git 忽略规则
```

## 兼容性

- SillyTavern 1.18+
- 使用 `SillyTavern.getContext()` + `fetch API`

## 致谢

基于原「小海螺 · IPE」(ipe-image-prompt-extractor) 功能逻辑从零重写。

作者：ripple & GPT & Claude
