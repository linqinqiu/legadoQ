import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isBundledUiStale } from './bootstrap.mjs';

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content);
    const encoded = Buffer.from(name);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(encoded.length, 26);
    locals.push(local, encoded, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(encoded.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, encoded);
    offset += local.length + encoded.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'legado-static-ui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, 'web', 'dist');
  const libs = path.join(root, 'app', 'build', 'libs');
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  mkdirSync(libs, { recursive: true });
  writeFileSync(path.join(root, 'web', 'package.json'), '{}');
  const files = {
    'index.html': '<script src="/assets/index-abc.js"></script><link rel="stylesheet" href="/assets/index-abc.css">',
    'assets/index-abc.js': 'console.log("current")',
    'assets/index-abc.css': 'body{color:red}',
    'sw.js': 'self.addEventListener("install",()=>{})',
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dist, name), content);
  const jar = path.join(libs, 'legado-1.2.3-all.jar');
  const writeJar = (overrides = {}) => writeFileSync(jar, storedZip(
    Object.entries({ ...files, ...overrides }).map(([name, content]) => [`static/${name}`, content]),
  ));
  writeJar();
  return { root, dist, libs, jar, files, writeJar };
}

test('bundled UI freshness compares every static file, not only the main bundle', (t) => {
  const { root, dist, libs, jar, writeJar } = fixture(t);
  assert.equal(isBundledUiStale(root, path.basename(jar), libs).stale, false);
  writeFileSync(path.join(dist, 'assets', 'index-abc.css'), 'body{color:blue}');
  const result = isBundledUiStale(root, path.basename(jar), libs);
  assert.equal(result.stale, true);
  assert.deepEqual(result.differences.changed, ['assets/index-abc.css']);
});

test('missing or unreadable jar UI fails closed', (t) => {
  const { root, libs, jar } = fixture(t);
  const entries = storedZip([
    ['static/index.html', '<script src="/assets/index-abc.js"></script>'],
    ['static/assets/index-abc.js', 'console.log("current")'],
  ]);
  writeFileSync(jar, entries);
  const missing = isBundledUiStale(root, path.basename(jar), libs);
  assert.equal(missing.stale, true);
  assert.ok(missing.differences.missing.includes('sw.js'));

  writeFileSync(jar, 'not a zip');
  const unreadable = isBundledUiStale(root, path.basename(jar), libs);
  assert.equal(unreadable.stale, true);
  assert.ok(unreadable.differences.missing.length > 0);
});

test('source checkout without dist is stale while jar-only deployment remains launchable', (t) => {
  const { root, dist, libs, jar } = fixture(t);
  rmSync(dist, { recursive: true });
  assert.equal(isBundledUiStale(root, path.basename(jar), libs).stale, true);
  rmSync(path.join(root, 'web', 'package.json'));
  assert.equal(isBundledUiStale(root, path.basename(jar), libs).stale, false);
});
