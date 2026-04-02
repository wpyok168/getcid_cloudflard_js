// 版本映射：把worker1.js、worker4.js的逻辑导入进来
import * as mainWorker from './worker.js';
import * as v1Worker from './worker1.js';
import * as v4Worker from './worker4.js';

// 版本处理器
const versionHandlers = {
  'main': mainWorker,
  'v1': v1Worker,
  'v4': v4Worker,
  'default': mainWorker
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 从路径获取版本：/v1/ 用worker1.js，/v4/ 用worker4.js，默认用worker.js
    const version = url.pathname.startsWith('/v1/') ? 'v1' : 
                    url.pathname.startsWith('/v4/') ? 'v4' : 'default';
    
    const handler = versionHandlers[version];
    if (handler?.fetch) {
      // 重写路径，让版本逻辑正常运行
      const newRequest = new Request(
        new URL(url.pathname.replace(/^\/v1|\/v4/, ''), url.origin),
        request
      );
      return handler.fetch(newRequest, env, ctx);
    }
    return new Response('Version not found', { status: 404 });
  }
};
