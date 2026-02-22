const express = require("express");
const { z } = require("zod");
const { getPool } = require("../db");
const { validate } = require("../middleware/validate");

const router = express.Router();

const outboundOrderSchema = z.object({
  outbound_no: z.string().min(1).max(80),
  client_id: z.coerce.number().int().positive(),
  warehouse_id: z.coerce.number().int().positive(),
  order_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sales_channel: z.string().max(80).nullable().optional(),
  order_no: z.string().max(120).nullable().optional(),
  tracking_no: z.string().max(120).nullable().optional(),
  status: z
    .enum([
      "draft",
      "confirmed",
      "allocated",
      "picking",
      "packed",
      "shipped",
      "delivered",
      "cancelled"
    ])
    .default("draft"),
  packed_at: z.string().datetime().nullable().optional(),
  shipped_at: z.string().datetime().nullable().optional(),
  created_by: z.coerce.number().int().positive()
});

function isMysqlDuplicate(error) {
  return error && error.code === "ER_DUP_ENTRY";
}

function isMysqlForeignKey(error) {
  return error && error.code === "ER_NO_REFERENCED_ROW_2";
}

function toMysqlDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

async function ensureOutboundOrderLogsTable() {
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS outbound_order_logs (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

function resolveActorUserId(req, fallbackUserId) {
  const tokenUserId = Number(req.user?.sub || 0);
  if (Number.isFinite(tokenUserId) && tokenUserId > 0) return tokenUserId;
  const fallback = Number(fallbackUserId || 0);
  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  return null;
}

function deriveOutboundAction(fromStatus, toStatus) {
  if (!fromStatus) return "create";
  if (toStatus === "allocated" && fromStatus !== "allocated") return "allocate";
  if (toStatus === "packed" && fromStatus !== "packed") return "pack";
  if (toStatus === "shipped" && fromStatus !== "shipped") return "ship";
  if (toStatus === "cancelled" && fromStatus !== "cancelled") return "cancel";
  if (fromStatus !== toStatus) return "status_change";
  return "update";
}

async function appendOutboundOrderLog({
  outboundOrderId,
  action,
  fromStatus = null,
  toStatus = null,
  note = null,
  actorUserId = null
}) {
  await ensureOutboundOrderLogsTable();
  await getPool().query(
    `INSERT INTO outbound_order_logs (outbound_order_id, action, from_status, to_status, note, actor_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [outboundOrderId, action, fromStatus, toStatus, note, actorUserId]
  );
}

router.get("/", async (_req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT id, outbound_no, client_id, warehouse_id, order_date, sales_channel, order_no, tracking_no, status, packed_at, shipped_at, created_by, created_at, updated_at
       FROM outbound_orders
       WHERE deleted_at IS NULL
       ORDER BY id DESC`
    );
    res.json({ ok: true, data: rows });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT id, outbound_no, client_id, warehouse_id, order_date, sales_channel, order_no, tracking_no, status, packed_at, shipped_at, created_by, created_at, updated_at
       FROM outbound_orders
       WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, message: "Outbound order not found" });
    }
    res.json({ ok: true, data: rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

router.get("/:id/logs", async (req, res) => {
  try {
    await ensureOutboundOrderLogsTable();
    const [rows] = await getPool().query(
      `SELECT l.id, l.outbound_order_id, l.action, l.from_status, l.to_status, l.note, l.actor_user_id,
              u.email AS actor_email, u.name AS actor_name, l.created_at
       FROM outbound_order_logs l
       LEFT JOIN users u ON u.id = l.actor_user_id
       WHERE l.outbound_order_id = ?
       ORDER BY l.id ASC`,
      [req.params.id]
    );
    return res.json({ ok: true, data: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.post("/", validate(outboundOrderSchema), async (req, res) => {
  const {
    outbound_no,
    client_id,
    warehouse_id,
    order_date,
    sales_channel = null,
    order_no = null,
    tracking_no = null,
    status = "draft",
    packed_at = null,
    shipped_at = null,
    created_by
  } = req.body;

  try {
    const [result] = await getPool().query(
      `INSERT INTO outbound_orders (outbound_no, client_id, warehouse_id, order_date, sales_channel, order_no, tracking_no, status, packed_at, shipped_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outbound_no,
        client_id,
        warehouse_id,
        order_date,
        sales_channel,
        order_no,
        tracking_no,
        status,
        toMysqlDateTime(packed_at),
        toMysqlDateTime(shipped_at),
        created_by
      ]
    );

    const [rows] = await getPool().query(
      `SELECT id, outbound_no, client_id, warehouse_id, order_date, sales_channel, order_no, tracking_no, status, packed_at, shipped_at, created_by, created_at, updated_at
       FROM outbound_orders
       WHERE id = ?`,
      [result.insertId]
    );
    await appendOutboundOrderLog({
      outboundOrderId: result.insertId,
      action: "create",
      toStatus: status,
      note: `Created outbound order ${outbound_no}`,
      actorUserId: resolveActorUserId(req, created_by)
    });
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (error) {
    if (isMysqlDuplicate(error)) {
      return res.status(409).json({ ok: false, message: "Duplicate outbound_no" });
    }
    if (isMysqlForeignKey(error)) {
      return res.status(400).json({ ok: false, message: "Invalid client_id, warehouse_id or created_by" });
    }
    res.status(500).json({ ok: false, message: error.message });
  }
});

router.put("/:id", validate(outboundOrderSchema), async (req, res) => {
  const {
    outbound_no,
    client_id,
    warehouse_id,
    order_date,
    sales_channel,
    order_no,
    tracking_no,
    status,
    packed_at,
    shipped_at,
    created_by
  } = req.body;

  try {
    const [existingRows] = await getPool().query(
      `SELECT id, status
       FROM outbound_orders
       WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({ ok: false, message: "Outbound order not found" });
    }
    const previousStatus = existingRows[0].status;

    const [result] = await getPool().query(
      `UPDATE outbound_orders
       SET outbound_no = ?, client_id = ?, warehouse_id = ?, order_date = ?, sales_channel = ?, order_no = ?, tracking_no = ?, status = ?, packed_at = ?, shipped_at = ?, created_by = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [
        outbound_no,
        client_id,
        warehouse_id,
        order_date,
        sales_channel || null,
        order_no || null,
        tracking_no || null,
        status,
        toMysqlDateTime(packed_at),
        toMysqlDateTime(shipped_at),
        created_by,
        req.params.id
      ]
    );

    const [rows] = await getPool().query(
      `SELECT id, outbound_no, client_id, warehouse_id, order_date, sales_channel, order_no, tracking_no, status, packed_at, shipped_at, created_by, created_at, updated_at
       FROM outbound_orders
       WHERE id = ?`,
      [req.params.id]
    );
    await appendOutboundOrderLog({
      outboundOrderId: Number(req.params.id),
      action: deriveOutboundAction(previousStatus, status),
      fromStatus: previousStatus,
      toStatus: status,
      note: previousStatus !== status ? `${previousStatus} -> ${status}` : "Outbound order updated",
      actorUserId: resolveActorUserId(req, created_by)
    });
    res.json({ ok: true, data: rows[0] });
  } catch (error) {
    if (isMysqlDuplicate(error)) {
      return res.status(409).json({ ok: false, message: "Duplicate outbound_no" });
    }
    if (isMysqlForeignKey(error)) {
      return res.status(400).json({ ok: false, message: "Invalid client_id, warehouse_id or created_by" });
    }
    res.status(500).json({ ok: false, message: error.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const [existingRows] = await getPool().query(
      `SELECT id, status
       FROM outbound_orders
       WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({ ok: false, message: "Outbound order not found" });
    }

    const [result] = await getPool().query(
      "UPDATE outbound_orders SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL",
      [req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ ok: false, message: "Outbound order not found" });
    await appendOutboundOrderLog({
      outboundOrderId: Number(req.params.id),
      action: "delete",
      fromStatus: existingRows[0].status,
      toStatus: null,
      note: "Outbound order deleted",
      actorUserId: resolveActorUserId(req, null)
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

module.exports = router;
