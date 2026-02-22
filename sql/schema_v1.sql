SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- =============================================
-- 3PL WMS & Settlement v1 Schema (MySQL)
-- Engine: InnoDB
-- Charset: utf8mb4
-- Soft delete: deleted_at on all tables
-- =============================================

CREATE TABLE clients (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_code VARCHAR(50) NOT NULL,
  name_kr VARCHAR(255) NOT NULL,
  name_en VARCHAR(255) NULL,
  contact_name VARCHAR(100) NULL,
  phone VARCHAR(50) NULL,
  email VARCHAR(255) NULL,
  address VARCHAR(500) NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_clients_code (client_code),
  KEY idx_clients_status_deleted (status, deleted_at),
  KEY idx_clients_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id BIGINT UNSIGNED NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  role ENUM('admin','warehouse','manager','client_viewer') NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role_deleted (role, deleted_at),
  KEY idx_users_client_deleted (client_id, deleted_at),
  CONSTRAINT fk_users_client FOREIGN KEY (client_id) REFERENCES clients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE warehouses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  country VARCHAR(100) NOT NULL,
  timezone VARCHAR(100) NOT NULL DEFAULT 'Asia/Bangkok',
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_warehouses_code (code),
  KEY idx_warehouses_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE warehouse_locations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  location_code VARCHAR(100) NOT NULL,
  zone VARCHAR(100) NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_location_wh_code (warehouse_id, location_code),
  KEY idx_locations_deleted (deleted_at),
  CONSTRAINT fk_locations_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id BIGINT UNSIGNED NOT NULL,
  sku_code VARCHAR(100) NULL,
  barcode_raw VARCHAR(120) NOT NULL,
  barcode_full VARCHAR(180) NOT NULL,
  name_kr VARCHAR(255) NOT NULL,
  name_en VARCHAR(255) NULL,
  volume_ml INT UNSIGNED NULL,
  unit VARCHAR(30) NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_client_barcode_raw (client_id, barcode_raw),
  UNIQUE KEY uq_products_barcode_full (barcode_full),
  KEY idx_products_client_deleted (client_id, deleted_at),
  KEY idx_products_deleted (deleted_at),
  CONSTRAINT fk_products_client FOREIGN KEY (client_id) REFERENCES clients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE product_lots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  lot_no VARCHAR(120) NOT NULL,
  expiry_date DATE NULL,
  mfg_date DATE NULL,
  status ENUM('active','hold','expired','inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lots_product_lot (product_id, lot_no),
  KEY idx_lots_expiry_deleted (expiry_date, deleted_at),
  KEY idx_lots_deleted (deleted_at),
  CONSTRAINT fk_lots_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE service_catalog (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_code VARCHAR(80) NOT NULL,
  service_name_kr VARCHAR(255) NOT NULL,
  billing_basis ENUM('QTY','BOX','ORDER','MANUAL') NOT NULL,
  default_currency ENUM('KRW','THB') NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_code (service_code),
  KEY idx_service_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE price_policies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id BIGINT UNSIGNED NOT NULL,
  service_id BIGINT UNSIGNED NOT NULL,
  unit_price DECIMAL(18,4) NOT NULL,
  currency ENUM('KRW','THB') NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_price_policy (client_id, service_id, effective_from),
  KEY idx_price_policy_lookup (client_id, service_id, effective_from, effective_to, deleted_at),
  CONSTRAINT fk_price_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_price_service FOREIGN KEY (service_id) REFERENCES service_catalog(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE inbound_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  inbound_no VARCHAR(80) NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  inbound_date DATE NOT NULL,
  status ENUM('draft','submitted','arrived','qc_hold','received','cancelled') NOT NULL DEFAULT 'draft',
  memo VARCHAR(1000) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  received_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inbound_no (inbound_no),
  KEY idx_inbound_status_date_deleted (status, inbound_date, deleted_at),
  KEY idx_inbound_client_date_deleted (client_id, inbound_date, deleted_at),
  CONSTRAINT fk_inbound_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_inbound_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_inbound_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE inbound_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  inbound_order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  lot_id BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NULL,
  qty INT UNSIGNED NOT NULL,
  invoice_price DECIMAL(18,4) NULL,
  currency ENUM('KRW','THB') NULL,
  remark VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_inbound_items_order_deleted (inbound_order_id, deleted_at),
  KEY idx_inbound_items_product_lot_deleted (product_id, lot_id, deleted_at),
  CONSTRAINT fk_inbound_item_order FOREIGN KEY (inbound_order_id) REFERENCES inbound_orders(id),
  CONSTRAINT fk_inbound_item_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_inbound_item_lot FOREIGN KEY (lot_id) REFERENCES product_lots(id),
  CONSTRAINT fk_inbound_item_location FOREIGN KEY (location_id) REFERENCES warehouse_locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE outbound_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  outbound_no VARCHAR(80) NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  order_date DATE NOT NULL,
  sales_channel VARCHAR(80) NULL,
  order_no VARCHAR(120) NULL,
  tracking_no VARCHAR(120) NULL,
  status ENUM('draft','confirmed','allocated','picking','packed','shipped','delivered','cancelled') NOT NULL DEFAULT 'draft',
  packed_at DATETIME NULL,
  shipped_at DATETIME NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_outbound_no (outbound_no),
  KEY idx_outbound_client_date_deleted (client_id, order_date, deleted_at),
  KEY idx_outbound_status_shipped_deleted (status, shipped_at, deleted_at),
  KEY idx_outbound_order_no_deleted (order_no, deleted_at),
  CONSTRAINT fk_outbound_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_outbound_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_outbound_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE outbound_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  outbound_order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  lot_id BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NULL,
  qty INT UNSIGNED NOT NULL,
  box_type VARCHAR(80) NULL,
  box_count INT UNSIGNED NOT NULL DEFAULT 0,
  remark VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_outbound_items_order_deleted (outbound_order_id, deleted_at),
  KEY idx_outbound_items_product_lot_deleted (product_id, lot_id, deleted_at),
  CONSTRAINT fk_outbound_item_order FOREIGN KEY (outbound_order_id) REFERENCES outbound_orders(id),
  CONSTRAINT fk_outbound_item_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_outbound_item_lot FOREIGN KEY (lot_id) REFERENCES product_lots(id),
  CONSTRAINT fk_outbound_item_location FOREIGN KEY (location_id) REFERENCES warehouse_locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE return_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_no VARCHAR(80) NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  related_outbound_order_id BIGINT UNSIGNED NULL,
  return_date DATE NOT NULL,
  status ENUM('draft','received','inspected','restocked','disposed','closed','cancelled') NOT NULL DEFAULT 'draft',
  reason VARCHAR(1000) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_return_no (return_no),
  KEY idx_return_client_date_deleted (client_id, return_date, deleted_at),
  KEY idx_return_status_deleted (status, deleted_at),
  CONSTRAINT fk_return_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_return_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_return_outbound FOREIGN KEY (related_outbound_order_id) REFERENCES outbound_orders(id),
  CONSTRAINT fk_return_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE return_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  lot_id BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NULL,
  qty_received INT UNSIGNED NOT NULL,
  qty_restocked INT UNSIGNED NOT NULL DEFAULT 0,
  qty_disposed INT UNSIGNED NOT NULL DEFAULT 0,
  disposition_reason VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_return_items_order_deleted (return_order_id, deleted_at),
  KEY idx_return_items_product_lot_deleted (product_id, lot_id, deleted_at),
  CONSTRAINT fk_return_item_order FOREIGN KEY (return_order_id) REFERENCES return_orders(id),
  CONSTRAINT fk_return_item_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_return_item_lot FOREIGN KEY (lot_id) REFERENCES product_lots(id),
  CONSTRAINT fk_return_item_location FOREIGN KEY (location_id) REFERENCES warehouse_locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE stock_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  lot_id BIGINT UNSIGNED NOT NULL,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NULL,
  from_location_id BIGINT UNSIGNED NULL,
  to_location_id BIGINT UNSIGNED NULL,
  txn_type ENUM('inbound_receive','outbound_ship','return_restock','return_dispose','adjustment','move_location') NOT NULL,
  txn_date DATETIME NOT NULL,
  qty_in INT UNSIGNED NOT NULL DEFAULT 0,
  qty_out INT UNSIGNED NOT NULL DEFAULT 0,
  ref_type ENUM('inbound_item','outbound_item','return_item','manual_adjustment','location_move') NOT NULL,
  ref_id BIGINT UNSIGNED NOT NULL,
  note VARCHAR(1000) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stock_txn_ref (txn_type, ref_type, ref_id),
  KEY idx_stock_txn_product_lot_date_deleted (product_id, lot_id, txn_date, deleted_at),
  KEY idx_stock_txn_client_type_date_deleted (client_id, txn_type, txn_date, deleted_at),
  KEY idx_stock_txn_ship_ref_deleted (ref_type, ref_id, txn_type, deleted_at),
  CONSTRAINT fk_stock_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_stock_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_stock_lot FOREIGN KEY (lot_id) REFERENCES product_lots(id),
  CONSTRAINT fk_stock_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_stock_location FOREIGN KEY (location_id) REFERENCES warehouse_locations(id),
  CONSTRAINT fk_stock_from_location FOREIGN KEY (from_location_id) REFERENCES warehouse_locations(id),
  CONSTRAINT fk_stock_to_location FOREIGN KEY (to_location_id) REFERENCES warehouse_locations(id),
  CONSTRAINT fk_stock_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE stock_balances (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  lot_id BIGINT UNSIGNED NOT NULL,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NULL,
  available_qty INT NOT NULL DEFAULT 0,
  reserved_qty INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stock_balance_key (client_id, product_id, lot_id, warehouse_id, location_id),
  KEY idx_stock_balance_client_deleted (client_id, deleted_at),
  KEY idx_stock_balance_product_lot_deleted (product_id, lot_id, deleted_at),
  CONSTRAINT fk_balance_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_balance_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_balance_lot FOREIGN KEY (lot_id) REFERENCES product_lots(id),
  CONSTRAINT fk_balance_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_balance_location FOREIGN KEY (location_id) REFERENCES warehouse_locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE storage_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  snapshot_date DATE NOT NULL,
  total_cbm DECIMAL(18,4) NOT NULL DEFAULT 0,
  total_pallet DECIMAL(18,4) NOT NULL DEFAULT 0,
  total_sku INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_storage_snapshot_wh_client_date (warehouse_id, client_id, snapshot_date),
  KEY idx_storage_snapshot_date (snapshot_date),
  KEY idx_storage_snapshot_wh_date (warehouse_id, snapshot_date),
  KEY idx_storage_snapshot_client_date (client_id, snapshot_date),
  CONSTRAINT fk_storage_snapshot_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_storage_snapshot_client FOREIGN KEY (client_id) REFERENCES clients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE service_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id BIGINT UNSIGNED NOT NULL,
  service_id BIGINT UNSIGNED NOT NULL,
  outbound_order_id BIGINT UNSIGNED NULL,
  stock_transaction_id BIGINT UNSIGNED NULL,
  event_date DATETIME NOT NULL,
  source_type ENUM('outbound_shipped','location_move','manual') NOT NULL,
  basis_applied ENUM('QTY','BOX','ORDER','MANUAL') NOT NULL,
  qty INT UNSIGNED NOT NULL DEFAULT 0,
  box_count INT UNSIGNED NOT NULL DEFAULT 0,
  unit_price DECIMAL(18,4) NULL,
  amount DECIMAL(18,4) NULL,
  currency ENUM('KRW','THB') NULL,
  remark VARCHAR(1000) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_service_event_client_date_deleted (client_id, event_date, deleted_at),
  KEY idx_service_event_source_deleted (source_type, event_date, deleted_at),
  CONSTRAINT fk_service_event_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_service_event_service FOREIGN KEY (service_id) REFERENCES service_catalog(id),
  CONSTRAINT fk_service_event_outbound FOREIGN KEY (outbound_order_id) REFERENCES outbound_orders(id),
  CONSTRAINT fk_service_event_stock_txn FOREIGN KEY (stock_transaction_id) REFERENCES stock_transactions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE files (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  file_key VARCHAR(255) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  uploaded_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_file_key (file_key),
  KEY idx_files_deleted (deleted_at),
  CONSTRAINT fk_files_user FOREIGN KEY (uploaded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE exchange_rates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  base_currency ENUM('KRW','THB') NOT NULL,
  quote_currency ENUM('KRW','THB') NOT NULL,
  rate DECIMAL(18,6) NOT NULL,
  rate_date DATE NOT NULL,
  status ENUM('draft','active','superseded') NOT NULL DEFAULT 'draft',
  entered_by BIGINT UNSIGNED NOT NULL,
  activated_by BIGINT UNSIGNED NULL,
  activated_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fx_pair_date (base_currency, quote_currency, rate_date),
  KEY idx_fx_status_date_deleted (status, rate_date, deleted_at),
  CONSTRAINT fk_fx_entered_by FOREIGN KEY (entered_by) REFERENCES users(id),
  CONSTRAINT fk_fx_activated_by FOREIGN KEY (activated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE exchange_rate_attachments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  exchange_rate_id BIGINT UNSIGNED NOT NULL,
  file_id BIGINT UNSIGNED NOT NULL,
  note VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fx_attachment (exchange_rate_id, file_id),
  KEY idx_fx_attachment_rate_deleted (exchange_rate_id, deleted_at),
  CONSTRAINT fk_fx_att_rate FOREIGN KEY (exchange_rate_id) REFERENCES exchange_rates(id),
  CONSTRAINT fk_fx_att_file FOREIGN KEY (file_id) REFERENCES files(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE settlement_batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id BIGINT UNSIGNED NOT NULL,
  billing_month CHAR(7) NOT NULL,
  exchange_rate_id BIGINT UNSIGNED NOT NULL,
  status ENUM('open','calculating','reviewed','closed') NOT NULL DEFAULT 'open',
  is_provisional TINYINT(1) NOT NULL DEFAULT 1,
  krw_subtotal DECIMAL(18,4) NOT NULL DEFAULT 0,
  thb_subtotal DECIMAL(18,4) NOT NULL DEFAULT 0,
  total_krw DECIMAL(18,4) NOT NULL DEFAULT 0,
  closed_at DATETIME NULL,
  closed_by BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_settlement_client_month (client_id, billing_month),
  KEY idx_settlement_status_month_deleted (status, billing_month, deleted_at),
  CONSTRAINT fk_settle_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_settle_fx FOREIGN KEY (exchange_rate_id) REFERENCES exchange_rates(id),
  CONSTRAINT fk_settle_closed_by FOREIGN KEY (closed_by) REFERENCES users(id),
  CONSTRAINT fk_settle_created_by FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE settlement_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  settlement_batch_id BIGINT UNSIGNED NOT NULL,
  service_id BIGINT UNSIGNED NULL,
  line_type ENUM('service','manual_expense') NOT NULL,
  description VARCHAR(255) NOT NULL,
  basis ENUM('QTY','BOX','ORDER','MANUAL') NOT NULL,
  qty INT UNSIGNED NOT NULL DEFAULT 0,
  unit_price DECIMAL(18,4) NOT NULL DEFAULT 0,
  currency ENUM('KRW','THB') NOT NULL,
  amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  extra_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  total_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  source_service_event_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_settlement_lines_batch_deleted (settlement_batch_id, deleted_at),
  KEY idx_settlement_lines_type_deleted (line_type, deleted_at),
  CONSTRAINT fk_settle_line_batch FOREIGN KEY (settlement_batch_id) REFERENCES settlement_batches(id),
  CONSTRAINT fk_settle_line_service FOREIGN KEY (service_id) REFERENCES service_catalog(id),
  CONSTRAINT fk_settle_line_service_event FOREIGN KEY (source_service_event_id) REFERENCES service_events(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE settlement_reopen_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  settlement_batch_id BIGINT UNSIGNED NOT NULL,
  requested_by BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(2000) NOT NULL,
  status ENUM('requested','approved','rejected') NOT NULL DEFAULT 'requested',
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_reopen_req_batch_status_deleted (settlement_batch_id, status, deleted_at),
  CONSTRAINT fk_reopen_req_batch FOREIGN KEY (settlement_batch_id) REFERENCES settlement_batches(id),
  CONSTRAINT fk_reopen_req_user FOREIGN KEY (requested_by) REFERENCES users(id),
  CONSTRAINT fk_reopen_req_approved_by FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE settlement_reopen_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  settlement_batch_id BIGINT UNSIGNED NOT NULL,
  request_id BIGINT UNSIGNED NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  action ENUM('close','reopen') NOT NULL,
  reason VARCHAR(2000) NULL,
  acted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_reopen_logs_batch_acted_deleted (settlement_batch_id, acted_at, deleted_at),
  CONSTRAINT fk_reopen_log_batch FOREIGN KEY (settlement_batch_id) REFERENCES settlement_batches(id),
  CONSTRAINT fk_reopen_log_request FOREIGN KEY (request_id) REFERENCES settlement_reopen_requests(id),
  CONSTRAINT fk_reopen_log_actor FOREIGN KEY (actor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE invoice_sequences (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id BIGINT UNSIGNED NOT NULL,
  yyyymm CHAR(6) NOT NULL,
  last_seq INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoice_seq_client_month (client_id, yyyymm),
  CONSTRAINT fk_invoice_seq_client FOREIGN KEY (client_id) REFERENCES clients(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE invoices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  settlement_batch_id BIGINT UNSIGNED NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  invoice_no VARCHAR(80) NOT NULL,
  status ENUM('draft','issued','sent','partially_paid','paid','void') NOT NULL DEFAULT 'draft',
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  recipient_email VARCHAR(255) NULL,
  currency ENUM('KRW','THB') NOT NULL,
  total_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  sent_at DATETIME NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoice_no (invoice_no),
  UNIQUE KEY uq_invoice_settlement_1to1 (settlement_batch_id),
  KEY idx_invoice_client_status_deleted (client_id, status, deleted_at),
  CONSTRAINT fk_invoice_settlement FOREIGN KEY (settlement_batch_id) REFERENCES settlement_batches(id),
  CONSTRAINT fk_invoice_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_invoice_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE invoice_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id BIGINT UNSIGNED NOT NULL,
  settlement_line_id BIGINT UNSIGNED NULL,
  service_id BIGINT UNSIGNED NULL,
  line_type ENUM('service','manual_expense') NOT NULL,
  description VARCHAR(255) NOT NULL,
  qty INT UNSIGNED NOT NULL DEFAULT 0,
  unit VARCHAR(30) NULL,
  currency ENUM('KRW','THB') NOT NULL,
  unit_price DECIMAL(18,4) NOT NULL DEFAULT 0,
  amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  extra_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  total_amount DECIMAL(18,4) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_invoice_lines_invoice_deleted (invoice_id, deleted_at),
  CONSTRAINT fk_invoice_line_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  CONSTRAINT fk_invoice_line_settlement_line FOREIGN KEY (settlement_line_id) REFERENCES settlement_lines(id),
  CONSTRAINT fk_invoice_line_service FOREIGN KEY (service_id) REFERENCES service_catalog(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
