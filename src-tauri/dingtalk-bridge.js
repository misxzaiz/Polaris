#!/usr/bin/env node

/**
 * 钉钉桥接服务
 *
 * 功能:
 * - 接收钉钉机器人的 Webhook 消息并转发给 Rust 后端
 * - 接收 Rust 后端的指令并发送到钉钉
 *
 * 通信协议 (stdin/stdout):
 * - 输入: JSON 格式的指令
 * - 输出: JSON 格式的消息和状态
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// 从命令行参数获取配置
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    appKey: '',
    appSecret: '',
    port: 3456,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--app-key':
        config.appKey = args[++i];
        break;
      case '--app-secret':
        config.appSecret = args[++i];
        break;
      case '--port':
        config.port = parseInt(args[++i], 10);
        break;
    }
  }

  return config;
}

// 获取 access_token
function getAccessToken(appKey, appSecret) {
  // 注意: 这是一个简化版本,实际应用中需要实现钉钉的 OAuth 流程
  // 这里我们使用企业内部机器人的 Webhook 方式
  return null;
}

// 发送消息到钉钉 (使用 Webhook)
async function sendToDingTalk(webhook, content) {
  // 这里需要实际的钉钉 Webhook URL
  // 目前返回模拟数据
  console.error(`[DingTalk] 发送消息到 ${webhook}: ${content}`);
  return { success: true, message: '发送成功' };
}

// 创建 HTTP 服务器接收 Webhook
function createServer(port) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/webhook') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });

      req.on('end', () => {
        try {
          const data = JSON.parse(body);

          // 提取消息内容
          const message = {
            type: 'message',
            conversationId: data.conversationId || 'default',
            senderName: data.senderName || '未知',
            content: data.content || data.text || '',
            timestamp: Date.now(),
          };

          // 发送到 stdout (Rust 会监听)
          console.log(JSON.stringify(message));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          console.error(`[DingTalk] 解析消息失败: ${error.message}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    const status = {
      type: 'status',
      isRunning: true,
      port: port,
      message: `钉钉桥接服务已启动，监听端口 ${port}`,
      timestamp: Date.now(),
    };
    console.log(JSON.stringify(status));
    console.error(`[DingTalk] HTTP 服务器已启动，监听端口 ${port}`);
  });

  server.on('error', (error) => {
    console.error(`[DingTalk] 服务器错误: ${error.message}`);
    const status = {
      type: 'error',
      error: error.message,
      timestamp: Date.now(),
    };
    console.log(JSON.stringify(status));
  });

  return server;
}

// 监听 stdin 接收来自 Rust 的指令
function listenStdin() {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line) => {
    try {
      const command = JSON.parse(line);

      switch (command.type) {
        case 'send':
          // 发送消息到钉钉
          const result = await sendToDingTalk(
            command.webhook,
            command.content
          );

          console.log(JSON.stringify({
            type: 'message-sent',
            success: result.success,
            conversationId: command.conversationId,
            timestamp: Date.now(),
          }));
          break;

        case 'shutdown':
          // 关闭服务
          console.error('[DingTalk] 收到关闭指令');
          process.exit(0);
          break;

        default:
          console.error(`[DingTalk] 未知指令类型: ${command.type}`);
      }
    } catch (error) {
      console.error(`[DingTalk] 处理指令失败: ${error.message}`);
    }
  });
}

// 主函数
function main() {
  console.error('[DingTalk] 钉钉桥接服务启动中...');

  const config = parseArgs();

  if (!config.appKey || !config.appSecret) {
    console.error('[DingTalk] 错误: 缺少 appKey 或 appSecret');
    process.exit(1);
  }

  console.error(`[DingTalk] 配置: AppKey=${config.appKey}, Port=${config.port}`);

  // 创建 HTTP 服务器
  const server = createServer(config.port);

  // 监听 stdin
  listenStdin();

  // 优雅退出
  process.on('SIGINT', () => {
    console.error('[DingTalk] 收到 SIGINT 信号，正在关闭...');
    server.close(() => {
      console.error('[DingTalk] 服务器已关闭');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    console.error('[DingTalk] 收到 SIGTERM 信号，正在关闭...');
    server.close(() => {
      console.error('[DingTalk] 服务器已关闭');
      process.exit(0);
    });
  });
}

// 启动服务
main();
