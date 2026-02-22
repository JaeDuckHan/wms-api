const express = require("express");
const { z } = require("zod");
const { getPool } = require("../db");
const { validate } = require("../middleware/validate");

const router = express.Router();

const inboundOrderCreateSchema = z.object({
  inbound_no: z.string().min(1).max(80),
  client_id: z.coerce.number().int().positive(),
  warehouse_id: z.coerce.number().int().positive(),
  inbound_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["draft", "submitted", "arrived", "qc_hold", "received", "cancelled"]).default("draft"),
  memo: z.string().max(1000).nullable().optional(),
  created_by: z.coerce.number().int().positive(),
  received_at: z.string().datetime().nullable().optional()
});

const inboundOrderUpdateSchema = inboundOrderCreateSchema.extend({
  status: z.enum(["draft", "submitted", "arrived", "qc_hold", "received", "cancelled"])
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

async function ensureInboundOrderLogsTable() {
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS inbound_order_logs (
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

function deriveInboundAction(fromStatus, toStatus) {
  if (!fromStatus) return "create";
  if (toStatus === "submitted" && fromStatus !== "submitted") return "submit";
  if (toStatus === "arrived" && fromStatus !== "arrived") return "arrive";
  if (toStatus === "received" && fromStatus !== "received") return "receive";
  if (toStatus === "cancelled" && fromStatus !== "cancelled") return "cancel";
  if (fromStatus !== toStatus) return "status_change";
  return "update";
}

async function appendInboundOrderLog({
  inboundOrderId,
  action,
  fromStatus = null,
  toStatus = null,
  note = null,
  actorUserId = null
}) {
  await ensureInboundOrderLogsTable();
  await getPool().query(
    `INSERT INTO inbound_order_logs (inbound_order_id, action, from_status, to_status, note, actor_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [inboundOrderId, action, fromStatus, toStatus, note, actorUserId]
  );
}

router.get("/", async (_req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT id, inbound_no, client_id, warehouse_id, inbound_date, status, memo, created_by, received_at, created_at, updated_at
       FROM inbound_orders
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
      `SELECT id, inbound_no, client_id, warehouse_id, inbound_date, status, memo, created_by, received_at, created_at, updated_at
       FROM inbound_orders
       WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, message: "Inbound order not found" });
    }
    res.json({ ok: true, data: rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

router.get("/:id/logs", async (req, res) => {
  try {
    await ensureInboundOrderLogsTable();
    const [rows] = await getPool().query(
      `SELECT l.id, l.inbound_order_id, l.action, l.from_status, l.to_status, l.note, l.actor_user_id,
              u.email AS actor_email, u.name AS actor_name, l.created_at
       FROM inbound_order_logs l
       LEFT JOIN users u ON u.id = l.actor_user_id
       WHERE l.inbound_order_id = ?
       ORDER BY l.id ASC`,
      [req.params.id]
    );
    return res.json({ ok: true, data: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.post("/", validate(inboundOrderCreateSchema), async (req, res) => {
  const {
    inbound_no,
    client_id,
    warehouse_id,
    inbound_date,
    status = "draft",
    memo = null,
    created_by,
    received_at = null
  } = req.body;

  if (!inbound_no || !client_id || !warehouse_id || !inbound_date || !created_by) {
    return res.status(400).json({
      ok: false,
      message: "inbound_no, client_id, warehouse_id, inbound_date, created_by are required"
    });
  }

  try {
    const [result] = await getPool().query(
      `INSERT INTO inbound_orders (inbound_no, client_id, warehouse_id, inbound_date, status, memo, created_by, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [inbound_no, client_id, warehouse_id, inbound_date, status, memo, created_by, toMysqlDateTime(received_at)]
    );

    const [rows] = await getPool().query(
      `SELECT id, inbound_no, client_id, warehouse_id, inbound_date, status, memo, created_by, received_at, created_at, updated_at
       FROM inbound_orders
       WHERE id = ?`,
      [result.insertId]
    );
    await appendInboundOrderLog({
      inboundOrderId: result.insertId,
      action: "create",
      toStatus: status,
      note: `Created inbound order ${inbound_no}`,
      actorUserId: resolveActorUserId(req, created_by)
    });
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (error) {
    if (isMysqlDuplicate(error)) {
      return res.status(409).json({ ok: false, message: "Duplicate inbound_no" });
    }
    if (isMysqlForeignKey(error)) {
      return res.status(400).json({ ok: false, message: "Invalid client_id, warehouse_id or created_by" });
    }
    res.status(500).json({ ok: false, message: error.message });
  }
});

router.put("/:id", validate(inboundOrderUpdateSchema), async (req, res) => {
  const {
    inbound_no,
    client_id,
    warehouse_id,
    inbound_date,
    status,
    memo,
    created_by,
    received_at
  } = req.body;

  if (!inbound_no || !client_id || !warehouse_id || !inbound_date || !status || !created_by) {
    return res.status(400).json({
      ok: false,
      message: "inbound_no, client_id, warehouse_id, inbound_date, status, created_by are required"
    });
  }

  try {
    const [existingRows] = await getPool().query(
      `SELECT id, status
       FROM inbound_orders
       WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({ ok: false, message: "Inbound order not found" });
    }
    const previousStatus = existingRows[0].status;

    const [result] = await getPool().query(
      `UPDATE inbound_orders
       SET inbound_no = ?, client_id = ?, warehouse_id = ?, inbound_date = ?, status = ?, memo = ?, created_by = ?, received_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [
        inbound_no,
        client_id,
        warehouse_id,
        inbound_date,
        status,
        memo || null,
        created_by,
        toMysqlDateTime(received_at),
        req.params.id
      ]
    );

    const [rows] = await getPool().query(
      `SELECT id, inbound_no, client_id, warehouse_id, inbound_date, status, memo, created_by, received_at, created_at, updated_at
       FROM inbound_orders
       WHERE id = ?`,
      [req.params.id]
    );
    await appendInboundOrderLog({
      inboundOrderId: Number(req.params.id),
      action: deriveInboundAction(previousStatus, status),
      fromStatus: previousStatus,
      toStatus: status,
      note: previousStatus !== status ? `${previousStatus} -> ${status}` : "Inbound order updated",
      actorUserId: resolveActorUserId(req, created_by)
    });
    res.json({ ok: true, data: rows[0] });
  } catch (error) {
    if (isMysqlDuplicate(error)) {
      return res.status(409).json({ ok: false, message: "Duplicate inbound_no" });
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
       FROM inbound_orders
       WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({ ok: false, message: "Inbound order not found" });
    }

    const [result] = await getPool().query(
      "UPDATE inbound_orders SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL",
      [req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ ok: false, message: "Inbound order not found" });
    await appendInboundOrderLog({
      inboundOrderId: Number(req.params.id),
      action: "delete",
      fromStatus: existingRows[0].status,
      toStatus: null,
      note: "Inbound order deleted",
      actorUserId: resolveActorUserId(req, null)
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

module.exports = router;
