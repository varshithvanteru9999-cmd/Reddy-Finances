-- ------------------------------------------------------------------
-- auth_sessions — server-side session registry.
--
-- The signed cookie proved who someone was but could not be withdrawn:
-- logging out only cleared the browser's copy, so a stolen cookie stayed
-- good for its full 30 days, and changing the admin password did not
-- disturb sessions already in the wild. A stateless cookie has no way
-- to express "no longer valid" — that needs server-side state.
--
-- One row per live sign-in. The cookie carries only the opaque `sid`;
-- everything else (email, when it was created, where from) stays here.
-- Deleting or expiring the row is what actually ends the session.
--
-- Safe to re-run.
-- ------------------------------------------------------------------

USE reddy_finances;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id           CHAR(64)     NOT NULL COMMENT 'opaque session id (sha256 hex), stored in the cookie',
  user_id      VARCHAR(128) NOT NULL DEFAULT '' COMMENT 'Firebase uid, or "admin" for password login',
  email        VARCHAR(190) NOT NULL DEFAULT '',
  admin        TINYINT(1)   NOT NULL DEFAULT 0 COMMENT 'cached admin flag, so a revoked admin row loses it too',
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME     NOT NULL,
  revoked_at   DATETIME     NULL COMMENT 'set on sign-out or "sign out everywhere"',
  ip           VARCHAR(64)  NULL,
  user_agent   VARCHAR(255) NULL,

  PRIMARY KEY (id),
  KEY ix_sessions_email (email, revoked_at),
  KEY ix_sessions_expiry (expires_at)
) ENGINE=InnoDB;
