const express = require("express");
const { z } = require("zod");
const { getPool } = require("../db");
const { validate } = require("../middleware/validate");
const { withTransaction } = require("../services/stock");

const router = express.Router();

const BILLING_UNITS = ["ORDER", "SKU", "BOX", "CBM", "PALLET", "EVENT", "MONTH"];
const PRICING_POLICIES = ["THB_BASED", "KRW_FIXED"];
let hasInvoiceMonthColumnCache = null;
let hasInvoiceDateColumnCache = null;
let hasInvoiceFxRateColumnCache = null;
let hasClientDefaultWarehouseColumnCache = null;
const schemaColumnCache = new Map();
const schemaTableCache = new Map();

function trunc100(input) {
  const value = Number(input || 0);
  return Math.floor(value / 100) * 100;
}

function monthRange(invoiceMonth) {
  const from = `${invoiceMonth}-01`;
  const [year, month] = invoiceMonth.split("-").map(Number);
  const to = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return { from, to };
}

function parseCreator(req, payloadCreatedBy) {
  if (payloadCreatedBy) return payloadCreatedBy;
  const authUserId = Number(req.user?.sub || 0);
  return Number.isFinite(authUserId) && authUserId > 0 ? authUserId : 1;
}

function mapBillingBasisFromUnit(unit) {
  if (unit === "ORDER") return "ORDER";
  if (unit === "BOX") return "BOX";
  if (unit === "SKU") return "QTY";
  return "MANUAL";
}

function requireAdmin(req, res) {
  if (req.user?.role !== "admin") {
    res.status(403).json({
      ok: false,
      code: "ADMIN_ONLY",
      message: "This operation requires admin role"
    });
    return false;
  }
  return true;
}

async function getExchangeRateUsageCount(conn, exchangeRateId) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS usage_count
     FROM invoices i
     JOIN exchange_rates er ON er.id = ?
     WHERE i.deleted_at IS NULL
       AND i.invoice_month IS NOT NULL
       AND i.fx_rate_thbkrw = er.rate`,
    [exchangeRateId]
  );
  return Number(rows[0]?.usage_count || 0);
}

async function resolveInvoiceSequence(conn, clientId, yyyymm) {
  const [seqRows] = await conn.query(
    `SELECT id, last_seq
     FROM invoice_sequences
     WHERE client_id = ? AND yyyymm = ? AND deleted_at IS NULL
     LIMIT 1
     FOR UPDATE`,
    [clientId, yyyymm]
  );

  if (seqRows.length === 0) {
    await conn.query(
      `INSERT INTO invoice_sequences (client_id, yyyymm, last_seq)
       VALUES (?, ?, 1)`,
      [clientId, yyyymm]
    );
    return 1;
  }

  const nextSeq = Number(seqRows[0].last_seq) + 1;
  await conn.query("UPDATE invoice_sequences SET last_seq = ? WHERE id = ?", [nextSeq, seqRows[0].id]);
  return nextSeq;
}

function normalizeInvoiceStatus(status) {
  if (!status) return null;
  const value = String(status).toLowerCase();
  if (["draft", "issued", "paid"].includes(value)) return value;
  return null;
}

async function hasInvoiceMonthColumn(conn = getPool()) {
  if (hasInvoiceMonthColumnCache !== null) return hasInvoiceMonthColumnCache;

  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'invoices'
       AND column_name = 'invoice_month'`
  );

  hasInvoiceMonthColumnCache = Number(rows[0]?.cnt || 0) > 0;
  return hasInvoiceMonthColumnCache;
}

function invoiceMonthExpr(hasInvoiceMonthColumn, alias) {
  return hasInvoiceMonthColumn ? `${alias}.invoice_month` : `DATE_FORMAT(${alias}.issue_date, '%Y-%m')`;
}

async function hasInvoiceDateColumn(conn = getPool()) {
  if (hasInvoiceDateColumnCache !== null) return hasInvoiceDateColumnCache;

  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'invoices'
       AND column_name = 'invoice_date'`
  );

  hasInvoiceDateColumnCache = Number(rows[0]?.cnt || 0) > 0;
  return hasInvoiceDateColumnCache;
}

function invoiceDateExpr(hasInvoiceDateColumn, alias) {
  return hasInvoiceDateColumn ? `${alias}.invoice_date` : `${alias}.issue_date`;
}

async function hasInvoiceFxRateColumn(conn = getPool()) {
  if (hasInvoiceFxRateColumnCache !== null) return hasInvoiceFxRateColumnCache;
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'invoices'
       AND column_name = 'fx_rate_thbkrw'`
  );
  hasInvoiceFxRateColumnCache = Number(rows[0]?.cnt || 0) > 0;
  return hasInvoiceFxRateColumnCache;
}

async function hasTable(tableName, conn = getPool()) {
  const key = String(tableName);
  if (schemaTableCache.has(key)) return schemaTableCache.get(key);
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name = ?`,
    [key]
  );
  const result = Number(rows[0]?.cnt || 0) > 0;
  schemaTableCache.set(key, result);
  return result;
}

async function hasColumn(tableName, columnName, conn = getPool()) {
  const key = `${tableName}.${columnName}`;
  if (schemaColumnCache.has(key)) return schemaColumnCache.get(key);
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND column_name = ?`,
    [tableName, columnName]
  );
  const result = Number(rows[0]?.cnt || 0) > 0;
  schemaColumnCache.set(key, result);
  return result;
}

async function hasClientDefaultWarehouseColumn(conn = getPool()) {
  if (hasClientDefaultWarehouseColumnCache !== null) return hasClientDefaultWarehouseColumnCache;

  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'clients'
       AND column_name = 'default_warehouse_id'`
  );
  hasClientDefaultWarehouseColumnCache = Number(rows[0]?.cnt || 0) > 0;
  return hasClientDefaultWarehouseColumnCache;
}

async function resolveWarehouseIdFromReference(conn, referenceType, referenceId) {
  if (!referenceId || !referenceType) return null;

  const normalizedType = String(referenceType).toUpperCase();
  if (normalizedType === "OUTBOUND") {
    const [rows] = await conn.query(
      `SELECT warehouse_id
       FROM outbound_orders
       WHERE deleted_at IS NULL
         AND (CAST(id AS CHAR) = ? OR outbound_no = ?)
       ORDER BY id DESC
       LIMIT 1`,
      [String(referenceId), String(referenceId)]
    );
    return rows[0]?.warehouse_id ?? null;
  }
  if (normalizedType === "INBOUND") {
    const [rows] = await conn.query(
      `SELECT warehouse_id
       FROM inbound_orders
       WHERE deleted_at IS NULL
         AND (CAST(id AS CHAR) = ? OR inbound_no = ?)
       ORDER BY id DESC
       LIMIT 1`,
      [String(referenceId), String(referenceId)]
    );
    return rows[0]?.warehouse_id ?? null;
  }
  return null;
}

async function resolveClientDefaultWarehouseId(conn, clientId) {
  const hasColumn = await hasClientDefaultWarehouseColumn(conn);
  if (!hasColumn) return null;
  const [rows] = await conn.query(
    `SELECT default_warehouse_id
     FROM clients
     WHERE id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [clientId]
  );
  return rows[0]?.default_warehouse_id ?? null;
}

async function resolveWarehouseIdForBillingEvent(conn, payload) {
  if (payload.warehouse_id) return Number(payload.warehouse_id);

  const byRef = await resolveWarehouseIdFromReference(conn, payload.reference_type, payload.reference_id);
  if (byRef) return Number(byRef);

  const byClientDefault = await resolveClientDefaultWarehouseId(conn, payload.client_id);
  if (byClientDefault) return Number(byClientDefault);
  return null;
}

const serviceCatalogSchema = z.object({
  service_code: z.string().min(1).max(80),
  service_name: z.string().min(1).max(255),
  billing_unit: z.enum(BILLING_UNITS),
  pricing_policy: z.enum(PRICING_POLICIES),
  default_currency: z.enum(["THB", "KRW"]),
  default_rate: z.coerce.number().nonnegative(),
  status: z.enum(["active", "inactive"]).default("active")
});

const clientRateSchema = z.object({
  client_id: z.coerce.number().int().positive(),
  service_code: z.string().min(1).max(80),
  custom_rate: z.coerce.number().nonnegative(),
  currency: z.enum(["THB", "KRW"]),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});

const exchangeRateSchema = z.object({
  rate_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rate: z.coerce.number().positive(),
  source: z.enum(["manual", "api"]).default("manual"),
  locked: z.coerce.number().int().min(0).max(1).default(0),
  status: z.enum(["draft", "active", "superseded"]).default("active"),
  entered_by: z.coerce.number().int().positive().optional()
});

const billingEventSchema = z.object({
  client_id: z.coerce.number().int().positive(),
  warehouse_id: z.coerce.number().int().positive().nullable().optional(),
  service_code: z.string().min(1).max(80),
  reference_type: z.string().min(1).max(40),
  reference_id: z.string().max(120).nullable().optional(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  qty: z.coerce.number().nonnegative().default(0),
  pricing_policy: z.enum(PRICING_POLICIES),
  unit_price_thb: z.coerce.number().nonnegative().nullable().optional(),
  amount_thb: z.coerce.number().nonnegative().nullable().optional(),
  unit_price_krw: z.coerce.number().nonnegative().nullable().optional(),
  amount_krw: z.coerce.number().nonnegative().nullable().optional()
});

const generateInvoiceSchema = z.object({
  client_id: z.coerce.number().int().positive(),
  invoice_month: z.string().regex(/^\d{4}-\d{2}$/),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  regenerate_draft: z.coerce.number().int().min(0).max(1).default(0),
  created_by: z.coerce.number().int().positive().optional()
});

const markPendingSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1)
});

function buildBillingEventsWhere(query, options = {}) {
  const hasWarehouseId = options.hasWarehouseId !== false;
  const params = [];
  let where = " WHERE be.deleted_at IS NULL";

  if (query.client_id) {
    where += " AND be.client_id = ?";
    params.push(Number(query.client_id));
  }
  if (query.status) {
    where += " AND be.status = ?";
    params.push(String(query.status).toUpperCase());
  }
  if (query.service_code) {
    where += " AND be.service_code = ?";
    params.push(String(query.service_code));
  }
  if (hasWarehouseId && query.warehouse_id) {
    where += " AND be.warehouse_id = ?";
    params.push(Number(query.warehouse_id));
  }
  if (query.invoice_month && /^\d{4}-\d{2}$/.test(String(query.invoice_month))) {
    where += " AND DATE_FORMAT(be.event_date, '%Y-%m') = ?";
    params.push(String(query.invoice_month));
  }

  return { where, params };
}

router.get("/billing/settings/service-catalog", async (_req, res) => {
  try {
    const hasServiceName = await hasColumn("service_catalog", "service_name");
    const hasBillingUnit = await hasColumn("service_catalog", "billing_unit");
    const hasPricingPolicy = await hasColumn("service_catalog", "pricing_policy");
    const hasDefaultRate = await hasColumn("service_catalog", "default_rate");

    const serviceNameExpr = hasServiceName ? "COALESCE(service_name, service_name_kr)" : "service_name_kr";
    const billingUnitExpr = hasBillingUnit
      ? "billing_unit"
      : `CASE billing_basis WHEN 'ORDER' THEN 'ORDER' WHEN 'BOX' THEN 'BOX' WHEN 'QTY' THEN 'SKU' ELSE 'EVENT' END`;
    const pricingPolicyExpr = hasPricingPolicy ? "pricing_policy" : "'KRW_FIXED'";
    const defaultRateExpr = hasDefaultRate ? "default_rate" : "0";

    const [rows] = await getPool().query(
      `SELECT id, service_code, ${serviceNameExpr} AS service_name,
              ${billingUnitExpr} AS billing_unit, ${pricingPolicyExpr} AS pricing_policy,
              default_currency, ${defaultRateExpr} AS default_rate, status, created_at, updated_at
       FROM service_catalog
       WHERE deleted_at IS NULL
       ORDER BY service_code ASC`
    );
    return res.json({ ok: true, data: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.post("/billing/settings/service-catalog", validate(serviceCatalogSchema), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const payload = req.body;
  try {
    await getPool().query(
      `INSERT INTO service_catalog
        (service_code, service_name_kr, service_name, billing_basis, billing_unit, pricing_policy, default_currency, default_rate, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.service_code,
        payload.service_name,
        payload.service_name,
        mapBillingBasisFromUnit(payload.billing_unit),
        payload.billing_unit,
        payload.pricing_policy,
        payload.default_currency,
        payload.default_rate,
        payload.status
      ]
    );

    const [rows] = await getPool().query(
      `SELECT id, service_code, COALESCE(service_name, service_name_kr) AS service_name,
              billing_unit, pricing_policy, default_currency, default_rate, status, created_at, updated_at
       FROM service_catalog
       WHERE service_code = ? AND deleted_at IS NULL`,
      [payload.service_code]
    );

    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, message: "Duplicate service_code" });
    }
    return res.status(500).json({ ok: false, message: error.message });
  }
});
router.put("/billing/settings/service-catalog/:serviceCode", validate(serviceCatalogSchema), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const payload = req.body;
  try {
    const [result] = await getPool().query(
      `UPDATE service_catalog
       SET service_code = ?, service_name_kr = ?, service_name = ?, billing_basis = ?, billing_unit = ?,
           pricing_policy = ?, default_currency = ?, default_rate = ?, status = ?
       WHERE service_code = ? AND deleted_at IS NULL`,
      [
        payload.service_code,
        payload.service_name,
        payload.service_name,
        mapBillingBasisFromUnit(payload.billing_unit),
        payload.billing_unit,
        payload.pricing_policy,
        payload.default_currency,
        payload.default_rate,
        payload.status,
        req.params.serviceCode
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, message: "Service not found" });
    }

    const [rows] = await getPool().query(
      `SELECT id, service_code, COALESCE(service_name, service_name_kr) AS service_name,
              billing_unit, pricing_policy, default_currency, default_rate, status, created_at, updated_at
       FROM service_catalog
       WHERE service_code = ? AND deleted_at IS NULL`,
      [payload.service_code]
    );

    return res.json({ ok: true, data: rows[0] });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, message: "Duplicate service_code" });
    }
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.delete("/billing/settings/service-catalog/:serviceCode", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [result] = await getPool().query(
      "UPDATE service_catalog SET deleted_at = NOW() WHERE service_code = ? AND deleted_at IS NULL",
      [req.params.serviceCode]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, message: "Service not found" });
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.get("/billing/settings/client-contract-rates", async (req, res) => {
  const { client_id, service_code } = req.query;
  try {
    const exists = await hasTable("client_contract_rates");
    if (!exists) {
      return res.json({ ok: true, data: [] });
    }

    let query = `SELECT id, client_id, service_code, custom_rate, currency, effective_date, created_at, updated_at
                 FROM client_contract_rates
                 WHERE deleted_at IS NULL`;
    const params = [];

    if (client_id) {
      query += " AND client_id = ?";
      params.push(client_id);
    }
    if (service_code) {
      query += " AND service_code = ?";
      params.push(service_code);
    }

    query += " ORDER BY effective_date DESC, id DESC";
    const [rows] = await getPool().query(query, params);
    return res.json({ ok: true, data: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.post("/billing/settings/client-contract-rates", validate(clientRateSchema), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const payload = req.body;
  try {
    const [result] = await getPool().query(
      `INSERT INTO client_contract_rates
        (client_id, service_code, custom_rate, currency, effective_date)
       VALUES (?, ?, ?, ?, ?)`,
      [
        payload.client_id,
        payload.service_code,
        payload.custom_rate,
        payload.currency,
        payload.effective_date
      ]
    );

    const [rows] = await getPool().query(
      `SELECT id, client_id, service_code, custom_rate, currency, effective_date, created_at, updated_at
       FROM client_contract_rates
       WHERE id = ?`,
      [result.insertId]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, message: "Duplicate contract rate" });
    }
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.put("/billing/settings/client-contract-rates/:id", validate(clientRateSchema), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const payload = req.body;
  try {
    const [result] = await getPool().query(
      `UPDATE client_contract_rates
       SET client_id = ?, service_code = ?, custom_rate = ?, currency = ?, effective_date = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [
        payload.client_id,
        payload.service_code,
        payload.custom_rate,
        payload.currency,
        payload.effective_date,
        req.params.id
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, message: "Contract rate not found" });
    }

    const [rows] = await getPool().query(
      `SELECT id, client_id, service_code, custom_rate, currency, effective_date, created_at, updated_at
       FROM client_contract_rates
       WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    return res.json({ ok: true, data: rows[0] });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, message: "Duplicate contract rate" });
    }
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.delete("/billing/settings/client-contract-rates/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [result] = await getPool().query(
      "UPDATE client_contract_rates SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL",
      [req.params.id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, message: "Contract rate not found" });
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.get("/billing/settings/exchange-rates", async (req, res) => {
  const { month } = req.query;
  try {
    const hasSource = await hasColumn("exchange_rates", "source");
    const hasLocked = await hasColumn("exchange_rates", "locked");
    const hasInvoiceFxRate = await hasInvoiceFxRateColumn();
    const hasInvoiceMonth = await hasInvoiceMonthColumn();

    const sourceExpr = hasSource ? "er.source" : "'manual'";
    const lockedExpr = hasLocked ? "er.locked" : "0";
    const usedInvoiceCountExpr = hasInvoiceFxRate
      ? `(
          SELECT COUNT(*)
          FROM invoices i
          WHERE i.deleted_at IS NULL
            ${hasInvoiceMonth ? "AND i.invoice_month IS NOT NULL" : ""}
            AND i.fx_rate_thbkrw = er.rate
        )`
      : "0";

    let query = `SELECT er.id, er.rate_date, er.base_currency, er.quote_currency, er.rate,
                        ${sourceExpr} AS source, ${lockedExpr} AS locked, er.status,
                        er.created_at, er.updated_at,
                        ${usedInvoiceCountExpr} AS used_invoice_count
                 FROM exchange_rates er
                 WHERE er.deleted_at IS NULL
                   AND er.base_currency = 'THB'
                   AND er.quote_currency = 'KRW'`;
    const params = [];

    if (month && /^\d{4}-\d{2}$/.test(String(month))) {
      query += " AND DATE_FORMAT(er.rate_date, '%Y-%m') = ?";
      params.push(month);
    }

    query += " ORDER BY er.rate_date DESC, er.id DESC";
    const [rows] = await getPool().query(query, params);
    return res.json({ ok: true, data: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.post("/billing/settings/exchange-rates", validate(exchangeRateSchema), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const payload = req.body;
  const enteredBy = parseCreator(req, payload.entered_by);

  try {
    const [result] = await getPool().query(
      `INSERT INTO exchange_rates
        (rate_date, base_currency, quote_currency, rate, source, locked, status, entered_by)
       VALUES (?, 'THB', 'KRW', ?, ?, ?, ?, ?)`,
      [payload.rate_date, payload.rate, payload.source, payload.locked, payload.status, enteredBy]
    );

    const [rows] = await getPool().query(
      `SELECT id, rate_date, base_currency, quote_currency, rate, source, locked, status, created_at, updated_at,
              0 AS used_invoice_count
       FROM exchange_rates
       WHERE id = ?`,
      [result.insertId]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, message: "Duplicate rate_date for THB/KRW" });
    }
    return res.status(500).json({ ok: false, message: error.message });
  }
});
router.put("/billing/settings/exchange-rates/:id", validate(exchangeRateSchema), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const payload = req.body;
  try {
    const [rows] = await getPool().query(
      `SELECT id, locked FROM exchange_rates WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, message: "Exchange rate not found" });
    }

    const usedCount = await getExchangeRateUsageCount(getPool(), req.params.id);
    if (Number(rows[0].locked) === 1 || usedCount > 0) {
      return res.status(409).json({
        ok: false,
        code: "EXCHANGE_RATE_LOCKED",
        message: "Exchange rate is locked/used by invoices and cannot be modified"
      });
    }

    const [result] = await getPool().query(
      `UPDATE exchange_rates
       SET rate_date = ?, rate = ?, source = ?, locked = ?, status = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [payload.rate_date, payload.rate, payload.source, payload.locked, payload.status, req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, message: "Exchange rate not found" });
    }

    const [updated] = await getPool().query(
      `SELECT id, rate_date, base_currency, quote_currency, rate, source, locked, status, created_at, updated_at,
              0 AS used_invoice_count
       FROM exchange_rates
       WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    return res.json({ ok: true, data: updated[0] });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, message: "Duplicate rate_date for THB/KRW" });
    }
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.delete("/billing/settings/exchange-rates/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [rows] = await getPool().query(
      `SELECT id, locked FROM exchange_rates WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, message: "Exchange rate not found" });
    }

    const usedCount = await getExchangeRateUsageCount(getPool(), req.params.id);
    if (Number(rows[0].locked) === 1 || usedCount > 0) {
      return res.status(409).json({
        ok: false,
        code: "EXCHANGE_RATE_LOCKED",
        message: "Exchange rate is locked/used by invoices and cannot be deleted"
      });
    }

    await getPool().query("UPDATE exchange_rates SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.get("/billing/events", async (req, res) => {
  try {
    const exists = await hasTable("billing_events");
    if (!exists) {
      return res.json({ ok: true, data: [], alerts: { missing_warehouse_id: 0 } });
    }

    const hasWarehouseId = await hasColumn("billing_events", "warehouse_id");
    const warehouseExpr = hasWarehouseId ? "be.warehouse_id" : "NULL";
    const { where, params } = buildBillingEventsWhere(req.query, { hasWarehouseId });
    const [rows] = await getPool().query(
      `SELECT be.id, be.event_date, be.client_id, c.client_code, c.name_kr,
              be.service_code, be.qty, be.amount_thb, be.fx_rate_thbkrw, be.amount_krw,
              be.reference_type, be.reference_id, ${warehouseExpr} AS warehouse_id, be.status, be.invoice_id
       FROM billing_events be
       JOIN clients c ON c.id = be.client_id
       ${where}
       ORDER BY be.event_date DESC, be.id DESC`,
      params
    );
    const alertRows = hasWarehouseId
      ? (
          await getPool().query(
            `SELECT COUNT(*) AS missing_warehouse_id
             FROM billing_events be
             ${where}
             AND be.warehouse_id IS NULL`,
            params
          )
        )[0]
      : [{ missing_warehouse_id: 0 }];
    return res.json({
      ok: true,
      data: rows,
      alerts: {
        missing_warehouse_id: Number(alertRows[0]?.missing_warehouse_id || 0)
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.get("/billing/events/export.csv", async (req, res) => {
  try {
    const exists = await hasTable("billing_events");
    if (!exists) {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=billing_events.csv");
      const header = "event_date,client,service_code,qty,amount_thb,fx_rate_thbkrw,amount_krw,reference_type,reference_id,warehouse_id,status";
      return res.send(header);
    }

    const hasWarehouseId = await hasColumn("billing_events", "warehouse_id");
    const warehouseExpr = hasWarehouseId ? "be.warehouse_id" : "NULL";
    const { where, params } = buildBillingEventsWhere(req.query, { hasWarehouseId });
    const [rows] = await getPool().query(
      `SELECT be.event_date, c.client_code, be.service_code, be.qty, be.amount_thb,
              be.fx_rate_thbkrw, be.amount_krw, be.reference_type, be.reference_id, ${warehouseExpr} AS warehouse_id, be.status
       FROM billing_events be
       JOIN clients c ON c.id = be.client_id
       ${where}
       ORDER BY be.event_date DESC, be.id DESC`,
      params
    );

    const header = "event_date,client,service_code,qty,amount_thb,fx_rate_thbkrw,amount_krw,reference_type,reference_id,warehouse_id,status";
    const lines = rows.map((r) => {
      const values = [
        r.event_date,
        r.client_code,
        r.service_code,
        r.qty,
        r.amount_thb,
        r.fx_rate_thbkrw,
        r.amount_krw,
        r.reference_type,
        r.reference_id,
        r.warehouse_id,
        r.status
      ];
      return values
        .map((v) => {
          const s = v === null || v === undefined ? "" : String(v);
          return `"${s.replace(/"/g, "\"\"")}"`;
        })
        .join(",");
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=billing_events.csv");
    return res.send([header, ...lines].join("\n"));
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.post("/billing/events/mark-pending", validate(markPendingSchema), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await withTransaction(async (conn) => {
      const ids = req.body.ids;

      const [rows] = await conn.query(
        `SELECT be.id, be.invoice_id, i.status AS invoice_status
         FROM billing_events be
         LEFT JOIN invoices i ON i.id = be.invoice_id AND i.deleted_at IS NULL
         WHERE be.id IN (?) AND be.deleted_at IS NULL
         FOR UPDATE`,
        [ids]
      );

      if (rows.length === 0) {
        return { ok: false, code: "EVENTS_NOT_FOUND", message: "No billing events found" };
      }

      const blocked = rows.filter((r) => ["issued", "paid"].includes(String(r.invoice_status || "").toLowerCase()));
      if (blocked.length > 0) {
        return {
          ok: false,
          code: "EVENTS_LOCKED",
          message: "Cannot mark events pending when linked invoice is ISSUED/PAID"
        };
      }

      await conn.query(
        `UPDATE billing_events
         SET status = 'PENDING', invoice_id = NULL, fx_rate_thbkrw = NULL
         WHERE id IN (?) AND deleted_at IS NULL`,
        [ids]
      );

      return { ok: true, data: { updated: rows.length } };
    });

    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.post("/billing/events", validate(billingEventSchema), async (req, res) => {
  const payload = req.body;
  const amountThb = payload.amount_thb ?? (payload.unit_price_thb ?? 0) * (payload.qty ?? 0);
  const amountKrw = payload.amount_krw ?? (payload.unit_price_krw ?? 0) * (payload.qty ?? 0);

  try {
    const hasWarehouseId = await hasColumn("billing_events", "warehouse_id");
    const warehouseId = hasWarehouseId ? await resolveWarehouseIdForBillingEvent(getPool(), payload) : null;
    const [result] = hasWarehouseId
      ? await getPool().query(
          `INSERT INTO billing_events
            (client_id, warehouse_id, service_code, reference_type, reference_id, event_date, qty, pricing_policy, unit_price_thb, amount_thb, unit_price_krw, amount_krw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            payload.client_id,
            warehouseId,
            payload.service_code,
            payload.reference_type,
            payload.reference_id || null,
            payload.event_date,
            payload.qty,
            payload.pricing_policy,
            payload.unit_price_thb || null,
            payload.pricing_policy === "THB_BASED" ? amountThb : null,
            payload.unit_price_krw || null,
            payload.pricing_policy === "KRW_FIXED" ? trunc100(amountKrw) : null
          ]
        )
      : await getPool().query(
          `INSERT INTO billing_events
            (client_id, service_code, reference_type, reference_id, event_date, qty, pricing_policy, unit_price_thb, amount_thb, unit_price_krw, amount_krw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            payload.client_id,
            payload.service_code,
            payload.reference_type,
            payload.reference_id || null,
            payload.event_date,
            payload.qty,
            payload.pricing_policy,
            payload.unit_price_thb || null,
            payload.pricing_policy === "THB_BASED" ? amountThb : null,
            payload.unit_price_krw || null,
            payload.pricing_policy === "KRW_FIXED" ? trunc100(amountKrw) : null
          ]
        );

    const [rows] = await getPool().query(
      `SELECT id, client_id, ${hasWarehouseId ? "warehouse_id" : "NULL AS warehouse_id"}, service_code, reference_type, reference_id, event_date, qty, pricing_policy,
              unit_price_thb, amount_thb, unit_price_krw, amount_krw, fx_rate_thbkrw, invoice_id, status, created_at, updated_at
       FROM billing_events
       WHERE id = ?`,
      [result.insertId]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});
router.post("/billing/events/sample", async (req, res) => {
  const clientId = Number(req.body?.client_id || 1);
  const warehouseId = req.body?.warehouse_id ? Number(req.body.warehouse_id) : null;
  const month = String(req.body?.invoice_month || "2026-01");
  const dateA = `${month}-03`;
  const dateB = `${month}-07`;

  try {
    const hasWarehouseId = await hasColumn("billing_events", "warehouse_id");
    if (hasWarehouseId) {
      await getPool().query(
        `INSERT INTO billing_events
          (client_id, warehouse_id, service_code, reference_type, reference_id, event_date, qty, pricing_policy, unit_price_thb, amount_thb)
         VALUES
          (?, ?, 'TH_SHIPPING', 'SHIPPING', 'SAMPLE-SHP-001', ?, 1, 'THB_BASED', 120, 120),
          (?, ?, 'TH_BOX', 'SHIPPING', 'SAMPLE-BOX-001', ?, 5, 'THB_BASED', 8, 40),
          (?, ?, 'OUTBOUND_FEE', 'OUTBOUND', 'SAMPLE-OUT-001', ?, 3, 'KRW_FIXED', NULL, NULL)`,
        [clientId, warehouseId, dateA, clientId, warehouseId, dateB, clientId, warehouseId, dateB]
      );
    } else {
      await getPool().query(
        `INSERT INTO billing_events
          (client_id, service_code, reference_type, reference_id, event_date, qty, pricing_policy, unit_price_thb, amount_thb)
         VALUES
          (?, 'TH_SHIPPING', 'SHIPPING', 'SAMPLE-SHP-001', ?, 1, 'THB_BASED', 120, 120),
          (?, 'TH_BOX', 'SHIPPING', 'SAMPLE-BOX-001', ?, 5, 'THB_BASED', 8, 40),
          (?, 'OUTBOUND_FEE', 'OUTBOUND', 'SAMPLE-OUT-001', ?, 3, 'KRW_FIXED', NULL, NULL)`,
        [clientId, dateA, clientId, dateB, clientId, dateB]
      );
    }

    await getPool().query(
      `UPDATE billing_events
       SET unit_price_krw = 3500, amount_krw = 10500
       WHERE client_id = ?
         AND reference_id = 'SAMPLE-OUT-001'
         AND pricing_policy = 'KRW_FIXED'
         AND deleted_at IS NULL
       ORDER BY id DESC
       LIMIT 1`,
      [clientId]
    );

    return res.json({ ok: true, data: { client_id: clientId, invoice_month: month, seeded: true } });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.post("/billing/invoices/generate", validate(generateInvoiceSchema), async (req, res) => {
  try {
    const result = await withTransaction(async (conn) => {
      const payload = req.body;
      const createdBy = parseCreator(req, payload.created_by);
      const hasInvoiceDate = await hasInvoiceDateColumn(conn);
      const { from, to } = monthRange(payload.invoice_month);

      const [existingRows] = await conn.query(
        `SELECT id, status
         FROM invoices
         WHERE client_id = ?
           AND invoice_month = ?
           AND deleted_at IS NULL
         ORDER BY id DESC
         LIMIT 1
         FOR UPDATE`,
        [payload.client_id, payload.invoice_month]
      );

      if (existingRows.length > 0) {
        const existing = existingRows[0];
        if (String(existing.status).toLowerCase() !== "draft") {
          return {
            ok: false,
            code: "INVOICE_ALREADY_ISSUED",
            message: "Generation blocked: month already has non-draft invoice. Use admin duplicate action."
          };
        }

        if (!payload.regenerate_draft) {
          return {
            ok: true,
            data: { invoice_id: existing.id, reused: true }
          };
        }

        await conn.query(
          `UPDATE billing_events
           SET status = 'PENDING', invoice_id = NULL, fx_rate_thbkrw = NULL
           WHERE invoice_id = ? AND deleted_at IS NULL`,
          [existing.id]
        );
        await conn.query("UPDATE invoice_items SET deleted_at = NOW() WHERE invoice_id = ? AND deleted_at IS NULL", [existing.id]);
        await conn.query("UPDATE invoices SET deleted_at = NOW() WHERE id = ?", [existing.id]);
      }

      const [fxRows] = await conn.query(
        `SELECT id, rate
         FROM exchange_rates
         WHERE base_currency = 'THB'
           AND quote_currency = 'KRW'
           AND deleted_at IS NULL
           AND status = 'active'
           AND rate_date <= ?
         ORDER BY rate_date DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [payload.invoice_date]
      );

      if (fxRows.length === 0) {
        return {
          ok: false,
          code: "FX_NOT_FOUND",
          message: "No active THB->KRW rate found on or before invoice_date"
        };
      }

      const fxRateId = Number(fxRows[0].id);
      const fx = Number(fxRows[0].rate);
      await conn.query("UPDATE exchange_rates SET locked = 1 WHERE id = ?", [fxRateId]);

      const [events] = await conn.query(
        `SELECT id, service_code, qty, pricing_policy, unit_price_thb, amount_thb, unit_price_krw, amount_krw
         FROM billing_events
         WHERE client_id = ?
           AND status = 'PENDING'
           AND deleted_at IS NULL
           AND event_date >= ?
           AND event_date < ?
         ORDER BY id ASC
         FOR UPDATE`,
        [payload.client_id, from, to]
      );

      if (events.length === 0) {
        return {
          ok: false,
          code: "NO_PENDING_EVENTS",
          message: "No pending billing events found for invoice month"
        };
      }

      const yyyymm = payload.invoice_month.replace("-", "");
      const nextSeq = await resolveInvoiceSequence(conn, payload.client_id, yyyymm);
      const invoiceNo = `KRW-${payload.client_id}-${yyyymm}-${String(nextSeq).padStart(4, "0")}`;

      const [invoiceCreated] = hasInvoiceDate
        ? await conn.query(
            `INSERT INTO invoices
              (settlement_batch_id, client_id, invoice_month, invoice_no, status, issue_date, invoice_date, due_date, recipient_email,
               currency, fx_rate_thbkrw, subtotal_krw, vat_krw, total_krw, total_amount, created_by)
             VALUES (NULL, ?, ?, ?, 'draft', ?, ?, ?, NULL, 'KRW', ?, 0, 0, 0, 0, ?)`,
            [
              payload.client_id,
              payload.invoice_month,
              invoiceNo,
              payload.invoice_date,
              payload.invoice_date,
              payload.invoice_date,
              fx,
              createdBy
            ]
          )
        : await conn.query(
            `INSERT INTO invoices
              (settlement_batch_id, client_id, invoice_month, invoice_no, status, issue_date, due_date, recipient_email,
               currency, fx_rate_thbkrw, subtotal_krw, vat_krw, total_krw, total_amount, created_by)
             VALUES (NULL, ?, ?, ?, 'draft', ?, ?, NULL, 'KRW', ?, 0, 0, 0, 0, ?)`,
            [payload.client_id, payload.invoice_month, invoiceNo, payload.invoice_date, payload.invoice_date, fx, createdBy]
          );
      const invoiceId = Number(invoiceCreated.insertId);

      const [serviceNameRows] = await conn.query(
        `SELECT service_code, COALESCE(service_name, service_name_kr) AS service_name
         FROM service_catalog
         WHERE deleted_at IS NULL`
      );
      const serviceNameMap = new Map(serviceNameRows.map((row) => [row.service_code, row.service_name]));
      const grouped = new Map();

      for (const event of events) {
        let normalizedAmount = 0;
        if (event.pricing_policy === "THB_BASED") {
          const amountThb =
            event.amount_thb !== null && event.amount_thb !== undefined
              ? Number(event.amount_thb)
              : Number(event.unit_price_thb || 0) * Number(event.qty || 0);
          normalizedAmount = trunc100(amountThb * fx);
        } else {
          const amountKrw =
            event.amount_krw !== null && event.amount_krw !== undefined
              ? Number(event.amount_krw)
              : Number(event.unit_price_krw || 0) * Number(event.qty || 0);
          normalizedAmount = trunc100(amountKrw);
        }

        await conn.query(
          `UPDATE billing_events
           SET amount_krw = ?, fx_rate_thbkrw = ?, status = 'INVOICED', invoice_id = ?
           WHERE id = ?`,
          [normalizedAmount, fx, invoiceId, event.id]
        );

        if (!grouped.has(event.service_code)) {
          grouped.set(event.service_code, { qty: 0, amount_krw: 0 });
        }
        const current = grouped.get(event.service_code);
        current.qty += Number(event.qty || 0);
        current.amount_krw += Number(normalizedAmount);
      }

      let subtotalKrw = 0;
      for (const [serviceCode, agg] of grouped.entries()) {
        const qty = Number(agg.qty);
        const lineAmount = trunc100(Number(agg.amount_krw));
        subtotalKrw += lineAmount;

        const unitDisplay = qty > 0 ? trunc100(lineAmount / qty) : lineAmount;
        await conn.query(
          `INSERT INTO invoice_items
            (invoice_id, service_code, description, qty, unit_price_krw, amount_krw)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [invoiceId, serviceCode, serviceNameMap.get(serviceCode) || serviceCode, qty, unitDisplay, lineAmount]
        );
      }

      subtotalKrw = trunc100(subtotalKrw);
      const vatKrw = trunc100(subtotalKrw * 0.07);
      const totalKrw = trunc100(subtotalKrw + vatKrw);

      await conn.query(
        `INSERT INTO invoice_items
          (invoice_id, service_code, description, qty, unit_price_krw, amount_krw)
         VALUES (?, 'VAT_7', 'VAT 7%', 1, ?, ?)`,
        [invoiceId, vatKrw, vatKrw]
      );

      await conn.query(
        `UPDATE invoices
         SET subtotal_krw = ?, vat_krw = ?, total_krw = ?, total_amount = ?
         WHERE id = ?`,
        [subtotalKrw, vatKrw, totalKrw, totalKrw, invoiceId]
      );

      const invoiceDateColumn = invoiceDateExpr(hasInvoiceDate, "i");
      const [invoiceRows] = await conn.query(
        `SELECT id, client_id, invoice_no, invoice_month, ${invoiceDateColumn} AS invoice_date, currency, fx_rate_thbkrw,
                subtotal_krw, vat_krw, total_krw, status, created_at, updated_at
         FROM invoices i
         WHERE id = ?`,
        [invoiceId]
      );

      return {
        ok: true,
        data: {
          invoice: invoiceRows[0],
          events_count: events.length,
          reused: false,
          fx_rate_id: fxRateId
        }
      };
    });

    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});
router.post("/billing/invoices/:id/issue", async (req, res) => {
  try {
    const result = await withTransaction(async (conn) => {
      const invoiceId = Number(req.params.id);
      const [rows] = await conn.query(
        `SELECT id, status FROM invoices WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
        [invoiceId]
      );
      if (rows.length === 0) return { ok: false, code: "NOT_FOUND", message: "Invoice not found" };
      if (String(rows[0].status).toLowerCase() !== "draft") {
        return { ok: false, code: "INVALID_STATUS", message: "Only DRAFT invoice can be issued" };
      }
      await conn.query("UPDATE invoices SET status = 'issued' WHERE id = ?", [invoiceId]);
      return { ok: true, data: { id: invoiceId, status: "issued" } };
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.post("/billing/invoices/:id/mark-paid", async (req, res) => {
  try {
    const result = await withTransaction(async (conn) => {
      const invoiceId = Number(req.params.id);
      const [rows] = await conn.query(
        `SELECT id, status FROM invoices WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
        [invoiceId]
      );
      if (rows.length === 0) return { ok: false, code: "NOT_FOUND", message: "Invoice not found" };
      if (String(rows[0].status).toLowerCase() !== "issued") {
        return { ok: false, code: "INVALID_STATUS", message: "Only ISSUED invoice can be marked paid" };
      }
      await conn.query("UPDATE invoices SET status = 'paid' WHERE id = ?", [invoiceId]);
      return { ok: true, data: { id: invoiceId, status: "paid" } };
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.post("/billing/invoices/:id/duplicate-admin", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await withTransaction(async (conn) => {
      const sourceInvoiceId = Number(req.params.id);
      const hasInvoiceDate = await hasInvoiceDateColumn(conn);
      const [invoiceRows] = await conn.query(
        `SELECT id, client_id, invoice_month, status
         FROM invoices
         WHERE id = ? AND deleted_at IS NULL
         LIMIT 1
         FOR UPDATE`,
        [sourceInvoiceId]
      );

      if (invoiceRows.length === 0) {
        return { ok: false, code: "NOT_FOUND", message: "Invoice not found" };
      }

      const source = invoiceRows[0];
      if (String(source.status).toLowerCase() === "draft") {
        return { ok: false, code: "INVALID_STATUS", message: "Use generate/regenerate for draft invoice" };
      }

      const yyyymm = String(source.invoice_month).replace("-", "");
      const nextSeq = await resolveInvoiceSequence(conn, source.client_id, yyyymm);
      const newInvoiceNo = `KRW-${source.client_id}-${yyyymm}-${String(nextSeq).padStart(4, "0")}`;

      const [created] = hasInvoiceDate
        ? await conn.query(
            `INSERT INTO invoices
              (settlement_batch_id, client_id, invoice_month, invoice_no, status, issue_date, invoice_date, due_date, recipient_email,
               currency, fx_rate_thbkrw, subtotal_krw, vat_krw, total_krw, total_amount, created_by)
             SELECT NULL, client_id, invoice_month, ?, 'draft', issue_date, invoice_date, due_date, recipient_email,
                    'KRW', fx_rate_thbkrw, subtotal_krw, vat_krw, total_krw, total_krw, created_by
             FROM invoices
             WHERE id = ?`,
            [newInvoiceNo, sourceInvoiceId]
          )
        : await conn.query(
            `INSERT INTO invoices
              (settlement_batch_id, client_id, invoice_month, invoice_no, status, issue_date, due_date, recipient_email,
               currency, fx_rate_thbkrw, subtotal_krw, vat_krw, total_krw, total_amount, created_by)
             SELECT NULL, client_id, invoice_month, ?, 'draft', issue_date, due_date, recipient_email,
                    'KRW', fx_rate_thbkrw, subtotal_krw, vat_krw, total_krw, total_krw, created_by
             FROM invoices
             WHERE id = ?`,
            [newInvoiceNo, sourceInvoiceId]
          );
      const newInvoiceId = Number(created.insertId);

      await conn.query(
        `INSERT INTO invoice_items (invoice_id, service_code, description, qty, unit_price_krw, amount_krw)
         SELECT ?, service_code, description, qty, unit_price_krw, amount_krw
         FROM invoice_items
         WHERE invoice_id = ? AND deleted_at IS NULL`,
        [newInvoiceId, sourceInvoiceId]
      );

      const invoiceDateColumn = invoiceDateExpr(hasInvoiceDate, "i");
      const [newRows] = await conn.query(
        `SELECT id, invoice_no, status, invoice_month, ${invoiceDateColumn} AS invoice_date, fx_rate_thbkrw, subtotal_krw, vat_krw, total_krw
         FROM invoices i
         WHERE id = ?`,
        [newInvoiceId]
      );

      return { ok: true, data: newRows[0] };
    });

    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.get("/billing/invoices", async (req, res) => {
  const { client_id, invoice_month } = req.query;
  const status = normalizeInvoiceStatus(req.query.status);

  try {
    const hasInvoices = await hasTable("invoices");
    if (!hasInvoices) {
      return res.json({ ok: true, data: [] });
    }

    const hasInvoiceMonth = await hasInvoiceMonthColumn();
    const hasInvoiceDate = await hasInvoiceDateColumn();
    const hasFxRate = await hasColumn("invoices", "fx_rate_thbkrw");
    const hasSubtotal = await hasColumn("invoices", "subtotal_krw");
    const hasVat = await hasColumn("invoices", "vat_krw");
    const hasTotalKrw = await hasColumn("invoices", "total_krw");
    const fxExpr = hasFxRate ? "i.fx_rate_thbkrw" : "NULL";
    const subtotalExpr = hasSubtotal ? "i.subtotal_krw" : "0";
    const vatExpr = hasVat ? "i.vat_krw" : "0";
    const totalExpr = hasTotalKrw ? "i.total_krw" : "i.total_amount";
    const monthExpr = invoiceMonthExpr(hasInvoiceMonth, "i");
    const dateExpr = invoiceDateExpr(hasInvoiceDate, "i");

    let query = `SELECT i.id, i.client_id, c.client_code, c.name_kr,
                        i.invoice_no, ${monthExpr} AS invoice_month, ${dateExpr} AS invoice_date, i.currency,
                        ${fxExpr} AS fx_rate_thbkrw, ${subtotalExpr} AS subtotal_krw, ${vatExpr} AS vat_krw, ${totalExpr} AS total_krw, i.status, i.created_at
                 FROM invoices i
                 JOIN clients c ON c.id = i.client_id
                 WHERE i.deleted_at IS NULL
                   AND ${monthExpr} IS NOT NULL`;
    const params = [];

    if (client_id) {
      query += " AND i.client_id = ?";
      params.push(client_id);
    }
    if (invoice_month) {
      query += ` AND ${monthExpr} = ?`;
      params.push(invoice_month);
    }
    if (status) {
      query += " AND i.status = ?";
      params.push(status);
    }

    query += ` ORDER BY ${monthExpr} DESC, i.id DESC`;
    const [rows] = await getPool().query(query, params);
    return res.json({ ok: true, data: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.get("/billing/invoices/:id", async (req, res) => {
  try {
    const hasInvoices = await hasTable("invoices");
    if (!hasInvoices) {
      return res.status(404).json({ ok: false, message: "Invoice not found" });
    }

    const hasInvoiceMonth = await hasInvoiceMonthColumn();
    const hasInvoiceDate = await hasInvoiceDateColumn();
    const hasFxRate = await hasColumn("invoices", "fx_rate_thbkrw");
    const hasSubtotal = await hasColumn("invoices", "subtotal_krw");
    const hasVat = await hasColumn("invoices", "vat_krw");
    const hasTotalKrw = await hasColumn("invoices", "total_krw");
    const hasInvoiceItems = await hasTable("invoice_items");

    const monthExpr = invoiceMonthExpr(hasInvoiceMonth, "i");
    const dateExpr = invoiceDateExpr(hasInvoiceDate, "i");
    const fxExpr = hasFxRate ? "i.fx_rate_thbkrw" : "NULL";
    const subtotalExpr = hasSubtotal ? "i.subtotal_krw" : "0";
    const vatExpr = hasVat ? "i.vat_krw" : "0";
    const totalExpr = hasTotalKrw ? "i.total_krw" : "i.total_amount";

    const [invoiceRows] = await getPool().query(
      `SELECT i.id, i.client_id, c.client_code, c.name_kr,
              i.invoice_no, ${monthExpr} AS invoice_month, ${dateExpr} AS invoice_date, i.currency,
              ${fxExpr} AS fx_rate_thbkrw, ${subtotalExpr} AS subtotal_krw, ${vatExpr} AS vat_krw, ${totalExpr} AS total_krw, i.status, i.created_at, i.updated_at,
              (MOD(${subtotalExpr}, 100) = 0) AS subtotal_trunc100,
              (MOD(${vatExpr}, 100) = 0) AS vat_trunc100,
              (MOD(${totalExpr}, 100) = 0) AS total_trunc100
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
       WHERE i.id = ? AND i.deleted_at IS NULL`,
      [req.params.id]
    );

    if (invoiceRows.length === 0) {
      return res.status(404).json({ ok: false, message: "Invoice not found" });
    }

    const [itemRows] = hasInvoiceItems
      ? await getPool().query(
          `SELECT id, invoice_id, service_code, description, qty, unit_price_krw, amount_krw, created_at, updated_at,
                  (MOD(unit_price_krw, 100) = 0) AS unit_price_trunc100,
                  (MOD(amount_krw, 100) = 0) AS amount_trunc100
           FROM invoice_items
           WHERE invoice_id = ? AND deleted_at IS NULL
           ORDER BY id ASC`,
          [req.params.id]
        )
      : [[]];

    return res.json({
      ok: true,
      data: {
        invoice: invoiceRows[0],
        items: itemRows
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.get("/billing/invoices/:id/export-pdf", async (req, res) => {
  try {
    const hasInvoices = await hasTable("invoices");
    if (!hasInvoices) {
      return res.status(404).json({ ok: false, message: "Invoice not found" });
    }

    const hasInvoiceMonth = await hasInvoiceMonthColumn();
    const hasTotalKrw = await hasColumn("invoices", "total_krw");
    const monthExpr = invoiceMonthExpr(hasInvoiceMonth, "i");
    const totalExpr = hasTotalKrw ? "i.total_krw" : "i.total_amount";

    const [invoiceRows] = await getPool().query(
      `SELECT i.id, i.invoice_no, ${monthExpr} AS invoice_month, ${totalExpr} AS total_krw, i.status
       FROM invoices i
       WHERE i.id = ? AND i.deleted_at IS NULL`,
      [req.params.id]
    );

    if (invoiceRows.length === 0) {
      return res.status(404).json({ ok: false, message: "Invoice not found" });
    }

    return res.json({
      ok: true,
      data: {
        invoice_id: invoiceRows[0].id,
        invoice_no: invoiceRows[0].invoice_no,
        status: "stub",
        message: "PDF export endpoint is ready. Implement renderer integration next.",
        download_url: null
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

module.exports = router;
