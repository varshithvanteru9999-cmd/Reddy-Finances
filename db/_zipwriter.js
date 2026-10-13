/* A minimal ZIP writer that produces spec-compliant archives.
   ------------------------------------------------------------------
   PowerShell's CreateFromDirectory writes entry names with Windows
   backslashes — "css\style.css" instead of "css/style.css". The ZIP
   spec (APPNOTE 4.4.17.1) requires forward slashes, and a Linux
   extractor reading a backslash name either creates one weirdly-named
   file or refuses the archive. Hostinger refused it: "Something went
   wrong", at any size.

   This writes the entries itself, so the separator is always "/".
   Deflate comes from zlib, which Node ships.
------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* MS-DOS date/time, which is what the format stores. */
function dosTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) |
               ((Math.floor(d.getSeconds() / 2)) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) |
               (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/* Collect every file under `root`, as { name, full } with POSIX names. */
function collect(root, accept) {
  const out = [];
  (function walk(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const name = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (accept && !accept.dir(name)) continue;
        walk(full, name);
      } else if (entry.isFile()) {
        if (accept && !accept.file(name)) continue;
        out.push({ name, full });
      }
    }
  })(root, '');
  return out;
}

function writeZip(root, outPath, accept) {
  const files = collect(root, accept);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = fs.readFileSync(f.full);
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    /* Store when deflating does not help — already-compressed media. */
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const nameBuf = Buffer.from(f.name, 'utf8');   /* forward slashes */
    const { time, date } = dosTime(fs.statSync(f.full).mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            /* version needed */
    local.writeUInt16LE(0x0800, 6);        /* UTF-8 names */
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(0x031e, 4);          /* made by: unix */
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);              /* extra */
    cen.writeUInt16LE(0, 32);              /* comment */
    cen.writeUInt16LE(0, 34);              /* disk */
    cen.writeUInt16LE(0, 36);              /* internal attrs */
    /* Unix mode 0644 in the high word. Shifting left by 16 overflows
       into a negative signed int, so multiply instead. */
    cen.writeUInt32LE(0o100644 * 0x10000, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(outPath, Buffer.concat([...chunks, centralBuf, end]));
  return { files: files.length, bytes: fs.statSync(outPath).size };
}

module.exports = { writeZip };
