# 配置系统重构 — 用户痛点搜索日志(20轮)

使用内置浏览器真实搜索,记录社区痛点与解决方案。

---

## R01 Zustand persist 跨 Tab/窗口不同步
- 来源: https://github.com/pmndrs/zustand/discussions/1614
- 痛点: persist 写 localStorage 正确,但多 Tab 取回的值不同步(Tab A 改了,Tab B 仍是旧值)。社区用户称"试了所有 zustand 中间件包同步 Tab/窗口,都各种失败"。
- 陷阱: `storage` 事件 + `rehydrate()` 方案会**无限循环**(rehydrate 触发 storage 事件 → 再 rehydrate)。mhsattarian 的生产代码用 `if (e.key === 'cart')` 守卫避免循环。
- 作者 dai-shi 推荐: BroadcastChannel。
- 对本项目启示:
  - Polaris 的 configStore 不 persist(正确,后端为真相源),但 13+ 个 persist store 有此问题。
  - 用 Tauri `config-changed` 事件(后端 emit)而非前端 storage 事件,从根源避免循环。
  - 收敛双写后,受影响的 persist store 变少,问题面缩小。

## R02 VSCode 插件配置 schema 设计(contributes.configuration)
- 来源: https://code.visualstudio.com/api/references/contribution-points + deepwiki Configuration API
- 痛点: VSCode 扩展用 `contributes.configuration` 数组声明配置 schema(title + properties),properties 用 JSON Schema(type/enum/default/description/markdownDescription)。宿主自动渲染 Settings UI,插件用 `workspace.getConfiguration()` 读取。这是成熟的"声明式配置"范式。
- 关键设计:
  - schema 是**纯数据**(JSON Schema),无函数,可跨 IPC 传递
  - 多个 configuration entry 可按 title 分组("分类")
  - `scope` 字段(machine/window/resource)控制配置作用域
  - `order` 字段控制 UI 展示顺序
- 对本项目启示:
  - 插件 configSchema 应参照此设计:纯数据(key/label/type/default/options/help/sensitive/scope)
  - 后端可序列化存储,前端按 schema 自动渲染表单
  - 权限校验只看 manifest.permissions.appConfigRead/Write,与 schema 解耦

## R03 Tauri 多窗口配置同步痛点
- 来源: gethopp.app / 777genius.github.io/state-sync / rustz2h.com / tauri-apps discussions#9423
- 痛点: "设置窗口改主题为 dark → 关闭窗口 → 主窗口仍是 light,用户困惑"。state-sync 作者称第三次手写事件同步出 bug 才造轮子。
- 社区方案:
  - gethopp: "loosely synced state" + Tauri event emit/listen
  - rustz2h: `app.emit_all()` 让多窗口保持同步
  - tauri-plugin-store: 配置持久化 + per-key change 事件广播,但非实时同步引擎
  - state-sync: 自建同步引擎,支持 Redux/Zustand/Jotai/MobX/Pinia 等
- 对本项目启示:
  - Polaris 已有 `config-changed` 事件(lib.rs:261 emit),但只带 `{ performance }`,且 Web 模式 settings.rs 不 emit。
  - 方向正确(事件驱动同步),但需:(1) Tauri 模式补全字段或按需扩 (2) Web 模式补 emit
  - 不引入 tauri-plugin-store 或 state-sync 第三方库,复用现有事件机制即可,避免增加依赖

## R04 前端配置重启丢失的常见原因
- 来源: https://stackoverflow.com/questions/72222728 / https://stackoverflow.com/questions/79798872 / https://codeberg.org/librewolf/issues/issues/1658 / LinkedIn 讨论
- 痛点(社区真实反馈):
  - **竞态覆盖(SO 72222728, 26 赞, 33k 浏览)**:useEffect 在首渲染用空 state(`[]`)写 localStorage,覆盖了已有数据;React 18 StrictMode 双挂载放大此问题。"processed asynchronously" 是关键词——刷新后异步 state 更新未处理,空值先落盘。
  - **浏览器策略擦除(SO 79798872 / Codeberg 1658)**:无痕模式、隐私扩展、LibreWolf `sanitize_on_close`、配额超限都会让 localStorage 重启后返回 null。用户称"偶尔"丢失,排查极痛苦。
  - **StrictMode 双挂载**:useEffect 初始化 localStorage 的写法在 StrictMode 下失效,社区被迫用 useRef 跳过首渲染或 useState 惰性初始化。
  - **state vs persist 顺序**:useState 异步、useEffect 同步写,刷新时 effect 先跑用旧(空)值写入,再跑 state 更新——典型竞态。
- 方案(社区/官方推荐):
  - 用 `useState(() => JSON.parse(localStorage.getItem(key)) || default)` 惰性初始化,直接从 localStorage 读初值,绕过 effect 竞态(Drew Reese 26 赞答案)。
  - 不要把空数组当守卫(`if (todoList.length > 0)`)——空数组是合法态,会破坏"清空"语义。
  - 承认 localStorage 是易失的(隐私模式/策略/配额都可能擦),**后端才是稳定真相源**(LinkedIn: "localStorage source of truth, backend is backup"——瞬时反馈靠 localStorage,持久靠后端)。
  - useRef 标记首渲染跳过首次 effect 写入,是 StrictMode 兼容方案。
- 对本项目启示:
  - Polaris hydrateFromLocalStorage 的"raw 值相等缓存"防重写正是同类竞态防护,但仍是 localStorage 层;**后端 config.json 才是抗隐私模式/StrictMode/配额的真相源**。
  - configStore 不 persist(正确方向),但 13+ 个 persist store 都受浏览器策略影响;Web 模式无后端兜底时,重启丢失是真实风险。
  - zustand persist 的 merge/rehydrate 是同步的,理论上无 React effect 竞态,但 hydrateFromLocalStorage 与 React 18 StrictMode 双挂载的交互仍需测试覆盖。
  - 启示强化:配置类数据必须后端为真相源 + 前端只做缓存与回退,不要让 localStorage 持有"唯一副本"。

## R05 zustand persist merge 丢失 store 函数(actions)
- 来源: https://github.com/pmndrs/zustand/issues/457 (官方 issue, Collaborator 参与) / https://dev.to/atsyot/solving-zustand-persisted-store-re-hydtration-merging-state-issue-1abk / https://stackoverflow.com/questions/76801357 / https://stackoverflow.com/questions/74031008
- 痛点(社区真实反馈):
  - **嵌套 actions 对象 rehydration 后变 undefined(GitHub #457)**:用户把 actions 包在 `actions: { set, toggle }` 嵌套对象里,持久化 `active` 状态;toggle 后刷新,toggle 变 undefined 报错。根因:persist 默认 merge 是浅 spread `{...currentState, ...persistedState}`,persistedState 里的 `actions` 键(序列化后是空对象 `{}`)覆盖了 currentState 的 `actions`(含函数)。
  - **JSON.stringify 丢弃函数(dev.to)**: Zustand 允许把 side-effect 函数(login)直接挂到 state,但 JSON 序列化只保留原始类型,函数被丢;rehydration 时 persistedState 不含函数,浅合并后函数位被 undefined 或空对象覆盖。作者称"花了一小时排查",质疑"为什么 Zustand 不自动处理"。
  - **问题持续存在**:2022 年用户在 #457 追问"Is this fixed? do I need write my own deep merge?",2024 年仍有用户用 lodash merge 方案(7 赞)——说明默认 merge 始终是浅的,deep merge 需用户自行实现。
  - **Duck.ai 自动答案**:"persist middleware's default shallow merge can overwrite store methods (like login) with persisted data, causing them to disappear."
- 方案(社区/官方推荐):
  - **官方临时方案(blacklist)**:Collaborator AnatoleLucet 建议 `blacklist: ['actions']` 不持久化 actions 属性(现可用 `partialize` 替代)。
  - **官方长期方案(自定义 merge)**:PR #466 引入 `merge` 选项,用户可传 deep merge 函数;官方建议用 immer 或自定义递归合并。
  - **社区方案(lodash merge, 7 赞)**:`merge: (persistedState, currentState) => merge({}, currentState, persistedState)`——lodash 的 merge 是 deep merge,且 currentState 在前保证函数不被 persistedState(空对象)覆盖。
  - **结构分离最佳实践**:flat state(不嵌套 actions 对象)可规避此问题,但牺牲组织性。
- 对本项目启示:
  - Polaris 的 13+ persist store 大多采用 flat state + 顶层 action 函数的模式(zustand 惯用),若 persist 的 persistedState 是空对象 `{}`(首次)或部分 key,浅合并理论上不覆盖函数;但**一旦有同名嵌套 key 就会覆盖**——需逐个 store 审查。
  - Polaris 已有 hydrateFromLocalStorage 的"raw 值相等缓存"防重写,但那是在 React 层;zustand persist 的 merge 是独立的、在 zustand 层,两者需分别防护。
  - 建议:Polaris 的 persist store 统一加 `partialize` 只持久化数据字段(排除函数),从根源规避;而非依赖每个 store 写 merge 函数(DX 差,易漏)。
  - 配置类 store(configStore)不 persist 是正确的;但若将来有 persist 的配置子 store,务必 partialize 只存值不存 action。

## R06 VSCode 插件运行时读配置的权限模型
- 来源: https://github.com/microsoft/vscode-extension-samples/blob/main/configuration-sample/README.md (官方示例) / https://stackoverflow.com/questions/65192859 / https://stackoverflow.com/questions/76337129 / vshaxe WorkspaceConfiguration 类型定义 / DeepWiki Configuration API
- 痛点/核心机制(社区与官方):
  - VSCode 的"配置权限"是**隐式 scope 模型**,不是显式 permission 字段。schema 里每项配置声明 `scope`: `window`(窗口级)/ `resource`(资源级,可按文件)/ `language-overridable`(按语言覆盖)。宿主据此决定该配置可写哪些层(User/Workspace/Folder)。
  - **window scope 在 Folder settings 写入会被拒**:官方 README 明确"NOTE: This setting cannot be applied under Folder settings, doing so will show a warning and value is not respected."——即 scope 不匹配时宿主拒绝写入并警告。
  - **合并视图 vs inspect 拆层**:getConfiguration() 返回合并后的值(Default ← Global ← Workspace ← Folder ← Language);社区(SO 65192859)发现要拿到"未合并的各层"须用 `inspect()`,它返回 `{ defaultValue, globalValue, workspaceValue, workspaceFolderValue }` 等字段——权限查询靠 inspect,运行时读靠 get。
  - **update 需选 target**:写配置时必须指定 `ConfigurationTarget`(Global/Workspace/WorkspaceFolder),宿主按 scope 校验是否允许写该层。
  - **section 分组**:getConfiguration(section) 按 section 前缀分组(SO 76337129),设置 UI 自动按 title 分组展示。
- 方案(官方推荐):
  - 插件在 package.json 的 `contributes.configuration.properties` 里为每项声明 `scope` 字段,宿主自动校验读写层级。
  - 运行时用 `workspace.getConfiguration(section).get<T>(key)` 读合并值;用 `.update(key, value, target)` 写,target 由 scope 决定可选范围。
  - 用 `inspect(key)` 查询各层未合并值,用于权限判断或 UI 显示"来自哪层"。
  - 用 `workspace.onDidChangeConfiguration` 监听变更,实时响应(scope 决定哪些变更会触发)。
- 对本项目启示:
  - Polaris 插件 configSchema 的 `scope` 字段(R02 提到)应参照 VSCode 的隐式权限模型:scope 值约束该配置可在哪层存储(全局/工作区/会话),后端 set_config 时按 scope 校验,不匹配则拒绝并返回警告(类似 VSCode 的 "value is not respected")。
  - Polaris 当前只有 `sensitive` 布尔(R02 设计),可考虑细化为 `scope: 'global' | 'workspace'`(对应 machine/window),不必照搬 VSCode 的 resource/language-overridable(Polaris 无文件资源概念,过度设计)。
  - 前端配置表单可参考 VSCode 的"按 section 分组 + 按 scope 控制可写层"——给配置项打 scope 标签,UI 据此禁用不适用层级的写入。
  - `inspect()` 的"查各层来源"思路可用于 Polaris 的配置溯源(值来自默认/用户/会话哪层),但当前规模不需要,记为未来增强。

## R07 Tauri 插件配置存储方案对比(plugin-store vs 自定义 JSON)
- 来源: https://jsonic.io/guides/json-in-tauri (2026-05) / https://techxcelerate.ntxm.org/docs/tauri/plugins/store-plugin/ / https://v2.tauri.app/develop/configuration-files/ / https://v2.tauri.app/develop/plugins/
- 痛点/对比(社区与官方):
  - **tauri-plugin-store 是什么**:轻量 key-value 存储,JSON 文件落盘到平台 AppData 目录;"file-based localStorage,works from both React frontend and Rust backend"。适合用户偏好、窗口状态、主题、中小型配置。
  - **autoSave 陷阱**:默认 autoSave=true(100ms debounce 自动存);若设为 false 且忘记 save,应用非正常关闭时数据丢失(虽 Tauri 退出时 flush,但"relying on that is fragile")。社区明确警告"Always make your save strategy explicit"。
  - **LazyStore**:大文件或非每次会话都用时,延迟到首次读写才加载磁盘。
  - **Rust↔JS 共享实例**:同 filename 的 store 在前后端复用同一实例(Rust `app.store()` 创建后注册到资源表,JS 同名复用);`store.close_resource()` 释放内存。
  - **serde_json::Value 强制**:跨语言 store.set() 必须 `serde_json::Value` 类型,否则 JS interop 失败。
  - **何时不用 store plugin**:大型结构化数据用 SQL Plugin;编译期配置用 tauri.conf.json(构建期读取);运行时用户配置二者皆可,store plugin 更省样板。
  - **自定义命令读写 JSON**:用 `#[tauri::command]` + serde_json 读写自定义 JSON 文件;jsonic.io 推荐"所有命令包装放 src/lib/tauri-api.ts,Rust 命令放 src-tauri/src/commands.rs,1-to-1 结构使 schema drift 立即可见"。
- 方案(官方推荐):
  - 小到中型配置 + 需前后端共享 → tauri-plugin-store(autoSave 默认开,或显式 save)。
  - 大型/结构化数据 → SQL Plugin。
  - 编译期/项目配置 → tauri.conf.json(JSON5/TOML 可选)。
  - 自定义配置 + 类型安全 → 自定义命令 + serde struct + TS interface 镜像(1-to-1 防漂移)。
- 对本项目启示:
  - Polaris 当前正是"自定义命令读写 config.json"路径(get_config/set_config IPC + Rust serde),与 store plugin 路径等价但更类型安全(Config struct 编译期校验)。**无需迁移到 tauri-plugin-store**——自定义命令已有类型安全与 schema 校验,store plugin 是无类型 key-value,反而弱化。
  - 但 store plugin 的两个特性值得借鉴:(1) autoSave debounce(100ms)防频繁写盘——Polaris 的 set_config 可考虑 debounce;(2) Rust↔JS 共享实例避免双写——Polaris 已是后端单真相源,前端只读缓存,符合此原则。
  - Web 模式无 tauri-plugin-store,自定义命令路径在 http service 下仍可工作(后端 fs 读写),路径一致性更好。
  - R03 提到不引入 tauri-plugin-store 避免依赖,此轮研究证实该判断正确:自定义命令 + 类型 struct 更适合 Polaris 的强 schema 需求。

## R08 从 JSON Schema 自动生成配置表单的库与模式
- 来源: https://rjsf-team.github.io/react-jsonschema-form/docs/ (官方) / https://github.com/rjsf-team/react-jsonschema-form / https://jsonic.io/guides/json-schema-forms (2026-05) / https://awesome-react.dev/library/react-jsonschema-form / https://medium.com/@kkoisland/generate-forms-using-json-schema-react-json-schema-form-rjsf-3bd0b76d24c9
- 痛点/核心机制(社区与官方):
  - **react-jsonschema-form (RJSF)** 是主流方案:"automatically generate a React form based on a JSON Schema"。awesome-react 评价"battery-included,takes a standard JSON Schema and automatically renders a fully functional HTML form with validation. Ideal for internal tools, admin panels, and systems where form structures are defined dynamically by the backend."
  - **官方哲学(关键)**:"If you want to generate a form for any data, sight unseen, simply given a JSON schema, RJSF may be for you. If you have a priori knowledge of your data and want a toolkit for generating forms for it, you might look elsewhere."——即 RJSF 适合**数据结构动态/未知**的场景;若结构已知,手写表单更好。
  - **uiSchema 机制**:RJSF 分离 schema(数据结构)与 uiSchema(外观/控件),用 `ui:widget` 覆盖单个渲染器,classNames 加自定义 CSS。
  - **替代路径(React Hook Form + Zod)**:jsonic.io 指出用 @rjsf/core 零组件代码生成,或用 React Hook Form + Zod 手写但获得类型安全与更细控制。
  - **id 自动生成**:默认为所有 widget 生成唯一 id;多实例同页需 `ui:rootFieldId` 前缀防冲突。
- 方案(社区推荐):
  - 动态/后端驱动表单 + 零代码 → RJSF(schema + uiSchema)。
  - 已知结构 + 类型安全 + 细控制 → React Hook Form + Zod(或 valibot)。
  - RJSF 的 widget/template 可定制,但深度定制成本接近手写。
- 对本项目启示:
  - Polaris 插件配置 schema 是**动态的**(插件运行时声明,宿主预先不知),正符合 RJSF 的"sight unseen"场景——用 RJSF 或类似方案从 configSchema 自动渲染设置表单是合理路径。
  - 但 Polaris 内置配置(性能开关、引擎配置等)结构已知且稳定,手写表单(如现有 SettingsTab)更可控——**不应强制全用 RJSF**,应区分:插件配置用 schema 驱动,内置配置用手写。
  - Polaris 的 configSchema(R02 设计的 key/label/type/default/options/help/sensitive/scope)比标准 JSON Schema 更丰富(含 label/help/sensitive),若用 RJSF 需通过 uiSchema 映射这些字段到 widget/label/help,或自定义 widget/template 读取扩展字段。
  - 替代:可参考 RJSF 的"schema + uiSchema 分离"思想,但不一定引入整个 RJSF 库(体积大、定制深)——可自研轻量 schema-driven 表单渲染器,只支持 Polaris 需要的控件类型(text/number/boolean/select/secret),与现有 SettingsTab 风格一致。
  - 敏感字段(sensitive=true)的渲染:RJSF 有 `ui:widget: 'password'`,Polaris 可映射 sensitive→password widget + 脱敏显示。

## R09 Electron 配置原子写与回滚实践
- 来源: https://github.com/sindresorhus/electron-store (主流库 README) / https://jsonic.io/guides/json-in-electron (2026-05) / https://github.com/nathanbuchar/electron-settings / https://stackoverflow.com/questions/30465034
- 痛点(社区真实反馈):
  - **崩溃时写半截文件损坏配置**:Electron 无内置持久化,用户自写 fs.writeFile 若进程崩溃(或断电)在写入中途,JSON 文件半截损坏,下次启动解析失败配置全丢。SO 30465034 早期讨论"store JSON in app dir → update app wipes out"。
  - **全读全写性能边界**:electron-store 明确"The entire JSON file is read and written on every change, so it's best suited for small data like user settings. For large data, use SQLite or similar."——全量写对小配置可接受,大配置应分库。
  - **schema 验证缺失**:自写 fs 读写无 schema 校验,脏数据可落盘;electron-store 用 Ajv(JSON Schema draft-2020-12)在 set 时验证,不合法拒绝写。
- 方案(社区/官方推荐):
  - **electron-store(主流)**:5 方法 API(get/set/delete/clear/onChange),原子写(写临时文件再 rename,崩溃不损坏现有配置),Ajv schema 验证,defaults 默认值,TypeScript 泛型 `Store<T>` 类型安全。Duck.ai 答案:"Electron apps can persist settings in a JSON file and use atomic writes to prevent corruption if the process crashes during a save."
  - **electron-settings**:Atom 编辑器原生配置管理器衍生,同路径 userData/settings.json。
  - **自定义 fs + contextBridge**:jsonic.io 指出用 `fs.promises` 主进程读写 + `contextBridge.exposeInMainWorld` 暴露给 renderer;适合需要自定义文件位置/格式时,但须自行实现原子写(临时文件+rename)与 schema 验证。
  - **原子写标准模式**:写临时文件 → fsync → rename(覆盖原文件)。rename 在同一文件系统是原子的 POSIX 保证。
- 对本项目启示:
  - Polaris 的 set_config 后端写 config.json 正是此场景;需确认是否用了"临时文件+rename"原子写,还是直接覆盖写——若直接覆盖,崩溃时半截 JSON 风险真实存在。
  - Polaris 后端有 serde struct 编译期校验(比 Ajv 运行时更早),但运行时仍需防"序列化中途崩溃"——建议 set_config 实现"先写 .tmp 再 rename"原子模式。
  - config.json 是小文件(用户配置),全读全写可接受;对话历史等大数据已用 SQLite/JSONL 分库,符合 electron-store 的边界建议。
  - defaults 回退:electron-store 的 get(key) 在 key 缺失时回退 defaults;Polaris 的 Config 已用 `..unwrap_or_default()` 链实现类似语义,方向一致。
  - Web 模式 http service 后端写文件同样需要原子写,不能因 Web 模式就省略——否则并发请求或崩溃更易损坏。

## R10 前后端配置 schema 漂移问题(monorepo)
- 来源: https://ertyurk.com/posts/polyglot-monorepos-when-your-backend-and-frontend-speak-different-languages/ (2026-02, Rust+TS polyglot,最对题) / https://dev.to/wantedhorizon1/sharing-typescript-types-in-a-monorepobff-2k8a / https://dev.to/iurii_rogulia/turborepo-monorepo-nextjs-15-frontend-hono-4-backend-in-one-repo-388 / https://www.javacodegeeks.com/2024/11/typescript-harmony-in-monorepos-dependencies-consistency.html / https://metasora.com/blog/turborepo-typescript-monorepo/
- 痛点(社区真实反馈):
  - **"API 返回 string 但前端当 number"的生产 bug**:dev.to iurii_rogulia 称"No more copy-pasting response types into both projects. No more 'the API returns a string but the frontend treats it as a number' bugs discovered in production."——schema 漂移的典型后果。
  - **Rust+TS polyglot 的契约缺口**:ertyurk 明确"Rust types are the source of truth... If I add a field in Rust and forget to update the frontend, the TypeScript compiler catches it. If I remove a field, the compiler catches it."——但前提是有"自动生成的契约",否则漂移无声。
  - **三处真相源失同步**:metasora 指出"types flow from database schema through the shared package to API responses and frontend components. It's one coherent system instead of three separate projects held together by hope and version numbers."——"hope and version numbers"即漂移的无奈现状。
  - **polyglot 痛点**:构建慢(Rust 编译慢,TS 快,等慢的)、工具链冲突(LSP 资源争抢)、CI 复杂(双工具链)、跨语言调试难(前端发错数据后端拒,两边查)、上手成本(Rust 学习曲线)。
- 方案(社区/官方推荐):
  - **契约层(ertyurk, Rust+TS)**:Rust 用 `utoipa` 从 handler 类型生成 OpenAPI spec(非手写),TS client 从 spec 自动生成(`make gen-api` 一命令)。Rust struct `#[derive(Serialize, Deserialize, ToSchema)]` → OpenAPI → TS interface。契约始终准确,编译器抓漂移。
  - **TS 单语言 monorepo**:packages/shared 放共享类型,tsconfig.base 继承,前端/后端/BFF 都 import 同一类型源。javacodegeeks:"centralizing dependencies, creating shared types, modularizing tsconfig.json"。
  - **数据库 schema 作共同底线**:ertyurk 用 SurrealDB migrations,两语言都读同一 schema,迁移文件是事实源。
  - **Makefile/Turbo 编排**:ertyurk 用根 Makefile 编排双工具链(`make dev` 同时启 Rust+TS,`make gen-api` 生成契约)。
- 对本项目启示:
  - Polaris 正是 Rust(Tauri 后端)+ TS(前端)polyglot,且无 OpenAPI 契约层——Config struct 在 Rust 手写,TS interface 在前端手写,**靠人维护同步,正是 ertyurk 说的"hope and version numbers"反模式**。
  - 现状:Config 的 Rust struct ↔ get_config IPC ↔ TS interface,三者靠人工保持一致;一旦 Rust 加字段忘改 TS(或反之),编译不报错(TS 不知道 Rust struct),运行时静默读 undefined。
  - 改进方向(非必须但应评估):(1) Rust 用 `schemars` 或 `utoipa` 从 Config struct 生成 JSON Schema,前端从后端拉 schema 动态渲染(R08 思路);(2) 或 CI 加 schema 一致性校验脚本(对比 Rust struct 字段与 TS interface 字段);(3) 至少在文档里标注"改 Config struct 必须同步 N 处"(类似 dual-engineid-sync 的陷阱备忘)。
  - 短期低成本:在 Config struct 与 TS interface 旁加注释互相引用,加 CI lint 校验字段名集合相等——比引入完整 OpenAPI 生成链轻量,适合 Polaris 当前规模。
  - Polaris 插件 configSchema 是纯数据 JSON(跨 IPC 安全),已天然避免了 Rust struct↔TS 的二进制耦合,漂移风险小于内置 Config——这是插件化配置的额外优势。

## R11 插件系统配置声明最佳实践
- 来源: https://docs.claw.so/engine/plugins/manifest/ (OpenClaw,2026-02,最完整) / https://docs.openclaw.ai/plugins/manifest / https://docs.openclaw.ai/plugins/sdk-setup / https://github.com/ChuckBuilds/ledmatrix-plugins/blob/main/docs/plugin-development/06-manifest-and-config-schema.md / https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-manifest-2.4 (Microsoft Copilot) / Duck.ai 答案
- 痛点/核心机制(社区与官方):
  - **manifest 即契约,无运行时验证**:OpenClaw 要求每个插件必须 `openclaw.plugin.json`,内含 `configSchema`(JSON Schema inline)。"OpenClaw uses this manifest to validate configuration **without executing plugin code**."——冷路径验证,不用加载插件运行时即可校验配置合法性。
  - **严格 schema(拒绝未知键)**:示例 `"additionalProperties": false`;文档明确"Unknown channels.* keys are errors, unless the channel id is declared by a plugin manifest"——声明式发现,未声明即拒绝。OpenClaw docs:"Bundled plugin schemas are strict, so adding myNewKey in user config without adding myNewKey to configSchema.properties will be rejected before the plugin runtime loads."
  - **uiHints 字段**:manifest 可选 `uiHints` 对象,含 config 字段的 label/placeholder/sensitive flags——**专给 UI 渲染用的元数据**,与 schema(数据结构)分离。
  - **manifest 是发现+验证的唯一来源**:"manifest is required for all plugins, including local filesystem loads";"manifest is only for discovery + validation; runtime loads the module separately"——manifest 与运行时模块解耦。
  - **broken manifest = 阻断**:"Missing or invalid manifests are treated as plugin errors and block config validation";Doctor 报告插件错误。
  - **disabled 插件 config 保留 + 警告**:"If plugin config exists but the plugin is disabled, the config is kept and a warning is surfaced"——不丢弃,但不静默。
  - **两文件模式(ledmatrix)**:manifest.json(元数据,store/loader 读)+ config_schema.json(表单,web UI 生成)分文件,各有版本工作流。
  - **Microsoft Copilot plugin manifest 2.4**:大厂范例,manifest 含 capabilities(APIs/MCP tools),schema 版本化(2.1/2.4)。
- 方案(社区/官方推荐):
  - manifest 必含 configSchema(JSON Schema),inline 或相对路径引用。
  - `additionalProperties: false` 严格模式,防拼写错误键静默通过。
  - schema 在 config 读/写时验证(非运行时),broken manifest 阻断验证。
  - UI 元数据(label/placeholder/sensitive)放 uiHints,与数据 schema 分离。
  - 声明式发现:插件声明 channels/providers/skills,未声明的引用是错误。
  - manifest 与运行时模块解耦:manifest 用于发现+验证,运行时单独加载。
- 对本项目启示:
  - Polaris 插件 configSchema(R02 设计的 key/label/type/default/options/help/sensitive/scope)与 OpenClaw 的"configSchema(JSON Schema)+ uiHints"高度同构——但 Polaris 把 UI 元数据(label/help/sensitive)直接揉进 schema 字段,OpenClaw 是 schema + uiHints 分离。**两种都可行**,Polaris 的揉合方式对插件作者更简单(一处声明),OpenClaw 的分离更纯(schema 可标准 JSON Schema 工具消费)。
  - 应学 OpenClaw 的两点:(1) **冷路径验证**——后端在 set_config 时用 configSchema 校验,不依赖插件运行时加载(防插件崩溃影响配置);(2) **additionalProperties: false 严格模式**——拒绝未知键,防拼写错误键静默写入。
  - Polaris 应学"broken manifest 阻断 + Doctor 报告":插件 manifest 缺失或 schema 无效时,不应静默加载,应标记错误并阻止其配置写入,在设置页可见。
  - Polaris 应学"disabled 插件 config 保留 + warning":卸载或禁用插件时,其配置不删除(保留以便重启用),但 UI 标记警告——避免用户误清后再启用丢配置。
  - Microsoft Copilot 的 manifest 版本化(schema 2.1/2.4)启示:Polaris 插件 manifest 应含 `version` 或 `schemaVersion`,便于未来 configSchema 演进时迁移。

## R12 多 store 状态同步:事件驱动 vs 轮询
- 来源: https://github.com/pmndrs/zustand/discussions/1102 (官方,作者 dai-shi 参与) / Duck.ai 答案 / https://dev.to/idanshalem/building-react-multi-tab-sync-a-custom-hook-with-the-broadcastchannel-api-c6d / https://dev.to/xenral/still-using-redux-everywhere-how-an-event-bus-could-transform-your-react-workflow-18ej / https://www.krapton.com/blog/synchronize-browser-tab-state-prevent-stale-data-in-react-apps-692d1b / https://www.nextsteps.dev/en/posts/federated-state-done-righ
- 痛点(社区真实反馈):
  - **事件驱动 vs 轮询的根本取舍**:Duck.ai 答案:"Event-driven architectures are generally more efficient for real-time updates, as they allow components to react to changes immediately without the overhead of constant polling. In contrast, polling can be simpler to implement but may lead to unnecessary resource usage if updates are infrequent."——事件驱动实时但复杂,轮询简单但浪费。
  - **zustand 无 onSubscribe/onDelete 钩子(GitHub #1102)**:用户想在 zustand 重建 react-query 的共享轮询(多消费者订阅同一数据,全部卸载停止轮询),但 zustand 无订阅生命周期钩子。用户称"想 onSubscribe/onDelete,但 contradicts simplicity of zustand"。作者 dai-shi 给两个方案:(1) 全局态放 store 外 setTimeout;(2) track mounted count,mount 启 timer,unmount 到 0 停 timer——但需手动管理计数,易错。
  - **多 tab 同步**:dev.to idanshalem 建 react-broadcast-sync,解决"消息去重、智能批处理、生命周期管理"三个坑;BroadcastChannel 是现代方案,但实现细节多。krapton:"BroadcastChannel API is the recommended modern solution for multi-tab state synchronization"——但同源限制。
  - **事件总线 vs 状态库**:dev.to xenral 主张事件总线(Event Bus)比 Redux/Zustand 更灵活,减少不必要的状态库耦合——但事件总线无单一真相源,调试难。
  - **federated state(多 store 联邦)**:nextsteps.dev 指"singleton configuration that prevents duplicate instances, cache-sharing strategies that don't create tight coupling, and the critical separation between client state (Zustand) and server state (TanStack Query)"——多 store 协同的关键是单例防重复 + 缓存共享不紧耦合 + 客户端态/服务端态分离。
- 方案(社区/官方推荐):
  - **事件驱动(首选,实时场景)**:BroadcastChannel(多 tab 同源)/ 自定义事件总线(组件解耦)/ Tauri `config-changed` 事件(后端→前端跨窗口)。组件订阅事件即时响应,无轮询开销。
  - **轮询(简单场景,更新不频繁)**:zustand + mounted 计数 + setTimeout(作者推荐 hook 组合而非中间件,因 TS 类型难)。
  - **客户端态 vs 服务端态分离**:Zustand 管客户端态(UI/配置),TanStack Query/SWR 管服务端态(异步数据/缓存/重验证)——不要用 Zustand 做 react-query 的事。
  - **单例 + 引用计数**:多消费者共享同一资源(如轮询)时,store 单例 + mounted 计数,0 时释放。
- 对本项目启示:
  - Polaris 配置同步是**事件驱动**(后端 `config-changed` 事件 → 前端 store 更新),符合社区首选方向,非轮询——方向正确。
  - R01 已指出 zustand persist 跨 tab 用 BroadcastChannel(dai-shi 推荐);Polaris 的 configStore 不 persist,跨窗口靠后端事件,与 BroadcastChannel 思路一致但更可靠(后端单真相源)。
  - **zustand 无 onSubscribe 钩子的启示**:Polaris 的 13+ persist store 若需"有消费者才轮询/订阅"语义,不能依赖 zustand 内置,需外层 hook(useRef + mounted 计数)或转事件驱动——这正是 configStore 用后端事件的优势(后端 push,前端被动接收,无需轮询协调)。
  - **客户端态/服务端态分离**:configStore 是"服务端态"(后端真相源,前端只读缓存),应用会话/对话等是"服务端态"(TanStack Query 范畴);UI 临时态(面板展开/输入草稿)是"客户端态"(zustand persist)。Polaris 应明确这三层,配置同步用事件驱动,不要误用轮询。
  - **federated state 单例**:Polaris 多 store 应确保单例(已在 sessionStoreManager 管理),避免重复实例;configStore 作为配置真相源的缓存,应是全局单例,多窗口共享后端事件而非各自轮询后端。

---

## 总结:对 Polaris 配置系统重构的关键启示汇总

| 轮次 | 主题 | 核心启示 |
|------|------|----------|
| R01 | zustand persist 跨 Tab | 后端事件驱动同步,避免 storage 事件循环 |
| R02 | VSCode contributes.configuration | 插件 configSchema 纯数据声明式设计 |
| R03 | Tauri 多窗口同步 | 复用现有 config-changed 事件,不引入第三方库 |
| R04 | 前端配置重启丢失 | 后端为真相源,localStorage 只做缓存 |
| R05 | persist merge 丢函数 | 用 partialize 排除 action,从根源规避 |
| R06 | VSCode 运行时读配置 | scope 隐式权限模型 + inspect 查各层 |
| R07 | Tauri store vs 自定义 JSON | 自定义命令 + 类型 struct 更适合强 schema |
| R08 | schema 自动生成表单 | 插件配置用 schema 驱动,内置配置手写 |
| R09 | Electron 原子写 | set_config 用临时文件+rename 防崩溃损坏 |
| R10 | monorepo schema 漂移 | 评估 schemars 生成 JSON Schema + CI 校验 |
| R11 | 插件配置声明最佳实践 | 冷路径验证 + additionalProperties:false + uiHints |
| R12 | 事件驱动 vs 轮询 | 事件驱动首选,客户端态/服务端态分离 |

**三条主线**:
1. **真相源**:后端 config.json 为唯一真相源,前端 localStorage/zustand 只做缓存与回退(R04/R05/R07)。
2. **同步机制**:事件驱动(后端 config-changed 事件)而非轮询/storage 事件,避免循环与浪费(R01/R03/R12)。
3. **插件配置**:声明式纯数据 schema + 冷路径验证 + 严格模式 + UI 元数据分离(R02/R06/R11),可从 schema 自动生成表单(R08)。
