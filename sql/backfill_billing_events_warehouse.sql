SET NAMES utf8mb4;

-- OUTBOUND reference -> outbound_orders.warehouse_id
UPDATE billing_events be
JOIN outbound_orders oo
  ON oo.deleted_at IS NULL
 AND (be.reference_id = CAST(oo.id AS CHAR) OR be.reference_id = oo.outbound_no)
SET be.warehouse_id = oo.warehouse_id
WHERE be.deleted_at IS NULL
  AND be.warehouse_id IS NULL
  AND be.reference_type = 'OUTBOUND'
  AND be.reference_id IS NOT NULL;

-- INBOUND reference -> inbound_orders.warehouse_id
UPDATE billing_events be
JOIN inbound_orders io
  ON io.deleted_at IS NULL
 AND (be.reference_id = CAST(io.id AS CHAR) OR be.reference_id = io.inbound_no)
SET be.warehouse_id = io.warehouse_id
WHERE be.deleted_at IS NULL
  AND be.warehouse_id IS NULL
  AND be.reference_type = 'INBOUND'
  AND be.reference_id IS NOT NULL;

-- Fallback to clients.default_warehouse_id if available
SET @has_default_wh := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'clients'
    AND column_name = 'default_warehouse_id'
);

SET @sql := IF(
  @has_default_wh > 0,
  'UPDATE billing_events be
   JOIN clients c ON c.id = be.client_id
   SET be.warehouse_id = c.default_warehouse_id
   WHERE be.deleted_at IS NULL
     AND be.warehouse_id IS NULL
     AND c.deleted_at IS NULL
     AND c.default_warehouse_id IS NOT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Check unresolved rows (should drive dashboard alert)
SELECT COUNT(*) AS missing_warehouse_id_events
FROM billing_events
WHERE deleted_at IS NULL
  AND warehouse_id IS NULL;
