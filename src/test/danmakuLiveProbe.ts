import { BilibiliDanmakuSession } from '../danmakuClient';
import { createProxyFetch } from '../network';
import { ResolvedProxy } from '../network';

const roomId = process.argv[2] || '13';
const timeoutMs = 30_000;
const proxy: ResolvedProxy = { mode: 'auto', url: null, source: 'none' };
const session = new BilibiliDanmakuSession(createProxyFetch(proxy), () => proxy, {
  log: (message) => console.log(message)
});
let connected = false;
let finished = false;

const finish = (exitCode: number, message: string) => {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(timeout);
  console.log(message);
  session.dispose();
  setImmediate(() => process.exit(exitCode));
};

const timeout = setTimeout(() => {
  finish(2, connected ? '已连接，但等待 30 秒仍未收到文本弹幕' : '等待 30 秒仍未连接到弹幕服务器');
}, timeoutMs);

session.onDidEvent((event) => {
  if (event.type === 'snapshot') {
    connected = connected || event.snapshot.status === 'connected';
    if (event.snapshot.status === 'error') {
      finish(1, `连接失败：${event.snapshot.error || '未知错误'}`);
    }
    return;
  }
  if (event.type === 'message') {
    finish(0, `收到实时弹幕：${event.message.username}: ${event.message.content}`);
  }
});

console.log(`正在验证 B站直播间 ${roomId} 的实时弹幕，最多等待 30 秒...`);
session.connect(roomId);
