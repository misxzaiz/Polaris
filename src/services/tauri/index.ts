/**
 * Tauri 命令服务统一入口
 *
 * 从各子模块 re-export 所有 API，保持对外接口完全兼容。
 * 消费端无需修改任何 import 路径。
 */

// 导出 invoke 和 listen — 通过 transport 抽象层路由
// Tauri 模式: 直接 IPC，HTTP 模式: fetch + WebSocket
export { invoke, listen } from '@/services/transport';

// 配置 + 健康检查
export * from './configService';

// 对话交互（QA、Plan、stdin、导出）
export * from './chatService';

// 文件系统（浏览器、搜索、监听、工作区）
export * from './fileService';

// 上下文管理
export * from './contextService';

// 窗口控制、翻译、系统
export * from './windowService';

// 内置浏览器控制
export * from './browserService';

// 集成平台（钉钉、QQ、飞书、实例管理）
export * from './integrationService';

// 定时任务（CRUD、锁、模板、协议、片段）
export * from './schedulerService';

// LSP 语言服务器（进程管理、消息转发）
export * from './lspService';
