# Agnes Video V2.0 接口文档

> 面向文生视频、图生视频、多图视频和关键帧动画的异步视频生成 API。

## 基础信息

| 属性 | 值 |
|------|-----|
| 模型名称 | `agnes-video-v2.0` |
| API 类型 | 异步 |
| 创建任务端点 | `POST https://apihub.agnes-ai.com/v1/videos` |
| 查询结果端点（推荐） | `GET https://apihub.agnes-ai.com/agnesapi?video_id=<VIDEO_ID>` |
| 查询结果端点（旧版） | `GET https://apihub.agnes-ai.com/v1/videos/<TASK_ID>` |
| 标准价格 | $0.005/秒 |
| 当前价格 | $0/秒（限时免费） |

## 核心能力

- **文生视频**：通过文本提示词直接生成视频
- **图生视频**：将静态图片转化为动态视频
- **多图视频**：使用多张参考图片引导视频生成
- **关键帧动画**：在多个关键帧之间生成流畅过渡
- **场景运动控制**：控制主体动作、镜头运动和场景动态
- **视觉一致性**：帧间保持主体、风格和场景一致

## 认证方式

```bash
-H "Authorization: Bearer YOUR_API_KEY"
-H "Content-Type: application/json"
```

## 创建任务参数

### 必填参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `model` | string | 固定值 `agnes-video-v2.0` |
| `prompt` | string | 视频内容的文本描述 |

### 视频参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `width` | integer | 1152 | 视频宽度 |
| `height` | integer | 768 | 视频高度 |
| `num_frames` | integer | - | 帧数，必须 ≤441 且遵循 `8n+1` 规则 |
| `frame_rate` | number | - | 帧率，范围 1-60 |

### 图像输入

| 参数 | 类型 | 使用场景 |
|------|------|---------|
| `image` | string | 单图模式（图生视频） |
| `extra_body.image` | string[] | 多图模式或关键帧动画 |

### 质量控制

| 参数 | 类型 | 说明 |
|------|------|------|
| `seed` | integer | 随机种子，相同值可复现结果 |
| `negative_prompt` | string | 反向提示词，排除不想要的内容 |
| `num_inference_steps` | integer | 推理步数 |

### 模式设置

| 参数 | 可选值 | 说明 |
|------|--------|------|
| `mode` | `ti2vid` | 图生视频模式 |
| `extra_body.mode` | `keyframes` | 关键帧动画模式 |

## 创建任务响应

```json
{
  "id": "task_YOUR_TASK_ID",
  "task_id": "task_YOUR_TASK_ID",
  "video_id": "video_YOUR_VIDEO_ID",
  "object": "video",
  "model": "agnes-video-v2.0",
  "status": "queued",
  "progress": 0,
  "created_at": 1780457477,
  "seconds": "10.0",
  "size": "1280x768"
}
```

| 字段 | 说明 |
|------|------|
| `id` / `task_id` | 任务标识符 |
| `video_id` | 视频标识符（推荐用于查询） |
| `status` | 任务状态 |
| `progress` | 完成百分比 |
| `seconds` | 视频时长 |
| `size` | 实际输出分辨率 |

## 查询结果

### 推荐方式

```bash
GET https://apihub.agnes-ai.com/agnesapi?video_id=<VIDEO_ID>
Authorization: Bearer YOUR_API_KEY
```

### 旧版兼容方式

```bash
GET https://apihub.agnes-ai.com/v1/videos/<TASK_ID>
Authorization: Bearer YOUR_API_KEY
```

### 查询响应

```json
{
  "id": "task_YOUR_TASK_ID",
  "video_id": "video_YOUR_VIDEO_ID",
  "model": "agnes-video-v2.0",
  "object": "video",
  "status": "completed",
  "progress": 100,
  "seconds": "10.0",
  "size": "1280x768",
  "remixed_from_video_id": "https://storage.googleapis.com/agnes-aigc/videos/xxx.mp4",
  "error": null
}
```

| 字段 | 说明 |
|------|------|
| `remixed_from_video_id` | 视频下载地址（仅完成状态） |
| `error` | 错误信息（仅失败状态） |

## 任务状态

| 状态 | 说明 |
|------|------|
| `queued` | 排队等待处理 |
| `in_progress` | 正在生成中 |
| `completed` | 生成成功 |
| `failed` | 生成失败 |

状态流转：
```
queued → in_progress → completed
                   ↓
                 failed
```

## 时长控制

### 计算公式

```
秒数 = num_frames / frame_rate
```

### 帧数约束

- 必须满足：`num_frames = 8n + 1`（n 为正整数）
- 最大值：441

### 时长参考

| 目标时长 | 帧数 | 帧率 |
|---------|------|------|
| 约 3 秒 | 81 | 24 |
| 约 5 秒 | 121 | 24 |
| 约 10 秒 | 241 | 24 |
| 约 18 秒 | 441 | 24 |

## 分辨率标准

系统会自动映射到最接近的标准分辨率：

| 宽高比 | 适用场景 |
|--------|---------|
| 16:9 | 横版视频、产品演示、YouTube 风格 |
| 9:16 | 竖版短视频、TikTok/Reels/Shorts |
| 1:1 | 方形视频、社媒信息流 |
| 4:3 | 传统横版格式 |
| 3:4 | 竖版演示、肖像为主 |

## 调用示例

### 文生视频

```bash
curl -X POST https://apihub.agnes-ai.com/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-video-v2.0",
    "prompt": "一只猫在海滩上行走的电影镜头，日落时分，柔和的海浪，温暖的金色光线",
    "height": 768,
    "width": 1152,
    "num_frames": 121,
    "frame_rate": 24
  }'
```

### 图生视频

```bash
curl -X POST https://apihub.agnes-ai.com/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-video-v2.0",
    "prompt": "女人慢慢转身看向镜头，自然面部表情，电影级镜头运动",
    "image": "https://example.com/image.png",
    "num_frames": 121,
    "frame_rate": 24
  }'
```

### 多图视频

```bash
curl -X POST https://apihub.agnes-ai.com/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-video-v2.0",
    "prompt": "在两张参考图之间创建平滑过渡场景，保持视觉一致性",
    "extra_body": {
      "image": [
        "https://example.com/image1.png",
        "https://example.com/image2.png"
      ]
    },
    "num_frames": 121,
    "frame_rate": 24
  }'
```

### 关键帧动画

```bash
curl -X POST https://apihub.agnes-ai.com/v1/videos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-video-v2.0",
    "prompt": "在关键帧之间生成平滑过渡，保持视觉一致性和自然镜头运动",
    "extra_body": {
      "image": [
        "https://example.com/keyframe1.png",
        "https://example.com/keyframe2.png"
      ],
      "mode": "keyframes"
    },
    "num_frames": 121,
    "frame_rate": 24
  }'
```

## 提示词规范

### 文生视频模板

```
[主体] + [动作] + [场景] + [镜头运动] + [光线] + [风格]
```

示例：
> 一个年轻宇航员在红色沙漠星球上行走，风吹起尘埃，缓慢的电影跟拍镜头，戏剧性的日落光线，写实科幻风格

### 图生视频模板

描述运动内容和保持稳定的元素：
> 让角色有轻微的呼吸动作，头发在微风中轻轻飘动，背景灯光柔和闪烁，同时保持面部和服装一致

### 多图视频模板

描述图片关系和过渡方式：
> 以第一张图作为起始场景，第二张图作为目标场景，创建平滑过渡，保持光照一致，自然运动，电影级节奏

### 关键帧动画模板

清晰描述过渡关系：
> 从第一个关键帧平滑过渡到第二个关键帧，保持角色身份一致，镜头角度稳定，场景间自然运动

## 推荐参数配置

| 场景 | 推荐设置 |
|------|---------|
| 标准生成 | width:1152, height:768, frames:121, rate:24 |
| 社交短视频 | frames:81/121, rate:24 |
| 较长视频 | 增大 frames 或降低 rate |
| 更流畅运动 | rate:24 或 30 |
| 可复现结果 | 设置固定 seed |
| 关键帧过渡 | extra_body.mode:"keyframes" |
| 排除特定内容 | 使用 negative_prompt |

## 错误码

| 状态码 | 说明 |
|--------|------|
| 400 | 请求无效，检查参数 |
| 401 | 未授权，检查 API Key |
| 404 | 任务或视频未找到 |
| 500 | 服务器错误 |
| 503 | 服务繁忙，稍后重试 |

## 适用场景

- 故事讲述：短片、角色场景、叙事片段
- 营销视频：产品广告、宣传视频、推广内容
- 社交媒体：Reels、Shorts、TikTok 风格
- 图片动画：为静态图添加动态效果
- 产品演示：通过文本或图片生成展示视频
- 关键帧过渡：在不同视觉状态间生成流畅转换

## 接入检查清单

- [ ] 使用 `agnes-video-v2.0` 作为模型名称
- [ ] 理解异步流程：创建任务 → 轮询结果
- [ ] 新接入使用 `video_id` 查询结果
- [ ] `num_frames` ≤441 且符合 `8n+1` 规则
- [ ] 单图用 `image`，多图/关键帧用 `extra_body.image`
