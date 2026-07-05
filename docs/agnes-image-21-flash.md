# Agnes Image 2.1 Flash 接口文档

> 升级版图像生成模型，优化高信息密度图像生成，支持文生图与图生图工作流。

## 基础信息

| 属性 | 值 |
|------|-----|
| 模型名称 | `agnes-image-2.1-flash` |
| API 类型 | 同步 |
| 端点 | `POST https://apihub.agnes-ai.com/v1/images/generations` |
| 标准价格 | $0.003/张 |
| 当前价格 | $0/张（限时免费） |

## 核心能力

- **文生图**：根据文本提示词生成高质量图像
- **图生图**：基于输入图像进行转换、重绘和风格化编辑
- **高信息密度优化**：适合复杂场景、丰富构图和多层视觉元素
- **构图保留**：编辑时可保留原始构图和主体布局
- **灵活输出**：支持 URL 或 Base64 两种返回格式

## 认证方式

```bash
-H "Authorization: Bearer YOUR_API_KEY"
-H "Content-Type: application/json"
```

## 请求参数

### 必填参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `model` | string | 固定值 `agnes-image-2.1-flash` |
| `prompt` | string | 图像生成或编辑的文本指令 |
| `size` | string | 输出尺寸，如 `1024x768`、`768x1024`、`1024x1024` |

### 可选参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `return_base64` | boolean | 文生图时设为 `true` 可获取 Base64 编码 |

### 图生图参数（嵌套在 `extra_body` 内）

| 参数路径 | 类型 | 必填条件 | 说明 |
|---------|------|---------|------|
| `extra_body.image` | string[] | 图生图必填 | 输入图像数组 |
| `extra_body.response_format` | string | 可选 | 输出格式：`url` 或 `b64_json` |

**注意**：`response_format` 必须放在 `extra_body` 内，不能放在顶层。图生图不需要传递 `tags` 字段。

## 响应格式

```json
{
  "created": 1780000000,
  "data": [
    {
      "url": "https://storage.googleapis.com/agnes-aigc/xxx.png",
      "b64_json": null,
      "revised_prompt": null
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `created` | 时间戳 |
| `data[0].url` | 图像下载地址（URL 模式） |
| `data[0].b64_json` | Base64 编码数据（Base64 模式） |
| `data[0].revised_prompt` | 模型调整后的提示词 |

## 调用示例

### 文生图 + URL 输出

```bash
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.1-flash",
    "prompt": "日出时分薄雾峡谷上方的浮空城市，电影级写实",
    "size": "1024x768",
    "extra_body": {
      "response_format": "url"
    }
  }'
```

### 文生图 + Base64 输出

```bash
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.1-flash",
    "prompt": "白色背景上的玻璃立方体产品照，柔和阴影",
    "size": "1024x768",
    "return_base64": true
  }'
```

### 图生图 + URL 输出

```bash
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.1-flash",
    "prompt": "将场景转为赛博朋克夜景，保留原始构图",
    "size": "1024x768",
    "extra_body": {
      "image": ["https://example.com/input.png"],
      "response_format": "url"
    }
  }'
```

### 图生图 + Base64 输出

```bash
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.1-flash",
    "prompt": "将物体改为哑光黑色，保留原始构图",
    "size": "1024x768",
    "extra_body": {
      "image": ["data:image/png;base64,iVBORw0KGgo..."],
      "response_format": "b64_json"
    }
  }'
```

## 输入图像格式

支持两种格式：

1. **公开 URL**：`https://example.com/photo.jpg`（需公开可访问）
2. **Data URI**：`data:image/png;base64,BASE64_HERE`

## 提示词规范

### 文生图模板

```
[主体] + [环境场景] + [艺术风格] + [光线效果] + [镜头构图] + [画质要求]
```

示例：
> 日出时分薄雾峡谷上方的发光浮空城市，电影级写实风格，广角构图，丰富的建筑细节，柔和的金色光线，高视觉密度

### 图生图模板

```
[修改指令] + [新风格/场景] + [增删元素] + [保留元素]
```

示例：
> 将白天街道场景改为电影级赛博朋克夜景，添加霓虹招牌和湿滑路面倒影，同时保留原始街道布局、相机角度和主要建筑形状

### 高密度图像建议

清晰描述视觉层次结构：
- 主要主体
- 背景环境
- 重要次要细节
- 风格、光照、构图约束

## 常见错误

| 问题 | 解决方案 |
|------|---------|
| `response_format` 无效 | 确保放在 `extra_body` 内 |
| 图生图不生效 | 检查 `extra_body.image` 是否正确传入 |
| 输入图无法访问 | 使用公开 URL 或 Base64 编码 |
| 请求超时 | 增加超时至 60-360 秒 |

## 适用场景

- 创意设计：概念图、海报、视觉探索
- 营销物料：活动图片、产品图、社媒素材
- 高密度场景：复杂构图、多元素组合
- 风格转换：滤镜效果、场景变换、打光调整

## 接入检查清单

- [ ] 使用 `agnes-image-2.1-flash` 作为模型名称
- [ ] 使用正确的 API 端点
- [ ] 文生图包含 `model`、`prompt`、`size`
- [ ] 图生图在 `extra_body.image` 中提供输入图像
- [ ] `response_format` 放在 `extra_body` 内
