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

test('BilibiliLiveClient limits enrichment concurrency and caches slow fields', async () => {
  let activeEnrichmentRequests = 0;
  let maxActiveEnrichmentRequests = 0;
  let baseInfoRequests = 0;
  let guardRequests = 0;
  let fansRequests = 0;
  const byRoomIds = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index + 1), {
    uid: 100 + index,
    room_id: index + 1,
    title: `房间${index + 1}`,
    uname: `主播${index + 1}`,
    live_status: 0,
    online: 0,
    live_time: 0
  }]));
  const client = new BilibiliLiveClient(async (input) => {
    const url = String(input);
    if (url.includes('getRoomBaseInfo')) {
      baseInfoRequests += 1;
      return baseInfoResponse(byRoomIds);
    }

    const isEnrichmentRequest = url.includes('guardTab') || url.includes('relation/stat');
    if (isEnrichmentRequest) {
      activeEnrichmentRequests += 1;
      maxActiveEnrichmentRequests = Math.max(maxActiveEnrichmentRequests, activeEnrichmentRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeEnrichmentRequests -= 1;
    }

    if (url.includes('guardTab')) {
      guardRequests += 1;
      return guardResponse(10);
    }

    fansRequests += 1;
    return relationStatResponse(20);
  });

  await client.fetchRooms(Object.keys(byRoomIds), 1000);
  await client.fetchRooms(Object.keys(byRoomIds), 2000);

  assert.ok(maxActiveEnrichmentRequests <= 12);
  assert.equal(baseInfoRequests, 1);
  assert.equal(guardRequests, 8);
  assert.equal(fansRequests, 8);
});

test('BilibiliLiveClient marks cached fans and guard values stale after refresh failure', async () => {
  let supplementsAvailable = true;
  const client = new BilibiliLiveClient(async (input) => {
    const url = String(input);
    if (url.includes('guardTab')) {
      return supplementsAvailable ? guardResponse(106) : httpErrorResponse(503);
    }
    if (url.includes('relation/stat')) {
      return supplementsAvailable ? relationStatResponse(72) : httpErrorResponse(503);
    }
    return baseInfoResponse({
      '1': {
        uid: 100,
        room_id: 1,
        title: 'A',
        uname: '主播A',
        live_status: 0,
        online: 0,
        live_time: 0
      }
    });
  });

  const firstRooms = await client.fetchRooms(['1'], 1_000);
  supplementsAvailable = false;
  const secondRooms = await client.fetchRooms(['1'], 5 * 60 * 1000 + 2_000);

  assert.equal(firstRooms[0].fansCount, 72);
  assert.equal(firstRooms[0].guardFleet?.total, 106);
  assert.equal(secondRooms[0].fansCount, 72);
  assert.equal(secondRooms[0].guardFleet?.total, 106);
  assert.equal(secondRooms[0].fansCountStale, true);
  assert.equal(secondRooms[0].guardFleetStale, true);
  assert.equal(secondRooms[0].fansCountLastSuccessAt, 1_000);
  assert.equal(secondRooms[0].guardFleetLastSuccessAt, 1_000);
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

test('BilibiliLiveClient caches online counts by the configured interval and marks failed refreshes stale', async () => {
  let onlineAvailable = true;
  let onlineRequests = 0;
  const client = new BilibiliLiveClient(async (input) => {
    const url = String(input);
    if (url.includes('getOnlineGoldRank')) {
      onlineRequests += 1;
      return onlineAvailable ? jsonResponse({ code: 0, data: { onlineNum: 500 } }) : httpErrorResponse(503);
    }
    if (url.includes('guardTab')) {
      return guardResponse(10);
    }
    if (url.includes('relation/stat')) {
      return relationStatResponse(20);
    }
    return baseInfoResponse({
      '1': {
        uid: 100,
        room_id: 1,
        title: 'A',
        uname: '涓绘挱A',
        live_status: 1,
        online: 999,
        live_time: 100
      }
    });
  });

  const firstRooms = await client.fetchRooms(['1'], 1_000);
  const cachedRooms = await client.fetchRooms(['1'], 5_000);
  onlineAvailable = false;
  const staleRooms = await client.fetchRooms(['1'], 17_000);

  assert.equal(firstRooms[0].online, 500);
  assert.equal(cachedRooms[0].online, 500);
  assert.equal(cachedRooms[0].onlineStale, false);
  assert.equal(staleRooms[0].online, 500);
  assert.equal(staleRooms[0].onlineStale, true);
  assert.equal(staleRooms[0].onlineLastSuccessAt, 1_000);
  assert.equal(onlineRequests, 2);
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
