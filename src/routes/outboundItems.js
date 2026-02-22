const express = require("express");
const { z } = require("zod");
const { getPool } = require("../db");
const { validate } = require("../middleware/validate");
const {
  StockError,
  withTransaction,
  getOutboundOrderContext,
  adjustAvailableQty,
  upsertStockTxn,
  getStockTxnId,
  softDeleteStockTxn
} = require("../services/stock");
const {
  upsertOutboundServiceEvent,
  softDeleteOutboundServiceEvent
} = require("../services/billing");
const { syncOutboundOrderBillingEvent } = require("../services/billingEvents");

const router = express.Router();

const outboundItemSchema = z.object({
  outbound_order_id: z.coerce.number().int().positive(),
  product_id: z.coerce.number().int().positive(),
  lot_id: z.coerce.number().int().positive(),
  location_id: z.coerce.number().int().positive().nullable().optional(),
  qty: z.coerce.number().int().positive(),
  box_type: z.string().max(80).nullable().optional(),
  box_count: z.coerce.number().int().min(0).default(0),
  remark: z.string().max(500).nullable().optional()
});

function isMysqlForeignKey(error) {
  return error && error.code === "ER_NO_REFERENCED_ROW_2";
}

async function validateLotBelongsToProduct(conn, productId, lotId) {
  const [rows] = await conn.query(
    "SELECT id FROM product_lots WHERE id = ? AND product_id = ? AND deleted_at IS NULL",
    [lotId, productId]
  );
  return rows.length > 0;
}

async function getOutboundItemWithContext(conn, itemId) {
  const [rows] = await conn.query(
    `SELECT oi.id, oi.outbound_order_id, oi.product_id, oi.lot_id, oi.location_id, oi.qty, oi.box_type, oi.box_count, oi.remark, oi.created_at, oi.updated_at,
            oo.client_id, oo.warehouse_id, oo.created_by
     FROM outbound_items oi
     JOIN outbound_orders oo ON oo.id = oi.outbound_order_id
     WHERE oi.id = ? AND oi.deleted_at IS NULL`,
    [itemId]
  );
  return rows[0] || null;
}

router.get("/", async (req, res) => {
  const outboundOrderId = req.query.outbound_order_id;

  try {
    let query = `SELECT id, outbound_order_id, product_id, lot_id, location_id, qty, box_type, box_count, remark, created_at, updated_at
                 FROM outbound_items
                 WHERE deleted_at IS NULL`;
    const params = [];

    if (outboundOrderId) {
      query += " AND outbound_order_id = ?";
      params.push(outboundOrderId);
    }

    query += " ORDER BY id DESC";

    const [rows] = await getPool().query(query, params);
    res.json({ ok: true, data: rows });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT id, outbound_order_id, product_id, lot_id, location_id, qty, box_type, box_count, remark, created_at, updated_at
       FROM outbound_items
       WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, message: "Outbound item not found" });
    }
    res.json({ ok: true, data: rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

router.post("/", validate(outboundItemSchema), async (req, res) => {
  const {
    outbound_order_id,
    product_id,
    lot_id,
    location_id = null,
    qty,
    box_type = null,
    box_count = 0,
    remark = null
  } = req.body;

  try {
    const created = await withTransaction(async (conn) => {
      const validLot = await validateLotBelongsToProduct(conn, product_id, lot_id);
      if (!validLot) {
        throw new StockError("INVALID_LOT_PRODUCT", "lot_id does not belong to product_id");
      }

      const order = await getOutboundOrderContext(conn, outbound_order_id);
      if (!order) {
        throw new StockError("INVALID_ORDER", "Invalid outbound_order_id");
      }

      const [result] = await conn.query(
        `INSERT INTO outbound_items (outbound_order_id, product_id, lot_id, location_id, qty, box_type, box_count, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [outbound_order_id, product_id, lot_id, location_id, qty, box_type, box_count, remark]
      );

      await adjustAvailableQty(
        conn,
        {
          clientId: order.client_id,
          productId: product_id,
          lotId: lot_id,
          warehouseId: order.warehouse_id,
          locationId: location_id
        },
        -Number(qty)
      );

      const stockTxnId = await upsertStockTxn(conn, {
        clientId: order.client_id,
        productId: product_id,
        lotId: lot_id,
        warehouseId: order.warehouse_id,
        locationId: location_id,
        txnType: "outbound_ship",
        qtyIn: 0,
        qtyOut: qty,
        refType: "outbound_item",
        refId: result.insertId,
        createdBy: order.created_by,
        note: remark
      });

      await upsertOutboundServiceEvent(conn, {
        clientId: order.client_id,
        outboundOrderId: order.id,
        stockTransactionId: stockTxnId,
        orderDate: order.order_date,
        qty,
        boxCount: box_count,
        remark
      });
      await syncOutboundOrderBillingEvent(conn, order.id);

      const [rows] = await conn.query(
        `SELECT id, outbound_order_id, product_id, lot_id, location_id, qty, box_type, box_count, remark, created_at, updated_at
         FROM outbound_items
         WHERE id = ?`,
        [result.insertId]
      );
      return rows[0];
    });

    return res.status(201).json({ ok: true, data: created });
  } catch (error) {
    if (isMysqlForeignKey(error)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid outbound_order_id, product_id, lot_id or location_id"
      });
    }
    if (error instanceof StockError) {
      return res.status(400).json({ ok: false, code: error.code, message: error.message });
    }
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.put("/:id", validate(outboundItemSchema), async (req, res) => {
  const {
    outbound_order_id,
    product_id,
    lot_id,
    location_id,
    qty,
    box_type,
    box_count,
    remark
  } = req.body;

  try {
    const updated = await withTransaction(async (conn) => {
      const prev = await getOutboundItemWithContext(conn, req.params.id);
      if (!prev) {
        throw new StockError("NOT_FOUND", "Outbound item not found");
      }

      const validLot = await validateLotBelongsToProduct(conn, product_id, lot_id);
      if (!validLot) {
        throw new StockError("INVALID_LOT_PRODUCT", "lot_id does not belong to product_id");
      }

      const nextOrder = await getOutboundOrderContext(conn, outbound_order_id);
      if (!nextOrder) {
        throw new StockError("INVALID_ORDER", "Invalid outbound_order_id");
      }

      await conn.query(
        `UPDATE outbound_items
         SET outbound_order_id = ?, product_id = ?, lot_id = ?, location_id = ?, qty = ?, box_type = ?, box_count = ?, remark = ?
         WHERE id = ? AND deleted_at IS NULL`,
        [
          outbound_order_id,
          product_id,
          lot_id,
          location_id || null,
          qty,
          box_type || null,
          box_count,
          remark || null,
          req.params.id
        ]
      );

      await adjustAvailableQty(
        conn,
        {
          clientId: prev.client_id,
          productId: prev.product_id,
          lotId: prev.lot_id,
          warehouseId: prev.warehouse_id,
          locationId: prev.location_id
        },
        Number(prev.qty)
      );

      await adjustAvailableQty(
        conn,
        {
          clientId: nextOrder.client_id,
          productId: product_id,
          lotId: lot_id,
          warehouseId: nextOrder.warehouse_id,
          locationId: location_id || null
        },
        -Number(qty)
      );

      const stockTxnId = await upsertStockTxn(conn, {
        clientId: nextOrder.client_id,
        productId: product_id,
        lotId: lot_id,
        warehouseId: nextOrder.warehouse_id,
        locationId: location_id || null,
        txnType: "outbound_ship",
        qtyIn: 0,
        qtyOut: qty,
        refType: "outbound_item",
        refId: Number(req.params.id),
        createdBy: nextOrder.created_by,
        note: remark
      });

      await upsertOutboundServiceEvent(conn, {
        clientId: nextOrder.client_id,
        outboundOrderId: nextOrder.id,
        stockTransactionId: stockTxnId,
        orderDate: nextOrder.order_date,
        qty,
        boxCount: box_count,
        remark
      });
      if (Number(prev.outbound_order_id) !== Number(nextOrder.id)) {
        await syncOutboundOrderBillingEvent(conn, prev.outbound_order_id);
      }
      await syncOutboundOrderBillingEvent(conn, nextOrder.id);

      const [rows] = await conn.query(
        `SELECT id, outbound_order_id, product_id, lot_id, location_id, qty, box_type, box_count, remark, created_at, updated_at
         FROM outbound_items
         WHERE id = ?`,
        [req.params.id]
      );
      return rows[0];
    });

    return res.json({ ok: true, data: updated });
  } catch (error) {
    if (isMysqlForeignKey(error)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid outbound_order_id, product_id, lot_id or location_id"
      });
    }
    if (error instanceof StockError) {
      const status = error.code === "NOT_FOUND" ? 404 : 400;
      return res.status(status).json({ ok: false, code: error.code, message: error.message });
    }
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    await withTransaction(async (conn) => {
      const prev = await getOutboundItemWithContext(conn, req.params.id);
      if (!prev) {
        throw new StockError("NOT_FOUND", "Outbound item not found");
      }

      await adjustAvailableQty(
        conn,
        {
          clientId: prev.client_id,
          productId: prev.product_id,
          lotId: prev.lot_id,
          warehouseId: prev.warehouse_id,
          locationId: prev.location_id
        },
        Number(prev.qty)
      );

      const stockTxnId = await getStockTxnId(
        conn,
        "outbound_ship",
        "outbound_item",
        req.params.id
      );

      await conn.query(
        "UPDATE outbound_items SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL",
        [req.params.id]
      );

      if (stockTxnId) {
        await softDeleteOutboundServiceEvent(conn, stockTxnId);
      }
      await softDeleteStockTxn(conn, "outbound_ship", "outbound_item", req.params.id);
      await syncOutboundOrderBillingEvent(conn, prev.outbound_order_id);
    });

    return res.json({ ok: true });
  } catch (error) {
    if (error instanceof StockError) {
      const status = error.code === "NOT_FOUND" ? 404 : 400;
      return res.status(status).json({ ok: false, code: error.code, message: error.message });
    }
    return res.status(500).json({ ok: false, message: error.message });
  }
});

module.exports = router;
