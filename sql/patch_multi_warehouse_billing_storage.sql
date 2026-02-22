SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- clients.default_warehouse_id (optional fallback for billing events)
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'clients' AND column_name = 'default_warehouse_id') = 0,
  'ALTER TABLE clients ADD COLUMN default_warehouse_id BIGINT UNSIGNED NULL AFTER id',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'clients' AND index_name = 'idx_clients_default_warehouse') = 0,
  'ALTER TABLE clients ADD KEY idx_clients_default_warehouse (default_warehouse_id)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.key_column_usage
   WHERE table_schema = DATABASE()
     AND table_name = 'clients'
     AND constraint_name = 'fk_clients_default_warehouse') = 0,
  'ALTER TABLE clients ADD CONSTRAINT fk_clients_default_warehouse FOREIGN KEY (default_warehouse_id) REFERENCES warehouses(id)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- warehouses capacity columns for capacity monitoring
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'warehouses' AND column_name = 'capacity_cbm') = 0,
  'ALTER TABLE warehouses ADD COLUMN capacity_cbm DECIMAL(18,4) NULL AFTER timezone',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'warehouses' AND column_name = 'capacity_pallet') = 0,
  'ALTER TABLE warehouses ADD COLUMN capacity_pallet DECIMAL(18,4) NULL AFTER capacity_cbm',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- billing_events.warehouse_id
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'billing_events' AND column_name = 'warehouse_id') = 0,
  'ALTER TABLE billing_events ADD COLUMN warehouse_id BIGINT UNSIGNED NULL AFTER client_id',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'billing_events' AND index_name = 'idx_billing_events_wh_event_status') = 0,
  'ALTER TABLE billing_events ADD KEY idx_billing_events_wh_event_status (warehouse_id, event_date, status)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.key_column_usage
   WHERE table_schema = DATABASE()
     AND table_name = 'billing_events'
     AND constraint_name = 'fk_billing_events_warehouse') = 0,
  'ALTER TABLE billing_events ADD CONSTRAINT fk_billing_events_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- storage_snapshots daily aggregate for dashboard + storage billing
CREATE TABLE IF NOT EXISTS storage_snapshots (
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

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'storage_snapshots' AND column_name = 'total_cbm') = 0,
  'ALTER TABLE storage_snapshots ADD COLUMN total_cbm DECIMAL(18,4) NOT NULL DEFAULT 0 AFTER snapshot_date',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'storage_snapshots' AND column_name = 'total_pallet') = 0,
  'ALTER TABLE storage_snapshots ADD COLUMN total_pallet DECIMAL(18,4) NOT NULL DEFAULT 0 AFTER total_cbm',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'storage_snapshots' AND column_name = 'total_sku') = 0,
  'ALTER TABLE storage_snapshots ADD COLUMN total_sku INT UNSIGNED NOT NULL DEFAULT 0 AFTER total_pallet',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'storage_snapshots' AND index_name = 'uq_storage_snapshot_wh_client_date') = 0,
  'ALTER TABLE storage_snapshots ADD UNIQUE KEY uq_storage_snapshot_wh_client_date (warehouse_id, client_id, snapshot_date)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'storage_snapshots' AND index_name = 'idx_storage_snapshot_date') = 0,
  'ALTER TABLE storage_snapshots ADD KEY idx_storage_snapshot_date (snapshot_date)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'storage_snapshots' AND index_name = 'idx_storage_snapshot_wh_date') = 0,
  'ALTER TABLE storage_snapshots ADD KEY idx_storage_snapshot_wh_date (warehouse_id, snapshot_date)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'storage_snapshots' AND index_name = 'idx_storage_snapshot_client_date') = 0,
  'ALTER TABLE storage_snapshots ADD KEY idx_storage_snapshot_client_date (client_id, snapshot_date)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.key_column_usage
   WHERE table_schema = DATABASE()
     AND table_name = 'storage_snapshots'
     AND constraint_name = 'fk_storage_snapshot_wh') = 0,
  'ALTER TABLE storage_snapshots ADD CONSTRAINT fk_storage_snapshot_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.key_column_usage
   WHERE table_schema = DATABASE()
     AND table_name = 'storage_snapshots'
     AND constraint_name = 'fk_storage_snapshot_client') = 0,
  'ALTER TABLE storage_snapshots ADD CONSTRAINT fk_storage_snapshot_client FOREIGN KEY (client_id) REFERENCES clients(id)',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET FOREIGN_KEY_CHECKS = 1;
