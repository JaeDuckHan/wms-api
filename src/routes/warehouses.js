const express = require("express");
const { z } = require("zod");
const { getPool } = require("../db");
const { validate } = require("../middleware/validate");

const router = express.Router();

const warehouseSchema = z.object({
  code: z.string().min(1).max(50).optional(),
  warehouse_code: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(255),
  country: z.string().min(1).max(100).default("KR"),
  timezone: z.string().min(1).max(100).default("Asia/Seoul"),
  default_cbm_size: z.coerce.number().positive().optional(),
  default_cbm_rate: z.coerce.number().nonnegative().optional(),
  status: z.enum(["active", "inactive"]).default("active"),
}).superRefine((value, ctx) => {
  const resolvedCode = String(value.code || value.warehouse_code || "").trim();
  if (!resolvedCode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "code or warehouse_code is required",
      path: ["code"],
    });
  }
});

const OPTIONAL_WAREHOUSE_COLUMNS = ["default_cbm_size", "default_cbm_rate"];
const OPTIONAL_COLUMNS_CACHE_TTL_MS = 60 * 1000;
let optionalWarehouseColumnsCache = null;
let optionalWarehouseColumnsCachedAt = 0;

async function getAvailableOptionalWarehouseColumns() {
  const now = Date.now();
  if (optionalWarehouseColumnsCache && now - optionalWarehouseColumnsCachedAt < OPTIONAL_COLUMNS_CACHE_TTL_MS) {
    return optionalWarehouseColumnsCache;
  }

  const placeholders = OPTIONAL_WAREHOUSE_COLUMNS.map(() => "?").join(", ");
  const [rows] = await getPool().query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'warehouses'
       AND column_name IN (${placeholders})`,
    OPTIONAL_WAREHOUSE_COLUMNS
  );

  optionalWarehouseColumnsCache = new Set(rows.map((row) => String(row.column_name)));
  optionalWarehouseColumnsCachedAt = now;
  return optionalWarehouseColumnsCache;
}

function buildWarehouseSelectColumns(availableColumns) {
  const optionalSelects = OPTIONAL_WAREHOUSE_COLUMNS.map((column) =>
    availableColumns.has(column) ? column : `NULL AS ${column}`
  );

  return `id, code, name, country, timezone, ${optionalSelects.join(", ")}, status, created_at, updated_at`;
}

function normalizeWarehousePayload(body) {
  const code = String(body.code || body.warehouse_code || "").trim().toUpperCase();
  const defaultCbmSize = Number(body.default_cbm_size ?? 0.1);
  const defaultCbmRate = Number(body.default_cbm_rate ?? 5000);

  return {
    code,
    name: String(body.name || "").trim(),
    country: String(body.country || "KR").trim(),
    timezone: String(body.timezone || "Asia/Seoul").trim(),
    default_cbm_size: Number.isFinite(defaultCbmSize) && defaultCbmSize > 0 ? defaultCbmSize : 0.1,
    default_cbm_rate: Number.isFinite(defaultCbmRate) && defaultCbmRate >= 0 ? defaultCbmRate : 5000,
    status: body.status || "active",
  };
}

function isMysqlDuplicate(error) {
  return error && error.code === "ER_DUP_ENTRY";
}

router.get("/", async (_req, res) => {
  try {
    const availableColumns = await getAvailableOptionalWarehouseColumns();
    const warehouseSelectColumns = buildWarehouseSelectColumns(availableColumns);
    const [rows] = await getPool().query(
      `SELECT ${warehouseSelectColumns}
       FROM warehouses
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
    const availableColumns = await getAvailableOptionalWarehouseColumns();
    const warehouseSelectColumns = buildWarehouseSelectColumns(availableColumns);
    const [rows] = await getPool().query(
      `SELECT ${warehouseSelectColumns}
       FROM warehouses
       WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, message: "Warehouse not found" });
    }
    res.json({ ok: true, data: rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

router.post("/", validate(warehouseSchema), async (req, res) => {
  const payload = normalizeWarehousePayload(req.body);

  if (!payload.code || !payload.name || !payload.country) {
    return res.status(400).json({
      ok: false,
      message: "code(or warehouse_code), name, country are required"
    });
  }

  try {
    const availableColumns = await getAvailableOptionalWarehouseColumns();
    const insertColumns = ["code", "name", "country", "timezone", "status"];
    const insertValues = [payload.code, payload.name, payload.country, payload.timezone, payload.status];
    if (availableColumns.has("default_cbm_size")) {
      insertColumns.push("default_cbm_size");
      insertValues.push(payload.default_cbm_size);
    }
    if (availableColumns.has("default_cbm_rate")) {
      insertColumns.push("default_cbm_rate");
      insertValues.push(payload.default_cbm_rate);
    }

    const [result] = await getPool().query(
      `INSERT INTO warehouses (${insertColumns.join(", ")})
       VALUES (${insertColumns.map(() => "?").join(", ")})`,
      insertValues
    );

    const warehouseSelectColumns = buildWarehouseSelectColumns(availableColumns);
    const [rows] = await getPool().query(
      `SELECT ${warehouseSelectColumns}
       FROM warehouses
       WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (error) {
    if (isMysqlDuplicate(error)) {
      return res.status(409).json({ ok: false, message: "Duplicate warehouse code" });
    }
    res.status(500).json({ ok: false, message: error.message });
  }
});

router.put("/:id", validate(warehouseSchema), async (req, res) => {
  const payload = normalizeWarehousePayload(req.body);

  if (!payload.code || !payload.name || !payload.country || !payload.timezone || !payload.status) {
    return res.status(400).json({
      ok: false,
      message: "code(or warehouse_code), name, country, timezone, status are required"
    });
  }

  try {
    const availableColumns = await getAvailableOptionalWarehouseColumns();
    const updateAssignments = [
      "code = ?",
      "name = ?",
      "country = ?",
      "timezone = ?",
      "status = ?"
    ];
    const updateValues = [payload.code, payload.name, payload.country, payload.timezone, payload.status];
    if (availableColumns.has("default_cbm_size")) {
      updateAssignments.push("default_cbm_size = ?");
      updateValues.push(payload.default_cbm_size);
    }
    if (availableColumns.has("default_cbm_rate")) {
      updateAssignments.push("default_cbm_rate = ?");
      updateValues.push(payload.default_cbm_rate);
    }
    updateValues.push(req.params.id);

    const [result] = await getPool().query(
      `UPDATE warehouses
       SET ${updateAssignments.join(", ")}
       WHERE id = ? AND deleted_at IS NULL`,
      updateValues
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, message: "Warehouse not found" });
    }

    const warehouseSelectColumns = buildWarehouseSelectColumns(availableColumns);
    const [rows] = await getPool().query(
      `SELECT ${warehouseSelectColumns}
       FROM warehouses
       WHERE id = ?`,
      [req.params.id]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (error) {
    if (isMysqlDuplicate(error)) {
      return res.status(409).json({ ok: false, message: "Duplicate warehouse code" });
    }
    res.status(500).json({ ok: false, message: error.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const [result] = await getPool().query(
      "UPDATE warehouses SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL",
      [req.params.id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, message: "Warehouse not found" });
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

module.exports = router;
