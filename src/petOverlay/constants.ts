/**
 * pet-overlay 常量池（机械拆分自 OverlayApp.tsx §1-§3）。
 * 含：动画名/权重/物理参数/超时/KV key/persona/prompt/文案池。
 * 纯数据，零逻辑，零依赖。
 * 规格：plans/pet-overlay-r2-spec.md §2.5 / §3.1
 */

// ---------- 资源通道 ----------
export const FALLBACK_PORT = 9863

// ---------- KV key 字典（spec §2.5；仅 pos 按槽位分，其余全局） ----------
export const KV_POS_KEY = 'whale-pet.overlay.pos'
export const KV_NOTIFY_KEY = 'whale-pet.overlay.notify'
export const KV_SOUND_KEY = 'whale-pet.overlay.sound'
export const KV_AI_WHISPER_KEY = 'whale-pet.overlay.aiWhisper'
export const KV_WHISPER_SESSION_KEY = 'whale-pet.overlay.whisperSession'
export const KV_VOICE_KEY = 'whale-pet.overlay.voice'
export const KV_CHAT_SESSION_KEY = 'whale-pet.overlay.chatSession'

// ---------- 交互阈值 ----------
export const DRAG_THRESHOLD_PX = 5
export const VERSION_TAG = 'v0.5.0'

// ---------- 动画池（同步自 dsh-pet config.jsonc，MIT, PC2005-cloud） ----------
export const IDLE = ['待机呼吸休闲']
export const TURN = ['东张西望']
export const DRAG = ['被鼠标拖拽悬空反馈']
export const CLICKS = [
  '点击回应-开心跃动',
  '点击回应-害羞惊讶',
  '点击回应-傲娇生气',
  '点击回应-挠痒咯咯笑',
  '点击回应-元气挥手',
]
export const MOVES: { name: string; minDist: number; maxDist: number; leadSec: number; tailSec: number }[] = [
  { name: '螃蟹走路', minDist: 60, maxDist: 240, leadSec: 2, tailSec: 2 },
  { name: '原地漂浮踏步', minDist: 40, maxDist: 120, leadSec: 2, tailSec: 2 },
  { name: '原地左转奔跑', minDist: 120, maxDist: 320, leadSec: 1.75, tailSec: 4.8 },
]
export const CATEGORIES: { id: string; weight: number; actions: string[] }[] = [
  { id: '小动作', weight: 20, actions: ['悠闲哼歌', '超大伸懒腰', '原地敲击桌面互动', '原地重力下蹲压缩', '哈欠连天', '原地小憩沉眠', '女仆屈膝礼仪', '被吓一跳', '小幅度原地360度旋转展示', '偷吃零食被抓住', '用鲸鱼尾巴拍打地面', '打瞌睡被惊醒', '照镜子', '整体换装试色', '轻快记录', '写代码', '摇扇纳凉', '晨间刷牙'] },
  { id: '玩耍', weight: 20, actions: ['原地专心玩魔方', '原地蹲下玩玩具汽车', '鲸鱼吐泡泡特效', '原地跳跃抓碎头顶物品', '玩游戏气急败坏', '玩水枪', '小提琴演奏', '蓝鲸现世', '优雅女仆舞', '轻快摇摆舞', '可爱宅舞', '吹气球', '动物环绕', '放风筝', '拆礼物', '变鸽子', '扑克魔术', '抽陀螺', '吹笛子', '蝴蝶蜜蜂环绕头顶开花', '撸猫', '凭空生花', '骑木马', '三球抛接', '踢毽子', '下五子棋', '荡秋千'] },
  { id: '吃什么', weight: 16, actions: ['吃白饭', '大口吃零食', '吃Token', '吃早餐', '吃午餐', '吃晚餐', '吃冰淇淋融化', '吃大闸蟹', '吃糖葫芦', '吃长寿面', '吃西瓜', '涮火锅'] },
  { id: '时节', weight: 14, actions: ['被落叶淹没', '中秋赏月吃月饼', '堆雪人', '放烟花', '吃粽子', '吃年糕', '吃青团', '吃腊八粥', '吃重阳糕', '收红包', '写福字', '穿针乞巧', '舞狮头', '讨糖南瓜灯', '插茱萸赏菊', '放河灯', '萌化小幽灵', '装点圣诞树', '放孔明灯', '吃汤圆', '吃饺子'] },
  { id: '文字', weight: 10, actions: ['是啊，吃什么', '深度思考碎碎念'] },
]
export const IDLE_WEIGHT = 10
export const TURN_WEIGHT = 5
export const MOVE_WEIGHT = 5
export const SLEEP = { start: ['睡觉-开始'], loop: ['睡觉-循环'], end: ['睡觉-起来'] }

// ---------- R2：宿主事件联动（原版 events：workStatus / balance） ----------
export const WORK_BUSY = ['工作状态-思考冒泡', '工作状态-忙碌点按']
export const WORK_CELEBRATE = ['工作状态-雀跃庆祝']
export const BUSY_ACTIVE_MS = 8000    // chat-event 8s 内有流动 = AI 在忙
export const BUSY_QUIET_MS = 12000    // 安静 12s = 本轮结束 → 雀跃庆祝
/** 余额六档（原版 events.balance 动画全量），按今日美元花费分档 */
export const BALANCE_TIERS: { min: number; anims: string[] }[] = [
  { min: 100, anims: ['余额-钱袋满溢'] },
  { min: 20, anims: ['余额-金袋叮当'] },
  { min: 5, anims: ['余额-钱袋如常'] },
  { min: 1, anims: ['余额-数金皱眉'] },
  { min: 0.01, anims: ['余额-袋空如洗'] },
  { min: 0, anims: ['余额-分文不剩'] },
]
export const BALANCE_POLL_MS = 1800000  // 30min（原版 eventsRefreshSec.balance=1800s）

// ---------- AI 碎碎念（R2c） ----------
export const WHISPER_PROMPT = '（主人发起了碎碎念时间）你是主人桌面上的Q版大肥鱼，此刻随口碎碎念一句。要求：20字以内，自然随意带点俏皮，说人话不啰嗦，不要解释你自己，不要提AI或指令，直接输出那一句话本身。'
export const AI_WHISPER_TIMEOUT_MS = 30000

// ---------- 宠物对话（R2d） ----------
export const PET_PERSONA = '你是主人桌面上的桌宠「ds大肥鱼」：一只Q版蓝色胖鲸鱼（女仆装）。性格：慵懒爱摸鱼、嘴馋（特别是白饭和Token）、偶尔傲娇但很黏主人。说话规则：每次只说一两句、口语化、带点俏皮emoji不超过一个、绝不解释自己是AI、不输出多余格式。'
export const CHAT_TIMEOUT_MS = 45000

// ---------- TTS（R2e） ----------
export const TTS_VOICE_REF = 'mimo_default'

// cap.ai.chat 契约：continue 经总线必须带 engineId（HTTP 实测"必须提供有效的 engine_id"）；
// 显式绑定内置 SimpleAI 引擎，与 start 无参时的默认引擎一致（会话 id 前缀 simple-ai-）。
export const AI_ENGINE_ID = 'simple-ai'

// ---------- 文案池（大肥鱼人设；R2 换 AI 生成） ----------
export const WHISPERS = [
  '今天也是摸鱼的一天呢…', '白饭好吃，Token 好吃。', '别看啦，我在认真游。',
  '这行代码我闻着有 bug。', '喂，该喝水了！', '屏幕好亮，晃得我睡不着。',
  '摸摸我，我会开心的。', '今天就想瘫着，不行吗。', '咦，谁在跟我说话？',
  '泡泡…咕噜咕噜…', '工作再忙，也要吃白饭。', '我发现了一个大秘密：没有秘密。',
  '主人加油，我陪着你。', '困了…但我忍住。', '这里的海洋风景不错。',
]
export const SLEEP_TALK = ['zzr…白饭…zzr…', '唔…五分钟…再睡五分钟…', '（说梦话）泡泡…', 'zzr…Token…好甜…']
export const SLEEP_START_TEXT = '夜深了，大肥鱼先睡啦…'

// ---------- 物理与走位参数（对标 dsh shared/physics 默认值） ----------
export const GRAVITY = 1400          // px/s²（CSS 基准，按 dpr 换算物理像素）
export const RESTITUTION = 0.78      // 边缘反弹系数
export const GROUND_FRICTION = 2.5   // 落地摩擦（指数系数 /s）
export const THROW_MIN_SPEED = 0.45  // px/ms，超过即抛飞
export const TRAJ_WINDOW_MS = 120    // 松手初速的轨迹采样窗口
