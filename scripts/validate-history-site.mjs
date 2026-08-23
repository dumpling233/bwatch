import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.argv[2] || 'site');
const dataRoot = path.join(root, 'data', 'v1');
const manifestPath = path.join(dataRoot, 'manifest.json');

assert.ok(fs.existsSync(path.join(root, 'index.html')), 'site/index.html is missing');
assert.ok(fs.existsSync(path.join(root, '.nojekyll')), 'site/.nojekyll is missing');
assert.ok(fs.existsSync(manifestPath), 'site/data/v1/manifest.json is missing');

const manifest = readJson(manifestPath);
assert.equal(manifest.schemaVersion, 1, 'manifest schemaVersion must be 1');
assert.ok(Number.isFinite(manifest.generatedAt) && manifest.generatedAt >= 0, 'manifest generatedAt is invalid');
assert.equal(typeof manifest.timeZone, 'string', 'manifest timeZone is invalid');
assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: manifest.timeZone }), 'manifest timeZone is unknown');
assert.ok(Array.isArray(manifest.rooms), 'manifest rooms must be an array');
assert.ok(Array.isArray(manifest.groups), 'manifest groups must be an array');
assert.ok(Array.isArray(manifest.dates), 'manifest dates must be an array');

const roomIds = new Set();
for (const [index, room] of manifest.rooms.entries()) {
  assert.match(room.roomId, /^\d+$/, `rooms[${index}].roomId is invalid`);
  assert.ok(!roomIds.has(room.roomId), `duplicate room ${room.roomId}`);
  roomIds.add(room.roomId);
  assert.equal(room.order, index, `room ${room.roomId} has unstable order`);
  assert.equal(typeof room.anchorName, 'string', `room ${room.roomId} anchorName is invalid`);
  assert.equal(typeof room.monitored, 'boolean', `room ${room.roomId} monitored is invalid`);
  validateRelativeJsonPath(room.sessionFile, 'sessions/');
  const sessions = readJson(path.join(dataRoot, room.sessionFile));
  assert.equal(sessions.schemaVersion, 1, `room ${room.roomId} sessions schemaVersion must be 1`);
  assert.equal(sessions.roomId, room.roomId, `room ${room.roomId} sessions roomId mismatch`);
  assert.ok(Array.isArray(sessions.sessions), `room ${room.roomId} sessions must be an array`);
  for (const session of sessions.sessions) {
    assert.equal(session.roomId, room.roomId, `room ${room.roomId} session roomId mismatch`);
    assert.ok(Number.isFinite(session.startMs) && Number.isFinite(session.endMs), `room ${room.roomId} session time is invalid`);
    assert.ok(session.startMs <= session.endMs, `room ${room.roomId} session range is invalid`);
    assert.ok(Number.isFinite(session.peakOnline) && session.peakOnline >= 0, `room ${room.roomId} session peak is invalid`);
  }
}

for (const group of manifest.groups) {
  assert.equal(typeof group.id, 'string', 'group id is invalid');
  assert.equal(typeof group.name, 'string', `group ${group.id} name is invalid`);
  assert.ok(Array.isArray(group.rooms), `group ${group.id} rooms must be an array`);
  group.rooms.forEach((roomId) => assert.ok(roomIds.has(roomId), `group ${group.id} references unknown room ${roomId}`));
}

let previousDate = '';
let totalPoints = 0;
for (const dateMeta of manifest.dates) {
  assert.match(dateMeta.date, /^\d{4}-\d{2}-\d{2}$/, `date ${dateMeta.date} is invalid`);
  assert.ok(dateMeta.date > previousDate, 'manifest dates must be unique and ascending');
  previousDate = dateMeta.date;
  validateRelativeJsonPath(dateMeta.file, 'dates/');
  const dateFile = readJson(path.join(dataRoot, dateMeta.file));
  assert.equal(dateFile.schemaVersion, 1, `${dateMeta.date} schemaVersion must be 1`);
  assert.equal(dateFile.date, dateMeta.date, `${dateMeta.date} date mismatch`);
  assert.equal(dateFile.startMs, dateMeta.startMs, `${dateMeta.date} startMs mismatch`);
  assert.equal(dateFile.endMs, dateMeta.endMs, `${dateMeta.date} endMs mismatch`);
  assert.ok(Array.isArray(dateFile.rooms), `${dateMeta.date} rooms must be an array`);
  let datePoints = 0;
  let previousRoomId = '';
  for (const room of dateFile.rooms) {
    assert.ok(roomIds.has(room.roomId), `${dateMeta.date} references unknown room ${room.roomId}`);
    assert.ok(compareRoomIds(previousRoomId, room.roomId) <= 0, `${dateMeta.date} rooms must be sorted`);
    previousRoomId = room.roomId;
    assert.ok(Array.isArray(room.points), `${dateMeta.date}/${room.roomId} points must be an array`);
    let previousOffset = -1;
    for (const point of room.points) {
      assert.ok(Array.isArray(point) && point.length === 2, `${dateMeta.date}/${room.roomId} point is invalid`);
      assert.ok(Number.isFinite(point[0]) && point[0] >= 0, `${dateMeta.date}/${room.roomId} offset is invalid`);
      assert.ok(point[0] >= previousOffset, `${dateMeta.date}/${room.roomId} points must be sorted`);
      assert.ok(dateMeta.startMs + point[0] <= dateMeta.endMs, `${dateMeta.date}/${room.roomId} point exceeds date range`);
      assert.ok(point[1] === null || (Number.isFinite(point[1]) && point[1] >= 0), `${dateMeta.date}/${room.roomId} online is invalid`);
      previousOffset = point[0];
      datePoints += 1;
    }
  }
  assert.equal(datePoints, dateMeta.pointCount, `${dateMeta.date} pointCount mismatch`);
  totalPoints += datePoints;
}

console.log(`History site data valid: ${manifest.rooms.length} rooms, ${manifest.dates.length} dates, ${totalPoints} points.`);

function readJson(filePath) {
  assert.ok(fs.existsSync(filePath), `${path.relative(process.cwd(), filePath)} is missing`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateRelativeJsonPath(value, prefix) {
  assert.equal(typeof value, 'string', 'data file path is invalid');
  assert.ok(value.startsWith(prefix) && value.endsWith('.json'), `data file must stay under ${prefix}`);
  assert.ok(!value.includes('..') && !path.isAbsolute(value), 'data file path must be relative');
}

function compareRoomIds(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}
