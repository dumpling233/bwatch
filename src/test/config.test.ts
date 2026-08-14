import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampAutoRefreshInterval,
  moveRoomGroupToIndex,
  normalizeNetworkProxyMode,
  normalizeRoomGroups,
  normalizeRoomIds,
  readMonitorSettings,
  readNetworkProxySettings,
  renameRoomGroup,
  reorderRoomGroups
} from '../config';

test('normalizeRoomIds keeps numeric unique room IDs', () => {
  assert.deepEqual(normalizeRoomIds([' 123 ', 'abc', '123', '456', '', null]), ['123', '456']);
});

test('clampAutoRefreshInterval enforces 15 second minimum', () => {
  assert.equal(clampAutoRefreshInterval(5), 15);
  assert.equal(clampAutoRefreshInterval(15), 15);
  assert.equal(clampAutoRefreshInterval(31.9), 31);
  assert.equal(clampAutoRefreshInterval('bad'), 15);
});

test('normalizeRoomGroups keeps valid unique groups and room IDs', () => {
  assert.deepEqual(
    normalizeRoomGroups(
      [
        { id: ' group-a ', name: ' A组 ', rooms: ['100', 'bad', '200', '100'] },
        { id: 'group-a', name: '重复 ID', rooms: ['100'] },
        { id: 'group-b', name: 'A组', rooms: ['200'] },
        { id: '中文', name: '中文组', rooms: ['300'] },
        { id: '', name: '', rooms: ['100'] },
        null
      ],
      ['100', '200']
    ),
    [
      { id: 'group-a', name: 'A组', rooms: ['100', '200'] },
      { id: 'group-3', name: '中文组', rooms: [] }
    ]
  );
});

test('readMonitorSettings normalizes groups against monitored rooms', () => {
  const settings = readMonitorSettings({
    get(section, defaultValue) {
      const values: Record<string, unknown> = {
        rooms: ['100', '200'],
        groups: [{ id: 'favorites', name: '常看', rooms: ['100', '300'] }],
        'autoRefresh.enabled': true,
        'autoRefresh.intervalSeconds': 1,
        'notifications.liveStart.enabled': false
      };
      return (section in values ? values[section] : defaultValue) as never;
    }
  });

  assert.deepEqual(settings.groups, [{ id: 'favorites', name: '常看', rooms: ['100'] }]);
  assert.equal(settings.autoRefreshIntervalSeconds, 15);
});

test('reorderRoomGroups moves groups without changing their data', () => {
  const groups = [
    { id: 'a', name: 'A组', rooms: ['100'] },
    { id: 'b', name: 'B组', rooms: ['200'] },
    { id: 'c', name: 'C组', rooms: ['300'] }
  ];

  assert.deepEqual(reorderRoomGroups(groups, 'b', -1).map((group) => group.id), ['b', 'a', 'c']);
  assert.deepEqual(reorderRoomGroups(groups, 'b', 1).map((group) => group.id), ['a', 'c', 'b']);
  assert.deepEqual(reorderRoomGroups(groups, 'a', -1), groups);
  assert.deepEqual(reorderRoomGroups(groups, 'c', 1), groups);
  assert.deepEqual(reorderRoomGroups(groups, 'missing', 1), groups);
  assert.deepEqual(groups.map((group) => group.id), ['a', 'b', 'c']);
});

test('moveRoomGroupToIndex supports direct drag-style reordering', () => {
  const groups = [
    { id: 'a', name: 'A组', rooms: ['100'] },
    { id: 'b', name: 'B组', rooms: ['200'] },
    { id: 'c', name: 'C组', rooms: ['300'] }
  ];

  assert.deepEqual(moveRoomGroupToIndex(groups, 'a', 2).map((group) => group.id), ['b', 'c', 'a']);
  assert.deepEqual(moveRoomGroupToIndex(groups, 'c', 0).map((group) => group.id), ['c', 'a', 'b']);
  assert.deepEqual(moveRoomGroupToIndex(groups, 'b', 99).map((group) => group.id), ['a', 'c', 'b']);
  assert.deepEqual(moveRoomGroupToIndex(groups, 'missing', 0), groups);
  assert.deepEqual(groups.map((group) => group.id), ['a', 'b', 'c']);
});

test('renameRoomGroup changes only the name and preserves stable group data', () => {
  const groups = [
    { id: 'a', name: 'A组', rooms: ['100'] },
    { id: 'b', name: 'B组', rooms: ['200', '300'] }
  ];

  assert.deepEqual(renameRoomGroup(groups, 'b', ' 新名称 '), [
    { id: 'a', name: 'A组', rooms: ['100'] },
    { id: 'b', name: '新名称', rooms: ['200', '300'] }
  ]);
  assert.deepEqual(renameRoomGroup(groups, 'b', 'A组'), groups);
  assert.deepEqual(renameRoomGroup(groups, 'missing', '新名称'), groups);
  assert.deepEqual(renameRoomGroup(groups, 'b', ''), groups);
  assert.deepEqual(groups[1], { id: 'b', name: 'B组', rooms: ['200', '300'] });
});

test('normalizeNetworkProxyMode falls back to auto', () => {
  assert.equal(normalizeNetworkProxyMode('manual'), 'manual');
  assert.equal(normalizeNetworkProxyMode('off'), 'off');
  assert.equal(normalizeNetworkProxyMode('bad'), 'auto');
});

test('readNetworkProxySettings trims manual proxy URL', () => {
  const settings = readNetworkProxySettings({
    get(section, defaultValue) {
      const values: Record<string, unknown> = {
        'network.proxy.mode': 'manual',
        'network.proxy.url': ' http://127.0.0.1:7890 '
      };
      return (section in values ? values[section] : defaultValue) as never;
    }
  });

  assert.deepEqual(settings, {
    mode: 'manual',
    url: 'http://127.0.0.1:7890'
  });
});
