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

/* Every folder the file list implies, parents first.

   The archive carried only file entries, with their folders implied by
   the slashes in "server/index.js". Most tools rebuild the tree from
   that, which is why the zip extracted correctly everywhere it was
   tested — but a stricter reader walks the entries expecting a record
   for each directory, and without them sees a flat pile of files
   rather than a project. Hostinger's deployment scanner rejected the
   upload as an "invalid project structure".

   A directory record is an ordinary entry whose name ends in "/", with
   no data. Cheap to add and what a conventional zip contains. */
function directoriesFor(files) {
  const seen = new Set();
  for (const f of files) {
    const parts = f.name.split('/');
    parts.pop();                       /* drop the file itself */
    let acc = '';
    for (const p of parts) {
      acc += p + '/';
      seen.add(acc);
    }
  }
  /* Shortest first, so a parent is always written before its child. */
  return [...seen].sort((a, b) => a.length - b.length);
}

function writeZip(root, outPath, accept) {
  const files = collect(root, accept);
  const chunks = [];
  const central = [];
  let offset = 0;

  /* Folders first, then the files, which is the order an extractor
     expects to meet them in. */
  const entries = [
    ...directoriesFor(files).map(name => ({ name, dir: true })),
    ...files
  ];

  for (const f of entries) {
    const data = f.dir ? Buffer.alloc(0) : fs.readFileSync(f.full);
    const crc = f.dir ? 0 : crc32(data);
    const deflated = f.dir ? data : zlib.deflateRawSync(data, { level: 9 });
    /* Store when deflating does not help — already-compressed media.
       A directory has no data, so it is always stored. */
    const useDeflate = !f.dir && deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const nameBuf = Buffer.from(f.name, 'utf8');   /* forward slashes */
    const { time, date } = dosTime(f.dir ? new Date() : fs.statSync(f.full).mtime);

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
    /* Unix mode in the high word. Shifting left by 16 overflows into a
       negative signed int, so multiply instead.

       A directory carries 0o40755 and the MS-DOS directory bit (0x10)
       in the low byte: a reader that ignores the unix word still has
       to be told this entry is a folder. */
    cen.writeUInt32LE(f.dir
      ? 0o040755 * 0x10000 + 0x10
      : 0o100644 * 0x10000, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  /* Every record, folders included — a count that disagrees with the
     central directory makes the whole archive unreadable. */
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(outPath, Buffer.concat([...chunks, centralBuf, end]));
  return { files: files.length, bytes: fs.statSync(outPath).size };
}

module.exports = { writeZip };
