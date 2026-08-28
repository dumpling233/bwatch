import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.argv[2] || 'site');
const dataRoot = path.join(root, 'data', 'v2');
const manifestPath = path.join(dataRoot, 'manifest.json');

assert.ok(fs.existsSync(path.join(root, 'index.html')), 'site/index.html is missing');
assert.ok(fs.existsSync(path.join(root, '.nojekyll')), 'site/.nojekyll is missing');
assert.ok(fs.existsSync(manifestPath), 'site/data/v2/manifest.json is missing');

const manifest = readJson(manifestPath);
assert.equal(manifest.schemaVersion, 2, 'manifest schemaVersion must be 2');
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
  validateFileReference(room.sessionFile, 'sessions/');
  const sessions = readReferencedJson(room.sessionFile);
  assert.equal(sessions.schemaVersion, 2, `room ${room.roomId} sessions schemaVersion must be 2`);
  assert.equal(sessions.roomId, room.roomId, `room ${room.roomId} sessions roomId mismatch`);
  assert.ok(Array.isArray(sessions.sessions), `room ${room.roomId} sessions must be an array`);
  assert.equal(sessions.sessions.length, room.sessionFile.pointCount, `room ${room.roomId} session count mismatch`);
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
  assert.ok(Array.isArray(dateMeta.roomIds), `${dateMeta.date} roomIds must be an array`);
  assert.ok(Array.isArray(dateMeta.activeRoomIds), `${dateMeta.date} activeRoomIds must be an array`);
  validateFileReference(dateMeta.indexFile, `dates/${dateMeta.date}/`);
  const index = readReferencedJson(dateMeta.indexFile);
  assert.equal(index.schemaVersion, 2, `${dateMeta.date} index schemaVersion must be 2`);
  assert.equal(index.date, dateMeta.date, `${dateMeta.date} index date mismatch`);
  assert.equal(index.startMs, dateMeta.startMs, `${dateMeta.date} startMs mismatch`);
  assert.equal(index.endMs, dateMeta.endMs, `${dateMeta.date} endMs mismatch`);
  assert.ok(Array.isArray(index.activeRooms), `${dateMeta.date} activeRooms must be an array`);
  assert.ok(Array.isArray(index.idleRoomIds), `${dateMeta.date} idleRoomIds must be an array`);

  const actualRoomIds = [];
  let datePoints = 0;
  let previousRoomId = '';
  for (const active of index.activeRooms) {
    assert.ok(roomIds.has(active.roomId), `${dateMeta.date} references unknown room ${active.roomId}`);
    assert.ok(compareRoomIds(previousRoomId, active.roomId) <= 0, `${dateMeta.date} active rooms must be sorted`);
    previousRoomId = active.roomId;
    validateFileReference(active.dataFile, `dates/${dateMeta.date}/active/`);
    const roomFile = readReferencedJson(active.dataFile);
    assert.equal(roomFile.schemaVersion, 2, `${dateMeta.date}/${active.roomId} schema mismatch`);
    assert.equal(roomFile.date, dateMeta.date, `${dateMeta.date}/${active.roomId} date mismatch`);
    assert.equal(roomFile.roomId, active.roomId, `${dateMeta.date}/${active.roomId} room mismatch`);
    validatePoints(roomFile.points, dateMeta, active.roomId);
    assert.ok(roomFile.points.some((point) => typeof point[1] === 'number' && point[1] > 0), `${dateMeta.date}/${active.roomId} must be active`);
    assert.equal(roomFile.points.length, active.dataFile.pointCount, `${dateMeta.date}/${active.roomId} pointCount mismatch`);
    actualRoomIds.push(active.roomId);
    datePoints += roomFile.points.length;
  }
  assert.deepEqual(index.activeRooms.map((room) => room.roomId), dateMeta.activeRoomIds, `${dateMeta.date} activeRoomIds mismatch`);

  if (index.idleRoomIds.length > 0) {
    assert.ok(index.idleDataFile, `${dateMeta.date} idle data reference is missing`);
    validateFileReference(index.idleDataFile, `dates/${dateMeta.date}/`);
    const idleFile = readReferencedJson(index.idleDataFile);
    assert.equal(idleFile.schemaVersion, 2, `${dateMeta.date} idle schema mismatch`);
    assert.equal(idleFile.date, dateMeta.date, `${dateMeta.date} idle date mismatch`);
    assert.ok(Array.isArray(idleFile.rooms), `${dateMeta.date} idle rooms must be an array`);
    assert.deepEqual(idleFile.rooms.map((room) => room.roomId), index.idleRoomIds, `${dateMeta.date} idleRoomIds mismatch`);
    let idlePoints = 0;
    for (const room of idleFile.rooms) {
      assert.ok(roomIds.has(room.roomId), `${dateMeta.date} idle references unknown room ${room.roomId}`);
      validatePoints(room.points, dateMeta, room.roomId);
      assert.ok(!room.points.some((point) => typeof point[1] === 'number' && point[1] > 0), `${dateMeta.date}/${room.roomId} must be idle`);
      actualRoomIds.push(room.roomId);
      idlePoints += room.points.length;
    }
    assert.equal(idlePoints, index.idleDataFile.pointCount, `${dateMeta.date} idle pointCount mismatch`);
    datePoints += idlePoints;
  } else {
    assert.equal(index.idleDataFile, null, `${dateMeta.date} idleDataFile must be null`);
  }

  actualRoomIds.sort(compareRoomIds);
  assert.deepEqual(actualRoomIds, [...dateMeta.roomIds].sort(compareRoomIds), `${dateMeta.date} roomIds mismatch`);
  assert.equal(datePoints, dateMeta.pointCount, `${dateMeta.date} pointCount mismatch`);
  assert.equal(datePoints, dateMeta.indexFile.pointCount, `${dateMeta.date} index pointCount mismatch`);
  totalPoints += datePoints;
}

console.log(`History site data valid: ${manifest.rooms.length} rooms, ${manifest.dates.length} dates, ${totalPoints} points.`);

function readJson(filePath) {
  assert.ok(fs.existsSync(filePath), `${path.relative(process.cwd(), filePath)} is missing`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readReferencedJson(reference) {
  const filePath = path.join(dataRoot, reference.file);
  assert.ok(fs.existsSync(filePath), `${path.relative(process.cwd(), filePath)} is missing`);
  const content = fs.readFileSync(filePath);
  assert.equal(content.byteLength, reference.byteCount, `${reference.file} byteCount mismatch`);
  assert.equal(crypto.createHash('sha256').update(content).digest('hex'), reference.revision, `${reference.file} revision mismatch`);
  return JSON.parse(content.toString('utf8'));
}

function validateFileReference(reference, prefix) {
  assert.ok(reference && typeof reference === 'object', 'data file reference is invalid');
  assert.equal(typeof reference.file, 'string', 'data file path is invalid');
  assert.ok(reference.file.startsWith(prefix) && reference.file.endsWith('.json'), `data file must stay under ${prefix}`);
  assert.ok(!reference.file.includes('..') && !path.isAbsolute(reference.file), 'data file path must be relative');
  assert.match(reference.revision, /^[a-f0-9]{64}$/, `${reference.file} revision is invalid`);
  assert.ok(Number.isInteger(reference.byteCount) && reference.byteCount > 0, `${reference.file} byteCount is invalid`);
  assert.ok(Number.isInteger(reference.pointCount) && reference.pointCount >= 0, `${reference.file} pointCount is invalid`);
}

function validatePoints(points, dateMeta, roomId) {
  assert.ok(Array.isArray(points), `${dateMeta.date}/${roomId} points must be an array`);
  let previousOffset = -1;
  for (const point of points) {
    assert.ok(Array.isArray(point) && point.length === 2, `${dateMeta.date}/${roomId} point is invalid`);
    assert.ok(Number.isFinite(point[0]) && point[0] >= 0, `${dateMeta.date}/${roomId} offset is invalid`);
    assert.ok(point[0] >= previousOffset, `${dateMeta.date}/${roomId} points must be sorted`);
    assert.ok(dateMeta.startMs + point[0] <= dateMeta.endMs, `${dateMeta.date}/${roomId} point exceeds date range`);
    assert.ok(point[1] === null || (Number.isFinite(point[1]) && point[1] >= 0), `${dateMeta.date}/${roomId} online is invalid`);
    previousOffset = point[0];
  }
}

function compareRoomIds(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}
