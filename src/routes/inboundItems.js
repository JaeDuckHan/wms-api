const express = require("express");
const { z } = require("zod");
const { getPool } = require("../db");
const { validate } = require("../middleware/validate");
const {
  StockError,
  withTransaction,
  getInboundOrderContext,
  adjustAvailableQty,
  upsertStockTxn,
  softDeleteStockTxn
} = require("../services/stock");
const { syncInboundOrderBillingEvent } = require("../services/billingEvents");

const router = express.Router();

const inboundItemSchema = z.object({
  inbound_order_id: z.coerce.number().int().positive(),
  product_id: z.coerce.number().int().positive(),
  lot_id: z.coerce.number().int().positive(),
  location_id: z.coerce.number().int().positive().nullable().optional(),
  qty: z.coerce.number().int().positive(),
  invoice_price: z.coerce.number().positive().nullable().optional(),
  currency: z.enum(["KRW", "THB"]).nullable().optional(),
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

async function getInboundItemWithContext(conn, itemId) {
  const [rows] = await conn.query(
    `SELECT ii.id, ii.inbound_order_id, ii.product_id, ii.lot_id, ii.location_id, ii.qty, ii.invoice_price, ii.currency, ii.remark, ii.created_at, ii.updated_at,
            io.client_id, io.warehouse_id, io.created_by
     FROM inbound_items ii
     JOIN inbound_orders io ON io.id = ii.inbound_order_id
     WHERE ii.id = ? AND ii.deleted_at IS NULL`,
    [itemId]
  );
  return rows[0] || null;
}

router.get("/", async (req, res) => {
  const inboundOrderId = req.query.inbound_order_id;

  try {
    let query = `SELECT id, inbound_order_id, product_id, lot_id, location_id, qty, invoice_price, currency, remark, created_at, updated_at
                 FROM inbound_items
                 WHERE deleted_at IS NULL`;
    const params = [];

    if (inboundOrderId) {
      query += " AND inbound_order_id = ?";
      params.push(inboundOrderId);
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
      `SELECT id, inbound_order_id, product_id, lot_id, location_id, qty, invoice_price, currency, remark, created_at, updated_at
       FROM inbound_items
       WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, message: "Inbound item not found" });
    }
    res.json({ ok: true, data: rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

router.post("/", validate(inboundItemSchema), async (req, res) => {
  const {
    inbound_order_id,
    product_id,
    lot_id,
    location_id = null,
    qty,
    invoice_price = null,
    currency = null,
    remark = null
  } = req.body;

  try {
    const created = await withTransaction(async (conn) => {
      const validLot = await validateLotBelongsToProduct(conn, product_id, lot_id);
      if (!validLot) {
        throw new StockError("INVALID_LOT_PRODUCT", "lot_id does not belong to product_id");
      }

      const order = await getInboundOrderContext(conn, inbound_order_id);
      if (!order) {
        throw new StockError("INVALID_ORDER", "Invalid inbound_order_id");
      }

      const [result] = await conn.query(
        `INSERT INTO inbound_items (inbound_order_id, product_id, lot_id, location_id, qty, invoice_price, currency, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [inbound_order_id, product_id, lot_id, location_id, qty, invoice_price, currency, remark]
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
        qty
      );

      await upsertStockTxn(conn, {
        clientId: order.client_id,
        productId: product_id,
        lotId: lot_id,
        warehouseId: order.warehouse_id,
        locationId: location_id,
        txnType: "inbound_receive",
        qtyIn: qty,
        qtyOut: 0,
        refType: "inbound_item",
        refId: result.insertId,
        createdBy: order.created_by,
        note: remark
      });
      await syncInboundOrderBillingEvent(conn, order.id);

      const [rows] = await conn.query(
        `SELECT id, inbound_order_id, product_id, lot_id, location_id, qty, invoice_price, currency, remark, created_at, updated_at
         FROM inbound_items
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
        message: "Invalid inbound_order_id, product_id, lot_id or location_id"
      });
    }
    if (error instanceof StockError) {
      return res.status(400).json({ ok: false, code: error.code, message: error.message });
    }
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.put("/:id", validate(inboundItemSchema), async (req, res) => {
  const {
    inbound_order_id,
    product_id,
    lot_id,
    location_id,
    qty,
    invoice_price,
    currency,
    remark
  } = req.body;

  try {
    const updated = await withTransaction(async (conn) => {
      const prev = await getInboundItemWithContext(conn, req.params.id);
      if (!prev) {
        throw new StockError("NOT_FOUND", "Inbound item not found");
      }

      const validLot = await validateLotBelongsToProduct(conn, product_id, lot_id);
      if (!validLot) {
        throw new StockError("INVALID_LOT_PRODUCT", "lot_id does not belong to product_id");
      }

      const nextOrder = await getInboundOrderContext(conn, inbound_order_id);
      if (!nextOrder) {
        throw new StockError("INVALID_ORDER", "Invalid inbound_order_id");
      }

      await conn.query(
        `UPDATE inbound_items
         SET inbound_order_id = ?, product_id = ?, lot_id = ?, location_id = ?, qty = ?, invoice_price = ?, currency = ?, remark = ?
         WHERE id = ? AND deleted_at IS NULL`,
        [
          inbound_order_id,
          product_id,
          lot_id,
          location_id || null,
          qty,
          invoice_price || null,
          currency || null,
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
        -Number(prev.qty)
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
        qty
      );

      await upsertStockTxn(conn, {
        clientId: nextOrder.client_id,
        productId: product_id,
        lotId: lot_id,
        warehouseId: nextOrder.warehouse_id,
        locationId: location_id || null,
        txnType: "inbound_receive",
        qtyIn: qty,
        qtyOut: 0,
        refType: "inbound_item",
        refId: Number(req.params.id),
        createdBy: nextOrder.created_by,
        note: remark
      });
      if (Number(prev.inbound_order_id) !== Number(nextOrder.id)) {
        await syncInboundOrderBillingEvent(conn, prev.inbound_order_id);
      }
      await syncInboundOrderBillingEvent(conn, nextOrder.id);

      const [rows] = await conn.query(
        `SELECT id, inbound_order_id, product_id, lot_id, location_id, qty, invoice_price, currency, remark, created_at, updated_at
         FROM inbound_items
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
        message: "Invalid inbound_order_id, product_id, lot_id or location_id"
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
      const prev = await getInboundItemWithContext(conn, req.params.id);
      if (!prev) {
        throw new StockError("NOT_FOUND", "Inbound item not found");
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
        -Number(prev.qty)
      );

      await conn.query(
        "UPDATE inbound_items SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL",
        [req.params.id]
      );

      await softDeleteStockTxn(conn, "inbound_receive", "inbound_item", req.params.id);
      await syncInboundOrderBillingEvent(conn, prev.inbound_order_id);
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
