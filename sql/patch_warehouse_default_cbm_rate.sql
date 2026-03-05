-- Add default warehouse CBM baseline fields for SKU storage billing reference
SET @sql := IF(
  (SELECT COUNT(*)
   FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'warehouses'
     AND column_name = 'default_cbm_size') = 0,
  'ALTER TABLE warehouses ADD COLUMN default_cbm_size DECIMAL(10,4) NOT NULL DEFAULT 0.1 AFTER timezone',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*)
   FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'warehouses'
     AND column_name = 'default_cbm_rate') = 0,
  'ALTER TABLE warehouses ADD COLUMN default_cbm_rate DECIMAL(18,4) NOT NULL DEFAULT 5000 AFTER default_cbm_size',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
