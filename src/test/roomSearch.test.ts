import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorToSearchResult, roomStatusToSearchResult } from '../roomSearch';
import { LiveRoomStatus } from '../types';

test('room id and anchor searches use the same result presentation', () => {
  const room = createRoom({
    anchorName: '测试主播',
    fansCount: 12345,
    status: 'live'
  });
  const roomResult = roomStatusToSearchResult(room, true);
  const anchorResult = anchorToSearchResult(
    {
      roomId: '1000',
      uid: '2000',
      uname: '测试主播',
      fansCount: 12345,
      isLive: true
    },
    true
  );

  assert.deepEqual(
    {
      title: roomResult?.title,
      subtitle: roomResult?.subtitle,
      detail: roomResult?.detail,
      isLive: roomResult?.isLive,
      monitored: roomResult?.monitored
    },
    {
      title: anchorResult.title,
      subtitle: anchorResult.subtitle,
      detail: anchorResult.detail,
      isLive: anchorResult.isLive,
      monitored: anchorResult.monitored
    }
  );
  assert.equal(roomResult?.detail, '未知分区 · 粉丝 12,345 · 直播中');
});

test('room search formats offline rooms and unavailable fans count', () => {
  const result = roomStatusToSearchResult(createRoom({ status: 'offline', fansCount: null }), false);

  assert.equal(result?.detail, '未知分区 · 粉丝 -- · 未开播');
  assert.equal(result?.isLive, false);
  assert.equal(result?.monitored, false);
});

test('room search does not present unknown or failed rooms as valid results', () => {
  const result = roomStatusToSearchResult(
    createRoom({ status: 'unknown', error: '直播间不存在或接口未返回该房间' }),
    false
  );

  assert.equal(result, undefined);
});

function createRoom(overrides: Partial<LiveRoomStatus>): LiveRoomStatus {
  return {
    roomId: '1000',
    title: '测试直播间',
    anchorName: '测试主播',
    fansCount: null,
    status: 'offline',
    online: 0,
    popularity: 0,
    guardFleet: null,
    liveStartTime: null,
    liveDurationText: '未开播',
    lastUpdatedAt: 0,
    ...overrides
  };
}
