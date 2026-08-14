import test from 'node:test';
import assert from 'node:assert/strict';
import { BilibiliLiveClient, normalizeRoomInfo } from '../bilibiliClient';

test('normalizeRoomInfo maps live room fields', () => {
  const status = normalizeRoomInfo(
    '1000',
    {
      room_id: 1000,
      short_id: 10,
      title: '测试直播',
      uname: '主播',
      live_status: 1,
      online: 2333,
      live_time: 100
    },
    1000 * 1000
  );

  assert.equal(status.status, 'live');
  assert.equal(status.online, null);
  assert.equal(status.popularity, 2333);
  assert.equal(status.guardFleet, null);
  assert.equal(status.fansCount, null);
  assert.equal(status.anchorName, '主播');
  assert.equal(status.liveDurationText, '15分钟0秒');
});

test('normalizeRoomInfo uses zero online count for offline rooms', () => {
  const status = normalizeRoomInfo(
    '1000',
    {
      room_id: 1000,
      title: '测试直播',
      uname: '主播',
      live_status: 0,
      online: 2333,
      live_time: 0
    },
    1000 * 1000
  );

  assert.equal(status.status, 'offline');
  assert.equal(status.online, 0);
  assert.equal(status.popularity, 2333);
  assert.equal(status.liveDurationText, '未开播');
});

test('normalizeRoomInfo creates per-room error for missing data', () => {
  const status = normalizeRoomInfo('404', undefined, 1000);
  assert.equal(status.status, 'unknown');
  assert.match(status.error ?? '', /不存在|未返回/);
});

test('BilibiliLiveClient preserves requested rooms when one is missing', async () => {
  const client = new BilibiliLiveClient(async () => baseInfoResponse({}));
  const rooms = await client.fetchRooms(['1', '2'], 1234);

  assert.equal(rooms.length, 2);
  assert.equal(rooms[0].status, 'unknown');
  assert.equal(rooms[1].status, 'unknown');
  assert.equal(rooms[1].roomId, '2');
});

test('BilibiliLiveClient uses online rank count for live rooms when available', async () => {
  const client = new BilibiliLiveClient(async (input) => {
    const url = String(input);
    if (url.includes('getOnlineGoldRank')) {
      return jsonResponse({
        code: 0,
        data: {
          onlineNum: 952,
          onlineNumText: '952'
        }
      });
    }

    if (url.includes('guardTab')) {
      return guardResponse(0);
    }

    if (url.includes('relation/stat')) {
      return relationStatResponse(72);
    }

    return baseInfoResponse({
      '1': {
        uid: 100,
        room_id: 1,
        title: 'A',
        uname: '主播A',
        live_status: 1,
        online: 73689,
        live_time: 100
      }
    });
  });

  const rooms = await client.fetchRooms(['1'], 1234);

  assert.equal(rooms[0].online, 952);
  assert.equal(rooms[0].popularity, 73689);
  assert.equal(rooms[0].fansCount, 72);
});

test('BilibiliLiveClient fetches guard fleet total', async () => {
  const client = new BilibiliLiveClient(async (input) => {
    const url = String(input);
    if (url.includes('getOnlineGoldRank')) {
      return jsonResponse({ code: 0, data: { onlineNum: 952 } });
    }

    if (url.includes('guardTab')) {
      return guardResponse(106);
    }

    if (url.includes('relation/stat')) {
      return relationStatResponse(72);
    }

    return baseInfoResponse({
      '1': {
        uid: 100,
        room_id: 1,
        title: 'A',
        uname: '主播A',
        live_status: 1,
        online: 73689,
        live_time: 100
      }
    });
  });

  const rooms = await client.fetchRooms(['1'], 1234);

  assert.deepEqual(rooms[0].guardFleet, {
    total: 106
  });
});

test('BilibiliLiveClient keeps room status when fans count request fails', async () => {
  const client = new BilibiliLiveClient(async (input) => {
    const url = String(input);
    if (url.includes('getOnlineGoldRank')) {
      return jsonResponse({ code: 0, data: { onlineNum: 952 } });
    }

    if (url.includes('guardTab')) {
      return guardResponse(0);
    }

    if (url.includes('relation/stat')) {
      return httpErrorResponse(503);
    }

    return baseInfoResponse({
      '1': {
        uid: 100,
        room_id: 1,
        title: 'A',
        uname: '主播A',
        live_status: 1,
        online: 73689,
        live_time: 100
      }
    });
  });

  const rooms = await client.fetchRooms(['1'], 1234);

  assert.equal(rooms[0].status, 'live');
  assert.equal(rooms[0].online, 952);
  assert.equal(rooms[0].fansCount, null);
});

test('BilibiliLiveClient keeps live online count null when online rank fails', async () => {
  const client = new BilibiliLiveClient(async (input) => {
    const url = String(input);
    if (url.includes('getOnlineGoldRank')) {
      return httpErrorResponse(503);
    }

    if (url.includes('guardTab')) {
      return guardResponse(0);
    }

    if (url.includes('relation/stat')) {
      return relationStatResponse(72);
    }

    return baseInfoResponse({
      '1': {
        uid: 100,
        room_id: 1,
        title: 'A',
        uname: '主播A',
        live_status: 1,
        online: 73689,
        live_time: 100
      }
    });
  });

  const rooms = await client.fetchRooms(['1'], 1234);

  assert.equal(rooms[0].status, 'live');
  assert.equal(rooms[0].online, null);
  assert.equal(rooms[0].popularity, 73689);
});

test('BilibiliLiveClient formats fetch failures for room status', async () => {
  const client = new BilibiliLiveClient(async () => {
    const error = new Error('fetch failed') as Error & { cause?: unknown };
    error.cause = Object.assign(new Error('connect EACCES 198.18.0.149:443'), {
      code: 'EACCES',
      address: '198.18.0.149',
      port: 443
    });
    throw error;
  });

  const rooms = await client.fetchRooms(['1'], 1234);

  assert.equal(rooms[0].status, 'unknown');
  assert.match(rooms[0].error ?? '', /代理\/fake-ip|198\.18\.0\.149:443/);
});

test('BilibiliLiveClient formats fetch failures for search', async () => {
  const client = new BilibiliLiveClient(async () => {
    const error = new Error('fetch failed') as Error & { cause?: unknown };
    error.cause = Object.assign(new Error('connect EACCES 198.18.0.150:443'), {
      code: 'EACCES',
      address: '198.18.0.150',
      port: 443
    });
    throw error;
  });

  await assert.rejects(() => client.searchLiveAnchors('能能'), /代理\/fake-ip|198\.18\.0\.150:443/);
});

test('BilibiliLiveClient searches live anchors by fuzzy keyword', async () => {
  const client = new BilibiliLiveClient(async () => {
    return jsonResponse({
      code: 0,
      data: {
        result: [
          {
            uid: 1806543,
            roomid: 26795,
            uname: '<em class="keyword">dumpling</em>0v0',
            uface: '//i0.hdslb.com/avatar.jpg',
            cate_name: '其他单机',
            attentions: 72,
            is_live: false,
            live_status: 0
          }
        ]
      }
    });
  });

  const results = await client.searchLiveAnchors('dumpling');

  assert.equal(results[0].roomId, '26795');
  assert.equal(results[0].uname, 'dumpling0v0');
  assert.equal(results[0].face, 'https://i0.hdslb.com/avatar.jpg');
  assert.equal(results[0].category, '其他单机');
  assert.equal(results[0].fansCount, 72);
});

test('BilibiliLiveClient sends browser-like headers for live anchor search', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const client = new BilibiliLiveClient(async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return jsonResponse({ code: 0, data: { result: [] } });
  });

  await client.searchLiveAnchors('能能');

  const headers = requestInit?.headers as Record<string, string>;
  assert.match(requestUrl, /search_type=live_user/);
  assert.match(requestUrl, /page_size=20/);
  assert.equal(headers.origin, 'https://search.bilibili.com');
  assert.match(headers.referer, /^https:\/\/search\.bilibili\.com\/live\?keyword=/);
  assert.match(headers['user-agent'], /Mozilla\/5\.0/);
  assert.match(headers.cookie ?? '', /buvid3=/);
});

test('BilibiliLiveClient returns friendly message when live anchor search is blocked', async () => {
  const client = new BilibiliLiveClient(async () => httpErrorResponse(412));

  await assert.rejects(() => client.searchLiveAnchors('能能'), /主播搜索暂时被拦截|输入直播间房间号/);
});

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload
  } as Response;
}

function httpErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({})
  } as Response;
}

function baseInfoResponse(byRoomIds: Record<string, unknown>): Response {
  return jsonResponse({
    code: 0,
    data: {
      by_room_ids: byRoomIds
    }
  });
}

function guardResponse(total: number): Response {
  return jsonResponse({
    code: 0,
    data: {
      info: {
        num: total
      }
    }
  });
}

function relationStatResponse(follower: number): Response {
  return jsonResponse({
    code: 0,
    data: {
      follower
    }
  });
}
