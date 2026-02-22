SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS inbound_order_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  inbound_order_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(40) NOT NULL,
  from_status VARCHAR(30) NULL,
  to_status VARCHAR(30) NULL,
  note VARCHAR(1000) NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inbound_order_logs_order_created (inbound_order_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS outbound_order_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  outbound_order_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(40) NOT NULL,
  from_status VARCHAR(30) NULL,
  to_status VARCHAR(30) NULL,
  note VARCHAR(1000) NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_outbound_order_logs_order_created (outbound_order_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
