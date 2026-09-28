/* ------------------------------------------------------------------
   The .sql files were written against a local database called
   reddy_finances, so they carry CREATE DATABASE / USE statements and
   name that schema inside INFORMATION_SCHEMA lookups.

   A managed host names the database for you (u807314952_reddy) and
   forbids creating one, so those references have to go: the connection
   already points at the right database, and DATABASE() resolves to it.
------------------------------------------------------------------- */

function stripDbStatements(sql) {
  return sql
    .replace(/CREATE\s+DATABASE[^;]*;/gi, '')
    .replace(/\bUSE\s+[A-Za-z0-9_`]+\s*;/gi, '')
    .replace(/TABLE_SCHEMA\s*=\s*'reddy_finances'/gi, 'TABLE_SCHEMA = DATABASE()');
}

module.exports = { stripDbStatements };

/* schema.sql ends with views that read columns the later migrations add.
   On a fresh database those columns do not exist yet, so the views have
   to be created after everything else. Returns the file split in two. */
function splitOffViews(sql) {
  const cut = sql.search(/CREATE\s+(OR\s+REPLACE\s+)?VIEW/i);
  if (cut === -1) return { body: sql, views: '' };
  return { body: sql.slice(0, cut), views: sql.slice(cut) };
}

module.exports.splitOffViews = splitOffViews;
