const { getPool } = require("../db");

async function getOutboundOrderForBilling(conn, outboundOrderId) {
  const [rows] = await conn.query(
    `SELECT id, client_id, warehouse_id, order_date
     FROM outbound_orders
     WHERE id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [outboundOrderId]
  );
  return rows[0] || null;
}

async function getInboundOrderForBilling(conn, inboundOrderId) {
  const [rows] = await conn.query(
    `SELECT id, client_id, warehouse_id, inbound_date
     FROM inbound_orders
     WHERE id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [inboundOrderId]
  );
  return rows[0] || null;
}

async function syncOutboundOrderBillingEvent(conn, outboundOrderId) {
  const order = await getOutboundOrderForBilling(conn, outboundOrderId);
  if (!order) return null;

  const [qtyRows] = await conn.query(
    `SELECT COALESCE(SUM(qty), 0) AS qty
     FROM outbound_items
     WHERE outbound_order_id = ? AND deleted_at IS NULL`,
    [outboundOrderId]
  );
  const totalQty = Number(qtyRows[0]?.qty || 0);

  if (totalQty <= 0) {
    await conn.query(
      `UPDATE billing_events
       SET deleted_at = NOW()
       WHERE reference_type = 'OUTBOUND'
         AND reference_id = ?
         AND service_code = 'OUTBOUND_FEE'
         AND deleted_at IS NULL`,
      [String(outboundOrderId)]
    );
    return null;
  }

  const [existing] = await conn.query(
    `SELECT id
     FROM billing_events
     WHERE reference_type = 'OUTBOUND'
       AND reference_id = ?
       AND service_code = 'OUTBOUND_FEE'
       AND deleted_at IS NULL
     ORDER BY id DESC
     LIMIT 1`,
    [String(outboundOrderId)]
  );

  if (existing.length === 0) {
    const [inserted] = await conn.query(
      `INSERT INTO billing_events
        (client_id, warehouse_id, service_code, reference_type, reference_id, event_date, qty, pricing_policy, unit_price_krw, amount_krw)
       VALUES (?, ?, 'OUTBOUND_FEE', 'OUTBOUND', ?, ?, ?, 'KRW_FIXED', 0, 0)`,
      [order.client_id, order.warehouse_id, String(outboundOrderId), order.order_date, totalQty]
    );
    return inserted.insertId;
  }

  await conn.query(
    `UPDATE billing_events
     SET client_id = ?, warehouse_id = ?, event_date = ?, qty = ?, pricing_policy = 'KRW_FIXED',
         unit_price_krw = COALESCE(unit_price_krw, 0), amount_krw = COALESCE(amount_krw, 0), deleted_at = NULL
     WHERE id = ?`,
    [order.client_id, order.warehouse_id, order.order_date, totalQty, existing[0].id]
  );

  return existing[0].id;
}

async function syncInboundOrderBillingEvent(conn, inboundOrderId) {
  const order = await getInboundOrderForBilling(conn, inboundOrderId);
  if (!order) return null;

  const [qtyRows] = await conn.query(
    `SELECT COALESCE(SUM(qty), 0) AS qty
     FROM inbound_items
     WHERE inbound_order_id = ? AND deleted_at IS NULL`,
    [inboundOrderId]
  );
  const totalQty = Number(qtyRows[0]?.qty || 0);

  if (totalQty <= 0) {
    await conn.query(
      `UPDATE billing_events
       SET deleted_at = NOW()
       WHERE reference_type = 'INBOUND'
         AND reference_id = ?
         AND service_code = 'INBOUND_FEE'
         AND deleted_at IS NULL`,
      [String(inboundOrderId)]
    );
    return null;
  }

  const [existing] = await conn.query(
    `SELECT id
     FROM billing_events
     WHERE reference_type = 'INBOUND'
       AND reference_id = ?
       AND service_code = 'INBOUND_FEE'
       AND deleted_at IS NULL
     ORDER BY id DESC
     LIMIT 1`,
    [String(inboundOrderId)]
  );

  if (existing.length === 0) {
    const [inserted] = await conn.query(
      `INSERT INTO billing_events
        (client_id, warehouse_id, service_code, reference_type, reference_id, event_date, qty, pricing_policy, unit_price_krw, amount_krw)
       VALUES (?, ?, 'INBOUND_FEE', 'INBOUND', ?, ?, ?, 'KRW_FIXED', 0, 0)`,
      [order.client_id, order.warehouse_id, String(inboundOrderId), order.inbound_date, totalQty]
    );
    return inserted.insertId;
  }

  await conn.query(
    `UPDATE billing_events
     SET client_id = ?, warehouse_id = ?, event_date = ?, qty = ?, pricing_policy = 'KRW_FIXED',
         unit_price_krw = COALESCE(unit_price_krw, 0), amount_krw = COALESCE(amount_krw, 0), deleted_at = NULL
     WHERE id = ?`,
    [order.client_id, order.warehouse_id, order.inbound_date, totalQty, existing[0].id]
  );

  return existing[0].id;
}

module.exports = {
  syncOutboundOrderBillingEvent,
  syncInboundOrderBillingEvent
};
