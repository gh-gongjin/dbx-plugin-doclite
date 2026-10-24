import fs from "node:fs";
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/**
 * Writes a plain ZIP archive with forward-slash entry names.
 * Entries are `{ name, path }` or `{ name, data }`; order is preserved.
 * Dates are fixed so repeated builds of identical input stay byte-identical.
 */
export function createZip(outPath, entries, options = {}) {
  const when = options.date || new Date(Date.UTC(2026, 9, 22));
  const stamp = dosDateTime(when);
  const handle = fs.openSync(outPath, "w");
  const central = [];
  let offset = 0;

  const write = (buffer) => {
    fs.writeSync(handle, buffer, 0, buffer.length);
    offset += buffer.length;
  };

  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
      const data = entry.data !== undefined ? Buffer.from(entry.data) : fs.readFileSync(entry.path);
      const compressed = zlib.deflateRawSync(data, { level: 9 });
      const useDeflate = compressed.length < data.length;
      const payload = useDeflate ? compressed : data;
      const method = useDeflate ? 8 : 0;
      const checksum = crc32(data);
      const localOffset = offset;

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0800, 6);
      header.writeUInt16LE(method, 8);
      header.writeUInt16LE(stamp.time, 10);
      header.writeUInt16LE(stamp.date, 12);
      header.writeUInt32LE(checksum, 14);
      header.writeUInt32LE(payload.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(name.length, 26);
      header.writeUInt16LE(0, 28);
      write(header);
      write(name);
      write(payload);

      central.push({ name, method, checksum, compressedSize: payload.length, size: data.length, localOffset });
    }

    const centralStart = offset;
    for (const entry of central) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(0x031e, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(stamp.time, 12);
      header.writeUInt16LE(stamp.date, 14);
      header.writeUInt32LE(entry.checksum, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.localOffset, 42);
      write(header);
      write(entry.name);
    }
    const centralSize = offset - centralStart;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    write(end);
  } finally {
    fs.closeSync(handle);
  }
}

export function listFiles(root, options = {}) {
  const ignore = options.ignore || (() => false);
  const result = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = `${directory}/${entry.name}`;
      const relative = absolute.slice(root.length + 1);
      if (ignore(relative, entry)) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) result.push({ absolute, relative });
    }
  };
  walk(root);
  result.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0));
  return result;
}
