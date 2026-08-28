import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const siteRoot = path.resolve(process.argv[2] || 'site');
const sourceRoot = path.join(siteRoot, 'data', 'v1');
const outputRoot = path.join(siteRoot, 'data', 'v2');
const sourceManifest = readJson(path.join(sourceRoot, 'manifest.json'));

assert.equal(sourceManifest.schemaVersion, 1, 'source manifest must use schemaVersion 1');
fs.mkdirSync(path.join(outputRoot, 'dates'), { recursive: true });
fs.mkdirSync(path.join(outputRoot, 'sessions'), { recursive: true });

let totalPoints = 0;
let totalBytes = 0;
let changedFiles = 0;

function writeDataFile(relativeFile, value, pointCount) {
  const content = `${JSON.stringify(value)}\n`;
  const revision = crypto.createHash('sha256').update(content).digest('hex');
  const filePath = path.join(outputRoot, relativeFile);
  const changed = !fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8') !== content;
  if (changed) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
    changedFiles += 1;
  }
  const byteCount = Buffer.byteLength(content, 'utf8');
  totalBytes += byteCount;
  return { file: relativeFile.replace(/\\/g, '/'), revision, byteCount, pointCount };
}

const dates = sourceManifest.dates.map((dateMeta) => {
  const sourceDate = readJson(path.join(sourceRoot, dateMeta.file));
  assert.equal(sourceDate.schemaVersion, 1, `${dateMeta.date} source schema mismatch`);
  const activeRooms = [];
  const idleRooms = [];

  for (const room of sourceDate.rooms) {
    const clone = { roomId: room.roomId, points: room.points };
    if (room.points.some((point) => typeof point[1] === 'number' && point[1] > 0)) {
      const relativeFile = `dates/${dateMeta.date}/active/${room.roomId}.json`;
      const dataFile = { schemaVersion: 2, date: dateMeta.date, roomId: room.roomId, points: room.points };
      activeRooms.push({ roomId: room.roomId, dataFile: writeDataFile(relativeFile, dataFile, room.points.length) });
    } else {
      idleRooms.push(clone);
    }
  }

  const reconstructed = [
    ...activeRooms.map((room) => readJson(path.join(outputRoot, room.dataFile.file))),
    ...idleRooms.map((room) => ({ roomId: room.roomId, points: room.points }))
  ]
    .map((room) => ({ roomId: room.roomId, points: room.points }))
    .sort((left, right) => compareRoomIds(left.roomId, right.roomId));
  assert.deepEqual(reconstructed, sourceDate.rooms, `${dateMeta.date} migration changed raw samples`);

  const idlePointCount = idleRooms.reduce((sum, room) => sum + room.points.length, 0);
  const idleDataFile = idleRooms.length
    ? writeDataFile(
      `dates/${dateMeta.date}/idle.json`,
      { schemaVersion: 2, date: dateMeta.date, rooms: idleRooms },
      idlePointCount
    )
    : null;
  const index = {
    schemaVersion: 2,
    date: dateMeta.date,
    startMs: dateMeta.startMs,
    endMs: dateMeta.endMs,
    activeRooms,
    idleRoomIds: idleRooms.map((room) => room.roomId),
    idleDataFile
  };
  const indexFile = writeDataFile(`dates/${dateMeta.date}/index.json`, index, dateMeta.pointCount);
  totalPoints += dateMeta.pointCount;
  return {
    date: dateMeta.date,
    startMs: dateMeta.startMs,
    endMs: dateMeta.endMs,
    roomIds: dateMeta.roomIds,
    activeRoomIds: activeRooms.map((room) => room.roomId),
    pointCount: dateMeta.pointCount,
    indexFile
  };
});

const rooms = sourceManifest.rooms.map((room) => {
  const sourceSessions = readJson(path.join(sourceRoot, room.sessionFile));
  const relativeFile = `sessions/${room.roomId}.json`;
  const sessions = { ...sourceSessions, schemaVersion: 2 };
  return {
    ...room,
    sessionFile: writeDataFile(relativeFile, sessions, sessions.sessions.length)
  };
});

const manifest = {
  schemaVersion: 2,
  generatedAt: sourceManifest.generatedAt,
  timeZone: sourceManifest.timeZone,
  rooms,
  groups: sourceManifest.groups,
  dates
};
const manifestContent = `${JSON.stringify(manifest)}\n`;
const manifestPath = path.join(outputRoot, 'manifest.json');
const manifestChanged = !fs.existsSync(manifestPath) || fs.readFileSync(manifestPath, 'utf8') !== manifestContent;
if (manifestChanged) {
  const tempPath = `${manifestPath}.tmp`;
  fs.writeFileSync(tempPath, manifestContent, 'utf8');
  fs.renameSync(tempPath, manifestPath);
  changedFiles += 1;
}
totalBytes += Buffer.byteLength(manifestContent, 'utf8');

console.log(
  `Migrated history site data to schema v2: ${rooms.length} rooms, ${dates.length} dates, ` +
  `${totalPoints} points, ${changedFiles} changed files, ${totalBytes} bytes.`
);

function readJson(filePath) {
  assert.ok(fs.existsSync(filePath), `${path.relative(process.cwd(), filePath)} is missing`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function compareRoomIds(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}
